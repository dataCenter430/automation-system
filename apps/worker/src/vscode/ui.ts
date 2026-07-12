/**
 * Drive the VS Code Claude Code extension the way a person would: open the folder, start a
 * new conversation, put the prompt in the box, hit enter. The point is that the human can
 * watch the whole build happen.
 *
 * What this module does NOT do is decide when Claude is finished. Screen-scraping a chat
 * panel for a "done" state is the thing that silently advances a half-built task. See
 * ./watch.ts — completion is proven from the session transcript and a sentinel file, not
 * from anything on screen.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { REPO_ROOT } from "../../../../packages/shared/src/paths.ts";
import { SENDKEYS, ensureKeybindings, verifyKeybindings } from "./keybindings.ts";

const exec = promisify(execFile);
const SCRIPT = resolve(REPO_ROOT, "scripts/vscode-send.ps1");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class VsCodeError extends Error {}

/**
 * Retry the input actions.
 *
 * Bringing a window to the foreground is a race against whatever else Windows currently
 * considers active, and it intermittently loses - observed live, twelve attempts failing and
 * the next call succeeding. A transient refusal must not kill a 45-minute build, so retry at
 * this level too. Read-only actions (check-window, check-desktop) are not worth retrying.
 */
const RETRYABLE = new Set(["focus-window", "send-chord", "type", "paste", "enter"]);

async function ps(args: string[]): Promise<string> {
  const action = args[1] ?? "";
  const attempts = RETRYABLE.has(action) ? 3 : 1;

  let last: Error | null = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await psOnce(args);
    } catch (e) {
      last = e as Error;
      if (i < attempts - 1) await sleep(2000 * (i + 1));
    }
  }
  throw last;
}

async function psOnce(args: string[]): Promise<string> {
  try {
    const { stdout } = await exec(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, ...args],
      { timeout: 60_000, windowsHide: true },
    );
    return stdout.trim();
  } catch (e) {
    // PowerShell's error text lands in stderr, but it arrives as a multi-line record with
    // the useful sentence buried in it. Surface ALL of it: an empty error message here cost
    // a whole debugging round the first time this failed.
    const err = e as { stderr?: string; stdout?: string; message?: string; code?: number };
    const detail = [err.stderr, err.stdout, err.message]
      .map((s) => (s ?? "").trim())
      .filter(Boolean)
      .join("\n") || `(no output; exit code ${err.code ?? "?"})`;
    throw new VsCodeError(`vscode-send.ps1 ${args[1] ?? "?"} failed:\n${detail}`);
  }
}

/** The VS Code window title contains the folder name, which is how we find the right window. */
function windowMatch(workspace: string): string {
  return basename(workspace);
}

/**
 * Is there a usable interactive desktop?
 *
 * A locked workstation swaps the interactive desktop for the secure Winlogon one, and while
 * that is up NOTHING can focus an app window or deliver a keystroke to it. The visual build
 * drives the real VS Code window, so a locked screen doesn't degrade it — it stops it dead.
 * Worth checking before we start rather than 40 seconds into a build.
 */
export async function isDesktopUsable(): Promise<boolean> {
  try {
    return (await ps(["-Action", "check-desktop"])) === "OK";
  } catch {
    return false;
  }
}

export async function isWindowOpen(workspace: string): Promise<boolean> {
  const out = await ps(["-Action", "check-window", "-Window", windowMatch(workspace)]);
  return out.startsWith("OK|");
}

/**
 * Open VS Code on the task workspace and wait for its window to actually exist.
 *
 * The wait matters: `code` returns immediately while VS Code is still starting, and a
 * keystroke sent into that gap goes nowhere (or somewhere worse).
 */
export async function openWorkspace(workspace: string, timeoutSec = 90): Promise<void> {
  ensureKeybindings();
  if (!verifyKeybindings()) {
    throw new VsCodeError(
      "Our keybindings are not present in VS Code's keybindings.json after installing them. " +
        "Without them, a synthetic keystroke would not reliably reach the Claude extension.",
    );
  }

  if (await isWindowOpen(workspace)) return;

  // `code` on Windows is a .cmd shim, so it needs a shell.
  //
  // NOTE the absence of `windowsHide: true`. That option sets STARTF_USESHOWWINDOW/SW_HIDE
  // in the STARTUPINFO we hand to the child - and ELECTRON INHERITS nCmdShow FOR ITS FIRST
  // WINDOW. So VS Code would open the workspace in a window that is real, focusable, and
  // completely invisible. Worse, VS Code then considers the folder "already open" and
  // refuses to open it again, so every retry silently did nothing. Verified: the window was
  // there the whole time with visible=False, minimized=False.
  //
  // The console flash from cmd.exe is a fair price for a window you can actually see.
  await exec("cmd", ["/c", "code", "--new-window", workspace], { timeout: 30_000 })
    .catch((e) => {
      throw new VsCodeError(
        `Could not launch VS Code (\`code --new-window\`): ${(e as Error).message}\n` +
          `Is the \`code\` CLI on PATH? In VS Code: Cmd/Ctrl+Shift+P -> "Shell Command: Install 'code' command in PATH".`,
      );
    });

  // Wait for the window to be STABLY present, not merely present once.
  //
  // On a cold start VS Code spawns several Code.exe processes and the one that owns the
  // main window changes as it initialises — so a single successful check can be followed
  // immediately by a failing one. Observed live. A flaky check here means we'd start
  // pasting into a window that isn't there.
  const deadline = Date.now() + timeoutSec * 1000;
  let consecutive = 0;
  while (Date.now() < deadline) {
    await sleep(1500);
    consecutive = (await isWindowOpen(workspace)) ? consecutive + 1 : 0;
    if (consecutive >= 3) {
      await sleep(5000); // let the window paint and the Claude extension activate
      return;
    }
  }
  throw new VsCodeError(
    `VS Code did not open a stable window for ${workspace} within ${timeoutSec}s.`,
  );
}

async function chord(workspace: string, command: keyof typeof SENDKEYS | string): Promise<void> {
  const keys = SENDKEYS[command];
  if (!keys) throw new VsCodeError(`No SendKeys mapping for command "${command}".`);
  await ps(["-Action", "send-chord", "-Window", windowMatch(workspace), "-Chord", keys]);
}

/** Open the Claude sidebar and start a genuinely NEW conversation for this task. */
export async function newConversation(workspace: string): Promise<void> {
  await chord(workspace, "claude-vscode.sidebar.open");
  await sleep(1500);
  await chord(workspace, "claude-vscode.newConversation");
  await sleep(2000);
  await chord(workspace, "claude-vscode.focus");
  await sleep(800);
}

/** SendKeys treats these as syntax, so a literal one must be wrapped in braces. */
function escapeSendKeys(s: string): string {
  return s.replace(/[+^%~(){}[\]]/g, (c) => `{${c}}`);
}

/**
 * Send a prompt to the Claude conversation, WITHOUT touching the clipboard.
 *
 * The obvious approach - put the prompt on the clipboard and press Ctrl+V - does not
 * survive this machine. The Windows clipboard is a single global resource, and AnyDesk and
 * RustDesk are both running and grab it continuously to sync it, so even SetDataObject's
 * ten-retry overload fails every time with "Requested Clipboard operation did not succeed".
 * Building on a resource two remote-desktop tools are fighting over would be fragile
 * forever, so we don't.
 *
 * Instead the prompt is WRITTEN TO A FILE in the workspace, and the chat message is one
 * short line telling Claude to read it. That line is ~50 characters, which SendKeys types
 * reliably - and it sidesteps the other problem too: synthesising 52,000 keystrokes for the
 * playbook would have taken many minutes and dropped characters.
 *
 * It is still fully visual. You watch the message appear and Claude open the file and work.
 */
export async function sendPrompt(workspace: string, text: string, label: string): Promise<void> {
  const dir = join(workspace, ".pipeline");
  mkdirSync(dir, { recursive: true });
  const rel = `.pipeline/${label}.md`;
  writeFileSync(join(workspace, rel), text, "utf8");

  const message = `Read ${rel} in this workspace and do exactly what it says.`;

  await chord(workspace, "claude-vscode.focus");
  await sleep(800);
  await ps(["-Action", "type", "-Window", windowMatch(workspace), "-Chord", escapeSendKeys(message)]);
  await sleep(600);
  await ps(["-Action", "enter", "-Window", windowMatch(workspace)]);
}
