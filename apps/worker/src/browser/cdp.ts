/**
 * Attach to the signed-in Chrome over CDP.
 *
 * We attach to a LIVE browser rather than launching our own, because the Snorkel session
 * cookie lives in that profile and we are forbidden from touching Snorkel's API — every
 * action must go through the real UI, as a real logged-in user.
 */
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

export interface Attached {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

const LAUNCH_HINT =
  "Nothing is listening on the CDP port.\n" +
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
  constructor(message: string) {
    super(message);
    this.name = "BrowserUnavailable";
  }
}

export async function attach(cdpUrl = process.env.CDP_URL ?? "http://127.0.0.1:9222"): Promise<Attached> {
  try {
    await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(5_000) });
  } catch {
    throw new BrowserUnavailable(`${LAUNCH_HINT}\n  (tried ${cdpUrl})`);
  }

  const browser = await chromium.connectOverCDP(cdpUrl);
  const context = browser.contexts()[0];
  if (!context) throw new Error("Chrome exposed CDP but has no browser context. Open a window and retry.");

  // Do NOT open a tab here. Stages attach and detach around every state, so creating a page
  // per attach leaks a tab per transition — and with eight tasks that is a lot of tabs in a
  // browser the human is also looking at. Reuse whatever is open; stages that need a tab of
  // their own call newTab().
  const page = context.pages().find((p) => p.url().includes("snorkel")) ?? context.pages()[0]!;
  return { browser, context, page };
}

/**
 * A tab that belongs to this task and nobody else.
 *
 * Used by the upload stage: filling a submission takes minutes, and a tab that another task
 * might navigate out from under it is not a place to do that.
 */
export async function newTab(a: Attached, url: string): Promise<Page> {
  const page = await a.context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  return page;
}

/**
 * The tab for THIS url — never somebody else's tab.
 *
 * This replaced a function that found "the first Snorkel tab" and navigated it wherever the
 * caller wanted to go. With one task in flight that is merely untidy. With eight it is a
 * wrong-submission generator:
 *
 *   Task A is in UPLOADING, its zip attached and its three explanations typed into the form.
 *   Task B enters UPLOADING, asks for /home, finds A's tab (it is a Snorkel tab), and
 *   navigates it — destroying A's form. B fills its own submission into that same tab. A's
 *   remaining calls now act on B's page: A records B's submission URL, polls B's feedback for
 *   twenty minutes, and finally clicks Submit on B's submission.
 *
 * That is the double-submit lock.ts was written to prevent, arriving through a door nobody
 * had locked. So: reuse a tab only if it is ALREADY at this url, and otherwise open a new
 * one. A tab is never navigated away from where another task left it.
 */
export async function snorkelPage(a: Attached, url: string): Promise<Page> {
  const already = a.context.pages().find((p) => !p.isClosed() && p.url().startsWith(url));
  if (already) return already;

  const page = await a.context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded" });
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
export async function withScratchPage<T>(
  a: Attached,
  url: string,
  fn: (page: Page) => Promise<T>,
): Promise<T> {
  const page = await a.context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    return await fn(page);
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * We must never call Snorkel's API — only drive its DOM. This makes that auditable:
 * every request the page makes is logged, so a stray fetch shows up in the run log
 * rather than hiding.
 */
export function auditRequests(page: Page, onApiCall: (url: string) => void): void {
  page.on("request", (req) => {
    if (req.resourceType() === "xhr" || req.resourceType() === "fetch") {
      onApiCall(`${req.method()} ${req.url()}`);
    }
  });
}

export async function detach(a: Attached): Promise<void> {
  // Close OUR connection, not the user's browser. `browser.close()` on a CDP-attached
  // browser only drops the connection; it does not kill Chrome.
  await a.browser.close();
}
