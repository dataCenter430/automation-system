/**
 * Attach to the signed-in Chrome over CDP.
 *
 * We attach to a LIVE browser rather than launching our own, because the Snorkel session
 * cookie lives in that profile and we are forbidden from touching Snorkel's API — every
 * action must go through the real UI, as a real logged-in user.
 */
import { chromium } from "playwright";
const LAUNCH_HINT = "Nothing is listening on the CDP port.\n" +
    (process.platform === "win32"
        ? "  Run:  powershell -File scripts/launch-chrome.ps1\n"
        : "  Run:  bash scripts/launch-chrome.sh\n") +
    "  You cannot attach to a normally-launched Chrome — the debug port only exists if Chrome\n" +
    "  was STARTED with --remote-debugging-port, and Chrome 136+ refuses that flag on the\n" +
    "  default user-data-dir. (That is a Chrome rule, not a Windows one: it applies here too.)";
/**
 * Chrome simply is not there. That is a "go and start it" condition, not a broken task —
 * the pipeline parks at NEEDS_HUMAN instead of burning the task's retries and marking a
 * perfectly good build FAILED.
 */
export class BrowserUnavailable extends Error {
    constructor(message) {
        super(message);
        this.name = "BrowserUnavailable";
    }
}
export async function attach(cdpUrl = process.env.CDP_URL ?? "http://127.0.0.1:9222") {
    try {
        await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(5_000) });
    }
    catch {
        throw new BrowserUnavailable(`${LAUNCH_HINT}\n  (tried ${cdpUrl})`);
    }
    const browser = await chromium.connectOverCDP(cdpUrl);
    const context = browser.contexts()[0];
    if (!context)
        throw new Error("Chrome exposed CDP but has no browser context. Open a window and retry.");
    const page = context.pages().find((p) => p.url().includes("snorkel")) ?? await context.newPage();
    return { browser, context, page };
}
/**
 * Reuse the existing Snorkel tab when there is one. Opening a fresh tab per stage would
 * pile up windows across a long run, and the user is watching this browser.
 *
 * ⚠️  This NAVIGATES the shared tab if it is not already on `url`. That is fine when `url`
 * is where you want to end up, and catastrophic when some other stage is mid-way through a
 * form on that tab. If you only need to LOOK at another page, use withScratchPage().
 */
export async function snorkelPage(a, url) {
    const existing = a.context.pages().find((p) => p.url().startsWith("https://experts.snorkel-ai.com"));
    const page = existing ?? await a.context.newPage();
    if (!page.url().startsWith(url)) {
        await page.goto(url, { waitUntil: "domcontentloaded" });
    }
    return page;
}
/**
 * Look at a page in a throwaway tab, then close it — leaving the caller's tab untouched.
 *
 * This exists because reconciliation ("has this task already been submitted?") has to read
 * /home while the submission form sits filled-in on the main tab. Doing that through
 * snorkelPage() navigated the form away, which is why the submit stage was looking for the
 * Submit button on the home page.
 */
export async function withScratchPage(a, url, fn) {
    const page = await a.context.newPage();
    try {
        await page.goto(url, { waitUntil: "domcontentloaded" });
        return await fn(page);
    }
    finally {
        await page.close().catch(() => { });
    }
}
/**
 * We must never call Snorkel's API — only drive its DOM. This makes that auditable:
 * every request the page makes is logged, so a stray fetch shows up in the run log
 * rather than hiding.
 */
export function auditRequests(page, onApiCall) {
    page.on("request", (req) => {
        if (req.resourceType() === "xhr" || req.resourceType() === "fetch") {
            onApiCall(`${req.method()} ${req.url()}`);
        }
    });
}
export async function detach(a) {
    // Close OUR connection, not the user's browser. `browser.close()` on a CDP-attached
    // browser only drops the connection; it does not kill Chrome.
    await a.browser.close();
}
