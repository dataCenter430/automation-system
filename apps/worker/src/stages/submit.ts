/**
 * Submit, and read the result back off the home page.
 *
 * This is the one irreversible action in the system, so it gets the one piece of paranoia:
 * RECONCILE BEFORE CLICKING. If the worker crashed in SUBMITTING, we do not know whether
 * the click landed. Re-clicking would double-submit, and a duplicate submission cannot be
 * undone. So we look first.
 */
import type { Page } from "playwright";
import { resolve_, exists, pageUrl, assertConfirmed } from "../browser/selectors.ts";
import { setCheckbox, snap } from "../browser/actions.ts";
import { withScratchPage, type Attached } from "../browser/cdp.ts";

export interface SubmitOutcome {
  submitted: boolean;
  /** From the revise-list href: ?assignmentId=... — the id that identifies OUR task. */
  assignmentId: string | null;
  /** From the href path: /projects/{p}/submission-{THIS}/review */
  submissionId: string | null;
  note: string;
}

/** Pull both ids out of a revise card's href. */
function idsFromHref(href: string): { submissionId: string | null; assignmentId: string | null } {
  const sub = /\/submission-([0-9a-f-]{36})\//i.exec(href);
  const asg = /[?&]assignmentId=([0-9a-f-]{36})/i.exec(href);
  return { submissionId: sub?.[1] ?? null, assignmentId: asg?.[1] ?? null };
}

/**
 * Did this task already get submitted?
 *
 * After a submit, Snorkel bounces to /home and the task appears in "Tasks to be revised"
 * as a card whose data-testid is literally `<task_id>-Terminus-2nd-Edition`. That makes
 * reconciliation exact rather than fuzzy.
 */
export async function findSubmitted(a: Attached, taskId: string, runDir: string): Promise<SubmitOutcome> {
  // In its OWN tab. This used to call snorkelPage(home), which REUSES the live Snorkel tab
  // and navigates it — so reconciling "have we already submitted?" silently destroyed the
  // filled submission form we were about to submit, and the Submit button was then looked
  // for on /home. Reconciliation must be able to look at the home page without touching the
  // page the caller is working on.
  return withScratchPage(a, pageUrl("home"), async (page) => {
    if (!(await exists(page, "home.reviseCard", { tokens: { task_id: taskId }, timeoutMs: 6000 }))) {
      return { submitted: false, assignmentId: null, submissionId: null, note: "not in the revise list" };
    }

    const card = await resolve_(page, "home.reviseCard", { tokens: { task_id: taskId } });
    const href = (await card.getAttribute("href")) ?? "";
    const { submissionId, assignmentId } = idsFromHref(href);
    await snap(page, runDir, "reconciled-found");

    return {
      submitted: true, assignmentId, submissionId,
      note: `found in the revise list${assignmentId ? ` (assignment ${assignmentId.slice(0, 8)})` : ""}`,
    };
  });
}

/** Tick "generate rubric automatically". Only ever called after feedback is green. */
export async function enableRubricGeneration(page: Page, runDir: string): Promise<void> {
  // Ticking the wrong box can overwrite a rubric, and this selector is still a guess.
  assertConfirmed("submission.generateRubricCheckbox");
  await setCheckbox(page, "submission.generateRubricCheckbox", true);
  await snap(page, runDir, "rubric-checkbox-ticked");
}

/**
 * The click. Called only after the human has approved in the dashboard.
 *
 * `page` MUST be the submission page. It used to be handed /home.
 */
export async function clickSubmit(a: Attached, page: Page, taskId: string, runDir: string): Promise<SubmitOutcome> {
  // The one irreversible action in the system. Refuse outright while the selector is still
  // an unverified guess whose fallback candidate is a bare `button[type=submit]` — that can
  // match a different form's button, click it, and report success.
  assertConfirmed("submission.submitButton");

  // Last chance to notice we already did this. Runs in its own tab, so `page` still shows
  // the filled submission form when we come back.
  const before = await findSubmitted(a, taskId, runDir).catch(() => null);
  if (before?.submitted) {
    return { ...before, note: `already submitted — did not click again (${before.note})` };
  }

  const btn = await resolve_(page, "submission.submitButton");
  await snap(page, runDir, "pre-submit");
  await btn.click();

  // Snorkel returns you to /home after a submit.
  await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {});
  await snap(page, runDir, "post-submit");

  const after = await findSubmitted(a, taskId, runDir);
  if (!after.submitted) {
    return {
      submitted: true, assignmentId: null, submissionId: null,
      note: "clicked Submit, but the task has not appeared in the revise list yet (it may take a moment)",
    };
  }
  return after;
}
