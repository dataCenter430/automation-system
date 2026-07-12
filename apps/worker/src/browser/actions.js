/**
 * The action primitives. Six of them, and that's all the browser layer needs.
 *
 * Each one exists because of a specific way this particular app breaks naive automation:
 * Radix lazily mounts fields, React drops programmatic input values, the file input is
 * hidden, checkbox state must be idempotent, and Monaco virtualizes its lines.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolve_ } from "./selectors.ts";
/* ------------------------------------------------------------------ snap */
let snapCounter = 0;
/**
 * Screenshot + DOM after every step, into runs/<slug>/.
 * This is the only forensic trail we get on a browser we don't control. When a selector
 * breaks at 2am, this is what tells you what the page actually looked like.
 */
export async function snap(page, runDir, label) {
    mkdirSync(runDir, { recursive: true });
    const n = String(++snapCounter).padStart(2, "0");
    const base = join(runDir, `${n}-${label.replace(/[^a-z0-9-]+/gi, "-")}`);
    try {
        await page.screenshot({ path: `${base}.png`, fullPage: true });
        writeFileSync(`${base}.html`, await page.content(), "utf8");
    }
    catch {
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
export async function expandIfCollapsed(page, key) {
    const section = await resolve_(page, key);
    const state = await section.getAttribute("data-state");
    if (state === "open")
        return;
    const trigger = section.locator('[aria-expanded="false"]').first();
    if ((await trigger.count()) === 0)
        return; // no trigger: not an accordion, nothing to do
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
export async function fillReliably(page, key, text) {
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
        throw new Error(`Could not set "${key}": the field still reads ${JSON.stringify(got.slice(0, 60))} ` +
            `after both fill() and typing. The form is rejecting our input.`);
    }
}
/* ------------------------------------------------------------------ attachFile */
/**
 * The zip input is `class="hidden"`, so it can never be clicked — setInputFiles targets
 * it directly, which is also what a real drag-and-drop ends up doing.
 */
export async function attachFile(page, key, absPath) {
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
export async function setCheckbox(page, key, want) {
    const box = await resolve_(page, key);
    const read = async () => {
        const aria = await box.getAttribute("aria-checked");
        if (aria !== null)
            return aria === "true";
        return box.isChecked();
    };
    if ((await read()) === want)
        return;
    await box.click();
    await page.waitForTimeout(150);
    if ((await read()) !== want) {
        throw new Error(`Clicked "${key}" but its state did not change to ${want}.`);
    }
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
export async function readMonaco(page) {
    return page.evaluate(() => {
        const m = globalThis.monaco;
        if (!m?.editor?.getModels)
            return [];
        return m.editor.getModels().map((model) => ({
            uri: String(model.uri),
            value: model.getValue(),
        }));
    });
}
/** Fallback for when window.monaco isn't reachable: read the aria-label textbox content. */
export async function readMonacoFallback(page, fieldKey) {
    const field = await resolve_(page, fieldKey);
    const editor = field.locator('[role="code"], .monaco-editor').first();
    if ((await editor.count()) === 0)
        return "";
    return (await editor.innerText()).trim();
}
