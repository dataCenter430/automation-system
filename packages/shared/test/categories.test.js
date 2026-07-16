/**
 * What each category ACTUALLY IS.
 *
 * The classifier never reads task.toml — it reads the deliverable and the grading. So when a task
 * is blocked, the only useful thing to tell the build session is what its ASSIGNED category
 * requires. Getting that wrong is worse than saying nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT } from "../src/paths.ts";
import { categorySpec, describedCategories } from "../../../apps/worker/src/stages/categories.ts";
test("THE BUG: guidance is per-category, not machine-learning for everyone", () => {
    // The failure report used to end with hardcoded ML advice, with ${declared} substituted in:
    //
    //   "To belong to "security", the DELIVERABLE and GRADING must be about MODEL BEHAVIOUR:
    //    training or evaluating a model, calibrating a decision threshold... precision/recall"
    //
    // A PKI-pinning task was blocked as software-engineering and told, in the system's own voice, to
    // go and calibrate a model. Had Claude obeyed, the rebuilt task would have been machine-learning
    // while task.toml said security — rejected the other way. Advice for the wrong category is not a
    // weaker version of the right advice; it is confidently wrong.
    const sec = categorySpec("security");
    assert.ok(sec, "security must have a spec");
    assert.doesNotMatch(sec.gradedOn, /precision|recall|calibrat|threshold|model/i, "SECURITY guidance must not be machine-learning guidance");
    assert.match(sec.gradedOn, /adversar|attack|reject/i, "security is graded on whether an ATTACK IS STOPPED");
    // ...and machine-learning must still be machine-learning.
    const ml = categorySpec("machine-learning");
    assert.match(ml.gradedOn, /precision|recall|PR-AUC|calibrat/i);
});
test("every ALLOWED category has a spec — a blocked task with no guidance is rebuilt by guesswork", () => {
    const taxonomy = JSON.parse(readFileSync(resolve(REPO_ROOT, "config/taxonomy.json"), "utf8"));
    for (const cat of taxonomy.category.$allowed) {
        assert.ok(categorySpec(cat), `"${cat}" is an allowed category with NO entry in config/categories.json. A task blocked into ` +
            `it would be told nothing about what it actually requires.`);
    }
});
test("no spec grades on 'the output file is correct' — that is data-processing, which is BLOCKED", () => {
    // The single most common way a good task slides into a blocked one. Every category's `notThis`
    // has to name it, because every category can fall into it.
    for (const cat of describedCategories()) {
        const s = categorySpec(cat);
        assert.match(s.notThis, /output|golden|matches|shape|serial|csv/i, `"${cat}" does not warn against grading on the OUTPUT — the trap every category falls into`);
        // The test names it recommends must not be output-shape tests.
        for (const t of s.testNamesLikeThis) {
            assert.doesNotMatch(t, /matches_golden|output_matches|_shape_|_json_matches/i, `"${cat}" recommends "${t}", which grades an output`);
        }
    }
});
test("every spec names its trap — the specific way it slides into a blocked category", () => {
    for (const cat of describedCategories()) {
        const s = categorySpec(cat);
        assert.ok(s.deliverable?.length > 40, `${cat}: deliverable is too thin to act on`);
        assert.ok(s.gradedOn?.length > 40, `${cat}: gradedOn is too thin to act on`);
        assert.ok(s.theTrap?.length > 30, `${cat}: no trap named`);
        assert.ok(s.testNamesLikeThis.length >= 3, `${cat}: needs real test names — the classifier reads them`);
    }
});
test("an undescribed category returns null — never a plausible default", () => {
    // A category we cannot describe is one whose rebuild would be guesswork. The report says so out
    // loud rather than inventing guidance, which is exactly the failure this whole file exists for.
    assert.equal(categorySpec("quantum-basketweaving"), null);
});
