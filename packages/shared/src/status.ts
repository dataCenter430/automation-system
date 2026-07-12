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
  SUBMITTED: 90,

  FAILED: -1,
  NEEDS_HUMAN: -2,
} as const;

export type PipelineStateValue = (typeof PipelineState)[keyof typeof PipelineState];

export const STATE_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(PipelineState).map(([k, v]) => [v, k]),
);

export function stateName(v: number): string {
  return STATE_NAMES[v] ?? `UNKNOWN(${v})`;
}

/** Snorkel's lifecycle, as it appears in `terminus.task_status`. */
export const TaskStatus = {
  WORKING_ON: 0,
  AI_REVIEW: 1,
  HUMAN_REVIEW: 2,
  ACCEPTED: 3,
} as const;

/** `terminus.payment_status`. */
export const PaymentStatus = {
  NONE: 0,
  PENDING: 1,
  PAID_OUT: 2,
} as const;

/**
 * States the worker may claim. DRAFT is deliberately absent: only the human's
 * "Start Build" click moves a row to QUEUED.
 */
export const CLAIMABLE: readonly number[] = [PipelineState.QUEUED];

/**
 * States that mean "a worker was mid-stage when it died". On boot these are swept
 * and re-entered. Each stage is written to be idempotent on re-entry.
 */
export const CRASHED_MIDFLIGHT: readonly number[] = [
  PipelineState.BUILD_RUNNING,
  PipelineState.VERIFY_RUNNING,
  PipelineState.FIX_RUNNING,
  PipelineState.UPLOADING,
  PipelineState.CHECKING_FEEDBACK,
  PipelineState.REMOTE_FIX_RUNNING,
  PipelineState.SUBMITTING,
];

/** Terminal — needs a human before anything else can happen. */
export const TERMINAL: readonly number[] = [
  PipelineState.SUBMITTED,
  PipelineState.FAILED,
  PipelineState.NEEDS_HUMAN,
];

export function isTerminal(s: number): boolean {
  return TERMINAL.includes(s);
}

/**
 * SUBMITTING is the one state a restart must never blindly re-enter by clicking:
 * a duplicate submission cannot be undone. The submit stage reconciles against the
 * revise list first. This flag exists so that rule is greppable, not just a comment.
 */
export function requiresReconciliation(s: number): boolean {
  return s === PipelineState.SUBMITTING;
}
