/**
 * Click "Check feedback" and read Snorkel's verdict.
 *
 * This is the authoritative gate. Our local Docker gate is a proxy; Snorkel's CI is the
 * opinion that actually decides whether the submission is accepted, so a task does not
 * get near Submit until this comes back green.
 *
 * Two rules govern the verdict:
 *
 *  1. Read the MONACO MODEL, not the rendered lines. Monaco virtualizes — scraping
 *     `.view-line` gives you the visible screenful and silently drops the rest, so you'd
 *     hand Claude half an error log.
 *
 *  2. NEVER infer a pass from the absence of an error. A false pass ticks the rubric box
 *     and parks a broken task at AWAITING_APPROVAL, where a human is being asked to trust
 *     it. Require an explicit positive signal; if we get neither a clear pass nor a clear
 *     fail, stop and ask a human.
 */
import type { Page } from "playwright";
import { resolve_ } from "../browser/selectors.ts";
import { readMonaco, readMonacoFallback, snap } from "../browser/actions.ts";

export type Verdict = "pass" | "fail" | "pending";

export interface FeedbackResult {
  verdict: "pass" | "fail";
  /** Full text of Snorkel's output — this is what goes back to Claude verbatim on a fail. */
  output: string;
  elapsedSec: number;
}

export class FeedbackInconclusive extends Error {
  output: string;
  constructor(msg: string, output: string) {
    super(msg);
    this.name = "FeedbackInconclusive";
    this.output = output;
  }
}

/**
 * Signals, kept here rather than in the selector config because they are about the TEXT
 * Snorkel writes, not about where it writes it.
 *
 * These are seeded from the field descriptions and will be pinned exactly against a live
 * run (one good zip, one deliberately broken zip) before this loop is trusted to spend
 * Claude attempts on a fix.
 */
const PASS_SIGNALS = [
  /\ball\s+checks?\s+passed\b/i,
  /\bno\s+(?:issues|errors|problems)\s+(?:were\s+)?found\b/i,
  /\bstatic\s+checks?\s+passed\b/i,
  /^\s*passed\s*$/im,
  /\bsuccess(?:ful)?\b.*\bvalidation\b/i,
];

const FAIL_SIGNALS = [
  /\bfailed\b/i,
  /\berror\b/i,
  /\bblocking\b/i,
  /\bmust be fixed\b/i,
  /\bcheck\s+failed\b/i,
  /\binvalid\b/i,
  /\bmissing\b/i,
];

function classify(output: string): Verdict {
  if (!output.trim()) return "pending";
  // Failures are checked FIRST: an output that says "3 checks passed, 1 failed" is a fail.
  if (FAIL_SIGNALS.some((r) => r.test(output))) return "fail";
  if (PASS_SIGNALS.some((r) => r.test(output))) return "pass";
  return "pending";
}

/** Everything Snorkel wrote back, from every result surface, as one blob. */
async function readOutput(page: Page): Promise<string> {
  const parts: string[] = [];

  const models = await readMonaco(page);
  for (const m of models) {
    if (m.value.trim()) parts.push(`--- ${m.uri} ---\n${m.value.trim()}`);
  }

  if (parts.length === 0) {
    // window.monaco unreachable — fall back to the rendered editors.
    for (const key of ["submission.textSummaryField", "submission.qualityCheckField"]) {
      const t = await readMonacoFallback(page, key).catch(() => "");
      if (t) parts.push(`--- ${key} ---\n${t}`);
    }
  }

  return parts.join("\n\n");
}

export async function checkFeedback(args: {
  page: Page;
  runDir: string;
  pollIntervalSec: number;
  timeoutMin: number;
  /** Called on every poll so the dashboard can show elapsed time instead of looking hung. */
  onHeartbeat?: (elapsedSec: number) => Promise<void>;
  /** Lets the worker abandon the poll and go serve another task. */
  shouldStop?: () => boolean;
}): Promise<FeedbackResult> {
  const { page, runDir, pollIntervalSec, timeoutMin } = args;

  const button = await resolve_(page, "submission.checkFeedbackButton");
  await button.click();
  await snap(page, runDir, "check-feedback-clicked");

  const started = Date.now();
  const deadline = started + timeoutMin * 60_000;

  while (Date.now() < deadline) {
    if (args.shouldStop?.()) {
      throw new FeedbackInconclusive("Poll abandoned by the worker; will resume.", "");
    }

    await page.waitForTimeout(pollIntervalSec * 1000);

    const elapsedSec = Math.round((Date.now() - started) / 1000);
    const output = await readOutput(page).catch(() => "");
    const verdict = classify(output);

    await args.onHeartbeat?.(elapsedSec);

    if (verdict === "pending") continue;

    await snap(page, runDir, `feedback-${verdict}`);
    return { verdict, output, elapsedSec };
  }

  const output = await readOutput(page).catch(() => "");
  await snap(page, runDir, "feedback-timeout");
  throw new FeedbackInconclusive(
    `"Check feedback" produced no clear pass or fail within ${timeoutMin} minutes. ` +
      `Not guessing: a false pass would park a broken task in front of you as if it were ready.\n` +
      `Screenshot and DOM are in ${runDir}.`,
    output,
  );
}
