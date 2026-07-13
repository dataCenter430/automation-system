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
