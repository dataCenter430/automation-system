/**
 * Headless login + post-submission feedback classification.
 *
 * Both are driven by fakes (DI) — no real stb, no real key. The login mechanism is undocumented, so
 * the test pins the BEHAVIOUR we control: it tries strategies in order, stops at the first success,
 * and NEVER lets the key into a logged message.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import {
  loginWithKey, readKey, redact, ensureReady, keysRefresh, LoginError, KEY_ENV, LOGIN_STRATEGIES,
  type LoginRunner,
} from "../../../apps/worker/src/stb/login.ts";
import { classifyFeedback, promptFor, parseDownloadPath } from "../../../apps/worker/src/stb/feedback.ts";
import type { Runner, StbResult } from "../../../apps/worker/src/stb/cli.ts";

const ok: StbResult = { code: 0, stdout: "logged in", stderr: "", timedOut: false };
const fail = (msg: string): StbResult => ({ code: 1, stdout: "", stderr: msg, timedOut: false });

// ------------------------------------------------------------------- login

test("readKey reads STB_API_KEY from the environment, trimmed", () => {
  assert.equal(readKey({ [KEY_ENV]: "  sk-abc  " } as NodeJS.ProcessEnv), "sk-abc");
  assert.equal(readKey({} as NodeJS.ProcessEnv), null);
  assert.equal(readKey({ [KEY_ENV]: "" } as NodeJS.ProcessEnv), null);
});

test("login stops at the FIRST strategy that exits 0", async () => {
  const tried: string[][] = [];
  const runner: LoginRunner = async (args) => {
    tried.push(args);
    // Fail everything except the stdin strategy (login with no extra args).
    return args.length === 1 && args[0] === "login" ? ok : fail("nope");
  };
  const res = await loginWithKey("sk-secret", runner);
  assert.equal(res.ok, true);
  // It should have tried earlier strategies first and stopped once one worked.
  assert.ok(tried.length >= 1);
});

test("login tries EVERY strategy before giving up, and the error names them", async () => {
  const runner: LoginRunner = async () => fail("unauthorized");
  await assert.rejects(
    () => loginWithKey("sk-secret", runner),
    (e: Error) => e instanceof LoginError && LOGIN_STRATEGIES.every((s) => e.message.includes(s.name)),
  );
});

test("the API key NEVER appears in the failure message", async () => {
  const KEY = "sk-super-secret-value-123";
  // A hostile CLI that echoes the key back in its error.
  const runner: LoginRunner = async () => fail(`bad key: ${KEY}`);
  const err = await loginWithKey(KEY, runner).catch((e) => e as Error);
  assert.ok(err instanceof LoginError);
  assert.ok(!err.message.includes(KEY), "the key must be redacted from any logged message");
  assert.ok(err.message.includes("***"), "redaction marker should be present");
});

test("redact removes every occurrence of the key", () => {
  assert.equal(redact("a KEY b KEY c", "KEY"), "a *** b *** c");
  assert.equal(redact("nothing here", "KEY"), "nothing here");
});

test("no key at all is a clear, actionable error", async () => {
  await assert.rejects(
    () => loginWithKey("", async () => ok),
    (e: Error) => e instanceof LoginError && e.message.includes(KEY_ENV),
  );
});

// ------------------------------------------------------------------- ensureReady (the one-time flow)

test("ensureReady: an ALREADY-authenticated worker does not re-login and does NOT refresh keys", async () => {
  // keys refresh is capped (max ~10), so a warm boot must never spend it.
  const calls: string[][] = [];
  const run: Runner = async (args) => {
    calls.push(args);
    if (args[0] === "keys" && args[1] === "show") return ok; // logged in
    return ok;
  };
  const loginRun: LoginRunner = async () => { throw new Error("should not login"); };
  const res = await ensureReady(run, loginRun, { env: {} as NodeJS.ProcessEnv });
  assert.equal(res.freshLogin, false);
  assert.ok(!calls.some((c) => c[0] === "keys" && c[1] === "refresh"), "must NOT refresh on a warm boot");
});

test("ensureReady: a cold worker logs in from .env, THEN refreshes keys once", async () => {
  const calls: string[][] = [];
  let loggedIn = false;
  const run: Runner = async (args) => {
    calls.push(args);
    if (args[0] === "keys" && args[1] === "show") return loggedIn ? ok : fail("not logged in");
    return ok;
  };
  const loginRun: LoginRunner = async () => { loggedIn = true; return ok; };
  const res = await ensureReady(run, loginRun, { env: { [KEY_ENV]: "sk-key" } as NodeJS.ProcessEnv });
  assert.equal(res.freshLogin, true);
  assert.ok(calls.some((c) => c[0] === "keys" && c[1] === "refresh"), "a fresh login must refresh keys once");
});

test("ensureReady: not logged in AND no key → a clear error naming STB_API_KEY", async () => {
  const run: Runner = async () => fail("not logged in");
  const loginRun: LoginRunner = async () => ok;
  await assert.rejects(
    () => ensureReady(run, loginRun, { env: {} as NodeJS.ProcessEnv }),
    (e: Error) => e instanceof LoginError && e.message.includes(KEY_ENV),
  );
});

test("keysRefresh treats the refresh CAP as non-fatal", async () => {
  const run: Runner = async () => fail("Bad Request: Maximum refresh limit reached");
  await keysRefresh(run); // must not throw
});

// ------------------------------------------------------------------- download path parsing

test("parseDownloadPath reads the destination out of the command output", () => {
  assert.equal(parseDownloadPath("Downloaded submission to /home/me/dl/sub-123"), "/home/me/dl/sub-123");
  assert.equal(parseDownloadPath("Saved to: ./artifacts/difficulty_check_artifact"), "./artifacts/difficulty_check_artifact");
  assert.equal(parseDownloadPath("Extracted files into /tmp/stb/xyz"), "/tmp/stb/xyz");
});

test("parseDownloadPath falls back to the last path token when there is no phrase", () => {
  assert.equal(parseDownloadPath("done\n/var/data/sub-9/difficulty_check_artifact"), "/var/data/sub-9/difficulty_check_artifact");
});

test("parseDownloadPath returns null when the output names no path", () => {
  assert.equal(parseDownloadPath("Download complete."), null);
});

// ------------------------------------------------------------------- feedback classification

test("'too easy' routes to the artifact-driven make-harder prompt", () => {
  const v = classifyFeedback("Difficulty check: the task is too easy. Worst model scores above 80%.");
  assert.equal(v.kind, "too-easy");
  assert.ok(v.signals.length >= 1);
  const p = promptFor(v.kind);
  assert.equal(p.template, "11-too-easy.md");
  assert.equal(p.needsArtifact, true); // the transcripts MUST be downloaded and handed over
});

test("a high pass-rate phrased as a percentage is caught as too-easy", () => {
  assert.equal(classifyFeedback("The agent solved it with 90% accuracy across runs.").kind, "too-easy");
});

test("'similar task already exists' is a DECLINE, not a too-easy fix", () => {
  // Decline must win even if the text also contains something else — it is fatal, not salvageable-harder.
  const v = classifyFeedback("Declined: a similar task already exists in the benchmark.");
  assert.equal(v.kind, "decline");
});

test("a named CI check failure routes to the CI-fix prompt", () => {
  const v = classifyFeedback("CI: check_task_absolute_path FAILED — use /full/path. ruff BLOCKING.");
  assert.equal(v.kind, "ci-failure");
  assert.equal(promptFor(v.kind).template, "05-feedback-fix.md");
});

test("plain reviewer prose routes to the surgical revise prompt", () => {
  const v = classifyFeedback("Please clarify step 3 of the instruction; it reads ambiguously.");
  assert.equal(v.kind, "reviewer-change");
  assert.equal(promptFor(v.kind).template, "06-revise.md");
});

test("empty feedback is unknown, not silently mishandled", () => {
  assert.equal(classifyFeedback("   ").kind, "unknown");
});

test("the raw feedback is ALWAYS preserved for the fix session", () => {
  const raw = "Some very specific reviewer note about the oracle.";
  assert.equal(classifyFeedback(raw).raw, raw);
});
