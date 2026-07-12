/**
 * Generate the three submission-form explanations in the VISIBLE Claude conversation.
 *
 * Same session that built the task, so Claude writes from what it actually built rather
 * than from the premise. It writes the JSON to a file, we read the file — the chat panel is
 * for you to watch, not for us to parse.
 *
 * Then we validate. The Snorkel docs ban LLM-tell prose, so generating these with an LLM and
 * shipping them unread would be self-defeating.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "../claude/prompts.ts";
import { openWorkspace, sendPrompt } from "../vscode/ui.ts";
import { waitForTurn, clearSentinel } from "../vscode/watch.ts";
import { validateExplanation, type Explanations } from "./explain.ts";

const OUT = ".pipeline/EXPLANATIONS.json";

export async function generateExplanationsVisually(args: {
  workspace: string;
  maxAttempts: number;
  timeoutMin: number;
  onProgress?: (msg: string) => Promise<void>;
}): Promise<{ explanations: Explanations; attempts: number }> {
  await openWorkspace(args.workspace);

  let prompt = render("04-explain.md", {});
  let lastProblems: string[] = [];

  for (let attempt = 1; attempt <= args.maxAttempts; attempt++) {
    clearSentinel(args.workspace, "EXPLAIN_DONE");

    await sendPrompt(args.workspace, prompt, "PROMPT_04_EXPLAIN");
    await args.onProgress?.(`explanations: attempt ${attempt}/${args.maxAttempts}`);

    const r = await waitForTurn({
      workspace: args.workspace,
      sentinelName: "EXPLAIN_DONE",
      timeoutMin: args.timeoutMin,
      requireFiles: [OUT],
      onHeartbeat: async (h) => args.onProgress?.(`writing explanations · ${h.elapsedSec}s`),
    });
    if (!r.done) throw new Error(`Explanations never arrived.\n${r.reason}`);

    const path = join(args.workspace, OUT);
    if (!existsSync(path)) throw new Error(`Claude signalled done but ${OUT} is not there.`);

    let parsed: { difficulty?: string; solution?: string; verification?: string };
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      prompt = `${OUT} is not valid JSON (${(e as Error).message}). Rewrite it as a plain JSON object with keys difficulty, solution, verification, then write .pipeline/EXPLAIN_DONE again.`;
      continue;
    }

    const explanations: Explanations = {
      difficulty: String(parsed.difficulty ?? "").trim(),
      solution: String(parsed.solution ?? "").trim(),
      verification: String(parsed.verification ?? "").trim(),
    };

    lastProblems = [
      ...validateExplanation("Difficulty Explanation", explanations.difficulty),
      ...validateExplanation("Solution Explanation", explanations.solution),
      ...validateExplanation("Verification Explanation", explanations.verification),
    ];
    if (lastProblems.length === 0) return { explanations, attempts: attempt };

    prompt =
      `Those explanations do not pass the style check. Fix exactly these problems, rewrite ` +
      `${OUT}, and write .pipeline/EXPLAIN_DONE again:\n\n` +
      lastProblems.map((p) => `- ${p}`).join("\n");
  }

  throw new Error(
    `Could not get usable explanations after ${args.maxAttempts} attempts. Last problems:\n` +
      lastProblems.map((p) => `  - ${p}`).join("\n"),
  );
}
