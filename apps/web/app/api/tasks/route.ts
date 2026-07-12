import { NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { db } from "../../../../../packages/shared/src/supabase.ts";
import { PipelineState, TaskStatus } from "../../../../../packages/shared/src/status.ts";
import { REPO_ROOT } from "../../../../../packages/shared/src/paths.ts";

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

  return NextResponse.json({ tasks: tasks ?? [], events: events ?? [] });
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
