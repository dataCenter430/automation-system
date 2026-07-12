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
import { advance } from "./pipeline.ts";
import { claimNextTask, findInterrupted, getTask, } from "../../../packages/shared/src/supabase.ts";
import { CRASHED_MIDFLIGHT, PipelineState as S, stateName, isTerminal, } from "../../../packages/shared/src/status.ts";
import { RateLimited } from "./claude/errors.ts";
import { sessionExists } from "./claude/session.ts";
import { resolve } from "node:path";
import { acquire, release, AlreadyRunning } from "./lock.ts";
const cfg = loadConfig();
const ts = () => new Date().toISOString().slice(11, 19);
const ctx = { cfg, log: (m) => console.log(`[${ts()}] ${m}`) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Tasks this process is currently stepping, so we never double-drive one. */
const inFlight = new Set();
let stopping = false;
/** Rate limits are a subscription reality, not a bug. Back off; never burn a retry. */
let backoffUntil = 0;
async function step(taskId) {
    if (inFlight.has(taskId))
        return;
    inFlight.add(taskId);
    try {
        let moved = true;
        // Keep stepping this task while it keeps moving, so a fast chain of transitions
        // (BUILT → VERIFY_RUNNING → …) doesn't wait a poll interval between each.
        while (moved && !stopping) {
            const row = await getTask(taskId);
            if (!row || isTerminal(row.pipeline_state))
                break;
            moved = await advance(ctx, row);
        }
    }
    catch (e) {
        if (e instanceof RateLimited) {
            backoffUntil = Date.now() + cfg.claude.rateLimitBackoffSec * 1000;
            ctx.log(`⏸  rate limited — backing off ${cfg.claude.rateLimitBackoffSec}s (no retry burned)`);
            return;
        }
        ctx.log(`💥 ${taskId}: ${e.message}`);
    }
    finally {
        inFlight.delete(taskId);
    }
}
/** On boot, re-enter anything a previous worker died in the middle of. */
async function sweep() {
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
            ctx.log(`  ${r.slug ?? r.task_id} — was in ${stateName(r.pipeline_state)}` +
                (r.claude_session_id
                    ? resumable
                        ? ` · session ${r.claude_session_id.slice(0, 8)} will be resumed, not rebuilt`
                        : ` · session ${r.claude_session_id.slice(0, 8)} is not on this machine — will rebuild from a fresh session`
                    : ""));
        }
    }
    return rows;
}
async function main() {
    console.log("Snorkel Automation Workflow — worker");
    // Before anything else: refuse to be the second worker. The crash-recovery sweep
    // deliberately re-enters mid-flight tasks, so two workers would drive the same task.
    try {
        acquire();
    }
    catch (e) {
        if (e instanceof AlreadyRunning) {
            console.error(`\n❌ ${e.message}\n`);
            process.exit(1);
        }
        throw e;
    }
    const checks = await preflight();
    if (!report(checks)) {
        release();
        process.exit(1);
    }
    for (const r of await sweep())
        void step(r.task_id);
    ctx.log(`polling every ${cfg.worker.pollIntervalSec}s · max ${cfg.worker.maxParallelTasks} tasks in flight`);
    ctx.log(`DRAFT tasks are inert — click "Start Build" in the dashboard to queue one.`);
    while (!stopping) {
        if (Date.now() < backoffUntil) {
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
        for (const r of await findInterrupted([
            S.BUILT, S.VERIFY_FAILED, S.VERIFIED, S.ZIPPED, S.EXPLAINED, S.FEEDBACK_FAILED,
            ...CRASHED_MIDFLIGHT,
        ])) {
            if (inFlight.size >= cfg.worker.maxParallelTasks)
                break;
            void step(r.task_id);
        }
        // Then pick up new work, but only what the human has explicitly released.
        if (inFlight.size < cfg.worker.maxParallelTasks) {
            const claimed = await claimNextTask();
            if (claimed) {
                ctx.log(`▸ claimed ${claimed.slug ?? claimed.task_id} — "${claimed.title}"`);
                void step(claimed.task_id);
            }
        }
        await sleep(cfg.worker.pollIntervalSec * 1000);
    }
}
for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
        if (stopping) {
            release();
            process.exit(1);
        }
        stopping = true;
        // Every stage is crash-safe by construction, so a hard stop is survivable — but a
        // clean one means the in-flight transition gets to commit first.
        ctx.log("stopping after the current transition… (again to force)");
    });
}
// Belt and braces: a stale lock is only a nuisance (the next worker sees the pid is dead
// and takes over), but releasing it cleanly means no nuisance at all.
process.on("exit", release);
main().catch((e) => {
    release();
    console.error(`\n💥 worker died: ${e.message}\n`);
    process.exit(1);
});
