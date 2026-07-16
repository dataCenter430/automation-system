/**
 * ACCEPTED-TASK RECIPES — the summary assembled when a task clears human review, and its retrieval
 * into a future build's design turn.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { assembleSummary, recordAccepted, factsOf, hasBody, type TaskFacts, type RecordDeps } from "../../../apps/worker/src/stages/accepted.ts";
import { renderAcceptedExamples, neutralizeBraces } from "../../../apps/worker/src/stages/build.ts";
import { render } from "../../../apps/worker/src/claude/prompts.ts";
import type { Design } from "../../../apps/worker/src/stages/design-gate.ts";
import type { Explanations } from "../../../apps/worker/src/stages/explain.ts";
import type { TerminusImplementationRow } from "../../../packages/shared/src/types.ts";

const facts: TaskFacts = {
  title: "Recover Terraform Container Specs", category: "machine-learning",
  sub_category: "long_context", languages: "kotlin, json", slug: "recover-terraform-ml",
};

const design: Design = {
  deliverable: "Select and deploy the stronger relevance model per segment.",
  gradedOn: "Average precision of the deployed model clears the baseline on held-out data.",
  gradingAxis: "property-threshold",
  testNames: ["test_threshold_achieves_recall_0_95", "test_no_regression_against_champion"],
};

const explanations: Explanations = {
  difficulty: "The model must be made to behave to a target on data it has never seen.",
  solution: "Derive the baseline and margin from the dossier, then select per segment.",
  verification: "Re-derive average precision on a held-out slice generated at test time.",
};

// ------------------------------------------------------------------- assembleSummary

test("assembles a scannable recipe with the grading axis, tests, and explanations", () => {
  const s = assembleSummary(facts, design, explanations);
  assert.match(s, /Recover Terraform Container Specs — ACCEPTED/);
  assert.match(s, /Category: machine-learning \/ long_context · Languages: kotlin, json/);
  assert.match(s, /axis `property-threshold`/);
  assert.match(s, /test_threshold_achieves_recall_0_95/);
  assert.match(s, /right difficulty/);
  assert.match(s, /Solution approach/);
  assert.match(s, /Verification approach/);
});

test("degrades gracefully when there is no design.json (task built before the design gate)", () => {
  const s = assembleSummary(facts, null, explanations);
  assert.match(s, /ACCEPTED/);
  assert.ok(!/grading axis|Graded on/.test(s), "no design section when there is no design");
  assert.match(s, /Solution approach/); // explanations still included
});

test("degrades gracefully when there are no explanations either", () => {
  const s = assembleSummary(facts, design, null);
  assert.match(s, /axis `property-threshold`/);
  assert.ok(!/Solution approach/.test(s));
});

// ------------------------------------------------------------------- recordAccepted

const baseDeps = (over: Partial<RecordDeps> = {}): { deps: RecordDeps; upserts: any[] } => {
  const upserts: any[] = [];
  const deps: RecordDeps = {
    readDesign: () => design,
    readExplanations: () => explanations,
    readStoredExplanations: async () => null,
    canonicalCategory: (raw) => raw.toLowerCase().replace(/ & | and /g, "-").replace(/\s+/g, "-"),
    upsert: async (taskId, patch) => { upserts.push({ taskId, patch }); },
    now: () => "2026-07-15T00:00:00Z",
    ...over,
  };
  return { deps, upserts };
};

test("recordAccepted upserts the recipe with accepted=true and the denormalised keys", async () => {
  const { deps, upserts } = baseDeps();
  await recordAccepted("task-1", "/ws", facts, deps);
  assert.equal(upserts.length, 1);
  const { taskId, patch } = upserts[0];
  assert.equal(taskId, "task-1");
  assert.equal(patch.accepted, true);
  assert.equal(patch.accepted_at, "2026-07-15T00:00:00Z");
  assert.equal(patch.category, "machine-learning"); // canonicalised
  assert.equal(patch.languages, "kotlin, json");
  assert.equal(patch.slug, "recover-terraform-ml");
  assert.match(patch.implementation_summary, /property-threshold/);
});

test("recordAccepted CANONICALISES the category so storage and retrieval agree on spelling", async () => {
  const { deps, upserts } = baseDeps();
  await recordAccepted("t", "/ws", { ...facts, category: "Machine Learning & AI" }, deps);
  assert.equal(upserts[0].patch.category, "machine-learning-ai");
});

test("recordAccepted falls back to the DB explanations when the workspace is gone", async () => {
  const stored = { difficulty: "from DB", solution: "from DB", verification: "from DB" };
  const { deps, upserts } = baseDeps({
    readDesign: () => null,          // workspace gone
    readExplanations: () => null,    // workspace gone
    readStoredExplanations: async () => stored,
  });
  await recordAccepted("t", "/ws", facts, deps);
  assert.match(upserts[0].patch.implementation_summary, /from DB/, "explanations recovered from the DB");
});

test("a body-less recipe (no design, no explanations anywhere) is accepted but NOT offered as a recipe", async () => {
  const { deps, upserts } = baseDeps({
    readDesign: () => null,
    readExplanations: () => null,
    readStoredExplanations: async () => null,
  });
  await recordAccepted("t", "/ws", facts, deps);
  assert.equal(upserts[0].patch.accepted, true, "still marked accepted");
  assert.equal(upserts[0].patch.implementation_summary, undefined, "no worthless header-only summary stored");
});

test("a DB write failure THROWS (so the caller can retry), never swallowed", async () => {
  const { deps } = baseDeps({ upsert: async () => { throw new Error("supabase 503"); } });
  await assert.rejects(() => recordAccepted("t", "/ws", facts, deps), /supabase 503/);
});

test("hasBody: design OR any explanation counts; nothing does not", () => {
  assert.equal(hasBody(design, null), true);
  assert.equal(hasBody(null, explanations), true);
  assert.equal(hasBody(null, { difficulty: "", solution: "", verification: "" }), false);
  assert.equal(hasBody(null, null), false);
});

test("factsOf pulls the retrieval keys out of a DB row", () => {
  const f = factsOf({
    title: "T", category: "security", sub_category: "crypto", languages: "lua", slug: "s",
  } as any);
  assert.deepEqual(f, { title: "T", category: "security", sub_category: "crypto", languages: "lua", slug: "s" });
});

// ------------------------------------------------------------------- retrieval → design prompt

const implRow = (summary: string): TerminusImplementationRow => ({
  id: 1, task_id: "t", implementation_summary: summary,
  difficulty_explanation: null, solution_explanation: null, verification_explanation: null,
  created_at: "", accepted: true, accepted_at: "2026-07-15T00:00:00Z",
  category: "machine-learning", sub_category: null, languages: "kotlin", title: "T", slug: "s",
});

test("renderAcceptedExamples joins the summaries; empty list → empty string (block collapses)", () => {
  assert.equal(renderAcceptedExamples([]), "");
  const joined = renderAcceptedExamples([implRow("RECIPE ONE"), implRow("RECIPE TWO")]);
  assert.match(joined, /RECIPE ONE/);
  assert.match(joined, /RECIPE TWO/);
  assert.match(joined, /---/); // separated
});

test("09-design.md RENDERS the accepted examples when present", () => {
  const s = render("09-design.md", {
    category: "machine-learning",
    categorySpec: "spec",
    rejectedDesigns: "",
    acceptedExamples: renderAcceptedExamples([implRow("A PROVEN RECIPE for this category")]),
  });
  assert.match(s, /ALREADY ACCEPTED/);
  assert.match(s, /A PROVEN RECIPE for this category/);
});

test("09-design.md COLLAPSES the accepted-examples block when there are none", () => {
  const s = render("09-design.md", {
    category: "machine-learning", categorySpec: "spec", rejectedDesigns: "", acceptedExamples: "",
  });
  assert.ok(!/ALREADY ACCEPTED/.test(s), "no dangling header when the library is empty");
});

test("a recipe containing {{token}} does NOT break render() — the category-wide build-killer", () => {
  // A templating task's recipe legitimately contains `{{name}}`. Un-neutralised, it would survive
  // into the rendered prompt and render()'s leftover guard would throw, failing every build in the
  // category. neutralizeBraces breaks the double-brace so it is inert.
  assert.match(neutralizeBraces("render {{name}} into {{#each items}}"), /\{ \{/);
  assert.ok(!/\{\{\w/.test(neutralizeBraces("render {{name}}")), "no {{word left");

  const poisoned = implRow("Deliverable: render {{name}} and {{#each rows}} into output.");
  const s = render("09-design.md", {
    category: "machine-learning", categorySpec: "spec", rejectedDesigns: "",
    acceptedExamples: renderAcceptedExamples([poisoned]),
  });
  assert.match(s, /render \{ \{name\} \}/, "the token is shown, neutralised");
  // The real proof is that render() did not throw above.
});
