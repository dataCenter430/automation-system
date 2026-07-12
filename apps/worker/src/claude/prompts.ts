/**
 * Prompt templates live in prompts/*.md as plain text, so they can be edited and
 * A/B'd without touching code. They are the tuning surface of this whole system:
 * when acceptance rate drops, prompts/summary.txt and prompts/02-build.md are the
 * files to change, not the pipeline.
 *
 * Deliberately tiny template language — {{var}} and {{#var}}…{{/var}} blocks. Anything
 * more and people start putting logic in the prompts.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT } from "../../../../packages/shared/src/paths.ts";

// Repo-relative, not cwd-relative: the worker must behave identically whether it is
// launched from the repo, a service wrapper, or a scheduled task on the target machine.
const PROMPTS_DIR = resolve(REPO_ROOT, "prompts");

export type Vars = Record<string, string | number | null | undefined>;

export function render(templateName: string, vars: Vars): string {
  let s = readFileSync(resolve(PROMPTS_DIR, templateName), "utf8");

  // Conditional blocks first, so an empty var removes its whole section rather
  // than leaving a dangling "**Additional Inspiration**" header with nothing under it.
  s = s.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_m, key: string, body: string) => {
    const v = vars[key];
    return v === undefined || v === null || v === "" ? "" : body;
  });

  s = s.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => {
    const v = vars[key];
    if (v === undefined || v === null) return "";
    return String(v);
  });

  const leftover = /\{\{[#/]?\w+\}\}/.exec(s);
  if (leftover) {
    throw new Error(`Prompt ${templateName} still has an unsubstituted placeholder: ${leftover[0]}`);
  }
  return s.trim() + "\n";
}

export function loadSummary(): string {
  const s = readFileSync(resolve(PROMPTS_DIR, "summary.txt"), "utf8").trim();
  if (s.length < 2000) {
    throw new Error(
      "prompts/summary.txt looks empty or truncated. It is the playbook the build session " +
        "is grounded in; a stub here quietly produces rejected tasks. Regenerate it.",
    );
  }
  return s;
}

/**
 * Appended to the Claude Code system prompt for every turn of a build session, and
 * also written to workspace/<slug>/CLAUDE.md.
 *
 * The duplication is on purpose: a long build will compact, and compaction summarizes
 * away the opening prompts — but CLAUDE.md is re-injected on every request. This is the
 * set of rules that must survive that.
 */
export const BUILD_CONTRACT = `
You are building a Terminus 2nd-Edition task for submission to Snorkel.

Non-negotiables, checked mechanically the moment you claim to be done:

1. The oracle must pass. \`bash /solution/solve.sh\` then \`bash /tests/test.sh\` must leave
   \`1\` in /logs/verifier/reward.txt.
2. The null run must fail. The same tests, with NO solution applied, must leave \`0\`.
   Tests that pass without the solution are an explicit rejection criterion.
3. There is no network at test time (\`allow_internet = false\`). Every verifier dependency
   must be baked into environment/Dockerfile. No pip install in tests/test.sh.
4. Never COPY solution/ or tests/ into the image. They are mounted at runtime.
5. Base images must be digest-pinned (@sha256:...).
6. tests/test.sh must end with the canonical reward block, exactly, with no comment or
   blank line between \`RC=$?\` and the \`if\`, and no trailing \`exit "$RC"\`.
7. All files that run in the container (*.sh, *.py, Dockerfile) must use LF line endings.
8. The \`category\` in task.toml is given to you already resolved. Use it verbatim. Snorkel is
   NOT currently accepting \`software-engineering\`, \`debugging\`, or \`data-processing\` — never
   substitute one of those, and do not shape the task so that it would obviously belong to
   one of them.

Never claim the task is finished on the basis of code that looks right. Build the image,
run the oracle, run the tests, and read the reward file. A false "verified green" is the
single most expensive thing you can do here, because the gate will catch it and hand it
straight back to you.
`.trim();
