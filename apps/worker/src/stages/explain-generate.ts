/**
 * Generate the three submission-form explanations.
 *
 * Runs in the SAME session that built the task, so Claude writes from what it actually
 * built rather than from the premise it was handed. It writes JSON to a file and we read
 * the file — we never parse prose out of a chat message.
 *
 * Then we validate. The Snorkel docs explicitly ban LLM-tell prose, so generating these
 * with an LLM and shipping them unread would be self-defeating. Anything that fails goes
 * back for a rewrite with the specific complaint attached.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "../claude/prompts.ts";
import { runTurn } from "../claude/session.ts";
import { validateExplanation, type Explanations } from "./explain.ts";

const OUT = ".pipeline/EXPLANATIONS.json";

export async function generateExplanations(args: {
  workspace: string;
  sessionId: string | null;
  maxAttempts: number;
  timeoutMin: number;
  onProgress?: (msg: string) => Promise<void>;
}): Promise<{ explanations: Explanations; attempts: number }> {
  let prompt = render("04-explain.md", {});
  let lastProblems: string[] = [];
  let sessionId = args.sessionId;

  for (let attempt = 1; attempt <= args.maxAttempts; attempt++) {
    await args.onProgress?.(`explanations: attempt ${attempt}/${args.maxAttempts}`);

    const r = await runTurn({
      prompt,
      cwd: args.workspace,
      resume: sessionId,
      timeoutMin: args.timeoutMin,
      label: "writing explanations",
      onProgress: args.onProgress,
    });
    sessionId = r.sessionId ?? sessionId;

    const path = join(args.workspace, OUT);
    if (!existsSync(path)) {
      prompt =
        `You did not write ${OUT}. Write it now: a plain JSON object with exactly the keys ` +
        `difficulty, solution, verification, each a string.`;
      continue;
    }

    let parsed: { difficulty?: string; solution?: string; verification?: string };
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      prompt =
        `${OUT} is not valid JSON (${(e as Error).message}). Rewrite it as a plain JSON ` +
        `object with keys difficulty, solution, verification.`;
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

    await args.onProgress?.(`style check failed: ${lastProblems.length} problem(s)`);
    prompt =
      `Those explanations do not pass the style check. Fix exactly these problems and ` +
      `rewrite ${OUT}:\n\n` +
      lastProblems.map((p) => `- ${p}`).join("\n");
  }

  throw new Error(
    `Could not get usable explanations after ${args.maxAttempts} attempts. Last problems:\n` +
      lastProblems.map((p) => `  - ${p}`).join("\n"),
  );
}
