/**
 * Selector resolution, driven entirely by config/selectors.snorkel.json.
 *
 * The rule this file exists to enforce: NO selector string appears in any logic file.
 * When Snorkel ships a redesign, the fix is a config edit, not a code change — and
 * `npm run selectors:record` regenerates the candidates for you.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT } from "../../../../packages/shared/src/paths.ts";
let cached = null;
function load() {
    cached ??= JSON.parse(readFileSync(resolve(REPO_ROOT, "config/selectors.snorkel.json"), "utf8"));
    return cached;
}
export function pageUrl(key) {
    const u = load().pages[key];
    if (!u)
        throw new Error(`No page "${key}" in config/selectors.snorkel.json`);
    return u;
}
/**
 * A selector that is still a guess was about to be used to DO something.
 *
 * `"$unconfirmed": true` in the config means "nobody has ever watched this resolve against
 * the real page". Two elements carry it, and they are the two that matter most: the Submit
 * button (irreversible) and the generate-rubric checkbox (can overwrite a rubric). Both have
 * generic fallback candidates — `button[type=submit]` will happily match some OTHER form's
 * button and report success.
 *
 * The flag existed, but nothing checked it at runtime: `isUnconfirmed()` was imported only
 * by the recorder CLI. So the pipeline would have clicked a placeholder Submit for real.
 * Now it refuses, and the task parks at NEEDS_HUMAN until someone pins the selector.
 */
export class UnconfirmedSelector extends Error {
    key;
    constructor(key) {
        super(`Refusing to act on "${key}": it is still marked "$unconfirmed" in ` +
            `config/selectors.snorkel.json — an educated guess that has never been seen to ` +
            `resolve against the real page.\n\n` +
            `This guard exists because the fallback candidates are generic enough to match the ` +
            `WRONG element and still look like they worked.\n\n` +
            `Pin it, then delete the "$unconfirmed" flag:\n` +
            `  bash scripts/launch-chrome.sh          # open the submission page\n` +
            `  npm run selectors:record -- --pick     # click the element; paste the candidates`);
        this.name = "UnconfirmedSelector";
        this.key = key;
    }
}
/** Call before any selector is used to CLICK, TICK or SUBMIT — never for a read. */
export function assertConfirmed(key) {
    if (isUnconfirmed(key))
        throw new UnconfirmedSelector(key);
}
export class SelectorNotFound extends Error {
    key;
    constructor(key, description, tried) {
        super(`Could not find "${key}"${description ? ` (${description})` : ""} on the page.\n` +
            `Tried ${tried.length} candidate(s):\n${tried.map((t) => `  - ${t}`).join("\n")}\n\n` +
            `The page has probably changed. Re-record it:\n` +
            `  npm run selectors:record -- ${key}\n` +
            `then update config/selectors.snorkel.json. No code change is needed.`);
        this.name = "SelectorNotFound";
        this.key = key;
    }
}
function describe(c) {
    switch (c.by) {
        case "testid": return `[data-testid="${c.value}"]`;
        case "css": return c.value;
        case "text": return `text=${c.value}`;
        case "label": return `label=${c.value}`;
        case "role": return `role=${c.role}${c.name ? `[name=${c.name}]` : ""}`;
    }
}
function build(root, c, tokens) {
    const sub = (s) => s.replace(/\{(\w+)\}/g, (_m, k) => String(tokens[k] ?? `{${k}}`));
    switch (c.by) {
        case "testid": return root.locator(`[data-testid="${sub(c.value)}"]`);
        case "css": return root.locator(sub(c.value));
        case "text": return root.locator(`text=${sub(c.value)}`);
        case "label": return root.locator(`label:has-text("${sub(c.value)}")`);
        case "role": {
            const name = c.name ? sub(c.name) : undefined;
            // A /…/i name in the config means a regex, matching Playwright's own convention.
            const rx = name && /^\/.*\/[a-z]*$/.test(name);
            const nameOpt = name
                ? rx
                    ? new RegExp(name.slice(1, name.lastIndexOf("/")), name.slice(name.lastIndexOf("/") + 1))
                    : name
                : undefined;
            return root.getByRole(c.role, {
                ...(nameOpt !== undefined ? { name: nameOpt } : {}),
                ...(c.exact !== undefined ? { exact: c.exact } : {}),
            });
        }
    }
}
/**
 * Walk the candidates in order and return the first that actually exists.
 *
 * `hidden: true` elements (the zip <input type=file> is class="hidden") are matched on
 * attachment rather than visibility — otherwise Playwright would correctly report that a
 * hidden input isn't visible, and we'd conclude the page had changed when it hadn't.
 */
export async function resolve_(page, key, opts = {}) {
    const def = load().elements[key];
    if (!def)
        throw new Error(`No element "${key}" in config/selectors.snorkel.json`);
    const tokens = opts.tokens ?? {};
    const timeout = opts.timeoutMs ?? 10_000;
    const root = def.scope
        ? await resolve_(page, def.scope, { tokens, timeoutMs: timeout })
        : page;
    const tried = [];
    for (const c of def.candidates) {
        const loc = build(root, c, tokens).first();
        tried.push(describe(c));
        try {
            await loc.waitFor({ state: def.hidden ? "attached" : "visible", timeout: timeout / def.candidates.length });
            return loc;
        }
        catch {
            // fall through to the next candidate
        }
    }
    throw new SelectorNotFound(key, def.description, tried);
}
/**
 * Every match, not just the first — for counting.
 *
 * resolve_() ends in `.first()`, which is right for acting on an element and useless for
 * counting one: `(await resolve_(…)).count()` can only ever return 0 or 1, so a count built on
 * it silently reports 1 no matter how many cards are on the page. The revise-queue gate needs a
 * real count, and a gate that miscounts in the low direction submits when it should refuse.
 *
 * Returns 0 matches rather than throwing — "none of them are there" is a legitimate answer to
 * "how many are there", unlike for resolve_(), where it is a broken selector.
 */
export async function resolveAll(page, key, opts = {}) {
    const def = load().elements[key];
    if (!def)
        throw new Error(`No element "${key}" in config/selectors.snorkel.json`);
    const tokens = opts.tokens ?? {};
    const root = def.scope ? await resolve_(page, def.scope, { tokens }) : page;
    for (const c of def.candidates) {
        const loc = build(root, c, tokens);
        if ((await loc.count()) > 0)
            return loc;
    }
    return null;
}
/** Present-or-not, without throwing. For "did a verdict appear yet?" style polling. */
export async function exists(page, key, opts = {}) {
    try {
        await resolve_(page, key, { timeoutMs: 1500, ...opts });
        return true;
    }
    catch {
        return false;
    }
}
export function isUnconfirmed(key) {
    return load().elements[key]?.$unconfirmed === true;
}
