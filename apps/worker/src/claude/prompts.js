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
export function render(templateName, vars) {
    let s = readFileSync(resolve(PROMPTS_DIR, templateName), "utf8");
    // Conditional blocks first, so an empty var removes its whole section rather
    // than leaving a dangling "**Additional Inspiration**" header with nothing under it.
    s = s.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_m, key, body) => {
        const v = vars[key];
        return v === undefined || v === null || v === "" ? "" : body;
    });
    s = s.replace(/\{\{(\w+)\}\}/g, (_m, key) => {
        const v = vars[key];
        if (v === undefined || v === null)
            return "";
        return String(v);
    });
    const leftover = /\{\{[#/]?\w+\}\}/.exec(s);
    if (leftover) {
        throw new Error(`Prompt ${templateName} still has an unsubstituted placeholder: ${leftover[0]}`);
    }
    return s.trim() + "\n";
}
export function loadSummary() {
    const s = readFileSync(resolve(PROMPTS_DIR, "summary.txt"), "utf8").trim();
    if (s.length < 2000) {
        throw new Error("prompts/summary.txt looks empty or truncated. It is the playbook the build session " +
            "is grounded in; a stub here quietly produces rejected tasks. Regenerate it.");
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

8. CATEGORY IS SUBSTANCE, NOT LABEL. This is the rule that gets tasks rejected.
   The category is decided by an LLM CLASSIFIER THAT READS THE TASK'S CONTENT — instruction.md,
   the source you ship, solve.sh, the test names. It NEVER reads task.toml. Snorkel BLOCKS
   \`software-engineering\`, \`debugging\` and \`data-processing\`: if the classifier puts your task
   in one of those, it is rejected outright no matter what the enum says. Use the \`category\`
   you were given verbatim in task.toml AND make the task genuinely be that category.

   GATE, before you write a line of instruction.md. Complete in <=15 words:
     "The agent must produce ___, judged correct by ___."
   Three ways that sentence gets you rejected. TWO OF THEM WE HAVE ALREADY SHIPPED AND HAD
   REJECTED, so they are not hypothetical:
     - "a corrected source file" / "the code now behaves correctly"
         -> software-engineering, or debugging if the agent must FIND the fault. REJECTED (0.95).
     - "a migrated / rematerialized dataset, table or feature store" / "the output data matches
       the new spec"
         -> data-processing. ETL is ETL however much machine-learning vocabulary surrounds it.
            REJECTED (0.90) — this was our second attempt, and we walked into it while escaping
            the first.
     - anything whose grading sentence ends "...the output is correct" rather than naming a
       MODEL quantity.
   If your sentence reads like any of those, STOP and redesign the substance. Do not adjust the
   wording; the classifier is not reading for wording.

   BANNED — never in instruction.md, the title, shipped source comments, solve.sh or test names:
   - "there are N bugs/defects", "fix the broken X", "X produces wrong/incorrect output",
     "something is off", "I wouldn't trust the other calculations", "debug/root-cause/track down",
     "make the failing tests pass"
   - planted-defect comments in shipped source (\`// DEFECT #1: WRONG — should be 45\`). They also
     leak the oracle and void \`long_context\`.
   - an oracle that is \`sed\` one-liners over constants, or a diff that only flips literals and
     operators.

   REQUIRED INSTEAD. Nothing in the environment is ever *in error*. Pre-existing values are
   legitimately correct for a prior version or configuration (a v2 spec, an old calibration);
   the agent DERIVES the current definition from the shipped specification and BUILDS the current
   artifact.

   For \`machine-learning\` specifically — and read this twice, because a plausible-sounding
   near-miss is what cost us the second submission:

     BUILDING A FEATURE PIPELINE IS NOT MACHINE LEARNING. It is data-processing, and
     data-processing is BLOCKED. Materializing a feature store, computing features to a spec,
     migrating a table between schema versions, even computing drift/PSI over two datasets —
     every one of those is graded on WHETHER THE OUTPUT DATA IS CORRECT, and that is ETL.

     Machine-learning means the deliverable and the GRADING are about MODEL BEHAVIOUR:
       - train or fit a model, and be graded on its quality
       - EVALUATE a model: precision, recall, PR-AUC, a confusion matrix, per-stratum metrics
       - CALIBRATE: pick an operating threshold that hits a stated target (e.g. maximise
         precision subject to recall >= 0.95), graded on the threshold and the metric it achieves
       - select an operating point, measure calibration error, compare models
     The test names are the tell. \`test_output_table_matches_spec\` is data-processing.
     \`test_threshold_achieves_recall_0_95\` / \`test_pr_auc_above_baseline\` is machine-learning.

   Domain nouns in the environment (a "classifier", a "feature store", a "model registry") are
   SET DRESSING. The classifier reads the agent's DELIVERABLE and the GRADING criteria, and it
   is not fooled by vocabulary — ours was, and that is exactly why this paragraph exists.
   Implementation language is irrelevant: six seds over constants is debugging in any domain.
   \`long_context\` payload must be a specification the agent implements, never a hiding place
   for a bug, and never shortcut-able by comments in the shipped source.

   SELF-CHECK before you finish: read instruction.md ALONE — no task.toml, no tags — and answer
   "which single category is this, at what confidence?". If it is not the assigned category at
   high confidence, or is a blocked category at any confidence, the task is NOT shippable.
   Iterate on the deliverables and the instruction, never on the metadata.

9. instruction.md states WHAT correct behaviour is and its acceptance criteria — never HOW to
   build or test. No "rebuild with \`make\`", no "set VAR=...", no step-by-step developer workflow,
   no test commands. Specify required outputs: exact paths, formats, values, tolerances. Build
   and verification procedure belongs in tests/ and the Dockerfile, not in the prompt.

10. Every Python file in the zip must be ruff-clean: no unused imports (F401), no f-string
    without a placeholder (F541), no unused variables (F841). Run \`ruff check tests/\` yourself
    before you claim done. Ship no scratch/helper scripts — they get linted too.

11. codebase_size must match the ACTUAL file count under environment/, excluding Dockerfile and
    docker-compose: <=20 files -> "minimal", 20+ -> "small", 200+ -> "large". Count it
    (\`find environment -type f | grep -v Dockerfile | wc -l\`); never guess.

12. THERE IS A HUMAN, AND YOU CAN REACH THEM. You are running unattended, but you are not
    alone: the \`ask_human\` tool posts a question to the operator's dashboard and BLOCKS until
    they answer. Use it for exactly one thing — a decision that changes what the task IS and
    that you cannot settle from the brief, the playbook, or the source material. Rule 8 is the
    canonical case: if you are about to redesign a task and you are not certain the new design
    escapes every blocked category, that is a question, not a coin flip. Two submissions have
    already been rejected for a design decision made silently.

    Do NOT use it to ask permission to proceed, to confirm something you already know, to
    report progress, or to pick between things that do not matter. Every question freezes one
    of a small number of build slots while a person reads it, so a needless question is not
    free — it stalls the fleet. Give real options with real consequences, and keep building
    everything that does not depend on the answer while you wait.

    If nobody answers, you will be told so and asked to use your best judgment. When that
    happens, say in your final message which choice you made without a human. Do not ask twice.

Never claim the task is finished on the basis of code that looks right. Build the image,
run the oracle, run the tests, and read the reward file. A false "verified green" is the
single most expensive thing you can do here, because the gate will catch it and hand it
straight back to you.
`.trim();
