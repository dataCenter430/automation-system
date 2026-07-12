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
import { lintTask, formatFindings } from "./lint.ts";
import { normalizeLineEndings } from "../util/lf.ts";
const REWARD_PATH = "/logs/verifier/reward.txt";
/** Read the reward the task itself wrote. Absent reward != 0; it means the run broke. */
async function readReward(container, runDir, label) {
    const dest = join(runDir, label);
    mkdirSync(dest, { recursive: true });
    await docker.copyOut(container, "/logs", dest);
    const p = join(dest, "logs", "verifier", "reward.txt");
    if (!existsSync(p))
        return null;
    const raw = readFileSync(p, "utf8").trim();
    if (raw !== "0" && raw !== "1")
        return null;
    return Number(raw);
}
/** Bring a container up with /tests, /solution and /logs staged inside it. */
async function stage(name, image, taskDir, opts, withSolution) {
    await docker.runDetached(name, image, { cpus: opts.cpus, memoryMb: opts.memoryMb });
    // Harbor reserves these mounts. We recreate them by hand so the task sees what it expects.
    await docker.exec(name, ["mkdir", "-p", "/tests", "/solution", "/logs/verifier", "/logs/artifacts"], 60);
    await docker.copyInto(name, join(taskDir, "tests") + "/.", "/tests/");
    if (withSolution) {
        await docker.copyInto(name, join(taskDir, "solution") + "/.", "/solution/");
        await docker.exec(name, ["chmod", "+x", "/solution/solve.sh"], 30);
    }
    await docker.exec(name, ["chmod", "+x", "/tests/test.sh"], 30);
}
export async function verifyTask(opts) {
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
            failureReport: `STAGE: static lint (no Docker was run)\n\n${formatFindings(lint.findings)}\n\n` +
                `Fix every BLOCKING finding above. Each names one rule and one file.`,
        };
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
                failureReport: `STAGE: docker build (environment/Dockerfile)\nexit=${build.code}${build.timedOut ? " (TIMED OUT)" : ""}\n\n` +
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
                failureReport: `STAGE: oracle solution (solution/solve.sh)\nexit=${solve.code}${solve.timedOut ? " (TIMED OUT)" : ""}\n\n` +
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
                failureReport: `STAGE: oracle verification\nreward=${oracleReward ?? "MISSING"} (must be 1)\n\n` +
                    (oracleReward === null
                        ? `tests/test.sh did not write a valid ${REWARD_PATH}. It must write 1 or 0 on BOTH paths.\n\n`
                        : `The oracle solution ran successfully but the tests still failed it. Either the tests are wrong or solve.sh does not actually solve the task.\n\n`) +
                    (ctrf ? `--- failing tests (from ctrf.json) ---\n${ctrf}\n\n` : "") +
                    `--- pytest output (tail) ---\n${tail(oTest.stdout + oTest.stderr, 8000)}`,
            };
        }
        // 4. NULL RUN — same image, NO solution. Must score 0.
        let nullReward = null;
        if (!opts.skipNullRun) {
            await stage(nullCtr, image, taskDir, opts, false);
            const nTest = await docker.exec(nullCtr, ["bash", "/tests/test.sh"], opts.testTimeoutSec);
            writeFileSync(join(runDir, "test-null.log"), nTest.stdout + nTest.stderr);
            nullReward = await readReward(nullCtr, runDir, "null");
            if (nullReward !== 0) {
                return {
                    passed: false, oracleReward, nullReward, lint, logsDir: runDir,
                    failureReport: `STAGE: null run (tests executed with NO solution applied)\n` +
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
    }
    finally {
        await docker.remove(oracleCtr);
        await docker.remove(nullCtr);
    }
}
/** Tail, never head: a pytest failure lives at the bottom of the output. */
function tail(s, n) {
    const t = s.trimEnd();
    return t.length <= n ? t : "…(truncated)…\n" + t.slice(-n);
}
/**
 * tests/test.sh already emits --ctrf. Structured per-test failures make a far better
 * fix prompt than a wall of stdout, so use them when they're there.
 */
function readCtrf(path) {
    if (!existsSync(path))
        return null;
    try {
        const j = JSON.parse(readFileSync(path, "utf8"));
        const tests = j?.results?.tests ?? [];
        const failed = tests.filter((t) => t.status !== "passed");
        if (failed.length === 0)
            return null;
        return failed
            .map((t) => `✗ ${t.name}\n    ${String(t.message ?? "").split("\n").slice(0, 12).join("\n    ")}`)
            .join("\n");
    }
    catch {
        return null;
    }
}
