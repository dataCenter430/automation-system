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

function lookup(table: Record<string, string | string[]>, label: string): string | null {
  const hit = table[label.trim().toLowerCase()];
  return typeof hit === "string" ? hit : null;
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
    throw new TaxonomyError(
      `Unknown category ${JSON.stringify(parsed.category)}. ` +
        `Add it to config/taxonomy.json (allowed values: ${(t.category.$allowed as string[]).join(", ")}).`,
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
        `Unknown sub-category ${JSON.stringify(raw)}. ` +
          `Add it to config/taxonomy.json (allowed values: ${(t.subcategory.$allowed as string[]).join(", ")}).`,
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
