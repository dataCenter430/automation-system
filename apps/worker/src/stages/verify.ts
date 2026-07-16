/**
 * The Docker verify gate. The only real quality oracle in this system.
 *
 * Three verdicts, not one:
 *   ORACLE   — run solution/solve.sh, then tests/test.sh. reward.txt MUST be 1.
 *   NULL RUN — fresh container, same image, SKIP solve.sh. reward.txt MUST be 0.
 *   LINT     — static checks (cheap; runs first so we fail in 200ms, not 6 minutes).
 *
 * The null run is the one people skip and shouldn't. A test suite that passes with no
 * solution is worthless, and it's an explicit rejection criterion in the Snorkel docs.
 * `oracle == 1` on its own proves nothing.
 */
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as docker from "../docker/runner.ts";
import { lintTask, formatFindings, type Finding } from "./lint.ts";
import { normalizeLineEndings } from "../util/lf.ts";
import { classifyTask, classifierFailure, type Classification } from "./classify.ts";
import { instructionGate, formatInstructionVerdict } from "./instruction-gate.ts";
import { designDrift, readDesign } from "./design-gate.ts";

/** The test names actually on disk — what the classifier reads, and what drift is measured against. */
function builtTestNames(taskDir: string): string[] {
  try {
    const p = join(taskDir, "tests", "test_outputs.py");
    if (!existsSync(p)) return [];
    return (readFileSync(p, "utf8").match(/^\s*def (test_\w+)/gm) ?? [])
      .map((m) => m.trim().replace(/^def /, ""));
  } catch {
    return [];
  }
}

export interface VerifyResult {
  passed: boolean;
  oracleReward: number | null;
  nullReward: number | null;
  lint: { clean: boolean; findings: Finding[] };
  /** Everything Claude needs to fix it, already assembled. Empty when passed. */
  failureReport: string;
  logsDir: string;
}

export interface VerifyOptions {
  taskDir: string;
  slug: string;
  runDir: string; // runs/<slug>/verify-<n>
  cpus: number;
  memoryMb: number;
  buildTimeoutSec: number;
  solveTimeoutSec: number;
  testTimeoutSec: number;
  /** Run the category classifier (the check that rejected our first submission). */
  classify?: boolean;
  /** Run the instruction gate — the guide's rules, plus "does this read as machine-written?". */
  instructionGate?: boolean;
  /** The style judge inside it costs one haiku call. Off = mechanical checks only. */
  styleJudge?: boolean;
  /** Snorkel's CI announces REVIEW_MODEL="claude-haiku-4-5"; we ask the same model. */
  classifierModel?: string;
  /** Skip the null run when you only want a fast pass/fail (not for the real gate). */
  skipNullRun?: boolean;
}

const REWARD_PATH = "/logs/verifier/reward.txt";

/** Read the reward the task itself wrote. Absent reward != 0; it means the run broke. */
async function readReward(container: string, runDir: string, label: string): Promise<number | null> {
  const dest = join(runDir, label);
  mkdirSync(dest, { recursive: true });
  await docker.copyOut(container, "/logs", dest);

  const p = join(dest, "logs", "verifier", "reward.txt");
  if (!existsSync(p)) return null;

  const raw = readFileSync(p, "utf8").trim();
  if (raw !== "0" && raw !== "1") return null;
  return Number(raw);
}

/** Does this task declare allow_internet = true? Then its container runs WITH the network. */
function taskAllowsInternet(taskDir: string): boolean {
  try {
    const t = readFileSync(join(taskDir, "task.toml"), "utf8");
    // [environment] allow_internet = true  (tolerant of spacing; false/absent → offline)
    return /allow_internet\s*=\s*true\b/.test(t);
  } catch {
    return false;
  }
}

/** Bring a container up with /tests, /solution and /logs staged inside it. */
async function stage(
  name: string,
  image: string,
  taskDir: string,
  opts: VerifyOptions,
  withSolution: boolean,
): Promise<void> {
  await docker.runDetached(name, image, {
    cpus: opts.cpus,
    memoryMb: opts.memoryMb,
    allowInternet: taskAllowsInternet(taskDir),
  });

  // Harbor reserves these mounts. We recreate them by hand so the task sees what it expects.
  await docker.exec(name, ["mkdir", "-p", "/tests", "/solution", "/logs/verifier", "/logs/artifacts"], 60);

  await docker.copyInto(name, join(taskDir, "tests") + "/.", "/tests/");
  if (withSolution) {
    await docker.copyInto(name, join(taskDir, "solution") + "/.", "/solution/");
    await docker.exec(name, ["chmod", "+x", "/solution/solve.sh"], 30);
  }
  await docker.exec(name, ["chmod", "+x", "/tests/test.sh"], 30);
}

/**
 * The classifier's verdict, written to BOTH places that need it.
 *
 *   runs/<slug>/verify-N/   the immutable audit trail for this attempt
 *   <task>/.pipeline/       the working copy the rejected-design ledger reads on the next lap
 *
 * Written on the blocked branch as well as the passing one. The old code wrote it only when the
 * task PASSED, so the one situation in which the verdict was actually needed — a rejection we
 * have to learn from — was the one situation in which it was thrown away.
 */
function writeVerdict(taskDir: string, runDir: string, c: Classification): void {
  const json = JSON.stringify(c, null, 2);
  try {
    writeFileSync(join(runDir, "classifier.json"), json, "utf8");
    mkdirSync(join(taskDir, ".pipeline"), { recursive: true });
    writeFileSync(join(taskDir, ".pipeline", "classifier.json"), json, "utf8");
  } catch {
    // Diagnostics. Losing them must never fail a gate that otherwise reached a verdict.
  }
}

export async function verifyTask(opts: VerifyOptions): Promise<VerifyResult> {
  const { taskDir, slug, runDir } = opts;
  mkdirSync(runDir, { recursive: true });

  // Claude writes these files on Windows. CRLF in solve.sh yields
  // `bad interpreter: /bin/bash^M`, which reads like a Docker fault and isn't.
  normalizeLineEndings(taskDir);

  // 1. LINT — cheapest gate first.
  const lint = lintTask(taskDir);
  if (!lint.clean) {
    return {
      passed: false,
      oracleReward: null,
      nullReward: null,
      lint,
      logsDir: runDir,
      failureReport:
        `STAGE: static lint (no Docker was run)\n\n${formatFindings(lint.findings)}\n\n` +
        `Fix every BLOCKING finding above. Each names one rule and one file.`,
    };
  }

  // 1b. DESIGN DRIFT — did the build actually grade what the approved design promised to grade?
  //
  // The design gate is only as honest as the session that writes the design, and the session writes
  // both. So a build could state a clean, property-graded design, clear the gate in seconds, and
  // then quietly ship `test_output_matches_reference` anyway — arriving at the identical blocked
  // task by a route that now has an approval stamped on it.
  //
  // The test names are the check, because they are exactly what the classifier reads. An
  // equality-shaped test that the approved design never promised is drift, and it is blocking:
  // catching it here costs milliseconds and a fix turn, where the classifier below would cost a
  // full rebuild.
  const approved = readDesign(taskDir);
  if (approved) {
    const drift = designDrift(approved, builtTestNames(taskDir));
    for (const t of drift) {
      lint.findings.push({
        rule: "design_drift",
        severity: "blocking",
        file: "tests/test_outputs.py",
        message:
          `\`${t}\` grades OUTPUT EQUALITY and is not in the design you cleared the gate with. ` +
          `The approved design (axis "${approved.gradingAxis}") promised: ${approved.testNames.join(", ")}. ` +
          `Grade the property you committed to, or restate the design — do not smuggle an equality ` +
          `assertion past an approval it never had.`,
      });
    }
    if (drift.length) {
      return {
        passed: false,
        oracleReward: null,
        nullReward: null,
        lint,
        logsDir: runDir,
        failureReport:
          `STAGE: design drift (no Docker was run)\n\n${formatFindings(lint.findings)}\n\n` +
          `The built tree does not grade what the approved design said it would grade.`,
      };
    }
  }

  // 2. CATEGORY CLASSIFIER — the check that actually rejected our first submission.
  //
  // Snorkel passed the enum ("✅ Category 'machine-learning' is valid") and rejected the task
  // in the same run ("❌ Predicted category 'software-engineering' (0.95) is blocked"). Both
  // were true: the label was legal, the task was not. A string compare cannot catch that, so
  // we ask the same model Snorkel's CI announces it uses — REVIEW_MODEL="claude-haiku-4-5" —
  // the same question, before we ever upload.
  //
  // Before Docker: this costs seconds, and a task that is blocked in substance should not
  // spend six minutes building an image first.
  if (opts.classify !== false) {
    const c = await classifyTask(taskDir, opts.classifierModel);

    if (c.unavailable) {
      // Never silently pass. A gate that reports clean because it could not run its check is
      // exactly how 14 ruff errors reached Snorkel.
      lint.findings.push({
        rule: "category_classifier",
        severity: "warning",
        file: "task.toml",
        message:
          `Could not run the category classifier, so this task is NOT protected against the ` +
          `check that rejected our first submission. ${c.unavailable}`,
      });
    } else if (c.blocked) {
      const declared = (() => {
        try {
          const t = readFileSync(join(taskDir, "task.toml"), "utf8");
          return /category\s*=\s*"([^"]+)"/.exec(t)?.[1] ?? "(unknown)";
        } catch {
          return "(unknown)";
        }
      })();

      lint.findings.push({
        rule: "predicted_category_blocked",
        severity: "blocking",
        file: "task.toml",
        message: `classifies as "${c.predicted}" (${c.confidence.toFixed(2)}) — a blocked category. ${c.why}`,
      });

      // WRITE THE VERDICT DOWN. This branch used to `return` without recording anything, so the
      // ONLY outcome that ever produced structured evidence was the one where nothing went wrong.
      // A task was blocked four times running and left four EMPTY verify-* directories behind —
      // meaning every redesign began with no idea what the classifier had actually objected to,
      // beyond one line of prose in lastError. The rejected-design ledger reads this file.
      writeVerdict(taskDir, runDir, c);

      return {
        passed: false,
        oracleReward: null,
        nullReward: null,
        lint,
        logsDir: runDir,
        failureReport:
          `STAGE: category classifier (no Docker was run)\n\n` +
          classifierFailure(c, declared),
      };
    } else {
      writeVerdict(taskDir, runDir, c);
    }
  }

  // 3. THE INSTRUCTION GATE — does the prompt read like a HUMAN wrote it?
  //
  // Snorkel's instruction guide: "Prompts should NOT be LLM-generated. We want to avoid the
  // 'GPT-style' of writing (verbose, repetitive, and overly polite)." The Review Checklist marks
  // every instruction criterion HIGH severity — one failure and the task is not accepted. So a
  // task whose instruction reads like documentation is dead on arrival, however good the
  // engineering underneath it.
  //
  // This check EXISTED (lintInstruction) and ran in exactly one place: upload.ts, deciding whether
  // we could honestly tick the "Prompt Check" box. That is far too late — by then we have paid for
  // the build, the image, the oracle run, the null run and the zip, and the fix loop never sees it
  // because the gate said the task was fine.
  //
  // So it runs HERE, before Docker, next to the classifier and for the same reason: it is cheap,
  // it is about SUBSTANCE, and a task that fails it should not spend six minutes building an image.
  if (opts.instructionGate !== false) {
    const g = await instructionGate(taskDir, { judge: opts.styleJudge !== false });

    writeFileSync(join(runDir, "instruction.json"), JSON.stringify(g, null, 2), "utf8");

    for (const f of g.findings) {
      lint.findings.push({
        rule: f.rule,
        severity: f.severity,
        file: "instruction.md",
        message: f.evidence ? `${f.message}\n     evidence: ${f.evidence}` : f.message,
      });
    }

    if (!g.ok) {
      return {
        passed: false,
        oracleReward: null,
        nullReward: null,
        lint,
        logsDir: runDir,
        failureReport: formatInstructionVerdict(g),
      };
    }
  }

  await docker.assertDaemonUp();

  const image = `tb-${slug}:verify`;
  const oracleCtr = `tb-${slug}-oracle`;
  const nullCtr = `tb-${slug}-null`;

  try {
    // 2. BUILD — network is ON here (apt/pip need it); it is OFF at test time.
    const build = await docker.buildImage(image, join(taskDir, "environment"), opts.buildTimeoutSec);
    writeFileSync(join(runDir, "docker-build.log"), build.stdout + build.stderr);
    if (build.code !== 0) {
      return {
        passed: false, oracleReward: null, nullReward: null, lint, logsDir: runDir,
        failureReport:
          `STAGE: docker build (environment/Dockerfile)\nexit=${build.code}${build.timedOut ? " (TIMED OUT)" : ""}\n\n` +
          `--- last 8000 chars of build output ---\n${tail(build.stdout + build.stderr, 8000)}`,
      };
    }

    // 3. ORACLE RUN — solve, then test. Must score 1.
    await stage(oracleCtr, image, taskDir, opts, true);

    const solve = await docker.exec(oracleCtr, ["bash", "/solution/solve.sh"], opts.solveTimeoutSec);
    writeFileSync(join(runDir, "solve.log"), solve.stdout + solve.stderr);
    if (solve.code !== 0) {
      return {
        passed: false, oracleReward: null, nullReward: null, lint, logsDir: runDir,
        failureReport:
          `STAGE: oracle solution (solution/solve.sh)\nexit=${solve.code}${solve.timedOut ? " (TIMED OUT)" : ""}\n\n` +
          `The oracle solution itself failed to run. The task is not solvable as written.\n\n` +
          `--- stdout (tail) ---\n${tail(solve.stdout, 4000)}\n\n--- stderr (tail) ---\n${tail(solve.stderr, 4000)}`,
      };
    }

    const oTest = await docker.exec(oracleCtr, ["bash", "/tests/test.sh"], opts.testTimeoutSec);
    writeFileSync(join(runDir, "test-oracle.log"), oTest.stdout + oTest.stderr);
    const oracleReward = await readReward(oracleCtr, runDir, "oracle");

    if (oracleReward !== 1) {
      const ctrf = readCtrf(join(runDir, "oracle", "logs", "verifier", "ctrf.json"));
      return {
        passed: false, oracleReward, nullReward: null, lint, logsDir: runDir,
        failureReport:
          `STAGE: oracle verification\nreward=${oracleReward ?? "MISSING"} (must be 1)\n\n` +
          (oracleReward === null
            ? `tests/test.sh did not write a valid ${REWARD_PATH}. It must write 1 or 0 on BOTH paths.\n\n`
            : `The oracle solution ran successfully but the tests still failed it. Either the tests are wrong or solve.sh does not actually solve the task.\n\n`) +
          (ctrf ? `--- failing tests (from ctrf.json) ---\n${ctrf}\n\n` : "") +
          `--- pytest output (tail) ---\n${tail(oTest.stdout + oTest.stderr, 8000)}`,
      };
    }

    // 4. NULL RUN — same image, NO solution. Must score 0.
    let nullReward: number | null = null;
    if (!opts.skipNullRun) {
      await stage(nullCtr, image, taskDir, opts, false);
      const nTest = await docker.exec(nullCtr, ["bash", "/tests/test.sh"], opts.testTimeoutSec);
      writeFileSync(join(runDir, "test-null.log"), nTest.stdout + nTest.stderr);
      nullReward = await readReward(nullCtr, runDir, "null");

      if (nullReward !== 0) {
        return {
          passed: false, oracleReward, nullReward, lint, logsDir: runDir,
          failureReport:
            `STAGE: null run (tests executed with NO solution applied)\n` +
            `reward=${nullReward ?? "MISSING"} (must be 0)\n\n` +
            `The tests PASS without the solution. They are not actually testing the task — they likely ` +
            `assert on values that already exist in the environment, or assert constants instead of ` +
            `re-deriving expected results. This is an explicit rejection criterion.\n\n` +
            `Rewrite tests/test_outputs.py so that every assertion depends on work the agent must do.\n\n` +
            `--- pytest output (tail) ---\n${tail(nTest.stdout + nTest.stderr, 6000)}`,
        };
      }
    }

    return {
      passed: true, oracleReward, nullReward, lint, logsDir: runDir, failureReport: "",
    };
  } finally {
    await docker.remove(oracleCtr);
    await docker.remove(nullCtr);
  }
}

/** Tail, never head: a pytest failure lives at the bottom of the output. */
function tail(s: string, n: number): string {
  const t = s.trimEnd();
  return t.length <= n ? t : "…(truncated)…\n" + t.slice(-n);
}

/**
 * tests/test.sh already emits --ctrf. Structured per-test failures make a far better
 * fix prompt than a wall of stdout, so use them when they're there.
 */
function readCtrf(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    const tests: any[] = j?.results?.tests ?? [];
    const failed = tests.filter((t) => t.status !== "passed");
    if (failed.length === 0) return null;
    return failed
      .map((t) => `✗ ${t.name}\n    ${String(t.message ?? "").split("\n").slice(0, 12).join("\n    ")}`)
      .join("\n");
  } catch {
    return null;
  }
}
