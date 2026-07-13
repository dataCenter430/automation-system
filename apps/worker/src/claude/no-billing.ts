/**
 * THIS SYSTEM MUST NEVER COST MONEY PER TOKEN.
 *
 * Every Claude call in this repo goes through the Claude Agent SDK, which spawns the Claude Code
 * CLI, which authenticates from `~/.claude` — the OS user's SUBSCRIPTION. A subscription is a flat
 * fee: usage counts against rate limits, not against a bill. There is no API key anywhere in this
 * codebase and there must never be one.
 *
 * ---------------------------------------------------------------------------------------------
 * THE WAY THAT GUARANTEE BREAKS
 *
 * It does not break by someone adding an API key to the code. It breaks by an ENVIRONMENT
 * VARIABLE that was never meant for us:
 *
 *     ANTHROPIC_API_KEY=sk-ant-...
 *
 * If the CLI sees that, it stops using the subscription and starts billing the key — METERED, per
 * token, for real. Nothing in the code changed. Nothing looks different. The dashboard still says
 * the build succeeded. The invoice arrives later.
 *
 * And it is genuinely easy to set by accident: a line in ~/.bashrc from some other project, a CI
 * runner's secret store, another tool's install script, a `direnv` .envrc two directories up. The
 * worker inherits the environment of whatever launched it.
 *
 * We made this worse ourselves. claude/session.ts passes `env: { ...process.env, ... }` to the SDK
 * (it has to — CLAUDE_CODE_STREAM_CLOSE_TIMEOUT must reach the child, or a blocking ask_human tool
 * call tears the transport down). That spread hands the child EVERY variable we happen to have,
 * including one we never wanted.
 *
 * ---------------------------------------------------------------------------------------------
 * SO WE DO NOT TRUST THE ENVIRONMENT — WE LAUNDER IT.
 *
 * Every SDK spawn goes through subscriptionEnv(), which DELETES the variables that could route a
 * call to metered billing. Not "warns about". Deletes. A warning is a thing you scroll past at
 * 2am; an unset variable cannot bill you.
 *
 * This is belt and braces on purpose: preflight also refuses to start when one of these is set, so
 * you find out at boot rather than after eight builds. But the launder is what actually makes it
 * safe, because preflight runs once and the environment can change under a long-lived worker.
 */

/**
 * Variables that take a Claude call OFF the subscription and ONTO a bill.
 *
 * - ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN: direct, metered API billing.
 * - ANTHROPIC_BASE_URL: points the CLI at a different endpoint, which is not the subscription one.
 * - CLAUDE_CODE_USE_BEDROCK / _USE_VERTEX: route to AWS Bedrock / Google Vertex — both metered,
 *   both billed to a cloud account, and neither is the subscription.
 * - ANTHROPIC_MODEL / ANTHROPIC_SMALL_FAST_MODEL: not billing, but they silently override the
 *   model we pinned in config, which is its own kind of lie (see session.ts on why the model that
 *   ACTUALLY ran is captured rather than assumed).
 */
export const BILLING_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "AWS_BEARER_TOKEN_BEDROCK",
] as const;

/** Model overrides. Not billing, but they defeat the pinned model without telling anyone. */
export const MODEL_OVERRIDE_VARS = ["ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL"] as const;

/** Which of them are set right now. Empty is the healthy answer. */
export function billingVarsPresent(env: NodeJS.ProcessEnv = process.env): string[] {
  return BILLING_VARS.filter((k) => {
    const v = env[k];
    return typeof v === "string" && v.trim() !== "";
  });
}

/**
 * The environment every Claude child process gets.
 *
 * Takes `process.env`, removes anything that could bill us, and adds whatever the caller needs.
 * The result is an environment in which the CLI has exactly one way to authenticate: the
 * subscription in ~/.claude.
 *
 * `delete` rather than set-to-empty: the CLI checks for PRESENCE on some of these, and an empty
 * string is present.
 */
export function subscriptionEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of [...BILLING_VARS, ...MODEL_OVERRIDE_VARS]) delete env[k];
  return { ...env, ...extra };
}

/**
 * What we tell the operator, in the one place they will believe it: the dashboard and the logs.
 *
 * The SDK reports `total_cost_usd` on every turn, and this system surfaces it. That number is what
 * the same tokens WOULD HAVE COST on the metered API. It is NOT a charge, and nothing in this
 * system can produce a charge. Printing "$16.66" with no qualifier next to it invites exactly one
 * conclusion, and it is the wrong one.
 */
export const BILLING_NOTE =
  "API-equivalent, not billed — every Claude call runs on your ~/.claude subscription (flat fee). " +
  "This figure is what the same tokens would have cost on the metered API, and it is shown because " +
  "it is the only honest measure of how much work a build did. It is not money leaving your account.";
