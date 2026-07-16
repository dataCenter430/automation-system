/**
 * The design gate — the mechanism that makes "new nouns, same grading" impossible.
 *
 * The failure it exists to prevent: a task was rejected four times. Between rejections it was
 * rebuilt from scratch into three unrelated deliverables — a Terraform spec recovery, a threshold
 * calibrator, a champion/challenger selector. Every one of them was graded "the agent's output
 * matches a reference", which is data-processing, which is blocked. The domain moved three times.
 * The grading axis never moved once, so the verdict never moved either.
 *
 * Every check here is DETERMINISTIC. No model is consulted. That is the point: three redesigns
 * argued their way past every prose instruction in the repo, and prose can be argued with.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT } from "../src/paths.ts";
import {
  alreadyRejected, axesExhausted, axisLint, designDrift, designEvidence, designFingerprint,
  validateDesign, DesignInvalid, type Design,
} from "../../../apps/worker/src/stages/design-gate.ts";
import type { RejectedDesign } from "../../../apps/worker/src/state.ts";

const ml = (over: Partial<Design> = {}): Design => ({
  deliverable: "The agent must select and deploy the stronger relevance model for each segment.",
  gradedOn: "Average precision of the deployed model on a held-out slice clears the baseline.",
  gradingAxis: "property-threshold",
  testNames: ["test_threshold_achieves_recall_0_95", "test_pr_auc_above_baseline", "test_no_regression"],
  handedToAgent: "labelled validation slices and a model card",
  ...over,
});

// --------------------------------------------------------------------- axisLint

test("the equality axis is blocked for a non-data-processing category — no model consulted", () => {
  const d = ml({ gradingAxis: "equality-vs-reference" });
  const problems = axisLint(d, "machine-learning");
  assert.ok(problems.length >= 1);
  assert.match(problems[0]!, /equality-vs-reference/);
  assert.match(problems[0]!, /BLOCKED/);
});

test("an output-equality TEST NAME is caught even when the axis claims otherwise", () => {
  // This is the exact test that sank the real task: the design claimed a property axis while
  // still shipping `test_decision_agrees_with_reference_evaluation`. The classifier reads test
  // names, so one of these is enough to read the whole task as data-processing.
  const d = ml({ testNames: [...ml().testNames, "test_decision_agrees_with_reference_evaluation"] });
  const problems = axisLint(d, "machine-learning");
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /test_decision_agrees_with_reference_evaluation/);
});

test("every flavour of output-equality naming is caught", () => {
  for (const name of [
    "test_output_matches_golden",
    "test_report_matches_reference",
    "test_result_equals_oracle",
    "test_artifact_is_byte_identical",
    "test_output_is_correct",
  ]) {
    const problems = axisLint(ml({ testNames: [name, "test_a", "test_b"] }), "machine-learning");
    assert.ok(problems.length >= 1, `${name} must be caught`);
  }
});

test("gradedOn PROSE that describes comparing to a reference is caught", () => {
  const d = ml({ gradedOn: "The emitted promotion.json is compared against the reference evaluation." });
  const problems = axisLint(d, "machine-learning");
  assert.ok(problems.some((p) => /reference/i.test(p)));
});

test("a genuinely in-category ML design passes clean", () => {
  assert.deepEqual(axisLint(ml(), "machine-learning"), []);
});

test("data-processing is the ONE category where the equality axis is legitimate", () => {
  // It is blocked as a CATEGORY, but the lint must not fire on the axis itself — otherwise the
  // rule is incoherent, and an incoherent rule gets worked around rather than obeyed.
  const d = ml({ gradingAxis: "equality-vs-reference", testNames: ["test_output_matches_golden", "test_a", "test_b"] });
  assert.deepEqual(axisLint(d, "data-processing"), []);
});

// ----------------------------------------------------------------- alreadyRejected

test("an EXACT re-proposal — same axis, same assertions — is caught", () => {
  const ledger: RejectedDesign[] = [{
    attempt: 1,
    predicted: "software-engineering", confidence: 0.92,
    why: "the agent implements a routine whose output is compared to a reference",
    deliverable: "Recover the Terraform container specs.",
    gradedOn: "The emitted containers.tf.json matches the reference.",
    gradingAxis: "equality-vs-reference",
    testNames: ["test_output_matches_reference"],
    at: "2026-07-13T22:37:00Z",
  }];

  // Fresh nouns, fresh deliverable prose — but the same axis asserting the same thing.
  const reworded = ml({
    deliverable: "Decide which of two relevance models to deploy per segment.",
    gradingAxis: "equality-vs-reference",
    testNames: ["test_output_matches_reference"],
  });

  const hit = alreadyRejected(reworded, ledger);
  assert.ok(hit, "rewording the domain around an unchanged assertion must be caught");
  assert.match(hit!.deliverable, /Terraform/); // and it can say WHICH one it repeats
});

test("REUSING AN AXIS with DIFFERENT assertions is a NEW design and gets its chance", () => {
  // The identity must not be the axis alone. A property-threshold design graded on recall and a
  // property-threshold design graded on calibration error are different tasks, and the second can
  // pass where the first did not. Banning the axis outright would be both untrue and — with only
  // four legal axes — a guaranteed deadlock by the fourth rejection.
  const ledger: RejectedDesign[] = [{
    attempt: 1, predicted: "software-engineering", confidence: 0.9, why: "impl graded by tests",
    deliverable: "x", gradedOn: "y", gradingAxis: "property-threshold",
    testNames: ["test_threshold_achieves_recall_0_95"], at: "2026-07-13T22:37:00Z",
  }];
  const different = ml({
    gradingAxis: "property-threshold",
    testNames: ["test_calibration_error_within_tolerance", "test_a", "test_b"],
  });
  assert.equal(alreadyRejected(different, ledger), null);
});

test("THE DEADLOCK: four blocked designs must not make every future design illegal", () => {
  // With identity-by-axis, four rejections would exhaust every legal axis and the design gate
  // would refuse EVERY proposal thereafter — an unsatisfiable gate on the way to certain failure.
  const ledger: RejectedDesign[] = (
    ["property-threshold", "invariant-violation", "comparative-baseline", "observable-end-state"] as const
  ).map((axis, i) => ({
    attempt: i + 1, predicted: "software-engineering", confidence: 0.9, why: "blocked",
    deliverable: "d", gradedOn: "g", gradingAxis: axis,
    testNames: [`test_old_${i}`], at: "2026-07-13T22:37:00Z",
  }));

  // A brand-new property-threshold design, asserting something never tried. It must be allowed.
  const fresh = ml({ gradingAxis: "property-threshold", testNames: ["test_brand_new", "test_a", "test_b"] });
  assert.equal(alreadyRejected(fresh, ledger), null, "the gate must not be unsatisfiable");
});

test("axesExhausted reports the honest end of the road — and only then", () => {
  const entry = (axis: string) => ({
    attempt: 1, predicted: "software-engineering", confidence: 0.9, why: "blocked",
    deliverable: "d", gradedOn: "g", gradingAxis: axis as any,
    testNames: ["test_x"], at: "2026-07-13T22:37:00Z",
  });

  // equality-vs-reference is not legal for machine-learning, so the other four are the whole space.
  const four = ["property-threshold", "invariant-violation", "comparative-baseline", "observable-end-state"]
    .map(entry);
  assert.equal(axesExhausted("machine-learning", four), true);
  assert.equal(axesExhausted("machine-learning", four.slice(0, 3)), false);
  assert.equal(axesExhausted("machine-learning", []), false);
});

test("designFingerprint is order-insensitive on test names", () => {
  const a = designFingerprint({ gradingAxis: "property-threshold", testNames: ["test_b", "test_a"] });
  const b = designFingerprint({ gradingAxis: "property-threshold", testNames: ["test_a", "test_b"] });
  assert.equal(a, b);
});

// ---------------------------------------------------------------- validateDesign

test("gradingAxis is a CLOSED vocabulary — an invented axis is refused", () => {
  // Prose can be paraphrased; an enum cannot. This is the field that exists to be
  // un-side-steppable, so a session inventing its own axis string must not get through.
  assert.throws(
    () => validateDesign({ ...ml(), gradingAxis: "model-quality-ish" }),
    (e: Error) => e instanceof DesignInvalid && /closed vocabulary/.test(e.message),
  );
});

test("a design with too few tests is refused — test names are what the classifier reads", () => {
  assert.throws(
    () => validateDesign({ ...ml(), testNames: ["test_only_one"] }),
    (e: Error) => e instanceof DesignInvalid && /at least 3/.test(e.message),
  );
});

test("a valid design round-trips", () => {
  const d = validateDesign(ml());
  assert.equal(d.gradingAxis, "property-threshold");
  assert.equal(d.testNames.length, 3);
});

// ---------------------------------------------------------------- designEvidence

test("designEvidence fills the SAME four slots the real classifier reads", () => {
  // The design gate and the real gate must agree by construction — same panel, same prompt, same
  // evidence shape. If these slots drift apart, a design that passes stops predicting a build
  // that passes, and the whole gate becomes theatre.
  const ev = designEvidence(ml());
  assert.match(ev, /=== instruction\.md — what the agent under test is told to do ===/);
  assert.match(ev, /=== solution\/solve\.sh — the oracle/);
  assert.match(ev, /=== test names — what is graded ===/);
  assert.match(ev, /=== environment\/ — what the agent is handed ===/);
  assert.match(ev, /test_threshold_achieves_recall_0_95/);
});

// ------------------------------------------------------------------- designDrift

test("an equality test smuggled into the BUILD, after a clean design, is caught", () => {
  // The session writes its own design, so the gate is only as honest as the session. The build
  // must still grade what the approved design promised to grade.
  const drift = designDrift(ml(), [
    "test_threshold_achieves_recall_0_95",
    "test_decision_agrees_with_reference_evaluation", // never promised, and it is an equality test
  ]);
  assert.deepEqual(drift, ["test_decision_agrees_with_reference_evaluation"]);
});

test("a build that keeps its promises does not drift", () => {
  assert.deepEqual(designDrift(ml(), ml().testNames), []);
});

// ------------------------------------------------- the lint must not refuse our own guidance

test("EVERY canonical example in config/categories.json passes its OWN category's lint", () => {
  // This invariant was broken in two different ways at once, and both would have refused a session
  // for doing exactly what the repo told it to do:
  //
  //   machine-learning  shipped `test_confusion_matrix_at_threshold_matches_reference` as a model
  //                     test name — an OUTPUT-EQUALITY assertion, in the category whose `notThis`
  //                     explicitly warns against output-equality assertions.
  //   security          has a `gradedOn` that DISCLAIMS the equality axis ("...never 'the output
  //                     file matches the golden copy'"), and the prose check fired on the
  //                     disclaimer. A negation is not an assertion.
  //
  // If our own canonical examples cannot pass our own gate, the gate is not a rule — it is a trap.
  const cats = JSON.parse(readFileSync(resolve(REPO_ROOT, "config/categories.json"), "utf8"));
  const AXIS: Record<string, string> = {
    "machine-learning": "property-threshold",
    "security": "invariant-violation",
    "scientific-computing": "property-threshold",
    "system-administration": "observable-end-state",
    "build-and-dependency-management": "property-threshold",
    "games": "comparative-baseline",
  };

  for (const [name, spec] of Object.entries<any>(cats)) {
    if (name.startsWith("$")) continue;
    const problems = axisLint(
      {
        deliverable: spec.deliverable,
        gradedOn: spec.gradedOn,
        gradingAxis: (AXIS[name] ?? "property-threshold") as any,
        testNames: spec.testNamesLikeThis,
      },
      name,
    );
    assert.deepEqual(problems, [], `config/categories.json → "${name}" is refused by our own lint`);
  }
});

test("a NEGATED mention of output-equality is not an assertion of it", () => {
  const d = ml({
    gradedOn:
      "ADVERSARIAL OUTCOMES. The oracle is 'the policy holds under attack', " +
      "never 'the output file matches the golden copy'.",
    gradingAxis: "invariant-violation",
  });
  assert.deepEqual(axisLint(d, "security"), [], "saying the right thing must not be punished");
});

test("...but an AFFIRMED output-equality description is still caught", () => {
  const d = ml({ gradedOn: "The emitted promotion.json is compared against the reference evaluation." });
  assert.ok(axisLint(d, "machine-learning").length >= 1);
});

test("EQUALITY_NAME catches the singular form too, not only 'matches'", () => {
  assert.ok(axisLint(ml({ testNames: ["test_output_match_reference", "test_a", "test_b"] }), "machine-learning").length >= 1);
  assert.ok(axisLint(ml({ testNames: ["test_result_equal_oracle", "test_a", "test_b"] }), "machine-learning").length >= 1);
});
