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
import { fillReliably, setCheckbox, setRadio, snap } from "../browser/actions.ts";
import { withScratchPage, type Attached } from "../browser/cdp.ts";
import { loadConfig } from "../config.ts";

export interface SubmitOutcome {
  submitted: boolean;
  /** From the revise-list href: ?assignmentId=... — the id that identifies OUR task's assignment. */
  assignmentId: string | null;
  note: string;
}

/**
 * Three uuids, and for a long time this file confused two of them.
 *
 *   task_id        the TASK GALLERY uuid. The operator claims a task inspiration and pastes its
 *                  uuid when adding the task. It exists BEFORE any submission does. It is also
 *                  what goes in the form's "Task Inspiration ID" field.
 *
 *   submission uid the uuid SNORKEL assigns to a submission. Shown next to "UID:" in the page
 *                  header, and it is the prefix of the revise card's data-testid. This is the
 *                  ONLY id that can find our task in the revise queue.
 *
 *   project stage  the `/submission-{uuid}/` segment of the href. This is NOT per-task — every
 *                  Terminus revise card in the live DOM carries the SAME one
 *                  (941bede0-d9c6-42f0-874d-cd3d25582c72). It identifies the project's
 *                  submission STAGE, not a submission.
 *
 * The old code pulled the project-stage uuid out of the href, called it `submissionId`, and
 * wrote it into the task's `submission_id` column — clobbering the real per-task uid that
 * upload.ts had correctly captured from the header. And findSubmitted() looked the revise card
 * up by `task_id`, which is a gallery uuid and therefore never matched anything.
 *
 * That second bug silently disarmed the guard this entire file exists to provide: the "have we
 * already submitted?" check answered NO every single time, so a retry in SUBMITTING would click
 * Submit a second time. Double submission is not undoable.
 */
function assignmentFromHref(href: string): string | null {
  return /[?&]assignmentId=([0-9a-f-]{36})/i.exec(href)?.[1] ?? null;
}

/**
 * "How long did it take you to complete this submission?" — in minutes.
 *
 * A required field with no right answer available to us: the machine's wall-clock is not the
 * number Snorkel is asking for (it is asking what it cost a person). The operator supplies the
 * spread — 180/200/220 — and we pick from it. A real human revision in the live DOM used 200.
 *
 * It is a spread rather than a constant on purpose: the same number on every submission, forever,
 * is itself a signal.
 */
export function pickAht(): number {
  const choices = loadConfig().snorkel?.ahtChoices ?? [180, 200, 220];
  return choices[Math.floor(Math.random() * choices.length)]!;
}

/** We cannot reconcile without Snorkel's uid, and we must never guess in the unsafe direction. */
export class CannotReconcile extends Error {
  constructor() {
    super(
      `Refusing to submit: this task has no Snorkel submission UID recorded, so there is no way ` +
        `to check whether it has ALREADY been submitted.\n\n` +
        `The uid is captured from the submission page header during upload (submission.uid). If ` +
        `it is missing, upload either never ran or could not read it.\n\n` +
        `Answering "not yet submitted" here would be a guess in the one direction that cannot be ` +
        `undone — so the task parks for a human instead.`,
    );
    this.name = "CannotReconcile";
  }
}

/**
 * Did this task already get submitted?
 *
 * After a submit, Snorkel bounces to /home and the task appears in "Tasks to be revised" as a
 * card whose data-testid is `<SNORKEL SUBMISSION UID>-Terminus-2nd-Edition`. Keyed on the right
 * uuid, that makes reconciliation exact rather than fuzzy.
 *
 * Throws CannotReconcile when we have no uid — because "I could not check" and "it is not there"
 * are different answers, and only one of them is safe to act on.
 */
export async function findSubmitted(
  a: Attached,
  submissionUid: string | null,
  runDir: string,
): Promise<SubmitOutcome> {
  if (!submissionUid) throw new CannotReconcile();

  // In its OWN tab. This used to call snorkelPage(home), which REUSES the live Snorkel tab
  // and navigates it — so reconciling "have we already submitted?" silently destroyed the
  // filled submission form we were about to submit, and the Submit button was then looked
  // for on /home. Reconciliation must be able to look at the home page without touching the
  // page the caller is working on.
  return withScratchPage(a, pageUrl("home"), async (page) => {
    const tokens = { submission_uid: submissionUid };

    if (!(await exists(page, "home.reviseCard", { tokens, timeoutMs: 6000 }))) {
      return { submitted: false, assignmentId: null, note: "not in the revise list" };
    }

    const card = await resolve_(page, "home.reviseCard", { tokens });
    const assignmentId = assignmentFromHref((await card.getAttribute("href")) ?? "");
    await snap(page, runDir, "reconciled-found");

    return {
      submitted: true,
      assignmentId,
      note: `found in the revise list${assignmentId ? ` (assignment ${assignmentId.slice(0, 8)})` : ""}`,
    };
  });
}

/**
 * SUBMITTING A TERMINUS TASK TAKES TWO PASSES, AND THEY ARE NOT THE SAME FORM.
 *
 * This is the shape of the whole thing, and getting it wrong destroys work. From Snorkel's own
 * `documentation/Rubric guide line.txt`, lines 30-33, verbatim:
 *
 *   30  "Generate the Rubric: Check the checkbox and then submit your submission (once ready)
 *        for automated checks."
 *   31  "Edit the Rubric: Once your submission COMES BACK TO YOU with a generated rubric in the
 *        textbox ... you can then directly edit the rubric"
 *   32  "Uncheck the Checkbox: Once satisfied with your rubric, make sure to ALWAYS UNCHECK the
 *        checkbox above BEFORE YOU SUBMIT (send to reviewer)! Submitting with the checkbox
 *        checked MIGHT CAUSE YOUR RUBRIC TO BE OVERWRITTEN upon submission."
 *   33  "Submit: Once satisfied with your submission overall, including the rubric ... submit"
 *
 * So:
 *
 *   PASS 1 — "ci"        rubric = TRUE,  sendToReviewer = FALSE
 *                        Snorkel runs CI, GENERATES the rubric, and hands the task BACK. It
 *                        lands in "Tasks to be revised" BY DESIGN. That is not a failure and it
 *                        is not the send-to-reviewer box being unticked "by mistake" — it is the
 *                        only way a rubric can exist.
 *
 *   PASS 2 — "reviewer"  rubric = FALSE, sendToReviewer = TRUE
 *                        The rubric now exists and has been edited. Untick the rubric box or
 *                        Snorkel may overwrite it; tick send-to-reviewer, and a human gets it.
 *
 * Setting BOTH to true — which this function did until the docs were read properly — is the
 * exact combination line 32 warns against. It would send the task to a human reviewer while
 * simultaneously asking Snorkel to regenerate (and overwrite) the rubric that reviewer is about
 * to read.
 *
 * The live DOM agrees, and this is the tell I initially misread: on a FRESH submission page both
 * boxes are unchecked; on a REVISE page a real human has sendToReviewer=TRUE and rubric=FALSE.
 * That is pass 2, exactly as the guide describes.
 */
export type SubmitPass = "ci" | "reviewer";

export async function finaliseForm(
  page: Page,
  runDir: string,
  opts: {
    taskId: string;
    ahtMinutes: number;
    pass: SubmitPass;
    /**
     * "Does this task use an approved canonical base image?"
     *
     * COMPUTED, never assumed — see canonicalBaseImage() in lint. `null` means we could not
     * determine it, and an attestation we cannot determine is one we must not sign: the caller
     * is required to park the task for a human rather than pass null through to a guess.
     */
    canonicalBaseImage: boolean;
  },
): Promise<void> {
  const forReviewer = opts.pass === "reviewer";

  // Order matters here only in that both must be right before Submit; but the pairing is the
  // whole point, so they are set together and never independently.
  await setCheckbox(page, "submission.generateRubricCheckbox", !forReviewer);
  await setCheckbox(page, "submission.sendToReviewerCheckbox", forReviewer);

  // An attestation. Computed from the task's own Dockerfile against Snorkel's canonical list.
  await setRadio(page, "submission.canonicalBaseImageRadio", opts.canonicalBaseImage);

  // "Did you use a Task Inspiration from the Task Gallery?" — Yes: the uuid the operator pastes
  // to create a task IS the gallery inspiration uuid (which is also why task_id is NOT Snorkel's
  // submission uid). Answering Yes MOUNTS a required "Task Inspiration ID" field, so the radio
  // must be set before the fill below — the field does not exist until it is.
  await setRadio(page, "submission.taskGalleryRadio", true);
  await fillReliably(page, "submission.taskInspirationId", opts.taskId);

  await fillReliably(page, "submission.aht", String(opts.ahtMinutes));

  await snap(page, runDir, `form-finalised-${opts.pass}`);
}

/**
 * The click. Called only after the human has approved in the dashboard.
 *
 * `page` MUST be the submission page. It used to be handed /home.
 */
export async function clickSubmit(
  a: Attached,
  page: Page,
  submissionUid: string | null,
  runDir: string,
): Promise<SubmitOutcome> {
  // Both of these were "$unconfirmed" placeholders that the system refused to click, because
  // their fallback candidates (a bare `button[type=submit]`, a `[data-testid*=rubric]`) were
  // generic enough to hit the WRONG element and report success. The real DOM has now pinned
  // both, so assertConfirmed passes — but it stays, because the day someone adds a new guessed
  // selector is the day it earns its keep again.
  assertConfirmed("submission.submitButton");

  // Last chance to notice we already did this. Runs in its own tab, so `page` still shows the
  // filled submission form when we come back. NOT swallowed with .catch(() => null) any more:
  // CannotReconcile means we do not know, and "we do not know" must stop the submit, not sail
  // past it into the one action that cannot be taken back.
  const before = await findSubmitted(a, submissionUid, runDir);
  if (before.submitted) {
    return { ...before, note: `already submitted — did not click again (${before.note})` };
  }

  const btn = await resolve_(page, "submission.submitButton");
  await snap(page, runDir, "pre-submit");
  await btn.click();

  // Snorkel returns you to /home after a submit.
  await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {});
  await snap(page, runDir, "post-submit");

  const after = await findSubmitted(a, submissionUid, runDir);
  if (!after.submitted) {
    return {
      submitted: true,
      assignmentId: null,
      note: "clicked Submit, but the task has not appeared in the revise list yet (it may take a moment)",
    };
  }
  return after;
}
