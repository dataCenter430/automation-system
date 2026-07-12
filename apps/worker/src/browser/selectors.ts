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
import type { Locator, Page } from "playwright";

type Candidate =
  | { by: "testid"; value: string }
  | { by: "css"; value: string }
  | { by: "text"; value: string }
  | { by: "label"; value: string }
  | { by: "role"; role: string; name?: string; exact?: boolean };

interface ElementDef {
  description?: string;
  scope?: string;
  hidden?: boolean;
  $unconfirmed?: boolean;
  candidates: Candidate[];
}

interface SelectorFile {
  pages: Record<string, string>;
  elements: Record<string, ElementDef>;
}

let cached: SelectorFile | null = null;

function load(): SelectorFile {
  cached ??= JSON.parse(
    readFileSync(resolve(REPO_ROOT, "config/selectors.snorkel.json"), "utf8"),
  ) as SelectorFile;
  return cached;
}

export function pageUrl(key: string): string {
  const u = load().pages[key];
  if (!u) throw new Error(`No page "${key}" in config/selectors.snorkel.json`);
  return u;
}

export class SelectorNotFound extends Error {
  key: string;
  constructor(key: string, description: string | undefined, tried: string[]) {
    super(
      `Could not find "${key}"${description ? ` (${description})` : ""} on the page.\n` +
        `Tried ${tried.length} candidate(s):\n${tried.map((t) => `  - ${t}`).join("\n")}\n\n` +
        `The page has probably changed. Re-record it:\n` +
        `  npm run selectors:record -- ${key}\n` +
        `then update config/selectors.snorkel.json. No code change is needed.`,
    );
    this.name = "SelectorNotFound";
    this.key = key;
  }
}

function describe(c: Candidate): string {
  switch (c.by) {
    case "testid": return `[data-testid="${c.value}"]`;
    case "css":    return c.value;
    case "text":   return `text=${c.value}`;
    case "label":  return `label=${c.value}`;
    case "role":   return `role=${c.role}${c.name ? `[name=${c.name}]` : ""}`;
  }
}

function build(root: Page | Locator, c: Candidate, tokens: Record<string, string | number>): Locator {
  const sub = (s: string) =>
    s.replace(/\{(\w+)\}/g, (_m, k: string) => String(tokens[k] ?? `{${k}}`));

  switch (c.by) {
    case "testid": return root.locator(`[data-testid="${sub(c.value)}"]`);
    case "css":    return root.locator(sub(c.value));
    case "text":   return root.locator(`text=${sub(c.value)}`);
    case "label":  return root.locator(`label:has-text("${sub(c.value)}")`);
    case "role": {
      const name = c.name ? sub(c.name) : undefined;
      // A /…/i name in the config means a regex, matching Playwright's own convention.
      const rx = name && /^\/.*\/[a-z]*$/.test(name);
      const nameOpt = name
        ? rx
          ? new RegExp(name.slice(1, name.lastIndexOf("/")), name.slice(name.lastIndexOf("/") + 1))
          : name
        : undefined;
      return root.getByRole(c.role as any, {
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
export async function resolve_(
  page: Page,
  key: string,
  opts: { tokens?: Record<string, string | number>; timeoutMs?: number } = {},
): Promise<Locator> {
  const def = load().elements[key];
  if (!def) throw new Error(`No element "${key}" in config/selectors.snorkel.json`);

  const tokens = opts.tokens ?? {};
  const timeout = opts.timeoutMs ?? 10_000;

  const root: Page | Locator = def.scope
    ? await resolve_(page, def.scope, { tokens, timeoutMs: timeout })
    : page;

  const tried: string[] = [];
  for (const c of def.candidates) {
    const loc = build(root, c, tokens).first();
    tried.push(describe(c));
    try {
      await loc.waitFor({ state: def.hidden ? "attached" : "visible", timeout: timeout / def.candidates.length });
      return loc;
    } catch {
      // fall through to the next candidate
    }
  }
  throw new SelectorNotFound(key, def.description, tried);
}

/** Present-or-not, without throwing. For "did a verdict appear yet?" style polling. */
export async function exists(
  page: Page,
  key: string,
  opts: { tokens?: Record<string, string | number>; timeoutMs?: number } = {},
): Promise<boolean> {
  try {
    await resolve_(page, key, { timeoutMs: 1500, ...opts });
    return true;
  } catch {
    return false;
  }
}

export function isUnconfirmed(key: string): boolean {
  return load().elements[key]?.$unconfirmed === true;
}
