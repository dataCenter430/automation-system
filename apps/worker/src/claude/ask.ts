/**
 * The question channel: how a headless Claude session asks the human something.
 *
 * THE PROBLEM THIS SOLVES
 *
 * Claude Code ships a built-in `AskUserQuestion` tool. In an interactive terminal it renders
 * a picker and blocks on your keystroke. In our worker there IS no terminal — the SDK is
 * driven headlessly from a background process — so that tool has nobody to ask. A build that
 * hits a genuine fork in the road can only guess, and a guess that silently redesigns the
 * task is exactly the failure that got two submissions rejected.
 *
 * So we close the dead end and open a real one:
 *
 *   session.ts sets  disallowedTools: ["AskUserQuestion"]   <- the built-in is removed from
 *                                                              the model's context entirely
 *   session.ts mounts an in-process MCP server exposing     <- ours. WE execute it, so we can
 *                    mcp__human__ask_human                     return a REAL tool result.
 *
 * `tool()`'s handler is async and the SDK simply awaits it, so the handler can park for as
 * long as it likes. That is the whole trick: the tool call does not return until a human has
 * answered it in the dashboard, and the answer arrives back in the conversation as an
 * ordinary tool result. The model does not know a person was involved; it just gets its
 * answer and carries on. No prompt re-injection, no session restart, no lost context.
 *
 * THE CROSS-PROCESS CHANNEL
 *
 * The worker and the Next.js dashboard are different processes. They already share exactly
 * one thing — the task workspace on disk — and every other cross-process read in this system
 * (the gate panel, state.json) goes through it. So does this:
 *
 *   worker  writes  .pipeline/question.json   and then polls for...
 *   web     writes  .pipeline/answer.json     ...which the worker consumes and deletes.
 *
 * No new service, no socket, no DB migration. If the worker dies mid-question the file is
 * left behind, which is why every turn calls clearQuestion() on the way in: a question whose
 * asker is dead must never be shown to a human, because answering it would do nothing.
 *
 * THE COST OF WAITING, STATED HONESTLY
 *
 * A parked question holds its Claude semaphore slot. Six slots, three sleeping questions, and
 * the fleet is down to three builders — with nothing on screen explaining why. Two things
 * follow from that, and both are deliberate:
 *
 *   1. blockedCount() is exported and surfaced in the fleet meters, so "why is nothing
 *      building" always has a visible answer.
 *   2. Questions TIME OUT (claude.askHumanTimeoutMin). On timeout the tool returns a real
 *      answer — "no human was available; use your best judgment and say what you assumed" —
 *      rather than erroring. A fleet that deadlocks because someone went to bed is a worse
 *      failure than a build that proceeds on a stated assumption.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface QuestionOption {
  label: string;
  detail?: string;
}

/** What the worker writes, and the dashboard renders. */
export interface PendingQuestion {
  id: string;
  slug: string;
  askedAt: string;
  /** Deadline, so the UI can show a countdown instead of a spinner that never ends. */
  expiresAt: string;
  question: string;
  /** Why it is asking — the model's own framing of the choice. */
  context?: string;
  /** Suggested answers. May be empty: free text is always accepted. */
  options: QuestionOption[];
}

/** What the dashboard writes back. */
export interface Answer {
  id: string;
  answer: string;
  answeredAt: string;
  by: "human" | "timeout";
}

const POLL_MS = 1500;

const qFile = (ws: string) => join(ws, ".pipeline", "question.json");
const aFile = (ws: string) => join(ws, ".pipeline", "answer.json");

function readJson<T>(p: string): T | null {
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    return null; // absent, or caught mid-write — either way, nothing to act on yet
  }
}

/** tmp + rename, so the dashboard can never read a half-written question. */
function writeJson(p: string, v: unknown): void {
  mkdirSync(join(p, ".."), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(v, null, 2));
  renameSync(tmp, p);
}

const drop = (p: string) => {
  try {
    rmSync(p, { force: true });
  } catch {
    /* nothing to do — a question we cannot delete is one the next clearQuestion() will get */
  }
};

/** The pending question for a task, if any. Read by the dashboard. Never throws. */
export function readQuestion(workspace: string): PendingQuestion | null {
  return readJson<PendingQuestion>(qFile(workspace));
}

/**
 * Record a human's answer. Called by the web API.
 *
 * Refuses an answer to a question that is not the one currently pending: the human's tab
 * polls every 3s, so it is entirely possible to click an option for a question that timed
 * out a second ago, and applying that to whatever question came next would be worse than
 * dropping it.
 */
export function writeAnswer(workspace: string, id: string, answer: string): { ok: boolean; error?: string } {
  const q = readQuestion(workspace);
  if (!q) return { ok: false, error: "there is no question pending for this task" };
  if (q.id !== id) return { ok: false, error: "that question is no longer the one being asked" };
  if (!answer.trim()) return { ok: false, error: "an empty answer is not an answer" };
  writeJson(aFile(workspace), {
    id,
    answer: answer.trim(),
    answeredAt: new Date().toISOString(),
    by: "human",
  } satisfies Answer);
  return { ok: true };
}

/**
 * Forget any pending question.
 *
 * Called at the top of every turn. A question.json on disk means "a live Claude session is
 * blocked on this" — and after a worker restart that is a lie: the session that asked is
 * gone, and nothing is listening for the answer. Showing it to a human would invite them to
 * answer into the void.
 */
export function clearQuestion(workspace: string): void {
  drop(qFile(workspace));
  drop(aFile(workspace));
}

// ---------------------------------------------------------------------------------------
// How many sessions are parked on a human right now.
//
// Exported for the fleet meters. Without this, a fleet that has quietly given all six of its
// Claude slots to unanswered questions looks identical to a fleet that is simply idle.
// ---------------------------------------------------------------------------------------
let blocked = 0;
export const blockedCount = (): number => blocked;

/**
 * One question at a time, per task.
 *
 * Claude can emit several tool calls in a single assistant message, so two ask_human calls
 * can genuinely be in flight at once. question.json holds one question, so the second must
 * queue rather than overwrite the first — an overwritten question is one the human answers
 * while the session that asked it waits forever for a reply that went to someone else.
 */
const chains = new Map<string, Promise<unknown>>();
function serialize<T>(ws: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(ws) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  chains.set(
    ws,
    next.catch(() => {}),
  );
  return next;
}

export interface AskArgs {
  workspace: string;
  slug: string;
  question: string;
  context?: string;
  options: QuestionOption[];
  timeoutMin: number;
  /** Cancels the wait when the turn is aborted or times out. */
  signal?: AbortSignal;
  onProgress?: (msg: string) => Promise<void>;
}

/**
 * Ask the human, and block until they answer (or the clock runs out).
 *
 * Returns the answer text that goes back to Claude as the tool result.
 */
export function askHuman(args: AskArgs): Promise<Answer> {
  return serialize(args.workspace, () => askInner(args));
}

/**
 * What Claude is told when nobody answers.
 *
 * Every clause is load-bearing:
 *   "nobody is coming"      — so it stops hoping.
 *   "Do NOT ask again"      — or it asks a second time and waits out the clock a second time.
 *   "best judgment"         — the same words BUILD_CONTRACT rule 12 promises it will hear.
 *   "in your final message" — the decision was unsupervised. That fact has to reach the human
 *                             eventually, and the final message is the thing they actually read.
 */
const noHumanCame = (mins: number): string =>
  `No human answered within ${mins} minutes, so nobody is coming. Do NOT ask again — you would ` +
  `only wait again. Use your best judgment, choose the option you think is right, proceed with ` +
  `the build, and state plainly in your final message which choice you made and that you made ` +
  `it without a human.`;

async function askInner(args: AskArgs): Promise<Answer> {
  const { workspace, slug, signal } = args;

  // Zero is a real setting, not a misconfiguration: `askHumanTimeoutMin: 0` means "I am not at
  // my desk — never freeze a build slot on me." Answer instantly and never show a question
  // nobody is there to see. (The old clamp was Math.max(1, …), which silently turned "never
  // block on me" into "block on me for a minute".)
  const timeoutMs = Math.max(0, args.timeoutMin) * 60_000;
  if (timeoutMs === 0) {
    return {
      id: "q_disabled",
      answeredAt: new Date().toISOString(),
      by: "timeout",
      answer: noHumanCame(0),
    };
  }

  const now = Date.now();

  // The id is what stops a stale click from answering the wrong question. It is derived from
  // the clock rather than a counter because a worker restart resets a counter, and a restart
  // is exactly when a stale answer.json is lying around.
  const id = `q_${now.toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;

  const q: PendingQuestion = {
    id,
    slug,
    askedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + timeoutMs).toISOString(),
    question: args.question,
    context: args.context,
    options: args.options ?? [],
  };

  drop(aFile(workspace)); // never let a previous answer satisfy this question
  writeJson(qFile(workspace), q);

  blocked += 1;
  await args.onProgress?.(`❓ waiting on you: ${args.question.slice(0, 100)}`);

  try {
    const deadline = now + timeoutMs;
    for (;;) {
      if (signal?.aborted) {
        // The turn is being torn down. Do not leave a question on screen for a session that
        // no longer exists.
        clearQuestion(workspace);
        throw new Error("the turn was aborted while waiting for a human answer");
      }

      const a = readJson<Answer>(aFile(workspace));
      if (a && a.id === id) {
        drop(qFile(workspace));
        drop(aFile(workspace));
        await args.onProgress?.(`✅ you answered: ${a.answer.slice(0, 100)}`);
        return a;
      }

      if (Date.now() >= deadline) {
        drop(qFile(workspace));
        drop(aFile(workspace));
        await args.onProgress?.(
          `⏰ no answer in ${args.timeoutMin}m — told Claude to proceed on its own judgment`,
        );
        return {
          id,
          answeredAt: new Date().toISOString(),
          by: "timeout",
          answer: noHumanCame(args.timeoutMin),
        };
      }

      await sleep(POLL_MS, signal);
    }
  } finally {
    blocked -= 1;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((res) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      res();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
