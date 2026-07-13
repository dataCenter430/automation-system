/**
 * The fleet meters — how loaded is the worker, right now?
 *
 * The worker is the ONLY process that can answer this. The Claude semaphore
 * (claude/session.ts) and the docker-gate semaphore (pipeline.ts) live in that process's
 * memory; the web app runs in a different process and cannot see inside it. So the worker
 * writes what it knows to runs/.worker-status.json on every poll tick, and this route reads
 * it back.
 *
 * The `stale` flag is the whole point of the timestamp. A worker that has been killed
 * leaves its last status file behind, and that file says "0 tasks in flight, 0 gates
 * running" — which is indistinguishable from a healthy idle worker unless you check how
 * old it is. A DEAD WORKER MUST NOT LOOK LIKE AN IDLE ONE, so anything older than 30s
 * (the worker rewrites every 5s, and refreshes even while parked in rate-limit backoff) is
 * reported stale and the meters must not be trusted.
 *
 * Read-only. It never writes, and it never touches the pipeline.
 */
import { NextResponse } from "next/server";
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { db } from "../../../../../packages/shared/src/supabase.ts";
import { REPO_ROOT, expandPath } from "../../../../../packages/shared/src/paths.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A status older than this means the worker is not writing any more — i.e. it is gone. */
const STALE_AFTER_MS = 30_000;

function configPaths(): { workspace: string; runs: string } {
  try {
    const cfg = JSON.parse(readFileSync(resolve(REPO_ROOT, "config/pipeline.json"), "utf8"));
    return { workspace: expandPath(cfg.paths.workspace), runs: expandPath(cfg.paths.runs) };
  } catch {
    return { workspace: resolve(REPO_ROOT, "workspace"), runs: resolve(REPO_ROOT, "runs") };
  }
}

// ---------------------------------------------------------------------------------------
// PER-TASK BURN, DERIVED FROM THE SESSION TRANSCRIPT
//
// (This block is deliberately identical to the one in app/api/tasks/route.ts. Both routes
// need it and neither may import from the other — a Next route module may only export its
// handlers, so there is nowhere shared to put it without touching a file this change does
// not own. Keep them in sync.)
//
// The Agent SDK writes the complete transcript of every session to
// ~/.claude/projects/<cwd, non-alphanumerics as '-'>/<session-id>.jsonl. That file is the
// ONLY place the per-task model, cost and tool-call count exist — the pipeline never
// recorded any of them. Four things about it are traps, and each one silently yields a
// confident, wrong number:
//
//  1. There are NO `result` lines. The SDK's result message — the one carrying
//     total_cost_usd — is a STREAM message; the CLI never persists it. (This is why the
//     existing session route's `costUsd` reads 0.00 on every real build.) Cost therefore
//     has to be derived from per-message `usage` and a price table.
//
//  2. ONE API response is split across SEVERAL jsonl lines — one per content block (text,
//     then tool_use). The input-side usage (input_tokens, cache_creation, cache_read) is
//     REPEATED VERBATIM on every line of the same message.id. Summing per line overcounts:
//     on the live transcript that is 29.1M cache-read tokens instead of 17.1M (+70%).
//
//  3. But output_tokens is NOT repeated — it is a running value that only reaches its final
//     figure on the LAST line of a message (the first line carries a placeholder 1). Taking
//     the first line per id undercounts output by 91% (7,993 instead of 89,706).
//
//     => Group by message.id, keep the LAST usage seen for each id, then sum. Both halves
//        of that sentence are load-bearing.
//
//  4. One session can span SEVERAL models. The live transcript holds both claude-opus-4-5
//     and claude-opus-4-8 — config/pipeline.json's pin changed under a running build. Cost
//     must be priced per model, not at one blended rate.
//
// `costUsd` is an API-list-price EQUIVALENT, not money charged. These builds authenticate
// as the logged-in Claude Code CLI (a subscription), so no per-token bill exists — this is
// what the same work would have cost on the API, which is the number you want when judging
// whether a build was worth its retries.
// ---------------------------------------------------------------------------------------

type Price = { in: number; out: number };

/** USD per MILLION tokens, list price. Cache write (5m) = 1.25x input; cache read = 0.1x. */
const PRICES: Record<string, Price> = {
  "claude-opus-4-8": { in: 5, out: 25 },
  "claude-opus-4-7": { in: 5, out: 25 },
  "claude-opus-4-6": { in: 5, out: 25 },
  "claude-opus-4-5": { in: 5, out: 25 },
  "claude-sonnet-5": { in: 3, out: 15 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-sonnet-4-5": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};
const CACHE_WRITE_MULT = 1.25;
const CACHE_READ_MULT = 0.1;

/** `claude-opus-4-5-20251101` is the same model, and the same price, as `claude-opus-4-5`. */
function priceOf(model: string): Price | null {
  return PRICES[model] ?? PRICES[model.replace(/-\d{8}$/, "")] ?? null;
}

type Usage = { model: string | null; i: number; cw: number; cr: number; o: number };

interface Derived {
  model: string | null;
  models: string[];
  toolCalls: number;
  /** null when nothing in the transcript could be priced (an unknown model). Never a fake 0. */
  costUsd: number | null;
  /** True when SOME model in this session has no price — the cost is a floor, not a total. */
  costPartial: boolean;
  tokens: { input: number; cacheWrite: number; cacheRead: number; output: number };
}

interface Entry {
  size: number;
  mtimeMs: number;
  offset: number;
  leftover: Buffer;
  byId: Map<string, Usage>;
  toolCalls: number;
  lastModel: string | null;
  derived: Derived | null;
}

/**
 * The dashboard polls every 3s, and a build transcript is megabytes (2.5 MB and growing on
 * the live one). So parse INCREMENTALLY: the jsonl is append-only, so remember the byte
 * offset and only read what was appended since last time. An unchanged file costs one
 * statSync(). The partial trailing line is carried over as BYTES, not text, so a multi-byte
 * character split across a read boundary is not corrupted.
 */
const cache = new Map<string, Entry>();

/** Same encoding Claude Code uses for its per-project transcript directory. */
function transcriptPath(workspace: string, sessionId: string): string {
  const dir = resolve(workspace).replace(/[^a-zA-Z0-9]/g, "-");
  return join(homedir(), ".claude", "projects", dir, `${sessionId}.jsonl`);
}

function ingest(e: Entry, line: string): void {
  if (!line.trim()) return;
  let m: any;
  try {
    m = JSON.parse(line);
  } catch {
    return; // a torn line is skipped, never fatal
  }
  const msg = m?.message;
  if (!msg) return;

  // Tool calls: blocks are disjoint across the lines of one message, so counting every
  // tool_use block over every line is right — no dedupe needed here.
  if (Array.isArray(msg.content)) {
    for (const b of msg.content) if (b?.type === "tool_use") e.toolCalls += 1;
  }

  if (m.type !== "assistant") return;
  const model = typeof msg.model === "string" ? msg.model : null;
  if (model) e.lastModel = model; // the model that ACTUALLY answered most recently
  const id = typeof msg.id === "string" ? msg.id : null;
  const u = msg.usage;
  if (!id || !u) return;

  // LAST line per message.id wins — see trap (2)/(3) above.
  e.byId.set(id, {
    model,
    i: Number(u.input_tokens ?? 0),
    cw: Number(u.cache_creation_input_tokens ?? 0),
    cr: Number(u.cache_read_input_tokens ?? 0),
    o: Number(u.output_tokens ?? 0),
  });
}

function derive(e: Entry): Derived {
  const tokens = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  const perModel = new Map<string, { i: number; cw: number; cr: number; o: number }>();

  for (const u of e.byId.values()) {
    tokens.input += u.i;
    tokens.cacheWrite += u.cw;
    tokens.cacheRead += u.cr;
    tokens.output += u.o;
    const key = u.model ?? "(unknown)";
    const b = perModel.get(key) ?? { i: 0, cw: 0, cr: 0, o: 0 };
    b.i += u.i;
    b.cw += u.cw;
    b.cr += u.cr;
    b.o += u.o;
    perModel.set(key, b);
  }

  let cost = 0;
  let anyPriced = false;
  let partial = false;
  for (const [model, b] of perModel) {
    const p = priceOf(model);
    if (!p) {
      partial = true; // an unpriced model: say so rather than quietly billing it at zero
      continue;
    }
    anyPriced = true;
    cost +=
      (b.i * p.in + b.cw * p.in * CACHE_WRITE_MULT + b.cr * p.in * CACHE_READ_MULT + b.o * p.out) /
      1_000_000;
  }

  return {
    model: e.lastModel,
    models: [...perModel.keys()].filter((m) => m !== "(unknown)"),
    toolCalls: e.toolCalls,
    costUsd: perModel.size === 0 ? 0 : anyPriced ? Number(cost.toFixed(4)) : null,
    costPartial: partial,
    tokens,
  };
}

/** Null when there is no transcript on this machine. Missing transcript => nulls, never a crash. */
function burnOf(workspace: string, sessionId: string): Derived | null {
  const file = transcriptPath(workspace, sessionId);
  let st;
  try {
    st = statSync(file);
  } catch {
    return null;
  }

  let e = cache.get(file);
  if (!e || st.size < e.size) {
    // Truncated or replaced (a different machine's transcript copied in): start over.
    e = {
      size: 0, mtimeMs: 0, offset: 0, leftover: Buffer.alloc(0),
      byId: new Map(), toolCalls: 0, lastModel: null, derived: null,
    };
    cache.set(file, e);
  }
  if (e.derived && st.size === e.size && st.mtimeMs === e.mtimeMs) return e.derived;

  if (st.size > e.offset) {
    const fd = openSync(file, "r");
    try {
      const len = st.size - e.offset;
      const buf = Buffer.allocUnsafe(len);
      const got = readSync(fd, buf, 0, len, e.offset);
      const chunk = Buffer.concat([e.leftover, buf.subarray(0, got)]);
      const nl = chunk.lastIndexOf(0x0a);
      if (nl < 0) {
        e.leftover = Buffer.from(chunk);
      } else {
        for (const line of chunk.subarray(0, nl).toString("utf8").split("\n")) ingest(e, line);
        e.leftover = Buffer.from(chunk.subarray(nl + 1));
      }
      e.offset += got;
    } finally {
      closeSync(fd);
    }
  }

  e.size = st.size;
  e.mtimeMs = st.mtimeMs;
  e.derived = derive(e);
  return e.derived;
}

export async function GET() {
  const { workspace, runs } = configPaths();

  // ---- The worker's own meters -------------------------------------------------------
  let worker: any = null;
  let note: string | undefined;
  const statusFile = join(runs, ".worker-status.json");
  try {
    worker = JSON.parse(readFileSync(statusFile, "utf8"));
  } catch {
    note =
      `No worker status at ${statusFile}. The worker writes it every poll tick, so either ` +
      `the worker has never run on this machine, or it is an older build that does not ` +
      `publish its load. The meters below are unknown — not zero.`;
  }

  const at = typeof worker?.at === "string" ? Date.parse(worker.at) : NaN;
  const ageMs = Number.isFinite(at) ? Date.now() - at : null;
  // No file, an unparseable timestamp, or an old one all mean the same thing: do not trust
  // the meters. A dead worker must not render as an idle one.
  const stale = worker === null || ageMs === null || ageMs > STALE_AFTER_MS;

  // ---- What the fleet has burned so far ----------------------------------------------
  let totalBurnUsd: number | null = null;
  let burnPartial = false;
  let tasksWithTranscript = 0;
  try {
    const { data: rows } = await db()
      .from("terminus")
      .select("task_id, slug, claude_session_id")
      .not("claude_session_id", "is", null)
      .limit(200);

    let sum = 0;
    let any = false;
    for (const r of rows ?? []) {
      if (!r.slug || !r.claude_session_id) continue;
      const b = burnOf(join(workspace, r.slug), r.claude_session_id);
      if (!b) continue; // no transcript on this machine — cannot know, so do not guess
      tasksWithTranscript += 1;
      if (b.costPartial) burnPartial = true;
      if (b.costUsd !== null) {
        sum += b.costUsd;
        any = true;
      }
    }
    if (any || tasksWithTranscript > 0) totalBurnUsd = Number(sum.toFixed(4));
  } catch {
    totalBurnUsd = null; // the DB being down must not take the meters down with it
  }

  return NextResponse.json({
    pid: worker?.pid ?? null,
    at: worker?.at ?? null,
    claude: worker?.claude ?? null,
    gates: worker?.gates ?? null,
    tasksInFlight: worker?.tasksInFlight ?? null,
    maxParallel: worker?.maxParallel ?? null,
    stale,
    ageSec: ageMs === null ? null : Math.round(ageMs / 1000),
    staleAfterSec: STALE_AFTER_MS / 1000,
    totalBurnUsd,
    burnPartial,
    tasksWithTranscript,
    ...(note ? { note } : {}),
  });
}
