/**
 * SNORKEL RECONCILIATION — pull the platform's verdict back into our pipeline, hourly.
 *
 * Once a task is submitted, Snorkel owns it for a while: automated checks run, a rubric is
 * generated, a human reviewer reads it. NONE of that pushes to us — we have to ask. So every hour
 * the worker runs one `stb submissions list` and maps each submission's status onto the matching
 * local task. The one that matters most, and the reason the operator asked for this: a submission
 * that comes back `NEEDS_REVISION` is handed straight into the revise lap — fetch the feedback, fix
 * the issue, re-gate, re-submit — without anyone watching a queue.
 *
 * This REPLACES the old per-task DOM polling (findInReviseQueue, which scraped the home page for
 * every SUBMITTED task on every tick and never once ran). One list call covers the whole fleet, on
 * a gentle cadence that is easy on the account.
 *
 * The mapping is a PURE function (planReconcile) so every status→transition rule is unit-tested with
 * no CLI and no network. The driver applies the plan through injected callbacks.
 */
import { PipelineState as S } from "../../../../packages/shared/src/status.ts";
import type { SubmissionRow, SubmissionStatus } from "./cli.ts";

/**
 * States where a task is WAITING ON SNORKEL's verdict — the only ones the reconciler may move.
 *
 * A task that is still building, gating, or parked awaiting a human APPROVAL is not waiting on
 * Snorkel and must not be touched. SENT_TO_REVIEWER is included even though it is otherwise terminal:
 * a human reviewer can send a task back, and NEEDS_REVISION on a reviewed task is exactly that.
 */
export const WAITING_ON_SNORKEL: readonly number[] = [
  S.CHECKING_FEEDBACK, // 65 — pass-1 CI is running
  S.SUBMITTED,         // 90 — pass 1 landed, awaiting the rubric/CI result
  S.SENT_TO_REVIEWER,  // 100 — a human reviewer has it (they may bounce it back)
];

/** The local view the reconciler needs for one task. */
export interface ReconcileTask {
  taskId: string;
  slug: string;
  /** Stored when we created/updated the submission; the strongest match key. */
  submissionId: string | null;
  pipelineState: number;
  /** Snorkel's own task_status, so we don't re-announce an ACCEPTED that is already recorded. */
  taskStatus?: string | null;
}

/** One thing to do, resolved to a concrete local transition. */
export interface ReconcileAction {
  taskId: string;
  slug: string;
  submissionId: string;
  status: SubmissionStatus;
  /** Target pipeline state. */
  to: number;
  /** Optional task_status to record (ACCEPTED / REJECTED / SKIPPED). */
  taskStatus?: string;
  reason: string;
}

/**
 * Match a submission to a local task. Prefer the stored submission id (exact); fall back to the
 * folder name from `--show-folder-names`, which equals our slug.
 */
function matchTask(
  row: SubmissionRow,
  byId: Map<string, ReconcileTask>,
  bySlug: Map<string, ReconcileTask>,
): ReconcileTask | undefined {
  return byId.get(row.id) ?? (row.folder ? bySlug.get(row.folder) : undefined);
}

/**
 * Given Snorkel's submission list and our local tasks, compute the transitions to apply. PURE.
 *
 * Only tasks currently WAITING_ON_SNORKEL are eligible — a submission whose local task is mid-build
 * or already revising is left alone. A submission with no matching local task (submitted from another
 * machine, or a different project) is ignored.
 */
export function planReconcile(rows: SubmissionRow[], tasks: ReconcileTask[]): ReconcileAction[] {
  const byId = new Map(tasks.filter((t) => t.submissionId).map((t) => [t.submissionId!, t]));
  const bySlug = new Map(tasks.map((t) => [t.slug, t]));
  const actions: ReconcileAction[] = [];

  for (const row of rows) {
    const task = matchTask(row, byId, bySlug);
    if (!task) continue;
    if (!WAITING_ON_SNORKEL.includes(task.pipelineState)) continue; // not ours to move right now

    const base = { taskId: task.taskId, slug: task.slug, submissionId: row.id, status: row.status };

    switch (row.status) {
      case "NEEDS_REVISION":
        // THE ONE THE OPERATOR ASKED FOR. Hand it into the revise lap; the worker drives the rest.
        actions.push({ ...base, to: S.REVISE_PENDING, reason: "Snorkel returned NEEDS_REVISION — entering the revise lap" });
        break;

      case "REVIEW_PENDING":
        // With a human reviewer now. Record that, unless we already have.
        if (task.pipelineState !== S.SENT_TO_REVIEWER) {
          actions.push({ ...base, to: S.SENT_TO_REVIEWER, taskStatus: "HUMAN_REVIEW", reason: "now with a human reviewer" });
        }
        break;

      case "ACCEPTED":
      case "OFFERED":
        // A win. No further pipeline work; just record the outcome once.
        if (task.taskStatus !== row.status) {
          actions.push({ ...base, to: task.pipelineState, taskStatus: row.status, reason: `Snorkel ${row.status} — accepted` });
        }
        break;

      case "REJECTED":
      case "SKIPPED":
        // Terminal on Snorkel's side. Stop and show a human — do not silently retry a rejected task.
        actions.push({ ...base, to: S.NEEDS_HUMAN, taskStatus: row.status, reason: `Snorkel ${row.status} — a human should decide` });
        break;

      case "EVALUATION_PENDING":
        break; // still processing; nothing to do
    }
  }
  return actions;
}

/** Everything the driver needs, injected so the whole thing is testable without a real stb/DB. */
export interface ReconcileDeps {
  /** `stb submissions list --show-folder-names`. */
  list: () => Promise<SubmissionRow[]>;
  /** The local tasks currently waiting on Snorkel. */
  waitingTasks: () => Promise<ReconcileTask[]>;
  /** Apply one action: move the task, record the submission id + status, and drive it. */
  apply: (a: ReconcileAction) => Promise<void>;
  log: (msg: string) => void;
}

/**
 * Run one reconciliation pass. Returns the actions applied (for the log/tests).
 *
 * Skips the list call entirely when nothing local is waiting — an idle fleet must not poke the CLI.
 */
export async function reconcile(deps: ReconcileDeps): Promise<ReconcileAction[]> {
  const tasks = await deps.waitingTasks();
  if (tasks.length === 0) return []; // nothing is waiting on Snorkel; don't even list

  const rows = await deps.list();
  const actions = planReconcile(rows, tasks);

  for (const a of actions) {
    try {
      await deps.apply(a);
      deps.log(`↩ ${a.slug}: ${a.status} → ${a.reason}`);
    } catch (e) {
      deps.log(`⚠ reconcile could not apply ${a.slug} (${a.status}): ${(e as Error).message}`);
    }
  }
  if (actions.length === 0) {
    deps.log(`reconcile: ${tasks.length} task(s) still waiting on Snorkel, no change`);
  }
  return actions;
}
