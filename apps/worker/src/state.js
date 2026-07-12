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
function dir(workspace) {
    return join(workspace, ".pipeline");
}
function file(workspace) {
    return join(dir(workspace), "state.json");
}
export function readState(workspace) {
    const p = file(workspace);
    if (!existsSync(p))
        return null;
    try {
        return JSON.parse(readFileSync(p, "utf8"));
    }
    catch {
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
export function writeState(workspace, s) {
    mkdirSync(dir(workspace), { recursive: true });
    const target = file(workspace);
    const tmp = target + ".tmp";
    const json = JSON.stringify({ ...s, updatedAt: new Date().toISOString() }, null, 2);
    writeFileSync(tmp, json, "utf8");
    let lastErr;
    for (let attempt = 0; attempt < 12; attempt++) {
        try {
            renameSync(tmp, target);
            return;
        }
        catch (e) {
            const code = e.code;
            if (code !== "EBUSY" && code !== "EPERM" && code !== "EACCES")
                throw e;
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
    }
    catch {
        throw lastErr;
    }
}
export function patchState(workspace, patch) {
    const cur = readState(workspace);
    if (!cur)
        throw new Error(`No state.json in ${workspace} — cannot patch what doesn't exist.`);
    const next = { ...cur, ...patch };
    writeState(workspace, next);
    return next;
}
