/**
 * Slack "needs a human" notifications.
 *
 * Every test drives the injected Poster — no network, no real token. The invariants that matter:
 * it never throws, it never leaks the token, it no-ops cleanly when disabled or unconfigured, and
 * it reports Slack's own {ok:false} errors instead of silently "succeeding".
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import {
  postSlack, notifyHuman, formatMessage, slackConfig, _resetAnnounced,
  type Poster, type SlackConfig,
} from "../../../apps/worker/src/notify/slack.ts";

const enabled: SlackConfig = { enabled: true, channelId: "C0BHPNC8LJ0", token: "xoxb-secret-123" };

const okPoster = (): { post: Poster; calls: any[] } => {
  const calls: any[] = [];
  const post: Poster = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  return { post, calls };
};

// ------------------------------------------------------------------- config

test("slackConfig reads the token from the environment, not from config", () => {
  const c = slackConfig({ enabled: true, channelId: "C1" }, { SLACK_BOT_TOKEN: " xoxb-abc " } as NodeJS.ProcessEnv);
  assert.equal(c.token, "xoxb-abc");
  assert.equal(c.channelId, "C1");
  assert.equal(c.enabled, true);
});

test("no token in the environment → token is undefined (not empty string)", () => {
  assert.equal(slackConfig({ enabled: true, channelId: "C1" }, {} as NodeJS.ProcessEnv).token, undefined);
});

// ------------------------------------------------------------------- posting

test("posts to chat.postMessage with the channel and a bearer token", async () => {
  const { post, calls } = okPoster();
  const r = await postSlack(enabled, "hello", post);
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://slack.com/api/chat.postMessage");
  assert.equal(calls[0].body.channel, "C0BHPNC8LJ0");
  assert.equal(calls[0].body.text, "hello");
  assert.match(calls[0].init.headers.Authorization, /^Bearer /);
});

test("DISABLED notifications no-op cleanly and never call the network", async () => {
  const { post, calls } = okPoster();
  const r = await postSlack({ ...enabled, enabled: false }, "hi", post);
  assert.equal(r.ok, true);
  assert.equal(calls.length, 0, "must not touch the network when disabled");
});

test("a missing token is a reported failure, not a crash", async () => {
  const r = await postSlack({ ...enabled, token: undefined }, "hi", okPoster().post);
  assert.equal(r.ok, false);
  assert.match(r.error!, /SLACK_BOT_TOKEN/);
});

test("Slack's 200-with-{ok:false} (invalid_auth, channel_not_found) is surfaced, not swallowed", async () => {
  const post: Poster = async () => ({ ok: true, status: 200, json: async () => ({ ok: false, error: "channel_not_found" }) });
  const r = await postSlack(enabled, "hi", post);
  assert.equal(r.ok, false);
  assert.match(r.error!, /channel_not_found/);
});

test("a network throw is caught and returned, never propagated", async () => {
  const post: Poster = async () => { throw new Error("ECONNREFUSED"); };
  const r = await postSlack(enabled, "hi", post);
  assert.equal(r.ok, false);
  assert.match(r.error!, /ECONNREFUSED/);
});

test("a token that leaks into an error message is REDACTED", async () => {
  const post: Poster = async () => { throw new Error("bad request with xoxb-10513482732512-abc in url"); };
  const r = await postSlack(enabled, "hi", post);
  assert.ok(!/xoxb-10513482732512-abc/.test(r.error ?? ""), "the token must not appear in a logged error");
  assert.match(r.error!, /xox\*\*\*/);
});

// ------------------------------------------------------------------- message formatting

test("formats a needs-human message with slug, title, quoted reason and a call to act", () => {
  const m = formatMessage({
    kind: "needs-human",
    slug: "recover-terraform-ml",
    title: "Recover Terraform Container Specs",
    message: "STUCK: the SAME design failed the same way 3 times in a row.\n\nThe wall we keep hitting:\ncategory classifier",
  });
  assert.match(m, /Needs a human/);
  assert.match(m, /`recover-terraform-ml`/);
  assert.match(m, /Recover Terraform Container Specs/);
  assert.match(m, /> STUCK: the SAME design/);
  assert.match(m, /console/i);
});

test("each kind has a distinct headline", () => {
  const kinds = ["needs-human", "failed", "awaiting-approval", "awaiting-review-approval", "question"] as const;
  const heads = kinds.map((k) => formatMessage({ kind: k, slug: "s" }).split("\n")[0]);
  assert.equal(new Set(heads).size, kinds.length, "no two kinds should share a headline");
});

test("a console URL becomes a Slack link", () => {
  const m = formatMessage({ kind: "question", slug: "s", consoleUrl: "http://localhost:3100" });
  assert.match(m, /<http:\/\/localhost:3100\|Open the console>/);
});

// ------------------------------------------------------------------- notifyHuman + dedupe

test("notifyHuman dedupes the same task+kind within the process", async () => {
  _resetAnnounced();
  const { post, calls } = okPoster();
  const ev = { kind: "needs-human" as const, slug: "task-a", message: "same wall" };
  await notifyHuman(enabled, ev, post);
  await notifyHuman(enabled, ev, post);
  assert.equal(calls.length, 1, "the identical notification must fire only once");
});

test("notifyHuman still distinguishes different tasks and different kinds", async () => {
  _resetAnnounced();
  const { post, calls } = okPoster();
  await notifyHuman(enabled, { kind: "needs-human", slug: "task-a" }, post);
  await notifyHuman(enabled, { kind: "needs-human", slug: "task-b" }, post);
  await notifyHuman(enabled, { kind: "awaiting-approval", slug: "task-a" }, post);
  assert.equal(calls.length, 3);
});

test("notifyHuman is a no-op when disabled", async () => {
  _resetAnnounced();
  const { post, calls } = okPoster();
  await notifyHuman({ ...enabled, enabled: false }, { kind: "failed", slug: "x" }, post);
  assert.equal(calls.length, 0);
});
