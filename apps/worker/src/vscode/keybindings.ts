/**
 * Install our own keybindings for the Claude Code extension's commands.
 *
 * Why not use the extension's built-in shortcuts? Because every one of them carries a
 * `when` clause. `newConversation` (ctrl+n) only fires when
 *   config.claudeCode.enableNewConversationShortcut && (activeWebviewPanelId == 'claudeVSCodePanel' || ...)
 * so whether a synthetic ctrl+n starts a new Claude conversation or a new *file* depends on
 * what happens to have focus. That is not something to gamble a 45-minute build on.
 *
 * So we bind rare, unconditional chords to the exact commands we need. A keystroke then
 * means one thing and only one thing.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

export interface Chord {
  key: string;
  command: string;
}

/**
 * F-keys with a three-modifier chord: nothing else in VS Code uses these, and SendKeys can
 * express them cleanly (^%+{F9} etc).
 */
export const CHORDS: Chord[] = [
  { key: "ctrl+alt+shift+f9", command: "claude-vscode.sidebar.open" },
  { key: "ctrl+alt+shift+f10", command: "claude-vscode.newConversation" },
  { key: "ctrl+alt+shift+f11", command: "claude-vscode.focus" },
];

/** SendKeys encoding of the chords above. Keep in lockstep with CHORDS. */
export const SENDKEYS: Record<string, string> = {
  "claude-vscode.sidebar.open": "^%+{F9}",
  "claude-vscode.newConversation": "^%+{F10}",
  "claude-vscode.focus": "^%+{F11}",
};

export function keybindingsPath(): string {
  if (process.env.VSCODE_USER_DIR) return resolve(process.env.VSCODE_USER_DIR, "keybindings.json");
  const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  return join(appData, "Code", "User", "keybindings.json");
}

/**
 * VS Code's keybindings.json is JSONC: line comments, block comments, trailing commas.
 * JSON.parse chokes on all three, and this is a file the user owns — so parse tolerantly
 * and, if we still can't read it, refuse to touch it rather than clobber it.
 */
function parseJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const next = text[i + 1];

    if (inLine) {
      if (c === "\n") { inLine = false; out += c; }
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") { inBlock = false; i++; }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") { out += text[++i] ?? ""; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === "/" && next === "/") { inLine = true; i++; continue; }
    if (c === "/" && next === "*") { inBlock = true; i++; continue; }
    out += c;
  }

  // Trailing commas before ] or }
  out = out.replace(/,(\s*[\]}])/g, "$1");
  const trimmed = out.trim();
  if (!trimmed) return [];
  return JSON.parse(trimmed);
}

export interface EnsureResult {
  path: string;
  installed: string[];
  alreadyPresent: string[];
  backedUpTo: string | null;
}

export function ensureKeybindings(): EnsureResult {
  const path = keybindingsPath();
  mkdirSync(dirname(path), { recursive: true });

  let existing: Array<Record<string, unknown>> = [];
  let backedUpTo: string | null = null;

  if (existsSync(path)) {
    const raw = readFileSync(path, "utf8");
    let parsed: unknown;
    try {
      parsed = parseJsonc(raw);
    } catch (e) {
      throw new Error(
        `Could not parse your VS Code keybindings.json, so I will not touch it:\n  ${path}\n` +
          `  ${(e as Error).message}\n\n` +
          `Fix or move that file, then re-run. (Overwriting a config you own is not something ` +
          `this tool will do on a guess.)`,
      );
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`${path} does not contain a JSON array. Refusing to overwrite it.`);
    }
    existing = parsed as Array<Record<string, unknown>>;

    if (raw.trim()) {
      backedUpTo = `${path}.bak-${Date.now()}`;
      copyFileSync(path, backedUpTo);
    }
  }

  const installed: string[] = [];
  const alreadyPresent: string[] = [];

  for (const chord of CHORDS) {
    const hit = existing.some((b) => b.key === chord.key && b.command === chord.command);
    if (hit) {
      alreadyPresent.push(chord.command);
      continue;
    }
    existing.push({ key: chord.key, command: chord.command });
    installed.push(chord.command);
  }

  if (installed.length) {
    writeFileSync(path, JSON.stringify(existing, null, 2) + "\n", "utf8");
  }

  return { path, installed, alreadyPresent, backedUpTo };
}

export function verifyKeybindings(): boolean {
  const path = keybindingsPath();
  if (!existsSync(path)) return false;
  try {
    const parsed = parseJsonc(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed)) return false;
    return CHORDS.every((c) =>
      (parsed as Array<Record<string, unknown>>).some((b) => b.key === c.key && b.command === c.command),
    );
  } catch {
    return false;
  }
}
