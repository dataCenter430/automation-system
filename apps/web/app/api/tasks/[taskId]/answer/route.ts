/**
 * Answer the question a build is blocked on.
 *
 * The other end of ask.ts. A Claude session somewhere is parked inside an `ask_human` tool
 * call, polling `.pipeline/answer.json` every 1.5s; this writes that file, and the build
 * resumes with the answer in its conversation as an ordinary tool result.
 *
 * The `id` in the body is not ceremony. The dashboard polls every 3 seconds, so it is
 * genuinely possible to click an option for a question that timed out a moment ago — and
 * applying a stale answer to whatever question came next would be worse than dropping it.
 * writeAnswer() refuses unless the id still matches the pending question, and this route
 * reports that refusal (409) rather than pretending the click worked.
 *
 * There is no auth here, and none anywhere else in this dashboard: it binds to localhost and
 * the machine has one user. Worth saying out loud rather than leaving as an assumption.
 */
import { NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { db } from "../../../../../../../packages/shared/src/supabase.ts";
import { REPO_ROOT, expandPath } from "../../../../../../../packages/shared/src/paths.ts";
import { readQuestion, writeAnswer } from "../../../../../../worker/src/claude/ask.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function workspaceRoot(): string {
  try {
    const cfg = JSON.parse(readFileSync(resolve(REPO_ROOT, "config/pipeline.json"), "utf8"));
    return expandPath(cfg.paths.workspace);
  } catch {
    return resolve(REPO_ROOT, "workspace");
  }
}

/** The workspace for a task, or null if it has not been given a slug yet. */
async function workspaceOf(taskId: string): Promise<string | null> {
  const { data, error } = await db()
    .from("terminus")
    .select("slug")
    .eq("task_id", taskId)
    .single();
  if (error || !data?.slug) return null;
  return join(workspaceRoot(), data.slug);
}

/** The pending question, if the build is currently blocked on one. */
export async function GET(_req: Request, ctx: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await ctx.params;
  const ws = await workspaceOf(taskId);
  if (!ws) return NextResponse.json({ error: "task not found" }, { status: 404 });
  return NextResponse.json({ question: readQuestion(ws) });
}

export async function POST(req: Request, ctx: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await ctx.params;

  let body: { id?: unknown; answer?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }

  const id = typeof body.id === "string" ? body.id : "";
  const answer = typeof body.answer === "string" ? body.answer : "";
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  if (!answer.trim()) return NextResponse.json({ error: "an empty answer is not an answer" }, { status: 400 });

  const ws = await workspaceOf(taskId);
  if (!ws) return NextResponse.json({ error: "task not found" }, { status: 404 });

  const r = writeAnswer(ws, id, answer);
  if (!r.ok) {
    // 409, not 400: the request was well-formed, the world moved. The UI says so, and
    // re-renders whatever is actually being asked now (probably nothing).
    return NextResponse.json({ error: r.error }, { status: 409 });
  }
  return NextResponse.json({ ok: true });
}
