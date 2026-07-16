/**
 * Local, per-task pipeline state: workspace/<slug>/.pipeline/state.json
 *
 * Deliberately two sources of truth. This file lives next to the artifacts it describes,
 * so it cannot drift from them — if the workspace is gone, so is the state. The DB columns
 * mirror it so Supabase is a live dashboard. On a conflict, this file wins for resume.
 *
 * Written atomically (tmp + rename): a half-written state.json after a crash would be
 * worse than none at all.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Explanations } from "./stages/explain.ts";

/**
 * One design the classifier said no to, and enough about it to tell a new design apart.
 *
 * `gradingAxis` is the load-bearing field. It is the answer to "what does the assertion
 * MEASURE?", and it is the thing three consecutive rebuilds never changed while changing
 * everything else. A redesign that keeps the axis has not redesigned anything, however
 * different its nouns are.
 */
export interface RejectedDesign {
  attempt: number;
  /** What the classifier called it, and how sure it was. */
  predicted: string;
  confidence: number;
  /** The classifier's own words — the only field that differed across the three rebuilds. */
  why: string;
  /** What the agent was asked to produce. */
  deliverable: string;
  /** What decided whether it was right. THE AXIS. */
  gradedOn: string;
  gradingAxis: GradingAxis;
  /** The test names, which are what the classifier actually reads. */
  testNames: string[];
  at: string;
}

/**
 * WHAT THE ASSERTION MEASURES. A closed vocabulary, deliberately.
 *
 * An open-ended "describe your grading approach" invites prose, and prose is what let three
 * rebuilds each describe the same equality assertion in fresh language. An enum cannot be
 * talked around: `equality-vs-reference` is rejected by construction for any category whose
 * deliverable is not literally an output artifact, and the worker can check "is this axis
 * already in the ledger?" mechanically, in microseconds, before it spends a single build.
 */
export type GradingAxis =
  /** agent's output == the reference output. THIS IS DATA-PROCESSING. Blocked, always. */
  | "equality-vs-reference"
  /** a measured property clears a stated bar: recall >= 0.95, AP >= baseline, error < tol. */
  | "property-threshold"
  /** an invariant must hold under attack/stress: a forged signature is refused, energy is conserved. */
  | "invariant-violation"
  /** the thing produced beats a named alternative on a metric: challenger vs champion, vs a baseline rule. */
  | "comparative-baseline"
  /** the observable end state of a system is correct: the service survives a restart, the limit is enforced. */
  | "observable-end-state";

export const GRADING_AXES: GradingAxis[] = [
  "equality-vs-reference",
  "property-threshold",
  "invariant-violation",
  "comparative-baseline",
  "observable-end-state",
];

/** The one axis that is data-processing BY DEFINITION, whatever the domain nouns say. */
export const BLOCKED_AXIS: GradingAxis = "equality-vs-reference";

export interface LocalState {
  taskId: string;
  slug: string;
  pipelineState: number;
  claudeSessionId: string | null;
  attempt: number;          // local Docker-gate fix attempts
  feedbackAttempt: number;  // Snorkel Check-feedback fix attempts
  zipPath: string | null;
  explanations: Explanations | null;
  /**
   * The URL of the submission page whose form we filled.
   *
   * Without this, the feedback and submit stages had nowhere to go back TO: they asked for
   * the home page, which navigated the shared tab away from the filled form. Snorkel
   * autosaves the submission, so returning to this URL restores it.
   */
  submissionUrl: string | null;
  /** Set while parked in CHECKING_FEEDBACK so a restart knows how long it has waited. */
  feedbackStartedAt: string | null;

  /**
   * A fingerprint of the last gate failure, and how many times in a row we have seen it.
   *
   * Retries are UNCAPPED (config retries.verifyAttempts = 0) — a task that needs five attempts
   * should get them, and a counter that kills an improving build throws away everything already
   * spent. But uncapped is not blind: the thing this system actually spends is rate limit, and an
   * unfixable task would burn it forever.
   *
   * So the loop is bounded by PROGRESS, not attempts. The same failure N times running means the
   * fix turns are not moving anything, and the task stops and asks a human instead of cranking.
   */
  lastFailureSig?: string | null;
  sameFailureCount?: number;

  /**
   * EVERY DESIGN THE CLASSIFIER HAS ALREADY REJECTED.
   *
   * Without this, a redesign is blind. It is handed the LATEST rejection and nothing else, so
   * it cannot know it is re-proposing something it already tried — and it cannot be held to
   * "something genuinely new", because nobody, including the machine checking it, knows what
   * old was.
   *
   * It also fixes a lie the system used to tell. The stuck detector fingerprinted the gate's
   * VERDICT ("software-engineering (0.92)") rather than the DESIGN, so three wholly different
   * task trees — a Terraform spec recovery, a threshold calibrator, and a champion/challenger
   * selector — produced one byte-identical fingerprint, and the pipeline reported "the fix loop
   * is going in circles" about a loop that had rebuilt the task from scratch twice. With the
   * ledger, "did the design actually change?" is a question we can answer instead of guess.
   *
   * Append-only. Never overwritten — the whole value is the history.
   */
  rejectedDesigns?: RejectedDesign[];

  /**
   * How many category blocks in a row, REGARDLESS of whether the design changed.
   *
   * Distinct from sameFailureCount, which now only counts a design that did NOT change. This
   * one is a budget on exploration: N genuinely different designs, all blocked, is not circling
   * — it is honest failure, and it deserves an honest message rather than a fabricated claim
   * that the loop went in circles.
   */
  blockedStreak?: number;

  /**
   * WHICH HALF OF THE SUBMISSION ARE WE ON.
   *
   *   1  the CI pass. Tick the rubric box, leave "Send to reviewer?" unticked, submit. Snorkel
   *      generates the rubric and hands the task back. This is a NEW submission.
   *   2  the reviewer pass. The task is on its revise page. Fix what the reviewer said, rewrite
   *      the rubric, re-zip, re-upload OVER the existing one, untick the rubric box, tick
   *      "Send to reviewer?", submit.
   *
   * The revise lap re-enters VERIFY_RUNNING and then walks the SAME states as the first build —
   * gate, zip, explain, upload, check feedback. Without this flag those states cannot tell the
   * two passes apart, and pass 2 would open a brand-new submission and submit it as pass 1 all
   * over again: a duplicate submission, and the reviewer would never get the task.
   */
  pass: 1 | 2;
  lastError: string | null;
  updatedAt: string;
}

function dir(workspace: string): string {
  return join(workspace, ".pipeline");
}
function file(workspace: string): string {
  return join(dir(workspace), "state.json");
}

export function readState(workspace: string): LocalState | null {
  const p = file(workspace);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as LocalState;
  } catch {
    return null; // corrupt (crashed mid-write on an older build) — treat as absent
  }
}

/**
 * Atomic-ish write: tmp file + rename.
 *
 * The rename is retried because on Windows it intermittently fails with EBUSY/EPERM —
 * Defender (or any indexer) briefly holds a handle on the file we just wrote, and
 * MoveFileEx refuses to replace the target. This is not theoretical: it killed a live
 * build six minutes in. Retrying beats the lock; a handful of milliseconds is all it takes.
 */
export function writeState(workspace: string, s: LocalState): void {
  mkdirSync(dir(workspace), { recursive: true });
  const target = file(workspace);
  const tmp = target + ".tmp";
  const json = JSON.stringify({ ...s, updatedAt: new Date().toISOString() }, null, 2);

  writeFileSync(tmp, json, "utf8");

  let lastErr: unknown;
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      renameSync(tmp, target);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "EPERM" && code !== "EACCES") throw e;
      lastErr = e;
      // Busy-wait briefly; this runs at most a few times and only on Windows contention.
      const until = Date.now() + 25 * (attempt + 1);
      while (Date.now() < until) { /* spin */ }
    }
  }

  // The rename never won. Writing in place is less crash-safe than a rename, but losing
  // the session id here would cost a whole 45-minute build — so take the lesser risk.
  try {
    writeFileSync(target, json, "utf8");
  } catch {
    throw lastErr;
  }
}

export function patchState(workspace: string, patch: Partial<LocalState>): LocalState {
  const cur = readState(workspace);
  if (!cur) throw new Error(`No state.json in ${workspace} — cannot patch what doesn't exist.`);
  const next = { ...cur, ...patch };
  writeState(workspace, next);
  return next;
}
