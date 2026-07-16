/**
 * Feed a real Snorkel "Check feedback" verdict back into the pipeline, by hand.
 *
 *   npm run feedback:fix -- <slug> <path-to-ci-output.txt>
 *
 * WHY THIS EXISTS
 *
 * The pipeline already has this loop: CHECKING_FEEDBACK reads Snorkel's static-check output
 * off the submission page, and on a rejection routes to REMOTE_FIX_RUNNING, which pastes that
 * output verbatim into the SAME Claude session that built the task (prompts/05-feedback-fix.md)
 * and then re-proves the result through the LOCAL Docker gate before it may be re-uploaded.
 *
 * But the browser half has never run against the real site, and its two Submit-adjacent
 * selectors are still unconfirmed. So today the verdict arrives the way it arrived this time:
 * a human pastes the CodeBuild log out of the browser. This script is that bridge. It puts the
 * verdict where the pipeline expects to find it and hands the task back to the worker, which
 * then does exactly what it would have done on its own.
 *
 * It is deliberately NOT a shortcut around the gate. It sets FEEDBACK_FAILED, not VERIFIED:
 * the fix goes back through Docker — oracle run, null run, lint — before anything is re-zipped.
 * A fix that satisfies Snorkel's CI can quietly break the oracle, and shipping that would waste
 * a whole lap.
 */
import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../apps/worker/src/config.ts";
import { patchState, readState } from "../apps/worker/src/state.ts";
import { db } from "../packages/shared/src/supabase.ts";
import { PipelineState, stateName } from "../packages/shared/src/status.ts";
const [slug, ciPath] = process.argv.slice(2);
if (!slug || !ciPath) {
    console.error("usage: npm run feedback:fix -- <slug> <path-to-snorkel-ci-output.txt>\n\n" +
        "Paste Snorkel's Check-feedback / CodeBuild output into a file, then point this at it.\n" +
        "The task goes to FEEDBACK_FAILED; the worker fixes it in the same Claude session and\n" +
        "re-proves it through the local Docker gate before it can be re-zipped.");
    process.exit(2);
}
const cfg = loadConfig();
const ws = resolve(cfg.paths.workspace, slug);
const ci = resolve(ciPath);
if (!existsSync(ws)) {
    console.error(`No workspace at ${ws} — is the slug right?`);
    process.exit(1);
}
if (!existsSync(ci)) {
    console.error(`No such file: ${ci}`);
    process.exit(1);
}
const feedback = readFileSync(ci, "utf8").trim();
if (feedback.length < 40) {
    console.error("That file is almost empty. Paste Snorkel's actual output — Claude fixes what it is shown.");
    process.exit(1);
}
const local = readState(ws);
if (!local) {
    console.error(`No .pipeline/state.json in ${ws}. This task has never been built here.`);
    process.exit(1);
}
const { data: row, error } = await db()
    .from("terminus")
    .select("task_id, slug, pipeline_state, claude_session_id")
    .eq("slug", slug)
    .single();
if (error || !row) {
    console.error(`No task row for slug "${slug}": ${error?.message ?? "not found"}`);
    process.exit(1);
}
// The workspace must belong to this task — the same ownership check the pipeline makes.
if (local.taskId !== row.task_id) {
    console.error(`Slug collision: workspace/${slug} belongs to task ${local.taskId}, but the row is ${row.task_id}.`);
    process.exit(1);
}
// The fix runs in the session that BUILT the task, so it knows what it built and why.
if (!local.claudeSessionId) {
    console.error("This task has no Claude session recorded, so there is nothing to feed the feedback back INTO.\n" +
        "The fix would start from a blank context and re-derive the task from scratch.");
    process.exit(1);
}
// lastError is what pipeline.ts hands to prompts/05-feedback-fix.md as {{feedback}}.
patchState(ws, { lastError: feedback, feedbackAttempt: 0, attempt: 0 });
const { error: upErr } = await db()
    .from("terminus")
    .update({
    pipeline_state: PipelineState.FEEDBACK_FAILED,
    last_error: feedback.slice(0, 4000),
    feedback_attempt: 0,
    attempt: 0,
})
    .eq("task_id", row.task_id);
if (upErr) {
    console.error(`Could not update the task row: ${upErr.message}`);
    process.exit(1);
}
console.log(`\n${slug}\n` +
    `  was            : ${stateName(row.pipeline_state)}\n` +
    `  now            : ${stateName(PipelineState.FEEDBACK_FAILED)}\n` +
    `  session        : ${local.claudeSessionId.slice(0, 8)} (the one that built it)\n` +
    `  feedback       : ${feedback.split("\n").length} lines from ${ci}\n\n` +
    `The worker will pick this up on its next poll and:\n` +
    `  1. paste Snorkel's output into that same Claude session (prompts/05-feedback-fix.md)\n` +
    `  2. re-run the LOCAL Docker gate on the fix — oracle, null run, lint\n` +
    `  3. re-zip only if the gate passes\n\n` +
    `Watch it in the dashboard: Session on the row.\n`);
