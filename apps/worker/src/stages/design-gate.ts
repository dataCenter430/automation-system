/**
 * THE DESIGN GATE — catch a blocked category in SECONDS, before anything is built.
 *
 * WHY THIS EXISTS. A task was rejected by the category classifier four times. Each rejection
 * arrived AFTER a full build turn (one ran 18 minutes, 69 tool calls). Between them the session
 * rebuilt the task wholesale — a Terraform spec recovery, then a threshold calibrator, then a
 * champion/challenger selector — three unrelated deliverables, and every one of them was
 * graded the same way:
 *
 *     "the agent emits an artifact; the tests compare it to a reference"
 *
 * That is the definition of data-processing, which is blocked. The nouns moved every time. The
 * GRADING AXIS never moved once, so the verdict never moved either.
 *
 * The verdict that cost those four builds was fully determined by information that existed
 * before a single file was written: the advocate classifier made its 0.95 software-engineering
 * case by quoting the routine the agent must implement and "nine test cases". Both of those are
 * present in a two-paragraph design statement.
 *
 * So the session now states its design FIRST — deliverable, grading axis, test names — and we
 * run the SAME classifier panel over it. Blocked designs die in seconds, for free, and the
 * session iterates on a paragraph instead of on a build.
 *
 * Two gates, cheapest first:
 *
 *   1. axisLint()      deterministic, zero model calls, zero discretion. The equality axis is
 *                      data-processing BY DEFINITION, so it does not need a model to spot it.
 *   2. classifyEvidence()  the real panel, over a design-derived evidence blob.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyEvidence, type Classification } from "./classify.ts";
import { BLOCKED_AXIS, GRADING_AXES, type GradingAxis, type RejectedDesign } from "../state.ts";

/** What the session must write to .pipeline/design.json before it may build. */
export interface Design {
  /** What must the agent PRODUCE? */
  deliverable: string;
  /** What decides whether it is right? */
  gradedOn: string;
  /** THE AXIS. A closed vocabulary — prose can be talked around, an enum cannot. */
  gradingAxis: GradingAxis;
  /** The test names. These are literally what the classifier reads. */
  testNames: string[];
  /** What is handed to the agent in environment/. */
  handedToAgent?: string;
}

export class DesignInvalid extends Error {}

const DESIGN_FILE = ".pipeline/design.json";

export function designPath(workspace: string): string {
  return join(workspace, DESIGN_FILE);
}

export function readDesign(workspace: string): Design | null {
  const p = designPath(workspace);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Design;
  } catch {
    return null;
  }
}

/**
 * Validate the SHAPE. A design we cannot read is a design we cannot gate.
 *
 * Deliberately strict about gradingAxis: a session that invents its own axis string has
 * side-stepped the one field that exists to be un-side-steppable.
 */
export function validateDesign(d: unknown): Design {
  const o = (d ?? {}) as Record<string, unknown>;
  const bad = (m: string) => { throw new DesignInvalid(m); };

  const deliverable = String(o.deliverable ?? "").trim();
  const gradedOn = String(o.gradedOn ?? "").trim();
  const axis = String(o.gradingAxis ?? "").trim() as GradingAxis;
  const testNames = Array.isArray(o.testNames) ? o.testNames.map((t) => String(t).trim()) : [];

  if (deliverable.length < 20) bad("design.deliverable is missing or too short to mean anything");
  if (gradedOn.length < 20) bad("design.gradedOn is missing or too short to mean anything");
  if (!GRADING_AXES.includes(axis)) {
    bad(
      `design.gradingAxis must be exactly one of: ${GRADING_AXES.join(", ")}. ` +
        `Got ${JSON.stringify(o.gradingAxis)}. This field is a closed vocabulary on purpose — ` +
        `it is the one thing a redesign cannot paraphrase its way around.`,
    );
  }
  if (testNames.length < 3) bad("design.testNames must list at least 3 tests — they are what the classifier reads");

  return { deliverable, gradedOn, gradingAxis: axis, testNames, handedToAgent: String(o.handedToAgent ?? "") };
}

/**
 * THE EQUALITY-AXIS LINT. Deterministic, free, and not up for debate.
 *
 * "The agent's output matches the reference output" is data-processing by definition. It does
 * not become machine-learning because the file is called `promotion.json`, and it does not
 * become security because the reference is a signature. No model call is needed to see this,
 * so no model call is made — and because it is mechanical, it cannot be argued with, which is
 * the entire point. Three redesigns argued their way past every prose instruction in the repo.
 *
 * Returns the reasons it is blocked; empty means clean.
 */
const EQUALITY_NAME =
  /(match(es)?|equals?|agrees?_with|identical_to)_(reference|golden|expected|oracle|spec)|byte_identical|output_(is_)?correct/i;

/**
 * The same idea in prose. Note what is NOT here: `== *oracle\.` used to sit behind a `\b`, where
 * it could never fire, because `=` is not a word character. A dead alternative in a regex is worse
 * than no alternative — it reads as coverage.
 */
const EQUALITY_PROSE =
  /(byte[- ]identical|match(es)? the (reference|golden|expected)|compared? (to|against) the (reference|oracle|golden)|output (data )?is correct)/i;

/**
 * NEGATION IS NOT ASSERTION, and a regex cannot tell the difference on its own.
 *
 * The security category's own `gradedOn` reads: "The oracle is 'the policy holds under attack',
 * NEVER 'the output file matches the golden copy'." The prose check fired on it — refusing a
 * description precisely BECAUSE it disclaimed the equality axis. A session that says the exactly
 * right thing must not be punished for naming the wrong thing in order to reject it.
 *
 * So: drop the clauses that are disclaimers, and test what is left.
 */
const NEGATION = /\b(never|not|rather than|instead of|no longer|avoid|isn't|aren't)\b/i;

function affirmativeOnly(prose: string): string {
  return prose
    .split(/[.;,]|\bbut\b/i)
    .filter((clause) => !NEGATION.test(clause))
    .join(" ");
}

export function axisLint(d: Design, declared: string): string[] {
  const problems: string[] = [];

  if (d.gradingAxis === BLOCKED_AXIS && declared !== "data-processing") {
    problems.push(
      `gradingAxis is "${BLOCKED_AXIS}" — the agent's output is compared to a reference output. ` +
        `That IS data-processing, which is BLOCKED, and no amount of domain vocabulary changes it. ` +
        `Your category is "${declared}". Pick the axis that category is actually graded on.`,
    );
  }

  const offenders = d.testNames.filter((t) => EQUALITY_NAME.test(t));
  if (offenders.length && declared !== "data-processing") {
    problems.push(
      `these test names grade OUTPUT EQUALITY: ${offenders.join(", ")}. ` +
        `The classifier reads test names. A single one of these is enough to read the whole task ` +
        `as data-processing — it is exactly what sank the last four attempts.`,
    );
  }

  if (EQUALITY_PROSE.test(affirmativeOnly(d.gradedOn)) && declared !== "data-processing") {
    problems.push(
      `gradedOn describes comparing the agent's output to a reference: "${d.gradedOn.slice(0, 120)}". ` +
        `Grade a PROPERTY of the result, not its equality to a golden copy.`,
    );
  }

  return problems;
}

/**
 * The identity of a design: its AXIS plus the SET OF THINGS IT ASSERTS.
 *
 * Getting this granularity right matters in both directions, and the obvious choice is wrong.
 *
 * TOO COARSE — the axis alone. There are five axes, and `equality-vs-reference` is refused
 * outright for any category but data-processing, leaving FOUR. Ban an axis the moment one design
 * using it is blocked, and the fourth rejection leaves no legal design at all: the gate becomes
 * unsatisfiable and refuses every proposal on the way to a guaranteed failure. It is also simply
 * untrue. A `property-threshold` design graded on recall and a `property-threshold` design graded
 * on calibration error are different tasks, and the second can pass where the first did not.
 *
 * TOO FINE — the deliverable prose. Rewordable at zero cost, which is exactly the move the loop
 * kept making: three rebuilds, three domains, three fresh descriptions, one unchanged assertion.
 *
 * So: the axis, plus what the tests actually assert. Change either and it is a new design and it
 * gets its chance. Change neither and you are repeating yourself, and we say so.
 *
 * NOTE the incident this file exists for is caught by axisLint(), not here — all three rebuilds
 * used the equality axis, which is refused unconditionally. This is the belt to that pair of
 * braces: it stops an exact re-proposal, and it never bans an idea that has not actually failed.
 */
export function designFingerprint(d: Pick<Design, "gradingAxis" | "testNames">): string {
  const tests = [...d.testNames].map((t) => t.trim().toLowerCase()).sort().join(",");
  return `${d.gradingAxis}::${tests}`;
}

/** Has this EXACT design — same axis, same assertions — already been tried and rejected? */
export function alreadyRejected(d: Design, ledger: RejectedDesign[]): RejectedDesign | null {
  const fp = designFingerprint(d);
  return ledger.find((r) => designFingerprint(r) === fp) ?? null;
}

/**
 * Has EVERY legal axis now been tried and blocked?
 *
 * This is the honest end of the road, and it is a different thing from circling. It means the
 * task as briefed may simply have no shape that fits its assigned category — which is a question
 * for a human, not another build.
 */
export function axesExhausted(declared: string, ledger: RejectedDesign[]): boolean {
  const legal = GRADING_AXES.filter((a) => a !== BLOCKED_AXIS || declared === "data-processing");
  const tried = new Set(ledger.map((r) => r.gradingAxis));
  return legal.every((a) => tried.has(a));
}

/**
 * Render the classifier's evidence shape from a DESIGN rather than a built tree.
 *
 * The four slots are the ones evidence() builds in classify.ts. They are labelled by SEMANTICS
 * ("what the agent is told to do", "what is graded"), not by provenance, so a design statement
 * fills them losslessly — and the panel cannot tell, and must not care, that no files exist yet.
 */
export function designEvidence(d: Design): string {
  return [
    "=== instruction.md — what the agent under test is told to do ===",
    d.deliverable,
    "",
    "=== solution/solve.sh — the oracle. What does 'solved' actually consist of? ===",
    d.gradedOn,
    "",
    "=== test names — what is graded ===",
    d.testNames.map((t) => `  ${t}`).join("\n"),
    "",
    "=== environment/ — what the agent is handed ===",
    d.handedToAgent || "(not yet stated)",
  ].join("\n");
}

export interface DesignVerdict {
  ok: boolean;
  /** Why it was refused, ready to hand straight back to the session. */
  report: string;
  /** Present only when the model panel actually ran. */
  classification?: Classification;
}

/**
 * The gate. Lint first (free), then the panel (seconds).
 *
 * An UNAVAILABLE classifier is a WARNING, never a pass — same rule as the real gate. A design we
 * could not check is a design we do not get to call clean; it proceeds, but it proceeds honestly.
 */
export async function designGate(
  d: Design,
  declared: string,
  ledger: RejectedDesign[],
  model?: string,
): Promise<DesignVerdict> {
  const repeat = alreadyRejected(d, ledger);
  if (repeat) {
    return {
      ok: false,
      report:
        `THIS EXACT DESIGN HAS ALREADY BEEN REJECTED.\n\n` +
        `You proposed axis "${d.gradingAxis}" grading:\n` +
        d.testNames.map((t) => `  - ${t}`).join("\n") +
        `\n\nAttempt ${repeat.attempt} proposed the same axis asserting the same things, and the ` +
        `classifier blocked it as "${repeat.predicted}" (${repeat.confidence}).\n\n` +
        `Its reason then: ${repeat.why}\n\n` +
        `The domain, the nouns and the file names are NOT the design — what the tests MEASURE is. ` +
        `Renaming the task around an unchanged assertion is the exact loop that has already burned ` +
        `four builds. Change what is ASSERTED, or change the axis.`,
    };
  }

  const lint = axisLint(d, declared);
  if (lint.length) {
    return {
      ok: false,
      report:
        `DESIGN REJECTED — the grading axis is blocked (no model was consulted; this one is mechanical).\n\n` +
        lint.map((p) => `  • ${p}`).join("\n\n"),
    };
  }

  const c = await classifyEvidence(designEvidence(d), model);

  if (c.unavailable) {
    return {
      ok: true,
      report: `⚠️  the design classifier could not run (${c.unavailable}) — proceeding UNVERIFIED.`,
      classification: c,
    };
  }

  if (c.blocked) {
    const hits = c.hits.map((h) => `  • ${h.category} (${h.confidence}) — ${h.why}`).join("\n");
    return {
      ok: false,
      report:
        `DESIGN REJECTED — it classifies into a blocked category BEFORE you have built anything.\n\n` +
        `Declared: ${declared}\nReads as: ${c.predicted} (${c.confidence})\n\n` +
        `${c.why}\n\nBlocked categories a reviewer could make stick:\n${hits}\n\n` +
        `Nothing has been built yet, so this costs you a paragraph, not a build. Change WHAT THE ` +
        `AGENT MUST PRODUCE and WHAT DECIDES WHETHER IT IS RIGHT — then restate the design.`,
      classification: c,
    };
  }

  return {
    ok: true,
    report: `design clears the classifier: ${c.predicted} (${c.confidence}) · axis "${d.gradingAxis}"`,
    classification: c,
  };
}

/**
 * BUILD DRIFT: the tree that got built must still be the design that got approved.
 *
 * The session writes its own design, so a design gate alone is only as honest as the session.
 * The cheap, structural check is the test names — they are what the classifier reads, and they
 * are what the design promised. If the built tree grades something other than what the approved
 * design said it would grade, the approval is void.
 */
export function designDrift(d: Design, builtTestNames: string[]): string[] {
  if (!builtTestNames.length) return [];
  const promised = new Set(d.testNames.map((t) => t.toLowerCase()));
  const sneakedIn = builtTestNames.filter(
    (t) => !promised.has(t.toLowerCase()) && EQUALITY_NAME.test(t),
  );
  return sneakedIn;
}
