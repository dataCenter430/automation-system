/**
 * The gate verdict — the five checks, as they ACTUALLY ran.
 *
 * Everything here is reconstructed from the artifacts the gate left behind in
 * runs/<slug>/verify-<n>/ (highest n = the most recent attempt), because those are the only
 * things that cannot lie about what happened:
 *
 *   01 LINTING       static lint findings          (blocking findings => the gate stops here)
 *   02 CLASSIFIER    classifier.json               {predicted, confidence, blocked, why}
 *   03 DOCKER BUILD  docker-build.log              (+ a duration, from BuildKit's own timings)
 *   04 ORACLE RUN    oracle/logs/verifier/reward.txt   must be "1"
 *   05 NULL RUN      null/logs/verifier/reward.txt     must be "0"
 *
 * THE RULE THAT MATTERS: a check that did not run is "skipped", NEVER "pass".
 *
 * verifyTask() short-circuits. If lint finds a blocking issue it returns before Docker is
 * ever invoked; if the image fails to build, no container runs; if the oracle scores 0, the
 * null run never happens. Rendering those un-run checks as green would be a lie in the most
 * dangerous direction — it would say "oracle passed" about a task whose oracle never
 * executed. So every skipped check carries the reason it was skipped.
 *
 * The other half of that discipline: DISK EVIDENCE OUTRANKS THE FAILURE REPORT. The report
 * comes from state.json's `lastError`, which is a general-purpose field — it holds whatever
 * failed last, which may be a Chrome/CDP error from the upload stage, or a stale lint report
 * from attempt 0 while attempt 1 is busy passing. So a report is believed only when the
 * artifacts on disk are consistent with it.
 *
 * Read-only. It never writes, and it never touches the pipeline.
 */
import { NextResponse } from "next/server";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { db } from "../../../../../../../packages/shared/src/supabase.ts";
import { REPO_ROOT, expandPath } from "../../../../../../../packages/shared/src/paths.ts";
import { PipelineState as S } from "../../../../../../../packages/shared/src/status.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Status = "pass" | "fail" | "skipped" | "pending";
interface Check {
  n: number;
  id: string;
  label: string;
  status: Status;
  detail: string;
}

function configPaths(): { workspace: string; runs: string } {
  try {
    const cfg = JSON.parse(readFileSync(resolve(REPO_ROOT, "config/pipeline.json"), "utf8"));
    return { workspace: expandPath(cfg.paths.workspace), runs: expandPath(cfg.paths.runs) };
  } catch {
    return { workspace: resolve(REPO_ROOT, "workspace"), runs: resolve(REPO_ROOT, "runs") };
  }
}

const read = (p: string): string | null => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
};

/** The reward the task itself wrote. Absent != 0 — it means the run broke before writing one. */
function reward(dir: string, which: "oracle" | "null"): string | null {
  const raw = read(join(dir, which, "logs", "verifier", "reward.txt"));
  return raw === null ? null : raw.trim();
}

/** The highest verify-<n> under runs/<slug>/ — the attempt the panel should be showing. */
function latestVerify(runs: string, slug: string): { dir: string; attempt: number } | null {
  let best: { dir: string; attempt: number } | null = null;
  let entries: string[];
  try {
    entries = readdirSync(join(runs, slug));
  } catch {
    return null;
  }
  for (const name of entries) {
    const m = /^verify-(\d+)$/.exec(name);
    if (!m) continue; // verify-cli and friends are not pipeline attempts
    const attempt = Number(m[1]);
    if (!best || attempt > best.attempt) best = { dir: join(runs, slug, name), attempt };
  }
  return best;
}

/**
 * BuildKit prints `#N DONE 12.3s` per step under --progress plain. Summing them is the only
 * duration the log actually contains (the runner records no wall clock), so that is what we
 * report — and we say that is what it is rather than dressing it up as elapsed time.
 */
function buildTiming(log: string): { sec: number | null; cached: number } {
  let sec: number | null = null;
  for (const m of log.matchAll(/^#\d+ DONE (\d+(?:\.\d+)?)s$/gm)) {
    sec = (sec ?? 0) + Number(m[1]);
  }
  const cached = [...log.matchAll(/^#\d+ CACHED$/gm)].length;
  return { sec: sec === null ? null : Number(sec.toFixed(1)), cached };
}

/** The stage a verify failure report blames, e.g. "STAGE: docker build (…)" => "docker build". */
function reportStage(report: string | null): string | null {
  if (!report) return null;
  const m = /^STAGE:\s*(.+)$/m.exec(report);
  if (!m) return null; // not a gate report at all (a Chrome/CDP or Claude error, say)
  return m[1]!.trim().replace(/\s*\(.*$/, "").toLowerCase();
}

const firstLines = (s: string, n: number): string =>
  s.split("\n").filter((l) => l.trim()).slice(0, n).join(" · ").slice(0, 400);

export async function GET(_req: Request, ctx: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await ctx.params;

  const { data: row, error } = await db()
    .from("terminus")
    .select("slug, pipeline_state, last_error")
    .eq("task_id", taskId)
    .single();

  if (error || !row) return NextResponse.json({ error: "task not found" }, { status: 404 });
  if (!row.slug) return NextResponse.json({ error: "task has no slug yet" }, { status: 409 });

  const { workspace, runs } = configPaths();
  const slug: string = row.slug;
  const state: number = row.pipeline_state;

  // state.json is the local source of truth and is written BEFORE the DB transition, so it
  // is never behind. Fall back to the DB column if the workspace is gone.
  const local = (() => {
    try {
      return JSON.parse(read(join(workspace, slug, ".pipeline", "state.json")) ?? "null");
    } catch {
      return null;
    }
  })();
  const report: string | null = local?.lastError ?? row.last_error ?? null;

  const found = latestVerify(runs, slug);
  const running = state === S.VERIFY_RUNNING;
  /** A check with no verdict is PENDING while the gate is live, and SKIPPED once it is not. */
  const idle = (): Status => (running ? "pending" : "skipped");

  if (!found) {
    const why = running
      ? "the gate is starting up — it has not written this attempt's directory yet"
      : `the docker gate has not run for this task yet (nothing under runs/${slug}/verify-*)`;
    return NextResponse.json({
      slug,
      attempt: null,
      runDir: null,
      passed: false,
      checks: CHECK_META.map((c) => ({ ...c, status: idle() as Status, detail: why })),
    });
  }

  const { dir, attempt } = found;

  // ---- What the disk says actually happened -------------------------------------------
  const classifierRaw = read(join(dir, "classifier.json"));
  const buildLog = read(join(dir, "docker-build.log"));
  const solveLog = read(join(dir, "solve.log"));
  const oracleTestLog = existsSync(join(dir, "test-oracle.log"));
  const oracleReward = reward(dir, "oracle");
  const nullReward = reward(dir, "null");

  // ---- What the failure report claims, believed ONLY where disk evidence agrees --------
  //
  // Each rule says: "the report blames stage X, AND nothing downstream of X exists". That
  // second clause is what makes a stale report from a previous attempt harmless — if the
  // gate got further this time, the artifacts prove it and the report is ignored.
  const stage = reportStage(report);
  const lintFailed = stage === "static lint" && !classifierRaw && !buildLog;
  const classifierBlocked = stage === "category classifier" && !classifierRaw && !buildLog;
  const buildFailed = stage === "docker build" && !!buildLog && !solveLog && oracleReward === null;
  const solveFailed = stage === "oracle solution" && !!solveLog && !oracleTestLog;

  const stopped = lintFailed || classifierBlocked; // nothing docker-shaped ran at all

  // ---- 01 LINTING ---------------------------------------------------------------------
  const lint: Check = (() => {
    const meta = CHECK_META[0]!;
    if (lintFailed) {
      const body = (report ?? "").split("\n").slice(2).join("\n");
      return { ...meta, status: "fail", detail: firstLines(body, 3) || "blocking lint findings" };
    }
    if (classifierRaw || buildLog || solveLog || oracleReward !== null) {
      return { ...meta, status: "pass", detail: "no blocking findings — the gate proceeded past lint" };
    }
    return {
      ...meta,
      status: idle(),
      detail: running
        ? "lint is running — it is the first stage, and nothing downstream exists yet"
        : "this attempt left no artifacts at all, so the gate never recorded a lint verdict",
    };
  })();

  // ---- 02 CLASSIFIER ------------------------------------------------------------------
  const classifier: Check = (() => {
    const meta = CHECK_META[1]!;
    if (lintFailed) {
      return {
        ...meta,
        status: "skipped",
        detail:
          "lint failed, so the gate stopped before the classifier. It short-circuits: nothing " +
          "after a blocking lint finding is executed.",
      };
    }
    if (classifierBlocked) {
      const m = /classifies as "([^"]+)" \(confidence ([\d.]+)\)/.exec(report ?? "");
      const why = /Classifier's reason: (.+)/.exec(report ?? "")?.[1] ?? "";
      return {
        ...meta,
        status: "fail",
        detail: m
          ? `predicted "${m[1]}" (${m[2]}) — a BLOCKED category. ${why}`.slice(0, 400)
          : firstLines(report ?? "", 2),
      };
    }
    if (classifierRaw) {
      try {
        const c = JSON.parse(classifierRaw) as {
          predicted: string | null; confidence: number; blocked: boolean; why: string;
        };
        return {
          ...meta,
          status: c.blocked ? "fail" : "pass",
          detail:
            `predicted "${c.predicted}" (${Number(c.confidence).toFixed(2)})` +
            `${c.blocked ? " — a BLOCKED category" : " — not a blocked category"}` +
            `${c.why ? `. ${c.why}` : ""}`.slice(0, 400),
        };
      } catch {
        return { ...meta, status: "skipped", detail: "classifier.json is present but unreadable" };
      }
    }
    if (buildLog) {
      // Docker ran, but no verdict was written: classifyTask() returned `unavailable`, which
      // adds a WARNING and lets the gate continue. That is not a pass — the check did not run.
      return {
        ...meta,
        status: "skipped",
        detail:
          "the classifier produced no verdict for this run (it could not run, or this gate " +
          "predates the check). Docker ran anyway — so this task is NOT protected against the " +
          "check that rejected the first submission.",
      };
    }
    return {
      ...meta,
      status: idle(),
      detail: running ? "waiting on lint" : "the gate stopped before the classifier",
    };
  })();

  // ---- 03 DOCKER BUILD ----------------------------------------------------------------
  const build: Check = (() => {
    const meta = CHECK_META[2]!;
    if (stopped) {
      return {
        ...meta,
        status: "skipped",
        detail: lintFailed
          ? "lint failed, so Docker never ran — the gate short-circuits before any image is built"
          : "the classifier blocked the task, so Docker never ran (that check runs before the build, deliberately: a task that is blocked in substance should not pay for a six-minute image build first)",
      };
    }
    if (buildFailed) {
      const exit = /exit=(-?\d+)( \(TIMED OUT\))?/.exec(report ?? "");
      return {
        ...meta,
        status: "fail",
        detail: `docker build failed${exit ? ` (exit=${exit[1]}${exit[2] ? ", TIMED OUT" : ""})` : ""} — the image never built`,
      };
    }
    if (!buildLog) {
      return {
        ...meta,
        status: idle(),
        detail: running ? "waiting on lint/classifier" : "no docker-build.log — the build never started",
      };
    }
    const built = !!solveLog || oracleReward !== null || /naming to |writing image/.test(buildLog);
    if (!built && /^ERROR: failed to solve/m.test(buildLog)) {
      return { ...meta, status: "fail", detail: "docker build failed — BuildKit reported: failed to solve" };
    }
    if (!built) {
      return {
        ...meta,
        status: running ? "pending" : "fail",
        detail: running
          ? "the image is still building"
          : "docker-build.log exists but the image was never tagged, and nothing downstream ran",
      };
    }
    const t = buildTiming(buildLog);
    const bits = [
      t.sec === null ? "image built" : `image built · ${t.sec}s of BuildKit step time`,
      t.cached ? `${t.cached} layers CACHED` : null,
      `${(statSync(join(dir, "docker-build.log")).size / 1024).toFixed(1)} KB log`,
    ].filter(Boolean);
    return { ...meta, status: "pass", detail: bits.join(" · ") };
  })();

  // ---- 04 ORACLE RUN ------------------------------------------------------------------
  const oracle: Check = (() => {
    const meta = CHECK_META[3]!;
    if (stopped || build.status === "fail") {
      return {
        ...meta,
        status: "skipped",
        detail: stopped
          ? "the gate stopped before Docker, so no container ever ran"
          : "the image never built, so no container ever ran",
      };
    }
    if (oracleReward === "1") {
      return { ...meta, status: "pass", detail: "solve.sh ran, tests scored reward=1 (required: 1)" };
    }
    if (oracleReward !== null) {
      return {
        ...meta,
        status: "fail",
        detail: `reward=${oracleReward} (must be 1) — the oracle solution ran but the tests still failed it`,
      };
    }
    if (solveFailed) {
      return {
        ...meta,
        status: "fail",
        detail: "solution/solve.sh itself failed to run — the task is not solvable as written",
      };
    }
    if (oracleTestLog) {
      return {
        ...meta,
        status: "fail",
        detail: "tests ran but wrote no valid /logs/verifier/reward.txt (it must write 1 or 0 on BOTH paths)",
      };
    }
    return {
      ...meta,
      status: idle(),
      detail: running ? "the oracle container is still running" : "the oracle run never executed",
    };
  })();

  // ---- 05 NULL RUN --------------------------------------------------------------------
  const nul: Check = (() => {
    const meta = CHECK_META[4]!;
    if (oracle.status !== "pass") {
      return {
        ...meta,
        status: oracle.status === "pending" ? "pending" : "skipped",
        detail:
          oracle.status === "pending"
            ? "waiting on the oracle run"
            : "the oracle run did not pass, so the null run never executed — the gate short-circuits here",
      };
    }
    if (nullReward === "0") {
      return {
        ...meta,
        status: "pass",
        detail: "tests scored reward=0 with NO solution applied (required: 0)",
      };
    }
    if (nullReward !== null) {
      return {
        ...meta,
        status: "fail",
        detail:
          `reward=${nullReward} (must be 0) — the tests PASS without the solution, so they are ` +
          `not testing the task. This is an explicit rejection criterion.`,
      };
    }
    return {
      ...meta,
      status: running ? "pending" : "skipped",
      detail: running ? "the null container is still running" : "the null run wrote no reward.txt",
    };
  })();

  const checks: Check[] = [lint, classifier, build, oracle, nul];

  return NextResponse.json({
    slug,
    attempt,
    runDir: dir,
    running,
    passed: checks.every((c) => c.status === "pass"),
    checks,
  });
}

/** The five checks the panel renders, in the order it renders them. */
const CHECK_META: ReadonlyArray<{ n: number; id: string; label: string }> = [
  { n: 1, id: "lint", label: "LINTING" },
  { n: 2, id: "classifier", label: "CLASSIFIER" },
  { n: 3, id: "docker_build", label: "DOCKER BUILD" },
  { n: 4, id: "oracle_run", label: "ORACLE RUN" },
  { n: 5, id: "null_run", label: "NULL RUN" },
];
