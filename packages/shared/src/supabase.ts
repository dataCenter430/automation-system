import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { TerminusRow, EventStage, EventStatus, TerminusImplementationRow } from "./types.ts";
import { PipelineState } from "./status.ts";
import { REPO_ROOT } from "./paths.ts";

let client: SupabaseClient | null = null;
let envLoaded = false;

/**
 * Load the repo-root .env if the vars aren't already present.
 *
 * Next.js only reads .env from its own app directory (apps/web), not from the repo root,
 * so the API routes would otherwise start up with no credentials and 500 on every request.
 * The worker loads it via `dotenv/config`; this makes both paths behave the same and keeps
 * a single .env as the source of truth.
 */
function ensureEnv(): void {
  if (envLoaded) return;
  envLoaded = true;
  if (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL) return;

  const envPath = resolve(REPO_ROOT, ".env");
  if (!existsSync(envPath)) return;

  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1]!;
    const value = m[2]!.trim().replace(/^["']|["']$/g, "");
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/**
 * Server-side client. Uses the SECRET key (new-style `sb_secret_…`), falling back to the
 * legacy `service_role` JWT so an older .env keeps working. Never ship either to a browser.
 */
export function db(): SupabaseClient {
  if (client) return client;
  ensureEnv();
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL / SUPABASE_SECRET_KEY are not set. Copy .env.example to .env and fill it in.",
    );
  }
  client = createClient(url, key, { auth: { persistSession: false } });
  return client;
}

/**
 * Atomically take ONE queued task.
 *
 * The `.eq("pipeline_state", QUEUED)` in the update is the lock: two workers racing for
 * the same row means exactly one of them matches and the other gets zero rows back.
 * DRAFT rows are deliberately unreachable from here — only the human's "Start Build"
 * click moves a row to QUEUED.
 */
export async function claimNextTask(): Promise<TerminusRow | null> {
  const { data: candidates, error: e1 } = await db()
    .from("terminus")
    .select("*")
    .eq("pipeline_state", PipelineState.QUEUED)
    .order("created_at", { ascending: true })
    .limit(1);
  if (e1) throw new Error(`claim: ${e1.message}`);
  if (!candidates?.length) return null;

  const row = candidates[0] as TerminusRow;
  const { data: claimed, error: e2 } = await db()
    .from("terminus")
    .update({ pipeline_state: PipelineState.BUILD_RUNNING })
    .eq("task_id", row.task_id)
    .eq("pipeline_state", PipelineState.QUEUED) // lost the race -> 0 rows
    .select();
  if (e2) throw new Error(`claim: ${e2.message}`);
  if (!claimed?.length) return null;

  return claimed[0] as TerminusRow;
}

/** Rows a previous worker was mid-stage on when it died. */
export async function findInterrupted(states: readonly number[]): Promise<TerminusRow[]> {
  const { data, error } = await db()
    .from("terminus")
    .select("*")
    .in("pipeline_state", states as number[])
    .order("updated_at", { ascending: true });
  if (error) throw new Error(`sweep: ${error.message}`);
  return (data ?? []) as TerminusRow[];
}

export async function getTask(taskId: string): Promise<TerminusRow | null> {
  const { data, error } = await db().from("terminus").select("*").eq("task_id", taskId).maybeSingle();
  if (error) throw new Error(`getTask: ${error.message}`);
  return (data as TerminusRow) ?? null;
}

export async function patchTask(taskId: string, patch: Partial<TerminusRow>): Promise<void> {
  const { error } = await db().from("terminus").update(patch).eq("task_id", taskId);
  if (error) throw new Error(`patchTask: ${error.message}`);
}

export async function upsertImplementation(
  taskId: string,
  patch: {
    implementation_summary?: string;
    difficulty_explanation?: string;
    solution_explanation?: string;
    verification_explanation?: string;
    accepted?: boolean;
    accepted_at?: string;
    category?: string;
    sub_category?: string;
    languages?: string;
    title?: string;
    slug?: string;
  },
): Promise<void> {
  const { error } = await db()
    .from("terminus_implementation")
    .upsert({ task_id: taskId, ...patch }, { onConflict: "task_id" });
  if (error) throw new Error(`upsertImplementation: ${error.message}`);
}

/**
 * The three explanations already persisted for a task, so an accept whose WORKSPACE is gone can
 * still assemble a recipe from the durable DB columns (the explain stage wrote them at build time).
 * Returns null when there is no row, or the row has no explanations.
 */
export async function getStoredExplanations(
  taskId: string,
): Promise<{ difficulty: string; solution: string; verification: string } | null> {
  const { data, error } = await db()
    .from("terminus_implementation")
    .select("difficulty_explanation, solution_explanation, verification_explanation")
    .eq("task_id", taskId)
    .maybeSingle();
  if (error) throw new Error(`getStoredExplanations: ${error.message}`);
  if (!data) return null;
  const d = data.difficulty_explanation, s = data.solution_explanation, v = data.verification_explanation;
  if (!d && !s && !v) return null;
  return { difficulty: d ?? "", solution: s ?? "", verification: v ?? "" };
}

/**
 * Accepted implementations of SIMILAR tasks — the reference library a new build learns from.
 *
 * "Similar" is, for v1, the same category, most-recently-accepted first. Category is the strongest
 * cheap signal (it is what the classifier gates on, so a same-category accepted task shares the
 * deliverable/grading shape a new one needs). Only rows with a real summary are returned, and the
 * task being built is excluded so it never cites itself on a re-run.
 */
export async function findAcceptedImplementations(opts: {
  category: string;
  excludeTaskId?: string;
  limit?: number;
}): Promise<TerminusImplementationRow[]> {
  let q = db()
    .from("terminus_implementation")
    .select("*")
    .eq("accepted", true)
    .eq("category", opts.category)
    .not("implementation_summary", "is", null)
    .order("accepted_at", { ascending: false })
    .limit(opts.limit ?? 3);
  if (opts.excludeTaskId) q = q.neq("task_id", opts.excludeTaskId);

  const { data, error } = await q;
  if (error) throw new Error(`findAcceptedImplementations: ${error.message}`);
  return (data ?? []) as TerminusImplementationRow[];
}

/**
 * Append to the progress log.
 *
 * Never throws: losing an event must not kill a running build. A dropped log line is
 * annoying; a build that dies because its logger hiccuped is expensive.
 */
export async function emitEvent(ev: {
  task_id: string;
  stage: EventStage;
  status: EventStatus;
  from_state?: number | null;
  to_state?: number | null;
  attempt?: number;
  detail?: Record<string, unknown> | null;
  message?: string | null;
}): Promise<void> {
  try {
    const { error } = await db().from("pipeline_events").insert({
      task_id: ev.task_id,
      stage: ev.stage,
      status: ev.status,
      from_state: ev.from_state ?? null,
      to_state: ev.to_state ?? null,
      attempt: ev.attempt ?? 0,
      detail: ev.detail ?? null,
      message: ev.message ?? null,
    });
    if (error) console.warn(`[events] insert failed: ${error.message}`);
  } catch (e) {
    console.warn(`[events] insert threw: ${(e as Error).message}`);
  }
}
