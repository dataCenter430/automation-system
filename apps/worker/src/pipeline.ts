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
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  PipelineState as S, stateName, TaskStatus,
} from "../../../packages/shared/src/status.ts";
import {
  patchTask, emitEvent, upsertImplementation,
} from "../../../packages/shared/src/supabase.ts";
import type { TerminusRow } from "../../../packages/shared/src/types.ts";
import type { ParsedTask } from "../../../packages/shared/src/parse-task-blob.ts";
import {
  readState, writeState, patchState, type LocalState, type RejectedDesign,
} from "./state.ts";
import { readDesign, axesExhausted, designFingerprint } from "./stages/design-gate.ts";
import { createHash } from "node:crypto";
import { slackConfig, notifyHuman } from "./notify/slack.ts";
import { snap } from "./browser/actions.ts";
import { closeEditor, touchEditor } from "./util/open-editor.ts";
import { buildTask, fixTask, buildAlreadyComplete, BuildIncomplete } from "./stages/build.ts";
import { verifyTask } from "./stages/verify.ts";
import { zipTask, assertNoWrapperDir } from "./stages/zip.ts";
import { generateExplanations } from "./stages/explain-generate.ts";
import { openNewSubmission, fillSubmissionForm, AttestationRefused, FormNotReady } from "./stages/upload.ts";
import { findInReviseQueue, readReviseInput, writeRubric, RubricRejected } from "./stages/revise.ts";
import { formatRubricReport, lintRubric } from "./stages/rubric-lint.ts";
import { checkFeedback, FeedbackInconclusive } from "./stages/feedback.ts";
import { findSubmitted, clickSubmit, finaliseForm, pickAht } from "./stages/submit.ts";
import { readQueue, QUEUE_LIMIT } from "./stages/queue-gate.ts";
import { canonicalBaseImage } from "./stages/canonical-image.ts";
import { attach, detach, snorkelPage, BrowserUnavailable, type Attached } from "./browser/cdp.ts";
import { SelectorNotFound, UnconfirmedSelector, assertConfirmed, resolve_ } from "./browser/selectors.ts";
import { RateLimited } from "./claude/errors.ts";
import { Semaphore } from "./util/semaphore.ts";
import type { Config } from "./config.ts";

export interface Ctx {
  cfg: Config;
  log: (msg: string) => void;
}

/**
 * The Docker gate is the one genuinely CPU-hungry stage: an image build plus two container
 * runs, each handed docker.cpus (2) and docker.memoryMb (4096). On a 4-core box two of those
 * already saturate it. Running eight would not make anything faster — it would make every
 * gate time out at once, and the pipeline would record eight task failures that were really
 * one scheduling mistake.
 *
 * Claude turns queue separately (see claude/session.ts). Tasks overlap; gates take turns.
 */
let gateSlots: Semaphore | null = null;
function dockerGate(cfg: Config): Semaphore {
  if (!gateSlots) gateSlots = new Semaphore(Math.max(1, cfg.docker.maxConcurrentGates));
  return gateSlots;
}

/**
 * For the worker's status line: how loaded is the docker gate right now?
 *
 * The semaphore is created lazily on the first gate, so "no gate has ever run" reports
 * an idle gate rather than throwing — which is the truth, not a fudge.
 */
export function gateLoad(): { inUse: number; queued: number } {
  if (!gateSlots) return { inUse: 0, queued: 0 };
  return { inUse: gateSlots.inUse, queued: gateSlots.queued };
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
/**
 * Pipeline states where the VS Code window has nothing left to show, so it is closed.
 *
 * The operator's rule: "close vs codes for finished work once submit or revise". So: pass 1 has
 * landed (SUBMITTED — Snorkel now has it and is running CI), and pass 2 has landed
 * (SENT_TO_REVIEWER — a human reviewer has it). Both are moments where the build is genuinely over.
 *
 * DELIBERATELY ABSENT: FAILED and NEEDS_HUMAN. Those are the two states where you most want an
 * editor open on the task — it stopped and it wants you to look at it. Closing the window on a task
 * that just failed would be taking away the thing you need.
 */
const EDITOR_DONE: readonly number[] = [S.SUBMITTED, S.SENT_TO_REVIEWER];

/**
 * Did the gate stop at the CATEGORY CLASSIFIER?
 *
 * That failure is different in kind from every other one the gate produces. A ruff error is a
 * defect in a good task; a blocked category means the task is asking for the wrong thing, and no
 * amount of patching will fix it — it has to be rebuilt. So it gets a different prompt.
 *
 * Matched on the report classify.ts writes, which begins "STAGE: category classifier".
 */
function isCategoryBlock(lastError: string | null | undefined): boolean {
  return /^STAGE:\s*category classifier/im.test(lastError ?? "");
}

/**
 * A stable fingerprint of a failure, so we can tell "failed again" from "failed the SAME WAY again".
 *
 * Retries are uncapped, which is right — a task that needs five attempts should get them. But an
 * uncapped loop on an UNFIXABLE task would burn rate limit forever, and rate limit is the one thing
 * this system genuinely spends. So the loop is bounded by PROGRESS: the same fingerprint N times
 * running means the fix turns are not moving anything, and it is time to say so.
 *
 * Deliberately coarse — the STAGE line plus the first real line of the report. Confidences,
 * timings, paths and attempt counters all move between runs while the failure is the same failure,
 * and a fingerprint that changed every time would never trip.
 */
function failureSignature(lastError: string | null | undefined, ws?: string): string | null {
  const e = (lastError ?? "").trim();
  if (!e) return null;
  const stage = /^STAGE:\s*(.+)$/im.exec(e)?.[1]?.replace(/\s*\(.*$/, "").trim() ?? "";

  // A CATEGORY BLOCK IS FINGERPRINTED BY THE DESIGN, NOT BY THE VERDICT.
  //
  // This used to fingerprint the first line of the report — which, for a category block, is a
  // sentence containing only the predicted and the declared category. So a task that was
  // rebuilt from scratch into three unrelated deliverables (a Terraform spec recovery, a
  // threshold calibrator, a champion/challenger selector) produced ONE byte-identical
  // fingerprint all three times, because all three were still read as software-engineering.
  //
  // The stuck detector then announced "the fix loop is going in circles. Another turn of the
  // same crank will produce the same failure" — about a loop that had rebuilt the entire task
  // twice. It could not tell "the fixer changed nothing" from "the fixer changed everything and
  // it is still blocked", and it called the second one the first. That is a lie the code was
  // structurally incapable of not telling, and it killed a task that was genuinely exploring.
  //
  // The design's identity is its GRADING AXIS — what the assertions MEASURE. That is the thing
  // three rebuilds never changed, and it is the only thing whose repetition means "circling".
  if (isCategoryBlock(e) && ws) {
    const d = readDesign(ws);
    const axis = d?.gradingAxis ?? "unknown-axis";
    const tests = (d?.testNames ?? []).map((t) => t.toLowerCase()).sort().join(",");
    return `category classifier::${axis}::${hash(tests)}`;
  }

  const first = e
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !/^STAGE:/i.test(l)) ?? "";
  return `${stage}::${first.replace(/[\d.]+/g, "#").slice(0, 120)}`;
}

/** Short, stable, and only ever compared to itself. */
function hash(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 12);
}

/**
 * Write the design that just got blocked into the ledger.
 *
 * Reads the classifier's own verdict off disk (verify.ts now writes classifier.json on the
 * BLOCKED branch too — it used to write it only when the task PASSED, which is why four
 * rejections in a row left four empty directories and nothing to learn from).
 */
async function recordRejectedDesign(ctx: Ctx, ws: string, s: LocalState): Promise<void> {
  const design = readDesign(ws);
  const verdict = readClassifierVerdict(ws);
  const tests = design?.testNames ?? builtTestNames(ws);

  const entry: RejectedDesign = {
    attempt: s.attempt,
    predicted: verdict?.predicted ?? "(unrecorded)",
    confidence: verdict?.confidence ?? 0,
    why: verdict?.why ?? firstLine(s.lastError),
    deliverable: design?.deliverable ?? "(no design.json — built before the design gate existed)",
    gradedOn: design?.gradedOn ?? "(unrecorded)",
    // NEVER FABRICATE THE AXIS. This used to default to "equality-vs-reference" when design.json
    // was absent — which is a guess, and a load-bearing one: the axis is the ledger's identity key
    // and what axesExhausted() counts. A wrong guess would both mask a genuinely new design as a
    // repeat AND burn one of the four legal axes for a design that may never have used it.
    // "unknown" is not a legal axis, so it can never collide with a real one or exhaust the space.
    gradingAxis: design?.gradingAxis ?? ("unknown" as RejectedDesign["gradingAxis"]),
    testNames: tests,
    at: new Date().toISOString(),
  };

  // IDEMPOTENT. VERIFY_FAILED is re-entered by the worker's poll loop (it is in the interrupted
  // list in index.ts), and a transition that fails midway would run this twice for one rejection.
  // Double-counting would inflate blockedStreak and trip "OUT OF IDEAS" on a task that had only
  // been blocked once.
  const ledger = [...(s.rejectedDesigns ?? [])];
  const fp = designFingerprint(entry);
  if (ledger.some((r) => designFingerprint(r) === fp)) {
    ctx.log(`  ↳ this design is already in the ledger — not double-counting it`);
    return;
  }

  ledger.push(entry);
  patchState(ws, { rejectedDesigns: ledger, blockedStreak: (s.blockedStreak ?? 0) + 1 });
  ctx.log(
    `  ↳ recorded rejected design #${ledger.length}: axis "${entry.gradingAxis}" ` +
      `→ blocked as ${entry.predicted} (${entry.confidence})`,
  );
}

/** The category task.toml declares. The classifier never reads it; the axis rules do. */
function declaredCategory(ws: string): string {
  try {
    const t = readFileSync(join(ws, "task.toml"), "utf8");
    return (/category\s*=\s*"([^"]+)"/.exec(t)?.[1] ?? "").trim().toLowerCase();
  } catch {
    return "";
  }
}

function firstLine(e: string | null | undefined): string {
  return (e ?? "").split("\n").map((l) => l.trim()).find((l) => l && !/^STAGE:/i.test(l)) ?? "";
}

/** The test names actually on disk — the fallback identity for a task built before design.json. */
function builtTestNames(ws: string): string[] {
  try {
    const p = join(ws, "tests", "test_outputs.py");
    if (!existsSync(p)) return [];
    return (readFileSync(p, "utf8").match(/^\s*def (test_\w+)/gm) ?? [])
      .map((m) => m.trim().replace(/^def /, ""));
  } catch {
    return [];
  }
}

interface ClassifierVerdict { predicted: string; confidence: number; why: string }

function readClassifierVerdict(ws: string): ClassifierVerdict | null {
  const s = readState(ws);
  const dir = s ? join(ws, ".pipeline") : null;
  if (!dir) return null;
  const p = join(dir, "classifier.json");
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, "utf8"));
    return { predicted: String(j.predicted ?? ""), confidence: Number(j.confidence ?? 0), why: String(j.why ?? "") };
  } catch {
    return null;
  }
}

/**
 * A HUMAN PRESSED RETRY. Make it mean something.
 *
 * It did not used to. `retryTarget()` sent a task that died in VERIFY_FAILED to BUILD_RUNNING,
 * where `buildAlreadyComplete()` found `.pipeline/BUILD_DONE` still sitting on disk from the
 * last build and jumped straight to BUILT — **without spending a single Claude turn**. The same
 * tree then went into the same gate and came out with the same verdict, and the task was back in
 * NEEDS_HUMAN within minutes. The web app's `attempt: 0` / `last_error: null` were dead writes:
 * state.json is only seeded from the DB `if (!existing)`, and `sameFailureCount` /
 * `lastFailureSig` live ONLY in state.json, where the web app cannot reach them.
 *
 * So the user's instruction — "on retry, let the session proceed with another testing logic" —
 * was not merely unimplemented. It was impossible: retry could not reach Claude at all.
 *
 * Now a retry after a category block:
 *   • banks the rejected design in the ledger (so the next one cannot repeat it),
 *   • DISCARDS the Claude session — an anchored session re-proposes its own design, and this one
 *     had already committed to the axis three times,
 *   • deletes BUILD_DONE, so BUILD_RUNNING must actually run,
 *   • clears the retry-scoped counters that the web app cannot touch.
 */
function reconcileRetry(ctx: Ctx, ws: string, row: TerminusRow, s: LocalState): void {
  // THE SIGNAL MUST BE UNAMBIGUOUS, BECAUSE THE RESPONSE IS DESTRUCTIVE.
  //
  // The obvious signal — "the DB's last_error is null but ours is not" — is a HEURISTIC, and a
  // dangerous one. `transition()` writes state.json first and the DB second, so a transient
  // patchTask failure (a dropped socket; we have had those) leaves the DB holding a stale null
  // while local holds the new error. On the next poll that heuristic would fire on a task nobody
  // touched, and it would delete BUILD_DONE and throw away the Claude session — destroying a
  // perfectly good build to "recover" from a retry that never happened.
  //
  // So use the one transition only a human can cause: the task was DEAD locally (FAILED or
  // NEEDS_HUMAN — states the worker never leaves on its own) and the DB says it is alive again.
  // Nothing but the retry endpoint resurrects a task, and no dropped write can fake it.
  const wasDead = s.pipelineState === S.FAILED || s.pipelineState === S.NEEDS_HUMAN;
  const nowAlive = row.pipeline_state !== S.FAILED && row.pipeline_state !== S.NEEDS_HUMAN;
  if (!wasDead || !nowAlive) return;

  const wasBlocked = isCategoryBlock(s.lastError);

  if (wasBlocked) {
    const design = readDesign(ws);
    ctx.log(
      `↻ retry after a category block — discarding the anchored session and forcing a NEW design` +
        (design ? ` (axis "${design.gradingAxis}" is now on the rejected list)` : ""),
    );
    // Force BUILD_RUNNING to actually spend a turn. Without this the retry is a no-op.
    rmSync(join(ws, ".pipeline", "BUILD_DONE"), { force: true });
    rmSync(join(ws, ".pipeline", "design.json"), { force: true });
  }

  patchState(ws, {
    attempt: 0,
    lastError: null,
    lastFailureSig: null,
    sameFailureCount: 0,
    // A human looked at it and said "go again". The exploration budget starts over — otherwise a
    // task that had already spent its streak would be declared OUT OF IDEAS on its first new gate,
    // and the Retry button would do nothing but re-print the message the human just dismissed.
    // The LEDGER survives (that is the whole point — it must not re-propose a rejected design);
    // only the budget resets.
    blockedStreak: 0,
    // A fresh session, but ONLY for a category block. Every other failure (a ruff error, a
    // broken oracle) is a defect in a good task, and the session that built it is the cheapest
    // thing that can fix it — throwing away its context there would be pure waste.
    ...(wasBlocked ? { claudeSessionId: null } : {}),
  });
}

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

  // Ping Slack when this transition lands the task on a human. Fire-and-forget and self-swallowing:
  // notifyHuman never throws, so a dead Slack cannot unwind a committed transition (same rule as the
  // editor close below).
  void maybeNotify(ctx, row, ws, to, ev.message);

  // The window's job is done. Closing is best-effort and must never fail a transition — the state
  // machine has already committed, and a stuck window is not worth unwinding it for.
  if (EDITOR_DONE.includes(to)) {
    void closeEditor(ws, `${stateName(to).toLowerCase().replace(/_/g, " ")} — the build is over`);
  } else {
    // Any other transition means this task is alive, so keep its window off the eviction block.
    touchEditor(ws);
  }
}

async function fail(ctx: Ctx, row: TerminusRow, ws: string, stage: any, err: string, needsHuman = false): Promise<void> {
  patchState(ws, { lastError: err });
  await transition(ctx, row, ws, needsHuman ? S.NEEDS_HUMAN : S.FAILED, { stage, message: err.split("\n")[0] });
}

/** Map the states where the pipeline blocks on a person to a Slack notification kind. */
const NOTIFY_STATE: Partial<Record<number, import("./notify/slack.ts").NotifyKind>> = {
  [S.NEEDS_HUMAN]: "needs-human",
  [S.FAILED]: "failed",
  [S.AWAITING_APPROVAL]: "awaiting-approval",
  [S.AWAITING_REVIEW_APPROVAL]: "awaiting-review-approval",
};

/**
 * Announce a "needs a human" transition to Slack, if configured for that kind. Reads the latest
 * lastError off disk for the "why". Never throws — notifyHuman swallows its own failures.
 */
async function maybeNotify(ctx: Ctx, row: TerminusRow, ws: string, to: number, message?: string): Promise<void> {
  const kind = NOTIFY_STATE[to];
  if (!kind) return;
  const cfg = slackConfig(ctx.cfg.slack);
  if (!cfg.enabled || !(ctx.cfg.slack?.notifyOn ?? []).includes(kind)) return;

  const r = await notifyHuman(cfg, {
    kind,
    slug: row.slug ?? row.task_id,
    title: row.title ?? undefined,
    message: readState(ws)?.lastError ?? message,
    consoleUrl: process.env.CONSOLE_URL, // optional; a bare "open the console" otherwise
  });
  if (!r.ok) ctx.log(`⚠ Slack notify failed: ${r.error}`);
}

/**
 * Perform ONE transition for this task.
 * Returns true if it did something, false if the task is parked or terminal.
 */
export async function advance(ctx: Ctx, row: TerminusRow): Promise<boolean> {
  const { cfg } = ctx;
  const slug = row.slug!;
  const ws = workspaceFor(cfg, slug);

  // ---- The workspace must belong to THIS task -------------------------------
  //
  // Every per-task resource in this system is keyed by SLUG, not task_id: the workspace, the
  // .pipeline/state.json inside it (which holds claude_session_id), runs/<slug>/,
  // Working/<slug>.zip, even the docker image name. But nothing enforced that a slug belongs
  // to only one task. slugify() is deterministic from the title and truncates to seven words,
  // and the dashboard lets the slug be hand-edited — so two tasks colliding on a slug is a
  // typo away, not a freak event.
  //
  // The consequence is not a race, it is worse: it needs no timing at all. Task B, finding
  // A's state.json already in the shared workspace, would read A's claudeSessionId and resume
  // A's CONVERSATION with B's prompt — or, if A had already finished, buildAlreadyComplete()
  // would return true, B would skip its build entirely, and A's task tree would be zipped and
  // uploaded as B.
  //
  // So: the state file names its owner, and we check. Two tasks, one slug, stops here.
  const existing = readState(ws);
  if (existing && existing.taskId !== row.task_id) {
    await fail(
      ctx, row, ws, "build",
      `Slug collision. workspace/${slug} already belongs to task ${existing.taskId}, but this ` +
        `is task ${row.task_id}.\n\n` +
        `Two tasks cannot share a workspace: it holds the Claude session id, the build, and ` +
        `the zip. Continuing would have resumed the other task's conversation, or shipped its ` +
        `task tree under this one's name.\n\n` +
        `Give this task a distinct slug in the dashboard and retry.`,
      true, // NEEDS_HUMAN — a human must pick the new slug; the machine must not guess one.
    );
    return true;
  }

  // Bootstrap local state on first entry (or if the workspace was wiped).
  if (!existing) {
    mkdirSync(ws, { recursive: true });
    writeState(ws, {
      taskId: row.task_id, slug,
      pipelineState: row.pipeline_state,
      claudeSessionId: row.claude_session_id,
      attempt: row.attempt ?? 0,
      feedbackAttempt: row.feedback_attempt ?? 0,
      zipPath: row.zip_path,
      explanations: null,
      submissionUrl: null,
      feedbackStartedAt: null,
      pass: 1,
      lastError: row.last_error,
      updatedAt: new Date().toISOString(),
    });
  }

  // A human pressed Retry. state.json is only seeded from the DB `if (!existing)` above, so
  // without this the retry's cleared last_error never reaches the file that actually drives the
  // pipeline — and a category-blocked task would re-enter BUILD_RUNNING, find BUILD_DONE still on
  // disk, skip Claude entirely, and land back in NEEDS_HUMAN with the identical verdict.
  if (existing) reconcileRetry(ctx, ws, row, existing);

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

      // A crash mid-build lands here with a session already recorded. If the build genuinely
      // finished and only the DB transition was lost, do not pay for it twice.
      //
      // This used to ask `missingFromManifest(ws).length === 0` — which is not the same
      // question. seedSkeleton() writes the ENTIRE manifest before Claude is ever called,
      // and the skeleton is a working hello-world task, so a build that died on its first
      // tool call left a workspace that answered "yes" and was shipped straight to the gate
      // — which passed it. buildAlreadyComplete() checks a marker we wrote ourselves, and
      // that the tree is not still the skeleton.
      if (resuming && buildAlreadyComplete(ws)) {
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
          openEditor: cfg.worker.openEditor,
          studyTimeoutMin: cfg.claude.studyTimeoutMin,
          buildTimeoutMin: cfg.claude.buildTimeoutMin,
          // Everything the classifier has already rejected for this task. A rebuild that does
          // not know what was already tried is condemned to try it again — which is exactly
          // what happened: three rebuilds, three domains, one grading axis, four rejections.
          rejectedDesigns: st().rejectedDesigns ?? [],
          designRounds: cfg.retries.designRounds ?? 4,
          designTimeoutMin: cfg.claude.designTimeoutMin ?? 15,
          // The SAME model the real gate uses. A design gate judging with a different model is a
          // different gate, and its approval would predict nothing about the real verdict.
          classifierModel: cfg.claude.classifierModel,
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

      const gate = dockerGate(cfg);
      if (gate.wouldBlock) {
        ctx.log(`${slug}  waiting for a docker gate (${gate.inUse} running, ${gate.queued} ahead)`);
        await emitEvent({
          task_id: row.task_id, stage: "verify", status: "heartbeat", attempt,
          message: `waiting for a docker gate (${gate.inUse} running, ${gate.queued} ahead)`,
        });
      }

      const r = await gate.run(() =>
        verifyTask({
          taskDir: ws,
          slug,
          runDir: runDirFor(cfg, slug, `verify-${attempt}`),
          cpus: cfg.docker.cpus,
          memoryMb: cfg.docker.memoryMb,
          buildTimeoutSec: cfg.docker.buildTimeoutSec,
          solveTimeoutSec: cfg.docker.solveTimeoutSec,
          testTimeoutSec: cfg.docker.testTimeoutSec,
          classifierModel: cfg.claude.classifierModel,
        }),
      );

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

      // ---- THE RETRY POLICY -------------------------------------------------------------------
      //
      // verifyAttempts: 0 means NO CAP. The operator's rule, and they are right: a cap turns a task
      // that needed five attempts into a dead task, and throws away everything already spent on it.
      // A build that is MAKING PROGRESS must not be killed by a counter.
      //
      // But uncapped is not the same as blind. The thing this system actually spends is rate limit,
      // and a task that CANNOT be fixed would burn it forever. So the loop is bounded by PROGRESS,
      // not by attempts: if the gate fails the SAME WAY N times running, we are going in circles —
      // and a machine going in circles should say so rather than keep going.
      const capped = cfg.retries.verifyAttempts > 0;
      if (capped && s.attempt + 1 >= cfg.retries.verifyAttempts) {
        await fail(ctx, row, ws, "verify",
          `Verify gate failed ${cfg.retries.verifyAttempts}x. Last failure:\n${s.lastError ?? "(none)"}`);
        return true;
      }

      // The streak means CONSECUTIVE category blocks. A failure of any other kind (a ruff error,
      // a broken oracle) is not a block, and letting it sit inside the streak would mean a task
      // that got blocked once, then failed lint twice, then got blocked once more would read as
      // "two designs blocked in a row" — which is false, and would march it toward OUT OF IDEAS
      // on evidence that does not exist.
      if (!isCategoryBlock(s.lastError) && (s.blockedStreak ?? 0) > 0) {
        patchState(ws, { blockedStreak: 0 });
      }

      const stuckAt = cfg.retries.stuckAfterIdenticalFailures ?? 3;
      const sig = failureSignature(s.lastError, ws);
      const repeats = sig && sig === s.lastFailureSig ? (s.sameFailureCount ?? 0) + 1 : 1;
      patchState(ws, { lastFailureSig: sig, sameFailureCount: repeats });

      // A blocked design goes into the ledger BEFORE anything else looks at it, so the next
      // redesign is handed the whole history rather than only the latest rejection. Nothing used
      // to record this at all — the four rejections that killed this task left literally zero
      // structured evidence behind (verify.ts wrote classifier.json only on the PASS branch), so
      // every redesign started blind and re-proposed what had already failed.
      if (isCategoryBlock(s.lastError)) {
        await recordRejectedDesign(ctx, ws, s);
      }

      const s3 = st();
      const blockedStreak = s3.blockedStreak ?? 0;
      const exploreBudget = cfg.retries.maxBlockedDesigns ?? 6;

      // TWO different ways to be done, and they are NOT the same thing. Conflating them is what
      // produced a confidently false accusation of circling against a task that had rebuilt
      // itself twice.
      //
      //   repeats >= stuckAt      the SAME DESIGN failed the same way again. Genuinely circling.
      //   blockedStreak >= budget N DIFFERENT designs were all blocked. Honest failure, not
      //                           circling — and it deserves to be described as what it is.
      if (repeats >= stuckAt) {
        await fail(
          ctx, row, ws, "verify",
          `STUCK: the SAME design has failed the same way ${repeats} times in a row ` +
            `(${s.attempt + 1} attempts total).\n\n` +
            `This is not a counter running out — retries are uncapped. It is the fix loop going in ` +
            `circles: the grading axis did not change between attempts, so neither did the verdict.\n\n` +
            `The wall we keep hitting:\n${s.lastError ?? "(none)"}\n\n` +
            `Retry to try again — a retry now DISCARDS the anchored session and forces a genuinely ` +
            `new design, with every rejected design on record so it cannot propose one of them again.`,
          true,
        );
        return true;
      }

      const ledger = s3.rejectedDesigns ?? [];
      const exhausted = isCategoryBlock(s.lastError) && axesExhausted(declaredCategory(ws), ledger);

      if (isCategoryBlock(s.lastError) && (blockedStreak >= exploreBudget || exhausted)) {
        const tried = ledger
          .map((r) => `  • axis "${r.gradingAxis}" — blocked as ${r.predicted} (${r.confidence})`)
          .join("\n");
        await fail(
          ctx, row, ws, "verify",
          (exhausted
            ? `OUT OF IDEAS: every grading axis this category can legally use has now been tried, ` +
              `and every one was blocked.\n\n`
            : `OUT OF IDEAS: ${blockedStreak} genuinely DIFFERENT designs have all been blocked.\n\n`) +
            `This is NOT the fix loop going in circles. Each of these was a different design, and ` +
            `the pipeline rebuilt the task for each one. The task as briefed may simply have no ` +
            `shape that fits its assigned category.\n\nWhat has been tried:\n${tried}\n\n` +
            `The wall:\n${s.lastError ?? "(none)"}\n\n` +
            `A human should decide whether this task belongs in a different category, or should be ` +
            `dropped. Retry to keep exploring anyway.`,
          true,
        );
        return true;
      }

      // Increment BEFORE the call: a crash inside the next state then burns one attempt, which is
      // the fail-safe direction.
      patchState(ws, { attempt: s.attempt + 1 });

      // A BLOCKED CATEGORY IS A REBUILD, NOT A FIX — AND A REBUILD NEEDS A FRESH SESSION.
      //
      // This used to go to FIX_RUNNING with `08-redesign.md` and `sessionId: claudeSessionId` —
      // i.e. it asked the session that had just authored the rejected design to redesign it, in
      // the same conversation, with all of its own prior reasoning still in context. It ran twice
      // and produced two more designs on the identical grading axis. The prompt even instructed it
      // to "read instruction.md ALONE — no memory of what you just did", which is not something a
      // resumed session can do, however sincerely it tries.
      //
      // So a category block now re-enters BUILD_RUNNING, which is the only path that:
      //   • starts a FRESH session (the anchor is gone),
      //   • re-runs the study turn, so the corrected playbook is actually re-read,
      //   • runs the DESIGN GATE, with the ledger of everything already rejected,
      //   • and has onSessionId wired, so the new session id is persisted rather than dropped.
      //     (fixTask returns void and never reads back a new session id — handing it a null
      //     session would have silently orphaned the conversation every later stage depends on.)
      if (isCategoryBlock(s.lastError)) {
        rmSync(join(ws, ".pipeline", "BUILD_DONE"), { force: true });
        rmSync(join(ws, ".pipeline", "design.json"), { force: true });
        patchState(ws, { claudeSessionId: null, explanations: null });
        await transition(ctx, row, ws, S.BUILD_RUNNING, {
          stage: "build",
          message:
            `blocked category — REBUILDING from a fresh session with a new design ` +
            `(attempt ${s.attempt + 2}, ${ledger.length} design(s) already rejected)`,
        });
        return true;
      }

      await transition(ctx, row, ws, S.FIX_RUNNING, {
        stage: "fix",
        message:
          `gate failed — attempt ${s.attempt + 2}` +
          (capped ? ` of ${cfg.retries.verifyAttempts}` : " (uncapped)"),
      });
      return true;
    }

    case S.FIX_RUNNING: {
      const s2 = st();
      await emitEvent({
        task_id: row.task_id, stage: "fix", status: "started", attempt: s2.attempt,
        message: "feeding the docker failure back to the build session",
      });
      try {
        // FIX_RUNNING is for DEFECTS IN A GOOD TASK — a ruff error, an unpinned image, a wrong
        // codebase_size, a broken oracle. For those, 03-fix.md is exactly right ("read the failure,
        // fix that, do not change the task") and the session that built the task is the cheapest
        // thing that can repair it: throwing away its context here would be pure waste.
        //
        // A BLOCKED CATEGORY NEVER REACHES THIS STATE ANY MORE. It used to, and it was routed here
        // with 08-redesign.md and the ORIGINAL SESSION ID — which asked the author of the rejected
        // design to redesign it inside its own conversation, with all of its prior reasoning still
        // in context. It obliged, twice, with two more designs on the identical grading axis.
        //
        // A blocked category is not a defect in a good task; it is the wrong task. VERIFY_FAILED
        // now sends it to BUILD_RUNNING with a fresh session, a re-read playbook, the design gate
        // and the ledger of everything already rejected. See the note there.
        await fixTask({
          workspace: ws,
          sessionId: s2.claudeSessionId,
          template: "03-fix.md",
          vars: {
            attempt: s2.attempt,
            maxAttempts: cfg.retries.verifyAttempts || "unlimited",
            failureReport: s2.lastError ?? "(no failure captured)",
          },
          timeoutMin: cfg.claude.fixTimeoutMin,
          onProgress: async (msg) => {
            ctx.log(`${slug}  ${msg}`);
            await emitEvent({ task_id: row.task_id, stage: "fix", status: "heartbeat", message: msg });
          },
        });
        // Straight back to the gate. The gate, not Claude, decides whether it is fixed.
        // The task tree just changed, so anything derived from it is stale — including the
        // three submission explanations. See the note at REMOTE_FIX_RUNNING below.
        patchState(ws, { explanations: null });
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

      let a: Attached | null = null;
      try {
        // attach() must be INSIDE the try: if Chrome is not running it throws, and outside
        // the try that would escape advance() entirely instead of parking the task.
        a = await attach();

        // WHICH PASS ARE WE ON — this decides whether we create a submission or edit one.
        //
        // Pass 1 opens a NEW submission from the home page. Pass 2 must NOT: the task already
        // has a submission, it is sitting on its revise page, and opening a new one would create
        // a SECOND submission of the same task and leave the first stranded in the revise queue
        // forever. So pass 2 returns to the revise URL and edits the form that is already there.
        const page =
          s.pass === 2 && s.submissionUrl
            ? await snorkelPage(a, s.submissionUrl)
            : await openNewSubmission(a, runDir);

        const r = await fillSubmissionForm({
          page, runDir, taskDir: ws,
          zipPath: s.zipPath!,
          explanations: s.explanations!,
        });

        // Pass 2 already HAS its uid, captured on pass 1. Do not overwrite it — it is the only
        // key that finds this task in the revise queue.
        if (s.pass !== 2 && r.submissionUid) {
          await patchTask(row.task_id, { submission_id: r.submissionUid });
        }

        // Pass 2 also carries the rubric Claude rewrote, which lives in the workspace rather
        // than the zip: it goes into a textbox on the page, not into the task tree. The
        // reviewer's complaint in the live DOM was almost entirely ABOUT this field, so a
        // revision that re-uploads a fixed tree and leaves the AI's original rubric in place
        // would be sent straight back.
        if (s.pass === 2) {
          const rubricPath = join(ws, ".pipeline", "rubric.md");
          if (!existsSync(rubricPath)) {
            throw new FormNotReady(
              `The revise turn did not write ${rubricPath}. The rubric is what the reviewer ` +
                `grades against and is the thing they most often send tasks back for — ` +
                `re-submitting with the AI's untouched rubric would waste the round trip.`,
            );
          }
          await writeRubric(page, readFileSync(rubricPath, "utf8"), runDir, ws);
        }

        // Remember WHERE the filled form is. The feedback and submit stages have to come
        // back to this exact page; asking for the home page navigated the form away.
        patchState(ws, { submissionUrl: r.submissionUrl, feedbackStartedAt: null });

        await transition(ctx, row, ws, S.CHECKING_FEEDBACK, {
          stage: "upload",
          message: `form filled${r.submissionUid ? ` · uid ${r.submissionUid.slice(0, 8)}` : ""}`,
          detail: { instruction_words: r.instructionAudit.stats.words },
        });
      } catch (e) {
        const msg = (e as Error).message;
        // An attestation refusal, a broken selector, an unconfirmed selector, or a Chrome
        // that simply isn't running are all human problems — not task failures. Parking a
        // good build at FAILED because nobody launched the browser would be a lie.
        const human =
          e instanceof AttestationRefused || e instanceof FormNotReady ||
          e instanceof SelectorNotFound || e instanceof UnconfirmedSelector ||
          e instanceof BrowserUnavailable;
        await fail(ctx, row, ws, "upload", msg, human);
      } finally {
        if (a) await detach(a);
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

      let a: Attached | null = null;
      try {
        // Go back to the FORM, not the home page. Asking for home here navigated the shared
        // tab away from the submission we had just filled in, so "Check feedback" was being
        // looked for on /home and could never be found.
        if (!s.submissionUrl) {
          throw new FormNotReady(
            "No submission URL was recorded for this task, so there is no filled form to " +
              "check feedback on. Re-run the upload stage.",
          );
        }
        a = await attach();
        const page = await snorkelPage(a, s.submissionUrl);
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
          // The green-run-only fields — rubric box, "Send to reviewer?", the two attestation
          // radios, the Task Inspiration id, the time budget — are NOT set here. finaliseForm()
          // sets them immediately before the click, in SUBMITTING or SENDING_TO_REVIEWER.
          //
          // The reason is the gap. A task parks at an approval state until a human presses the
          // button, which may be hours; the submit state then re-navigates to the submission URL.
          // State set here would have to survive that gap and that reload, on a form that
          // autosaves whenever it feels like it. Setting those fields on the page we are actually
          // about to submit, seconds before we submit it, removes the question entirely.
          //
          // WHICH APPROVAL, though. Pass 1 goes to a CI submission; pass 2 goes to a human
          // reviewer. They are different clicks with different consequences, so they are
          // different gates — and the second one is the one that puts a person's time on the line.
          const gate = s.pass === 2 ? S.AWAITING_REVIEW_APPROVAL : S.AWAITING_APPROVAL;
          await transition(ctx, row, ws, gate, {
            stage: "feedback",
            message:
              s.pass === 2
                ? `✅ Snorkel checks passed in ${r.elapsedSec}s · revision ready · approve to SEND TO A REVIEWER`
                : `✅ Snorkel checks passed in ${r.elapsedSec}s · waiting for your approval`,
            detail: { elapsed_sec: r.elapsedSec, pass: s.pass },
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
          const human =
            e instanceof SelectorNotFound || e instanceof UnconfirmedSelector ||
            e instanceof BrowserUnavailable || e instanceof FormNotReady;
          await fail(ctx, row, ws, "feedback", (e as Error).message, human);
        }
      } finally {
        if (a) await detach(a);
      }
      return true;
    }

    case S.FEEDBACK_FAILED: {
      const s = st();

      // `0` MEANS UNLIMITED — the same convention verifyAttempts uses eight hundred lines up
      // (`const capped = cfg.retries.verifyAttempts > 0`). This branch never applied it, and the
      // arithmetic was merciless: with feedbackAttempts = 0, `0 + 1 >= 0` is TRUE, so the FIRST
      // Snorkel CI failure went straight to terminal FAILED.
      //
      // The consequences were entirely invisible. REMOTE_FIX_RUNNING was unreachable, which means
      // 05-feedback-fix.md — the prompt whose whole job is to fix what Snorkel's own checks
      // rejected — HAS NEVER ONCE RUN. The operator set 0 to mean "keep trying until it passes",
      // and it silently meant "give up immediately", on the one loop where giving up costs a
      // submission slot.
      const capped = cfg.retries.feedbackAttempts > 0;
      if (capped && s.feedbackAttempt + 1 >= cfg.retries.feedbackAttempts) {
        await fail(ctx, row, ws, "feedback",
          `Snorkel's checks failed ${cfg.retries.feedbackAttempts}x. Last output:\n${s.lastError ?? "(none)"}`);
        return true;
      }
      patchState(ws, { feedbackAttempt: s.feedbackAttempt + 1 });
      await transition(ctx, row, ws, S.REMOTE_FIX_RUNNING, {
        stage: "fix",
        message: `Snorkel's checks failed — remote fix attempt ${s.feedbackAttempt + 1}` +
          (capped ? ` of ${cfg.retries.feedbackAttempts}` : " (uncapped)"),
      });
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
        //
        // And throw away the explanations. They are DERIVED from the task tree, and the task
        // tree just changed — sometimes completely. This nearly shipped: Snorkel rejected our
        // first task because a classifier read it as `debugging`, the fix turn redesigned the
        // task from "five defects are planted in this C++ file, find them" into a feature-store
        // rematerialization with no defects at all — and the EXPLAINED stage would have skipped
        // regeneration (`if (s.explanations) …`) and uploaded the OLD explanations, which open
        // with "I planted five defects in the C++ code", as the description of a task that no
        // longer has any. A stale explanation is worse than a missing one: it is a confident,
        // fluent lie about what you built, in your own voice, submitted under your name.
        patchState(ws, { attempt: 0, explanations: null });
        await transition(ctx, row, ws, S.VERIFY_RUNNING, {
          stage: "fix", message: "re-verifying locally before re-upload · explanations invalidated",
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
      let a: Attached | null = null;
      try {
        if (!s.submissionUrl) {
          throw new FormNotReady(
            "No submission URL was recorded, so there is no submission page to click Submit " +
              "on. Refusing to guess — re-run the upload stage.",
          );
        }
        a = await attach();

        // ---- THE ACCOUNT-SAFETY GATE ------------------------------------------------------
        // Snorkel limits submissions while the revision queue is full, and the operator's #1
        // rule is that this account must never do anything that could get it banned. So this
        // runs BEFORE the irreversible click, reads Snorkel's own "N tasks to be revised"
        // sentence (never a card count — the owner-filter userscript hides cards), and refuses
        // if it cannot be read at all. A blocked task goes back to AWAITING_APPROVAL rather
        // than failing: nothing is wrong with it, the queue is just full.
        const queue = await readQueue(a, runDir);
        if (!queue.maySubmit) {
          await patchState(ws, { lastError: queue.reason });
          await transition(ctx, row, ws, S.AWAITING_APPROVAL, {
            stage: "submit",
            message: queue.reason,
            detail: { total: queue.total, terminus: queue.terminus, limit: QUEUE_LIMIT },
          });
          return true;
        }

        // A crash in SUBMITTING means we do not know whether the click landed. Look before
        // clicking: a duplicate submission cannot be undone. findSubmitted() now does this
        // in a throwaway tab, so the submission form below survives the check.
        //
        // Keyed on SNORKEL'S submission uid, not row.task_id. task_id is the Task Gallery
        // uuid the operator pastes; the revise card is keyed by the uid Snorkel assigns. The
        // old code looked the card up by task_id, which never matched — so this guard answered
        // "not submitted yet" every single time, and a retry here would have clicked Submit a
        // second time. If the uid is missing, findSubmitted throws CannotReconcile rather than
        // guessing, and the task parks for a human.
        const existing = await findSubmitted(a, row.submission_id, runDir);
        let outcome;
        if (existing.submitted) {
          outcome = { ...existing, note: `already submitted — did not click again (${existing.note})` };
        } else {
          // The SUBMISSION page — not /home, which is what this used to hand to clickSubmit,
          // guaranteeing it looked for the Submit button on the wrong page.
          const page = await snorkelPage(a, s.submissionUrl);

          // "Does this task use an approved canonical base image?" is an ATTESTATION, so it is
          // computed from this task's own Dockerfile against Snorkel's list — never assumed.
          // `null` means we could not tell, and a statement we cannot verify is one we must not
          // sign: the task parks for a human instead.
          const base = canonicalBaseImage(ws);
          if (base.canonical === null) {
            throw new Error(
              `Refusing to submit: cannot determine whether this task uses an approved canonical ` +
                `base image — ${base.why}\n\n` +
                `That question is an attestation on Snorkel's form. Answering it without knowing ` +
                `would be signing a statement we have not checked.`,
            );
          }

          // PASS 1 of two. rubric = TRUE, sendToReviewer = FALSE.
          //
          // This submission is SUPPOSED to come back to the revise queue: that is how Snorkel
          // generates the rubric ("Rubric guide line.txt" line 30-31). Pass 2 — untick rubric,
          // tick send-to-reviewer — happens on the revise page, after the rubric exists and has
          // been edited. Ticking both at once is what line 32 warns overwrites your rubric.
          await finaliseForm(page, runDir, {
            taskId: row.task_id,
            ahtMinutes: pickAht(),
            pass: "ci",
            canonicalBaseImage: base.canonical,
          });

          outcome = await clickSubmit(a, page, row.submission_id, runDir);
        }

        await patchTask(row.task_id, {
          task_status: TaskStatus.AI_REVIEW, // 1 = AI review, per your lifecycle
          // NOTE: submission_id is NOT written here. It is captured from the page header during
          // upload and is the real per-task uid. The old code overwrote it with a uuid parsed
          // out of the revise-card href — which is the PROJECT'S submission-stage id and is
          // identical on every Terminus card (941bede0-…). Writing it here destroyed the one
          // identifier the revise queue can be searched by.
          ...(outcome.assignmentId ? { assignment_id: outcome.assignmentId } : {}),
        });
        await transition(ctx, row, ws, S.SUBMITTED, {
          stage: "submit",
          message: `submitted · task_status → AI review · ${outcome.note}`,
          detail: { submission_id: row.submission_id, assignment_id: outcome.assignmentId },
        });
      } catch (e) {
        // Ambiguous submit state is exactly when a machine must stop and a human must look.
        // That includes "the Submit selector is still a guess" (UnconfirmedSelector), "I cannot
        // tell whether this was already submitted" (CannotReconcile), and "I cannot read the
        // revision queue" (QueueUnreadable).
        await fail(ctx, row, ws, "submit", (e as Error).message, true);
      } finally {
        if (a) await detach(a);
      }
      return true;
    }

    // ----------------------------------------------------------- PASS 2: THE REVISE LAP
    //
    // SUBMITTED is not the end. Pass 1 ticked the rubric box and left "Send to reviewer?"
    // unticked, so Snorkel is generating a rubric and will hand the task BACK to us in "Tasks
    // to be revised" (Rubric guide, lines 30-31). Until this lap existed, SUBMITTED was
    // terminal — so every submission added one to a queue nothing ever drained, and the moment
    // a queue gate arrived the whole pipeline deadlocked.

    case S.SUBMITTED: {
      // Waiting on Snorkel. Poll the revise queue for OUR submission uid; it appears when CI
      // finishes. Nothing to do but look, so this is cheap and holds no slots.
      if (!row.submission_id) {
        await fail(
          ctx, row, ws, "revise",
          `This task was submitted but has no Snorkel submission UID recorded, so it cannot be ` +
            `found in the revise queue and pass 2 can never run for it. The uid is read from the ` +
            `submission page header during upload.`,
          true,
        );
        return true;
      }

      let a: Attached | null = null;
      try {
        a = await attach();
        const target = await findInReviseQueue(a, row.submission_id, runDirFor(cfg, slug, "revise"));
        if (!target) return false; // not back yet — check again next tick

        patchState(ws, { submissionUrl: target.url });
        await patchTask(row.task_id, {
          ...(target.assignmentId ? { assignment_id: target.assignmentId } : {}),
        });
        await transition(ctx, row, ws, S.REVISE_PENDING, {
          stage: "revise",
          message: `Snorkel returned it for revision — the rubric is ready`,
          detail: { assignment_id: target.assignmentId },
        });
      } catch (e) {
        if (e instanceof BrowserUnavailable) return false; // Chrome is not up; try later
        await fail(ctx, row, ws, "revise", (e as Error).message, true);
      } finally {
        if (a) await detach(a);
      }
      return true;
    }

    case S.REVISE_PENDING:
    case S.REVISE_RUNNING: {
      const s = st();
      const runDir = runDirFor(cfg, slug, `revise-${s.feedbackAttempt}`);
      let a: Attached | null = null;

      try {
        if (!s.submissionUrl) throw new FormNotReady("No revise URL recorded for this task.");
        await transition(ctx, row, ws, S.REVISE_RUNNING, { stage: "revise", message: "reading the reviewer's feedback" });

        a = await attach();
        const page = await snorkelPage(a, s.submissionUrl);

        // The reviewer's words and the AI-generated rubric. Read from the DOM, per-tab — NOT via
        // the extension's clipboard button: the clipboard is one global slot and eight concurrent
        // revisions would hand each other the wrong feedback. Refuses on a partial read.
        const input = await readReviseInput(page, runDir);
        await emitEvent({
          task_id: row.task_id, stage: "revise", status: "heartbeat",
          message: `reviewer: ${input.feedback.split("\n")[0]!.slice(0, 120)}`,
        });

        // Claude fixes the TREE and rewrites the RUBRIC, in the same session that built the task
        // — it still has the whole thing in context, which is the entire reason we resume rather
        // than start fresh.
        await fixTask({
          workspace: ws,
          sessionId: s.claudeSessionId,
          template: "06-revise.md",
          vars: {
            attempt: s.feedbackAttempt + 1,
            maxAttempts: 3,
            feedback: input.feedback,
            rubric: input.rubric || "(Snorkel generated no rubric for this submission.)",
          },
          timeoutMin: cfg.claude.fixTimeoutMin,
          onProgress: async (m) => {
            await emitEvent({ task_id: row.task_id, stage: "revise", status: "heartbeat", message: m });
          },
        });

        // ---- The rubric must be LEGAL before we go anywhere near the browser ------------------
        //
        // Snorkel marks every rubric rule "High" severity: one failure and the task is not
        // accepted. The rules are mechanical, so they are checked here rather than hoped for —
        // and checked NOW, while the Claude session is still warm and can fix its own output,
        // rather than at upload time when the only remaining move is to park the task.
        //
        // One retry. If Claude cannot produce a legal rubric with the errors in front of it, the
        // problem is not a typo and a human should look.
        const rubricPath = join(ws, ".pipeline", "rubric.md");
        for (let attempt = 0; attempt < 2; attempt += 1) {
          if (!existsSync(rubricPath)) {
            throw new FormNotReady(
              `The revise turn did not write ${rubricPath}. The rubric is what the reviewer grades ` +
                `against and is the thing they most often send tasks back for.`,
            );
          }
          const report = lintRubric(readFileSync(rubricPath, "utf8"), ws);
          if (report.ok) {
            await emitEvent({
              task_id: row.task_id, stage: "revise", status: "heartbeat",
              message: `rubric OK — ${report.criteria.length} criteria, ${report.negatives} negative`,
            });
            break;
          }
          if (attempt === 1) throw new RubricRejected(formatRubricReport(report));

          await emitEvent({
            task_id: row.task_id, stage: "revise", status: "heartbeat",
            message: `rubric breaks ${report.findings.filter((f) => f.severity === "blocking").length} of Snorkel's rules — handing them back to Claude`,
          });
          await fixTask({
            workspace: ws,
            sessionId: readState(ws)!.claudeSessionId,
            template: "07-rubric-fix.md",
            vars: { report: formatRubricReport(report), workspace: ws },
            timeoutMin: cfg.claude.explainTimeoutMin,
            onProgress: async (m) => {
              await emitEvent({ task_id: row.task_id, stage: "revise", status: "heartbeat", message: m });
            },
          });
        }

        // The revision CHANGED THE TASK. The gate that blessed the old tree says nothing about
        // the new one, and the explanations describe a task that no longer exists.
        // From here the task re-walks VERIFY -> ZIP -> EXPLAIN -> UPLOAD -> CHECK FEEDBACK,
        // the same states as the first build. `pass: 2` is what stops those states from treating
        // this as a fresh submission and opening a SECOND one.
        patchState(ws, { explanations: null, feedbackAttempt: s.feedbackAttempt + 1, pass: 2 });
        await transition(ctx, row, ws, S.VERIFY_RUNNING, {
          stage: "revise",
          message: "reviewer feedback applied · re-running the local gate before anything is re-uploaded",
        });
      } catch (e) {
        if (e instanceof RateLimited) return false;
        await fail(ctx, row, ws, "revise", (e as Error).message, true);
      } finally {
        if (a) await detach(a);
      }
      return true;
    }

    case S.AWAITING_REVIEW_APPROVAL:
      // The SECOND human gate. Tree re-gated, zip re-uploaded, rubric rewritten. The next click
      // sends it to a person, and it is yours.
      return false;

    case S.SENDING_TO_REVIEWER: {
      const s = st();
      const runDir = runDirFor(cfg, slug, "send-to-reviewer");
      let a: Attached | null = null;
      try {
        if (!s.submissionUrl) throw new FormNotReady("No revise URL recorded for this task.");
        a = await attach();

        const base = canonicalBaseImage(ws);
        if (base.canonical === null) {
          throw new Error(`Cannot attest to the base image — ${base.why}`);
        }

        const page = await snorkelPage(a, s.submissionUrl);

        // PASS 2. rubric = FALSE, sendToReviewer = TRUE.
        //
        // Untick the rubric box: "Submitting with the checkbox checked might cause your rubric
        // to be overwritten upon submission" — and the rubric is the thing we just spent a Claude
        // turn rewriting to match the reviewer's complaint.
        await finaliseForm(page, runDir, {
          taskId: row.task_id,
          ahtMinutes: pickAht(),
          pass: "reviewer",
          canonicalBaseImage: base.canonical,
        });

        assertConfirmed("submission.submitButton");
        const btn = await resolve_(page, "submission.submitButton");
        await snap(page, runDir, "pre-send-to-reviewer");
        await btn.click();
        await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {});
        await snap(page, runDir, "post-send-to-reviewer");

        // Pass 2 reconciles INVERSELY to pass 1: a task that has gone to a reviewer LEAVES the
        // revise queue. So "still in the queue" means the click did not land, and "gone from the
        // queue" is the success signal — the exact opposite of findSubmitted()'s oracle.
        const still = await findInReviseQueue(a, row.submission_id!, runDir);
        if (still) {
          throw new Error(
            `Clicked Submit, but the task is STILL in the revise queue. The send-to-reviewer ` +
              `click did not take. Not retrying automatically — look at ${runDir}.`,
          );
        }

        await patchTask(row.task_id, { task_status: TaskStatus.HUMAN_REVIEW });
        await transition(ctx, row, ws, S.SENT_TO_REVIEWER, {
          stage: "revise",
          message: "sent to a human reviewer · task_status → Human review",
        });
      } catch (e) {
        await fail(ctx, row, ws, "revise", (e as Error).message, true);
      } finally {
        if (a) await detach(a);
      }
      return true;
    }

    case S.SENT_TO_REVIEWER:
    case S.FAILED:
    case S.NEEDS_HUMAN:
      return false;

    default:
      await fail(ctx, row, ws, "build", `Unknown pipeline_state ${row.pipeline_state}`, true);
      return true;
  }
}

export { S as PipelineState, TaskStatus };
