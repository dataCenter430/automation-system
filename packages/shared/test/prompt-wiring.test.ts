/**
 * THE PROMPTS MUST ACTUALLY CARRY WHAT WE PASS THEM.
 *
 * This exists because of a silent no-op that would have wasted the whole fix. `02-build.md` was
 * being handed `categorySpec` and `approvedDesign` — but the template had no `{{categorySpec}}`
 * or `{{approvedDesign}}` placeholder in it, so both were dropped on the floor. render() throws
 * on an UNSUBSTITUTED placeholder but says nothing about an UNUSED variable, so everything
 * typechecked, every test passed, and the build session still never saw the definition of the
 * category it was building for — the exact defect the change set out to remove.
 *
 * So: assert on the RENDERED TEXT, not on the call site.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { render } from "../../../apps/worker/src/claude/prompts.ts";
import {
  categorySpecText, designSummary, renderLedger,
} from "../../../apps/worker/src/stages/build.ts";
import type { RejectedDesign } from "../../../apps/worker/src/state.ts";

const SPEC = categorySpecText("machine-learning");

const DESIGN = designSummary({
  deliverable: "Select and deploy the stronger relevance model per segment.",
  gradedOn: "Average precision of the deployed model clears the baseline on held-out data.",
  gradingAxis: "property-threshold",
  testNames: ["test_threshold_achieves_recall_0_95", "test_pr_auc_above_baseline", "test_x"],
});

const LEDGER: RejectedDesign[] = [{
  attempt: 1, predicted: "software-engineering", confidence: 0.92,
  why: "implements a routine whose output is compared to a reference",
  deliverable: "Recover the Terraform container specs.",
  gradedOn: "containers.tf.json matches the reference.",
  gradingAxis: "equality-vs-reference",
  testNames: ["test_output_matches_reference"],
  at: "2026-07-13T22:37:00Z",
}];

const build = () => render("02-build.md", {
  title: "T", category: "Machine Learning", sub_category: "long_context",
  languages: "kotlin", description: "d", additional_note: "",
  toml_category: "machine-learning", toml_subcategories: "[]", toml_languages: "[]",
  workspace: "/w", categorySpec: SPEC, approvedDesign: DESIGN,
});

const design = () => render("09-design.md", {
  category: "machine-learning", categorySpec: SPEC, rejectedDesigns: renderLedger(LEDGER),
});

test("categorySpecText carries the category's REAL definition, not a paraphrase", () => {
  assert.match(SPEC, /A STATEMENT ABOUT MODEL BEHAVIOUR/);
  assert.match(SPEC, /BUILDING A FEATURE PIPELINE IS NOT MACHINE LEARNING/); // the notThis
  assert.match(SPEC, /test_threshold_achieves_recall_0_95/);                 // testNamesLikeThis
});

test("02-build.md ACTUALLY RENDERS the category spec — it used to be silently dropped", () => {
  const s = build();
  assert.match(s, /A STATEMENT ABOUT MODEL BEHAVIOUR/);
  assert.match(s, /BUILDING A FEATURE PIPELINE IS NOT MACHINE LEARNING/);
});

test("02-build.md ACTUALLY RENDERS the approved design", () => {
  const s = build();
  assert.match(s, /property-threshold/);
  assert.match(s, /test_threshold_achieves_recall_0_95/);
});

test("09-design.md renders the spec AND the rejected-design ledger", () => {
  const s = design();
  assert.match(s, /A STATEMENT ABOUT MODEL BEHAVIOUR/);
  assert.match(s, /ALREADY been rejected/);
  assert.match(s, /Recover the Terraform container specs/);  // the actual rejected deliverable
  assert.match(s, /equality-vs-reference/);                   // and its axis
});

test("an empty ledger renders to nothing, not to a dangling header", () => {
  assert.equal(renderLedger([]), "");
  const s = render("09-design.md", {
    category: "machine-learning", categorySpec: SPEC, rejectedDesigns: "",
  });
  assert.ok(!/ALREADY been rejected/.test(s), "a first build must not be shown an empty ledger");
});

test("a placeholder NOBODY SUPPLIED throws — it must never render as an empty hole", () => {
  // render() used to substitute "" for any key the caller had not passed, and the leftover-check
  // could not catch it because the placeholder was already gone. A template asking for
  // {{categorySpec}} that nobody passed therefore rendered a prompt with a silently EMPTY
  // category definition: no throw, no warning, a build session flying blind, green tests.
  assert.throws(
    () => render("09-design.md", { category: "machine-learning" }), // categorySpec/rejectedDesigns absent
    /needs \{\{categorySpec\}\}|needs \{\{rejectedDesigns\}\}/,
  );
});

test("PASSED-but-empty still renders empty — an optional var is not a wiring mistake", () => {
  // additional_note is legitimately absent on most tasks. Its caller passes it explicitly, so it
  // must keep working; only a key the caller never mentioned at all is a bug.
  const s = render("02-build.md", {
    title: "T", category: "ML", sub_category: "x", languages: "kotlin", description: "d",
    additional_note: undefined,                       // <- explicitly passed, legitimately empty
    toml_category: "machine-learning", toml_subcategories: "[]", toml_languages: "[]",
    workspace: "/w", categorySpec: SPEC, approvedDesign: DESIGN,
  });
  assert.ok(!/Additional Inspiration/.test(s), "the conditional block must collapse");
});

test("EVERY prompt renders from its real call-site variables", () => {
  // The stricter render() turns a forgotten variable into a throw. That is the point — but it
  // means a template gaining a placeholder without its call site gaining the var is now a RUNTIME
  // failure in a fix turn. Catch it here instead.
  const CALL_SITES: Record<string, Record<string, unknown>> = {
    "01-study.md": { summary: "see the playbook" },
    "02-build.md": {
      title: "T", category: "ML", sub_category: "x", languages: "kotlin", description: "d",
      additional_note: "", toml_category: "machine-learning", toml_subcategories: "[]",
      toml_languages: "[]", workspace: "/w", categorySpec: SPEC, approvedDesign: DESIGN,
    },
    "09-design.md": { category: "machine-learning", categorySpec: SPEC, rejectedDesigns: "" },
    // fixTask() injects `workspace` and spreads the caller's vars over it.
    "03-fix.md": { workspace: "/w", attempt: 1, maxAttempts: "unlimited", failureReport: "r" },
    "05-feedback-fix.md": { workspace: "/w", attempt: 1, maxAttempts: 3, feedback: "f" },
    "06-revise.md": { workspace: "/w", attempt: 1, maxAttempts: 3, feedback: "f", rubric: "r" },
    "07-rubric-fix.md": { workspace: "/w", report: "r" },
    "04-explain.md": {},
  };
  for (const [tpl, vars] of Object.entries(CALL_SITES)) {
    assert.doesNotThrow(() => render(tpl, vars as any), `${tpl} must render from its call site`);
  }
});
