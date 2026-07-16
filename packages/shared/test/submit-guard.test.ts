/**
 * The two account-safety caps on net-new submissions. Fail closed.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canCreate, recordCreate, countToday, utcDay, dailyLogPath, readDailyLog,
} from "../../../apps/worker/src/stb/submit-guard.ts";

test("blocks when the revision queue is at the cap", () => {
  const r = canCreate({ revisionQueueCount: 10, revisionCap: 10, todayCount: 0, dailyCap: 2 });
  assert.equal(r.ok, false);
  assert.match(r.reason!, /revision queue/);
});

test("blocks when today's net-new count is at the cap", () => {
  const r = canCreate({ revisionQueueCount: 3, revisionCap: 10, todayCount: 2, dailyCap: 2 });
  assert.equal(r.ok, false);
  assert.match(r.reason!, /today/);
});

test("allows when both are under", () => {
  assert.equal(canCreate({ revisionQueueCount: 9, revisionCap: 10, todayCount: 1, dailyCap: 2 }).ok, true);
});

test("fails closed: caller passes a huge queue count when the list could not be read", () => {
  // The convention is that an unreadable `stb submissions list` is reported as a large number, so
  // the gate refuses rather than submits blind.
  assert.equal(canCreate({ revisionQueueCount: 9999, revisionCap: 10, todayCount: 0, dailyCap: 2 }).ok, false);
});

test("utcDay extracts the UTC date, so the reset is a new key at midnight UTC", () => {
  assert.equal(utcDay("2026-07-14T23:59:59.000Z"), "2026-07-14");
  assert.equal(utcDay("2026-07-15T00:00:01.000Z"), "2026-07-15");
});

test("the daily counter is DURABLE across reads and resets by UTC day", () => {
  const dir = mkdtempSync(join(tmpdir(), "stb-guard-"));
  try {
    const path = dailyLogPath(dir);
    assert.equal(countToday(path, "2026-07-14T10:00:00Z"), 0);

    assert.equal(recordCreate(path, "2026-07-14T10:00:00Z"), 1);
    assert.equal(recordCreate(path, "2026-07-14T15:00:00Z"), 2);
    assert.equal(countToday(path, "2026-07-14T20:00:00Z"), 2);

    // A NEW day is a fresh count — the cap resets automatically.
    assert.equal(countToday(path, "2026-07-15T00:30:00Z"), 0);
    assert.equal(recordCreate(path, "2026-07-15T00:30:00Z"), 1);

    // The 14th's count is untouched — it is a persisted, separate key.
    assert.equal(readDailyLog(path)["2026-07-14"], 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a restart does not reset the count — it reads back from disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "stb-guard-"));
  try {
    const path = dailyLogPath(dir);
    recordCreate(path, "2026-07-14T10:00:00Z");
    recordCreate(path, "2026-07-14T11:00:00Z");
    // Simulate a fresh process: nothing in memory, only the file.
    assert.equal(countToday(path, "2026-07-14T12:00:00Z"), 2);
    // And the gate would now block a third if the cap is 2.
    assert.equal(canCreate({ revisionQueueCount: 0, revisionCap: 10, todayCount: 2, dailyCap: 2 }).ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("old entries are pruned so the file never grows unbounded", () => {
  const dir = mkdtempSync(join(tmpdir(), "stb-guard-"));
  try {
    const path = dailyLogPath(dir);
    recordCreate(path, "2026-01-01T10:00:00Z"); // ancient
    recordCreate(path, "2026-07-14T10:00:00Z"); // today
    const log = readDailyLog(path);
    assert.equal(log["2026-01-01"], undefined, "an entry >30 days old should be pruned");
    assert.equal(log["2026-07-14"], 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
