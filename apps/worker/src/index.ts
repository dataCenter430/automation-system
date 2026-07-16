/**
 * The worker loop.
 *
 * Two properties worth stating out loud, because everything else follows from them:
 *
 *  1. It NEVER starts a DRAFT task. Only the human's "Start Build" click moves a row to
 *     QUEUED. A task can sit in the queue forever and nothing will spend a Claude session
 *     or a Docker build on it.
 *
 *  2. It advances tasks ONE transition at a time, round-robin. A task parked in
 *     CHECKING_FEEDBACK (which can take 20 minutes) yields the worker to another task
 *     instead of blocking it. This is why `advance()` returns after a single step.
 */
import "dotenv/config";
import { loadConfig } from "./config.ts";
import { preflight, report } from "./preflight.ts";
import { advance, gateLoad, type Ctx } from "./pipeline.ts";
import {
  claimNextTask, findInterrupted, getTask, patchTask,
} from "../../../packages/shared/src/supabase.ts";
import {
  CRASHED_MIDFLIGHT, PipelineState as S, stateName, isTerminal,
} from "../../../packages/shared/src/status.ts";
import { RateLimited } from "./claude/errors.ts";
import { claudeLoad, sessionExists } from "./claude/session.ts";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { acquire, release, AlreadyRunning } from "./lock.ts";
import { withDeadline } from "./util/deadline.ts";
import { readState, patchState } from "./state.ts";
import { realRunner, submissionsList } from "./stb/cli.ts";
import { ensureReady, realLoginRunner } from "./stb/login.ts";
import { reconcile, WAITING_ON_SNORKEL } from "./stb/reconcile.ts";
import { recordAccepted, factsOf } from "./stages/accepted.ts";
import type { TerminusRow } from "../../../packages/shared/src/types.ts";

const cfg = loadConfig();
const ts = () => new Date().toISOString().slice(11, 19);
const ctx: Ctx = { cfg, log: (m) => console.log(`[${ts()}] ${m}`) };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Tasks this process is currently stepping, so we never double-drive one. */
const inFlight = new Set<string>();
let stopping = false;

/**
 * The fleet meters.
 *
 * The worker is the only process that knows its own load: the Claude semaphore and the
 * docker-gate semaphore live in THIS process's memory, and the web app cannot see inside
 * it. So the worker writes what it knows to runs/.worker-status.json every tick and
 * GET /api/fleet reads it back.
 *
 * Written tmp+rename, for the same reason state.json is: the dashboard polls this file on
 * a 3s timer, and a half-written JSON would be read as a crashed worker.
 *
 * `at` is the liveness signal. It is refreshed on EVERY tick — including while rate-limit
 * backoff is parked — because a worker that is waiting out a 429 is alive, and letting its
 * status go stale would tell the dashboard it had died. Conversely, nothing here ever
 * deletes the file: a killed worker leaves its last status behind and /api/fleet marks it
 * stale from the timestamp. A dead worker must not read as an idle one.
 */
const STATUS_FILE = resolve(cfg.paths.runs, ".worker-status.json");

function writeStatus(): void {
  const claude = claudeLoad();
  const gates = gateLoad();
  const status = {
    pid: process.pid,
    at: new Date().toISOString(),
    // `blocked` is a SUBSET of inUse: sessions frozen inside an ask_human tool call, holding
    // their slot while they wait for a person. Reported separately because a fleet whose six
    // slots are all parked on unanswered questions is indistinguishable, on every other meter,
    // from a fleet that is simply busy — and the fix for the two is not the same.
    claude: {
      inUse: claude.running,
      queued: claude.queued,
      max: cfg.claude.maxConcurrent,
      blocked: claude.blocked,
    },
    gates: { inUse: gates.inUse, queued: gates.queued, max: cfg.docker.maxConcurrentGates },
    tasksInFlight: inFlight.size,
    maxParallel: cfg.worker.maxParallelTasks,
  };
  try {
    mkdirSync(cfg.paths.runs, { recursive: true });
    const tmp = `${STATUS_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(status, null, 2), "utf8");
    renameSync(tmp, STATUS_FILE);
  } catch {
    // These are diagnostics. A full disk must never take the pipeline down with it.
  }
}

/** Rate limits are a subscription reality, not a bug. Back off; never burn a retry. */
let backoffUntil = 0;

/**
 * THE POLL LOOP MUST NEVER BLOCK FOREVER, AND MUST NEVER LEAVE QUIETLY.
 *
 * Both halves of that are scar tissue, from one night that cost eight tasks.
 *
 * The VM's NIC dropped and re-leased (`dhcp4 (ens33): new lease`, 22:55:40; NetworkManager
 * did not reach CONNECTED_GLOBAL again until 22:58:10). The loop was parked on an un-timed
 * Supabase fetch. The socket went away underneath it and THE PROMISE NEVER SETTLED — no
 * rejection, so nothing was thrown and nothing was caught. The heartbeat froze at 22:43:41
 * while the in-flight Claude session, which owned handles of its own, kept logging happily
 * for another twelve minutes. When that session finished at 22:56:29 the process had no
 * live handles and no runnable work left, so node's event loop simply drained and the
 * worker EXITED WITHOUT A WORD: no throw, no `💥` line in runs/worker.log, no OOM in the
 * kernel log, exit code 0. Nothing supervised it, so it stayed dead for an hour and forty
 * minutes — while the dashboard went on pulsing VERIFYING at a task nobody was driving.
 *
 * Hence, in order: a deadline on every await, a try/catch on every tick, a watchdog that
 * holds the event loop open and shouts if the loop stops turning, and a message on every
 * route out of this process. A network blip must cost one poll interval, not a night.
 */
const DB_TIMEOUT_MS = 20_000;

/** The loop stopped turning. Distinct from any DB error, so the watchdog can name the cause. */
const WEDGED_AFTER_MS = 120_000;

/** Set at the top of every tick. The watchdog reads it; nothing else may write it. */
let lastTickAt = Date.now();

async function step(taskId: string): Promise<void> {
  if (inFlight.has(taskId)) return;
  inFlight.add(taskId);
  try {
    let moved = true;
    // Keep stepping this task while it keeps moving, so a fast chain of transitions
    // (BUILT → VERIFY_RUNNING → …) doesn't wait a poll interval between each.
    while (moved && !stopping) {
      const row = await getTask(taskId);
      if (!row || isTerminal(row.pipeline_state)) break;
      moved = await advance(ctx, row);
    }
  } catch (e) {
    if (e instanceof RateLimited) {
      backoffUntil = Date.now() + cfg.claude.rateLimitBackoffSec * 1000;
      ctx.log(`⏸  rate limited — backing off ${cfg.claude.rateLimitBackoffSec}s (no retry burned)`);
      return;
    }
    ctx.log(`💥 ${taskId}: ${(e as Error).message}`);
  } finally {
    inFlight.delete(taskId);
  }
}

/**
 * The hourly Snorkel reconciliation. One `stb submissions list`, mapped onto local task states —
 * see stb/reconcile.ts for the mapping. Self-guarded (never overlaps, never throws into the loop),
 * and inert until stb is configured with a projectId.
 */
let lastReconcileAt = 0;
let reconcileInFlight = false;

/** Snorkel's numeric task_status enum: 0 working · 1 AI review · 2 human review · 3 accepted. */
const TASK_STATUS_NUM: Record<string, number> = { HUMAN_REVIEW: 2, ACCEPTED: 3, OFFERED: 3 };

async function reconcileSnorkel(): Promise<void> {
  if (reconcileInFlight) return;
  const stbCfg = cfg.stb;
  if (!stbCfg?.projectId) return;
  reconcileInFlight = true;
  try {
    // Cheap when already authenticated (just `keys show`); refreshes AI creds only on a fresh login.
    await ensureReady(realRunner, realLoginRunner, { env: process.env, log: ctx.log });
    const stbCtx = { run: realRunner, projectId: stbCfg.projectId };

    await reconcile({
      waitingTasks: async () => {
        const rows = await withDeadline(findInterrupted(WAITING_ON_SNORKEL as number[]), DB_TIMEOUT_MS, "waitingTasks");
        return rows.map((r) => ({
          taskId: r.task_id,
          slug: r.slug ?? r.task_id,
          submissionId: r.submission_id,
          pipelineState: r.pipeline_state,
          taskStatus: null,
        }));
      },
      list: () => submissionsList(stbCtx, { showFolders: true }),
      apply: async (a) => {
        const ws = resolve(cfg.paths.workspace, a.slug);

        // ACCEPTED IS SPECIAL: the recipe MUST be written before we commit the terminal state.
        //
        // ACCEPTED (110) is terminal and on no sweep list, so once a task is there nothing ever
        // revisits it. If we marked it accepted first and the recipe write then failed transiently,
        // the recipe would be lost forever. So: record FIRST. Only on success advance to 110. If the
        // record throws (a real DB failure), leave the task at SENT_TO_REVIEWER (100, still in
        // WAITING_ON_SNORKEL) so the next hourly reconcile retries — but mark task_status accepted so
        // the acceptance itself is not lost. recordAccepted does NOT throw on a missing workspace; it
        // only throws on a genuine write failure, which is exactly the case we want to retry.
        if (a.to === S.ACCEPTED) {
          try {
            const row = await getTask(a.taskId);
            if (row) await recordAccepted(a.taskId, ws, factsOf(row));
            await patchTask(a.taskId, {
              pipeline_state: S.ACCEPTED, submission_id: a.submissionId, task_status: TASK_STATUS_NUM.ACCEPTED,
            });
            if (readState(ws)) patchState(ws, { pipelineState: S.ACCEPTED });
            ctx.log(`✓ recorded accepted recipe for ${a.slug}`);
          } catch (e) {
            // Record the acceptance, but stay at 100 so the recipe is retried next reconcile.
            await patchTask(a.taskId, { task_status: TASK_STATUS_NUM.ACCEPTED, submission_id: a.submissionId }).catch(() => {});
            ctx.log(`⚠ could not record recipe for ${a.slug} (staying accepted-but-unrecorded; retry next reconcile): ${(e as Error).message}`);
          }
          return;
        }

        const patch: Partial<TerminusRow> = { pipeline_state: a.to, submission_id: a.submissionId };
        if (a.to === S.NEEDS_HUMAN) patch.last_error = a.reason;
        const ts = a.taskStatus ? TASK_STATUS_NUM[a.taskStatus] : undefined;
        if (ts !== undefined) patch.task_status = ts;
        await patchTask(a.taskId, patch);

        // Keep the local state.json in step so advance() and the dashboard agree on the new state.
        if (readState(ws)) {
          patchState(ws, { pipelineState: a.to, lastError: a.to === S.NEEDS_HUMAN ? a.reason : null });
        }

        void step(a.taskId); // drive it now rather than waiting for the next poll
      },
      log: ctx.log,
    });
  } catch (e) {
    ctx.log(`⚠ Snorkel reconcile failed: ${(e as Error).message}`);
  } finally {
    reconcileInFlight = false;
  }
}

/** On boot, re-enter anything a previous worker died in the middle of. */
async function sweep(): Promise<TerminusRow[]> {
  const rows = await findInterrupted(CRASHED_MIDFLIGHT);
  if (rows.length) {
    ctx.log(`recovering ${rows.length} interrupted task(s):`);
    for (const r of rows) {
      // Only claim the session will be resumed if its transcript is actually here. A
      // workspace that came from another machine carries a session id whose conversation
      // did not come with it, and promising a resume we cannot deliver is how you end up
      // trusting a STUDY_DONE marker written by a session that no longer exists.
      const ws = resolve(cfg.paths.workspace, r.slug ?? "");
      const resumable = sessionExists(ws, r.claude_session_id);
      ctx.log(
        `  ${r.slug ?? r.task_id} — was in ${stateName(r.pipeline_state)}` +
          (r.claude_session_id
            ? resumable
              ? ` · session ${r.claude_session_id.slice(0, 8)} will be resumed, not rebuilt`
              : ` · session ${r.claude_session_id.slice(0, 8)} is not on this machine — will rebuild from a fresh session`
            : ""),
      );
    }
  }
  return rows;
}

async function main(): Promise<void> {
  console.log("Snorkel Automation Workflow — worker");

  // Before anything else: refuse to be the second worker. The crash-recovery sweep
  // deliberately re-enters mid-flight tasks, so two workers would drive the same task.
  try {
    acquire();
  } catch (e) {
    if (e instanceof AlreadyRunning) {
      console.error(`\n❌ ${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }

  const checks = await preflight();
  if (!report(checks)) { release(); process.exit(1); }

  for (const r of await sweep()) void step(r.task_id);

  ctx.log(`polling every ${cfg.worker.pollIntervalSec}s · max ${cfg.worker.maxParallelTasks} tasks in flight`);
  ctx.log(`DRAFT tasks are inert — click "Start Build" in the dashboard to queue one.`);

  writeStatus(); // publish an idle-but-alive status before the first poll

  const wd = watchdog();

  while (!stopping) {
    lastTickAt = Date.now();
    writeStatus();

    try {
      if (Date.now() < backoffUntil) {
        // Still alive, just parked. writeStatus() above already refreshed `at`, so the
        // dashboard shows a backed-off worker rather than a dead one.
        await sleep(2000);
        continue;
      }

      // Keep driving anything already underway (this is what un-parks CHECKING_FEEDBACK).
      //
      // FEEDBACK_FAILED belongs here for exactly the same reason VERIFY_FAILED does: it is a
      // decision state, not a resting state — it exists only to route to the fixer or to give
      // up. Normally the inner while-loop in step() carries a task straight through it, so
      // nobody noticed it was missing from both this list and CRASHED_MIDFLIGHT. But a worker
      // that died in the instant between committing FEEDBACK_FAILED and the next advance()
      // left the task stranded forever, with nothing on any sweep that would ever look at it.
      const interrupted = await withDeadline(
        findInterrupted([
          S.BUILT, S.VERIFY_FAILED, S.VERIFIED, S.ZIPPED, S.EXPLAINED, S.FEEDBACK_FAILED,
          // REVISE_PENDING is where the hourly Snorkel reconciler parks a task it just pulled back
          // for revision. It is a resting state (the reconciler sets it and moves on), so it must
          // be driven here or it would sit forever waiting for a step() that never comes.
          S.REVISE_PENDING,
          ...CRASHED_MIDFLIGHT,
        ]),
        DB_TIMEOUT_MS,
        "findInterrupted",
      );
      for (const r of interrupted) {
        if (inFlight.size >= cfg.worker.maxParallelTasks) break;
        void step(r.task_id);
      }

      // Then pick up new work, but only what the human has explicitly released.
      if (inFlight.size < cfg.worker.maxParallelTasks) {
        const claimed = await withDeadline(claimNextTask(), DB_TIMEOUT_MS, "claimNextTask");
        if (claimed) {
          ctx.log(`▸ claimed ${claimed.slug ?? claimed.task_id} — "${claimed.title}"`);
          void step(claimed.task_id);
        }
      }

      // ONCE AN HOUR: reconcile the fleet against Snorkel. This is the only thing that learns a
      // submission has come back needing revision (or been accepted/rejected) and routes it into
      // the revise lap. Fire-and-forget — it self-guards against overlap and never throws into
      // the loop.
      const reconcileMs = (cfg.stb?.reconcileIntervalSec ?? 3600) * 1000;
      if (cfg.stb?.projectId && Date.now() - lastReconcileAt >= reconcileMs) {
        lastReconcileAt = Date.now();
        void reconcileSnorkel();
      }
    } catch (e) {
      // A tick that could not reach Supabase is a blip, not a death — and the correct
      // response to a blip is to take the next tick. Nothing is lost by skipping one: every
      // task's real state lives in state.json next to its own artifacts, in-flight steps are
      // untouched (they are separate promises), and the boot sweep re-enters anything that
      // was mid-flight. The ONLY thing that must not happen here is falling out of the loop.
      ctx.log(`⚠ poll tick failed: ${(e as Error).message} — retrying in ${cfg.worker.pollIntervalSec}s`);
    }

    await sleep(cfg.worker.pollIntervalSec * 1000);
  }

  clearInterval(wd); // a clean stop must be allowed to actually exit
}

/**
 * The watchdog. Its boring job is the important one.
 *
 *  1. It is a permanent timer, so THE EVENT LOOP CAN NEVER RUN DRY. That alone makes the
 *     silent exit above impossible: even a loop wedged on a promise that never settles now
 *     keeps the process alive with a visibly stale heartbeat — a state the dashboard can
 *     see and a human can act on. A process that simply vanishes is neither.
 *  2. If the loop stops turning anyway, it says so out loud and exits NON-ZERO, so the
 *     supervisor brings up a fresh worker instead of guarding a corpse.
 *
 * It deliberately does NOT write the heartbeat. The heartbeat means "the tick loop turned";
 * a watchdog that refreshed it would upgrade a wedged worker into a lying one.
 */
function watchdog(): NodeJS.Timeout {
  return setInterval(() => {
    if (stopping) return;
    const idle = Date.now() - lastTickAt;
    if (idle <= WEDGED_AFTER_MS) return;

    console.error(
      `\n💥 worker wedged — the poll loop has not turned for ${Math.round(idle / 1000)}s ` +
        `(the poll interval is ${cfg.worker.pollIntervalSec}s).\n` +
        `Exiting so the supervisor can restart it. In-flight tasks resume from state.json ` +
        `on the next boot; nothing is lost.\n`,
    );
    release();
    process.exit(75); // EX_TEMPFAIL — "try me again", and distinguishable from a clean stop
  }, 15_000);
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (stopping) { release(); process.exit(1); }
    stopping = true;
    // Every stage is crash-safe by construction, so a hard stop is survivable — but a
    // clean one means the in-flight transition gets to commit first.
    ctx.log("stopping after the current transition… (again to force)");
  });
}

/**
 * NOTHING MAY LEAVE THIS PROCESS QUIETLY.
 *
 * The worker once exited with code 0, no exception, and not one line of output — see the
 * note on DB_TIMEOUT_MS. `main().catch()` below only covers a REJECTION; it cannot see an
 * event loop that drained, an uncaught throw from a callback, or a rejected promise nobody
 * awaited. Each of those now writes its own epitaph before it goes.
 */
process.on("uncaughtException", (e) => {
  release();
  console.error(`\n💥 worker died — uncaught exception:\n${e?.stack ?? e}\n`);
  process.exit(1);
});

process.on("unhandledRejection", (e) => {
  release();
  console.error(`\n💥 worker died — unhandled rejection:\n${(e as Error)?.stack ?? e}\n`);
  process.exit(1);
});

// Belt and braces: a stale lock is only a nuisance (the next worker sees the pid is dead
// and takes over), but releasing it cleanly means no nuisance at all.
process.on("exit", (code) => {
  release();
  // A zero exit that nobody asked for is the exact signature of the silent drain. If it
  // ever happens again it will at least say so, in the log, at the moment it happens.
  if (!stopping && code === 0) {
    console.error(
      `\n💥 worker exited on its own with code 0 — nobody asked it to stop, and it did not ` +
        `throw. The poll loop fell out from under itself.\n`,
    );
  }
});

main().catch((e) => {
  release();
  console.error(`\n💥 worker died: ${e.message}\n`);
  process.exit(1);
});
