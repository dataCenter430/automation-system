/**
 * Alignment with the Snorkel Terminus changelog — the lint rules that changed.
 *
 * Each test builds a minimal task tree in a temp dir and asserts a specific rule fires (or does not),
 * pinning the changelog behaviour so a future edit that regresses it goes red.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lintTask, type Finding } from "../../../apps/worker/src/stages/lint.ts";

const PINNED = "public.ecr.aws/docker/library/python:3.13-slim-bookworm@sha256:01f42367a0a94ad4bc17111776fd66e3500c1d87c15bbd6055b7371d39c124fb";

const GOOD_DOCKERFILE = `FROM ${PINNED}
RUN pip install --no-cache-dir pytest==8.4.1 pytest-json-ctrf==0.3.5 && \\
    apt-get update && apt-get install -y --no-install-recommends tmux asciinema && rm -rf /var/lib/apt/lists/*
COPY app /app
`;

const GOOD_TEST_SH = `#!/bin/bash
cd /app
python -m pytest /tests/test_outputs.py --ctrf /logs/verifier/report.json
RC=$?
if [ "$RC" -eq 0 ]; then
  echo 1 > /logs/verifier/reward.txt
else
  echo 0 > /logs/verifier/reward.txt
fi
`;

const TOML = (allowInternet: string) => `version = "2.0"
[metadata]
author_name = "anonymous"
author_email = "anonymous"
difficulty = "hard"
category = "security"
subcategories = ["long_context"]
languages = ["python"]
tags = ["a", "b", "c"]
codebase_size = "minimal"
[agent]
timeout_sec = 600
[verifier]
timeout_sec = 600
[environment]
${allowInternet}
build_timeout_sec = 900
`;

/** Build a minimal task tree; overrides replace specific files. */
function makeTask(over: { toml?: string; dockerfile?: string; testSh?: string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "cl-align-"));
  mkdirSync(join(dir, "environment", "app"), { recursive: true });
  mkdirSync(join(dir, "tests"), { recursive: true });
  mkdirSync(join(dir, "solution"), { recursive: true });
  writeFileSync(join(dir, "task.toml"), over.toml ?? TOML("allow_internet = false"));
  writeFileSync(join(dir, "instruction.md"), "You are a security engineer. Harden /app/verify against forged signatures.\n");
  writeFileSync(join(dir, "environment", "Dockerfile"), over.dockerfile ?? GOOD_DOCKERFILE);
  writeFileSync(join(dir, "environment", "app", "main.py"), "x = 1\n");
  writeFileSync(join(dir, "solution", "solve.sh"), "#!/bin/bash\necho solve\n");
  writeFileSync(join(dir, "tests", "test.sh"), over.testSh ?? GOOD_TEST_SH);
  writeFileSync(join(dir, "tests", "test_outputs.py"), "def test_forged_signature_is_rejected():\n    assert True\n");
  return dir;
}

const rules = (f: Finding[], rule: string) => f.filter((x) => x.rule === rule);
const blocking = (f: Finding[], rule: string) => rules(f, rule).filter((x) => x.severity === "blocking");
const withDir = (over: Parameters<typeof makeTask>[0], fn: (f: Finding[]) => void) => {
  const dir = makeTask(over);
  try { fn(lintTask(dir).findings); } finally { rmSync(dir, { recursive: true, force: true }); }
};

// ------------------------------------------------------------------- allow_internet (Jul 13)

test("allow_internet = true is ACCEPTED (warning, not blocking) — the Jul 13 rule", () => {
  withDir({ toml: TOML("allow_internet = true") }, (f) => {
    assert.equal(blocking(f, "allow_internet").length, 0, "true must not be blocked any more");
    assert.equal(rules(f, "allow_internet").filter((x) => x.severity === "warning").length, 1);
  });
});

test("allow_internet = false is fine (offline task)", () => {
  withDir({ toml: TOML("allow_internet = false") }, (f) => {
    assert.equal(rules(f, "allow_internet").length, 0);
  });
});

test("allow_internet MISSING is blocking — it must be set", () => {
  withDir({ toml: TOML("") }, (f) => {
    assert.equal(blocking(f, "allow_internet").length, 1);
  });
});

// ------------------------------------------------------------------- test.sh network (A5 / G-7)

test("curl in test.sh is BLOCKED when allow_internet = false", () => {
  const testSh = GOOD_TEST_SH.replace("cd /app", "cd /app\ncurl https://example.com/data");
  withDir({ testSh }, (f) => assert.equal(blocking(f, "no_runtime_install").length, 1));
});

test("curl in test.sh is ALLOWED when allow_internet = true (only installs warn)", () => {
  const testSh = GOOD_TEST_SH.replace("cd /app", "cd /app\ncurl https://example.com/data");
  withDir({ toml: TOML("allow_internet = true"), testSh }, (f) => {
    assert.equal(blocking(f, "no_runtime_install").length, 0, "an online task may curl at test time");
  });
});

test("a runtime pip install still WARNS even with allow_internet = true (reproducibility)", () => {
  const testSh = GOOD_TEST_SH.replace("cd /app", "cd /app\npip install requests");
  withDir({ toml: TOML("allow_internet = true"), testSh }, (f) => {
    assert.equal(rules(f, "no_runtime_install").filter((x) => x.severity === "warning").length, 1);
  });
});

// ------------------------------------------------------------------- reward block (M-1)

test("the INLINE reward form `if [ $? -eq 0 ]` is accepted", () => {
  const testSh = `#!/bin/bash
cd /app
python -m pytest /tests/test_outputs.py --ctrf /logs/verifier/report.json
if [ $? -eq 0 ]; then
  echo 1 > /logs/verifier/reward.txt
else
  echo 0 > /logs/verifier/reward.txt
fi
`;
  withDir({ testSh }, (f) => assert.equal(blocking(f, "canonical_reward_block").length, 0));
});

test("a lowercase `rc=$?` capture is accepted (case-insensitive)", () => {
  const testSh = GOOD_TEST_SH.replace('RC=$?\nif [ "$RC" -eq 0 ]', 'rc=$?\nif [ "$rc" -eq 0 ]');
  withDir({ testSh }, (f) => assert.equal(blocking(f, "canonical_reward_block").length, 0));
});

// ------------------------------------------------------------------- tmux/asciinema (G-3)

test("a Dockerfile missing tmux is BLOCKING", () => {
  const dockerfile = GOOD_DOCKERFILE.replace("tmux asciinema", "asciinema");
  withDir({ dockerfile }, (f) => assert.equal(blocking(f, "environment_problems").length, 1));
});

test("a Dockerfile missing asciinema is BLOCKING", () => {
  const dockerfile = GOOD_DOCKERFILE.replace("tmux asciinema", "tmux");
  withDir({ dockerfile }, (f) => assert.equal(blocking(f, "environment_problems").length, 1));
});

test("a Dockerfile with both tmux and asciinema is clean on that rule", () => {
  withDir({}, (f) => assert.equal(rules(f, "environment_problems").length, 0));
});

// ------------------------------------------------------------------- tag-only image (M-2)

test("a tag-only FROM (no @sha256) is BLOCKING", () => {
  const dockerfile = GOOD_DOCKERFILE.replace(PINNED, "python:3.13-slim-bookworm");
  withDir({ dockerfile }, (f) => assert.equal(blocking(f, "check_pinned_images").length, 1));
});

test("a digest-pinned FROM is clean", () => {
  withDir({}, (f) => assert.equal(rules(f, "check_pinned_images").length, 0));
});
