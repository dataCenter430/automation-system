/**
 * THE DIFFICULTY GATE — the one quality check the local Docker gate structurally cannot do.
 *
 * verify.ts proves a task is SOLVABLE (oracle → reward 1) and that its tests are INTACT (null run →
 * reward 0). Neither says anything about whether a frontier model can solve it — and that pass-rate
 * is the exact quantity Snorkel's acceptance bar is defined on:
 *
 *     "Tasks where the worst model scores above 80% will not be accepted — they're too easy to be
 *      useful as training signal."   (# Difficulty Guidelines.txt)
 *
 * So "too easy" was invisible to us until now: a task could pass every local gate, consume a human
 * approval and a scarce daily submission slot, and be Declined days later for being trivial. The stb
 * CLI runs the real eval panel — GPT-5.5 and Opus 4.8 — against a task, for free (platform
 * credentials, not ours), and gives us the number the bar is written in.
 *
 * THE OPERATOR'S CHOICE: block and rebuild. A task that lands too-easy or EASY does not reach the
 * human — it loops straight back to a harder rebuild, so no approval and no daily slot is ever spent
 * on a task Snorkel will reject.
 *
 * This module is PURE VERDICT LOGIC over parsed pass-rates. The only calibration point is
 * parseHarborRuns() — how `stb harbor run -k N` reports its per-run rewards is undocumented and must
 * be confirmed against scripts/stb-probe.sh. Everything else is fully specified and unit-tested.
 */
import { stb, type Runner, type StbResult } from "../stb/cli.ts";

/** The eval panel and the thresholds. Defaults mirror the docs; overridable via config. */
export interface DifficultyConfig {
  /** The two eval models, as stb -m arguments. */
  models: string[];
  /** Runs per model. The docs say 5 for a reliable pass-rate. */
  runsPerModel: number;
  /** worst-model pass-rate strictly ABOVE this → too easy, auto-rejected by Snorkel. */
  rejectAboveWorst: number; // 0.80
  /** at or below this on best OR worst → HARD. */
  hardAtOrBelow: number; // 0.20
  /** worst at or below this (and not HARD) → MEDIUM. */
  mediumAtOrBelow: number; // 0.60
  /** EASY is blocked platform-wide ("only medium and hard will be accepted"). */
  blockEasy: boolean;
  /** Python tasks must be HARD, per the diversity rules. Empty = no language policy. */
  pythonMustBeHard: boolean;
}

export const DEFAULT_DIFFICULTY: DifficultyConfig = {
  models: ["@openai/gpt-5.5", "@anthropic/claude-opus-4-8"],
  runsPerModel: 5,
  rejectAboveWorst: 0.8,
  hardAtOrBelow: 0.2,
  mediumAtOrBelow: 0.6,
  blockEasy: true,
  pythonMustBeHard: true,
};

export type Band = "HARD" | "MEDIUM" | "EASY" | "TOO_EASY";

export interface ModelResult {
  model: string;
  runs: number;
  passes: number;
  passRate: number;
}

export interface DifficultyVerdict {
  perModel: ModelResult[];
  worstPassRate: number;
  bestPassRate: number;
  band: Band;
  /** True = this task must NOT be submitted; loop it back to a harder rebuild. */
  blocked: boolean;
  /** Human-readable, ready to feed a rebuild prompt or show in the dashboard. */
  report: string;
}

/**
 * CALIBRATION POINT: parse per-run rewards out of one `stb harbor run -m MODEL -k N` invocation.
 *
 * The reward semantics ARE known and shared with verify.ts: each run writes reward.txt = 1 (solved)
 * or 0 (not). What is NOT known is how `-k N` surfaces N of them — one summary line, a table, JSON.
 * So this parser accepts several shapes and is the single place to adjust once real output is seen:
 *   - JSON: {"results":[{"reward":1},...]} or [1,0,1,...] or {"pass":3,"total":5}
 *   - text: lines like "Run 3 (GPT-5.5): PASS" / "reward: 1" / "3/5 passed"
 * Returns {passes, runs}. If it cannot find N runs, it returns what it found and the caller decides.
 */
export function parseHarborRuns(stdout: string, expectedRuns: number): { passes: number; runs: number } {
  const text = stdout.trim();

  // JSON shapes.
  try {
    const j = JSON.parse(text);
    if (Array.isArray(j) && j.every((x) => x === 0 || x === 1)) {
      return { passes: j.filter((x: number) => x === 1).length, runs: j.length };
    }
    const arr = Array.isArray(j?.results) ? j.results : Array.isArray(j?.runs) ? j.runs : null;
    if (arr) {
      const rewards = arr.map((r: any) => Number(r.reward ?? r.score ?? (r.pass ? 1 : 0)));
      return { passes: rewards.filter((x: number) => x >= 1).length, runs: rewards.length };
    }
    if (typeof j?.pass === "number" && typeof j?.total === "number") {
      return { passes: j.pass, runs: j.total };
    }
  } catch {
    // not JSON
  }

  // "3/5 passed" style.
  const frac = /(\d+)\s*\/\s*(\d+)\s*(?:passed|pass|solved)?/i.exec(text);
  if (frac) return { passes: Number(frac[1]), runs: Number(frac[2]) };

  // Per-run PASS/FAIL lines: "Run 2 (GPT-5.5): PASS", "reward: 1", "FAIL - Good".
  const lines = text.split("\n").filter((l) => /\b(pass|fail)\b|reward\s*[:=]/i.test(l));
  if (lines.length) {
    let passes = 0;
    let runs = 0;
    for (const l of lines) {
      const reward = /reward\s*[:=]\s*([01])/i.exec(l);
      if (reward) {
        runs++;
        if (reward[1] === "1") passes++;
        continue;
      }
      // A line naming the run outcome. "FAIL - Good"/"FAIL - Bad" are still fails.
      if (/\bpass\b/i.test(l) && !/\bfail\b/i.test(l)) {
        runs++;
        passes++;
      } else if (/\bfail\b/i.test(l)) {
        runs++;
      }
    }
    if (runs) return { passes, runs };
  }

  return { passes: 0, runs: 0 };
}

/**
 * Classify a task from its two pass-rates. PURE — no I/O, exhaustively unit-tested.
 *
 * The doc's own words drive every branch:
 *   too easy : "worst model scores above 80%"                                  → TOO_EASY (reject)
 *   hard     : "≤ 20% on best OR worst model … earns Hard"                     → HARD
 *   medium   : "20–60% on worst model"                                         → MEDIUM
 *   easy     : "60% < accuracy ≤ 80% on the worst model"                       → EASY (blocked)
 */
export function classify(worst: number, best: number, cfg: DifficultyConfig): Band {
  if (worst > cfg.rejectAboveWorst) return "TOO_EASY";
  if (worst <= cfg.hardAtOrBelow || best <= cfg.hardAtOrBelow) return "HARD";
  if (worst <= cfg.mediumAtOrBelow) return "MEDIUM";
  return "EASY";
}

/** Turn per-model results into a full verdict, applying the block policy (too-easy, easy, python). */
export function verdictFrom(
  perModel: ModelResult[],
  cfg: DifficultyConfig,
  opts: { isPython: boolean },
): DifficultyVerdict {
  const rates = perModel.map((m) => m.passRate);
  // "Worst model" = the one with the LOWER pass-rate; "best" = the higher. Empty → 0 (treated as hard).
  const worst = rates.length ? Math.min(...rates) : 0;
  const best = rates.length ? Math.max(...rates) : 0;
  const band = classify(worst, best, cfg);

  const reasons: string[] = [];
  if (band === "TOO_EASY") {
    reasons.push(
      `worst-model pass-rate ${(worst * 100).toFixed(0)}% is above the ${(cfg.rejectAboveWorst * 100).toFixed(0)}% ceiling — Snorkel auto-rejects this as too easy`,
    );
  }
  if (band === "EASY" && cfg.blockEasy) {
    reasons.push(`lands EASY, and only MEDIUM and HARD are accepted`);
  }
  if (opts.isPython && cfg.pythonMustBeHard && band !== "HARD") {
    reasons.push(`Python tasks must be HARD; this is ${band}`);
  }
  const blocked = reasons.length > 0;

  const lines = perModel.map((m) => `  ${m.model}: ${m.passes}/${m.runs} = ${(m.passRate * 100).toFixed(0)}%`);
  const report =
    `Difficulty: ${band} (worst ${(worst * 100).toFixed(0)}%, best ${(best * 100).toFixed(0)}%)\n` +
    lines.join("\n") +
    (blocked ? `\n\nBLOCKED — ${reasons.join("; ")}. Rebuilding harder before this reaches you or a submission slot.` : `\n\nAccepted band; proceeding.`);

  return { perModel, worstPassRate: worst, bestPassRate: best, band, blocked, report };
}

/**
 * Run the whole gate: N runs per model via stb harbor, parse, classify, decide.
 *
 * Models run SEQUENTIALLY, not concurrently — the docs warn that concurrent GPT-5.5 + Opus runs
 * "exhaust keys faster", and a key-budget stall is worse than a slightly slower gate.
 */
export async function runDifficulty(
  run: Runner,
  taskDir: string,
  cfg: DifficultyConfig,
  opts: { isPython: boolean; onProgress?: (m: string) => Promise<void> },
): Promise<DifficultyVerdict> {
  const perModel: ModelResult[] = [];
  for (const model of cfg.models) {
    await opts.onProgress?.(`difficulty: ${model} × ${cfg.runsPerModel}`);
    const r: StbResult = await stb(
      run,
      ["harbor", "run", "-m", model, "-p", taskDir, "-k", String(cfg.runsPerModel)],
      { timeoutSec: 3600 }, // real agent runs are slow; give them room
    );
    const { passes, runs } = parseHarborRuns(r.stdout, cfg.runsPerModel);
    const effRuns = runs || cfg.runsPerModel;
    perModel.push({ model, runs: effRuns, passes, passRate: effRuns ? passes / effRuns : 0 });
  }
  return verdictFrom(perModel, cfg, opts);
}
