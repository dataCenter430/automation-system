/**
 * The feedback verdict decides whether a task is handed to you as "ready to submit".
 *
 * A false FAIL burns one of three Claude fix attempts on a task that was fine.
 * A false PASS ticks the rubric box and parks a broken task in front of you as if it were
 * green. The second is much worse, which is why a degraded (possibly-truncated) read is
 * never allowed to produce a pass.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classify } from "../../../apps/worker/src/stages/feedback.ts";

test("a clean run is a pass", () => {
  for (const s of [
    "All checks passed.",
    "Static checks passed\nInstruction sufficiency: OK",
    "PASSED",
    "Successful validation of the submission.",
  ]) {
    assert.equal(classify(s, false), "pass", s);
  }
});

test("prose containing 'error'/'missing'/'invalid' is NOT a failure", () => {
  // This is the regression that mattered: the old FAIL list had bare /\berror\b/,
  // /\bmissing\b/ and /\binvalid\b/, so every one of these green runs read as a failure.
  for (const s of [
    "All checks passed. 0 errors, 0 warnings.",
    "All checks passed.\nNo missing files were detected.",
    "Static checks passed.\ntests/test_outputs.py::test_invalid_input PASSED",
    "All checks passed. The agent handled the error path correctly.",
  ]) {
    assert.equal(classify(s, false), "pass", s);
  }
});

test("'no errors found' is reachable as a pass", () => {
  // The old ordering made this unreachable: /\berror\b/ matched it as a FAIL first.
  assert.equal(classify("No errors found.", false), "pass");
});

test("a real failure is a failure", () => {
  for (const s of [
    "FAILED: task.toml is not valid",
    "ERROR: base image is not digest-pinned",
    "1 test failed",
    "Check failed: the null run scored 1",
    "Validation failed.",
    "This must be fixed before submission.",
    "Blocking issue: solution/ is COPYied into the image",
    "Traceback (most recent call last):\n  File ...",
    "missing required field: metadata.category",
    "task.toml is invalid",
  ]) {
    assert.equal(classify(s, false), "fail", s);
  }
});

test("mixed output is a failure — a partial pass is not a pass", () => {
  assert.equal(classify("3 checks passed.\n1 test failed.", false), "fail");
  assert.equal(classify("All checks passed.\nERROR: reward.txt missing", false), "fail");
});

test("'0 tests failed' is not a failure", () => {
  assert.equal(classify("All checks passed. 0 tests failed.", false), "pass");
});

test("a DEGRADED read can never produce a pass", () => {
  // Truncated: what we can see says everything is fine, but the failures may be below the
  // fold. We refuse to call it green — it becomes inconclusive, and a human looks.
  assert.equal(classify("All checks passed.", true), "pending");
  assert.equal(classify("No errors found.", true), "pending");
  // But a failure we DID see is still actionable — we don't need the whole log to know it broke.
  assert.equal(classify("ERROR: base image is not digest-pinned", true), "fail");
});

test("empty output is pending, not a verdict", () => {
  assert.equal(classify("", false), "pending");
  assert.equal(classify("   \n  ", false), "pending");
});
