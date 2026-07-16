/**
 * SLACK NOTIFICATIONS — ping a channel the moment the system needs a person.
 *
 * The console already shows a NEEDS_HUMAN task and holds an ask_human question, but a human has to be
 * LOOKING at the console to see it. This closes that gap: when a task stops and needs a decision, a
 * message lands in Slack so nobody has to babysit the dashboard.
 *
 * Posts through Slack's own bot API (chat.postMessage) — a first-party, sanctioned interface, not a
 * scrape. No SDK: one authenticated HTTPS POST.
 *
 * THREE RULES, all learned elsewhere in this repo:
 *  1. THE TOKEN IS A SECRET. It comes from the environment (SLACK_BOT_TOKEN in .env), never from a
 *     committed file, and it is NEVER logged — not in a success line, not in an error.
 *  2. THIS MUST NEVER FAIL A TRANSITION. A dead Slack, a wrong channel, no network — none of it may
 *     take the pipeline down. Every entry point swallows its own errors and returns a result; the
 *     caller fires it and forgets it.
 *  3. DEPENDENCY INJECTION for the HTTP call, so tests never hit the network.
 */

/** The HTTP seam. Real code uses global fetch; tests pass a fake. */
export type Poster = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<any>;
}>;

export const realPoster: Poster = (url, init) =>
  fetch(url, init).then((r) => ({ ok: r.ok, status: r.status, json: () => r.json() }));

export interface SlackConfig {
  enabled: boolean;
  channelId: string;
  /** From the environment — SLACK_BOT_TOKEN. Never from config JSON. */
  token: string | undefined;
}

export interface PostResult {
  ok: boolean;
  /** Redacted, safe to log. */
  error?: string;
}

/** Read Slack config: channel/enabled from pipeline config, token from the environment. */
export function slackConfig(
  cfg: { enabled?: boolean; channelId?: string } | undefined,
  env: NodeJS.ProcessEnv = process.env,
): SlackConfig {
  return {
    enabled: cfg?.enabled ?? false,
    channelId: cfg?.channelId ?? "",
    token: env.SLACK_BOT_TOKEN?.trim() || undefined,
  };
}

/**
 * Post a message. NEVER throws — returns a result the caller may log. Skips cleanly (ok:true) when
 * notifications are disabled, so callers do not have to check `enabled` themselves.
 */
export async function postSlack(
  cfg: SlackConfig,
  text: string,
  post: Poster = realPoster,
): Promise<PostResult> {
  if (!cfg.enabled) return { ok: true };
  if (!cfg.token) return { ok: false, error: "SLACK_BOT_TOKEN is not set (put it in .env)" };
  if (!cfg.channelId) return { ok: false, error: "no Slack channel configured (slack.channelId)" };

  try {
    const res = await post("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel: cfg.channelId, text, mrkdwn: true, unfurl_links: false }),
    });
    if (!res.ok) return { ok: false, error: `Slack HTTP ${res.status}` };
    // Slack returns 200 with {ok:false,error:"..."} for auth/channel problems. The error strings
    // ("invalid_auth", "channel_not_found", "not_in_channel") are safe to surface; the token is not
    // in them.
    const body = await res.json().catch(() => ({}));
    if (body?.ok === false) return { ok: false, error: `Slack: ${body.error ?? "unknown_error"}` };
    return { ok: true };
  } catch (e) {
    // Redact anything token-shaped from the message, belt and braces.
    const msg = (e as Error).message.replace(/xox[baprs]-[\w-]+/gi, "xox***");
    return { ok: false, error: msg };
  }
}

// =========================================================================================
// MESSAGE FORMATTING — one message per "needs a human" moment.
// =========================================================================================

export type NotifyKind =
  | "needs-human"              // NEEDS_HUMAN: stopped and refused to guess
  | "failed"                   // FAILED: terminal error
  | "awaiting-approval"        // pass 1: ready, waiting for Approve & Submit
  | "awaiting-review-approval" // pass 2: revision ready, waiting to send to a reviewer
  | "question";               // ask_human: a live Claude session is asking

export interface NotifyEvent {
  kind: NotifyKind;
  slug: string;
  title?: string;
  /** The wall we hit / the question asked / why. First lines are enough. */
  message?: string;
  /** Where to act — the console URL, if known. */
  consoleUrl?: string;
}

const HEAD: Record<NotifyKind, string> = {
  "needs-human": ":raising_hand: *Needs a human*",
  failed: ":x: *Task failed*",
  "awaiting-approval": ":white_check_mark: *Ready to submit — your approval*",
  "awaiting-review-approval": ":white_check_mark: *Revision ready — approve send to reviewer*",
  question: ":question: *Claude is asking you*",
};

/** Build the message text. Kept pure so it is trivially testable. */
export function formatMessage(ev: NotifyEvent): string {
  const lines = [`${HEAD[ev.kind]} — \`${ev.slug}\``];
  if (ev.title) lines.push(ev.title);
  if (ev.message) {
    // Quote the first few lines; Slack renders `>` as a blockquote.
    const excerpt = ev.message.split("\n").filter((l) => l.trim()).slice(0, 4).join("\n");
    lines.push(excerpt.split("\n").map((l) => `> ${l}`).join("\n"));
  }
  lines.push(ev.consoleUrl ? `<${ev.consoleUrl}|Open the console>` : "Open the console to act.");
  return lines.join("\n");
}

/**
 * The one call the pipeline makes. Formats + posts, never throws, dedupes within the process so the
 * same task+kind is not announced twice (transitions commit once, but this is belt-and-braces).
 */
const announced = new Set<string>();

export async function notifyHuman(
  cfg: SlackConfig,
  ev: NotifyEvent,
  post: Poster = realPoster,
): Promise<PostResult> {
  if (!cfg.enabled) return { ok: true };
  const key = `${ev.slug}:${ev.kind}:${(ev.message ?? "").slice(0, 40)}`;
  if (announced.has(key)) return { ok: true };
  announced.add(key);
  return postSlack(cfg, formatMessage(ev), post);
}

/** Test seam: forget what has been announced. */
export function _resetAnnounced(): void {
  announced.clear();
}
