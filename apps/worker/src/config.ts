import { readFileSync } from "node:fs";
import { REPO_ROOT, expandPath } from "../../../packages/shared/src/paths.ts";
import { resolve } from "node:path";

export interface Config {
  paths: { workspace: string; runs: string; zipOutput: string; documentation: string };
  retries: {
    /** 0 = NO CAP. Keep fixing until it passes — a counter must not kill a task that is improving. */
    verifyAttempts: number;
    feedbackAttempts: number;
    /** Explanations keep their cap: a prose style-validator has nothing to make progress on. */
    explainAttempts: number;
    /** Uncapped != blind. This many IDENTICAL failures in a row means we are going in circles. */
    stuckAfterIdenticalFailures?: number;
    /** How many times the session may restate its design at the design gate before we build anyway. */
    designRounds?: number;
    /**
     * How many GENUINELY DIFFERENT designs may be blocked before we stop and ask a human.
     *
     * Distinct from stuckAfterIdenticalFailures, which counts the SAME design failing the same
     * way. This one is a budget on exploration — and the two were conflated, which is how a task
     * that had rebuilt itself into three unrelated deliverables got told it was "going in circles".
     */
    maxBlockedDesigns?: number;
  };
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
    /** The design gate's turn: state a deliverable + grading axis. Short — it writes one JSON file. */
    designTimeoutMin?: number;
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
    /** How many VS Code windows may exist at once. A MEMORY limit — see the config comment. */
    maxEditors?: number;
  };
  snorkel?: {
    /** Minutes offered for "How long did it take you to complete this submission?". */
    ahtChoices: number[];
  };
  /**
   * The sanctioned Snorkel CLI. Absent until the operator has run `stb login` and captured the
   * project id — the pipeline's stb-backed stages refuse to run without projectId set, rather than
   * guess it. See stb/cli.ts and scripts/stb-probe.sh.
   */
  stb?: {
    /** From `stb projects list`. Name ("Terminus-2nd-Edition") or UUID both work as -p. */
    projectId: string;
    /** Minutes to report as time-spent on create/update. Honest spread, like ahtChoices. */
    timePolicy: number[];
    /** The difficulty gate. See stages/difficulty.ts. */
    difficulty: {
      models: string[];
      runsPerModel: number;
      rejectAboveWorst: number;
      hardAtOrBelow: number;
      mediumAtOrBelow: number;
      blockEasy: boolean;
      pythonMustBeHard: boolean;
    };
    /** Account-safety caps, enforced client-side, fail-closed — like the existing queue gate. */
    queue: {
      /** Submissions in NEEDS_REVISION at or above which create is blocked. Platform rule: 10. */
      revisionCap: number;
      /** Net-new create() calls allowed per UTC day. Platform: 2 (new expert) / 3 (veteran). */
      dailyNetNew: number;
    };
    /** How often to poll `stb submissions list` for a status transition. Gentle. */
    pollStatusSec: number;
    /**
     * How often to reconcile the whole fleet against Snorkel — one `stb submissions list` that
     * catches anything come back NEEDS_REVISION (→ revise lap), accepted, or rejected. The operator
     * asked for hourly; it is easy on the account and catches feedback within the hour.
     */
    reconcileIntervalSec: number;
  };
  gate: {
    requireOracleReward: number; requireNullReward: number;
    requireLintClean: boolean; requireSolveProbeFails: boolean;
  };
  /**
   * Slack "needs a human" notifications. The token is NOT here — it is a secret and lives in .env
   * as SLACK_BOT_TOKEN. Only the non-secret routing lives in config.
   */
  slack?: {
    enabled: boolean;
    channelId: string;
    /** Which "needs human" moments to announce. */
    notifyOn: string[];
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
