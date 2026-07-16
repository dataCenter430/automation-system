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
function isAlive(pid) {
    try {
        process.kill(pid, 0); // signal 0 = existence check, doesn't actually signal
        return true;
    }
    catch {
        return false;
    }
}
export class AlreadyRunning extends Error {
}
export function acquire() {
    mkdirSync(dirname(LOCK), { recursive: true });
    // The claim must be ATOMIC, not existsSync-then-write.
    //
    // The old shape checked for the file, found none, and wrote — three separate syscalls with
    // gaps between them. Two workers started close together (a service wrapper retrying, a
    // scheduled run overlapping a manual one, `npm run worker` twice) both saw no lock, both
    // wrote their pid, and both proceeded. The DB's compare-and-swap in claimNextTask() does not
    // save you there, because sweep() recovers CRASHED_MIDFLIGHT rows WITHOUT going through it:
    // both workers would resume the same Claude session, in the same workspace, racing on the
    // same state.json.
    //
    // flag "wx" is O_CREAT|O_EXCL: the kernel creates the file or fails. Exactly one wins.
    const stamp = `${process.pid}\n`;
    try {
        writeFileSync(LOCK, stamp, { encoding: "utf8", flag: "wx" });
        return;
    }
    catch (e) {
        if (e.code !== "EEXIST")
            throw e;
    }
    // Someone holds it. Is that someone still alive?
    const pid = Number(readFileSync(LOCK, "utf8").trim());
    if (Number.isFinite(pid) && pid !== process.pid && isAlive(pid)) {
        throw new AlreadyRunning(`A worker is already running (pid ${pid}).\n` +
            `Two workers would drive the same task at once — racing on state and, worst case, ` +
            `double-submitting.\n\n` +
            `Stop the other one, or if you are sure it is dead:\n  ` +
            (process.platform === "win32" ? `del "${LOCK}"` : `rm "${LOCK}"`));
    }
    // A stale lock from a worker that was killed. Take it over — but do so by removing and
    // re-creating exclusively, so two processes racing to reclaim the SAME stale lock still
    // resolve to exactly one winner.
    try {
        unlinkSync(LOCK);
    }
    catch { /* another process got there first; the create below will decide it */ }
    try {
        writeFileSync(LOCK, stamp, { encoding: "utf8", flag: "wx" });
    }
    catch (e) {
        if (e.code === "EEXIST") {
            throw new AlreadyRunning("Another worker took the lock while this one was reclaiming it as stale. " +
                "That is the lock doing its job — start only one worker.");
        }
        throw e;
    }
}
export function release() {
    try {
        if (existsSync(LOCK) && readFileSync(LOCK, "utf8").trim() === String(process.pid)) {
            unlinkSync(LOCK);
        }
    }
    catch {
        // A leftover lock is recoverable (the pid check above sees it's dead); a crash here is not.
    }
}
