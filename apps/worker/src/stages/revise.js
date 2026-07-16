import { resolve_, exists, pageUrl } from "../browser/selectors.ts";
import { readFieldMonaco, snap, writeFieldMonaco, } from "../browser/actions.ts";
import { withScratchPage } from "../browser/cdp.ts";
import { formatRubricReport, lintRubric } from "./rubric-lint.ts";
export class ReviseUnreadable extends Error {
    constructor(what, why) {
        super(`Refusing to revise: could not read the ${what} on the revise page (${why}).\n\n` +
            `The fix turn is driven ENTIRELY by what the reviewer wrote. Feeding Claude a partial ` +
            `read would produce a confident fix aimed at the wrong problem, and we would then re-zip ` +
            `and submit it.`);
        this.name = "ReviseUnreadable";
    }
}
/**
 * Is our task in the revise queue yet?
 *
 * Keyed on SNORKEL'S submission uid — the revise card's data-testid is `<uid>-Terminus-2nd-Edition`.
 * Not task_id: that is the Task Gallery uuid, and it appears nowhere on the home page.
 *
 * Runs in a scratch tab so it never navigates a page a caller is holding.
 */
export async function findInReviseQueue(a, submissionUid, runDir) {
    return withScratchPage(a, pageUrl("home"), async (page) => {
        const tokens = { submission_uid: submissionUid };
        if (!(await exists(page, "home.reviseCard", { tokens, timeoutMs: 6000 })))
            return null;
        const card = await resolve_(page, "home.reviseCard", { tokens });
        const href = (await card.getAttribute("href")) ?? "";
        if (!href)
            return null;
        await snap(page, runDir, "revise-found");
        return {
            url: new URL(href, pageUrl("home")).toString(),
            assignmentId: /[?&]assignmentId=([0-9a-f-]{36})/i.exec(href)?.[1] ?? null,
        };
    });
}
/**
 * Read everything Snorkel and the reviewer gave us back.
 *
 * The sidebar and its "Reviewer Feedback" section are Radix collapsibles: while they are closed
 * their content is NOT IN THE DOM AT ALL. So we open them first, and if the text still is not
 * there we refuse rather than treating "closed" as "no feedback".
 */
export async function readReviseInput(page, runDir) {
    // 1. The sidebar rail.
    const toggle = await resolve_(page, "revise.sidebarToggle");
    if ((await toggle.getAttribute("aria-pressed")) !== "true") {
        await toggle.click();
        await page.waitForTimeout(250);
    }
    // 2. The "Reviewer Feedback" collapsible inside it.
    const section = await resolve_(page, "revise.feedbackToggle");
    if ((await section.getAttribute("aria-expanded")) !== "true") {
        await section.click();
        await page.waitForTimeout(250);
    }
    // 3. The feedback itself — plain text, whitespace-pre-line, complete.
    let feedback = "";
    try {
        const el = await resolve_(page, "revise.feedbackText", { timeoutMs: 8000 });
        feedback = (await el.innerText()).trim();
    }
    catch {
        throw new ReviseUnreadable("reviewer feedback", "the Reviewer Feedback panel is not on the page");
    }
    if (!feedback) {
        throw new ReviseUnreadable("reviewer feedback", "the panel is present but empty");
    }
    // 4. The rubric CI generated. May legitimately be empty (if the box was never ticked), and an
    //    empty rubric is a fact, not a failure — so `null` (could not read) and "" (nothing there)
    //    are kept apart.
    const rubric = await readFieldMonaco(page, "submission.rubricField");
    if (rubric === null) {
        throw new ReviseUnreadable("generated rubric", "window.monaco is unreachable, so the rubric could not be read in full. Reading the " +
            "rendered lines instead would give us roughly 3% of it");
    }
    await snap(page, runDir, "revise-input-read");
    return { feedback, rubric: rubric.trim() };
}
/**
 * Put Claude's rewritten rubric back into the editable Monaco box — but only if it is legal.
 *
 * Snorkel's Review Checklist marks EVERY rubric rule "High" severity, which means a single
 * failure and the task is not accepted. Those rules are mechanical (one line per criterion,
 * starts with "Agent", score in {±1,±2,±3,±5}, at least 3 negatives, no reference to /tests/,
 * task.toml, instruction.md or the oracle) — so they are checked, not hoped for.
 *
 * A rubric that fails is not written. Sending a reviewer a rubric that breaks the rules they are
 * about to grade against wastes their time and ours, and the whole point of the revise lap is to
 * stop doing that.
 */
export class RubricRejected extends Error {
    report;
    constructor(report) {
        super(`Refusing to submit this rubric: it breaks rules Snorkel marks HIGH severity, which means ` +
            `the task would not be accepted.\n\n${report}`);
        this.name = "RubricRejected";
        this.report = report;
    }
}
export async function writeRubric(page, rubric, runDir, taskDir = null) {
    const report = lintRubric(rubric, taskDir);
    if (!report.ok)
        throw new RubricRejected(formatRubricReport(report));
    await writeFieldMonaco(page, "submission.rubricField", rubric);
    await snap(page, runDir, "rubric-rewritten");
}
