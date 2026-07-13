/**
 * The revision-queue gate.
 *
 * THE OPERATOR'S RULE: "the submission would be limited if there are 10+ revision tasks in the
 * revision queue of the home page. so you can only proceed submit once revision queue is under 10."
 *
 * This is an ACCOUNT-SAFETY gate, and the account is the thing we are most concerned with
 * protecting — the whole browser layer is DOM-only for exactly that reason. So the gate is
 * written to fail CLOSED: every uncertainty resolves to "do not submit".
 *
 * ---------------------------------------------------------------------------------------------
 * WHY WE READ A SENTENCE INSTEAD OF COUNTING THE CARDS
 *
 * The obvious implementation counts `[data-testid=project-card]` inside the assignments list.
 * That implementation is wrong, and wrong in the dangerous direction.
 *
 * The operator's own Chrome userscript injects an owner filter into this page:
 *
 *     <div id="snorkel-badge"><span>Owner: Mickey — 4 shown · 9 in sheet</span>
 *
 * "4 shown · 9 in sheet". It HIDES cards. Snorkel's own search box does too. So a card count can
 * report 4 when the queue really holds 14 — and 4 is under 10, so we would submit, which is the
 * precise thing the rule forbids.
 *
 * Snorkel itself renders the true number, in a sentence, from the unfiltered list:
 *
 *     <h1 class="text-heading">Tasks to be revised</h1>
 *     <div class="text-base-normal">14 tasks to be revised</div>
 *
 * That sentence is the source of truth. If it cannot be parsed, we do not fall back to counting
 * cards — we REFUSE, because a fallback that can silently undercount is worse than no answer.
 *
 * ---------------------------------------------------------------------------------------------
 * WHICH NUMBER
 *
 * The queue is cross-project. In the live DOM: 13 Terminus-2nd-Edition + 1 CDG_Beaver_Prod_vFYAR
 * = the 14 the header reports. The operator chose: BLOCK IF EITHER the total OR the Terminus-only
 * count is >= 10. Strictly the most cautious reading, and it costs only throughput — never the
 * account.
 *
 * The Terminus subcount DOES come from cards (there is no per-project sentence to read), which
 * means a filter can undercount it. That is safe in this direction only because the total, read
 * from the sentence, is checked too and cannot be filtered away. Both must pass.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT IT DOES NOT GATE
 *
 * REVISIONS. A revision is not a new submission — it is how the queue gets SHORTER. Gating
 * revisions on a full queue would deadlock the system exactly when it most needs to drain: at 14
 * in the queue it could neither submit new work nor clear the backlog. So this runs before a NEW
 * submission only.
 */
import type { Page } from "playwright";
import { resolve_, resolveAll, exists, pageUrl } from "../browser/selectors.ts";
import { snap } from "../browser/actions.ts";
import { withScratchPage, type Attached } from "../browser/cdp.ts";

/** The rule. Under this, we may submit; at it or above, we may not. */
export const QUEUE_LIMIT = 10;

export interface QueueState {
  /** From Snorkel's own sentence. The authoritative number. */
  total: number;
  /** Terminus-2nd-Edition cards only. Counted from the DOM, so a filter can undercount it. */
  terminus: number;
  /** Cards actually in the DOM. If this disagrees with `total`, a filter is hiding rows. */
  cardsVisible: number;
  /** The operator's owner-filter userscript is active, so card counts are not to be trusted. */
  filtered: boolean;
  /** May a NEW submission proceed? */
  maySubmit: boolean;
  /** Human-readable, and the exact text the dashboard shows when it refuses. */
  reason: string;
}

/**
 * Could not establish the queue size. NOT the same as "the queue is empty".
 *
 * Thrown rather than returned as a number, because every numeric return type here invites a
 * caller to treat a failure as a zero.
 */
export class QueueUnreadable extends Error {
  constructor(why: string) {
    super(
      `Refusing to submit: could not read the revision queue size from the home page (${why}).\n\n` +
        `The rule is "only submit when the revision queue is under ${QUEUE_LIMIT}", and we cannot ` +
        `confirm that. Counting the cards instead is NOT an acceptable fallback: the owner-filter ` +
        `userscript and Snorkel's search box both HIDE cards, so a count can read 4 when the queue ` +
        `holds 14 — and that error points straight at submitting when we must not.\n\n` +
        `Open ${pageUrl("home")} and check that "N tasks to be revised" is on the page.`,
    );
    this.name = "QueueUnreadable";
  }
}

/** "14 tasks to be revised" -> 14. Also tolerates "1 task to be revised". */
export function parseQueueCount(text: string): number | null {
  const m = /(\d+)\s+tasks?\s+to\s+be\s+revised/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Read the queue, in its own tab.
 *
 * Its own tab matters: the caller is usually holding a filled submission form, and navigating
 * that tab to /home would destroy it. (This is the same bug that findSubmitted() was fixed for.)
 */
export async function readQueue(a: Attached, runDir: string): Promise<QueueState> {
  return withScratchPage(a, pageUrl("home"), async (page) => {
    await snap(page, runDir, "queue-gate");
    return readQueueFrom(page);
  });
}

/** Split out from readQueue so it can be tested against a real page without the CDP layer. */
export async function readQueueFrom(page: Page): Promise<QueueState> {
  let sentence: string;
  try {
    sentence = (await (await resolve_(page, "home.reviseQueueCount", { timeoutMs: 8000 })).innerText()).trim();
  } catch {
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
  if (filtered) bits.push("owner filter ACTIVE — card counts are unreliable");
  else if (cardsVisible !== total) bits.push(`only ${cardsVisible} cards in the DOM — something is hiding rows`);

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
async function countOrZero(page: Page, key: string): Promise<number> {
  try {
    const loc = await resolveAll(page, key);
    return loc ? await loc.count() : 0;
  } catch {
    return 0;
  }
}
