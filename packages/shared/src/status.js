/**
 * The pipeline state machine.
 *
 * A state means "this work is not yet done". A transition is committed only AFTER its
 * side effect is durable, which is what makes crash-resumability fall out for free:
 * anything found in a *_RUNNING state on boot was interrupted, so just re-enter it.
 *
 * NOTE this is DISTINCT from `terminus.task_status`, which is Snorkel's own lifecycle
 * (0 Working on / 1 AI review / 2 Human review / 3 Accepted). Don't conflate them.
 */
export const PipelineState = {
    /** Parsed and saved, but INERT. The worker will never touch a DRAFT row. */
    DRAFT: 0,
    /** Human clicked "Start Build". This is the only way work ever begins. */
    QUEUED: 5,
    BUILD_RUNNING: 10,
    BUILT: 20,
    VERIFY_RUNNING: 30,
    VERIFY_FAILED: 35,
    FIX_RUNNING: 45,
    VERIFIED: 40,
    ZIPPED: 50,
    EXPLAINED: 55,
    UPLOADING: 60,
    CHECKING_FEEDBACK: 65,
    FEEDBACK_FAILED: 67,
    REMOTE_FIX_RUNNING: 69,
    /** Form is filled and Snorkel's checks are green. Waits here indefinitely, safely. */
    AWAITING_APPROVAL: 70,
    SUBMITTING: 80,
    // ------------------------------------------------------------------ PASS 2
    //
    // SUBMITTING is only HALF of a submission. Snorkel's own Rubric guide (lines 30-33):
    //
    //   "Generate the Rubric: Check the checkbox and then submit ... for automated checks."
    //   "Edit the Rubric: Once your submission COMES BACK TO YOU with a generated rubric ..."
    //   "Uncheck the Checkbox: ... ALWAYS uncheck ... BEFORE YOU SUBMIT (send to reviewer)!"
    //
    // So pass 1 (rubric ticked, send-to-reviewer NOT ticked) deliberately bounces the task into
    // "Tasks to be revised" — that is how the rubric gets generated at all. Pass 2 edits the
    // rubric and the tree, unticks the rubric box, ticks send-to-reviewer, and only THEN does a
    // human reviewer see it.
    //
    // SUBMITTED used to be TERMINAL, which meant nothing in this system ever drained the revise
    // queue. With the revision-queue gate in place (refuse at >=10, and it stands at 14), that
    // made the whole pipeline deadlock: it could neither submit new work nor clear the backlog.
    // These five states are the other half.
    /** Pass 1 landed. Snorkel is running CI and will hand the task back with a rubric. */
    SUBMITTED: 90,
    /** Watching the revise queue for OUR submission uid to appear. */
    REVISE_PENDING: 92,
    /** On the revise page: reviewer feedback + generated rubric read, Claude fixing, re-gating. */
    REVISE_RUNNING: 94,
    /** Tree re-gated, zip re-uploaded, rubric rewritten. The second human gate. */
    AWAITING_REVIEW_APPROVAL: 96,
    /** Pass 2: rubric box UNTICKED, "Send to reviewer?" TICKED, Submit clicked. */
    SENDING_TO_REVIEWER: 98,
    /** Done. A human reviewer has it. task_status → HUMAN_REVIEW. */
    SENT_TO_REVIEWER: 100,
    FAILED: -1,
    NEEDS_HUMAN: -2,
};
export const STATE_NAMES = Object.fromEntries(Object.entries(PipelineState).map(([k, v]) => [v, k]));
export function stateName(v) {
    return STATE_NAMES[v] ?? `UNKNOWN(${v})`;
}
/** Snorkel's lifecycle, as it appears in `terminus.task_status`. */
export const TaskStatus = {
    WORKING_ON: 0,
    AI_REVIEW: 1,
    HUMAN_REVIEW: 2,
    ACCEPTED: 3,
};
/** `terminus.payment_status`. */
export const PaymentStatus = {
    NONE: 0,
    PENDING: 1,
    PAID_OUT: 2,
};
/**
 * States the worker may claim. DRAFT is deliberately absent: only the human's
 * "Start Build" click moves a row to QUEUED.
 */
export const CLAIMABLE = [PipelineState.QUEUED];
/**
 * States that mean "a worker was mid-stage when it died". On boot these are swept
 * and re-entered. Each stage is written to be idempotent on re-entry.
 */
export const CRASHED_MIDFLIGHT = [
    PipelineState.BUILD_RUNNING,
    PipelineState.VERIFY_RUNNING,
    PipelineState.FIX_RUNNING,
    PipelineState.UPLOADING,
    PipelineState.CHECKING_FEEDBACK,
    PipelineState.REMOTE_FIX_RUNNING,
    PipelineState.SUBMITTING,
    PipelineState.REVISE_RUNNING,
    PipelineState.SENDING_TO_REVIEWER,
];
/**
 * Terminal — nothing else will happen without a human.
 *
 * SUBMITTED IS NOT HERE ANY MORE, and that is the point. It used to be, which meant a submitted
 * task was "done" — so nothing ever went back for the rubric, nothing ever reached a reviewer,
 * and nothing ever left the revise queue. Every submission added one to a queue that only ever
 * grew. The moment a queue gate existed (refuse at >=10; the queue stands at 14), that made the
 * system deadlock permanently.
 *
 * SENT_TO_REVIEWER is the real end of our involvement: a human reviewer has the task, and
 * task_status is HUMAN_REVIEW.
 */
export const TERMINAL = [
    PipelineState.SENT_TO_REVIEWER,
    PipelineState.FAILED,
    PipelineState.NEEDS_HUMAN,
];
export function isTerminal(s) {
    return TERMINAL.includes(s);
}
/**
 * SUBMITTING is the one state a restart must never blindly re-enter by clicking:
 * a duplicate submission cannot be undone. The submit stage reconciles against the
 * revise list first. This flag exists so that rule is greppable, not just a comment.
 */
export function requiresReconciliation(s) {
    return s === PipelineState.SUBMITTING;
}
