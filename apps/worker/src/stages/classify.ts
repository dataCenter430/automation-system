/**
 * Predict the category a classifier will assign to this task — before Snorkel does.
 *
 * WHY THIS EXISTS
 *
 * Our first real submission was rejected with:
 *
 *   ❌ [category_classifier] Predicted category 'software-engineering' (confidence 0.95)
 *      is blocked for this project. Rework the task so it does not fall into a blocked
 *      category.
 *
 * while the very same run reported `✅ Category 'machine-learning' is valid`. Both are true.
 * The ENUM in task.toml was valid; the TASK was not. Snorkel classifies the task from its
 * CONTENT, and the content was "five defects are planted in this C++ file, find them" — which
 * is software-engineering (or debugging) no matter what string sits in the metadata.
 *
 * Our gate had a `blocked_category` rule, and it waved this through, because it compared a
 * string against a list. You cannot catch a semantic problem with a string compare. lint.ts's
 * ML-keyword heuristic is a backstop, but a heuristic invites keyword-stuffing: a task can
 * satisfy it without changing what it *is*.
 *
 * So we run the real thing. Snorkel's CI announces its own reviewer model in the build log —
 * `export REVIEW_MODEL="claude-haiku-4-5"` — so we ask the same model the same question, on
 * the same evidence, before we ever upload. This is the difference between a gate that
 * approximates Snorkel and a gate that agrees with it.
 *
 * It is deliberately cheap: Haiku, one turn, no tools, a few KB of prompt. It runs before
 * Docker, so a task that is blocked-in-substance is caught in seconds rather than after a
 * six-minute image build.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { blockedCategories } from "../../../../packages/shared/src/taxonomy.ts";

/** The nine categories Snorkel classifies into. */
const CATEGORIES = [
  "system-administration", "build-and-dependency-management", "data-processing",
  "games", "software-engineering", "machine-learning", "debugging", "security",
  "scientific-computing",
];

export interface Classification {
  /** null when the classifier could not be run at all. */
  predicted: string | null;
  confidence: number;
  why: string;
  /** True when `predicted` is one of the categories Snorkel is not accepting. */
  blocked: boolean;
  /** Set when we could not run the classifier — the gate warns rather than passing silently. */
  unavailable?: string;
}

function head(p: string, chars: number): string {
  try {
    return readFileSync(p, "utf8").slice(0, chars);
  } catch {
    return "";
  }
}

/** A shallow listing of the environment — the classifier cares what the agent is handed. */
function envListing(taskDir: string, limit = 40): string {
  const root = join(taskDir, "environment");
  if (!existsSync(root)) return "(no environment/)";
  const out: string[] = [];
  const walk = (d: string) => {
    if (out.length >= limit) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (out.length < limit) {
        const kb = Math.round(statSync(p).size / 1024);
        out.push(`  ${relative(taskDir, p)} (${kb} KB)`);
      }
    }
  };
  walk(root);
  return out.join("\n");
}

/**
 * The evidence a classifier actually keys on: what is the agent asked to DO, what must it
 * hand back, and how is it judged. Not the domain nouns lying around the environment.
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
    "=== task.toml ===",
    head(join(taskDir, "task.toml"), 2000) || "(missing)",
    "",
    "=== solution/solve.sh — the oracle. What does 'solved' actually consist of? ===",
    head(join(taskDir, "solution", "solve.sh"), 3000) || "(missing)",
    "",
    "=== test names — what is graded ===",
    testNames,
    "",
    "=== environment/ — what the agent is handed ===",
    envListing(taskDir),
  ].join("\n");
}

const PROMPT = (ev: string) => `
You are the task-category classifier for a coding-benchmark review pipeline. Classify the
task below into exactly one of these categories:

${CATEGORIES.map((c) => `  - ${c}`).join("\n")}

Classify by SUBSTANCE, not by subject matter. The question is: **what is the agent under test
actually asked to produce, and what is it graded on?** Not: what nouns appear in the
environment.

  - If the deliverable is "repaired source code" and the grading is "the code is now correct",
    that is software-engineering — or debugging, if the task is framed as hunting defects the
    agent must first locate. A domain full of machine-learning nouns does not change this.
  - Call it machine-learning only if the work itself is machine learning: building a feature
    pipeline to a spec, constructing or validating a dataset, evaluating a model, calibrating
    a threshold, measuring drift, scoring, and the success criteria are stated in terms of
    data or model behaviour rather than "the code is fixed".
  - Implementation language is irrelevant. Heavy C++ that builds a feature pipeline is
    machine-learning. Six sed commands over constants is debugging.

Answer with ONLY a JSON object, no prose, no code fence:
{"category": "<one of the list>", "confidence": <0.0-1.0>, "why": "<one sentence, quoting the
strongest signal from the task>"}

${ev}
`.trim();

/**
 * @param model the classifier model. Snorkel's CI log shows REVIEW_MODEL="claude-haiku-4-5",
 *   so we ask the same model the same question.
 */
export async function classifyTask(
  taskDir: string,
  model = "claude-haiku-4-5",
  timeoutMs = 120_000,
): Promise<Classification> {
  const blocked = new Set(blockedCategories());

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  let text = "";

  try {
    const stream = query({
      prompt: PROMPT(evidence(taskDir)),
      options: {
        cwd: taskDir,
        model,
        abortController: abort,
        settingSources: [],
        // Pure judgement. No tools, no file access — it reads only the evidence we hand it,
        // which is also what keeps it fast and cheap enough to run on every gate.
        tools: [],
        permissionMode: "default",
      },
    });

    for await (const m of stream as AsyncIterable<any>) {
      if (m.type === "result") {
        if (m.subtype !== "success") {
          return {
            predicted: null, confidence: 0, blocked: false, why: "",
            unavailable: `classifier did not finish: ${m.subtype}`,
          };
        }
        text = String(m.result ?? "");
      }
    }
  } catch (e) {
    return {
      predicted: null, confidence: 0, blocked: false, why: "",
      unavailable: `classifier could not run: ${(e as Error).message}`,
    };
  } finally {
    clearTimeout(timer);
  }

  // Tolerate a code fence or stray prose around the JSON — but never GUESS a category. If we
  // cannot read the answer, we say so; a classifier that silently returns "fine" is worse
  // than no classifier, because it is trusted.
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) {
    return {
      predicted: null, confidence: 0, blocked: false, why: "",
      unavailable: `classifier returned no JSON: ${text.slice(0, 200)}`,
    };
  }

  try {
    const j = JSON.parse(m[0]) as { category?: string; confidence?: number; why?: string };
    const predicted = String(j.category ?? "").trim();
    if (!CATEGORIES.includes(predicted)) {
      return {
        predicted: null, confidence: 0, blocked: false, why: "",
        unavailable: `classifier returned an unknown category: ${JSON.stringify(j.category)}`,
      };
    }
    return {
      predicted,
      confidence: Number(j.confidence ?? 0),
      why: String(j.why ?? "").trim(),
      blocked: blocked.has(predicted),
    };
  } catch (e) {
    return {
      predicted: null, confidence: 0, blocked: false, why: "",
      unavailable: `classifier JSON was unparseable: ${(e as Error).message}`,
    };
  }
}

/** The failure report handed to Claude when the predicted category is blocked. */
export function classifierFailure(c: Classification, declared: string): string {
  return [
    `The task classifies as "${c.predicted}" (confidence ${c.confidence.toFixed(2)}), which ` +
      `Snorkel is NOT accepting. task.toml declares "${declared}".`,
    ``,
    `Classifier's reason: ${c.why}`,
    ``,
    `This is NOT fixed by editing the category in task.toml. Snorkel classifies the task from ` +
      `its CONTENT — what the agent is asked to produce and what it is graded on. Their CI ` +
      `passed the enum ("Category 'machine-learning' is valid") and rejected the task in the ` +
      `same run.`,
    ``,
    `Rework the SUBSTANCE of the task so it genuinely belongs to "${declared}". If the agent's ` +
      `job is "find and fix what is wrong with this code", it is software-engineering or ` +
      `debugging, whatever the metadata says. Change what the agent must build and how it is ` +
      `graded — not the label.`,
  ].join("\n");
}
