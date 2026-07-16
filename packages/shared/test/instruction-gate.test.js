/**
 * The instruction gate.
 *
 * Snorkel's guide: "Prompts should NOT be LLM-generated. We want to avoid the 'GPT-style' of
 * writing (verbose, repetitive, and overly polite)." The Review Checklist marks every instruction
 * criterion HIGH severity — one failure and the task is not accepted.
 *
 * These test the MECHANICAL half — the five anti-patterns the guide names, with its own examples.
 * The style JUDGE is an LLM call and is not unit-tested here; it was run against all six real task
 * workspaces and correctly split them 4 human / 2 llm.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditInstruction } from "../../../apps/worker/src/stages/instruction-gate.ts";
function withInstruction(md) {
    const d = mkdtempSync(join(tmpdir(), "instr-"));
    writeFileSync(join(d, "instruction.md"), md);
    return d;
}
const rules = (d) => auditInstruction(d).map((f) => f.rule);
/** A good one: a person, typing to an agent, saying what they need and stopping. */
const GOOD = `The thumbnail verifier at /app/verify.lua accepts evidence it shouldn't — we've seen it
pass a capture whose key was revoked last month, and one that's just a replay of an older valid
capture. It only ever checks the embedded HMAC.

Make it consult the trust ledger in /app/trust.db before it accepts anything. A verdict record goes
to /app/out/verdicts.json.`;
test("a real human prompt passes cleanly", () => {
    const d = withInstruction(GOOD);
    try {
        assert.deepEqual(auditInstruction(d), [], "a good prompt must not be flagged");
    }
    finally {
        rmSync(d, { recursive: true, force: true });
    }
});
test("ANTI-PATTERN 1: step-by-step walkthrough with solution values", () => {
    // The guide's own example, near enough. "The prompt tells the agent exactly what to do, which
    // defeats the purpose of the project."
    const d = withInstruction(`### Step 3: Optimize the File Sync Utility

Modify /app/file_sync.py to implement the following:

1. Set SO_RCVBUF to 262144 bytes
2. Set SO_SNDBUF to 262144 bytes
3. Enable SO_REUSEADDR
4. Use 65536 byte chunks for reading
`);
    try {
        assert.ok(rules(d).includes("instruction_step_by_step"));
    }
    finally {
        rmSync(d, { recursive: true, force: true });
    }
});
test("ANTI-PATTERN 2: a hints section that describes the answers", () => {
    // "There is a full section explaining exactly how to detect each type of corruption."
    for (const heading of ["Detection Guidance", "Hints", "Look for:", "Things to check for"]) {
        const d = withInstruction(`${GOOD}\n\n## ${heading}\n\nCurrency conversion anomalies that affect only specific codes.\n`);
        try {
            assert.ok(rules(d).includes("instruction_hints_section"), heading);
        }
        finally {
            rmSync(d, { recursive: true, force: true });
        }
    }
});
test("ANTI-PATTERN 3: excessive markdown — it reads like documentation", () => {
    // "This reads like structured documentation, not a human prompt."
    const d = withInstruction(`# Endpoints

## revenue-by-category GET
- Array sorted by totalRevenue desc
- Fields: category, totalRevenue, orderCount

## top-customers GET
- Array sorted by totalSpent desc
- Optional ?limit=N (default 5)

## order-status-summary GET
- Array sorted by count desc
- Fields: status, count, percentage
`);
    try {
        assert.ok(rules(d).includes("instruction_reads_like_documentation"));
    }
    finally {
        rmSync(d, { recursive: true, force: true });
    }
});
test("ANTI-PATTERN 4: prescribing the implementation (signatures are the answer, written out)", () => {
    // "It tells the agent the exact project structure, exact library to use, exact build commands."
    const d = withInstruction(`${GOOD}

backend/processor.py must export four functions:
  apply_grayscale(input_path: Path, output_path: Path) -> Path
  apply_rotate(input_path: Path, output_path: Path, angle: float) -> Path
`);
    try {
        assert.ok(rules(d).includes("instruction_prescribes_the_solution"));
    }
    finally {
        rmSync(d, { recursive: true, force: true });
    }
});
test("ANTI-PATTERN 5: bold markers pointing at the answer", () => {
    const d = withInstruction(`${GOOD}

**Policy limit**: $500 USD per single expense.
**Note:** Violations operate **independently** from the approval system.
**Compliance Rate**: 1.0 - (violation_count / total_expenses)
`);
    try {
        assert.ok(rules(d).includes("instruction_bold_marks_the_answer"));
    }
    finally {
        rmSync(d, { recursive: true, force: true });
    }
});
test("the persona opener — the guide contrasts it against how a person actually writes", () => {
    // Guide's Tone row: "You are an expert programmer. Your goal is to..." vs
    //                   "We need to migrate the existing SQLite schema to..."
    for (const opener of ["You are an expert programmer.", "Your goal is to harden the verifier."]) {
        const d = withInstruction(`${opener}\n\n${GOOD}`);
        try {
            assert.ok(rules(d).includes("instruction_persona_opener"), opener);
        }
        finally {
            rmSync(d, { recursive: true, force: true });
        }
    }
});
test("fenced code is NOT prose — a schema or a payload must not trip the prose rules", () => {
    // A task that shows the agent a file format is a normal task. Judging the contents of a fenced
    // block as if it were the author's writing would flag every one of them.
    const d = withInstruction(`${GOOD}

The ledger rows look like this:

\`\`\`json
{
  "key_id": "...",
  "revoked_at": "2026-01-01T00:00:00Z",
  "reason": "compromise"
}
\`\`\`
`);
    try {
        assert.deepEqual(auditInstruction(d), [], "fenced code must not be read as prose");
    }
    finally {
        rmSync(d, { recursive: true, force: true });
    }
});
test("a missing instruction.md is blocking, not silently fine", () => {
    const d = mkdtempSync(join(tmpdir(), "instr-"));
    try {
        const f = auditInstruction(d);
        assert.equal(f.length, 1);
        assert.equal(f[0].rule, "instruction_missing");
        assert.equal(f[0].severity, "blocking");
    }
    finally {
        rmSync(d, { recursive: true, force: true });
    }
});
