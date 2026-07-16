/**
 * THE TWO ACCOUNT-SAFETY CAPS ON SUBMITTING. Both fail closed.
 *
 * Snorkel limits net-new submissions two ways, and the founding DOM system enforced only the first
 * (and only by scraping the home page):
 *
 *   1. REVISION-QUEUE CAP. "At most 10 submissions in your revision queue" — over that, you are
 *      blocked from submitting any net-new tasks. Measured now from `stb submissions list` by
 *      counting NEEDS_REVISION, not by scraping. Revisions (update) do NOT count against it.
 *
 *   2. DAILY NET-NEW CAP. "2 net-new per day (new expert) / 3 (veteran), resets midnight UTC."
 *      The repo enforced this NOWHERE — so 8 tasks built in parallel would all try to submit the
 *      same day and trip the platform's own limit. We track our own create() calls per UTC day.
 *
 * Only `create` (a brand-new submission) is capped. `update` (revising an existing one) is not, by
 * either rule — a revision is not a net-new task.
 *
 * The daily counter is DURABLE (a small JSON file under runs/) so a worker restart does not reset it
 * and let the cap be exceeded. It is keyed by UTC date string, so the reset is automatic: a new day
 * is simply a new key.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface DailyLog {
  /** UTC date (YYYY-MM-DD) → number of net-new create() calls made that day. */
  [utcDate: string]: number;
}

/** UTC day key. Passed in (not read from a clock) so it is testable and resume-safe. */
export function utcDay(nowIso: string): string {
  return nowIso.slice(0, 10); // ISO-8601 is already UTC 'YYYY-MM-DD...'
}

export function readDailyLog(path: string): DailyLog {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as DailyLog;
  } catch {
    return {}; // corrupt → treat as empty; the queue cap is the real backstop
  }
}

function writeDailyLog(path: string, log: DailyLog): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(log, null, 2), "utf8");
  renameSync(tmp, path);
}

export function dailyLogPath(runsDir: string): string {
  return join(runsDir, ".stb-daily-submissions.json");
}

export interface GateInput {
  /** Count of NEEDS_REVISION from `stb submissions list`. */
  revisionQueueCount: number;
  revisionCap: number;
  /** Net-new create() calls already made today (read from the durable log). */
  todayCount: number;
  dailyCap: number;
}

export interface GateResult {
  ok: boolean;
  reason?: string;
}

/**
 * May we create a NET-NEW submission right now? Pure — no I/O, so it is exhaustively testable.
 * Fails closed: an unreadable queue count should be passed in as a large number by the caller.
 */
export function canCreate(g: GateInput): GateResult {
  if (g.revisionQueueCount >= g.revisionCap) {
    return {
      ok: false,
      reason:
        `revision queue holds ${g.revisionQueueCount} (cap ${g.revisionCap}). The platform blocks ` +
        `net-new submissions while the queue is full — revise an existing task down first.`,
    };
  }
  if (g.todayCount >= g.dailyCap) {
    return {
      ok: false,
      reason:
        `already submitted ${g.todayCount} net-new task(s) today (cap ${g.dailyCap}, resets 00:00 UTC). ` +
        `Hold this one until tomorrow — over-submitting is an account-safety risk.`,
    };
  }
  return { ok: true };
}

/**
 * Record one net-new create() against today's UTC count, durably. Call AFTER a successful create.
 * Returns the new count for logging.
 */
export function recordCreate(path: string, nowIso: string): number {
  const log = readDailyLog(path);
  const day = utcDay(nowIso);
  log[day] = (log[day] ?? 0) + 1;
  // Keep the file small: drop entries older than ~30 days.
  const cutoff = utcDay(new Date(Date.parse(nowIso) - 30 * 86_400_000).toISOString());
  for (const k of Object.keys(log)) if (k < cutoff) delete log[k];
  writeDailyLog(path, log);
  return log[day]!;
}

/** How many net-new submissions have we made today? For the gate and the dashboard. */
export function countToday(path: string, nowIso: string): number {
  return readDailyLog(path)[utcDay(nowIso)] ?? 0;
}
