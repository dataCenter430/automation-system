/**
 * The Claude engine.
 *
 * One turn = one call to the Agent SDK's `query()`, run headlessly in the task workspace.
 * The SDK spawns the Claude Code CLI it ships with, which authenticates from `~/.claude` —
 * there is NO API key anywhere in this system, by design. It uses the subscription of the
 * OS user running the worker.
 *
 * This module replaced a layer that drove the VS Code GUI with synthetic keystrokes. That
 * approach could not run on Linux at all, and even on Windows it depended on window focus,
 * a keybinding chord, and a sentinel file Claude had to remember to write. Here, a turn is
 * over when the SDK says it is over, and the session id comes back as data rather than
 * being scraped out of a transcript on disk.
 *
 * Two things are load-bearing and easy to get wrong:
 *
 *   systemPrompt.append  — this is where BUILD_CONTRACT lives. It deliberately does NOT go
 *     in a CLAUDE.md inside the task tree: lint.ts blocks CLAUDE.md as a High-severity
 *     reviewer flag, and the gate lints the workspace, so a task carrying one fails its own
 *     gate every time. The system prompt is not part of the conversation, so compaction
 *     cannot summarise it away either — which was the original reason for wanting CLAUDE.md.
 *
 *   onSessionId fires on the FIRST message  — the id is persisted before any real work
 *     happens, which is what makes a crashed build resumable instead of paid for twice.
 *
 * settingSources is left EMPTY (SDK isolation mode) on purpose: the task workspace lives
 * inside this repo, and we do not want the repo's own .claude/ settings leaking into a
 * build. Everything the build needs is passed explicitly.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { RateLimited, looksRateLimited } from "./errors.ts";
import { judge } from "./guard.ts";

/** A turn that ended for any reason other than Claude finishing normally. */
export class ClaudeTurnFailed extends Error {
  subtype: string;
  constructor(subtype: string, message: string) {
    super(message);
    this.name = "ClaudeTurnFailed";
    this.subtype = subtype;
  }
}

export interface TurnResult {
  sessionId: string | null;
  /** Claude's final message for the turn. */
  text: string;
  costUsd: number;
  turns: number;
  toolCalls: number;
  durationSec: number;
  /** Tool calls the guard refused. Empty on a normal build; non-empty is worth reading. */
  denials: string[];
}

export interface RunTurnArgs {
  prompt: string;
  /** Claude runs with this as its working directory, so every path it writes is task-local. */
  cwd: string;
  /** Session id to continue. Null/undefined starts a fresh conversation. */
  resume?: string | null;
  /** Appended to the Claude Code system prompt (we use it for BUILD_CONTRACT). */
  append?: string;
  timeoutMin: number;
  onSessionId?: (id: string) => Promise<void>;
  onProgress?: (msg: string) => Promise<void>;
  /** How often to emit a heartbeat. The dashboard's log is built from these. */
  heartbeatSec?: number;
  /** Prefix for heartbeat lines, e.g. "building". */
  label?: string;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => b?.type === "text")
    .map((b: any) => String(b.text ?? ""))
    .join("");
}

function countToolUses(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  return content.filter((b: any) => b?.type === "tool_use").length;
}

/**
 * Run one Claude turn to completion.
 *
 * Throws RateLimited (the worker backs off, without burning a retry attempt), or
 * ClaudeTurnFailed (a real failure the pipeline should record).
 */
export async function runTurn(args: RunTurnArgs): Promise<TurnResult> {
  const started = Date.now();
  const heartbeatMs = (args.heartbeatSec ?? 20) * 1000;
  const label = args.label ?? "working";

  let sessionId: string | null = args.resume ?? null;
  let announced = false;
  let toolCalls = 0;
  let lastActivity = Date.now();
  let finalText = "";
  let stderrTail = "";
  const denials: string[] = [];

  // The SDK has no timeout of its own — a wedged turn would hang the worker forever.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), args.timeoutMin * 60_000);

  // Heartbeats come off a timer rather than off message arrival: the interesting failure is
  // a turn that goes QUIET, and a message-driven heartbeat cannot report silence.
  let beating = false;
  const beat = setInterval(() => {
    if (beating || !args.onProgress) return;
    beating = true;
    const elapsed = Math.floor((Date.now() - started) / 1000);
    const idle = Math.floor((Date.now() - lastActivity) / 1000);
    const msg =
      `${label} · ${Math.floor(elapsed / 60)}m${elapsed % 60}s · ${toolCalls} tool calls` +
      (idle > 120 ? ` · idle ${idle}s` : "");
    void args
      .onProgress(msg)
      .catch(() => {})
      .finally(() => {
        beating = false;
      });
  }, heartbeatMs);

  try {
    const stream = query({
      prompt: args.prompt,
      options: {
        cwd: args.cwd,
        abortController: abort,
        // Isolation mode: no filesystem settings, no CLAUDE.md. See the header.
        settingSources: [],
        // There is no human at the keyboard, so every tool call is decided by guard.ts:
        // writes must stay inside this workspace, and a short list of shell constructs a
        // task build never needs is refused. NOT 'bypassPermissions' — an unattended agent
        // with a free hand on the whole machine is not a trade worth making.
        permissionMode: "default",
        canUseTool: async (toolName, input) => {
          const v = judge(args.cwd, toolName, input);
          if (v.allow) return { behavior: "allow", updatedInput: input };
          denials.push(`${toolName}: ${v.reason}`);
          // Surfaced, never swallowed: a silent block looks exactly like Claude being
          // stupid, and you would debug the wrong thing for an hour.
          void args.onProgress?.(`⛔ ${v.reason}`).catch(() => {});
          return { behavior: "deny", message: v.reason! };
        },
        systemPrompt: args.append
          ? { type: "preset", preset: "claude_code", append: args.append }
          : { type: "preset", preset: "claude_code" },
        ...(args.resume ? { resume: args.resume } : {}),
        stderr: (d: string) => {
          stderrTail = (stderrTail + d).slice(-4000);
        },
      },
    });

    for await (const m of stream as AsyncIterable<any>) {
      lastActivity = Date.now();

      if (m.session_id && !sessionId) sessionId = m.session_id;

      // Durable before anything else. This is what makes a long build survivable.
      if (sessionId && !announced) {
        announced = true;
        if (args.onSessionId) await args.onSessionId(sessionId);
      }

      if (m.type === "assistant") {
        toolCalls += countToolUses(m.message?.content);
        continue;
      }

      if (m.type === "result") {
        if (m.subtype === "success") {
          finalText = String(m.result ?? "");
          return {
            sessionId,
            text: finalText,
            costUsd: Number(m.total_cost_usd ?? 0),
            turns: Number(m.num_turns ?? 0),
            toolCalls,
            durationSec: Math.floor((Date.now() - started) / 1000),
            denials,
          };
        }

        // A limit is a "wait", not a failure: the worker backs off rather than spending one
        // of the task's three attempts on something that was never the task's fault.
        const blob = `${stderrTail}\n${textOf(m.result)}`;
        if (looksRateLimited(blob)) {
          throw new RateLimited(`Claude is rate limited: ${blob.trim().slice(-300)}`);
        }
        throw new ClaudeTurnFailed(
          String(m.subtype),
          `Claude did not finish: ${m.subtype}` +
            (stderrTail.trim() ? `\n${stderrTail.trim().slice(-600)}` : ""),
        );
      }
    }

    // The stream ended without a result message. Either the CLI died or we aborted it.
    if (abort.signal.aborted) {
      throw new ClaudeTurnFailed(
        "timeout",
        `Claude did not finish within ${args.timeoutMin} minutes ` +
          `(${toolCalls} tool calls). Last stderr:\n${stderrTail.trim().slice(-600)}`,
      );
    }
    if (looksRateLimited(stderrTail)) {
      throw new RateLimited(`Claude is rate limited: ${stderrTail.trim().slice(-300)}`);
    }
    throw new ClaudeTurnFailed(
      "no_result",
      `Claude's session ended without a result.\n${stderrTail.trim().slice(-600)}`,
    );
  } finally {
    clearTimeout(timer);
    clearInterval(beat);
  }
}
