/**
 * Predict the category a reviewer will assign — adversarially, not hopefully.
 *
 * TWO SUBMISSIONS, TWO CATEGORY REJECTIONS. This file is the record of what that taught us.
 *
 *   1st: ❌ Predicted 'software-engineering' (0.95) — the task was "five defects are planted
 *        in this C++ file, find them". A bug hunt. Correctly blocked.
 *   2nd: ❌ Predicted 'data-processing'      (0.90) — we had redesigned it into "rematerialize
 *        the feature store under the v3 spec". That is ETL. Also correctly blocked.
 *
 * We escaped one blocked category by walking into another, and OUR OWN GATE WAVED IT THROUGH
 * with `machine-learning` at 0.92 confidence. That is the failure worth understanding, because
 * the classifier was not wrong by accident — it was wrong by construction:
 *
 *   The old prompt TOLD the model what machine-learning looks like: "a feature pipeline to a
 *   spec, constructing or validating a dataset, evaluating a model, calibrating a threshold,
 *   measuring drift". The redesigned task used those exact words. So the classifier matched
 *   the vocabulary of MY prompt against the vocabulary of the task and confirmed itself. A
 *   leak, straight out of an eval-design textbook.
 *
 *   Proof, run on the rejected tree: a NEUTRAL prompt given only instruction.md returns
 *   data-processing (0.92) — reproducing Snorkel exactly. Our prompt returned
 *   machine-learning (0.92). Same model, same task, opposite answer.
 *
 * So the question changed. "What is this task?" is a cooperative question and it gets a
 * cooperative answer. The question a gate must ask is:
 *
 *   "Is there ANY blocked category a reviewer could plausibly land on?"
 *
 * which is asked once per blocked category, by an advocate FOR that category, and answered by
 * the worst verdict on the panel — never the friendliest.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { blockedCategories } from "../../../../packages/shared/src/taxonomy.ts";

const CATEGORIES = [
  "system-administration", "build-and-dependency-management", "data-processing",
  "games", "software-engineering", "machine-learning", "debugging", "security",
  "scientific-computing",
];

/** What each blocked category MEANS, in the words a reviewer would use — not ours. */
const BLOCKED_DEFS: Record<string, string> = {
  "software-engineering":
    "the deliverable is source code that now works — implementing, refactoring or repairing a " +
    "program, graded on whether the code is correct",
  "debugging":
    "the agent must LOCATE a fault it was not handed — the task presents symptoms, or planted " +
    "defects, and the work is finding and repairing them",
  "data-processing":
    "the work is moving or reshaping data — ETL, a migration between schemas or specification " +
    "versions, parsing, transforming, materializing or re-materializing a dataset — graded on " +
    "whether the output data is correct",
};

export interface Verdict {
  category: string;
  confidence: number;
  why: string;
}

export interface Classification {
  /** The neutral prediction: what a reviewer asked "what is this?" would most likely answer. */
  predicted: string | null;
  confidence: number;
  why: string;
  /** True if ANY blocked category survived its adversarial check, or the prediction is blocked. */
  blocked: boolean;
  /** Which blocked categories an advocate could make stick, worst first. RISK, not verdict. */
  hits: Array<{ category: string; confidence: number; why: string }>;
  /** True when the neutral pass was shaky and an advocate was certain — the coin-flip case. */
  coinFlip?: boolean;
  unavailable?: string;
}

/**
 * CALIBRATION — and why the obvious design is wrong.
 *
 * The obvious design is: block if ANY advocate makes a blocked category stick. Tried it on the
 * rejected tree and it fires like this:
 *
 *   data-processing      0.98  "must produce materialized data artifacts"     <- correct
 *   software-engineering 0.95  "must produce working source code artifacts"   <- USELESS
 *
 * The second one is not a finding, it is a tautology. EVERY Terminus task produces working
 * source code — that is the medium, not the substance. An advocate briefed to argue a case
 * will find that argument in every task ever written, so blocking on it would reject good
 * machine-learning tasks, burn all three fix attempts, and land them in FAILED. A gate that
 * rejects everything is exactly as useless as one that rejects nothing; it just fails in a
 * direction that feels responsible.
 *
 * So the DECISION is the neutral pass, which is the faithful proxy: it has now reproduced
 * Snorkel's verdict twice, on both rejected trees, to within 0.02 confidence
 * (software-engineering 0.95/0.95, then data-processing 0.92/0.90).
 *
 * The advocates earn their place in the one case the neutral pass is weak: when it is UNSURE
 * (<= 0.75) and an advocate is CERTAIN (>= 0.90). That is the coin-flip a reviewer could
 * plausibly call the other way, and it is precisely where two submissions have been lost.
 * Everywhere else they are reported as risk, in the failure report and on the gate panel, and
 * a human decides what to do about them.
 */
const STICKS_AT = 0.5;        // reported as risk at or above this
const ADVOCATE_CERTAIN = 0.9; // an advocate this sure...
const NEUTRAL_UNSURE = 0.75;  // ...against a neutral pass this shaky, blocks

function head(p: string, chars: number): string {
  try {
    return readFileSync(p, "utf8").slice(0, chars);
  } catch {
    return "";
  }
}

function envListing(taskDir: string, limit = 40): string {
  const root = join(taskDir, "environment");
  if (!existsSync(root)) return "(no environment/)";
  const out: string[] = [];
  const walk = (d: string) => {
    if (out.length >= limit) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (out.length < limit) out.push(`  ${relative(taskDir, p)} (${Math.round(statSync(p).size / 1024)} KB)`);
    }
  };
  walk(root);
  return out.join("\n");
}

/**
 * The evidence. instruction.md dominates — it is what Snorkel's classifier keyed on both times
 * — but the oracle and the test names are included because they say what "solved" actually
 * CONSISTS of, which is the thing a label can lie about and a diff cannot.
 */
function evidence(taskDir: string): string {
  const testNames = (() => {
    const p = join(taskDir, "tests", "test_outputs.py");
    if (!existsSync(p)) return "(none)";
    const m = readFileSync(p, "utf8").match(/^\s*def (test_\w+)/gm) ?? [];
    return m.map((s) => `  ${s.trim().replace(/^def /, "")}`).join("\n") || "(none)";
  })();

  return [
    "=== instruction.md — what the agent under test is told to do ===",
    head(join(taskDir, "instruction.md"), 6000) || "(missing)",
    "",
    "=== solution/solve.sh — the oracle. What does 'solved' actually consist of? ===",
    head(join(taskDir, "solution", "solve.sh"), 2500) || "(missing)",
    "",
    "=== test names — what is graded ===",
    testNames,
    "",
    "=== environment/ — what the agent is handed ===",
    envListing(taskDir),
  ].join("\n");
}

async function ask(prompt: string, model: string, timeoutMs: number): Promise<any | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  let text = "";
  try {
    const stream = query({
      prompt,
      options: {
        cwd: "/tmp",
        model,
        abortController: abort,
        settingSources: [],
        tools: [], // pure judgement — it reads only what we hand it
        permissionMode: "default",
      },
    });
    for await (const m of stream as AsyncIterable<any>) {
      if (m.type === "result") {
        if (m.subtype !== "success") return null;
        text = String(m.result ?? "");
      }
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

/**
 * NEUTRAL. No definitions, no steering, no vocabulary for the task to match against — because
 * that is precisely what went wrong last time. Just the nine names and the evidence.
 */
const NEUTRAL = (ev: string) => `
You are the task-category classifier for a coding-benchmark review pipeline.

Classify the task below into exactly one of these categories:
${CATEGORIES.map((c) => `  - ${c}`).join("\n")}

Judge by what the agent under test is actually asked to PRODUCE and what it is GRADED on.

Answer with ONLY a JSON object:
{"category": "<one of the list>", "confidence": <0.0-1.0>, "why": "<one sentence>"}

${ev}
`.trim();

/**
 * ADVERSARIAL. One advocate per blocked category, briefed to make the strongest HONEST case.
 * "Honest" is load-bearing: an advocate who will argue anything is as useless as a rubber
 * stamp, just in the other direction.
 */
const ADVOCATE = (cat: string, def: string, ev: string) => `
A reviewer is deciding whether the task below falls into the category "${cat}", which means:
${def}

Make the strongest HONEST case that this task IS "${cat}". Do not argue for it if the case is
weak — a wrong yes costs as much as a wrong no. Judge by what the agent must PRODUCE and what
it is GRADED on, not by the subject matter of the environment: a task full of machine-learning
nouns whose deliverable is a corrected file is still about the file.

Answer with ONLY a JSON object:
{"applies": true|false, "confidence": <0.0-1.0>, "why": "<one sentence, quoting the strongest signal>"}

${ev}
`.trim();

export async function classifyTask(
  taskDir: string,
  model = "claude-haiku-4-5",
  timeoutMs = 120_000,
): Promise<Classification> {
  const blocked = blockedCategories();
  const ev = evidence(taskDir);

  // The panel runs concurrently: one neutral, one advocate per blocked category. Four cheap
  // Haiku calls, before Docker.
  const [neutral, ...advocacy] = await Promise.all([
    ask(NEUTRAL(ev), model, timeoutMs),
    ...blocked.map((c) => ask(ADVOCATE(c, BLOCKED_DEFS[c] ?? c, ev), model, timeoutMs)),
  ]);

  if (!neutral || !CATEGORIES.includes(String(neutral.category))) {
    return {
      predicted: null, confidence: 0, why: "", blocked: false, hits: [], coinFlip: false,
      unavailable: "the neutral classifier did not return a usable category",
    };
  }

  const hits = blocked
    .map((category, i) => {
      const a = advocacy[i];
      return a && a.applies === true
        ? { category, confidence: Number(a.confidence ?? 0), why: String(a.why ?? "") }
        : null;
    })
    .filter((h): h is { category: string; confidence: number; why: string } => h !== null)
    .filter((h) => h.confidence >= STICKS_AT)
    .sort((a, b) => b.confidence - a.confidence);

  const predicted = String(neutral.category);
  const confidence = Number(neutral.confidence ?? 0);

  // The neutral pass IS the verdict — it is the faithful proxy for Snorkel's own classifier.
  const predictedIsBlocked = blocked.includes(predicted);

  // The one place the advocates decide: a neutral pass that is shaky, against an advocate that
  // is certain. That is the coin-flip a reviewer could call the other way — and has, twice.
  const coinFlip =
    !predictedIsBlocked &&
    confidence <= NEUTRAL_UNSURE &&
    hits.some((h) => h.confidence >= ADVOCATE_CERTAIN);

  return {
    predicted,
    confidence,
    why: String(neutral.why ?? ""),
    blocked: predictedIsBlocked || coinFlip,
    coinFlip,
    hits,
  };
}

/** The failure report handed to Claude when a blocked category sticks. */
export function classifierFailure(c: Classification, declared: string): string {
  const lines: string[] = [];

  if (c.predicted && blockedCategories().includes(c.predicted)) {
    lines.push(
      `The task classifies as "${c.predicted}" (${c.confidence.toFixed(2)}), which Snorkel is ` +
        `NOT accepting. task.toml declares "${declared}".`,
      ``,
      `Reason given: ${c.why}`,
    );
  } else {
    lines.push(
      `The task reads as "${c.predicted}" on a neutral pass, but a reviewer could plausibly ` +
        `land on a BLOCKED category — and Snorkel's classifier has now done exactly that twice.`,
    );
  }

  if (c.hits.length) {
    lines.push(``, `Blocked categories a reviewer could make stick:`);
    for (const h of c.hits) {
      lines.push(`  • ${h.category} (${h.confidence.toFixed(2)}) — ${h.why}`);
    }
  }

  lines.push(
    ``,
    `This is NOT fixed by editing the category in task.toml. Snorkel passed the ENUM both times`,
    `("✅ Category 'machine-learning' is valid") and rejected the TASK in the same run. The`,
    `classifier reads what the agent must produce and what it is graded on.`,
    ``,
    `Two blocked framings, both of which we have now shipped and had rejected:`,
    `  • "there are defects in this code, find and fix them"   -> software-engineering / debugging`,
    `  • "migrate / rematerialize / transform this data to a new spec" -> data-processing`,
    ``,
    `A migration is ETL no matter how much machine-learning vocabulary surrounds it. To belong`,
    `to "${declared}", the agent's DELIVERABLE and its GRADING must be about MODEL BEHAVIOUR:`,
    `training or evaluating a model, calibrating a decision threshold to hit a target metric,`,
    `selecting an operating point, measuring model quality. Grade it on precision/recall, a`,
    `calibration error, an operating threshold — not on "the output table is correct".`,
    ``,
    `Rework the SUBSTANCE. Change what the agent must build and how it is judged, not the label.`,
  );

  return lines.join("\n");
}
