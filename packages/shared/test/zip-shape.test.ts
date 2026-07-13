/**
 * The zip is the deliverable. Nothing else in the system looks at it.
 *
 * The gate verifies the WORKSPACE and we ship the ZIP, and until this test existed nothing
 * asserted those were the same thing. Twice in one hour, the gate said VERIFIED while the
 * artefact was wrong:
 *
 *   1. We hardened the gate to run ruff, so Claude ran `ruff check` on its own work, so ruff
 *      wrote a .ruff_cache/, so the zip shipped 15 linter cache files to Snorkel.
 *   2. Claude zipped the tree to inspect what it was about to submit — leaving a 93 KB copy of
 *      the submission INSIDE the submission.
 *
 * Both were invisible to a gate that only ever looked at the directory.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipTask } from "../../../apps/worker/src/stages/zip.ts";
import { lintTask } from "../../../apps/worker/src/stages/lint.ts";

/** A minimal but structurally complete task tree, plus whatever junk a test wants to add. */
function tree(extra: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "zip-shape-"));
  const files: Record<string, string> = {
    "task.toml": 'version = "2.0"\n[metadata]\ncategory = "machine-learning"\n',
    "instruction.md": "Build the thing.\n",
    "environment/Dockerfile": "FROM scratch\n",
    "environment/.dockerignore": "**/.git\n",
    "solution/solve.sh": "#!/bin/bash\necho ok\n",
    "tests/test.sh": "#!/bin/bash\npytest -rA\n",
    "tests/test_outputs.py": "def test_x():\n    assert True\n",
    ...extra,
  };
  for (const [rel, body] of Object.entries(files)) {
    const p = join(dir, ...rel.split("/"));
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, body, "utf8");
  }
  return dir;
}

async function entriesOf(dir: string): Promise<string[]> {
  const out = join(tmpdir(), `shape-${Math.abs(dir.length * 7919)}.zip`);
  const r = await zipTask(dir, out);
  rmSync(out, { force: true });
  return r.entries;
}

test("a clean tree zips to exactly the task", async () => {
  const dir = tree();
  try {
    const e = await entriesOf(dir);
    assert.deepEqual(
      [...e].sort(),
      [
        "environment/.dockerignore",
        "environment/Dockerfile",
        "instruction.md",
        "solution/solve.sh",
        "task.toml",
        "tests/test.sh",
        "tests/test_outputs.py",
      ].sort(),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a linter cache never reaches the zip", async () => {
  // Bug 1, verbatim: we told the gate to run ruff, so Claude ran ruff, so ruff left a cache.
  const dir = tree({
    ".ruff_cache/0.14.5/11630421158921577170": "x",
    ".ruff_cache/.gitignore": "*",
    ".pytest_cache/CACHEDIR.TAG": "x",
    ".mypy_cache/x.json": "{}",
    "tests/__pycache__/test_outputs.cpython-311.pyc": "x",
  });
  try {
    const e = await entriesOf(dir);
    const junk = e.filter((f) => /(^|\/)(\.\w|__pycache__)/.test(f) && !f.endsWith(".dockerignore"));
    assert.deepEqual(junk, [], `these must never ship: ${junk.join(", ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the zip never contains a zip — or any other build scratch at the root", async () => {
  // Bug 2, verbatim: Claude zipped the tree to inspect what it was about to submit.
  const dir = tree({
    "migrate-imagemagick-textile-features.zip": "PKfake",
    "notes.md": "scratch",
    "check.sh": "#!/bin/bash\n",
    "scratch/whatever.txt": "x",
  });
  try {
    const e = await entriesOf(dir);
    for (const bad of ["migrate-imagemagick-textile-features.zip", "notes.md", "check.sh"]) {
      assert.equal(e.includes(bad), false, `${bad} must not be in the submission`);
    }
    assert.equal(e.some((f) => f.startsWith("scratch/")), false, "scratch/ must not ship");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the GATE blocks build scratch too, so the tree and the zip stay the same thing", () => {
  // zip.ts dropping it is not enough. If the gate verifies a tree that differs from the
  // artefact, the gate is describing something we did not ship.
  const dir = tree({ "migrate-imagemagick.zip": "PK", "notes.md": "x" });
  try {
    const r = lintTask(dir);
    const hits = r.findings.filter((f) => f.rule === "unexpected_root_entry");
    assert.equal(hits.length, 2, "both the stray zip and the notes file must be flagged");
    for (const h of hits) assert.equal(h.severity, "blocking");
    assert.equal(r.clean, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a cache inside environment/ is BLOCKING — it would be baked into the image", () => {
  const dir = tree({ "environment/.ruff_cache/x": "x" });
  try {
    const hits = lintTask(dir).findings.filter((f) => f.rule === "no_tool_caches");
    assert.equal(hits.length, 1);
    assert.equal(
      hits[0]!.severity,
      "blocking",
      "environment/ IS the Docker build context — a cache there ships inside the image",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("environment/.dockerignore survives — it is a dot FILE, not a dot directory", async () => {
  // The whole subtlety of excluding dot-entries: .dockerignore is required, and dropping it
  // would silently break the build context rules Snorkel checks.
  const dir = tree();
  try {
    const e = await entriesOf(dir);
    assert.equal(e.includes("environment/.dockerignore"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
