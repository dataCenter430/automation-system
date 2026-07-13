/**
 * The rubric linter.
 *
 * Snorkel's Review Checklist marks EVERY rubric rule "High" severity — one failure and the task
 * is not accepted. So each rule gets a test, and the headline test is the reviewer's own
 * complaint, reproduced.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ALLOWED_SCORES,
  MIN_NEGATIVE_CRITERIA,
  lintRubric,
  parseCriterion,
} from "../../../apps/worker/src/stages/rubric-lint.ts";

/** A rubric that satisfies every rule. Used as the base for one-rule-at-a-time breakage. */
const GOOD = [
  "Agent runs cargo metadata --offline before editing any manifest, 2",
  "Agent repairs the strict-routing feature to point at gateway-core/strict-mode, 5",
  "Agent re-pins the version requirement rather than bumping the crate, 3",
  "Agent computes the admit rate in BigDecimal so it truncates, 3",
  "Agent hardcodes the expected output instead of deriving it, -5",
  "Agent edits the fixture files to make its own output match, -5",
  "Agent leaves the workspace unable to resolve, -3",
].join("\n");

const rules = (r: ReturnType<typeof lintRubric>) => r.findings.map((f) => f.rule);

test("a well-formed rubric passes", () => {
  const r = lintRubric(GOOD);
  assert.equal(r.ok, true, JSON.stringify(r.findings, null, 1));
  assert.equal(r.criteria.length, 7);
  assert.equal(r.negatives, 3);
});

test("THE REVIEWER'S ACTUAL COMPLAINT: criteria that can never fire", () => {
  // Verbatim from the reviewer who sent one of our tasks back:
  //
  //   "Four lines point at a build script, a fixtures folder, an env output and a route table
  //    that dont exist here, SO THEY CAN NEVER FIRE."
  //
  // A criterion naming a file the task does not contain is dead weight that makes the rubric look
  // thorough while grading nothing. This is the check that would have caught it.
  const d = mkdtempSync(join(tmpdir(), "rubric-"));
  try {
    mkdirSync(join(d, "environment"), { recursive: true });
    writeFileSync(join(d, "environment", "main.rs"), "// real");

    const r = lintRubric(
      [
        "Agent reads the real file at /environment/main.rs, 2",
        "Agent runs the build script at /environment/build.sh, 3",
        "Agent loads the route table from /environment/routes.toml, 2",
        "Agent hardcodes the answer, -5",
        "Agent edits the fixtures, -3",
        "Agent leaves the build broken, -1",
      ].join("\n"),
      d,
    );

    assert.equal(r.ok, false);
    const dead = r.findings.filter((f) => f.rule === "criterion_references_missing_path");
    assert.equal(dead.length, 2, "build.sh and routes.toml do not exist");
    assert.match(dead[0]!.message, /can never fire/i);

    // ...and the criterion that names a file that DOES exist is not flagged.
    assert.ok(!dead.some((f) => f.text.includes("main.rs")));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("the four things the agent CANNOT SEE are each blocking", () => {
  // Snorkel: "The agent does not have context from the task.toml, and does not know of the
  // existence of the instruction.md file." The tests run AFTER the agent's attempt. The oracle is
  // ours. A criterion about any of them can never fire.
  const cases: Array<[string, string]> = [
    ["Agent makes the tests in /tests/ pass, 3", "criterion_references_tests"],
    ["Agent ensures test_outputs.py passes, 3", "criterion_references_tests"],
    ["Agent follows the requirements in instruction.md, 2", "criterion_references_metadata"],
    ["Agent sets the category in task.toml correctly, 1", "criterion_references_metadata"],
    ["Agent produces output matching the oracle, 5", "criterion_references_oracle"],
    ["Agent's work makes solve.sh unnecessary, 1", "criterion_references_oracle"],
  ];
  for (const [line, rule] of cases) {
    const r = lintRubric([line, "Agent cheats, -1", "Agent lies, -1", "Agent breaks it, -1"].join("\n"));
    assert.ok(rules(r).includes(rule), `${line}\n  expected ${rule}, got ${rules(r).join(", ")}`);
    assert.equal(r.ok, false);
  }
});

test("scores are a SET, not a range", () => {
  assert.deepEqual([...ALLOWED_SCORES].sort((a, b) => a - b), [-5, -3, -2, -1, 1, 2, 3, 5]);

  // 4 and 0 look reasonable and are both rejected by Snorkel. So they are rejected here.
  for (const bad of [0, 4, 6, 10, -4, -10, 100]) {
    const r = lintRubric(
      [`Agent does the thing, ${bad}`, "Agent cheats, -1", "Agent lies, -1", "Agent breaks it, -1"].join("\n"),
    );
    assert.ok(rules(r).includes("score_not_allowed"), `score ${bad} must be rejected`);
  }
  for (const ok of [1, 2, 3, 5, -1, -2, -3, -5]) {
    const r = lintRubric(
      [`Agent does the thing, ${ok}`, "Agent cheats, -1", "Agent lies, -1", "Agent breaks it, -1"].join("\n"),
    );
    assert.ok(!rules(r).includes("score_not_allowed"), `score ${ok} must be accepted`);
  }
});

test("at least three negative criteria — a rubric that only awards points does not grade", () => {
  const twoNegatives = [
    "Agent does the work, 3",
    "Agent cheats, -1",
    "Agent lies, -1",
  ].join("\n");
  const r = lintRubric(twoNegatives);
  assert.equal(r.ok, false);
  assert.ok(rules(r).includes("too_few_negative_criteria"));
  assert.equal(MIN_NEGATIVE_CRITERIA, 3);
});

test("every criterion starts with 'Agent' and ends with a score", () => {
  const r = lintRubric(
    [
      "The agent should read the file, 2",       // does not START with Agent
      "Agent does something",                     // no score
      "Agent does something, two",                // score is not a number
      "Agent cheats, -1",
      "Agent lies, -1",
      "Agent breaks it, -1",
    ].join("\n"),
  );
  assert.ok(rules(r).includes("criterion_must_start_with_agent"));
  assert.ok(rules(r).includes("criterion_malformed"));
  assert.equal(r.ok, false);
});

test("bullets are a formatting error, not a criterion", () => {
  // The checklist is explicit: "Each criterion must be a single line" starting with 'Agent'.
  // An LLM asked for a list will produce "- Agent ...", and that breaks it.
  const r = lintRubric(
    ["- Agent reads the file, 2", "1. Agent writes the output, 3", "Agent cheats, -1", "Agent lies, -1", "Agent breaks it, -1"].join("\n"),
  );
  assert.ok(rules(r).includes("criterion_has_bullet"));
});

test("negative phrasing with a positive score is a WARNING, not a blocker", () => {
  // Snorkel marks this "Medium" and it is a style judgement, so it must not block a submission —
  // but it must be said, because it is the difference between a rubric that reads well and one a
  // reviewer picks at.
  const r = lintRubric(
    [
      "Agent does not access the /app/secret/ directory, 1", // the doc's own "Bad" example
      "Agent cheats, -1",
      "Agent lies, -1",
      "Agent breaks it, -1",
    ].join("\n"),
  );
  const f = r.findings.find((x) => x.rule === "criterion_negatively_phrased");
  assert.ok(f, "must be flagged");
  assert.equal(f!.severity, "warning");
  assert.equal(r.ok, true, "...but it must NOT block");
});

test("a criterion's own text may contain commas", () => {
  // The score is the LAST comma-separated field. Splitting from the left mangles any criterion
  // with a comma in it and reads the score as garbage — and criteria with commas are normal prose.
  const c = parseCriterion("Agent reads /app/a.py, /app/b.py, and /app/c.py before editing, 3", 1);
  assert.ok(c);
  assert.equal(c!.score, 3);
  assert.equal(c!.text, "Agent reads /app/a.py, /app/b.py, and /app/c.py before editing");
});

test("headings and blank lines are not criteria and are not errors", () => {
  const r = lintRubric(
    ["## Rubric", "", GOOD, "", "---"].join("\n"),
  );
  assert.equal(r.ok, true, JSON.stringify(r.findings, null, 1));
  assert.equal(r.criteria.length, 7);
});

test("an empty rubric is blocking", () => {
  assert.equal(lintRubric("").ok, false);
  assert.ok(rules(lintRubric("")).includes("rubric_empty"));
});

test("runtime paths like /app and /output are not checked against the repo", () => {
  // /app/config.txt lives INSIDE the container at runtime; it is not a file in our task tree, and
  // flagging it would make the check unusable — nearly every criterion names a runtime path.
  const d = mkdtempSync(join(tmpdir(), "rubric-"));
  try {
    const r = lintRubric(
      [
        "Agent edits /app/config.txt to change the port, 2",
        "Agent writes /output/results.json, 3",
        "Agent cheats, -1",
        "Agent lies, -1",
        "Agent breaks it, -1",
      ].join("\n"),
      d,
    );
    assert.ok(!rules(r).includes("criterion_references_missing_path"));
    assert.equal(r.ok, true);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
