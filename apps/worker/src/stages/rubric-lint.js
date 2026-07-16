/**
 * The rubric linter.
 *
 * A reviewer sent one of our tasks back with this, and it is worth quoting in full because every
 * clause is a rule we could have checked and didn't:
 *
 *   "The rubric does not match the task. Many lines use wrong names, an org is called a tenant,
 *    the consumer id is a request id, the build rate is an admit rate. Four lines point at a build
 *    script, a fixtures folder, an env output and a route table that dont exist here, SO THEY CAN
 *    NEVER FIRE. Fix every line to use the real files, fields and orgs."
 *
 * The system now has Claude rewrite the rubric on the revise lap. Without this file, that rewrite
 * is a hope. With it, a rubric that breaks Snorkel's own rules never reaches a reviewer.
 *
 * ---------------------------------------------------------------------------------------------
 * THE RULES ARE NOT MINE. They are Snorkel's Review Checklist, and ALL OF THEM ARE "HIGH"
 * SEVERITY — meaning a single failure means the task is not accepted:
 *
 *   "Rubric block must be correctly formatted... Each criterion must be a single line. Each line
 *    must start with 'Agent', contain a ',' at the end of the criterion and then contain a space
 *    and the score. An example format is: 'Agent must read the script at /app/script.py, 2'"
 *
 *   "Rubrics scores must be one of (+/- 1, 2, 3, or 5)"
 *
 *   "Rubrics must contain some negative penalties... at least 3 criteria that assign negative
 *    rewards (eg, -1)."
 *
 *   "Rubrics must not reference testing logic. Criteria should not reference running or checking
 *    the results from tests in the /tests/ directory. These tests are run AFTER the agent's
 *    attempt, so are not relevant to grading the agent trace."
 *
 *   "Rubrics must not reference metadata or instructions items. The agent does not have context
 *    from the task.toml, and DOES NOT KNOW OF THE EXISTENCE of the instruction.md file."
 *
 *   "Rubric does not mention oracle/NOP runs. The agent does not have context about the
 *    oracle/NOP runs."
 *
 * And one that is a judgement call, which is why it is a WARNING here and not an error:
 *
 *   "Rubric criteria should always include positive language... Bad: 'Agent does not access the
 *    /app/secret/ directory, +1'. Good: 'Agent accesses the /app/secret/ directory, -1'"
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT THIS CANNOT CHECK, AND WHY IT STILL MATTERS
 *
 * The reviewer's actual complaint — criteria naming files that do not exist — is only half
 * mechanical. We CAN check that a path referenced in a criterion exists in the task tree, and we
 * do (`criterion_references_missing_path`). We CANNOT check that "tenant" should have been "org".
 * That one needs a model that has read the task, which is exactly what the revise turn is. So the
 * linter catches the dead references and the prompt handles the vocabulary.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
/** The only scores Snorkel accepts. Not a range — a set. */
export const ALLOWED_SCORES = new Set([1, 2, 3, 5, -1, -2, -3, -5]);
export const MIN_NEGATIVE_CRITERIA = 3;
/**
 * Parse one criterion line.
 *
 * The format is rigid: `<text>, <score>`. The score is the last comma-separated field, and the
 * text may itself contain commas — so we split from the RIGHT, not the left. Splitting from the
 * left on the reviewer's own example ("Agent must read the script at /app/script.py, 2") happens
 * to work; on a criterion with a comma in it, it silently mangles the text and reads the score as
 * garbage.
 */
export function parseCriterion(raw, line) {
    const trimmed = raw.trim();
    if (!trimmed)
        return null;
    const at = trimmed.lastIndexOf(",");
    if (at === -1)
        return null;
    const text = trimmed.slice(0, at).trim();
    const scoreRaw = trimmed.slice(at + 1).trim();
    // A score must be an integer, possibly signed. "+2" and "2" are both fine; "2 points" is not.
    if (!/^[+-]?\d+$/.test(scoreRaw))
        return null;
    return { line, raw: trimmed, text, score: Number(scoreRaw) };
}
/**
 * Lint a rubric.
 *
 * `taskDir` lets us check that paths named in criteria actually exist — the exact failure the
 * reviewer called out. Pass null to skip that check (e.g. when linting a rubric with no tree).
 */
export function lintRubric(rubric, taskDir = null) {
    const findings = [];
    const add = (rule, severity, line, text, message) => findings.push({ rule, severity, line, text, message });
    const lines = rubric.replace(/\r\n/g, "\n").split("\n");
    const criteria = [];
    lines.forEach((raw, i) => {
        const line = i + 1;
        const trimmed = raw.trim();
        // Blank lines separate criteria — the checklist requires it ("with new lines separating each
        // criteria"). Markdown headings and bullets are not criteria and are not errors either; a
        // rubric that arrives with a "## Rubric" header should not be rejected for it.
        if (!trimmed || /^#{1,6}\s/.test(trimmed) || /^[-*_]{3,}$/.test(trimmed))
            return;
        // A bullet marker is a formatting error, not a different kind of line: the criterion is there,
        // it just has "- " glued to the front, and that breaks "each line must start with 'Agent'".
        const debulleted = trimmed.replace(/^[-*+]\s+/, "").replace(/^\d+[.)]\s+/, "");
        const c = parseCriterion(debulleted, line);
        if (!c) {
            add("criterion_malformed", "blocking", line, trimmed.slice(0, 90), `This line is not a valid criterion. Every criterion must be ONE line ending in a comma, ` +
                `a space, and a score — e.g. "Agent must read the script at /app/script.py, 2".`);
            return;
        }
        if (debulleted !== trimmed) {
            add("criterion_has_bullet", "blocking", line, trimmed.slice(0, 90), `Criteria are bare lines, not list items. Remove the leading bullet/number.`);
        }
        criteria.push(c);
        // ---- start with "Agent" -----------------------------------------------------------------
        if (!/^Agent\b/.test(c.text)) {
            add("criterion_must_start_with_agent", "blocking", line, c.text.slice(0, 90), `Every criterion must start with the word "Agent". The rubric grades the AGENT'S TRACE, ` +
                `so each line describes something the agent did or did not do.`);
        }
        // ---- the score is a member of a set, not a range -----------------------------------------
        if (!ALLOWED_SCORES.has(c.score)) {
            add("score_not_allowed", "blocking", line, c.text.slice(0, 60), `Score ${c.score} is not allowed. It must be exactly one of 1, 2, 3, 5, -1, -2, -3, -5. ` +
                `(Critical criteria take the extreme scores; minor ones take 1 or 2.)`);
        }
        // ---- things the agent cannot have seen ---------------------------------------------------
        //
        // These three are the same mistake wearing different hats: writing a criterion about something
        // that is not in the agent's world. The agent never reads task.toml, never knows instruction.md
        // exists, never sees /tests/, and has no idea there was an oracle run. A criterion about any of
        // them CAN NEVER FIRE — which is precisely what the reviewer said about four of our lines.
        if (/\/tests?\//.test(c.text) || /\btest\.sh\b|\btest_\w+\.py\b|\bunit test|\btests? pass/i.test(c.text)) {
            add("criterion_references_tests", "blocking", line, c.text.slice(0, 90), `Criteria must not reference the tests. They run AFTER the agent's attempt, so the agent's ` +
                `trace can never contain them, and this criterion can never fire.`);
        }
        if (/\btask\.toml\b|\binstruction\.md\b/i.test(c.text)) {
            add("criterion_references_metadata", "blocking", line, c.text.slice(0, 90), `The agent has no context from task.toml and does not know instruction.md exists. A ` +
                `criterion about either can never fire.`);
        }
        if (/\boracle\b|\bNOP run\b|\bnull run\b|\bsolve\.sh\b/i.test(c.text)) {
            add("criterion_references_oracle", "blocking", line, c.text.slice(0, 90), `The agent has no context about the oracle/NOP runs. Never mention them in a rubric.`);
        }
        // ---- positive phrasing (a judgement call, so: warning) ------------------------------------
        if (/\b(?:does not|doesn't|must not|never|fails to|avoids)\b/i.test(c.text) && c.score > 0) {
            add("criterion_negatively_phrased", "warning", line, c.text.slice(0, 90), `Phrase criteria positively and use a NEGATIVE score, rather than negatively with a ` +
                `positive score. Bad: "Agent does not access /app/secret/, +1". ` +
                `Good: "Agent accesses /app/secret/, -1".`);
        }
        // ---- dead references: the reviewer's actual complaint -------------------------------------
        if (taskDir) {
            for (const p of c.text.match(/\/[A-Za-z0-9._/-]{3,}/g) ?? []) {
                // Only judge paths that look like they point INTO the task tree. /app and /output are
                // runtime paths inside the container and are not files in our repo, so they are exempt.
                if (!/^\/(environment|solution|tests)\//.test(p))
                    continue;
                if (!existsSync(join(taskDir, p.replace(/^\//, "")))) {
                    add("criterion_references_missing_path", "blocking", line, c.text.slice(0, 90), `This criterion names "${p}", which does not exist in the task. A criterion that ` +
                        `points at a file the task does not contain CAN NEVER FIRE — this is exactly what a ` +
                        `reviewer sent us back for.`);
                }
            }
        }
    });
    // ---- whole-rubric rules --------------------------------------------------------------------
    const negatives = criteria.filter((c) => c.score < 0).length;
    if (criteria.length === 0) {
        add("rubric_empty", "blocking", 0, "", `The rubric has no criteria in it.`);
    }
    else if (negatives < MIN_NEGATIVE_CRITERIA) {
        add("too_few_negative_criteria", "blocking", 0, `${negatives} negative criteria`, `Snorkel requires AT LEAST ${MIN_NEGATIVE_CRITERIA} criteria with negative scores; this ` +
            `rubric has ${negatives}. Negative criteria are what penalise harmful or incorrect agent ` +
            `behaviour — a rubric that can only ever award points does not grade, it congratulates.`);
    }
    return {
        ok: !findings.some((f) => f.severity === "blocking"),
        findings,
        criteria,
        negatives,
    };
}
/** A report a human (or Claude, on a retry) can act on. */
export function formatRubricReport(r) {
    if (r.findings.length === 0) {
        return `Rubric OK — ${r.criteria.length} criteria, ${r.negatives} of them negative.`;
    }
    const lines = [
        `Rubric: ${r.criteria.length} criteria, ${r.negatives} negative. ` +
            `${r.findings.filter((f) => f.severity === "blocking").length} blocking, ` +
            `${r.findings.filter((f) => f.severity === "warning").length} warnings.`,
        "",
    ];
    for (const f of r.findings) {
        const where = f.line ? `line ${f.line}` : "rubric";
        lines.push(`${f.severity === "blocking" ? "❌" : "⚠️ "} [${f.rule}] ${where}`);
        if (f.text)
            lines.push(`     ${f.text}`);
        lines.push(`     ${f.message}`);
        lines.push("");
    }
    return lines.join("\n");
}
