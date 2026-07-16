/**
 * The stb CLI wrapper — the sanctioned submission path.
 *
 * Driven entirely by a FAKE Runner (dependency injection), so no test touches a real `stb` and none
 * needs a login. The two things worth protecting here are the status parser (robust to JSON *or*
 * table output, since the shape is unverified) and the env laundering (a stray personal key must
 * never turn a free harbor run into a bill).
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import {
  parseSubmissionsList, countNeedsRevision, firstUuid, harborEnv, personalModelKeyPresent,
  submissionsList, submissionsCreate, submissionsUpdate, StbError, type Runner, type StbResult,
} from "../../../apps/worker/src/stb/cli.ts";

const ok = (stdout: string): StbResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const fake = (stdout: string): Runner => async () => ok(stdout);
const capture = (): { runner: Runner; calls: string[][] } => {
  const calls: string[][] = [];
  return { calls, runner: async (args) => { calls.push(args); return ok("done 11111111-2222-3333-4444-555555555555"); } };
};

// ------------------------------------------------------------------- status parsing

test("parses a TABLE listing by finding the known status token on each row", () => {
  const out = [
    "ID                                    STATUS              FOLDER",
    "11111111-1111-1111-1111-111111111111  NEEDS_REVISION      my-task-a",
    "22222222-2222-2222-2222-222222222222  REVIEW_PENDING      my-task-b",
    "33333333-3333-3333-3333-333333333333  ACCEPTED            my-task-c",
  ].join("\n");
  const rows = parseSubmissionsList(out);
  assert.equal(rows.length, 3);
  assert.equal(rows[0]!.status, "NEEDS_REVISION");
  assert.equal(rows[0]!.id, "11111111-1111-1111-1111-111111111111");
  assert.equal(rows[2]!.status, "ACCEPTED");
});

test("parses a JSON listing", () => {
  const out = JSON.stringify([
    { id: "aaaa1111-1111-1111-1111-111111111111", status: "NEEDS_REVISION", folder: "t1" },
    { submission_id: "bbbb2222-2222-2222-2222-222222222222", state: "review_pending" },
  ]);
  const rows = parseSubmissionsList(out);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.status, "NEEDS_REVISION");
  assert.equal(rows[0]!.folder, "t1");
  assert.equal(rows[1]!.status, "REVIEW_PENDING"); // lowercased in, uppercased out
});

test("ignores header/separator lines that carry no known status", () => {
  const out = "ID   STATUS\n----  ------\n(no submissions yet)";
  assert.deepEqual(parseSubmissionsList(out), []);
});

test("countNeedsRevision counts only NEEDS_REVISION — the queue-cap quantity", () => {
  const rows = parseSubmissionsList([
    "a1111111-1111-1111-1111-111111111111  NEEDS_REVISION",
    "b2222222-2222-2222-2222-222222222222  NEEDS_REVISION",
    "c3333333-3333-3333-3333-333333333333  REVIEW_PENDING",
    "d4444444-4444-4444-4444-444444444444  ACCEPTED",
  ].join("\n"));
  assert.equal(countNeedsRevision(rows), 2);
});

test("firstUuid pulls the submission id out of create's output", () => {
  assert.equal(
    firstUuid("Created submission 7f3a9c21-0b4e-4d6a-8c1f-2e5b7a9d0c33 — uploading…"),
    "7f3a9c21-0b4e-4d6a-8c1f-2e5b7a9d0c33",
  );
  assert.equal(firstUuid("no id here"), null);
});

// ------------------------------------------------------------------- env laundering (cost safety)

test("harborEnv STRIPS personal (direct-provider) keys — a free run must never bill us", () => {
  const dirty = {
    PATH: "/usr/bin",
    ANTHROPIC_API_KEY: "sk-ant-leak",
    OPENAI_API_KEY: "sk-openai-leak",
    OPENAI_BASE_URL: "https://api.openai.com", // NOT portkey → personal → strip
  } as NodeJS.ProcessEnv;
  const clean = harborEnv(dirty);
  assert.equal(clean.PATH, "/usr/bin");
  assert.equal(clean.ANTHROPIC_API_KEY, undefined);
  assert.equal(clean.OPENAI_API_KEY, undefined);
  assert.equal(clean.OPENAI_BASE_URL, undefined);
});

test("harborEnv KEEPS a Portkey-routed key — that is the platform credential harbor needs", () => {
  // The docs' own setup: OPENAI_API_KEY=<portkey-key> + OPENAI_BASE_URL=https://api.portkey.ai/v1.
  // Portkey is Snorkel's proxy → platform-billed → must survive, or harbor has no credentials.
  const platform = {
    PATH: "/usr/bin",
    OPENAI_API_KEY: "pk-portkey-abc",
    OPENAI_BASE_URL: "https://api.portkey.ai/v1",
  } as NodeJS.ProcessEnv;
  const clean = harborEnv(platform);
  assert.equal(clean.OPENAI_API_KEY, "pk-portkey-abc", "the Portkey key must be preserved");
  assert.equal(clean.OPENAI_BASE_URL, "https://api.portkey.ai/v1");
});

test("personalModelKeyPresent flags direct-provider keys but NOT Portkey-routed ones", () => {
  assert.deepEqual(personalModelKeyPresent({ PATH: "/x" } as NodeJS.ProcessEnv), []);

  // Personal keys → flagged.
  const flagged = personalModelKeyPresent({ OPENAI_API_KEY: "x", ANTHROPIC_API_KEY: "y" } as NodeJS.ProcessEnv);
  assert.ok(flagged.includes("OPENAI_API_KEY"));
  assert.ok(flagged.includes("ANTHROPIC_API_KEY"));

  // A Portkey-routed OpenAI key is safe → NOT flagged.
  assert.deepEqual(
    personalModelKeyPresent({ OPENAI_API_KEY: "pk", OPENAI_BASE_URL: "https://api.portkey.ai/v1" } as NodeJS.ProcessEnv),
    [],
  );
});

// ------------------------------------------------------------------- command argv shaping

test("the two-pass toggle: --no-send-to-reviewer is present for pass 1, absent for pass 2", async () => {
  const p1 = capture();
  await submissionsUpdate({ run: p1.runner, projectId: "P" }, "./task", 200, { sendToReviewer: false });
  assert.ok(p1.calls[0]!.includes("--no-send-to-reviewer"), "CI/hold lap must NOT send to reviewer");

  const p2 = capture();
  await submissionsUpdate({ run: p2.runner, projectId: "P" }, "./task", 200, { sendToReviewer: true, submissionId: "S" });
  assert.ok(!p2.calls[0]!.includes("--no-send-to-reviewer"), "the reviewer lap must omit the flag");
  assert.ok(p2.calls[0]!.includes("-s") && p2.calls[0]!.includes("S"));
});

test("create passes the project and honest --time", async () => {
  const c = capture();
  const res = await submissionsCreate({ run: c.runner, projectId: "Terminus-2nd-Edition" }, "./task", 200);
  const argv = c.calls[0]!;
  assert.deepEqual(argv.slice(0, 3), ["submissions", "create", "./task"]);
  assert.ok(argv.includes("-p") && argv.includes("Terminus-2nd-Edition"));
  assert.ok(argv.includes("--time") && argv.includes("200"));
  assert.equal(res.submissionId, "11111111-2222-3333-4444-555555555555");
});

test("a non-zero exit throws StbError with the stderr tail", async () => {
  const failing: Runner = async () => ({ code: 1, stdout: "", stderr: "Authentication failed: run stb login", timedOut: false });
  await assert.rejects(
    () => submissionsList({ run: failing, projectId: "P" }),
    (e: Error) => e instanceof StbError && /Authentication failed/.test(e.message),
  );
});

test("a timeout throws rather than silently returning empty", async () => {
  const slow: Runner = async () => ({ code: -1, stdout: "", stderr: "", timedOut: true });
  await assert.rejects(() => submissionsList({ run: slow, projectId: "P" }), (e: Error) => e instanceof StbError && /timed out/.test(e.message));
});
