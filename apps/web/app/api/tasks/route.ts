import { NextResponse } from "next/server";
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { db } from "../../../../../packages/shared/src/supabase.ts";
import { PipelineState, TaskStatus } from "../../../../../packages/shared/src/status.ts";
import { REPO_ROOT, expandPath } from "../../../../../packages/shared/src/paths.ts";
import { assertValidSlug } from "../../../../../packages/shared/src/slug.ts";
import { toTaskToml } from "../../../../../packages/shared/src/taxonomy.ts";

export const runtime = "nodejs"; // reads config/owners.json off disk

/**
 * Who owns the tasks we submit (Hercules / Mickey / Pug). Managed from /settings rather
 * than an env var, so changing it doesn't mean restarting anything.
 */
function activeOwner(): string | null {
  try {
    const cfg = JSON.parse(readFileSync(resolve(REPO_ROOT, "config/owners.json"), "utf8"));
    return typeof cfg.activeOwner === "string" ? cfg.activeOwner : null;
  } catch {
    return null;
  }
}

function workspaceRoot(): string {
  try {
    const cfg = JSON.parse(readFileSync(resolve(REPO_ROOT, "config/pipeline.json"), "utf8"));
    return expandPath(cfg.paths.workspace);
  } catch {
    return resolve(REPO_ROOT, "workspace");
  }
}

// ---------------------------------------------------------------------------------------
// PER-TASK MODEL / COST / TOOL CALLS, DERIVED FROM THE SESSION TRANSCRIPT
//
// (Deliberately identical to the block in app/api/fleet/route.ts. Both routes need it and
// neither may import from the other — a Next route module may only export its handlers, so
// there is nowhere shared to put it without touching a file this change does not own.)
//
// The Agent SDK writes the complete transcript of every session to
// ~/.claude/projects/<cwd, non-alphanumerics as '-'>/<session-id>.jsonl — the same encoding
// [taskId]/session/route.ts uses. That file is the ONLY place the per-task model, cost and
// tool-call count exist; the pipeline never recorded any of them. Four things about it are
// traps, and each one silently yields a confident, wrong number:
//
//  1. There are NO `result` lines. The SDK's result message — the one carrying
//     total_cost_usd — is a STREAM message; the CLI never persists it. (This is why the
//     session route's `costUsd` reads 0.00 on every real build.) Cost must be derived from
//     per-message `usage` and a price table.
//
//  2. ONE API response is split across SEVERAL jsonl lines — one per content block (text,
//     then tool_use). The input-side usage (input_tokens, cache_creation, cache_read) is
//     REPEATED VERBATIM on every line of the same message.id. Summing per line overcounts:
//     29.1M cache-read tokens instead of 17.1M (+70%) on the live transcript.
//
//  3. But output_tokens is NOT repeated — it is a running value that only reaches its final
//     figure on the LAST line of a message (the first carries a placeholder 1). Taking the
//     first line per id undercounts output by 91% (7,993 instead of 89,706).
//
//     => Group by message.id, keep the LAST usage per id, then sum. Both halves matter.
//
//  4. One session can span SEVERAL models — the live transcript holds both claude-opus-4-5
//     and claude-opus-4-8, because the pin in config/pipeline.json changed under a running
//     build. Cost is priced per model, never at one blended rate.
//
// `costUsd` is an API-list-price EQUIVALENT, not money charged: these builds authenticate as
// the logged-in Claude Code CLI (a subscription), so there is no per-token bill. It is what
// the same work would have cost on the API — the number you want when judging whether a
// build was worth its retries.
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
 * KEEP IT CHEAP — the dashboard polls this route every 3 seconds.
 *
 * A build transcript is megabytes (2.5 MB and growing on the live one) and there can be
 * eight of them. So parse INCREMENTALLY: the jsonl is append-only, so remember the byte
 * offset and read only what was appended since last poll. An unchanged file costs a single
 * statSync(). The partial trailing line is carried over as BYTES, not text, so a multi-byte
 * character split across a read boundary is never corrupted.
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

  // Tool calls: content blocks are disjoint across the lines of one message, so counting
  // every tool_use block over every line is correct — no dedupe needed here.
  if (Array.isArray(msg.content)) {
    for (const b of msg.content) if (b?.type === "tool_use") e.toolCalls += 1;
  }

  if (m.type !== "assistant") return;
  const model = typeof msg.model === "string" ? msg.model : null;
  if (model) e.lastModel = model; // the model that ACTUALLY answered most recently
  const id = typeof msg.id === "string" ? msg.id : null;
  const u = msg.usage;
  if (!id || !u) return;

  // LAST line per message.id wins — see traps (2) and (3) above.
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
    // Truncated or replaced (a transcript copied in from another machine): start over.
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

/** The queue, newest first, with the last few events per task for the live feed. */
export async function GET() {
  const { data: tasks, error } = await db()
    .from("terminus")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const ids = (tasks ?? []).map((t) => t.task_id);
  const { data: events } = ids.length
    ? await db()
        .from("pipeline_events")
        .select("*")
        .in("task_id", ids)
        .order("created_at", { ascending: false })
        .limit(400)
    : { data: [] };

  // Each task carries what its Claude session actually cost: the model that really answered,
  // the tool calls it made, and the API-equivalent burn. All of it comes from the transcript
  // on disk (see the block above). A task with no session, or whose transcript belongs to
  // another machine, reports nulls — never a zero, and never a crash.
  const ws = workspaceRoot();
  const enriched = (tasks ?? []).map((t) => {
    const b =
      t.slug && t.claude_session_id ? burnOf(join(ws, t.slug), t.claude_session_id) : null;
    return {
      ...t,
      model: b?.model ?? null,
      models: b?.models ?? [],
      toolCalls: b?.toolCalls ?? null,
      costUsd: b?.costUsd ?? null,
      costPartial: b?.costPartial ?? false,
      tokens: b?.tokens ?? null,
    };
  });

  return NextResponse.json({ tasks: enriched, events: events ?? [] });
}

/**
 * Add a task to the queue.
 *
 * It lands at DRAFT and is INERT. The worker will not touch it, no matter how long it
 * sits there. Only the human's "Start Build" click moves it to QUEUED. That is the
 * whole point of the gate: nothing spends a Claude session until you say so.
 */
export async function POST(req: Request) {
  const body = (await req.json()) as {
    task_id?: string;
    slug?: string;
    parsed?: {
      category: string; sub_category: string; title: string;
      description: string; languages: string; additional_note: string | null;
    };
  };

  if (!body.task_id || !/^[0-9a-f-]{36}$/i.test(body.task_id)) {
    return NextResponse.json({ error: "A valid task_id (uuid) is required." }, { status: 400 });
  }
  if (!body.parsed || !body.slug) {
    return NextResponse.json({ error: "Parse the task text before adding it." }, { status: 400 });
  }

  // ---- The slug is a primary key in everything except the database ---------
  //
  // The slug names the workspace, the Claude session that lives in it, runs/<slug>/,
  // Working/<slug>.zip and the docker image. Two tasks sharing one is not a cosmetic clash:
  // the second task would resume the first one's Claude conversation, or skip its build and
  // ship the first one's task tree under its own name. The worker now refuses to proceed in
  // that situation, but refusing at the door is better than parking a task at NEEDS_HUMAN
  // after the human has already pressed Start Build.
  //
  // assertValidSlug() has existed in packages/shared since the beginning and was called from
  // nowhere. The slug field in the dashboard is free text.
  try {
    assertValidSlug(body.slug);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  const { data: clash } = await db()
    .from("terminus")
    .select("task_id, title")
    .eq("slug", body.slug)
    .maybeSingle();

  if (clash) {
    return NextResponse.json(
      {
        error:
          `The slug "${body.slug}" is already taken by task ${String(clash.task_id).slice(0, 8)} ` +
          `("${clash.title}").\n\n` +
          `The slug is the workspace name, the zip name and the Claude session's home — two ` +
          `tasks cannot share one. Edit the slug and try again.`,
      },
      { status: 409 },
    );
  }

  // The taxonomy is re-checked SERVER-side, not just in the browser preview. The preview's
  // Start Build button is disabled on a blocked category, but a stale tab or a plain curl
  // bypasses that entirely — and the next thing to catch it would be build.ts, by which time
  // a Claude study turn has already been paid for.
  try {
    toTaskToml(body.parsed);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 422 });
  }

  const owner = activeOwner();
  if (!owner) {
    return NextResponse.json(
      { error: "No active task owner is set. Pick one at /settings before adding tasks." },
      { status: 409 },
    );
  }

  const { error } = await db().from("terminus").insert({
    task_id: body.task_id,
    slug: body.slug,
    ...body.parsed,
    task_status: TaskStatus.WORKING_ON,
    payment_status: 0,
    pipeline_state: PipelineState.DRAFT, // inert until you press Start Build
    task_owner: owner,
  });

  if (error) {
    const dup = error.message.includes("duplicate") || error.code === "23505";
    return NextResponse.json(
      { error: dup ? "That task_id is already in the queue." : error.message },
      { status: dup ? 409 : 500 },
    );
  }
  return NextResponse.json({ ok: true });
}
