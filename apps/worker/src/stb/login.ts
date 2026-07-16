/**
 * NON-INTERACTIVE `stb login` — authenticate from a key the operator supplies, no browser.
 *
 * WHAT THE OPERATOR WANTS: put the Snorkel expert API key in .env (STB_API_KEY), and have the worker
 * install + log in headlessly. The `stb login` documented in the CLI guide is INTERACTIVE — it opens
 * the key page and waits for you to paste the key at a prompt ("copy the key, and paste it into your
 * terminal", # Snorkel Terminal-Bench CLI.txt:83). There is NO documented non-interactive flag.
 *
 * So the exact headless mechanism is UNVERIFIED, and this module is built to survive that: it tries
 * the plausible mechanisms in order and reports which one worked. When `stb login --help` reveals the
 * real flag (the probe script captures it), collapse this to the one true strategy.
 *
 * THE KEY IS A SECRET. It is read from the environment (.env, loaded by dotenv), never logged, never
 * written to the transcript, never passed on a visible argv where we can avoid it. Errors quote the
 * CLI's message, not the key.
 *
 * SEPARATION OF THE TWO KEYS (this is the one that bites): the key here is the SNORKEL PLATFORM key,
 * which authenticates the CLI. It is NOT the Portkey AI key that harbor model runs use — that one is
 * provisioned separately by `stb keys refresh` after login. Do not conflate them. See stb/cli.ts
 * harborEnv() for the AI-credential side.
 */
import { spawn } from "node:child_process";
import { stb, harborEnv, StbError, type Runner, type StbResult } from "./cli.ts";

/** The env var the operator sets in .env. */
export const KEY_ENV = "STB_API_KEY";

export class LoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoginError";
  }
}

export interface LoginResult {
  ok: boolean;
  /** Which strategy authenticated, for the log. */
  strategy: string;
  detail: string;
}

/**
 * The strategies, in order of likelihood, each a (key) → argv-and-stdin plan. The FIRST that exits 0
 * wins. Every one keeps the key off a world-readable argv where possible (stdin or env), because a
 * process list is not a secret store.
 *
 * Calibrate against `stb login --help` (probe step 5). Most CLIs implement exactly one of these; when
 * we know which, delete the rest.
 */
interface Strategy {
  name: string;
  /** argv after `login`. */
  args: (key: string) => string[];
  /** piped to stdin, if the CLI reads the key that way ("paste into your terminal" hints at stdin). */
  stdin?: (key: string) => string;
  /** extra env for this attempt (e.g. STB_API_KEY passthrough). */
  env?: (key: string) => Record<string, string>;
}

export const LOGIN_STRATEGIES: Strategy[] = [
  // 1. THE DOCUMENTED MECHANISM. `stb login` opens a browser to GENERATE a key, then reads the key
  //    you "paste into your terminal" — i.e. from stdin. We already hold the key, so we ignore the
  //    browser (realLoginRunner also neuters it) and feed the key straight to the prompt. This is
  //    exactly the operator's description: the confirmation window appears, we ignore it, the key
  //    from .env logs us in.
  { name: "stdin", args: () => ["login"], stdin: (k) => `${k}\n` },
  // Fallbacks for other CLI versions — only reached if stdin fails.
  { name: "env:STB_API_KEY", args: () => ["login"], env: (k) => ({ STB_API_KEY: k }), stdin: (k) => `${k}\n` },
  { name: "flag:--api-key", args: (k) => ["login", "--api-key", k] },
  { name: "flag:--key", args: (k) => ["login", "--key", k] },
];

/**
 * A Runner that can also pass stdin and per-call env. The default cli.ts Runner does not take stdin,
 * so login uses this richer seam; tests drive it with a fake.
 */
export type LoginRunner = (
  args: string[],
  opts: { timeoutSec: number; stdin?: string; env?: Record<string, string> },
) => Promise<StbResult>;

/** Read the key from the environment. Returns null (not throws) so the caller can message nicely. */
export function readKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const k = env[KEY_ENV]?.trim();
  return k && k.length > 0 ? k : null;
}

/** Is the CLI already authenticated? Cheap, and lets us skip login entirely on a warm machine. */
export async function isLoggedIn(run: Runner): Promise<boolean> {
  try {
    const r = await run(["keys", "show"], { timeoutSec: 30 });
    // "keys show" prints creds when logged in and errors (non-zero) when not.
    return r.code === 0 && !/not\s+logged\s+in|authenticat|login/i.test(r.stdout + r.stderr);
  } catch {
    return false;
  }
}

/**
 * Log in headlessly. Tries each strategy until one exits 0. Never logs the key.
 *
 * `probe` runs the strategy and returns its result; injected so tests never spawn `stb`.
 */
export async function loginWithKey(
  key: string,
  probe: LoginRunner,
): Promise<LoginResult> {
  if (!key) throw new LoginError(`No ${KEY_ENV} provided. Put the Snorkel expert API key in .env as ${KEY_ENV}=...`);

  const failures: string[] = [];
  for (const s of LOGIN_STRATEGIES) {
    let r: StbResult;
    try {
      r = await probe(s.args(key), {
        timeoutSec: 60,
        stdin: s.stdin?.(key),
        env: s.env?.(key),
      });
    } catch (e) {
      failures.push(`${s.name}: ${(e as Error).message}`);
      continue;
    }
    if (r.code === 0) {
      return { ok: true, strategy: s.name, detail: "authenticated" };
    }
    // Redact anything that looks like the key from the recorded message.
    const said = redact((r.stderr || r.stdout).trim().split("\n")[0] ?? "", key);
    failures.push(`${s.name}: exit ${r.code} — ${said}`);
  }

  throw new LoginError(
    `Headless login failed on every known strategy. The non-interactive mechanism is undocumented — ` +
      `run \`stb login --help\` (see scripts/stb-probe.sh) and tell me the real flag/env, then this ` +
      `collapses to one call.\nTried:\n  ${failures.join("\n  ")}`,
  );
}

/** Remove the secret from any string before it is logged. */
export function redact(s: string, key: string): string {
  if (!key) return s;
  return s.split(key).join("***");
}

/**
 * The real login spawn: feeds the key on stdin, and SUPPRESSES THE BROWSER so no window pops on an
 * automated worker.
 *
 * `stb` is a Python CLI, and Python's webbrowser module honours $BROWSER. Setting it to `true` (the
 * shell no-op that exits 0) means the "open the key page" step does nothing instead of launching a
 * window — the operator's "ignore it" made automatic. If a given stb version ignores $BROWSER and
 * opens anyway, that is harmless: the key still arrives on stdin and the window is just ignored.
 *
 * stdin is ALWAYS closed after the key is written, so `stb login` never blocks waiting for more
 * input. The key is passed via stdin/env, never on argv where a process list would expose it (the
 * flag fallbacks are last-resort and still redacted from any log).
 */
export const realLoginRunner: LoginRunner = (args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn("stb", args, {
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...harborEnv(), // launder any personal model key out of the login environment too
        ...opts.env,
        BROWSER: opts.env?.BROWSER ?? "true", // no-op the browser launch on a headless worker
      },
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
      reject(new StbError(`Failed to spawn stb login: ${err.message}. Is stb installed and on PATH?`)),
    );
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut });
    });
    if (opts.stdin !== undefined) child.stdin.write(opts.stdin);
    child.stdin.end(); // never leave stb waiting for more input
  });

/**
 * `stb keys refresh` — provision the platform (Portkey) AI credentials harbor runs need.
 *
 * REFRESH IS CAPPED (the docs: "Maximum refresh limit reached" after ~10). So this is called ONLY
 * after a FRESH login, never on every boot — a warm, already-authenticated worker keeps the creds it
 * has. A cap error here is non-fatal: existing creds may already be valid.
 */
export async function keysRefresh(run: Runner, log?: (m: string) => void): Promise<void> {
  try {
    await stb(run, ["keys", "refresh"], { timeoutSec: 60 });
    log?.("stb keys refreshed — harbor AI credentials provisioned");
  } catch (e) {
    const msg = (e as Error).message;
    if (/maximum refresh limit/i.test(msg)) {
      log?.("stb keys refresh hit the cap — keeping existing credentials (not fatal)");
      return;
    }
    throw e;
  }
}

/**
 * ONE-TIME SETUP, made idempotent: ensure the CLI is authenticated and harbor-ready.
 *
 *   already logged in  → do nothing (do NOT refresh — that would burn the capped refresh budget).
 *   not logged in      → log in from .env's STB_API_KEY, then refresh keys ONCE for harbor.
 *
 * After this returns, any stb command — submissions, reviews, harbor runs — works. Injected runners
 * keep it fully testable; production passes realRunner + realLoginRunner.
 */
export async function ensureReady(
  run: Runner,
  loginRun: LoginRunner,
  opts: { env?: NodeJS.ProcessEnv; log?: (m: string) => void } = {},
): Promise<{ freshLogin: boolean }> {
  const log = opts.log;
  if (await isLoggedIn(run)) {
    log?.("stb already authenticated — reusing existing session");
    return { freshLogin: false };
  }
  const key = readKey(opts.env);
  if (!key) {
    throw new LoginError(
      `stb is not logged in and no ${KEY_ENV} is set. Put your Snorkel expert API key in .env as ` +
        `${KEY_ENV}=... — it is used once to log in; harbor credentials come from \`stb keys refresh\` after.`,
    );
  }
  const res = await loginWithKey(key, loginRun);
  log?.(`stb login succeeded (${res.strategy})`);
  await keysRefresh(run, log);
  return { freshLogin: true };
}
