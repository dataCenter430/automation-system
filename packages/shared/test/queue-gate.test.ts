/**
 * The revision-queue gate.
 *
 * This is an account-safety gate, so the tests are all about the UNSAFE direction: every path
 * that could let a submission through when the queue is full.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQueueCount, QUEUE_LIMIT } from "../../../apps/worker/src/stages/queue-gate.ts";

test("reads Snorkel's own sentence — the only unfilterable number on the page", () => {
  // Verbatim from the live home page.
  assert.equal(parseQueueCount("14 tasks to be revised"), 14);
  assert.equal(parseQueueCount("9 tasks to be revised"), 9);
  assert.equal(parseQueueCount("1 task to be revised"), 1); // singular
  assert.equal(parseQueueCount("0 tasks to be revised"), 0);
  assert.equal(parseQueueCount("  14 tasks to be revised  \n"), 14);
});

test("an unparseable line yields null — NEVER a zero", () => {
  // This is the whole point. Every one of these must be "I don't know", because the caller turns
  // null into a REFUSAL. If any of them returned 0, an unreadable page would read as an EMPTY
  // queue, and an empty queue means "go ahead and submit".
  for (const junk of [
    "",
    "Tasks to be revised",          // the heading, not the count
    "no tasks to be revised",       // words, not a digit
    "loading…",
    "9 projects available",         // the OTHER counter on the same page
    "tasks to be revised: many",
  ]) {
    assert.equal(parseQueueCount(junk), null, JSON.stringify(junk));
  }
});

test("the projects counter cannot be mistaken for the queue counter", () => {
  // Both are `<h1>` + `<div class="text-base-normal">` on the same page. A loose regex that
  // matched "9 projects available" would report a queue of 9 — under the limit — and submit.
  assert.equal(parseQueueCount("9 projects available"), null);
});

test("14 is over the limit, so today's real queue must block", () => {
  // The live home page says 14. The operator's rule is <10. So the correct behaviour RIGHT NOW
  // is to refuse — and this test pins that, so a future edit that "helpfully" relaxes the gate
  // has to argue with a red test first.
  const total = parseQueueCount("14 tasks to be revised")!;
  assert.equal(total >= QUEUE_LIMIT, true, "14 must be treated as over the limit");
});

test("the boundary is >=10, not >10", () => {
  // "you can only proceed submit once revision queue is under 10" — 10 itself is NOT under 10.
  assert.equal(10 >= QUEUE_LIMIT, true, "10 blocks");
  assert.equal(9 >= QUEUE_LIMIT, false, "9 passes");
  assert.equal(QUEUE_LIMIT, 10);
});
