/**
 * Open a VS Code window on a task workspace, so you can watch the build happen in a real
 * editor — one window per task, all of them at once.
 *
 * This is NOT the old build path. VS Code is a VIEWER here, not the driver.
 *
 * The old system drove the Claude extension by synthesising keystrokes into the focused
 * window. That is why it could only ever run one build at a time (only one window can hold
 * keyboard focus), why it needed an unlocked desktop, and why it could not run on this
 * machine at all. It also meant the build ran under whatever permissions the extension
 * happened to have — there was no guard.ts fence, because there was no programmatic hook to
 * put one in.
 *
 * What makes the viewer approach work is a happy accident of where Claude Code keeps state:
 * the Agent SDK writes its session transcript to
 *
 *     ~/.claude/projects/<workspace path, non-alphanumerics as '-'>/<session-id>.jsonl
 *
 * which is the SAME store the VS Code Claude extension reads for that folder. So opening VS
 * Code on workspace/<slug> shows you the build's own conversation in the Claude panel's
 * history — the prompt we sent and everything Claude did — while the SDK, not the keyboard,
 * is what actually drives it. You get the window back without giving up concurrency, the
 * permission guard, or the ability to run headless.
 *
 * Fire-and-forget on purpose: a missing `code` binary must never fail a build. If VS Code
 * cannot open, you lose a window, not a task.
 */
import { spawn } from "node:child_process";

const opened = new Set<string>();

/**
 * @param workspace absolute path to the task workspace
 * @param onNote    optional progress sink, so the dashboard says whether it worked
 */
export function openInEditor(workspace: string, onNote?: (msg: string) => void): void {
  // Once per workspace per worker run. `code <path>` re-focuses an existing window, and
  // stealing focus every time a fix turn starts would make the machine unusable while eight
  // builds run.
  if (opened.has(workspace)) return;
  opened.add(workspace);

  try {
    const child = spawn("code", [workspace], {
      detached: true,
      stdio: "ignore",
      // NOT windowsHide: on Windows, Electron inherits nCmdShow for its first window and
      // would open VS Code invisibly — real, focusable, and impossible to see. That cost the
      // original author an afternoon; the comment is preserved so it does not cost another.
    });
    child.on("error", (e) => {
      onNote?.(`could not open VS Code (${e.message}) — the build continues without it`);
    });
    child.unref();
    onNote?.("opened VS Code on this workspace — the Claude panel's history shows this session");
  } catch (e) {
    onNote?.(`could not open VS Code (${(e as Error).message}) — the build continues without it`);
  }
}
