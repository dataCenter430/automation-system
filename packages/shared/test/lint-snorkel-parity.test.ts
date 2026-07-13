/**
 * Parity with Snorkel's CI, proven against the artefacts Snorkel actually rejected.
 *
 * The submission at workspace/migrate-imagemagick-textile-features-with-c-sqlite passed our
 * gate ("lint clean") and was then hit by Snorkel with 9 hard errors and a pile of warnings.
 * Every test below pins one of those findings to the rule that now catches it, using the REAL
 * failing tree — not a mock of it. If someone weakens a rule, the corresponding Snorkel
 * finding comes back, and this file goes red.
 *
 * The mapping:
 *   ❌ "tests: ruff found 14 error(s)"                    -> ruff_clean                       (blocking)
 *   ❌ "codebase_size is 'small' ... expected 'minimal'"  -> codebase_size_matches_environment (blocking)
 *   ❌ "[category_classifier] Predicted 'software-engineering' ... is blocked"
 *                                                         -> predicted_category_blocked        (warning, sync backstop)
 *   ⚠️ "[instruction_check] prescribes sequential developer workflow steps"
 *                                                         -> instruction_prescribes_workflow   (warning)
 *   ⚠️ "Dockerfile:24: pip install with no Python lockfile"
 *                                                         -> pip_hash_locked_requirements      (warning)
 *   (blind spot, did not fire here) "[ ] pinned_dependencies"
 *                                                         -> pinned_dependencies               (blocking)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { lintTask, type Finding } from "../../../apps/worker/src/stages/lint.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * A FROZEN copy of the exact task tree Snorkel rejected — not the live workspace.
 *
 * These tests originally lint()ed workspace/migrate-imagemagick-textile-features-with-c-sqlite
 * directly, on the reasoning that the best regression subject is the real thing. That was
 * wrong, and it broke within the hour: the pipeline fed Snorkel's verdict back into the build
 * session, Claude redesigned the task, and four tests went red — not because the gate had
 * regressed, but because the system had done its job and fixed the very tree the tests were
 * asserting was broken.
 *
 * A test whose subject is a directory the system under test rewrites is not a test. The tree
 * is checked in here, extracted from the zip that was actually submitted and actually
 * rejected, so it can never be fixed out from under us. (The 222 KB dossier is stubbed: lint
 * never reads its contents, but the file must EXIST, because environment/ holding 6 files is
 * exactly what makes codebase_size = "small" wrong.)
 */
const REAL = join(REPO, "packages", "shared", "test", "fixtures", "rejected-submission");

/** Is ruff runnable here at all? Mirrors ruffRunner()'s search order. */
function ruffAvailable(): boolean {
  const w = spawnSync("bash", ["-lc", "command -v ruff"], { encoding: "utf8" });
  if (w.status === 0 && (w.stdout ?? "").trim()) return true;
  if (existsSync(join(homedir(), ".local", "bin", "ruff"))) return true;
  return spawnSync("python3", ["-m", "ruff", "--version"], { encoding: "utf8" }).status === 0;
}

// One lint pass over the real tree, reused by every test below. lintTask() is synchronous —
// which is the whole reason ruff is shelled out with spawnSync and not exec(). verify.ts calls
// it inline and would silently see a Promise if that ever changed.
const real = lintTask(REAL);
assert.equal(
  typeof (real as unknown as { then?: unknown }).then,
  "undefined",
  "lintTask() must stay SYNCHRONOUS — verify.ts calls it inline, not awaited",
);

const of = (rule: string, fs: Finding[] = real.findings) => fs.filter((x) => x.rule === rule);

/** A throwaway task tree. Only the files a test cares about need to exist. */
function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "lint-parity-"));
  for (const [rel, body] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body, "utf8");
  }
  return dir;
}

// ============================================================ the real submission

test("the real failing submission does NOT lint clean — the whole point", () => {
  assert.equal(
    real.clean,
    false,
    "this exact tree passed our gate and was then rejected by Snorkel; it must never lint clean again",
  );
});

// ------------------------------------------------------------------- ruff_clean

test("ruff_clean: reproduces Snorkel's 14 errors in tests/, as BLOCKING findings", { skip: ruffAvailable() ? false : "ruff not installed" }, () => {
  const hits = of("ruff_clean");
  assert.ok(hits.length > 0, "Snorkel found 14 ruff errors here; our gate found none before this rule");
  for (const h of hits) assert.equal(h.severity, "blocking", "ruff errors are a blocking CI check");

  // 14 diagnostics, capped at 15 spelled-out findings => all 14 are named individually.
  assert.equal(hits.length, 14, "E4,E7,E9,F,I over tests/ must reproduce Snorkel's number exactly");

  // The exact codes Snorkel printed: F401 x2, F541 x9, F841 x1, I001 x2.
  const codes = hits.map((h) => /\b([EFI]\d+)\b/.exec(h.message)?.[1]).filter(Boolean);
  const count = (c: string) => codes.filter((x) => x === c).length;
  assert.equal(count("F401"), 2, "F401 unused-import");
  assert.equal(count("F541"), 9, "F541 f-string-missing-placeholders");
  assert.equal(count("F841"), 1, "F841 unused variable — the playbook warns this WILL bite you");
  assert.equal(count("I001"), 2, "I001 unsorted-imports — the delta that makes 12 into Snorkel's 14");

  // Findings are file:line:col addressable, which is what makes them usable as fix prompts.
  const t = hits.find((h) => h.file.endsWith("tests/test_outputs.py"))!;
  assert.ok(t, "findings must be attributed to the file, task-relative");
  assert.match(t.message, /^\d+:\d+: [EFI]\d+ /, "message must lead with line:col CODE");
});

test("ruff_clean: a clean tests/ produces no ruff findings", { skip: ruffAvailable() ? false : "ruff not installed" }, () => {
  const dir = fixture({
    "tests/test_outputs.py": "import json\nimport os\n\n\ndef test_ok():\n    assert os.path.sep in json.dumps({\"a\": \"/\"})\n",
  });
  try {
    assert.deepEqual(of("ruff_clean", lintTask(dir).findings), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ruff_clean: an unrunnable ruff is REPORTED, never silently passed", () => {
  // THE regression test for the original bug: a gate that reports "clean" because it never ran
  // the linter. Starve the resolver of every route to ruff — empty PATH (kills `command -v`,
  // `python3 -m ruff` and the docker fallback), an empty HOME (kills ~/.local/bin/ruff, the
  // route that actually works on this machine), and a RUFF_BIN pointing at nothing — then
  // assert the gate SAYS SO instead of silently finding zero diagnostics.
  const dir = fixture({ "tests/test_outputs.py": "import os\n" });
  const emptyHome = mkdtempSync(join(tmpdir(), "lint-nohome-"));
  const saved = { bin: process.env.RUFF_BIN, path: process.env.PATH, home: process.env.HOME };
  try {
    process.env.PATH = join(dir, "no-bin-here");
    process.env.HOME = emptyHome; // os.homedir() reads $HOME on POSIX
    process.env.RUFF_BIN = join(dir, "definitely-not-ruff");

    const hits = of("ruff_clean", lintTask(dir).findings);
    assert.equal(hits.length, 1, "an unrunnable linter must produce a finding, not silence");
    assert.match(hits[0]!.message, /could not be run/i);
    assert.match(hits[0]!.message, /CANNOT certify/i, "the message must say the clean report is worthless");
  } finally {
    process.env.PATH = saved.path;
    if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
    if (saved.bin === undefined) delete process.env.RUFF_BIN; else process.env.RUFF_BIN = saved.bin;
    rmSync(dir, { recursive: true, force: true });
    rmSync(emptyHome, { recursive: true, force: true });
  }
});

test("ruff_environment_clean: environment/ Python is surfaced but NOT blocking", { skip: ruffAvailable() ? false : "ruff not installed" }, () => {
  // Snorkel did not lint environment/ in this run (it never mentioned these 2 I001 errors), so
  // blocking here would be stricter than CI and would burn fix cycles on read-only fixture code.
  const hits = of("ruff_environment_clean");
  assert.equal(hits.length, 2, "environment/app/{legacy,images}/*.py carry 2 I001 errors");
  for (const h of hits) {
    assert.equal(h.severity, "warning", "environment/ Python must never block — Snorkel did not lint it");
    assert.match(h.message, /I001/);
  }
});

// ------------------------------------------- codebase_size_matches_environment

test("codebase_size_matches_environment: catches 'small' on a 6-file environment", () => {
  const hits = of("codebase_size_matches_environment");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.severity, "blocking");
  assert.equal(hits[0]!.file, "task.toml");
  // Snorkel's exact words: "codebase_size is 'small' but environment/ has 6 files (excluding
  // Dockerfile/docker-compose), expected 'minimal'".
  assert.match(hits[0]!.message, /codebase_size is 'small'/);
  assert.match(hits[0]!.message, /environment\/ has 6 files/);
  assert.match(hits[0]!.message, /expected 'minimal'/);
});

test("codebase_size: dotfiles COUNT, Dockerfile does not, and the walk is recursive", () => {
  // The 6 only decomposes one way: 5 files under environment/app/** PLUS environment/.dockerignore,
  // with environment/Dockerfile excluded. That is the proof that dotfiles are counted.
  const base = {
    "task.toml": 'version = "2.0"\n[metadata]\ncodebase_size = "minimal"\n',
    "environment/Dockerfile": "FROM scratch\n",
    "environment/docker-compose.yml": "services: {}\n",
    "environment/.dockerignore": "**/.git\n",
    "environment/app/deep/nested/thing.txt": "x\n",
  };
  const dir = fixture(base);
  try {
    // 2 counted files (.dockerignore + the nested one) => minimal, no finding.
    assert.deepEqual(of("codebase_size_matches_environment", lintTask(dir).findings), []);

    // Same tree declared 'small' => blocked, and the count proves the exclusions applied.
    writeFileSync(join(dir, "task.toml"), 'version = "2.0"\n[metadata]\ncodebase_size = "small"\n', "utf8");
    const hits = of("codebase_size_matches_environment", lintTask(dir).findings);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.severity, "blocking");
    assert.match(hits[0]!.message, /has 2 files/, "Dockerfile and docker-compose.yml must not be counted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("codebase_size: the ambiguous band boundaries are tolerated, not guessed", () => {
  // The playbook overlaps at exactly 20 ("minimal 0-20", "small 20+"). We do not know which
  // side Snorkel puts it on, and 20 is not the case that failed — so accept both labels there
  // and be strict everywhere else.
  const files: Record<string, string> = { "environment/Dockerfile": "FROM scratch\n" };
  for (let i = 0; i < 20; i++) files[`environment/f${i}.txt`] = "x\n";

  for (const size of ["minimal", "small"]) {
    const dir = fixture({ ...files, "task.toml": `version = "2.0"\n[metadata]\ncodebase_size = "${size}"\n` });
    try {
      assert.deepEqual(
        of("codebase_size_matches_environment", lintTask(dir).findings), [],
        `n === 20 must tolerate '${size}' — the documented bands overlap there`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // 21 is unambiguous: 'minimal' is now wrong.
  const dir = fixture({
    ...files,
    "environment/f20.txt": "x\n",
    "task.toml": 'version = "2.0"\n[metadata]\ncodebase_size = "minimal"\n',
  });
  try {
    const hits = of("codebase_size_matches_environment", lintTask(dir).findings);
    assert.equal(hits.length, 1, "21 files is 'small', not 'minimal'");
    assert.match(hits[0]!.message, /expected 'small'/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------ instruction_prescribes_workflow

test("instruction_prescribes_workflow: catches the build cmd, the env var and the flagged CLI", () => {
  const hits = of("instruction_prescribes_workflow");
  assert.ok(hits.length >= 3, "instruction.md prescribes make, a flagged migrate invocation, and an env var");
  for (const h of hits) {
    assert.equal(h.severity, "warning", "heuristic — warn, do not block");
    assert.equal(h.file, "instruction.md");
  }
  const all = hits.map((h) => h.message).join("\n");
  assert.match(all, /build\/rebuild command/, "'rebuild it with make in /app'");
  assert.match(all, /environment variable assignment/, "'set MIGRATION_TIMESTAMP=2024-11-15T00:00:00Z'");
  assert.match(all, /CLI invocation with flags/, "'/app/bin/migrate --legacy ... --output ... --images ...'");
});

test("instruction_prescribes_workflow: the ACCEPTED reference instruction stays clean", () => {
  // Verbatim from prompts/summary.txt §5 — the instruction.md of a task Snorkel accepted. If
  // this ever trips the rule, the rule is wrong, not the instruction. Note it DOES name a
  // script ("run /app/run_audit.sh"): one bare deliverable-producing command, no flags, no env
  // var, no build step, no test command. That is allowed and must stay allowed.
  const dir = fixture({
    "instruction.md":
      "The OPA/Rego bundle in /app/policy is supposed to enforce our WandB model-governance rules,\n" +
      "but it's misclassifying requests. Right now it waves through GPU inference deployments that\n" +
      "were never granted capacity, and it blocks production rollbacks that should go straight\n" +
      "through during an incident. Those are just the two cases we happened to catch — the bundle\n" +
      "is meant to implement the entire governance review at /app/docs/governance_review.md (the\n" +
      "current baseline is policy v4.2), and I don't trust that the rest of it is correct either.\n\n" +
      "Go through the review and fix the policies so every action it covers gets the decision the\n" +
      "review actually specifies: model registry promotions, Launch job overrides, and artifact\n" +
      "alias operations, including how time-bound governance exceptions and their expiry are\n" +
      "evaluated. The request fixtures we've been testing against are in /app/requests.\n\n" +
      "When the policy is right, run /app/run_audit.sh to regenerate the audit report at\n" +
      "/app/out/audit_report.json and confirm it passes the Cargo-based JSON Schema validator the\n" +
      "pipeline runs. A report that is schema-valid but contains wrong decisions is not done — the\n" +
      "decisions have to match the policy in the review.\n",
  });
  try {
    assert.deepEqual(
      of("instruction_prescribes_workflow", lintTask(dir).findings), [],
      "the accepted reference instruction must not trip this rule",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------- pip_hash_locked_requirements

test("pip_hash_locked_requirements: warns on the real Dockerfile's unlocked pip install", () => {
  // Snorkel: "⚠️ Dockerfile:24: pip install with no Python lockfile ... Inline == pins only
  // freeze direct deps." pytest==8.4.1 is pinned; its transitive deps are not.
  const hits = of("pip_hash_locked_requirements");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.severity, "warning", "Snorkel raises this as a warning; mirror it");
  assert.match(hits[0]!.message, /no Python lockfile/);
  assert.match(hits[0]!.message, /--require-hashes/);
});

test("pip_hash_locked_requirements: a hash-locked requirements file satisfies it", () => {
  const ok = fixture({
    "environment/Dockerfile":
      "FROM python:3.13-slim\n" +
      "COPY requirements.lock /tmp/requirements.lock\n" +
      "RUN python3 -m pip install --no-cache-dir --require-hashes --no-deps \\\n" +
      "    -r /tmp/requirements.lock\n",
    "environment/requirements.lock":
      "pytest==8.4.1 \\\n    --hash=sha256:0000000000000000000000000000000000000000000000000000000000000000\n",
  });
  try {
    assert.deepEqual(of("pip_hash_locked_requirements", lintTask(ok).findings), []);
  } finally {
    rmSync(ok, { recursive: true, force: true });
  }

  // Same Dockerfile, but the lockfile carries no hashes: --require-hashes protects nothing.
  const unhashed = fixture({
    "environment/Dockerfile":
      "FROM python:3.13-slim\n" +
      "RUN python3 -m pip install --require-hashes --no-deps -r /tmp/requirements.lock\n",
    "environment/requirements.lock": "pytest==8.4.1\n",
  });
  try {
    const hits = of("pip_hash_locked_requirements", lintTask(unhashed).findings);
    assert.equal(hits.length, 1);
    assert.match(hits[0]!.message, /no --hash=sha256: entries/);
  } finally {
    rmSync(unhashed, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------ pinned_dependencies

test("pinned_dependencies: the real Dockerfile is pinned, so this must NOT fire on it", () => {
  // pytest==8.4.1 and pytest-json-ctrf==0.3.5. The rule was still worth adding: the gate had
  // no pinning check at all, so the NEXT unpinned dependency would have sailed through.
  assert.deepEqual(of("pinned_dependencies"), []);
});

test("pinned_dependencies: an unpinned pip/npm package is BLOCKING", () => {
  const dir = fixture({
    "environment/Dockerfile":
      "FROM python:3.13-slim\n" +
      "RUN python3 -m pip install --no-cache-dir --break-system-packages \\\n" +
      "    pytest==8.4.1 \\\n" +
      "    requests\n" +
      "RUN npm install -g typescript@5.7.2 eslint\n",
  });
  try {
    const hits = of("pinned_dependencies", lintTask(dir).findings);
    for (const h of hits) {
      assert.equal(h.severity, "blocking", "pinned_dependencies is a blocking CI check");
      assert.equal(h.file, "environment/Dockerfile");
    }
    const msgs = hits.map((h) => h.message).join("\n");
    assert.match(msgs, /pip package "requests" is not pinned/);
    assert.match(msgs, /npm package "eslint" is not pinned/);
    // The pinned ones must NOT be reported, or the finding list becomes noise nobody reads.
    assert.doesNotMatch(msgs, /pytest==8\.4\.1/);
    assert.doesNotMatch(msgs, /typescript@5\.7\.2/);
    // Continuation lines are joined first: `--break-system-packages` and `\` are not packages.
    assert.doesNotMatch(msgs, /break-system-packages|"\\\\"/);
    assert.equal(hits.length, 2, "exactly the two unpinned packages, nothing else");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pinned_dependencies: `-r requirements.txt` is pip_hash_locked_requirements' business, not ours", () => {
  const dir = fixture({
    "environment/Dockerfile": "FROM python:3.13-slim\nRUN pip install -r /tmp/requirements.txt\n",
  });
  try {
    assert.deepEqual(
      of("pinned_dependencies", lintTask(dir).findings), [],
      "a requirements file is not an unpinned package; the lockfile rule owns that case",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------- predicted_category_blocked

test("predicted_category_blocked: 'machine-learning' with no model anywhere is called out", () => {
  // Snorkel: "❌ [category_classifier] Predicted category 'software-engineering' (confidence
  // 0.95) is blocked for this project." task.toml declared machine-learning; the task is a
  // C++/SQLite migration tool. blocked_category only ever compared the DECLARED string against
  // the blocked list, so it waved this through. This is the sync backstop for that hole.
  const hits = of("predicted_category_blocked");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.file, "task.toml");
  assert.match(hits[0]!.message, /software-engineering, which is BLOCKED/);
  assert.match(hits[0]!.message, /renaming the label will not save it/);
});

test("predicted_category_blocked: a task that really does train a model is left alone", () => {
  const dir = fixture({
    "task.toml": 'version = "2.0"\n[metadata]\ncategory = "machine-learning"\ntags = ["pytorch"]\n',
    "instruction.md": "The training loop in /app/train.py diverges after the third epoch.\n",
    "environment/app/train.py": "import torch\n",
  });
  try {
    assert.deepEqual(of("predicted_category_blocked", lintTask(dir).findings), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
