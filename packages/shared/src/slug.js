/**
 * Title -> short kebab slug, used for the workspace dir AND the zip filename.
 *
 * Matches the convention already in E:\Work\Snorkel\Working:
 *   "Automate C Graphviz Worker for Stained-Glass Vault Replays"
 *     -> automate-c-graphviz-worker-stained-glass-vault
 *   "Harden Go MLflow Build Locks"  -> harden-go-mlflow-build-locks
 *
 * Those existing names are human-shortened and not perfectly consistent (some keep
 * "for"/"with", some don't), so this produces a sane default that the dashboard
 * lets you override before the build starts.
 */
const STOPWORDS = new Set(["a", "an", "the", "for", "of", "to", "and", "or", "on", "in"]);
const MAX_WORDS = 7;
export function slugify(title, maxWords = MAX_WORDS) {
    const words = title
        .toLowerCase()
        .replace(/[''']/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
    // Keep the leading verb even if it somehow lands in STOPWORDS; drop stopwords elsewhere.
    const kept = words.filter((w, i) => i === 0 || !STOPWORDS.has(w));
    const slug = kept.slice(0, maxWords).join("-");
    if (!slug)
        throw new Error(`Could not derive a slug from title: ${JSON.stringify(title)}`);
    return slug;
}
/** Filesystem-safe check — we build directories and zip files from this. */
export function assertValidSlug(slug) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
        throw new Error(`Invalid slug ${JSON.stringify(slug)} — must be lowercase kebab-case (a-z, 0-9, single hyphens).`);
    }
    if (slug.length > 80)
        throw new Error(`Slug too long (${slug.length} chars): ${slug}`);
}
