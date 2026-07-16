/**
 * Hourly Snorkel reconciliation — mapping submission statuses onto local transitions.
 *
 * The rule the operator cares about most: a submission that comes back NEEDS_REVISION hands the
 * local task into the revise lap. Everything here is the pure planner; the driver is exercised with
 * injected fakes at the bottom.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { planReconcile, reconcile, WAITING_ON_SNORKEL, type ReconcileTask } from "../../../apps/worker/src/stb/reconcile.ts";
import { PipelineState as S } from "../../../packages/shared/src/status.ts";
import type { SubmissionRow } from "../../../apps/worker/src/stb/cli.ts";

const row = (id: string, status: SubmissionRow["status"], folder?: string): SubmissionRow =>
  ({ id, status, folder, raw: "" });

const task = (over: Partial<ReconcileTask> = {}): ReconcileTask => ({
  taskId: "t1", slug: "my-task", submissionId: "sub-1", pipelineState: S.SUBMITTED, ...over,
});

// ------------------------------------------------------------------- the core rule

test("NEEDS_REVISION on a SUBMITTED task → enters the revise lap (REVISE_PENDING)", () => {
  const actions = planReconcile([row("sub-1", "NEEDS_REVISION")], [task()]);
  assert.equal(actions.length, 1);
  assert.equal(actions[0]!.to, S.REVISE_PENDING);
  assert.match(actions[0]!.reason, /NEEDS_REVISION/);
});

test("NEEDS_REVISION on a task a HUMAN REVIEWER already had (SENT_TO_REVIEWER) also revises", () => {
  // A reviewer can bounce a task back; SENT_TO_REVIEWER is otherwise terminal, so this is the only
  // thing that re-opens it.
  const actions = planReconcile([row("sub-1", "NEEDS_REVISION")], [task({ pipelineState: S.SENT_TO_REVIEWER })]);
  assert.equal(actions[0]?.to, S.REVISE_PENDING);
});

// ------------------------------------------------------------------- the waiting-state guard

test("a task that is still BUILDING is NOT touched, whatever Snorkel says", () => {
  const actions = planReconcile([row("sub-1", "NEEDS_REVISION")], [task({ pipelineState: S.BUILD_RUNNING })]);
  assert.deepEqual(actions, []);
});

test("a task already IN the revise lap is not re-triggered", () => {
  assert.deepEqual(planReconcile([row("sub-1", "NEEDS_REVISION")], [task({ pipelineState: S.REVISE_RUNNING })]), []);
});

// ------------------------------------------------------------------- matching

test("matches by stored submission id first", () => {
  const actions = planReconcile([row("sub-1", "NEEDS_REVISION")], [task({ submissionId: "sub-1", slug: "x" })]);
  assert.equal(actions.length, 1);
});

test("falls back to folder name (= slug) when there is no stored id", () => {
  const actions = planReconcile(
    [row("sub-999", "NEEDS_REVISION", "my-task")],
    [task({ submissionId: null, slug: "my-task" })],
  );
  assert.equal(actions.length, 1);
  assert.equal(actions[0]!.submissionId, "sub-999");
});

test("a submission with NO matching local task is ignored (submitted elsewhere)", () => {
  assert.deepEqual(planReconcile([row("sub-x", "NEEDS_REVISION", "someone-elses-task")], [task()]), []);
});

// ------------------------------------------------------------------- the other statuses

test("EVALUATION_PENDING is a no-op — Snorkel is still working", () => {
  assert.deepEqual(planReconcile([row("sub-1", "EVALUATION_PENDING")], [task()]), []);
});

test("REVIEW_PENDING records that a human reviewer now has it", () => {
  const actions = planReconcile([row("sub-1", "REVIEW_PENDING")], [task({ pipelineState: S.SUBMITTED })]);
  assert.equal(actions[0]?.to, S.SENT_TO_REVIEWER);
  assert.equal(actions[0]?.taskStatus, "HUMAN_REVIEW");
});

test("ACCEPTED moves the task to the terminal ACCEPTED state — where its recipe is recorded", () => {
  const actions = planReconcile([row("sub-1", "ACCEPTED")], [task({ pipelineState: S.SENT_TO_REVIEWER })]);
  assert.equal(actions[0]?.to, S.ACCEPTED);
  assert.equal(actions[0]?.taskStatus, "ACCEPTED");
});

test("an already-ACCEPTED task is never re-processed", () => {
  // ACCEPTED (110) is terminal and not in WAITING_ON_SNORKEL, so it is not even fetched — and even
  // if it were, the planner does not re-fire it. The recipe is recorded exactly once.
  assert.deepEqual(planReconcile([row("sub-1", "ACCEPTED")], [task({ pipelineState: S.ACCEPTED })]), []);
});

test("REJECTED / SKIPPED go to NEEDS_HUMAN — never a silent auto-retry", () => {
  for (const st of ["REJECTED", "SKIPPED"] as const) {
    const actions = planReconcile([row("sub-1", st)], [task({ pipelineState: S.SUBMITTED })]);
    assert.equal(actions[0]?.to, S.NEEDS_HUMAN, `${st} → NEEDS_HUMAN`);
    assert.equal(actions[0]?.taskStatus, st);
  }
});

// ------------------------------------------------------------------- the driver

test("reconcile skips the CLI entirely when nothing is waiting on Snorkel", async () => {
  let listed = false;
  const applied: string[] = [];
  const actions = await reconcile({
    waitingTasks: async () => [],
    list: async () => { listed = true; return []; },
    apply: async (a) => { applied.push(a.slug); },
    log: () => {},
  });
  assert.equal(listed, false, "must not list submissions when the fleet is idle");
  assert.deepEqual(actions, []);
});

test("reconcile lists, plans, and applies each action", async () => {
  const applied: number[] = [];
  const actions = await reconcile({
    waitingTasks: async () => [task({ taskId: "a", slug: "task-a", submissionId: "s-a", pipelineState: S.SUBMITTED })],
    list: async () => [row("s-a", "NEEDS_REVISION")],
    apply: async (a) => { applied.push(a.to); },
    log: () => {},
  });
  assert.equal(actions.length, 1);
  assert.deepEqual(applied, [S.REVISE_PENDING]);
});

test("reconcile: one failing apply does not stop the others", async () => {
  const applied: string[] = [];
  const actions = await reconcile({
    waitingTasks: async () => [
      task({ taskId: "a", slug: "task-a", submissionId: "s-a", pipelineState: S.SUBMITTED }),
      task({ taskId: "b", slug: "task-b", submissionId: "s-b", pipelineState: S.SUBMITTED }),
    ],
    list: async () => [row("s-a", "NEEDS_REVISION"), row("s-b", "NEEDS_REVISION")],
    apply: async (a) => { if (a.slug === "task-a") throw new Error("boom"); applied.push(a.slug); },
    log: () => {},
  });
  assert.equal(actions.length, 2);
  assert.deepEqual(applied, ["task-b"], "task-b still applied after task-a threw");
});
