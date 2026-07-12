/**
 * Audit instruction.md against the three claims the "Prompt Check" box attests to:
 *
 *   "I reviewed my prompt (instruction.md) and:
 *      - Ensured it does not list an excessive number of requirements (20+)
 *      - Made it sound natural and human
 *      - Removed any unnecessary hints and verified it does not reveal the solution"
 *
 * The form adds: "I confirm that the above is true and understand that if not, the
 * submission is subject to rejection."
 *
 * So this is not a formality we tick past. The system only ticks that box once it has
 * actually checked the three things — and if it can't confirm them, it stops and says so
 * rather than asserting something untrue on your behalf.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface InstructionAudit {
  ok: boolean;
  problems: string[];
  stats: { words: number; requirements: number; imperativeLines: number };
}

/** Words that mark machine-written prose. The docs ban this register outright. */
const LLM_TELLS = [
  "delve", "moreover", "furthermore", "it's worth noting", "it is worth noting",
  "comprehensive", "robust", "seamless", "leverage", "utilize", "facilitate",
  "in conclusion", "additionally", "multifaceted", "pivotal", "underscore",
];

/** Phrasing that hands the agent the method instead of the goal. */
const HINT_PATTERNS: Array<[RegExp, string]> = [
  [/\bstep\s*\d\b|\bstep-by-step\b/i, "reads as step-by-step instructions"],
  [/\byou (?:should|must|need to) (?:first|then|next)\b/i, "sequences the solution for the agent"],
  [/\bhint\b|\btip:\b/i, "contains an explicit hint"],
  [/\buse the\s+\w+\s+(?:function|method|library|algorithm)\b/i, "names the implementation to use"],
  [/\bhere(?:'s| is) how\b/i, "explains how rather than what"],
];

export function lintInstruction(taskDir: string): InstructionAudit {
  const p = join(taskDir, "instruction.md");
  if (!existsSync(p)) {
    return { ok: false, problems: ["instruction.md is missing."], stats: { words: 0, requirements: 0, imperativeLines: 0 } };
  }

  const text = readFileSync(p, "utf8");
  const lower = text.toLowerCase();
  const problems: string[] = [];

  // 1. "does not list an excessive number of requirements (20+)"
  const bullets = (text.match(/^\s*(?:[-*+]|\d+[.)])\s+\S/gm) ?? []).length;
  const musts = (text.match(/\b(?:must|shall|should|has to|is required to)\b/gi) ?? []).length;
  const requirements = Math.max(bullets, musts);
  if (requirements >= 20) {
    problems.push(
      `Lists ~${requirements} requirements (${bullets} bullets, ${musts} must/should). ` +
        `The attestation says fewer than 20.`,
    );
  }

  // 2. "made it sound natural and human"
  const tells = LLM_TELLS.filter((t) => lower.includes(t));
  if (tells.length) {
    problems.push(`Contains LLM-tell words that make it read as machine-written: ${tells.join(", ")}.`);
  }
  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text)) {
    problems.push("Contains emoji. The prompt should read as a human colleague wrote it.");
  }
  const headings = (text.match(/^#{1,6}\s/gm) ?? []).length;
  if (headings >= 3) {
    problems.push(`Has ${headings} markdown headings. Real prompts are prose, not documents.`);
  }

  // 3. "removed any unnecessary hints and verified it does not reveal the solution"
  for (const [rx, why] of HINT_PATTERNS) {
    if (rx.test(text)) problems.push(`Possible hint: ${why}.`);
  }
  // Edition 2 dropped canary strings; one left in means an Edition-1 skeleton was reused.
  if (/canary|BENCHMARK DATA SHOULD NEVER APPEAR/i.test(text)) {
    problems.push("Contains a canary string. Canaries were dropped in Edition 2 and flag a stale skeleton.");
  }

  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words > 400) {
    problems.push(`${words} words. The guide asks for one sentence to three paragraphs; this reads as a spec.`);
  }

  return {
    ok: problems.length === 0,
    problems,
    stats: { words, requirements, imperativeLines: musts },
  };
}
