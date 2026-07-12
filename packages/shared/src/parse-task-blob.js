/**
 * Splits a pasted Terminus task blob into the `terminus` table columns.
 *
 * Expected shape:
 *
 *   Interactive Challenges & Games/Long Context, DB Interaction   <- category/sub_category
 *                                                                 <- blank
 *   Automate C Graphviz Worker for Stained-Glass Vault Replays     <- title
 *                                                                 <- blank
 *   <description, one or MORE paragraphs>
 *                                                                 <- blank
 *   C                                                             <- languages, one per line
 *   SQL
 *   POSIX shell
 *   Additional Inspiration                                        <- literal marker
 *   <additional_note>
 *
 * We parse from the END, not the top. The description can be multiple paragraphs,
 * so "block 3 is the description" is wrong. Anchoring on the `Additional Inspiration`
 * marker and the language block (which is always last) makes the description
 * whatever is left over, however many paragraphs that is.
 */
export class ParseError extends Error {
    // Declared as a field rather than a constructor parameter property: Node's
    // --experimental-strip-types only erases types, and parameter properties emit code.
    blocks;
    constructor(message, blocks) {
        const dump = blocks.map((b, i) => `  [${i}] ${JSON.stringify(b.slice(0, 80))}`).join("\n");
        super(`${message}\n\nBlocks found (${blocks.length}):\n${dump}`);
        this.name = "ParseError";
        this.blocks = blocks;
    }
}
const ADDITIONAL_INSPIRATION = /^[ \t]*Additional Inspiration[ \t]*:?[ \t]*$/i;
/** A language block is a run of short lines with no sentence punctuation. */
function looksLikeLanguageBlock(block) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0)
        return false;
    return lines.every((l) => l.length <= 30 && !/[.?!,;:]$/.test(l));
}
export function parseTaskBlob(raw) {
    // Fenced `---` delimiters are how the blob gets pasted around; they are not content.
    const text = raw
        .replace(/\r\n?/g, "\n")
        .replace(/^\s*(?:---|===+)\s*$/gm, "")
        .split("\n")
        .map((l) => l.replace(/[ \t]+$/, ""))
        .join("\n")
        .trim();
    if (!text)
        throw new ParseError("Task blob is empty.", []);
    // 1. Peel off the Additional Inspiration tail (last occurrence wins).
    let body = text;
    let additional_note = null;
    const lines = text.split("\n");
    let markerIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
        if (ADDITIONAL_INSPIRATION.test(lines[i])) {
            markerIdx = i;
            break;
        }
    }
    if (markerIdx !== -1) {
        body = lines.slice(0, markerIdx).join("\n").trim();
        const tail = lines.slice(markerIdx + 1).join("\n").trim();
        additional_note = tail || null;
    }
    // 2. Split what's left into blank-line-separated blocks.
    const blocks = body
        .split(/\n[ \t]*\n+/)
        .map((b) => b.trim())
        .filter(Boolean);
    if (blocks.length < 4) {
        throw new ParseError("Expected at least 4 blocks (category line, title, description, languages). " +
            "Check the blob has blank lines between sections.", blocks);
    }
    // 3. Block 0: "Category/Sub A, Sub B" — split on the FIRST slash only.
    const header = blocks[0].replace(/\n/g, " ").trim();
    const slash = header.indexOf("/");
    if (slash === -1) {
        throw new ParseError(`First block must be "Category/Sub-category", got: ${JSON.stringify(header)}`, blocks);
    }
    const category = header.slice(0, slash).trim();
    const sub_category = header.slice(slash + 1).trim();
    if (!category || !sub_category) {
        throw new ParseError(`Category or sub-category is empty in: ${JSON.stringify(header)}`, blocks);
    }
    // 4. Block 1: title.
    const title = blocks[1].replace(/\n/g, " ").trim();
    if (!title)
        throw new ParseError("Title block is empty.", blocks);
    // 5. Last block: languages, one per line.
    const langBlock = blocks[blocks.length - 1];
    if (!looksLikeLanguageBlock(langBlock)) {
        throw new ParseError("The last block does not look like a language list (expected short lines such as " +
            `"C" / "SQL" / "POSIX shell"). Got: ${JSON.stringify(langBlock.slice(0, 120))}`, blocks);
    }
    const languages = langBlock
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .join(", ");
    // 6. Everything between title and languages is the description — any number of paragraphs.
    const description = blocks.slice(2, blocks.length - 1).join("\n\n").trim();
    if (!description)
        throw new ParseError("Description is empty.", blocks);
    return { category, sub_category, title, description, languages, additional_note };
}
