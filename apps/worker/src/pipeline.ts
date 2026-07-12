/**
 * The state machine driver. One switch, resumable.
 *
 * Every stage is entered from a persisted state and leaves by writing a new one, so the
 * whole thing is a step function you can stop and restart at any point. The rule that
 * makes it work: a transition is committed only AFTER its side effect is durable.
 *
 * `advance()` performs exactly ONE transition and returns. The worker loop calls it in a
 * loop, which is what lets a task parked in CHECKING_FEEDBACK yield the worker to another
 * task instead of blocking it for 20 minutes.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  PipelineState as S, stateName, TaskStatus,
} from "../../../packages/shared/src/status.ts";
import {
  patchTask, emitEvent, upsertImplementation,
} from "../../../packages/shared/src/supabase.ts";
import type { TerminusRow } from "../../../packages/shared/src/types.ts";
import type { ParsedTask } from "../../../packages/shared/src/parse-task-blob.ts";
import { readState, writeState, patchState, type LocalState } from "./state.ts";
import { buildTask, fixTask, missingFromManifest, BuildIncomplete } from "./stages/build.ts";
import { verifyTask } from "./stages/verify.ts";
import { zipTask, assertNoWrapperDir } from "./stages/zip.ts";
import { generateExplanations } from "./stages/explain-generate.ts";
import { openNewSubmission, fillSubmissionForm, AttestationRefused, FormNotReady } from "./stages/upload.ts";
import { checkFeedback, FeedbackInconclusive } from "./stages/feedback.ts";
import { findSubmitted, clickSubmit, enableRubricGeneration } from "./stages/submit.ts";
import { attach, detach, snorkelPage } from "./browser/cdp.ts";
import { pageUrl, SelectorNotFound } from "./browser/selectors.ts";
import { RateLimited } from "./claude/errors.ts";
import type { Config } from "./config.ts";

export interface Ctx {
  cfg: Config;
  log: (msg: string) => void;
}

const toParsed = (r: TerminusRow): ParsedTask => ({
  category: r.category,
  sub_category: r.sub_category,
  title: r.title,
  description: r.description,
  languages: r.languages,
  additional_note: r.additional_note,
});

function workspaceFor(cfg: Config, slug: string): string {
  return resolve(cfg.paths.workspace, slug);
}
function runDirFor(cfg: Config, slug: string, label: string): string {
  const d = resolve(cfg.paths.runs, slug, label);
  mkdirSync(d, { recursive: true });
  return d;
}

/** Commit a state transition to disk AND the DB, and log it. Order matters: disk first. */
async function transition(
  ctx: Ctx, row: TerminusRow, ws: string, to: number,
  ev: { stage: any; message?: string; detail?: Record<string, unknown> },
): Promise<void> {
  const from = row.pipeline_state;
  patchState(ws, { pipelineState: to });
  const local = readState(ws)!;
  await patchTask(row.task_id, {
    pipeline_state: to,
    claude_session_id: local.claudeSessionId,
    attempt: local.attempt,
    feedback_attempt: local.feedbackAttempt,
    zip_path: local.zipPath,
    last_error: local.lastError,
  });
  await emitEvent({
    task_id: row.task_id,
    stage: ev.stage,
    status: to === S.FAILED || to === S.NEEDS_HUMAN ? "failed" : "completed",
    from_state: from,
    to_state: to,
    attempt: local.attempt,
    detail: ev.detail ?? null,
    message: ev.message ?? null,
  });
  ctx.log(`${row.slug ?? row.task_id}  ${stateName(from)} → ${stateName(to)}${ev.message ? `  · ${ev.message}` : ""}`);
}

async function fail(ctx: Ctx, row: TerminusRow, ws: string, stage: any, err: string, needsHuman = false): Promise<void> {
  patchState(ws, { lastError: err });
  await transition(ctx, row, ws, needsHuman ? S.NEEDS_HUMAN : S.FAILED, { stage, message: err.split("\n")[0] });
}

/**
 * Perform ONE transition for this task.
 * Returns true if it did something, false if the task is parked or terminal.
 */
export async function advance(ctx: Ctx, row: TerminusRow): Promise<boolean> {
  const { cfg } = ctx;
  const slug = row.slug!;
  const ws = workspaceFor(cfg, slug);

  // Bootstrap local state on first entry (or if the workspace was wiped).
  if (!readState(ws)) {
    mkdirSync(ws, { recursive: true });
    writeState(ws, {
      taskId: row.task_id, slug,
      pipelineState: row.pipeline_state,
      claudeSessionId: row.claude_session_id,
      attempt: row.attempt ?? 0,
      feedbackAttempt: row.feedback_attempt ?? 0,
      zipPath: row.zip_path,
      explanations: null,
      feedbackStartedAt: null,
      lastError: row.last_error,
      updatedAt: new Date().toISOString(),
    });
  }
  const st = (): LocalState => readState(ws)!;

  switch (row.pipeline_state) {
    // ---------------------------------------------------------------- DRAFT
    case S.DRAFT:
      // Inert by design. Only the human's Start Build click moves this to QUEUED.
      return false;

    case S.QUEUED:
      // claimNextTask() already moved it to BUILD_RUNNING; getting here means a
      // restart raced the claim. Just re-enter the build.
      await patchTask(row.task_id, { pipeline_state: S.BUILD_RUNNING });
      return true;

    // ---------------------------------------------------------------- BUILD
    case S.BUILD_RUNNING: {
      const resuming = st().claudeSessionId !== null;

      // A crash mid-build lands here with a session already recorded. If the manifest is
      // complete, the build actually finished and only the transition was lost — do not
      // pay for it twice.
      if (resuming && missingFromManifest(ws).length === 0) {
        await transition(ctx, row, ws, S.BUILT, {
          stage: "build",
          message: "recovered: build was already complete on disk",
        });
        return true;
      }

      await emitEvent({
        task_id: row.task_id, stage: "build", status: "started",
        from_state: row.pipeline_state,
        message: resuming ? "resuming the existing Claude session" : "new Claude session",
      });

      try {
        const out = await buildTask({
          task: toParsed(row),
          slug,
          workspace: ws,
          resuming,
          sessionId: st().claudeSessionId,
          studyTimeoutMin: cfg.claude.studyTimeoutMin,
          buildTimeoutMin: cfg.claude.buildTimeoutMin,
          onSessionId: async (id) => {
            // Durable before anything else. This is what makes a long build survivable.
            patchState(ws, { claudeSessionId: id });
            await patchTask(row.task_id, { claude_session_id: id });
          },
          onProgress: async (msg) => {
            ctx.log(`${slug}  ${msg}`);
            await emitEvent({ task_id: row.task_id, stage: "build", status: "heartbeat", message: msg });
          },
        });

        await transition(ctx, row, ws, S.BUILT, {
          stage: "build",
          message: out.summary ? out.summary.split("\n")[0]!.slice(0, 140) : "manifest complete",
          detail: { session_id: out.sessionId, skeleton: out.skeleton.source },
        });
      } catch (e) {
        if (e instanceof RateLimited) throw e;
        // A build that ended with the manifest still incomplete is a human problem: Claude
        // stopped without producing the task tree, and re-running the gate on a half-built
        // tree would only produce a confusing Docker failure. Park it and let someone read
        // the transcript.
        const human = e instanceof BuildIncomplete;
        await fail(ctx, row, ws, "build", (e as Error).message, human);
      }
      return true;
    }

    case S.BUILT:
      await transition(ctx, row, ws, S.VERIFY_RUNNING, { stage: "verify" });
      return true;

    // --------------------------------------------------------------- VERIFY
    case S.VERIFY_RUNNING: {
      const attempt = st().attempt;
      await emitEvent({
        task_id: row.task_id, stage: "verify", status: "started",
        attempt, message: `docker gate (attempt ${attempt + 1}/${cfg.retries.verifyAttempts})`,
      });

      const r = await verifyTask({
        taskDir: ws,
        slug,
        runDir: runDirFor(cfg, slug, `verify-${attempt}`),
        cpus: cfg.docker.cpus,
        memoryMb: cfg.docker.memoryMb,
        buildTimeoutSec: cfg.docker.buildTimeoutSec,
        solveTimeoutSec: cfg.docker.solveTimeoutSec,
        testTimeoutSec: cfg.docker.testTimeoutSec,
      });

      const detail = {
        oracle_reward: r.oracleReward,
        null_reward: r.nullReward,
        lint_blocking: r.lint.findings.filter((f) => f.severity === "blocking").length,
      };

      if (r.passed) {
        await transition(ctx, row, ws, S.VERIFIED, {
          stage: "verify", detail, message: "oracle=1, null=0, lint clean",
        });
        return true;
      }

      patchState(ws, { lastError: r.failureReport });
      await emitEvent({
        task_id: row.task_id, stage: "verify", status: "failed", attempt, detail,
        message: r.failureReport.split("\n")[0],
      });
      await transition(ctx, row, ws, S.VERIFY_FAILED, { stage: "verify", detail });
      return true;
    }

    case S.VERIFY_FAILED: {
      const s = st();
      if (s.attempt + 1 >= cfg.retries.verifyAttempts) {
        await fail(ctx, row, ws, "verify",
          `Verify gate failed ${cfg.retries.verifyAttempts}x. Last failure:\n${s.lastError ?? "(none)"}`);
        return true;
      }
      // Increment BEFORE the fix call: a crash inside FIX_RUNNING then burns one attempt,
      // which is the fail-safe direction. An infinite fix loop is far worse.
      patchState(ws, { attempt: s.attempt + 1 });
      await transition(ctx, row, ws, S.FIX_RUNNING, { stage: "fix" });
      return true;
    }

    case S.FIX_RUNNING: {
      const s2 = st();
      await emitEvent({
        task_id: row.task_id, stage: "fix", status: "started", attempt: s2.attempt,
        message: "feeding the docker failure back to the build session",
      });
      try {
        await fixTask({
          workspace: ws,
          sessionId: s2.claudeSessionId,
          template: "03-fix.md",
          vars: {
            attempt: s2.attempt,
            maxAttempts: cfg.retries.verifyAttempts,
            failureReport: s2.lastError ?? "(no failure captured)",
          },
          timeoutMin: cfg.claude.fixTimeoutMin,
          onProgress: async (msg) => {
            ctx.log(`${slug}  ${msg}`);
            await emitEvent({ task_id: row.task_id, stage: "fix", status: "heartbeat", message: msg });
          },
        });
        // Straight back to the gate. The gate, not Claude, decides whether it is fixed.
        await transition(ctx, row, ws, S.VERIFY_RUNNING, { stage: "fix", message: "fix applied — re-verifying" });
      } catch (e) {
        if (e instanceof RateLimited) throw e;
        await fail(ctx, row, ws, "fix", (e as Error).message, e instanceof BuildIncomplete);
      }
      return true;
    }

    case S.VERIFIED:
      await transition(ctx, row, ws, S.ZIPPED, { stage: "zip" });
      return true;

    // ------------------------------------------------------------------ ZIP
    case S.ZIPPED: {
      // Enter ZIPPED by producing the zip, then move on. (The state names what is TRUE
      // once we leave, which is why the work happens on the way out of VERIFIED.)
      const zipPath = join(resolve(cfg.paths.zipOutput), `${slug}.zip`);
      const r = await zipTask(ws, zipPath);
      assertNoWrapperDir(r.entries);
      patchState(ws, { zipPath });
      await patchTask(row.task_id, { zip_path: zipPath });
      await emitEvent({
        task_id: row.task_id, stage: "zip", status: "completed",
        detail: { bytes: r.bytes, entries: r.entries.length },
        message: `${(r.bytes / 1024).toFixed(0)} KB · ${r.entries.length} files`,
      });
      await transition(ctx, row, ws, S.EXPLAINED, { stage: "explain" });
      return true;
    }

    case S.EXPLAINED: {
      const s = st();
      if (s.explanations) {
        await transition(ctx, row, ws, S.UPLOADING, { stage: "upload" });
        return true;
      }
      await emitEvent({ task_id: row.task_id, stage: "explain", status: "started" });
      try {
        const { explanations, attempts } = await generateExplanations({
          workspace: ws,
          sessionId: s.claudeSessionId,
          maxAttempts: cfg.retries.explainAttempts,
          timeoutMin: cfg.claude.explainTimeoutMin,
          onProgress: async (msg) => {
            ctx.log(`${slug}  ${msg}`);
            await emitEvent({ task_id: row.task_id, stage: "explain", status: "heartbeat", message: msg });
          },
        });
        patchState(ws, { explanations });
        await upsertImplementation(row.task_id, {
          difficulty_explanation: explanations.difficulty,
          solution_explanation: explanations.solution,
          verification_explanation: explanations.verification,
        });
        await emitEvent({
          task_id: row.task_id, stage: "explain", status: "completed",
          message: `3 explanations written (${attempts} attempt${attempts > 1 ? "s" : ""})`,
        });
        await transition(ctx, row, ws, S.UPLOADING, { stage: "upload" });
      } catch (e) {
        if (e instanceof RateLimited) throw e;
        await fail(ctx, row, ws, "explain", (e as Error).message);
      }
      return true;
    }

    // --------------------------------------------------------------- UPLOAD
    case S.UPLOADING: {
      const s = st();
      const runDir = runDirFor(cfg, slug, `upload-${s.feedbackAttempt}`);
      await emitEvent({ task_id: row.task_id, stage: "upload", status: "started", attempt: s.feedbackAttempt });

      const a = await attach();
      try {
        // Always start from a clean page. Clearing a previously-attached file is fiddly
        // and varies by dropzone; reloading and re-attaching is idempotent and sidesteps
        // the whole "which zip is actually attached" class of bug.
        const page = await openNewSubmission(a, runDir);
        const r = await fillSubmissionForm({
          page, runDir, taskDir: ws,
          zipPath: s.zipPath!,
          explanations: s.explanations!,
        });
        if (r.submissionUid) await patchTask(row.task_id, { submission_id: r.submissionUid });

        await transition(ctx, row, ws, S.CHECKING_FEEDBACK, {
          stage: "upload",
          message: `form filled${r.submissionUid ? ` · uid ${r.submissionUid.slice(0, 8)}` : ""}`,
          detail: { instruction_words: r.instructionAudit.stats.words },
        });
        patchState(ws, { feedbackStartedAt: null });
      } catch (e) {
        const msg = (e as Error).message;
        // An attestation refusal or a broken selector is a human problem, not a retry.
        const human = e instanceof AttestationRefused || e instanceof FormNotReady || e instanceof SelectorNotFound;
        await fail(ctx, row, ws, "upload", msg, human);
      } finally {
        await detach(a);
      }
      return true;
    }

    // ------------------------------------------------------------- FEEDBACK
    case S.CHECKING_FEEDBACK: {
      const s = st();
      const runDir = runDirFor(cfg, slug, `feedback-${s.feedbackAttempt}`);
      await emitEvent({
        task_id: row.task_id, stage: "feedback", status: "started", attempt: s.feedbackAttempt,
        message: `check feedback (attempt ${s.feedbackAttempt + 1}/${cfg.retries.feedbackAttempts})`,
      });

      const a = await attach();
      try {
        const page = await snorkelPage(a, pageUrl("home"));
        const r = await checkFeedback({
          page, runDir,
          pollIntervalSec: cfg.feedback.pollIntervalSec,
          timeoutMin: cfg.feedback.timeoutMin,
          onHeartbeat: async (elapsedSec) => {
            await emitEvent({
              task_id: row.task_id, stage: "feedback", status: "heartbeat",
              attempt: s.feedbackAttempt,
              message: `waiting on Snorkel · ${Math.floor(elapsedSec / 60)}m${elapsedSec % 60}s`,
            });
          },
        });

        if (r.verdict === "pass") {
          // The rubric box is ticked ONLY now — after Snorkel itself says the build is clean.
          await enableRubricGeneration(page, runDir);
          await transition(ctx, row, ws, S.AWAITING_APPROVAL, {
            stage: "feedback",
            message: `✅ Snorkel checks passed in ${r.elapsedSec}s · rubric ticked · waiting for your approval`,
            detail: { elapsed_sec: r.elapsedSec },
          });
        } else {
          patchState(ws, { lastError: r.output });
          await emitEvent({
            task_id: row.task_id, stage: "feedback", status: "failed", attempt: s.feedbackAttempt,
            message: r.output.split("\n").find((l) => /fail|error|missing|invalid/i.test(l))?.slice(0, 120)
              ?? "Snorkel's checks rejected the build",
          });
          await transition(ctx, row, ws, S.FEEDBACK_FAILED, { stage: "feedback" });
        }
      } catch (e) {
        if (e instanceof FeedbackInconclusive) {
          patchState(ws, { lastError: e.message });
          await fail(ctx, row, ws, "feedback", e.message, true); // NEEDS_HUMAN, never a guess
        } else {
          await fail(ctx, row, ws, "feedback", (e as Error).message, e instanceof SelectorNotFound);
        }
      } finally {
        await detach(a);
      }
      return true;
    }

    case S.FEEDBACK_FAILED: {
      const s = st();
      if (s.feedbackAttempt + 1 >= cfg.retries.feedbackAttempts) {
        await fail(ctx, row, ws, "feedback",
          `Snorkel's checks failed ${cfg.retries.feedbackAttempts}x. Last output:\n${s.lastError ?? "(none)"}`);
        return true;
      }
      patchState(ws, { feedbackAttempt: s.feedbackAttempt + 1 });
      await transition(ctx, row, ws, S.REMOTE_FIX_RUNNING, { stage: "fix" });
      return true;
    }

    case S.REMOTE_FIX_RUNNING: {
      const s = st();
      await emitEvent({
        task_id: row.task_id, stage: "fix", status: "started", attempt: s.feedbackAttempt,
        message: "feeding Snorkel's CI output back to the build session",
      });
      try {
        await fixTask({
          workspace: ws,
          sessionId: s.claudeSessionId,
          template: "05-feedback-fix.md",
          vars: {
            attempt: s.feedbackAttempt,
            maxAttempts: cfg.retries.feedbackAttempts,
            feedback: s.lastError ?? "(no output captured)",
          },
          timeoutMin: cfg.claude.fixTimeoutMin,
          onProgress: async (msg) => {
            ctx.log(`${slug}  ${msg}`);
            await emitEvent({ task_id: row.task_id, stage: "fix", status: "heartbeat", message: msg });
          },
        });
        await emitEvent({
          task_id: row.task_id, stage: "fix", status: "completed", attempt: s.feedbackAttempt,
          message: "remote fix applied in the build session",
        });

        // Back through the LOCAL gate before re-uploading. A fix that satisfies Snorkel's
        // CI can quietly break the oracle, and uploading that would waste a whole lap.
        patchState(ws, { attempt: 0 });
        await transition(ctx, row, ws, S.VERIFY_RUNNING, {
          stage: "fix", message: "re-verifying locally before re-upload",
        });
      } catch (e) {
        if (e instanceof RateLimited) throw e;
        await fail(ctx, row, ws, "fix", (e as Error).message);
      }
      return true;
    }

    // --------------------------------------------------------------- SUBMIT
    case S.AWAITING_APPROVAL:
      // Parks here indefinitely and safely. The dashboard's "Approve & Submit" button is
      // the only thing that moves it, and that is the point.
      return false;

    case S.SUBMITTING: {
      const s = st();
      const runDir = runDirFor(cfg, slug, "submit");
      const a = await attach();
      try {
        // A crash in SUBMITTING means we do not know whether the click landed. Look before
        // clicking: a duplicate submission cannot be undone.
        const existing = await findSubmitted(a, row.task_id, runDir);
        const outcome = existing.submitted
          ? { ...existing, note: `already submitted — did not click again (${existing.note})` }
          : await clickSubmit(a, await snorkelPage(a, pageUrl("home")), row.task_id, runDir);

        await patchTask(row.task_id, {
          task_status: TaskStatus.AI_REVIEW, // 1 = AI review, per your lifecycle
          ...(outcome.submissionId ? { submission_id: outcome.submissionId } : {}),
          ...(outcome.assignmentId ? { assignment_id: outcome.assignmentId } : {}),
        });
        await transition(ctx, row, ws, S.SUBMITTED, {
          stage: "submit",
          message: `submitted · task_status → AI review · ${outcome.note}`,
          detail: { submission_id: outcome.submissionId, assignment_id: outcome.assignmentId },
        });
      } catch (e) {
        // Ambiguous submit state is exactly when a machine must stop and a human must look.
        await fail(ctx, row, ws, "submit", (e as Error).message, true);
      } finally {
        await detach(a);
      }
      return true;
    }

    case S.SUBMITTED:
    case S.FAILED:
    case S.NEEDS_HUMAN:
      return false;

    default:
      await fail(ctx, row, ws, "build", `Unknown pipeline_state ${row.pipeline_state}`, true);
      return true;
  }
}

export { S as PipelineState, TaskStatus };
