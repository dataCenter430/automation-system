/**
 * PASS 2 — the revise lap.
 *
 * A Terminus submission is not one click, it is two, and the second one is where the task
 * actually becomes reviewable. Snorkel's `documentation/Rubric guide line.txt` (lines 30-33):
 *
 *   pass 1   tick the rubric box, submit          -> CI generates a rubric and hands the task
 *                                                    BACK to you, in "Tasks to be revised"
 *   pass 2   edit the rubric, UNTICK the box,     -> a human reviewer finally sees it
 *            tick "Send to reviewer?", submit
 *
 * So a task sitting in the revise queue is not a failure. It is halfway.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THERE IS NO CLIPBOARD IN HERE
 *
 * The operator installed a Chrome extension with a "Copy Reviewer Feedback" button and expected
 * us to click it and read the clipboard. We do not, and the reason is concurrency: the OS
 * clipboard is ONE global slot, and this system runs 6-8 tasks at once. Two revisions clicking
 * Copy within a few hundred milliseconds of each other would hand task A the reviewer feedback
 * for task B — and A would then "fix" itself against B's complaints, re-zip, and submit it. The
 * zip would be valid, our gate would pass it, and a human would receive a coherent-looking task
 * that answers the wrong criticism. Nothing downstream could catch that.
 *
 * It turned out to be unnecessary anyway: the feedback is NOT inside Monaco, it is a
 * `.whitespace-pre-line` div in the sidebar. `textContent` gives the whole thing, newlines and
 * all, per-tab. The extension button stays in the selector config as a documented fallback and
 * is not used.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT THIS REFUSES TO DO
 *
 * - It will not fix a task on feedback it could not fully read. A truncated or empty read parks
 *   the task; there is no "well, we got some of it" path.
 * - It will not re-upload a tree that has not passed the LOCAL gate again. A revision changes the
 *   task; the gate that blessed the old tree says nothing about the new one.
 * - It will not touch "Do you disagree with the reviewer feedback?". Disagreeing with a human
 *   reviewer is not a decision an automation gets to make.
 */
import type { Page } from "playwright";
import { resolve_, exists, pageUrl } from "../browser/selectors.ts";
import {
  readFieldMonaco, snap, writeFieldMonaco,
} from "../browser/actions.ts";
import { withScratchPage, type Attached } from "../browser/cdp.ts";

/** Where a task sits in the revise queue, and how to get to it. */
export interface ReviseTarget {
  /** Absolute URL of the revise page (carries ?assignmentId=). */
  url: string;
  assignmentId: string | null;
}

/** What Snorkel handed back to us. */
export interface ReviseInput {
  /** The human reviewer's words, in full. */
  feedback: string;
  /** The rubric Snorkel's CI generated. Empty string means it generated none. */
  rubric: string;
}

export class ReviseUnreadable extends Error {
  constructor(what: string, why: string) {
    super(
      `Refusing to revise: could not read the ${what} on the revise page (${why}).\n\n` +
        `The fix turn is driven ENTIRELY by what the reviewer wrote. Feeding Claude a partial ` +
        `read would produce a confident fix aimed at the wrong problem, and we would then re-zip ` +
        `and submit it.`,
    );
    this.name = "ReviseUnreadable";
  }
}

/**
 * Is our task in the revise queue yet?
 *
 * Keyed on SNORKEL'S submission uid — the revise card's data-testid is `<uid>-Terminus-2nd-Edition`.
 * Not task_id: that is the Task Gallery uuid, and it appears nowhere on the home page.
 *
 * Runs in a scratch tab so it never navigates a page a caller is holding.
 */
export async function findInReviseQueue(
  a: Attached,
  submissionUid: string,
  runDir: string,
): Promise<ReviseTarget | null> {
  return withScratchPage(a, pageUrl("home"), async (page) => {
    const tokens = { submission_uid: submissionUid };
    if (!(await exists(page, "home.reviseCard", { tokens, timeoutMs: 6000 }))) return null;

    const card = await resolve_(page, "home.reviseCard", { tokens });
    const href = (await card.getAttribute("href")) ?? "";
    if (!href) return null;

    await snap(page, runDir, "revise-found");

    return {
      url: new URL(href, pageUrl("home")).toString(),
      assignmentId: /[?&]assignmentId=([0-9a-f-]{36})/i.exec(href)?.[1] ?? null,
    };
  });
}

/**
 * Read everything Snorkel and the reviewer gave us back.
 *
 * The sidebar and its "Reviewer Feedback" section are Radix collapsibles: while they are closed
 * their content is NOT IN THE DOM AT ALL. So we open them first, and if the text still is not
 * there we refuse rather than treating "closed" as "no feedback".
 */
export async function readReviseInput(page: Page, runDir: string): Promise<ReviseInput> {
  // 1. The sidebar rail.
  const toggle = await resolve_(page, "revise.sidebarToggle");
  if ((await toggle.getAttribute("aria-pressed")) !== "true") {
    await toggle.click();
    await page.waitForTimeout(250);
  }

  // 2. The "Reviewer Feedback" collapsible inside it.
  const section = await resolve_(page, "revise.feedbackToggle");
  if ((await section.getAttribute("aria-expanded")) !== "true") {
    await section.click();
    await page.waitForTimeout(250);
  }

  // 3. The feedback itself — plain text, whitespace-pre-line, complete.
  let feedback = "";
  try {
    const el = await resolve_(page, "revise.feedbackText", { timeoutMs: 8000 });
    feedback = (await el.innerText()).trim();
  } catch {
    throw new ReviseUnreadable("reviewer feedback", "the Reviewer Feedback panel is not on the page");
  }
  if (!feedback) {
    throw new ReviseUnreadable("reviewer feedback", "the panel is present but empty");
  }

  // 4. The rubric CI generated. May legitimately be empty (if the box was never ticked), and an
  //    empty rubric is a fact, not a failure — so `null` (could not read) and "" (nothing there)
  //    are kept apart.
  const rubric = await readFieldMonaco(page, "submission.rubricField");
  if (rubric === null) {
    throw new ReviseUnreadable(
      "generated rubric",
      "window.monaco is unreachable, so the rubric could not be read in full. Reading the " +
        "rendered lines instead would give us roughly 3% of it",
    );
  }

  await snap(page, runDir, "revise-input-read");
  return { feedback, rubric: rubric.trim() };
}

/** Put Claude's rewritten rubric back into the editable Monaco box, and prove it took. */
export async function writeRubric(page: Page, rubric: string, runDir: string): Promise<void> {
  await writeFieldMonaco(page, "submission.rubricField", rubric);
  await snap(page, runDir, "rubric-rewritten");
}
