/**
 * The human gates. These are the ONLY two writes in the system that a person makes.
 *
 *   start   DRAFT (0)             → QUEUED (5)              "Start Build"
 *   approve AWAITING_APPROVAL(70) → SUBMITTING (80)         "Approve & Submit"  ← irreversible
 *   retry   FAILED/NEEDS_HUMAN    → back to the last clean state
 *
 * Every one of them is guarded by the state it expects, so a stale browser tab clicking
 * a button twice can't do anything unexpected.
 */
import { NextResponse } from "next/server";
import { db } from "../../../../../../packages/shared/src/supabase.ts";
import { PipelineState as S } from "../../../../../../packages/shared/src/status.ts";

type Action = "start" | "approve" | "retry" | "cancel";

/**
 * Where a failed task should resume from.
 *
 * A FAILED row no longer remembers where it died — pipeline_state is just -1. So we ask
 * the event log: the failing transition recorded its `from_state`. Without this, a task
 * that failed at the upload stage would restart from the top and burn a whole Docker cycle
 * re-proving a build that had already passed.
 *
 * Anything that died before the zip goes back to BUILD_RUNNING. That looks wasteful but
 * isn't: the BUILD_RUNNING handler checks the manifest on disk first and jumps straight to
 * BUILT if the task is already complete, without spending a Claude turn. And if it ISN'T
 * complete, we genuinely do need Claude to finish it. Either way the session id is kept, so
 * the retry resumes with full context rather than starting over.
 */
async function retryTarget(taskId: string): Promise<number> {
  const { data } = await db()
    .from("pipeline_events")
    .select("from_state")
    .eq("task_id", taskId)
    .in("to_state", [S.FAILED, S.NEEDS_HUMAN])
    .order("created_at", { ascending: false })
    .limit(1);

  const diedIn = data?.[0]?.from_state as number | undefined;
  if (diedIn === undefined || diedIn === null) return S.QUEUED;

  if (diedIn >= S.BUILD_RUNNING && diedIn <= S.FIX_RUNNING) return S.BUILD_RUNNING;
  // Past the zip, the task already passed the local gate → the problem is upload/feedback.
  if (diedIn >= S.ZIPPED && diedIn <= S.SUBMITTING) return S.UPLOADING;
  return S.QUEUED;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const { taskId } = await params;
  const { action } = (await req.json()) as { action: Action };

  const { data: row, error: e1 } = await db()
    .from("terminus").select("*").eq("task_id", taskId).maybeSingle();
  if (e1) return NextResponse.json({ error: e1.message }, { status: 500 });
  if (!row) return NextResponse.json({ error: "No such task." }, { status: 404 });

  const cur = row.pipeline_state as number;
  let patch: Record<string, unknown>;
  let expect: number;
  let message: string;

  switch (action) {
    case "start":
      if (cur !== S.DRAFT) {
        return NextResponse.json(
          { error: `This task is not a draft (it's at state ${cur}). Nothing to start.` },
          { status: 409 },
        );
      }
      expect = S.DRAFT;
      patch = { pipeline_state: S.QUEUED, last_error: null };
      message = "queued for build";
      break;

    case "approve":
      // The only irreversible click in the system, and it belongs to the human.
      if (cur !== S.AWAITING_APPROVAL) {
        return NextResponse.json(
          { error: `This task is not waiting for approval (it's at state ${cur}).` },
          { status: 409 },
        );
      }
      expect = S.AWAITING_APPROVAL;
      patch = { pipeline_state: S.SUBMITTING };
      message = "approved — submitting";
      break;

    case "retry":
      if (cur !== S.FAILED && cur !== S.NEEDS_HUMAN) {
        return NextResponse.json({ error: "Only a failed task can be retried." }, { status: 409 });
      }
      expect = cur;
      // Keep claude_session_id: the retry resumes the same session and keeps its context.
      patch = { pipeline_state: await retryTarget(taskId), last_error: null, attempt: 0 };
      message = "retrying";
      break;

    case "cancel":
      expect = cur;
      patch = { pipeline_state: S.FAILED, last_error: "Cancelled by user." };
      message = "cancelled";
      break;

    default:
      return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  }

  // Guarded write: if the worker moved the row since this page loaded, we lose the race
  // and do nothing rather than stomping on a live transition.
  const { data: updated, error: e2 } = await db()
    .from("terminus").update(patch)
    .eq("task_id", taskId).eq("pipeline_state", expect)
    .select();
  if (e2) return NextResponse.json({ error: e2.message }, { status: 500 });
  if (!updated?.length) {
    return NextResponse.json(
      { error: "The task moved while you were looking at it. Refresh and try again." },
      { status: 409 },
    );
  }

  await db().from("pipeline_events").insert({
    task_id: taskId,
    stage: action === "approve" ? "submit" : "parse",
    status: "started",
    from_state: cur,
    to_state: patch.pipeline_state as number,
    message: `${message} (by human)`,
  });

  return NextResponse.json({ ok: true, state: patch.pipeline_state });
}
