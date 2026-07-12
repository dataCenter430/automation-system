/**
 * Single-instance lock.
 *
 * Two workers polling the same Supabase table will both sweep the same interrupted task
 * and both drive it — racing on state.json, double-spending Claude sessions, and (worst)
 * potentially double-clicking Submit. The DB claim is atomic and protects QUEUED rows, but
 * the crash-recovery sweep deliberately re-enters rows that are already mid-flight, so it
 * offers no such protection.
 *
 * We hit this for real: a second worker started while the first was still building, and
 * they fought over the state file.
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { REPO_ROOT } from "../../../packages/shared/src/paths.ts";

const LOCK = resolve(REPO_ROOT, "runs/.worker.lock");

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check, doesn't actually signal
    return true;
  } catch {
    return false;
  }
}

export class AlreadyRunning extends Error {}

export function acquire(): void {
  mkdirSync(dirname(LOCK), { recursive: true });

  if (existsSync(LOCK)) {
    const pid = Number(readFileSync(LOCK, "utf8").trim());
    if (Number.isFinite(pid) && pid !== process.pid && isAlive(pid)) {
      throw new AlreadyRunning(
        `A worker is already running (pid ${pid}).\n` +
          `Two workers would drive the same task at once — racing on state and, worst case, ` +
          `double-submitting.\n\n` +
          `Stop the other one, or if you are sure it is dead:\n  del "${LOCK}"`,
      );
    }
    // Stale lock from a worker that was killed. Safe to take over.
  }

  writeFileSync(LOCK, String(process.pid), "utf8");
}

export function release(): void {
  try {
    if (existsSync(LOCK) && readFileSync(LOCK, "utf8").trim() === String(process.pid)) {
      unlinkSync(LOCK);
    }
  } catch {
    // A leftover lock is recoverable (the pid check above sees it's dead); a crash here is not.
  }
}
