import { readFileSync } from "node:fs";
import { REPO_ROOT, expandPath } from "../../../packages/shared/src/paths.ts";
import { resolve } from "node:path";

export interface Config {
  paths: { workspace: string; runs: string; zipOutput: string; documentation: string };
  retries: { verifyAttempts: number; feedbackAttempts: number; explainAttempts: number };
  claude: {
    maxConcurrent: number; studyTimeoutMin: number; buildTimeoutMin: number;
    fixTimeoutMin: number; explainTimeoutMin: number;
    probeTimeoutMin: number; rateLimitBackoffSec: number;
  };
  docker: {
    cpus: number; memoryMb: number; buildTimeoutSec: number;
    solveTimeoutSec: number; testTimeoutSec: number;
  };
  feedback: { pollIntervalSec: number; timeoutMin: number };
  worker: { pollIntervalSec: number; maxParallelTasks: number };
  gate: {
    requireOracleReward: number; requireNullReward: number;
    requireLintClean: boolean; requireSolveProbeFails: boolean;
  };
}

let cached: Config | null = null;

/**
 * Load config/pipeline.json, resolved from the REPO root rather than process.cwd() —
 * the worker must behave the same whether you launch it from the repo, from a service
 * wrapper, or from a scheduled task on the target machine.
 */
export function loadConfig(): Config {
  if (cached) return cached;

  const raw = JSON.parse(readFileSync(resolve(REPO_ROOT, "config/pipeline.json"), "utf8")) as Config;

  // Expand ${SNORKEL_ROOT} / ${REPO_ROOT} so no absolute path is ever baked into the repo.
  raw.paths = {
    workspace: expandPath(raw.paths.workspace),
    runs: expandPath(raw.paths.runs),
    zipOutput: expandPath(raw.paths.zipOutput),
    documentation: expandPath(raw.paths.documentation),
  };

  cached = raw;
  return raw;
}
