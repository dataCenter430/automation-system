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
  /**
   * Labels we did not recognise and passed through anyway.
   *
   * Shown in the preview so the human can see what we guessed, but NEVER fatal. See below.
   */
  warnings: string[];
}

export class TaxonomyError extends Error {}

/**
 * AN UNKNOWN LABEL IS NOT AN ERROR.
 *
 * This used to throw on anything the table did not know, and it was wrong twice in one day:
 * "Security & Cryptography" (a spelling we had not listed) and then "HCL" (a language we had never
 * seen). Both were perfectly good tasks, and both were refused at the door by OUR lookup table
 * rather than by anything Snorkel actually requires.
 *
 * Snorkel adds languages and categories whenever it likes. A closed table on our side is a promise
 * we cannot keep, and every new value it does not contain is an operator staring at a paste box
 * being told to go and edit a JSON file. `languages` is free-form in task.toml anyway — the
 * playbook's own template is just `languages = ["bash"]`.
 *
 * So: an unrecognised label is SLUGIFIED into the shape task.toml wants, passed through, and
 * reported as a warning. If we guessed wrong, Snorkel's `validate_task_fields` will say so, and
 * that is a check that is actually authoritative — unlike this file.
 *
 * -------------------------------------------------------------------------------------------
 * WITH EXACTLY ONE EXCEPTION, AND IT STAYS.
 *
 * A BLOCKED category is still refused, loudly, at paste time. That is not vocabulary validation —
 * it is the guard that caught two of our three rejections (software-engineering 0.95,
 * data-processing 0.90). Slugifying an unknown label actually makes it STRONGER: "Software
 * Engineering" now folds to "software-engineering" and is refused whether or not anyone remembered
 * to map it.
 */
function slugifyCategory(label: string): string {
  return normaliseLabel(label).replace(/\s+/g, "-");
}
function slugifySub(label: string): string {
  return normaliseLabel(label).replace(/\s+/g, "_");
}
function slugifyLanguage(label: string): string {
  // Languages are free-form. Keep it recognisable: "HCL" -> "hcl", "F#" -> "f#", "Objective-C"
  // -> "objective-c". No hyphen-to-underscore games; this is a name, not an enum.
  return label.trim().toLowerCase().replace(/\s+/g, "-");
}

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
  const warnings: string[] = [];

  // ---- category: mapped if we know it, slugified if we do not. NEVER fatal for being unknown. --
  const category = lookup(t.category, parsed.category) ?? slugifyCategory(parsed.category);
  if (!lookup(t.category, parsed.category)) {
    warnings.push(
      `Category "${parsed.category}" is not in config/taxonomy.json — using "${category}". ` +
        `If that is wrong, Snorkel's validate_task_fields will say so; add a mapping to silence this.`,
    );
  }

  // ---- THE ONE REFUSAL THAT STAYS -------------------------------------------------------------
  //
  // Snorkel is not currently accepting these, and a task that is one of them is rejected outright
  // — after a 45-minute build, if nobody catches it here. This is not vocabulary validation; it is
  // the guard that caught two of our three rejections.
  //
  // Slugifying unknowns makes it STRONGER, not weaker: "Software Engineering" folds to
  // "software-engineering" and is refused whether or not anyone remembered to map it.
  const blocked = ((t.category.$blocked as { categories?: string[] } | undefined)?.categories) ?? [];
  if (blocked.includes(category)) {
    throw new TaxonomyError(
      `Category "${parsed.category}" resolves to "${category}", which Snorkel is NOT currently accepting.\n` +
        `Blocked categories: ${blocked.join(", ")}.\n\n` +
        `Pick a different task, or if this one genuinely belongs to an accepted category, ` +
        `correct the category line in the task text.`,
    );
  }

  // ---- subcategories: same rule. ---------------------------------------------------------------
  const subcategories: string[] = [];
  for (const raw of parsed.sub_category.split(/[,/]/).map((s) => s.trim()).filter(Boolean)) {
    const sub = lookup(t.subcategory, raw) ?? slugifySub(raw);
    if (!lookup(t.subcategory, raw)) {
      warnings.push(`Sub-category "${raw}" is not in config/taxonomy.json — using "${sub}".`);
    }
    if (!subcategories.includes(sub)) subcategories.push(sub);
  }

  // ---- languages: FREE-FORM in task.toml. There is nothing here to validate against. -----------
  //
  // The template in the playbook is literally `languages = ["bash"]`. There is no closed
  // vocabulary, so the only job of the table is to stop the SAME language appearing under two
  // spellings (c++ / cpp). An unknown one is just a language we have not seen — "HCL" was, and it
  // stopped a perfectly good task at the paste box.
  const languages: string[] = [];
  for (const raw of parsed.languages.split(/[,/\n]/).map((s) => s.trim()).filter(Boolean)) {
    const lang = lookup(t.language, raw) ?? slugifyLanguage(raw);
    if (!languages.includes(lang)) languages.push(lang);
  }

  return { category, subcategories, languages, warnings };
}
