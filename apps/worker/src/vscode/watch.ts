/**
 * "Has the Claude session in VS Code finished this turn?"
 *
 * This module answers exactly that, and it must never answer it wrongly. Everything
 * downstream — the Docker gate, the zip, the submission — assumes the build is complete.
 *
 * We do NOT scrape the chat panel. A UI that *looks* idle proves nothing, and a false
 * "done" silently ships a half-built task. Instead, three independent signals:
 *
 *   SENTINEL   Claude writes .pipeline/<name> as its final act, because the prompt told it
 *              to. A file either exists or it doesn't. This is the intent signal.
 *   MANIFEST   The required files are actually on disk. This is the evidence signal, and it
 *              is what catches the documented failure mode of this model declaring itself
 *              done while the work is unfinished.
 *   TRANSCRIPT The session .jsonl the extension writes. This is the LIVENESS signal — it
 *              tells us Claude is still working rather than hung, and lets us show the human
 *              a real progress count instead of a spinner.
 *
 * Done requires sentinel AND manifest. The transcript never, on its own, means "done".
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Claude Code stores a session at ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl,
 * where <encoded-cwd> is the ABSOLUTE path with every non-alphanumeric char replaced by '-'.
 *
 *   E:\Work\Snorkel\...\workspace\my-slug
 *     -> E--Work-Snorkel-...-workspace-my-slug
 *
 * Note the double dash after the drive letter: both the ':' and the '\' become '-'.
 */
export function encodeCwd(absPath: string): string {
  return resolve(absPath).replace(/[^a-zA-Z0-9]/g, "-");
}

export function transcriptDir(workspace: string): string {
  return join(homedir(), ".claude", "projects", encodeCwd(workspace));
}

export interface SessionRef {
  path: string;
  sessionId: string;
  mtimeMs: number;
}

/** The newest session transcript for this workspace, or null if Claude hasn't started yet. */
export function findSession(workspace: string, since = 0): SessionRef | null {
  const dir = transcriptDir(workspace);
  if (!existsSync(dir)) return null;

  const sessions = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl") && !f.startsWith("agent-"))
    .map((f) => {
      const p = join(dir, f);
      return { path: p, sessionId: f.replace(/\.jsonl$/, ""), mtimeMs: statSync(p).mtimeMs };
    })
    .filter((s) => s.mtimeMs >= since)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  return sessions[0] ?? null;
}

/** How much work Claude has done — so the human sees progress, not a spinner. */
export function countToolCalls(transcriptPath: string): number {
  if (!existsSync(transcriptPath)) return 0;
  let n = 0;
  for (const line of readFileSync(transcriptPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const d = JSON.parse(line) as { type?: string; message?: { content?: unknown } };
      if (d.type !== "assistant") continue;
      const content = d.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block && typeof block === "object" && (block as { type?: string }).type === "tool_use") n++;
      }
    } catch { /* a partially-flushed last line is normal while Claude is writing */ }
  }
  return n;
}

function sentinelPath(workspace: string, name: string): string {
  return join(workspace, ".pipeline", name);
}

/**
 * Delete a stale sentinel BEFORE starting a turn.
 *
 * A leftover STEP_DONE from a previous run would make the very next check report "finished"
 * instantly — the build would be skipped and a stale task would sail through to Docker. It
 * is a one-line mistake with a silent, expensive failure, so it gets its own function and
 * gets called at the top of every turn.
 */
export function clearSentinel(workspace: string, name: string): void {
  mkdirSync(join(workspace, ".pipeline"), { recursive: true });
  rmSync(sentinelPath(workspace, name), { force: true });
}

export interface WatchResult {
  done: boolean;
  reason: string;
  sessionId: string | null;
  toolCalls: number;
  sentinelText: string | null;
}

export interface WatchOptions {
  workspace: string;
  sentinelName: string;
  timeoutMin: number;
  /** Files that must exist for the turn to count as complete. Relative to the workspace. */
  requireFiles?: string[];
  pollSec?: number;
  heartbeatSec?: number;
  onHeartbeat?: (info: {
    elapsedSec: number;
    idleSec: number;
    toolCalls: number;
    sessionId: string | null;
  }) => void | Promise<void>;
}

export async function waitForTurn(opts: WatchOptions): Promise<WatchResult> {
  const { workspace, sentinelName, timeoutMin } = opts;
  const pollSec = opts.pollSec ?? 5;
  const heartbeatSec = opts.heartbeatSec ?? 20;
  const requireFiles = opts.requireFiles ?? [];

  const started = Date.now();
  const deadline = started + timeoutMin * 60_000;
  let lastHeartbeat = 0;
  let lastActivityMs = started;
  let lastSize = -1;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollSec * 1000));

    const session = findSession(workspace);
    const toolCalls = session ? countToolCalls(session.path) : 0;

    // Liveness: is the transcript still growing?
    if (session) {
      const size = statSync(session.path).size;
      if (size !== lastSize) {
        lastSize = size;
        lastActivityMs = Date.now();
      }
    }

    const sp = sentinelPath(workspace, sentinelName);
    if (existsSync(sp)) {
      const missing = requireFiles.filter((f) => !existsSync(join(workspace, f)));

      if (missing.length === 0) {
        return {
          done: true,
          reason: "sentinel written and all required files present",
          sessionId: session?.sessionId ?? null,
          toolCalls,
          sentinelText: readFileSync(sp, "utf8").trim().slice(0, 500),
        };
      }

      // Claude said it finished, but the work isn't there. This is a real finding, not a
      // timing artefact — and it is exactly the failure this layer exists to catch. Keep
      // waiting in case it is still writing, but if it goes idle, report it honestly below.
      const idleSec = (Date.now() - lastActivityMs) / 1000;
      if (idleSec > 60) {
        return {
          done: false,
          reason:
            `Claude wrote the "${sentinelName}" sentinel but the task is incomplete — missing: ` +
            `${missing.join(", ")}. It has been idle for ${Math.round(idleSec)}s, so it is not ` +
            `still working. Treating this as an unfinished build rather than trusting the sentinel.`,
          sessionId: session?.sessionId ?? null,
          toolCalls,
          sentinelText: readFileSync(sp, "utf8").trim().slice(0, 500),
        };
      }
    }

    const elapsedSec = Math.round((Date.now() - started) / 1000);
    if (elapsedSec - lastHeartbeat >= heartbeatSec) {
      lastHeartbeat = elapsedSec;
      await opts.onHeartbeat?.({
        elapsedSec,
        idleSec: Math.round((Date.now() - lastActivityMs) / 1000),
        toolCalls,
        sessionId: session?.sessionId ?? null,
      });
    }
  }

  const session = findSession(workspace);
  const missing = requireFiles.filter((f) => !existsSync(join(workspace, f)));
  const idleSec = Math.round((Date.now() - lastActivityMs) / 1000);
  const sawSentinel = existsSync(sentinelPath(workspace, sentinelName));

  // NEVER done:true on a timeout. The caller turns this into NEEDS_HUMAN.
  return {
    done: false,
    reason:
      `Timed out after ${timeoutMin} minutes.\n` +
      `  sentinel "${sentinelName}": ${sawSentinel ? "present" : "NOT written"}\n` +
      `  missing files: ${missing.length ? missing.join(", ") : "none"}\n` +
      `  transcript: ${session ? `last changed ${idleSec}s ago` : "never appeared — did the prompt reach the chat box?"}`,
    sessionId: session?.sessionId ?? null,
    toolCalls: session ? countToolCalls(session.path) : 0,
    sentinelText: null,
  };
}
