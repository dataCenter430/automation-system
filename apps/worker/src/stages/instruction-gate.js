/**
 * THE INSTRUCTION GATE.
 *
 * Snorkel's instruction guide is blunt about the bar:
 *
 *     "Prompts should NOT be LLM-generated. We want to avoid the 'GPT-style' of writing
 *      (verbose, repetitive, and overly polite)."
 *
 * And the Review Checklist marks it HIGH severity — a single failure and the task is not accepted.
 * So a task whose instruction reads like documentation is dead on arrival, no matter how good the
 * engineering underneath it is.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THIS IS A GATE AND NOT AN UPLOAD CHECK
 *
 * lintInstruction() has existed for a while and it is good. It ran in exactly one place:
 * upload.ts, as the thing that decides whether we may honestly tick the "Prompt Check" box.
 *
 * That is far too late. By the time upload runs, we have paid for the build, the Docker gate, the
 * oracle run, the null run and the zip — and the failure arrives as an `AttestationRefused`, which
 * is a confusing place to learn that your prose is too flowery. Worse, the fix loop never sees it:
 * the gate said the task was fine.
 *
 * So the audit runs HERE, in the gate, BEFORE Docker — next to the category classifier, and for
 * the same reason. Both are cheap, both are about SUBSTANCE rather than mechanics, and a task that
 * fails either should not pay for a six-minute image build first.
 *
 * ---------------------------------------------------------------------------------------------
 * TWO HALVES, BECAUSE ONE IS NOT ENOUGH
 *
 * MECHANICAL — the five anti-patterns the guide names, with examples, plus its hard rules
 *   (absolute paths, no canary, concise, no emoji). A regex can catch a numbered walkthrough, a
 *   "Detection Guidance" section, a wall of bold, an exact socket-buffer constant.
 *
 * A JUDGE — because the guide's actual objection is "verbose, repetitive, and overly polite", and
 *   there is no regex for that. A word list catches "delve" and "leverage"; it does not catch a
 *   paragraph that says the same thing three times in a courteous voice. So we ask a model, with a
 *   NEUTRAL prompt — and neutral is load-bearing here. The category classifier taught us this the
 *   expensive way: a prompt that TELLS the model what it is looking for gets its own vocabulary
 *   handed back. So we do not describe LLM-style. We just ask who wrote it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { subscriptionEnv } from "../claude/no-billing.ts";
import { loadConfig } from "../config.ts";
import { lintInstruction } from "./instruction-audit.ts";
// =============================================================================================
// MECHANICAL — the five anti-patterns the guide names, by name, with its own examples.
// =============================================================================================
const ANTI_PATTERNS = [
    {
        // Guide, anti-pattern #1: "Step-by-Step Walkthrough With Solution Values"
        rule: "instruction_step_by_step",
        severity: "blocking",
        message: `Reads as a step-by-step walkthrough. The guide's first named anti-pattern: "The prompt tells ` +
            `the agent exactly what to do, which defeats the purpose of the project." Give the agent the ` +
            `WHAT (requirements), never the HOW.`,
        test: (b) => {
            // Numbered headings, or 3+ numbered list items that read like a procedure.
            const steps = [...b.matchAll(/^\s*(?:#+\s*)?step\s*\d+\b.*$/gim)].map((m) => m[0].trim());
            if (steps.length)
                return steps[0];
            const numbered = [...b.matchAll(/^\s*\d+\.\s+\S.*$/gm)];
            return numbered.length >= 4 ? numbered[0][0].trim() : null;
        },
    },
    {
        // Guide, anti-pattern #2: "Hints Section That Describes the Answers"
        rule: "instruction_hints_section",
        severity: "blocking",
        message: `Contains a hints section. The guide: "We should not be giving away answers. There is a full ` +
            `section explaining exactly how to detect each type of corruption." Delete it — the task is ` +
            `supposed to be hard.`,
        test: (b) => {
            const m = /^.*\b(detection guidance|hints?|guidance|things to (?:look|check) for|look for:|watch out for|approach:|strategy:)\s*:?\s*$/gim.exec(b);
            return m ? m[0].trim() : null;
        },
    },
    {
        // Guide, anti-pattern #3: "Excessive Markdown / Bulleted Structure"
        rule: "instruction_reads_like_documentation",
        severity: "blocking",
        message: `Reads like structured documentation, not a human prompt. The guide: "Avoid excessive use of ` +
            `markdown and bullet points." A person typing to a coding agent does not write an API reference.`,
        test: (b) => {
            const lines = b.split("\n").filter((l) => l.trim());
            if (lines.length < 4)
                return null;
            const bullets = lines.filter((l) => /^\s*[-*+]\s+/.test(l)).length;
            const headings = lines.filter((l) => /^#{1,6}\s/.test(l)).length;
            const structured = bullets + headings;
            // More than half the document is bullets/headings => it is a document, not a message.
            if (structured / lines.length > 0.5 && structured >= 5) {
                return `${bullets} bullets + ${headings} headings across ${lines.length} lines`;
            }
            return headings >= 4 ? `${headings} markdown headings` : null;
        },
    },
    {
        // Guide, anti-pattern #4: "Overly Prescriptive Guidelines"
        rule: "instruction_prescribes_the_solution",
        severity: "blocking",
        message: `Prescribes the implementation. The guide: "It tells the agent the exact project structure, ` +
            `exact library to use, exact build commands." Function signatures and type annotations in an ` +
            `instruction are the answer, written out.`,
        test: (b) => {
            // A typed signature: `foo(a: Path, b: int) -> Path`  — the guide's own example.
            const sig = /\b\w+\s*\([^)]*:\s*\w+[^)]*\)\s*->\s*\w+/.exec(b);
            if (sig)
                return sig[0];
            const mustExport = /\bmust (?:export|define|implement)\b[^.\n]*\b(?:function|method|class)s?\b/i.exec(b);
            return mustExport ? mustExport[0] : null;
        },
    },
    {
        // Guide, anti-pattern #5: "Bold Markers Highlighting Solution Details"
        rule: "instruction_bold_marks_the_answer",
        severity: "warning",
        message: `Heavy use of bold. The guide: "Scattered bold markers draw attention to exact solution ` +
            `details. We should not be giving hints." If a value matters, let the agent find that out.`,
        test: (b) => {
            const bold = [...b.matchAll(/\*\*[^*\n]{2,}\*\*/g)];
            return bold.length >= 4 ? `${bold.length} bolded spans` : null;
        },
    },
    {
        // Not one of the five, but the guide's Tone row: "You are an expert programmer. Your goal is to..."
        rule: "instruction_persona_opener",
        severity: "blocking",
        message: `Opens with a persona. The guide contrasts exactly this — "You are an expert programmer. Your ` +
            `goal is to..." — against how a real person writes: "We need to migrate the existing SQLite ` +
            `schema to...". Nobody briefs a colleague by telling them who they are.`,
        test: (b) => {
            const m = /^\s*(?:#+\s*)?you are an?\b.*$|^\s*your (?:goal|task|job|mission) is\b.*$/im.exec(b);
            return m ? m[0].trim() : null;
        },
    },
];
/**
 * Run the mechanical half. Cheap, deterministic, and it names the rule it broke so the fix turn
 * has something to act on rather than a vibe.
 */
export function auditInstruction(taskDir) {
    const p = join(taskDir, "instruction.md");
    if (!existsSync(p)) {
        return [{ rule: "instruction_missing", severity: "blocking", message: "instruction.md is missing." }];
    }
    const raw = readFileSync(p, "utf8");
    // Fenced code blocks are legitimate — a schema, a sample payload, a command the task is ABOUT.
    // Judging them as prose would flag every task that shows the agent a file format.
    const body = raw.replace(/```[\s\S]*?```/g, "\n");
    const findings = [];
    for (const a of ANTI_PATTERNS) {
        const hit = a.test(body);
        if (hit)
            findings.push({ rule: a.rule, severity: a.severity, message: a.message, evidence: hit.slice(0, 120) });
    }
    // Fold in the audit that already existed — LLM-tell words, emoji, canary, hints, word count.
    // It was only ever consulted at upload time, where it was far too late to be useful.
    const legacy = lintInstruction(taskDir);
    for (const problem of legacy.problems) {
        findings.push({ rule: "instruction_prompt_check", severity: "blocking", message: problem });
    }
    return findings;
}
// =============================================================================================
// THE JUDGE — "did a human write this?"
// =============================================================================================
/**
 * NEUTRAL ON PURPOSE.
 *
 * The category classifier taught us this at the cost of a submission: my first prompt TOLD the
 * model what machine-learning looks like, in the same vocabulary the task used — and it dutifully
 * matched my description against the task and confirmed itself. A neutral prompt, given only the
 * instruction and no theory, reproduced Snorkel's verdict twice.
 *
 * So this prompt does not define "LLM style". It does not list tells. It does not mention Snorkel,
 * or a guide, or a bar to clear. It shows the model a piece of writing and asks who wrote it —
 * which is the only question whose answer we can trust.
 */
const JUDGE_PROMPT = `Below is the text of a task instruction — the message a person sends to an AI coding agent in a terminal, asking it to do a piece of work.

Read it and answer one question: WHO WROTE THIS?

- "human": a working engineer typed this to a coding agent. It sounds like a person with a problem.
- "llm": a language model generated it. It reads as produced rather than written.
- "unsure": genuinely could be either.

Reply with ONLY a JSON object, no other text:
{"author": "human" | "llm" | "unsure", "confidence": 0.0-1.0, "why": "<one sentence, quoting the specific thing that decided it>"}

The instruction:
---
{{instruction}}
---`;
/**
 * Ask the model who wrote it.
 *
 * Runs on the classifier model (haiku) — the same one Snorkel's own CI announces. Returns null if
 * it cannot run, and null is NEVER a pass: the caller blocks, because "we could not check" and
 * "it is fine" are different answers and only one of them is safe to act on.
 */
export async function judgeStyle(taskDir, timeoutMin = 3) {
    const p = join(taskDir, "instruction.md");
    if (!existsSync(p))
        return null;
    const instruction = readFileSync(p, "utf8").trim();
    if (!instruction)
        return null;
    const cfg = loadConfig();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMin * 60_000);
    try {
        let text = "";
        const stream = query({
            prompt: JUDGE_PROMPT.replace("{{instruction}}", instruction),
            options: {
                abortController: abort,
                cwd: taskDir,
                settingSources: [],
                // It reads one string we hand it. It has no business touching the filesystem.
                tools: [],
                model: cfg.claude.classifierModel,
                env: subscriptionEnv(),
                systemPrompt: { type: "preset", preset: "claude_code" },
            },
        });
        for await (const m of stream) {
            if (m.type === "result" && m.subtype === "success")
                text = String(m.result ?? "");
        }
        const json = /\{[\s\S]*\}/.exec(text);
        if (!json)
            return null;
        const v = JSON.parse(json[0]);
        if (!["human", "llm", "unsure"].includes(v.author))
            return null;
        return { author: v.author, confidence: Number(v.confidence) || 0, why: String(v.why ?? "") };
    }
    catch {
        return null;
    }
    finally {
        clearTimeout(timer);
    }
}
// =============================================================================================
/**
 * The gate.
 *
 * `styleBlocksAt` is the confidence at which an "llm" verdict is fatal. Not 0.5: a judge that is
 * merely leaning is not evidence, and blocking a good task because a model was 55% suspicious of
 * its prose would make this gate the enemy. 0.75 is a model that is fairly sure.
 */
export async function instructionGate(taskDir, opts = {}) {
    const findings = auditInstruction(taskDir);
    const blocksAt = opts.styleBlocksAt ?? 0.75;
    let style = null;
    if (opts.judge !== false) {
        style = await judgeStyle(taskDir);
        if (style === null) {
            findings.push({
                rule: "instruction_style_unchecked",
                severity: "warning",
                message: `The human-style judge could not run, so nobody has checked whether this instruction ` +
                    `reads as machine-written. That is NOT a pass — Snorkel rejects LLM-style prompts, and ` +
                    `this is the one check that can see it.`,
            });
        }
        else if (style.author === "llm" && style.confidence >= blocksAt) {
            findings.push({
                rule: "instruction_reads_as_llm_written",
                severity: "blocking",
                message: `This instruction reads as machine-written (confidence ${style.confidence.toFixed(2)}). ` +
                    `Snorkel's guide: "Prompts should NOT be LLM-generated. We want to avoid the 'GPT-style' ` +
                    `of writing (verbose, repetitive, and overly polite)."\n\n` +
                    `The judge's reason: ${style.why}\n\n` +
                    `Rewrite it the way you would actually type it to a coding agent: say what you need and ` +
                    `what "done" looks like, then stop. One sentence to three paragraphs. No preamble, no ` +
                    `politeness, no summary of what you just said.`,
                evidence: style.why,
            });
        }
    }
    return {
        ok: !findings.some((f) => f.severity === "blocking"),
        findings,
        style,
    };
}
/** The report the fix loop reads. Named rules, not vibes. */
export function formatInstructionVerdict(v) {
    const lines = [`STAGE: instruction gate (no Docker was run)`, ``];
    if (v.style) {
        lines.push(`Style judge: "${v.style.author}" (${v.style.confidence.toFixed(2)}) — ${v.style.why}`, ``);
    }
    const blocking = v.findings.filter((f) => f.severity === "blocking");
    const warnings = v.findings.filter((f) => f.severity === "warning");
    if (blocking.length) {
        lines.push(`BLOCKING (${blocking.length}):`, ``);
        for (const f of blocking) {
            lines.push(`❌ [${f.rule}]`);
            if (f.evidence)
                lines.push(`     ${f.evidence}`);
            lines.push(`     ${f.message}`, ``);
        }
    }
    if (warnings.length) {
        lines.push(`WARNINGS (${warnings.length}):`, ``);
        for (const f of warnings) {
            lines.push(`⚠️  [${f.rule}] ${f.message}`, ``);
        }
    }
    lines.push(`instruction.md is the primary interface between the task and the agent, and the Review`, `Checklist marks every one of these HIGH severity — a single failure and the task is not`, `accepted. Rewrite the prompt. Do not touch the task.`);
    return lines.join("\n");
}
