/**
 * The `stb` CLI wrapper — the SANCTIONED path to the Snorkel platform.
 *
 * WHY THIS EXISTS. This system was built DOM-only, on the belief that no sanctioned API existed and
 * that any direct call would risk the account. That belief was wrong: Snorkel ships an official CLI,
 * `stb` (`snorkelai-stb`), and `stb login` issues an official expert API key. The CLI is the vendor's
 * own tool doing exactly what the vendor intends — it is STRICTLY SAFER than screen-scraping a live
 * app over a Chrome debug port, which is what the DOM path did, and which never once succeeded here
 * (0 of 4 tasks got past "Nothing is listening on the CDP port").
 *
 * So this wrapper replaces the browser stack for everything except the rubric textbox (which has no
 * CLI command — see stages/rubric-*).
 *
 * TWO DESIGN RULES, both learned the hard way elsewhere in this repo:
 *
 *  1. DEPENDENCY INJECTION for the spawn. ES module bindings are immutable, so a test cannot
 *     monkeypatch `spawn`. Every function here takes a `Runner` so tests drive it with a fake and
 *     never touch a real `stb`. (The EditorPool tests died on exactly this and had to be rewritten.)
 *
 *  2. THE OUTPUT PARSERS ARE ISOLATED AND CALIBRATABLE. Four output shapes are undocumented and must
 *     be confirmed against a real logged-in CLI (see scripts/stb-probe.sh): whether `--json` exists,
 *     the `submissions list` row shape, the `-k N` aggregation, and exit codes. Each parser is a
 *     single named function with a documented assumption, so calibrating to reality is a one-function
 *     edit, never a hunt through call sites.
 */
import { spawn } from "node:child_process";
import { billingVarsPresent, BILLING_VARS } from "../claude/no-billing.ts";

/** One invocation's raw result. Deliberately the same shape as docker/runner.ts's ExecResult. */
export interface StbResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** The seam. Real code spawns `stb`; tests pass a fake. */
export type Runner = (args: string[], opts: { timeoutSec: number; cwd?: string }) => Promise<StbResult>;

export class StbError extends Error {
  // NB: an explicit field, not a TS parameter property — `--experimental-strip-types` (how the
  // worker runs) does not support parameter properties at runtime; it throws at import.
  readonly result?: StbResult;
  constructor(message: string, result?: StbResult) {
    super(message);
    this.name = "StbError";
    this.result = result;
  }
}

/**
 * PLATFORM CREDENTIALS ARE SAFE; PERSONAL CREDENTIALS BILL YOU. THE BASE URL TELLS THEM APART.
 *
 * The docs describe harbor's AI credentials as a PORTKEY key:
 *     export OPENAI_API_KEY=<your-portkey-api-key>
 *     export OPENAI_BASE_URL=https://api.portkey.ai/v1
 * (# Quick Start Guide.txt, # Platform Submission Guide.txt). Portkey is Snorkel's proxy — a key
 * routed through it is billed to the PLATFORM's refillable budget, never to us. So we must NOT strip
 * it; harbor needs it. `stb keys` provisions exactly this.
 *
 * The danger is a DIRECT-PROVIDER key — OPENAI_API_KEY with no Portkey base URL, or ANTHROPIC_API_KEY
 * hitting api.anthropic.com — which a harbor run could pick up and bill FOR REAL (the failure
 * no-billing.ts guards the Claude subscription against).
 *
 * So the rule is: keep a key ONLY when its base URL points at Portkey; strip it otherwise. A warning
 * is a thing you scroll past at 2am; an unset variable cannot bill you.
 */
const OPENAI_VARS = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID"] as const;

/** Does this base URL route through Snorkel's Portkey proxy (platform-billed, therefore safe)? */
function isPortkey(url: string | undefined): boolean {
  return !!url && /portkey\.ai/i.test(url);
}

export function harborEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  // Anthropic (harbor's Opus runs): keep only if routed through Portkey; else it's the subscription's
  // job and a bare ANTHROPIC_API_KEY here would meter. Strip the whole billing set.
  if (!isPortkey(env.ANTHROPIC_BASE_URL)) {
    for (const v of BILLING_VARS) delete env[v];
  }
  // OpenAI (harbor's GPT-5.5 runs): keep a Portkey-routed key; strip a personal one.
  if (!isPortkey(env.OPENAI_BASE_URL)) {
    for (const v of OPENAI_VARS) delete env[v];
  }
  return env;
}

/**
 * Personal (non-Portkey) model keys that a harbor run could bill FOR REAL. Preflight refuses to
 * start when one is set — a Portkey-routed key is NOT flagged, because that one is safe.
 */
export function personalModelKeyPresent(base: NodeJS.ProcessEnv = process.env): string[] {
  const flagged: string[] = [];
  if (!isPortkey(base.ANTHROPIC_BASE_URL)) flagged.push(...billingVarsPresent(base));
  if (!isPortkey(base.OPENAI_BASE_URL) && base.OPENAI_API_KEY) flagged.push("OPENAI_API_KEY");
  return flagged;
}

/** The real spawn. Kept tiny; everything testable lives above the Runner seam. */
export const realRunner: Runner = (args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn("stb", args, {
      cwd: opts.cwd,
      windowsHide: true,
      shell: false,
      // Launder the environment so a stray personal key cannot turn a free harbor run into a bill.
      env: harborEnv(),
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutSec * 1000);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) =>
      reject(new StbError(`Failed to spawn stb: ${err.message}. Is the stb CLI installed and on PATH? (uv tool install snorkelai-stb)`)),
    );
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut });
    });
  });

/** Run stb and THROW on a non-zero exit. Use for actions where failure must stop the pipeline. */
export async function stb(run: Runner, args: string[], opts: { timeoutSec?: number; cwd?: string } = {}): Promise<StbResult> {
  const r = await run(args, { timeoutSec: opts.timeoutSec ?? 300, cwd: opts.cwd });
  if (r.timedOut) throw new StbError(`stb ${args[0]} timed out after ${opts.timeoutSec ?? 300}s`, r);
  if (r.code !== 0) {
    const said = (r.stderr || r.stdout).trim().split("\n").slice(0, 4).join("\n");
    throw new StbError(`stb ${args.join(" ")} exited ${r.code}:\n${said}`, r);
  }
  return r;
}

// =========================================================================================
// SUBMISSION STATUS — the 7-value enum, verbatim from the CLI doc (lines 312-320).
// =========================================================================================

export const SUBMISSION_STATUSES = [
  "EVALUATION_PENDING", // automated checks running — cannot update
  "NEEDS_REVISION",     // reviewer/CI requested changes — the ONE updatable state
  "REVIEW_PENDING",     // waiting for a human reviewer
  "ACCEPTED",
  "OFFERED",
  "REJECTED",
  "SKIPPED",
] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

export interface SubmissionRow {
  id: string;
  status: SubmissionStatus;
  /** The local task folder, present only with --show-folder-names. */
  folder?: string;
  /** Anything else the row carried, kept raw so a calibration change never loses data. */
  raw: string;
}

/**
 * Parse `stb submissions list`.
 *
 * CALIBRATION POINT #1 (unverified). Two shapes are handled:
 *   - JSON: if the output parses as JSON (a `--json` flag may exist), read id/status/folder fields.
 *   - TABLE: otherwise, find a known status token on each line and the first UUID-ish token as the id.
 * The table path is deliberately forgiving — a status enum of exactly seven known values is robust to
 * column reordering, which a positional parser would not be. Recalibrate against scripts/stb-probe.sh.
 */
export function parseSubmissionsList(stdout: string): SubmissionRow[] {
  const text = stdout.trim();
  if (!text) return [];

  // JSON shape first.
  try {
    const j = JSON.parse(text);
    const rows: any[] | null = Array.isArray(j) ? j : Array.isArray(j.submissions) ? j.submissions : null;
    if (rows) {
      return rows
        .map((r: any): SubmissionRow | null => {
          const status = String(r.status ?? r.state ?? "").toUpperCase();
          if (!SUBMISSION_STATUSES.includes(status as SubmissionStatus)) return null;
          return {
            id: String(r.id ?? r.submission_id ?? r.uuid ?? ""),
            status: status as SubmissionStatus,
            folder: r.folder ?? r.folder_name ?? r.task_folder ?? undefined,
            raw: JSON.stringify(r),
          };
        })
        .filter((x): x is SubmissionRow => x !== null);
    }
  } catch {
    // Not JSON — fall through to the table parser.
  }

  // Table shape: one row per line carrying a known status token.
  const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
  const rows: SubmissionRow[] = [];
  for (const line of text.split("\n")) {
    const status = SUBMISSION_STATUSES.find((s) => line.includes(s));
    if (!status) continue; // header, separator, or a blank line
    const id = UUID.exec(line)?.[0] ?? line.trim().split(/\s+/)[0] ?? "";
    rows.push({ id, status, raw: line.trim() });
  }
  return rows;
}

/** How many submissions are sitting in NEEDS_REVISION — the number the queue gate cares about. */
export function countNeedsRevision(rows: SubmissionRow[]): number {
  return rows.filter((r) => r.status === "NEEDS_REVISION").length;
}

// =========================================================================================
// TYPED COMMANDS. Each is a thin, named call so the pipeline reads as intent, not argv.
// =========================================================================================

export interface StbCtx {
  run: Runner;
  projectId: string;
}

/** `stb projects list` — used once at setup to capture the PROJECT_ID; also a cheap liveness probe. */
export async function projectsList(run: Runner): Promise<string> {
  return (await stb(run, ["projects", "list"], { timeoutSec: 60 })).stdout;
}

/** `stb submissions list -p PROJECT [--show-folder-names]`. */
export async function submissionsList(
  ctx: StbCtx,
  opts: { showFolders?: boolean } = {},
): Promise<SubmissionRow[]> {
  const args = ["submissions", "list", "-p", ctx.projectId];
  if (opts.showFolders) args.push("--show-folder-names");
  return parseSubmissionsList((await stb(ctx.run, args, { timeoutSec: 120 })).stdout);
}

/** `stb submissions feedback ID` — the automated + reviewer feedback for one submission. */
export async function submissionFeedback(run: Runner, submissionId: string): Promise<string> {
  return (await stb(run, ["submissions", "feedback", submissionId], { timeoutSec: 120 })).stdout;
}

/**
 * `stb submissions create ./task -p PROJECT --time N` — PASS 1. Zips, uploads, runs checks, creates
 * the record. This is the account-slot-consuming action; the pipeline gates it behind the human
 * approval and the queue/daily caps.
 *
 * Returns the new submission id, parsed out of stdout (CALIBRATION POINT #2 — the exact phrasing is
 * unverified; the parser looks for a UUID and is easy to tighten once we see real output).
 */
export async function submissionsCreate(
  ctx: StbCtx,
  taskDir: string,
  timeMinutes: number,
): Promise<{ submissionId: string | null; stdout: string }> {
  const r = await stb(ctx.run, ["submissions", "create", taskDir, "-p", ctx.projectId, "--time", String(timeMinutes)], {
    timeoutSec: 600,
  });
  return { submissionId: firstUuid(r.stdout), stdout: r.stdout };
}

/**
 * `stb submissions update ./task -s ID --time N [--no-send-to-reviewer]`.
 *
 * THE TWO-PASS TOGGLE. `--no-send-to-reviewer` holds the task in the CI/rubric loop (pass 1);
 * omitting it sends the task to a human reviewer (pass 2). Only valid while the submission is in
 * NEEDS_REVISION. This replaces the DOM's tick/untick-then-submit dance with one explicit flag.
 */
export async function submissionsUpdate(
  ctx: StbCtx,
  taskDir: string,
  timeMinutes: number,
  opts: { submissionId?: string; sendToReviewer: boolean },
): Promise<StbResult> {
  const args = ["submissions", "update", taskDir, "--time", String(timeMinutes)];
  if (opts.submissionId) args.push("-s", opts.submissionId);
  if (!opts.sendToReviewer) args.push("--no-send-to-reviewer");
  return stb(ctx.run, args, { timeoutSec: 600 });
}

/** The first UUID in a blob, or null. Used to pull a submission id out of create's output. */
export function firstUuid(s: string): string | null {
  return /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.exec(s)?.[0] ?? null;
}
