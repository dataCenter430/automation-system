import { resolve_, resolveAll, exists, pageUrl } from "../browser/selectors.ts";
import { snap } from "../browser/actions.ts";
import { withScratchPage } from "../browser/cdp.ts";
/** The rule. Under this, we may submit; at it or above, we may not. */
export const QUEUE_LIMIT = 10;
/**
 * Could not establish the queue size. NOT the same as "the queue is empty".
 *
 * Thrown rather than returned as a number, because every numeric return type here invites a
 * caller to treat a failure as a zero.
 */
export class QueueUnreadable extends Error {
    constructor(why) {
        super(`Refusing to submit: could not read the revision queue size from the home page (${why}).\n\n` +
            `The rule is "only submit when the revision queue is under ${QUEUE_LIMIT}", and we cannot ` +
            `confirm that. Counting the cards instead is NOT an acceptable fallback: the owner-filter ` +
            `userscript and Snorkel's search box both HIDE cards, so a count can read 4 when the queue ` +
            `holds 14 — and that error points straight at submitting when we must not.\n\n` +
            `Open ${pageUrl("home")} and check that "N tasks to be revised" is on the page.`);
        this.name = "QueueUnreadable";
    }
}
/** "14 tasks to be revised" -> 14. Also tolerates "1 task to be revised". */
export function parseQueueCount(text) {
    const m = /(\d+)\s+tasks?\s+to\s+be\s+revised/i.exec(text);
    if (!m)
        return null;
    const n = Number(m[1]);
    return Number.isInteger(n) && n >= 0 ? n : null;
}
/**
 * Read the queue, in its own tab.
 *
 * Its own tab matters: the caller is usually holding a filled submission form, and navigating
 * that tab to /home would destroy it. (This is the same bug that findSubmitted() was fixed for.)
 */
export async function readQueue(a, runDir) {
    return withScratchPage(a, pageUrl("home"), async (page) => {
        await snap(page, runDir, "queue-gate");
        return readQueueFrom(page);
    });
}
/** Split out from readQueue so it can be tested against a real page without the CDP layer. */
export async function readQueueFrom(page) {
    let sentence;
    try {
        sentence = (await (await resolve_(page, "home.reviseQueueCount", { timeoutMs: 8000 })).innerText()).trim();
    }
    catch {
        throw new QueueUnreadable("the 'N tasks to be revised' line is not on the page");
    }
    const total = parseQueueCount(sentence);
    if (total === null) {
        throw new QueueUnreadable(`the line read ${JSON.stringify(sentence.slice(0, 80))}, which has no count in it`);
    }
    const filtered = await exists(page, "home.ownerFilterBadge", { timeoutMs: 1000 });
    // Counted, therefore filterable, therefore only ever used to make the gate STRICTER.
    const cardsVisible = await countOrZero(page, "home.reviseCardAny");
    const terminus = await countOrZero(page, "home.reviseCardTerminus");
    const overTotal = total >= QUEUE_LIMIT;
    const overTerminus = terminus >= QUEUE_LIMIT;
    const maySubmit = !overTotal && !overTerminus;
    const bits = [`${total} in the queue`, `${terminus} of them Terminus`];
    if (filtered)
        bits.push("owner filter ACTIVE — card counts are unreliable");
    else if (cardsVisible !== total)
        bits.push(`only ${cardsVisible} cards in the DOM — something is hiding rows`);
    const reason = maySubmit
        ? `Queue is clear: ${bits.join(", ")} (limit ${QUEUE_LIMIT}).`
        : `BLOCKED — ${bits.join(", ")}. The rule is: no new submission while the revision queue is at ` +
            `${QUEUE_LIMIT} or more (${overTotal ? "the total" : ""}${overTotal && overTerminus ? " and " : ""}` +
            `${overTerminus ? "the Terminus count" : ""} is over). Clear a revision first — revisions are ` +
            `never gated, and they are what drains this queue.`;
    return { total, terminus, cardsVisible, filtered, maySubmit, reason };
}
/**
 * How many of them are there?
 *
 * Must go through resolveAll(), NOT resolve_(): resolve_ ends in `.first()`, so counting on it
 * returns 1 for a page with fourteen cards. A gate that reads 1 when the answer is 14 submits
 * when it must refuse — which is the entire failure this file exists to prevent.
 */
async function countOrZero(page, key) {
    try {
        const loc = await resolveAll(page, key);
        return loc ? await loc.count() : 0;
    }
    catch {
        return 0;
    }
}
