/**
 * The difficulty gate — the check that finally makes "too easy" detectable.
 *
 * Every threshold here is quoted from # Difficulty Guidelines.txt. The bar Snorkel actually enforces:
 *   "Tasks where the worst model scores above 80% will not be accepted."
 *   "≤ 20% on best OR worst model … earns Hard."
 *   "60% < accuracy ≤ 80% on the worst model" → Easy.  "20–60% on worst" → Medium.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import {
  classify, verdictFrom, parseHarborRuns, DEFAULT_DIFFICULTY, type ModelResult,
} from "../../../apps/worker/src/stages/difficulty.ts";

// ------------------------------------------------------------------- classify (pure bands)

test("worst-model pass-rate ABOVE 80% is TOO_EASY — the exact rejection bar", () => {
  assert.equal(classify(0.9, 0.95, DEFAULT_DIFFICULTY), "TOO_EASY");
  assert.equal(classify(0.81, 1.0, DEFAULT_DIFFICULTY), "TOO_EASY");
});

test("exactly 80% worst is NOT too easy — the bar is strictly ABOVE", () => {
  // "above 80%" — 80% itself is the top of the Easy band, not a rejection.
  assert.equal(classify(0.8, 0.8, DEFAULT_DIFFICULTY), "EASY");
});

test("≤20% on worst OR best earns HARD", () => {
  assert.equal(classify(0.2, 0.2, DEFAULT_DIFFICULTY), "HARD");
  assert.equal(classify(0.0, 0.0, DEFAULT_DIFFICULTY), "HARD");
  // The doc's subtle case: a task the STRONGEST model still fails ≤20% is Hard even if the worst
  // model also struggles — "because the failure isn't just a weak-model artifact."
  assert.equal(classify(0.15, 0.15, DEFAULT_DIFFICULTY), "HARD");
});

test("20–60% on worst is MEDIUM", () => {
  assert.equal(classify(0.4, 0.7, DEFAULT_DIFFICULTY), "MEDIUM");
  assert.equal(classify(0.6, 0.9, DEFAULT_DIFFICULTY), "MEDIUM");
});

test("60–80% on worst is EASY", () => {
  assert.equal(classify(0.7, 0.9, DEFAULT_DIFFICULTY), "EASY");
  assert.equal(classify(0.61, 0.61, DEFAULT_DIFFICULTY), "EASY");
});

// ------------------------------------------------------------------- verdictFrom (block policy)

const mr = (model: string, passes: number, runs = 5): ModelResult => ({ model, passes, runs, passRate: passes / runs });

test("TOO_EASY is blocked and loops back to rebuild", () => {
  const v = verdictFrom([mr("gpt", 5), mr("opus", 5)], DEFAULT_DIFFICULTY, { isPython: false });
  assert.equal(v.band, "TOO_EASY");
  assert.equal(v.blocked, true);
  assert.match(v.report, /too easy/i);
});

test("EASY is blocked platform-wide (only medium and hard accepted)", () => {
  // worst 70%, best 90% → EASY.
  const v = verdictFrom([mr("gpt", 5, 5), mr("opus", 7, 10)], { ...DEFAULT_DIFFICULTY }, { isPython: false });
  assert.equal(v.band, "EASY");
  assert.equal(v.blocked, true);
});

test("a MEDIUM non-Python task is accepted and proceeds", () => {
  const v = verdictFrom([mr("gpt", 2), mr("opus", 3)], DEFAULT_DIFFICULTY, { isPython: false });
  assert.equal(v.band, "MEDIUM");
  assert.equal(v.blocked, false);
  assert.match(v.report, /proceeding/i);
});

test("a MEDIUM PYTHON task is BLOCKED — python must be hard", () => {
  const v = verdictFrom([mr("gpt", 2), mr("opus", 3)], DEFAULT_DIFFICULTY, { isPython: true });
  assert.equal(v.band, "MEDIUM");
  assert.equal(v.blocked, true);
  assert.match(v.report, /Python tasks must be HARD/);
});

test("a HARD python task is accepted", () => {
  const v = verdictFrom([mr("gpt", 1), mr("opus", 1)], DEFAULT_DIFFICULTY, { isPython: true });
  assert.equal(v.band, "HARD");
  assert.equal(v.blocked, false);
});

test("worst = the LOWER pass-rate model, best = the higher, regardless of order", () => {
  const v = verdictFrom([mr("gpt", 5), mr("opus", 1)], DEFAULT_DIFFICULTY, { isPython: false });
  assert.equal(v.worstPassRate, 0.2);   // opus
  assert.equal(v.bestPassRate, 1.0);    // gpt
});

// ------------------------------------------------------------------- parseHarborRuns (calibratable)

test("parses a JSON reward array", () => {
  assert.deepEqual(parseHarborRuns("[1,0,1,1,0]", 5), { passes: 3, runs: 5 });
});

test("parses a {pass,total} JSON summary", () => {
  assert.deepEqual(parseHarborRuns('{"pass":4,"total":5}', 5), { passes: 4, runs: 5 });
});

test("parses a results array of reward objects", () => {
  assert.deepEqual(parseHarborRuns('{"results":[{"reward":1},{"reward":0},{"reward":1}]}', 3), { passes: 2, runs: 3 });
});

test("parses a '3/5 passed' summary line", () => {
  assert.deepEqual(parseHarborRuns("Aggregate: 3/5 passed", 5), { passes: 3, runs: 5 });
});

test("parses per-run PASS/FAIL lines, and FAIL - Good still counts as a fail", () => {
  const out = [
    "Run 1 (GPT-5.5): FAIL",
    "Run 2 (GPT-5.5): PASS",
    "Run 3 (GPT-5.5): FAIL - Good",
    "Run 4 (GPT-5.5): PASS",
    "Run 5 (GPT-5.5): FAIL - Bad",
  ].join("\n");
  assert.deepEqual(parseHarborRuns(out, 5), { passes: 2, runs: 5 });
});

test("parses reward: lines", () => {
  assert.deepEqual(parseHarborRuns("reward: 1\nreward: 1\nreward: 0", 3), { passes: 2, runs: 3 });
});

test("unparseable output returns zero runs, so the caller can fall back rather than trust a wrong 0%", () => {
  assert.deepEqual(parseHarborRuns("some unexpected banner text", 5), { passes: 0, runs: 0 });
});
