import { NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { db } from "../../../../../packages/shared/src/supabase.ts";
import { PipelineState, TaskStatus } from "../../../../../packages/shared/src/status.ts";
import { REPO_ROOT } from "../../../../../packages/shared/src/paths.ts";
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
