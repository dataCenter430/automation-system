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
    /** null = inherit the CLI default (and you will not know what it is). */
    model: string | null;
    /** The model the category classifier uses. Snorkel's CI announces REVIEW_MODEL="claude-haiku-4-5". */
    classifierModel: string;
    /**
     * How long a session waits on an `ask_human` question before proceeding on its own
     * judgment. A parked question holds a Claude slot, so this bounds how much of the fleet an
     * unattended dashboard can freeze.
     */
    askHumanTimeoutMin?: number;
  };
  docker: {
    cpus: number; memoryMb: number; buildTimeoutSec: number;
    solveTimeoutSec: number; testTimeoutSec: number;
    /** How many gates may run at once. cpus * this must not exceed the machine's cores. */
    maxConcurrentGates: number;
  };
  feedback: { pollIntervalSec: number; timeoutMin: number };
  worker: {
    pollIntervalSec: number; maxParallelTasks: number;
    /** Open a VS Code window per task workspace, as a viewer (the SDK still drives). */
    openEditor: boolean;
  };
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
