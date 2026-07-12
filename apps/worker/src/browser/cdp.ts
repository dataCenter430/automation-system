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

export async function attach(cdpUrl = process.env.CDP_URL ?? "http://127.0.0.1:9222"): Promise<Attached> {
  try {
    await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(5_000) });
  } catch {
    throw new Error(`${LAUNCH_HINT}\n  (tried ${cdpUrl})`);
  }

  const browser = await chromium.connectOverCDP(cdpUrl);
  const context = browser.contexts()[0];
  if (!context) throw new Error("Chrome exposed CDP but has no browser context. Open a window and retry.");

  const page = context.pages().find((p) => p.url().includes("snorkel")) ?? await context.newPage();
  return { browser, context, page };
}

/**
 * Reuse the existing Snorkel tab when there is one. Opening a fresh tab per stage would
 * pile up windows across a long run, and the user is watching this browser.
 */
export async function snorkelPage(a: Attached, url: string): Promise<Page> {
  const existing = a.context.pages().find((p) => p.url().startsWith("https://experts.snorkel-ai.com"));
  const page = existing ?? await a.context.newPage();
  if (!page.url().startsWith(url)) {
    await page.goto(url, { waitUntil: "domcontentloaded" });
  }
  return page;
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
