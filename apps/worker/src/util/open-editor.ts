/**
 * The worker's single VS Code window pool.
 *
 * ONE pool per worker process, because the cap is a property of the MACHINE, not of a task. Eight
 * tasks each politely holding "their own" window is exactly how you end up with eight windows.
 *
 * The pool — and the argument for why it can never close a window YOU opened — lives in editor.ts.
 * This file is just the wiring: read the config, hold the one instance, give the pipeline four
 * verbs.
 */
import { EditorPool } from "./editor.ts";
import { loadConfig } from "../config.ts";

let pool: EditorPool | null = null;

function cap(): number {
  const cfg = loadConfig();
  // openEditor:false means a cap of ZERO — the pool still exists, it just never opens anything.
  // That keeps every call site identical on a headless box, instead of sprinkling `if (openEditor)`
  // through the pipeline.
  return cfg.worker.openEditor ? (cfg.worker.maxEditors ?? 6) : 0;
}

function get(): EditorPool {
  if (!pool) {
    pool = new EditorPool({ max: cap() });
  }
  return pool;
}

/**
 * Open a window for this task, if the pool has room.
 *
 * Never throws, never blocks. An editor is a convenience and a build must never wait on one — so a
 * full pool, a missing `code` binary, or no X11 all end the same way: no window, and the build
 * carries on. The dashboard says which.
 */
export async function openInEditor(workspace: string, onNote?: (msg: string) => void): Promise<void> {
  try {
    const p = get();
    const opened = await p.open(workspace);
    if (!opened) {
      onNote?.(
        cap() === 0
          ? "editor windows are off (worker.openEditor) — watch this build in the console"
          : `no VS Code window for this task — the pool is full at ${cap()}. ` +
            `Watch it in the console; the build is unaffected.`,
      );
      return;
    }
    onNote?.(`opened VS Code (${p.size}/${cap()}) — the Claude panel shows this build's own session`);
  } catch (e) {
    onNote?.(`could not open VS Code (${(e as Error).message}) — the build continues without it`);
  }
}

/**
 * This task is finished with its window. Close it.
 *
 * Deliberately NOT called on FAILED or NEEDS_HUMAN: those are exactly the tasks you want to open
 * and look at. See pipeline.ts for which states release a window.
 */
export async function closeEditor(workspace: string, why: string): Promise<void> {
  try {
    await get().release(workspace, why);
  } catch {
    // A window we could not close is an orphan on screen. Annoying, never dangerous.
  }
}

/** Keep this task's window off the eviction block while it is actively doing something. */
export function touchEditor(workspace: string): void {
  try {
    get().touch(workspace);
  } catch { /* the pool is best-effort, always */ }
}

/** For the dashboard's fleet meters — the third thing that can run out, after Claude and Docker. */
export function editorLoad(): { open: number; max: number } {
  return { open: pool?.size ?? 0, max: cap() };
}
