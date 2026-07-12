/**
 * The semaphore decides how many Docker gates and Claude sessions run at once. If it ever
 * leaks a permit on an error path, the worker strangles itself one failure at a time — and
 * the symptom (tasks silently stop being picked up) looks nothing like the cause.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Semaphore } from "../../../apps/worker/src/util/semaphore.ts";

const tick = () => new Promise((r) => setTimeout(r, 5));

test("never lets more than max run at once", async () => {
  const sem = new Semaphore(2);
  let running = 0;
  let peak = 0;

  await Promise.all(
    Array.from({ length: 8 }, () =>
      sem.run(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await tick();
        running -= 1;
      }),
    ),
  );

  assert.equal(peak, 2, "more than 2 gates ran concurrently");
  assert.equal(sem.inUse, 0, "permits leaked");
});

test("a throwing task gives its permit back", async () => {
  const sem = new Semaphore(1);

  for (let i = 0; i < 3; i++) {
    await assert.rejects(sem.run(async () => { throw new Error("gate blew up"); }));
  }

  // If the permit leaked, this would hang forever rather than resolve.
  let ran = false;
  await sem.run(async () => { ran = true; });
  assert.equal(ran, true, "the semaphore was strangled by earlier failures");
  assert.equal(sem.inUse, 0);
});

test("everything queued eventually runs, in order", async () => {
  const sem = new Semaphore(1);
  const order: number[] = [];

  await Promise.all(
    [1, 2, 3, 4].map((n) =>
      sem.run(async () => {
        order.push(n);
        await tick();
      }),
    ),
  );

  assert.deepEqual(order, [1, 2, 3, 4]);
});

test("wouldBlock reports honestly", async () => {
  const sem = new Semaphore(1);
  assert.equal(sem.wouldBlock, false);

  let release!: () => void;
  const held = sem.run(() => new Promise<void>((r) => { release = r; }));

  await tick();
  assert.equal(sem.wouldBlock, true, "a full semaphore should say so");
  assert.equal(sem.inUse, 1);

  release();
  await held;
  assert.equal(sem.wouldBlock, false);
});
