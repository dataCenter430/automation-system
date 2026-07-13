/**
 * The action primitives. Six of them, and that's all the browser layer needs.
 *
 * Each one exists because of a specific way this particular app breaks naive automation:
 * Radix lazily mounts fields, React drops programmatic input values, the file input is
 * hidden, checkbox state must be idempotent, and Monaco virtualizes its lines.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "playwright";
import { resolve_ } from "./selectors.ts";

/* ------------------------------------------------------------------ snap */

/**
 * Per-run-directory, NOT global.
 *
 * A single module-level counter is shared by every task in the process, so with eight tasks
 * running browser stages at once, runs/<slugA>/upload-0/ got 03, 07, 15 while runs/<slugB>/
 * got 04, 09, 12. The docstring below calls this "the only forensic trail we get" — a trail
 * whose numbering is interleaved with seven other tasks is not one.
 */
const snapCounters = new Map<string, number>();

/**
 * Screenshot + DOM after every step, into runs/<slug>/.
 * This is the only forensic trail we get on a browser we don't control. When a selector
 * breaks at 2am, this is what tells you what the page actually looked like.
 */
export async function snap(page: Page, runDir: string, label: string): Promise<void> {
  mkdirSync(runDir, { recursive: true });
  const next = (snapCounters.get(runDir) ?? 0) + 1;
  snapCounters.set(runDir, next);
  const n = String(next).padStart(3, "0"); // 3 digits: a long feedback poll snaps a lot
  const base = join(runDir, `${n}-${label.replace(/[^a-z0-9-]+/gi, "-")}`);
  try {
    await page.screenshot({ path: `${base}.png`, fullPage: true });
    writeFileSync(`${base}.html`, await page.content(), "utf8");
  } catch {
    // A screenshot failing must never fail the stage it was documenting.
  }
}

/* --------------------------------------------------------- expandIfCollapsed */

/**
 * Radix mounts a section's fields only when it is OPEN.
 *
 * This is not a nicety — a closed accordion means the textareas do not exist in the DOM
 * at all, and every selector below it fails with a "page has changed" error that is a lie.
 * Proven necessary by the Rubric-extension already in this repo.
 */
export async function expandIfCollapsed(page: Page, key: string): Promise<void> {
  const section = await resolve_(page, key);

  const state = await section.getAttribute("data-state");
  if (state === "open") return;

  const trigger = section.locator('[aria-expanded="false"]').first();
  if ((await trigger.count()) === 0) return; // no trigger: not an accordion, nothing to do

  await trigger.click();
  await section.locator('[data-state="open"]').first()
    .waitFor({ state: "attached", timeout: 10_000 });
}

/* ---------------------------------------------------------------- fillReliably */

/**
 * Fill, read back, and if it didn't stick, type it.
 *
 * React-controlled inputs drop programmatically-set values often enough that
 * write-then-verify has to be the default, not the exception. Silently filling nothing
 * and then wondering why "Check feedback" stays disabled is the failure this prevents.
 */
export async function fillReliably(page: Page, key: string, text: string): Promise<void> {
  const loc = await resolve_(page, key);

  await loc.fill(text);
  if ((await loc.inputValue()) === text) {
    await loc.blur();
    return;
  }

  await loc.click();
  await loc.fill("");
  await loc.pressSequentially(text, { delay: 8 });
  await loc.blur();

  const got = await loc.inputValue();
  if (got !== text) {
    throw new Error(
      `Could not set "${key}": the field still reads ${JSON.stringify(got.slice(0, 60))} ` +
        `after both fill() and typing. The form is rejecting our input.`,
    );
  }
}

/* ------------------------------------------------------------------ attachFile */

/**
 * The zip input is `class="hidden"`, so it can never be clicked — setInputFiles targets
 * it directly, which is also what a real drag-and-drop ends up doing.
 */
export async function attachFile(page: Page, key: string, absPath: string): Promise<void> {
  const input = await resolve_(page, key);
  await input.setInputFiles(absPath);
}

/* ----------------------------------------------------------------- setCheckbox */

/**
 * Idempotent by construction: read the state, click only on a mismatch, then re-read.
 *
 * Blind-clicking a checkbox is a coin flip on its final state, and for the
 * generate-rubric box the wrong state can overwrite a rubric.
 */
export async function setCheckbox(page: Page, key: string, want: boolean): Promise<void> {
  const box = await resolve_(page, key);

  const read = async (): Promise<boolean> => {
    const aria = await box.getAttribute("aria-checked");
    if (aria !== null) return aria === "true";
    return box.isChecked();
  };

  if ((await read()) === want) return;

  await box.click();
  await page.waitForTimeout(150);

  if ((await read()) !== want) {
    throw new Error(`Clicked "${key}" but its state did not change to ${want}.`);
  }
}

/* -------------------------------------------------------------------- setRadio */

/**
 * Answer a Yes/No radiogroup.
 *
 * Two things make this not a one-liner, both taken straight from the live DOM:
 *
 *   1. THE REAL <input type=radio> CANNOT BE CLICKED. Snorkel renders it
 *      `position:absolute; pointer-events:none; opacity:0` and puts a Radix
 *      `<button role="radio">` on top. Clicking the input is a no-op that reports success.
 *
 *   2. THE IDS ARE GARBAGE. `id="_r_59_-true"` is React useId() output — the submission page
 *      and the revise page render the SAME fields with completely different ids. Selecting on
 *      them works exactly until the next render. So the selectors are anchored on the question
 *      text and the radio's `value`, both of which are stable.
 *
 * Idempotent, like setCheckbox: read, click only on a mismatch, then verify it took.
 */
export async function setRadio(page: Page, key: string, yes: boolean): Promise<void> {
  const value = yes ? "true" : "false";
  const radio = await resolve_(page, key, { tokens: { value } });

  const isSet = async (): Promise<boolean> => (await radio.getAttribute("aria-checked")) === "true";

  if (await isSet()) return;

  await radio.click();
  await page.waitForTimeout(150);

  if (!(await isSet())) {
    throw new Error(
      `Clicked "${key}" (value=${value}) but aria-checked did not become true. ` +
        `The radiogroup did not accept the answer.`,
    );
  }
}

/* ----------------------------------------------------------------- readMonaco */

export interface MonacoModel {
  uri: string;
  value: string;
}

/**
 * Read Monaco's MODEL, never its rendered lines.
 *
 * Monaco virtualizes: `.view-line` elements only exist for the rows currently on screen.
 * Scraping them gives you the first screenful of a failure log and nothing else, so you'd
 * hand Claude a truncated error and wonder why the fix missed the point.
 *
 * This runs in the page context — it is DOM access, not a Snorkel API call.
 */
export async function readMonaco(page: Page): Promise<MonacoModel[]> {
  return page.evaluate(() => {
    const m = (globalThis as any).monaco;
    if (!m?.editor?.getModels) return [];
    return m.editor.getModels().map((model: any) => ({
      uri: String(model.uri),
      value: model.getValue(),
    }));
  });
}

/**
 * Read ONE field's Monaco content, in full.
 *
 * THE MODEL NUMBER IS NOT AN IDENTIFIER. The same five fields render as `inmemory://model/6..10`
 * on the submission page and `inmemory://model/1..5` on the revise page — the number is just
 * allocation order. So we do not guess it: we read the `data-uri` that Monaco itself stamped
 * INSIDE this field's container, then look that uri up in the model list.
 *
 * Returns null when the field has no editor, or when window.monaco is unreachable. NULL MEANS
 * "I DID NOT READ IT" — never "". The caller must treat that as a failure to check, not as an
 * empty (and therefore clean) report. See below for why that distinction is the whole ballgame.
 */
export async function readFieldMonaco(page: Page, fieldKey: string): Promise<string | null> {
  const field = await resolve_(page, fieldKey);
  const editor = field.locator("[data-uri]").first();
  if ((await editor.count()) === 0) return null;

  const uri = await editor.getAttribute("data-uri");
  if (!uri) return null;

  const models = await readMonaco(page);
  const hit = models.find((m) => m.uri === uri);
  return hit ? hit.value : null;
}

/**
 * Write into a Monaco editor — the rubric box, which is the one editable one.
 *
 * NOT by typing. The generated rubric is hundreds of lines; `pressSequentially` would take
 * minutes and Monaco's auto-indent and bracket-closing would mangle it on the way in. We set the
 * MODEL's value, which is what Monaco's own API is for, and which fires the change events the
 * React binding is listening for — so the form sees it and autosaves it.
 *
 * Verified by reading it back. A silent no-op here would send a reviewer the AI's untouched
 * synthetic rubric while the log claimed we had rewritten it.
 */
export async function writeFieldMonaco(page: Page, fieldKey: string, text: string): Promise<void> {
  const field = await resolve_(page, fieldKey);
  const editor = field.locator("[data-uri]").first();
  if ((await editor.count()) === 0) {
    throw new Error(`Cannot write "${fieldKey}": it has no Monaco editor on this page.`);
  }

  const uri = await editor.getAttribute("data-uri");
  if (!uri) throw new Error(`Cannot write "${fieldKey}": its editor has no data-uri.`);

  const ok = await page.evaluate(
    ({ uri, text }) => {
      const m = (globalThis as any).monaco;
      if (!m?.editor?.getModels) return false;
      const model = m.editor.getModels().find((x: any) => String(x.uri) === uri);
      if (!model) return false;
      model.setValue(text);
      return true;
    },
    { uri, text },
  );
  if (!ok) {
    throw new Error(
      `Cannot write "${fieldKey}": window.monaco is not reachable, or the model (${uri}) is gone. ` +
        `Refusing to pretend the rubric was updated.`,
    );
  }

  const got = await readFieldMonaco(page, fieldKey);
  if (got?.trim() !== text.trim()) {
    throw new Error(
      `Wrote "${fieldKey}" but it read back different (${got?.length ?? 0} chars vs ${text.length}). ` +
        `The editor rejected the value.`,
    );
  }
}

/**
 * Read the RENDERED lines. The output of this function is EVIDENCE OF FAILURE ONLY.
 *
 * It may never be used to conclude that a check passed, and callers must mark anything it
 * returns as `degraded` so classify() can enforce that. The name says UNSAFE so that a future
 * reader cannot reach for it casually.
 *
 * Why it is unsafe: Monaco virtualizes, so `innerText` returns only the rows currently painted.
 * The live DOM shows the scale — the Summary field's model is 5408px tall at 19px per line
 * (~284 lines), and the page contains EIGHT `.view-line` divs. This returns about 3% of the log.
 *
 * A truncated CI report whose failures sit below the fold looks exactly like a clean one. If a
 * "pass" could ever be derived from this, the system would submit a task that Snorkel's own
 * checks had already failed, and report it green. Hence: fail or pending, never pass.
 *
 * It still earns its place. Without it, a page where `window.monaco` is unreachable is a page we
 * are simply blind on, and a REAL failure sitting in plain sight would go unread until timeout.
 * Seeing 3% of a failure is worth something. Seeing 3% of a success is worth nothing.
 */
export async function readRenderedLinesUNSAFE(page: Page, fieldKey: string): Promise<string> {
  const field = await resolve_(page, fieldKey);
  const editor = field.locator('[role="code"], .monaco-editor').first();
  if ((await editor.count()) === 0) return "";
  return (await editor.innerText()).trim();
}
