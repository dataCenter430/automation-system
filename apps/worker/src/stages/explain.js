/**
 * The style filter for the three submission-form explanations.
 *
 * Generation happens in the build session (see explain-generate.ts) — Claude writes them to
 * a file and we read the file. This module is the part that decides whether what came back
 * is usable.
 *
 * It exists because the Snorkel docs explicitly ban LLM-tell prose. Generating these with
 * an LLM and then shipping them unread would be self-defeating, so anything that fails
 * validation goes back for a rewrite with the specific complaint attached.
 */
/** The words that make a paragraph read as machine-written. */
const TELLS = [
    "delve", "moreover", "furthermore", "it's worth noting", "it is worth noting",
    "additionally", "leverage", "robust", "comprehensive", "seamless", "crucial",
    "pivotal", "underscore", "multifaceted", "in conclusion", "notably",
];
const HUMAN_OPENERS = [
    "i am sure", "i'm sure", "i think", "i found", "i made", "i built", "i wrote",
    "i believe", "i chose", "i designed", "i tried", "i know", "the tricky part",
    "the hard part", "my main", "honestly", "what makes",
];
function countSentences(s) {
    return s.split(/[.!?]+(?:\s|$)/).map((x) => x.trim()).filter(Boolean).length;
}
/** Returns human-readable complaints; empty means it passed. */
export function validateExplanation(name, text) {
    const problems = [];
    const lower = text.toLowerCase();
    const sentences = countSentences(text);
    if (sentences !== 4) {
        problems.push(`${name}: needs exactly 4 sentences, has ${sentences}.`);
    }
    const words = text.trim().split(/\s+/).length;
    if (words < 40 || words > 110) {
        problems.push(`${name}: should be roughly 60-90 words, has ${words}.`);
    }
    if (text.includes("—") || text.includes("–")) {
        problems.push(`${name}: contains an em-dash or en-dash. Use commas or full stops.`);
    }
    const found = TELLS.filter((t) => lower.includes(t));
    if (found.length) {
        problems.push(`${name}: contains LLM-tell words: ${found.join(", ")}. Rewrite plainly.`);
    }
    if (/^\s*[-*#>]|\n\s*[-*]\s/.test(text)) {
        problems.push(`${name}: contains markdown or bullets. It must be plain prose.`);
    }
    if (!HUMAN_OPENERS.some((o) => lower.startsWith(o))) {
        problems.push(`${name}: must open the way a person would ("I am sure...", "I think...", "I found that...").`);
    }
    return problems;
}
