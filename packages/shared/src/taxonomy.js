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
let cached = null;
function load() {
    cached ??= JSON.parse(readFileSync(TAXONOMY_PATH, "utf8"));
    return cached;
}
function lookup(table, label) {
    const hit = table[label.trim().toLowerCase()];
    return typeof hit === "string" ? hit : null;
}
export class TaxonomyError extends Error {
}
/**
 * Turn the parsed blob's human labels into task.toml enum values.
 *
 * Unknown labels throw rather than silently passing through: an invalid enum in
 * task.toml fails Snorkel's CI, and finding out at the Check-feedback stage costs
 * a full build cycle. Better to stop at parse time, where a human is already looking.
 */
export function toTaskToml(parsed) {
    const t = load();
    const category = lookup(t.category, parsed.category);
    if (!category) {
        throw new TaxonomyError(`Unknown category ${JSON.stringify(parsed.category)}. ` +
            `Add it to config/taxonomy.json (allowed values: ${t.category.$allowed.join(", ")}).`);
    }
    // Snorkel is not currently accepting these. Reject at parse time — the human is looking
    // at the preview right now, and discovering this after a 45-minute build would be waste.
    const subcategories = [];
    for (const raw of parsed.sub_category.split(",").map((s) => s.trim()).filter(Boolean)) {
        const sub = lookup(t.subcategory, raw);
        if (!sub) {
            throw new TaxonomyError(`Unknown sub-category ${JSON.stringify(raw)}. ` +
                `Add it to config/taxonomy.json (allowed values: ${t.subcategory.$allowed.join(", ")}).`);
        }
        if (!subcategories.includes(sub))
            subcategories.push(sub);
    }
    const languages = [];
    for (const raw of parsed.languages.split(",").map((s) => s.trim()).filter(Boolean)) {
        const lang = lookup(t.language, raw);
        if (!lang) {
            throw new TaxonomyError(`Unknown language ${JSON.stringify(raw)}. Add it to config/taxonomy.json.`);
        }
        if (!languages.includes(lang))
            languages.push(lang);
    }
    return { category, subcategories, languages };
}
