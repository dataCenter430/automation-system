import { resolve_ } from "../browser/selectors.ts";
import { readMonaco, readMonacoFallback, snap } from "../browser/actions.ts";
export class FeedbackInconclusive extends Error {
    output;
    constructor(msg, output) {
        super(msg);
        this.name = "FeedbackInconclusive";
        this.output = output;
    }
}
/**
 * Signals, kept here rather than in the selector config because they are about the TEXT
 * Snorkel writes, not about where it writes it.
 *
 * These are seeded from the field descriptions and will be pinned exactly against a live
 * run (one good zip, one deliberately broken zip) before this loop is trusted to spend
 * Claude attempts on a fix.
 */
const PASS_SIGNALS = [
    /\ball\s+checks?\s+passed\b/i,
    /\bno\s+(?:issues|errors|problems)\s+(?:were\s+)?found\b/i,
    /\bstatic\s+checks?\s+passed\b/i,
    /^\s*passed\s*$/im,
    /\bsuccess(?:ful)?\b.*\bvalidation\b/i,
];
/**
 * FAIL signals must be STRUCTURAL, never bare English words.
 *
 * This list used to contain /\berror\b/, /\binvalid\b/ and /\bmissing\b/. Snorkel's output
 * is an agent simulation plus per-test stats plus an instruction-sufficiency report — prose
 * that routinely contains the words "error", "missing" and "invalid" in passing ("0 errors",
 * "no missing files", "test_invalid_input ... PASSED"). Every green run was therefore going
 * to be read as a failure, burn a Claude fix attempt, and do it three times before giving up.
 *
 * Worse, because failures are tested first, /\berror\b/ also made PASS_SIGNALS[1]
 * ("no errors found") permanently unreachable — the pass phrase matched the fail rule.
 *
 * So: anchor to line starts, require a count that is not zero, or require a phrase that only
 * appears when something is actually wrong.
 */
const FAIL_SIGNALS = [
    /^\s*(?:❌|✗|FAIL(?:ED|URE)?|ERROR)\b/im, // a line that STARTS with a failure marker
    /\b(?!0+\b)\d+\s+(?:checks?|tests?|assertions?)\s+failed\b/i, // "1 test failed", not "0 tests failed"
    /\bcheck(?:s)?\s+failed\b/i,
    /\bvalidation\s+failed\b/i,
    /\bmust\s+be\s+fixed\b/i,
    /\bblocking\s+(?:issue|error|problem|finding)/i,
    /\btraceback\s*\(most\s+recent\s+call\s+last\)/i,
    /\bmissing\s+required\b/i,
    /\bis\s+invalid\b/i,
];
/**
 * @param degraded true when the text came from the rendered editor rather than the Monaco
 *   model — i.e. it may be TRUNCATED. A truncated read may only ever produce "fail" or
 *   "pending", never "pass": the screenful we can see could easily be the header of a log
 *   whose failures are below the fold, and a false pass ticks the rubric box and hands you
 *   a broken task as if it were ready.
 */
export function classify(output, degraded) {
    if (!output.trim())
        return "pending";
    // Failures are checked FIRST: an output that says "3 checks passed, 1 failed" is a fail.
    if (FAIL_SIGNALS.some((r) => r.test(output)))
        return "fail";
    if (degraded)
        return "pending"; // we can act on a fail we saw; we cannot trust a pass we might not have seen
    if (PASS_SIGNALS.some((r) => r.test(output)))
        return "pass";
    return "pending";
}
/** Everything Snorkel wrote back, from every result surface, as one blob. */
async function readOutput(page) {
    const parts = [];
    const models = await readMonaco(page);
    for (const m of models) {
        if (m.value.trim())
            parts.push(`--- ${m.uri} ---\n${m.value.trim()}`);
    }
    if (parts.length)
        return { text: parts.join("\n\n"), degraded: false };
    // window.monaco is not reachable — a modern bundled Monaco usually is not on `window`.
    // The fallback reads RENDERED lines, which Monaco virtualizes, so what we get back is
    // whatever happens to be on screen. Usable as evidence of failure; never as proof of
    // success. See classify().
    for (const key of ["submission.textSummaryField", "submission.qualityCheckField"]) {
        const t = await readMonacoFallback(page, key).catch(() => "");
        if (t)
            parts.push(`--- ${key} (RENDERED — MAY BE TRUNCATED) ---\n${t}`);
    }
    return { text: parts.join("\n\n"), degraded: parts.length > 0 };
}
export async function checkFeedback(args) {
    const { page, runDir, pollIntervalSec, timeoutMin } = args;
    const button = await resolve_(page, "submission.checkFeedbackButton");
    await button.click();
    await snap(page, runDir, "check-feedback-clicked");
    const started = Date.now();
    const deadline = started + timeoutMin * 60_000;
    while (Date.now() < deadline) {
        if (args.shouldStop?.()) {
            throw new FeedbackInconclusive("Poll abandoned by the worker; will resume.", "");
        }
        await page.waitForTimeout(pollIntervalSec * 1000);
        const elapsedSec = Math.round((Date.now() - started) / 1000);
        const out = await readOutput(page).catch(() => ({ text: "", degraded: false }));
        const verdict = classify(out.text, out.degraded);
        await args.onHeartbeat?.(elapsedSec);
        if (verdict === "pending")
            continue;
        await snap(page, runDir, `feedback-${verdict}`);
        return { verdict, output: out.text, elapsedSec };
    }
    const out = await readOutput(page).catch(() => ({ text: "", degraded: false }));
    await snap(page, runDir, "feedback-timeout");
    throw new FeedbackInconclusive(`"Check feedback" produced no clear pass or fail within ${timeoutMin} minutes. ` +
        `Not guessing: a false pass would park a broken task in front of you as if it were ready.` +
        (out.degraded
            ? `\nNOTE: window.monaco was not reachable, so the output could only be read from the ` +
                `RENDERED editor, which Monaco truncates to whatever is on screen. A pass is never ` +
                `inferred from a truncated read — that is why this is inconclusive rather than green.`
            : "") +
        `\nScreenshot and DOM are in ${runDir}.`, out.text);
}
