/**
 * Selector recorder.
 *
 *   npm run selectors:record                  → audit every configured selector on the current page
 *   npm run selectors:record -- --pick        → click an element; get ranked candidates to paste
 *
 * This is the tool that keeps the "no selector strings in code" rule affordable. When
 * Snorkel ships a redesign, you run this, paste the output into
 * config/selectors.snorkel.json, and nothing else changes.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT } from "../../../../packages/shared/src/paths.ts";
import { attach, detach } from "./cdp.ts";
import { resolve_, isUnconfirmed } from "./selectors.ts";
const CONFIG = JSON.parse(readFileSync(resolve(REPO_ROOT, "config/selectors.snorkel.json"), "utf8"));
/** Ranked most-stable-first: a testid survives a restyle, a CSS path does not. */
const PICKER = `
(() => {
  const rank = (el) => {
    const out = [];
    const tid = el.closest('[data-testid]')?.getAttribute('data-testid');
    if (tid) out.push({ by: 'testid', value: tid });

    const id = el.id;
    if (id && !/^(radix|_r_)/.test(id)) out.push({ by: 'css', value: '#' + id });

    const role = el.getAttribute('role') || (el.tagName === 'BUTTON' ? 'button' : null);
    const name = (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40);
    if (role && name) out.push({ by: 'role', role, name });

    const tag = el.tagName.toLowerCase();
    if (tid) out.push({ by: 'css', value: '[data-testid="' + tid + '"] ' + tag });
    return out;
  };

  return new Promise((res) => {
    const prev = document.body.style.cursor;
    document.body.style.cursor = 'crosshair';
    const onClick = (e) => {
      e.preventDefault(); e.stopPropagation();
      document.removeEventListener('click', onClick, true);
      document.body.style.cursor = prev;
      const el = e.target;
      res({
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || '').trim().slice(0, 60),
        candidates: rank(el),
        outerHTML: el.outerHTML.slice(0, 400),
      });
    };
    document.addEventListener('click', onClick, true);
  });
})()
`;
async function main() {
    const pick = process.argv.includes("--pick");
    const a = await attach();
    const page = a.page;
    console.log(`\nattached to: ${page.url()}\n`);
    if (pick) {
        console.log("👉 Click the element you want in the Chrome window…\n");
        const r = (await page.evaluate(PICKER));
        console.log(`<${r.tag}>  "${r.text}"\n`);
        console.log("Paste into config/selectors.snorkel.json:\n");
        console.log(JSON.stringify({ description: r.text || r.tag, candidates: r.candidates }, null, 2));
        console.log(`\nouterHTML:\n${r.outerHTML}\n`);
        await detach(a);
        return;
    }
    // Audit: which configured selectors actually resolve on the page in front of us?
    let found = 0, missing = 0, unconfirmed = 0;
    for (const [key, def] of Object.entries(CONFIG.elements)) {
        const tokens = key.includes("{") ? {} : {};
        const flag = isUnconfirmed(key) ? " (UNCONFIRMED in config)" : "";
        try {
            const loc = await resolve_(page, key, { tokens, timeoutMs: 1200 });
            const n = await loc.count();
            console.log(`✅ ${key.padEnd(42)} ${n} match${n === 1 ? "" : "es"}${flag}`);
            found++;
            if (flag)
                unconfirmed++;
        }
        catch {
            console.log(`❌ ${key.padEnd(42)} not on this page${flag}  ${def.description ? `— ${def.description}` : ""}`);
            missing++;
        }
    }
    console.log(`\n${found} resolved, ${missing} not on this page.`);
    if (unconfirmed) {
        console.log(`⚠️  ${unconfirmed} resolved via a candidate marked $unconfirmed — remove the flag in the config to trust it.`);
    }
    console.log(`\n(Selectors for other pages will show as "not on this page" — that's expected. Run this on the page you care about.)\n`);
    await detach(a);
}
main().catch((e) => {
    console.error(`\n💥 ${e.message}\n`);
    process.exit(1);
});
