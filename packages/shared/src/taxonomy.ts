/**
 * Maps the human labels in a task blob to the closed vocabularies `task.toml` requires.
 *
 * `validate_task_fields` is a blocking CI check, so Claude must never be left to guess
 * these. The mapped values get injected into the build prompt as hard facts.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const TAXONOMY_PATH = resolve(HERE, "../../../config/taxonomy.json");

interface TaxonomyFile {
  category: Record<string, string | string[]>;
  subcategory: Record<string, string | string[]>;
  language: Record<string, string | string[]>;
}

let cached: TaxonomyFile | null = null;

function load(): TaxonomyFile {
  cached ??= JSON.parse(readFileSync(TAXONOMY_PATH, "utf8")) as TaxonomyFile;
  return cached;
}

/**
 * Fold a human label down to one canonical shape, so the table needs ONE key per concept instead
 * of one key per spelling.
 *
 * Snorkel's platform writes categories as display labels — "Security & Cryptography",
 * "Machine Learning & AI" — and the blob is pasted straight out of it. The old lookup only
 * lowercased, so every ampersand needed its own duplicate key ("machine learning & ai" AND
 * "machine learning and ai"), and the first label nobody had thought of threw. That is exactly how
 * "Security & Cryptography" failed: there was no key for it, and somebody "fixed" it by pasting the
 * LABEL into $allowed — which is the list of task.toml ENUM values — so the error message ended up
 * saying the value was unknown while listing it as allowed.
 *
 * Normalising kills the whole class:
 *
 *   "Security & Cryptography"   ->  "security and cryptography"
 *   "security and cryptography" ->  "security and cryptography"
 *   "Security  &  Cryptography" ->  "security and cryptography"
 *   "Security/Cryptography"     ->  "security cryptography"   (still distinct — see below)
 *
 * Deliberately NOT collapsed: word order, and the words themselves. This normalises SPELLING, not
 * MEANING. A label we do not recognise must still throw, because guessing a category wrong is a
 * blocked-category rejection at Snorkel's CI, forty-five minutes after the guess.
 */
export function normaliseLabel(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9+#.]+/g, " ") // keep c++, c#, .net — strip the rest to spaces
    .trim()
    .replace(/\s+/g, " ");
}

function lookup(table: Record<string, string | string[]>, label: string): string | null {
  const want = normaliseLabel(label);
  for (const [key, value] of Object.entries(table)) {
    if (key.startsWith("$")) continue; // $comment / $allowed / $blocked are metadata, not entries
    if (typeof value !== "string") continue;
    if (normaliseLabel(key) === want) return value;
  }
  return null;
}

/** Every label the table recognises — for an error message that is actually actionable. */
function knownLabels(table: Record<string, string | string[]>): string[] {
  return Object.keys(table).filter((k) => !k.startsWith("$") && typeof table[k] === "string");
}

export interface TaskToml {
  category: string;
  subcategories: string[];
  languages: string[];
}

export class TaxonomyError extends Error {}

/**
 * The categories Snorkel is not currently accepting, read from config/taxonomy.json.
 *
 * This is exported so the GATE can ask for the list rather than keep its own copy. lint.ts
 * had its own hardcoded `new Set(["software-engineering", "debugging", "data-processing"])`,
 * which is fine right up until Snorkel blocks a fourth category: someone updates
 * taxonomy.json, the parse step starts rejecting it, and the gate — the last line of defence,
 * the one that checks the task.toml Claude actually wrote — goes on waving it through,
 * because nobody remembered there were two lists.
 */
export function blockedCategories(): string[] {
  const t = load();
  return ((t.category.$blocked as { categories?: string[] } | undefined)?.categories) ?? [];
}

/**
 * Turn the parsed blob's human labels into task.toml enum values.
 *
 * Unknown labels throw rather than silently passing through: an invalid enum in
 * task.toml fails Snorkel's CI, and finding out at the Check-feedback stage costs
 * a full build cycle. Better to stop at parse time, where a human is already looking.
 */
export function toTaskToml(parsed: {
  category: string;
  sub_category: string;
  languages: string;
}): TaskToml {
  const t = load();

  const category = lookup(t.category, parsed.category);
  if (!category) {
    // The old message listed $allowed — the task.toml ENUM values — at somebody who had just
    // pasted a LABEL. So it answered a question nobody asked ("which enums are legal?") instead of
    // the one they had ("what do I write, and where?"), and the obvious "fix" was to paste the
    // label into $allowed, which made the error contradict itself: unknown, and listed as allowed.
    throw new TaxonomyError(
      `Unknown category ${JSON.stringify(parsed.category)}.\n\n` +
        `It is not a task.toml value — it is the label Snorkel's platform shows — so it has to be ` +
        `MAPPED to one. Add a line to the "category" table in config/taxonomy.json:\n\n` +
        `    "${normaliseLabel(parsed.category)}": "<one of: ${(t.category.$allowed as string[]).join(" | ")}>"\n\n` +
        `Labels currently recognised:\n` +
        knownLabels(t.category).map((l) => `  - ${l}  ->  ${t.category[l] as string}`).join("\n"),
    );
  }

  // Snorkel is not currently accepting these. Reject at parse time — the human is looking
  // at the preview right now, and discovering this after a 45-minute build would be waste.
  const blocked = ((t.category.$blocked as { categories?: string[] } | undefined)?.categories) ?? [];
  if (blocked.includes(category)) {
    throw new TaxonomyError(
      `Category "${parsed.category}" resolves to "${category}", which Snorkel is NOT currently accepting.\n` +
        `Blocked categories: ${blocked.join(", ")}.\n\n` +
        `Pick a different task, or if this one genuinely belongs to an accepted category, ` +
        `correct the category line in the task text.`,
    );
  }

  const subcategories: string[] = [];
  for (const raw of parsed.sub_category.split(",").map((s) => s.trim()).filter(Boolean)) {
    const sub = lookup(t.subcategory, raw);
    if (!sub) {
      throw new TaxonomyError(
        `Unknown sub-category ${JSON.stringify(raw)}.\n\n` +
          `Add a line to the "subcategory" table in config/taxonomy.json:\n\n` +
          `    "${normaliseLabel(raw)}": "<one of: ${(t.subcategory.$allowed as string[]).join(" | ")}>"\n\n` +
          `Labels currently recognised:\n` +
          knownLabels(t.subcategory).map((l) => `  - ${l}  ->  ${t.subcategory[l] as string}`).join("\n"),
      );
    }
    if (!subcategories.includes(sub)) subcategories.push(sub);
  }

  const languages: string[] = [];
  for (const raw of parsed.languages.split(",").map((s) => s.trim()).filter(Boolean)) {
    const lang = lookup(t.language, raw);
    if (!lang) {
      throw new TaxonomyError(
        `Unknown language ${JSON.stringify(raw)}. Add it to config/taxonomy.json.`,
      );
    }
    if (!languages.includes(lang)) languages.push(lang);
  }

  return { category, subcategories, languages };
}
