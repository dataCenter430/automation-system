/**
 * What each category ACTUALLY IS — the deliverable, and what it is graded on.
 *
 * The classifier never reads task.toml. It reads the task's CONTENT and answers one question:
 * "what must the agent produce, and what decides whether it is right?" So when a task is blocked,
 * the only useful thing you can tell the build session is what its ASSIGNED category actually
 * requires — in that category's own terms.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 *
 * The classifier's failure report used to end with this, with `${declared}` substituted in:
 *
 *     "To belong to "${declared}", the agent's DELIVERABLE and its GRADING must be about MODEL
 *      BEHAVIOUR: training or evaluating a model, calibrating a decision threshold to hit a target
 *      metric... Grade it on precision/recall, a calibration error, an operating threshold."
 *
 * That is machine-learning advice. It was given to EVERY blocked task. So a SECURITY task —
 * a PKI-pinning verifier — was blocked as software-engineering and then told, in the system's own
 * voice, to go and calibrate a model. Had Claude obeyed, the rebuilt task would have been
 * machine-learning while task.toml said security, and it would have been rejected the other way.
 *
 * Advice for the wrong category is not a smaller version of the right advice. It is confidently
 * wrong, in a place the model has no way to check.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT } from "../../../../packages/shared/src/paths.ts";
let cached = null;
function load() {
    if (!cached) {
        const raw = JSON.parse(readFileSync(resolve(REPO_ROOT, "config/categories.json"), "utf8"));
        cached = Object.fromEntries(Object.entries(raw).filter(([k, v]) => !k.startsWith("$") && typeof v === "object"));
    }
    return cached;
}
/**
 * What this category requires — or null if we have no entry for it.
 *
 * Null rather than a plausible default: a category we cannot describe is one whose rebuild would
 * be guesswork, and the report says so out loud instead of inventing guidance.
 */
export function categorySpec(category) {
    return load()[category.trim().toLowerCase()] ?? null;
}
/** Every category we can describe. For the redesign prompt, and for the tests. */
export function describedCategories() {
    return Object.keys(load());
}
