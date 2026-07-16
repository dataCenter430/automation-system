/**
 * The deadline that keeps the worker alive.
 *
 * The case that matters is the FIRST one: a promise that never settles at all. That is what
 * a Supabase fetch became when the VM's NIC dropped mid-poll on 2026-07-13, and it is the
 * only failure mode a try/catch is helpless against — there is nothing to catch, and control
 * never comes back. The worker wedged, its heartbeat froze, and when the last live handle
 * closed the event loop drained and the process exited silently with code 0.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { Timeout, withDeadline } from "../../../apps/worker/src/util/deadline.ts";

test("a promise that NEVER settles rejects at the deadline — this is the whole point", async () => {
  const neverSettles = new Promise<string>(() => { /* the dropped socket */ });

  const started = Date.now();
  await assert.rejects(
    () => withDeadline(neverSettles, 60, "findInterrupted"),
    (e: Error) => e instanceof Timeout && /findInterrupted did not answer within 0\.06s/.test(e.message),
  );

  // Control came back. That is the only thing the poll loop needs in order to survive.
  assert.ok(Date.now() - started >= 55, "it must actually wait for the deadline, not fail fast");
});

test("a promise that resolves in time passes its value straight through", async () => {
  const v = await withDeadline(Promise.resolve("rows"), 1000, "findInterrupted");
  assert.equal(v, "rows");
});

test("a promise that REJECTS in time keeps its own error — the deadline must not mask it", async () => {
  const boom = Promise.reject(new Error("supabase: 503"));
  await assert.rejects(
    () => withDeadline(boom, 1000, "claimNextTask"),
    (e: Error) => !(e instanceof Timeout) && e.message === "supabase: 503",
  );
});

test("the timer is cleared on the happy path, so a clean shutdown can actually exit", async () => {
  // A leaked timer holds the event loop open past a clean stop — a milder strain of exactly
  // the bug this file exists to kill: a process whose liveness stops reflecting its work.
  const before = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  await withDeadline(Promise.resolve(1), 60_000, "findInterrupted");
  const after = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  assert.equal(after, before, "the 60s timer must not still be pending after the promise resolved");
});

test("the timer is cleared on the rejection path too", async () => {
  const before = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  await withDeadline(Promise.reject(new Error("nope")), 60_000, "claimNextTask").catch(() => {});
  const after = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  assert.equal(after, before, "the 60s timer must not still be pending after the promise rejected");
});
