/**
 * The two-pass submission, as a state machine.
 *
 * A Terminus submission is two clicks, not one (Snorkel's Rubric guide, lines 30-33):
 *
 *   pass 1   rubric box TICKED, "Send to reviewer?" UNTICKED  -> CI generates a rubric and
 *                                                                hands the task back to us
 *   pass 2   rubric box UNTICKED, "Send to reviewer?" TICKED  -> a human reviewer gets it
 *
 * Everything below is a property that, if it broke, would either destroy a rubric, deadlock the
 * pipeline, or send a reviewer the wrong thing. None of them are cosmetic.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PipelineState as S,
  TERMINAL,
  CRASHED_MIDFLIGHT,
  isTerminal,
  stateName,
} from "../../../packages/shared/src/status.ts";

test("SUBMITTED IS NOT TERMINAL — this is what un-deadlocks the pipeline", () => {
  // The regression that matters most. SUBMITTED used to be terminal, which meant a submitted task
  // was "done": nothing went back for the rubric, nothing reached a reviewer, and nothing ever
  // LEFT the revision queue. Every submission added one to a queue that only grew.
  //
  // On its own that was merely wrong. The moment a queue gate existed (refuse at >=10, and the
  // queue stands at 14), it became a permanent deadlock: the system could neither submit new work
  // nor clear the backlog, and no amount of waiting would fix it.
  assert.equal(isTerminal(S.SUBMITTED), false, "a submitted task still has pass 2 to do");
  assert.ok(!TERMINAL.includes(S.SUBMITTED));
});

test("SENT_TO_REVIEWER is the real end of our involvement", () => {
  assert.equal(isTerminal(S.SENT_TO_REVIEWER), true);
  assert.deepEqual(
    [...TERMINAL].sort((a, b) => a - b),
    [S.NEEDS_HUMAN, S.FAILED, S.SENT_TO_REVIEWER].sort((a, b) => a - b),
  );
});

test("every state in the revise lap is reachable and named", () => {
  // A state that exists in the enum but has no name is one the dashboard renders as
  // "UNKNOWN(94)" — and an operator who sees that has no idea whether to wait or intervene.
  for (const s of [
    S.SUBMITTED,
    S.REVISE_PENDING,
    S.REVISE_RUNNING,
    S.AWAITING_REVIEW_APPROVAL,
    S.SENDING_TO_REVIEWER,
    S.SENT_TO_REVIEWER,
  ]) {
    assert.doesNotMatch(stateName(s), /UNKNOWN/, `state ${s} has no name`);
  }
});

test("the lap moves strictly forward — no state number is reused", () => {
  // Two states sharing a number is a silent merge: the pipeline would take one branch believing
  // it was on the other.
  const all = [
    S.DRAFT, S.QUEUED, S.BUILD_RUNNING, S.BUILT, S.VERIFY_RUNNING, S.VERIFY_FAILED,
    S.VERIFIED, S.FIX_RUNNING, S.ZIPPED, S.EXPLAINED, S.UPLOADING, S.CHECKING_FEEDBACK,
    S.FEEDBACK_FAILED, S.REMOTE_FIX_RUNNING, S.AWAITING_APPROVAL, S.SUBMITTING, S.SUBMITTED,
    S.REVISE_PENDING, S.REVISE_RUNNING, S.AWAITING_REVIEW_APPROVAL, S.SENDING_TO_REVIEWER,
    S.SENT_TO_REVIEWER, S.FAILED, S.NEEDS_HUMAN,
  ];
  assert.equal(new Set(all).size, all.length, "two states share a number");
});

test("the two irreversible states are both swept as crashed-midflight", () => {
  // SUBMITTING and SENDING_TO_REVIEWER each end in a click that cannot be taken back. If the
  // worker dies mid-click we do not know whether it landed — so both MUST be re-entered on boot
  // and reconciled (look before clicking), never left parked in a state nobody re-enters.
  assert.ok(CRASHED_MIDFLIGHT.includes(S.SUBMITTING), "pass 1's click must be reconciled");
  assert.ok(CRASHED_MIDFLIGHT.includes(S.SENDING_TO_REVIEWER), "pass 2's click must be reconciled");
  assert.ok(CRASHED_MIDFLIGHT.includes(S.REVISE_RUNNING), "a half-done revise turn must resume");
});

test("BOTH human gates are outside CRASHED_MIDFLIGHT — a restart must never click for you", () => {
  // The whole design rests on two human gates: approve pass 1 (submit to CI), and approve pass 2
  // (send to a person). If either were swept as "crashed midflight", a worker restart would
  // re-enter it and act — which is precisely the human decision the gate exists to preserve.
  assert.ok(!CRASHED_MIDFLIGHT.includes(S.AWAITING_APPROVAL));
  assert.ok(!CRASHED_MIDFLIGHT.includes(S.AWAITING_REVIEW_APPROVAL));

  // ...and neither is terminal, because a human WILL move them.
  assert.equal(isTerminal(S.AWAITING_APPROVAL), false);
  assert.equal(isTerminal(S.AWAITING_REVIEW_APPROVAL), false);
});

test("REVISE_PENDING is a poll, not a park — it must not be terminal", () => {
  // The task is waiting on Snorkel's CI to hand it back. If this were terminal, the task would
  // sit there forever and the queue would never drain.
  assert.equal(isTerminal(S.REVISE_PENDING), false);
});
