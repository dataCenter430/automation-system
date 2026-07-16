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
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { RateLimited, looksRateLimited } from "./errors.ts";
import { askHuman, blockedCount, clearQuestion } from "./ask.ts";
import { judge } from "./guard.ts";
import { subscriptionEnv } from "./no-billing.ts";
import { Semaphore } from "../util/semaphore.ts";
import { loadConfig } from "../config.ts";
/**
 * How many Claude sessions may run at once.
 *
 * `claude.maxConcurrent` has been in config/pipeline.json since the beginning, described as
 * the guard on the subscription rate limit — and no code has ever read it. This is where it
 * finally does something: every turn, from every stage, queues here. Build turns are long
 * (up to two hours for a long_context corpus), so this is the knob that decides whether
 * eight parallel tasks means eight parallel Claude sessions or a polite queue behind N.
 */
const claudeSlots = new Semaphore(Math.max(1, loadConfig().claude.maxConcurrent));
/**
 * The model every build runs on. `null` means "whatever the CLI defaults to" — which is what
 * we had, and it is not a choice, it is an accident waiting to change under you.
 */
const cfgModel = loadConfig().claude.model ?? null;
/**
 * How long a session will wait for a human to answer a question before giving up and using
 * its own judgment. See ask.ts — a parked question holds a Claude slot, so this is the knob
 * that decides whether "nobody is at the desk" costs you one build or the whole fleet.
 */
const askTimeoutMin = loadConfig().claude.askHumanTimeoutMin ?? 30;
/**
 * For the worker's status line: how loaded is Claude right now?
 *
 * `blocked` is the number of sessions parked on an unanswered question. It is part of
 * `running` (they hold their slots), and it is reported separately because a fleet whose
 * slots are all waiting on a human looks, from every other meter, exactly like an idle one.
 */
export function claudeLoad() {
    return { running: claudeSlots.inUse, queued: claudeSlots.queued, blocked: blockedCount() };
}
/**
 * Is this session actually on THIS machine?
 *
 * A session id is only meaningful next to the transcript it names. Claude Code stores those
 * at ~/.claude/projects/<cwd, non-alphanumerics replaced by '-'>/<id>.jsonl, so a workspace
 * carried over from another machine (or a different repo path) arrives with a recorded
 * session id whose transcript is nowhere to be found.
 *
 * Resuming it would fail — and worse, code that trusts the id would skip the study turn on
 * the grounds that "this session already read the playbook", when the session that read it
 * no longer exists. Ask first.
 */
export function sessionExists(cwd, sessionId) {
    if (!sessionId)
        return false;
    const dir = resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
    return existsSync(join(homedir(), ".claude", "projects", dir, `${sessionId}.jsonl`));
}
/** A turn that ended for any reason other than Claude finishing normally. */
export class ClaudeTurnFailed extends Error {
    subtype;
    constructor(subtype, message) {
        super(message);
        this.name = "ClaudeTurnFailed";
        this.subtype = subtype;
    }
}
function textOf(content) {
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        return "";
    return content
        .filter((b) => b?.type === "text")
        .map((b) => String(b.text ?? ""))
        .join("");
}
/**
 * A one-line, human-readable description of a tool call, for the dashboard's event log.
 *
 * This is the whole answer to "I can't see what it's doing". The old VS Code path gave you
 * a window to watch; the SDK is headless, so the event stream has to carry that visibility
 * instead. A heartbeat that only says "building · 8m · 4 tool calls" is not visibility — the
 * first build to run under this engine spent 45 minutes in a Write/Edit loop on one file and
 * nothing in the log said so until it timed out.
 */
function describeToolUse(b) {
    const i = b.input ?? {};
    const short = (p) => String(p ?? "").split("/").slice(-2).join("/");
    switch (b.name) {
        case "Bash":
            return `$ ${String(i.command ?? "").replace(/\s+/g, " ").slice(0, 90)}`;
        case "Write":
        case "Edit":
        case "MultiEdit":
            return `${b.name} ${short(i.file_path)}`;
        case "Read":
            return `Read ${short(i.file_path)}`;
        case "Glob":
        case "Grep":
            return `${b.name} ${String(i.pattern ?? "").slice(0, 50)}`;
        // The raw name is `mcp__human__ask_human`, which tells the reader of the log nothing. The
        // QUESTION is the event.
        case "mcp__human__ask_human":
            return `❓ asked you: ${String(i.question ?? "").slice(0, 90)}`;
        default:
            return b.name;
    }
}
/**
 * Run one Claude turn to completion.
 *
 * Throws RateLimited (the worker backs off, without burning a retry attempt), or
 * ClaudeTurnFailed (a real failure the pipeline should record).
 */
export async function runTurn(args) {
    // Queue behind claude.maxConcurrent. Waiting here is cheap and honest; the alternative is
    // firing eight simultaneous sessions at the subscription and taking a rate limit that
    // looks, from the dashboard, like eight tasks failing at once.
    if (claudeSlots.wouldBlock) {
        await args.onProgress?.(`waiting for a Claude slot (${claudeSlots.inUse} sessions running, ${claudeSlots.queued} ahead)`);
    }
    return claudeSlots.run(() => runTurnInner(args));
}
async function runTurnInner(args) {
    const started = Date.now();
    const heartbeatMs = (args.heartbeatSec ?? 20) * 1000;
    const label = args.label ?? "working";
    // Never hand the SDK a session id whose transcript is not on this machine — it would just
    // fail. Drop it loudly and start fresh instead; a fresh session on an existing workspace
    // can still read what is already there.
    let resumeId = args.resume ?? null;
    if (resumeId && !sessionExists(args.cwd, resumeId)) {
        await args.onProgress?.(`session ${resumeId.slice(0, 8)} has no transcript on this machine — starting a fresh one`);
        resumeId = null;
    }
    let sessionId = resumeId;
    let announced = false;
    let toolCalls = 0;
    let questionsAsked = 0;
    let timedOutQuestions = 0;
    let lastActivity = Date.now();
    let finalText = "";
    let stderrTail = "";
    let model = null;
    const denials = [];
    // The SDK has no timeout of its own — a wedged turn would hang the worker forever.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), args.timeoutMin * 60_000);
    // Heartbeats come off a timer rather than off message arrival: the interesting failure is
    // a turn that goes QUIET, and a message-driven heartbeat cannot report silence.
    let beating = false;
    const beat = setInterval(() => {
        if (beating || !args.onProgress)
            return;
        beating = true;
        const elapsed = Math.floor((Date.now() - started) / 1000);
        const idle = Math.floor((Date.now() - lastActivity) / 1000);
        const msg = `${label} · ${Math.floor(elapsed / 60)}m${elapsed % 60}s · ${toolCalls} tool calls` +
            (idle > 120 ? ` · idle ${idle}s` : "");
        void args
            .onProgress(msg)
            .catch(() => { })
            .finally(() => {
            beating = false;
        });
    }, heartbeatMs);
    // A question left over from a previous run belongs to a session that no longer exists.
    // Answering it would do nothing, so it must never reach a human. See ask.ts.
    clearQuestion(args.cwd);
    /**
     * The one tool in this system that a human answers.
     *
     * Claude Code's built-in AskUserQuestion is removed from the model's context below
     * (`disallowedTools`), because headless it has nobody to ask and would either hang or be
     * silently dropped. This replaces it. The handler is awaited by the SDK, so it can park for
     * as long as a human takes; the answer comes back as an ordinary tool result and the
     * conversation continues with its full context intact.
     */
    const humanTools = createSdkMcpServer({
        name: "human",
        version: "1.0.0",
        tools: [
            tool("ask_human", "Ask the human operator a question and WAIT for their answer. Use this only for a " +
                "decision that changes what the task IS and that you cannot settle from the brief " +
                "or the playbook. Do not use it to ask permission to proceed, to confirm something " +
                "you already know, or to report progress.", {
                question: z.string().describe("The decision, in one sentence. Be specific."),
                context: z
                    .string()
                    .optional()
                    .describe("Why you are stuck: what you tried, and what makes the choice genuinely ambiguous."),
                options: z
                    .array(z.object({
                    label: z.string().describe("A concrete choice, e.g. 'Calibrate a threshold'."),
                    detail: z.string().optional().describe("What picking this would mean for the task."),
                }))
                    .default([])
                    .describe("The choices you see. The human may also type a different answer."),
            }, async (input) => {
                const a = await askHuman({
                    workspace: args.cwd,
                    slug: basename(args.cwd),
                    question: input.question,
                    context: input.context,
                    options: input.options ?? [],
                    timeoutMin: askTimeoutMin,
                    signal: abort.signal,
                    onProgress: args.onProgress,
                });
                questionsAsked += 1;
                if (a.by === "timeout")
                    timedOutQuestions += 1;
                return { content: [{ type: "text", text: a.answer }] };
            }),
        ],
    });
    try {
        const stream = query({
            prompt: args.prompt,
            options: {
                cwd: args.cwd,
                abortController: abort,
                // Isolation mode: no filesystem settings, no CLAUDE.md. See the header.
                settingSources: [],
                // The human-in-the-loop channel. `ask_human` blocks; the dashboard answers it.
                mcpServers: { human: humanTools },
                // Close the dead end. Headless, the built-in has nobody to ask — leaving it in context
                // means the model can pick the door that goes nowhere instead of the one that works.
                disallowedTools: ["AskUserQuestion"],
                // The SDK's own warning, from the createSdkMcpServer doc comment: "If your SDK MCP
                // calls will run longer than 60s, override CLAUDE_CODE_STREAM_CLOSE_TIMEOUT." A tool
                // that waits for a person WILL run longer than 60 seconds. Without this the transport
                // tears the session down mid-question and the whole feature is a hang.
                // LAUNDERED, not spread. `{...process.env}` would hand the child ANTHROPIC_API_KEY if it
                // happened to be set — by a stray line in ~/.bashrc, a CI runner, another tool's installer
                // — and the CLI would silently stop using the subscription and start billing that key,
                // metered, per token. Nothing in the code would change; the invoice would arrive later.
                // subscriptionEnv() deletes every variable that could route a call off the subscription.
                env: subscriptionEnv({
                    CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: String(askTimeoutMin * 60_000 + 120_000),
                }),
                // There is no human at the keyboard, so every tool call is decided by guard.ts:
                // writes must stay inside this workspace, and a short list of shell constructs a
                // task build never needs is refused. NOT 'bypassPermissions' — an unattended agent
                // with a free hand on the whole machine is not a trade worth making.
                permissionMode: "default",
                canUseTool: async (toolName, input) => {
                    const v = judge(args.cwd, toolName, input);
                    if (v.allow)
                        return { behavior: "allow", updatedInput: input };
                    denials.push(`${toolName}: ${v.reason}`);
                    // Surfaced, never swallowed: a silent block looks exactly like Claude being
                    // stupid, and you would debug the wrong thing for an hour.
                    void args.onProgress?.(`⛔ ${v.reason}`).catch(() => { });
                    return { behavior: "deny", message: v.reason };
                },
                systemPrompt: args.append
                    ? { type: "preset", preset: "claude_code", append: args.append }
                    : { type: "preset", preset: "claude_code" },
                // Pin the model, if config says so. Leave it null and you inherit whatever the
                // Claude Code CLI happens to default to that week — which is how the first real
                // build silently ran on opus-4-5 when nobody had chosen it.
                ...(cfgModel ? { model: cfgModel } : {}),
                ...(resumeId ? { resume: resumeId } : {}),
                stderr: (d) => {
                    stderrTail = (stderrTail + d).slice(-4000);
                },
            },
        });
        for await (const m of stream) {
            lastActivity = Date.now();
            if (m.session_id && !sessionId)
                sessionId = m.session_id;
            // The SDK announces the model on its init message. Say it out loud: which model built
            // a task is not a detail, it is provenance.
            if (m.type === "system" && m.subtype === "init" && m.model && !model) {
                model = String(m.model);
                await args.onProgress?.(`model: ${model}`);
            }
            // Durable before anything else. This is what makes a long build survivable.
            if (sessionId && !announced) {
                announced = true;
                if (args.onSessionId)
                    await args.onSessionId(sessionId);
            }
            if (m.type === "assistant") {
                const blocks = Array.isArray(m.message?.content) ? m.message.content : [];
                for (const b of blocks) {
                    if (b?.type !== "tool_use")
                        continue;
                    toolCalls += 1;
                    // Stream every tool call so the dashboard log shows what Claude is actually doing,
                    // as it does it. This is the replacement for watching the VS Code window.
                    await args.onProgress?.(`⚙ ${toolCalls}. ${describeToolUse(b)}`);
                }
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
                        model,
                        questionsAsked,
                        questionsTimedOut: timedOutQuestions,
                    };
                }
                // A limit is a "wait", not a failure: the worker backs off rather than spending one
                // of the task's three attempts on something that was never the task's fault.
                const blob = `${stderrTail}\n${textOf(m.result)}`;
                if (looksRateLimited(blob)) {
                    throw new RateLimited(`Claude is rate limited: ${blob.trim().slice(-300)}`);
                }
                throw new ClaudeTurnFailed(String(m.subtype), `Claude did not finish: ${m.subtype}` +
                    (stderrTail.trim() ? `\n${stderrTail.trim().slice(-600)}` : ""));
            }
        }
        // The stream ended without a result message. Either the CLI died or we aborted it.
        if (abort.signal.aborted) {
            throw new ClaudeTurnFailed("timeout", `Claude did not finish within ${args.timeoutMin} minutes ` +
                `(${toolCalls} tool calls). Last stderr:\n${stderrTail.trim().slice(-600)}`);
        }
        if (looksRateLimited(stderrTail)) {
            throw new RateLimited(`Claude is rate limited: ${stderrTail.trim().slice(-300)}`);
        }
        throw new ClaudeTurnFailed("no_result", `Claude's session ended without a result.\n${stderrTail.trim().slice(-600)}`);
    }
    finally {
        clearTimeout(timer);
        clearInterval(beat);
        // However this turn ended — success, timeout, a dead CLI — no session is listening for an
        // answer any more. Leaving the question on the dashboard would invite the human to answer
        // into the void, and the click would appear to do nothing.
        clearQuestion(args.cwd);
    }
}
