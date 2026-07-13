/**
 * The question channel.
 *
 * This is the one place in the system where a Claude session deliberately stops and waits for
 * a person, so the things worth testing are all about what happens at the edges of that wait:
 * a click that lands a moment too late, two questions racing for one file, and — the one that
 * decides whether the fleet survives an unattended night — the timeout.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  askHuman,
  blockedCount,
  clearQuestion,
  readQuestion,
  writeAnswer,
} from "../../../apps/worker/src/claude/ask.ts";

function ws(): string {
  const d = mkdtempSync(join(tmpdir(), "ask-"));
  mkdirSync(join(d, ".pipeline"), { recursive: true });
  return d;
}

/** Wait for a question to appear (askHuman writes it before it starts polling). */
async function untilAsked(dir: string, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const q = readQuestion(dir);
    if (q) return q;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("no question appeared");
}

test("a human answer unblocks the session, and the answer is what Claude gets back", async () => {
  const dir = ws();
  try {
    const pending = askHuman({
      workspace: dir,
      slug: "my-task",
      question: "Threshold calibration or feature store?",
      options: [{ label: "Threshold" }, { label: "Feature store" }],
      timeoutMin: 5,
    });

    const q = await untilAsked(dir);
    assert.equal(q.question, "Threshold calibration or feature store?");
    assert.equal(q.slug, "my-task");
    assert.equal(q.options.length, 2);

    // ...the human clicks.
    const r = writeAnswer(dir, q.id, "Threshold — it is the only framing that is not data-processing");
    assert.equal(r.ok, true);

    const a = await pending;
    assert.equal(a.by, "human");
    assert.match(a.answer, /^Threshold/);

    // And the channel is left clean: a question that has been answered must not still be on
    // the dashboard, or the next poll invites the human to answer it again.
    assert.equal(readQuestion(dir), null);
    assert.equal(existsSync(join(dir, ".pipeline", "answer.json")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stale click cannot answer the question that replaced it", async () => {
  // The dashboard polls every 3s, so a human can genuinely press an option for a question
  // that expired a second ago. Applying that answer to whatever is being asked NOW would be
  // worse than dropping it — the session would get an answer to a question nobody asked it.
  const dir = ws();
  try {
    const pending = askHuman({
      workspace: dir,
      slug: "t",
      question: "current question",
      options: [],
      timeoutMin: 5,
    });
    const q = await untilAsked(dir);

    const r = writeAnswer(dir, "q_some_other_question", "answer to something else");
    assert.equal(r.ok, false);
    assert.match(r.error!, /no longer the one being asked/);

    // The real question is untouched and still pending.
    assert.equal(readQuestion(dir)!.id, q.id);

    writeAnswer(dir, q.id, "the right answer");
    assert.equal((await pending).answer, "the right answer");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty answer is not an answer", async () => {
  const dir = ws();
  try {
    const pending = askHuman({ workspace: dir, slug: "t", question: "q?", options: [], timeoutMin: 5 });
    const q = await untilAsked(dir);

    for (const empty of ["", "   ", "\n\t "]) {
      const r = writeAnswer(dir, q.id, empty);
      assert.equal(r.ok, false, JSON.stringify(empty));
    }
    assert.equal(readQuestion(dir)!.id, q.id, "still pending");

    writeAnswer(dir, q.id, "real");
    await pending;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("answering when nothing is being asked is refused, not silently accepted", () => {
  const dir = ws();
  try {
    const r = writeAnswer(dir, "q_nothing", "hello?");
    assert.equal(r.ok, false);
    assert.match(r.error!, /no question pending/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TIMEOUT: the fleet never deadlocks on a human who went to bed", async () => {
  // The load-bearing one. A parked question holds a Claude slot; six of them would freeze the
  // whole fleet indefinitely. On timeout the tool must NOT throw — it must hand Claude a real
  // answer telling it to decide for itself and to say that it did so.
  const dir = ws();
  try {
    const a = await askHuman({
      workspace: dir,
      slug: "t",
      question: "nobody is going to answer this",
      options: [],
      timeoutMin: 0.02, // ~1.2s
    });

    assert.equal(a.by, "timeout");
    assert.match(a.answer, /No human answered/i);
    assert.match(a.answer, /best judgment/i);
    // It must tell the model to OWN the decision out loud. A silent unsupervised redesign is
    // exactly what got two submissions rejected.
    assert.match(a.answer, /final message/i);
    // ...and it must not invite a retry, or the session will simply wait all over again.
    assert.match(a.answer, /Do NOT ask again/i);

    // The dead question must be gone from the dashboard.
    assert.equal(readQuestion(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("askHumanTimeoutMin: 0 means 'never block on me' — not 'block on me for a minute'", async () => {
  // Regression. The clamp was Math.max(1, timeoutMin), which silently turned a zero into a
  // 60-second freeze — the precise opposite of what setting it to zero asks for. Zero is the
  // setting for "I am going out; keep the fleet moving without me."
  const dir = ws();
  try {
    const t0 = Date.now();
    const a = await askHuman({ workspace: dir, slug: "t", question: "q?", options: [], timeoutMin: 0 });

    assert.equal(a.by, "timeout");
    assert.ok(Date.now() - t0 < 500, `must not block at all, waited ${Date.now() - t0}ms`);
    // And it must never have shown a question to a human who is not there.
    assert.equal(readQuestion(dir), null);
    assert.equal(blockedCount(), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two questions in one assistant message queue instead of overwriting each other", async () => {
  // Claude can emit several tool calls in a single message. question.json holds ONE question,
  // so a second ask must WAIT for the first — an overwritten question is one the human answers
  // while the session that asked it waits forever for a reply that went somewhere else.
  const dir = ws();
  try {
    const first = askHuman({ workspace: dir, slug: "t", question: "FIRST", options: [], timeoutMin: 5 });
    const second = askHuman({ workspace: dir, slug: "t", question: "SECOND", options: [], timeoutMin: 5 });

    const q1 = await untilAsked(dir);
    assert.equal(q1.question, "FIRST", "the second must not have clobbered the first");

    writeAnswer(dir, q1.id, "answer one");
    assert.equal((await first).answer, "answer one");

    // Only now does the second surface.
    const q2 = await untilAsked(dir);
    assert.equal(q2.question, "SECOND");
    assert.notEqual(q2.id, q1.id);

    writeAnswer(dir, q2.id, "answer two");
    assert.equal((await second).answer, "answer two");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clearQuestion drops a question whose asker is dead", () => {
  // Every turn calls this on the way in. A question.json left behind by a crashed worker
  // refers to a session that no longer exists: nothing is polling for the answer, so showing
  // it to a human would invite them to click into the void.
  const dir = ws();
  try {
    writeFileSync(
      join(dir, ".pipeline", "question.json"),
      JSON.stringify({ id: "q_ghost", slug: "t", question: "from a dead worker", options: [] }),
    );
    assert.ok(readQuestion(dir), "precondition: a stale question is on disk");

    clearQuestion(dir);
    assert.equal(readQuestion(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an aborted turn takes its question off the dashboard with it", async () => {
  const dir = ws();
  const ac = new AbortController();
  try {
    const pending = askHuman({
      workspace: dir,
      slug: "t",
      question: "about to be abandoned",
      options: [],
      timeoutMin: 5,
      signal: ac.signal,
    });
    await untilAsked(dir);

    ac.abort(); // the build timed out, or the worker is shutting down
    await assert.rejects(pending, /aborted/);
    assert.equal(readQuestion(dir), null, "a question nobody is listening to must not be shown");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("blockedCount reports the sessions that are holding a slot for a human", async () => {
  // This number is why the fleet meter can distinguish "busy" from "frozen, waiting on you".
  const dir = ws();
  try {
    assert.equal(blockedCount(), 0);

    const pending = askHuman({ workspace: dir, slug: "t", question: "q?", options: [], timeoutMin: 5 });
    const q = await untilAsked(dir);
    assert.equal(blockedCount(), 1, "a parked question is a held slot, and must be visible as one");

    writeAnswer(dir, q.id, "done");
    await pending;
    assert.equal(blockedCount(), 0, "and it must be released the moment it is answered");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
