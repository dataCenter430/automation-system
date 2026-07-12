/**
 * Upload the zip and fill the submission form. Stops well short of Submit.
 *
 * The fill ORDER is not arbitrary. Snorkel renders "Check feedback" as `disabled` until
 * the zip, all three explanations, AND the Prompt Check attestation are done — and it
 * prints exactly which ones are missing. That disabled attribute is a free, authoritative
 * readiness oracle: we never have to guess whether a React textarea took our value.
 */
import type { Page } from "playwright";
import { resolve_, pageUrl } from "../browser/selectors.ts";
import { attachFile, expandIfCollapsed, fillReliably, setCheckbox, snap } from "../browser/actions.ts";
import { newTab, type Attached } from "../browser/cdp.ts";
import { lintInstruction, type InstructionAudit } from "./instruction-audit.ts";
import type { Explanations } from "./explain.ts";

export class FormNotReady extends Error {}
export class AttestationRefused extends Error {}

export interface UploadResult {
  page: Page;
  submissionUid: string | null;
  /** Where this form lives, so the feedback and submit stages can come back to it. */
  submissionUrl: string;
  instructionAudit: InstructionAudit;
}

export async function openNewSubmission(a: Attached, runDir: string): Promise<Page> {
  // A tab of our OWN. Filling this form takes minutes — a zip upload and three explanations —
  // and with eight tasks in flight a shared tab means some other task's upload navigates this
  // one away mid-fill, and we end up typing our submission into theirs. This tab belongs to
  // this task until the submission is done with it.
  const page = await newTab(a, pageUrl("home"));
  await page.waitForLoadState("domcontentloaded");
  await snap(page, runDir, "home");

  const start = await resolve_(page, "home.newSubmissionStart");
  await start.click();
  await page.waitForLoadState("domcontentloaded");
  await snap(page, runDir, "submission-page");
  return page;
}

export async function fillSubmissionForm(args: {
  page: Page;
  runDir: string;
  taskDir: string;
  zipPath: string;
  explanations: Explanations;
}): Promise<UploadResult> {
  const { page, runDir, zipPath, explanations, taskDir } = args;

  // Radix does not mount the fields until the section is open. Everything below this
  // line depends on it.
  await expandIfCollapsed(page, "submission.section");

  await attachFile(page, "submission.zipInput", zipPath);
  await snap(page, runDir, "zip-attached");

  await fillReliably(page, "submission.difficultyExplanation", explanations.difficulty);
  await fillReliably(page, "submission.solutionExplanation", explanations.solution);
  await fillReliably(page, "submission.verificationExplanation", explanations.verification);

  // The Prompt Check box is a HUMAN ATTESTATION: "I reviewed my prompt (instruction.md)
  // and: ensured it does not list an excessive number of requirements (20+); made it
  // sound natural and human; removed any unnecessary hints and verified it does not
  // reveal the solution."
  //
  // We tick it only after actually checking those three claims. Ticking a box that
  // asserts something we haven't verified is not a shortcut we get to take — the form
  // says the submission is subject to rejection if it isn't true.
  const audit = lintInstruction(taskDir);
  if (!audit.ok) {
    throw new AttestationRefused(
      `Refusing to tick the Prompt Check box: instruction.md does not satisfy what that box attests to.\n` +
        audit.problems.map((p) => `  - ${p}`).join("\n") +
        `\n\nFix instruction.md and re-run. (The box claims a human reviewed and confirmed these.)`,
    );
  }
  await setCheckbox(page, "submission.promptCheckbox", true);

  // The readiness oracle: Snorkel itself decides when the form is complete.
  //
  // Poll the locator we RESOLVED FROM CONFIG, rather than a second, hardcoded copy of the
  // selector. The hardcoded `document.querySelector('[data-testid="field-feedbackbutton-
  // fast_static_checks"] button')` that used to live here defeated the entire point of the
  // candidate-fallback design: if the testid changed and checkFeedbackButton resolved via
  // its role-based fallback, this querySelector returned null forever, timed out, and threw
  // FormNotReady — reporting "the form did not accept our input" when the form was fine.
  // Polling the locator also survives a React re-render, which an elementHandle would not.
  const button = await resolve_(page, "submission.checkFeedbackButton");
  try {
    await button.waitFor({ state: "visible", timeout: 5_000 });

    const deadline = Date.now() + 20_000;
    let enabled = false;
    while (Date.now() < deadline) {
      if (!(await button.isDisabled().catch(() => true))) {
        enabled = true;
        break;
      }
      await page.waitForTimeout(500);
    }
    if (!enabled) throw new Error("check-feedback button never became enabled");
  } catch {
    // Don't retry blindly — read Snorkel's own list of what didn't take.
    let missing = "";
    try {
      const msg = await resolve_(page, "submission.checkFeedbackMissingFields", { timeoutMs: 3000 });
      missing = (await msg.innerText()).trim();
    } catch { /* the message isn't there either */ }
    await snap(page, runDir, "form-not-ready");
    throw new FormNotReady(
      `"Check feedback" is still disabled, so the form did not accept our input.\n` +
        (missing ? `Snorkel says: ${missing}` : `(Snorkel did not say which fields are missing.)`),
    );
  }

  // "Last saved at HH:MM" — the server acknowledged the field writes.
  try {
    await (await resolve_(page, "submission.autosave", { timeoutMs: 15_000 })).waitFor({ timeout: 15_000 });
  } catch { /* autosave indicator is a nice-to-have, not a gate */ }

  await snap(page, runDir, "form-filled");

  let submissionUid: string | null = null;
  try {
    submissionUid = (await (await resolve_(page, "submission.uid", { timeoutMs: 3000 })).innerText()).trim();
  } catch { /* header UID not always rendered */ }

  return { page, submissionUid, submissionUrl: page.url(), instructionAudit: audit };
}
