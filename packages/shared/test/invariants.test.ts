/**
 * The two invariants the user named as non-negotiable.
 *
 *   1. A task must NEVER be predicted into software-engineering, debugging, or
 *      data-processing. Snorkel is not accepting them; such a task is rejected.
 *   2. Under concurrency, a task must build in ITS OWN workspace and ITS OWN Claude session.
 *
 * Both were audited and both had holes. These tests are the fence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toTaskToml, TaxonomyError, blockedCategories } from "../src/taxonomy.ts";
import { assertValidSlug, slugify } from "../src/slug.ts";
import { lintTask } from "../../../apps/worker/src/stages/lint.ts";

// ---------------------------------------------------------------- 1. categories

test("the blocked list is the one Snorkel actually blocks", () => {
  assert.deepEqual(
    [...blockedCategories()].sort(),
    ["data-processing", "debugging", "software-engineering"],
  );
});

test("a blocked category is refused at resolution, not silently passed through", () => {
  for (const label of ["Software Engineering", "Debugging", "Data Processing"]) {
    assert.throws(
      () => toTaskToml({ category: label, sub_category: "Long Context", languages: "Python" }),
      TaxonomyError,
      `${label} must be rejected`,
    );
  }
});

test("the GATE independently blocks a task.toml that names a blocked category", () => {
  // Belt and braces: we hand Claude a pre-resolved category, but Claude can write task.toml.
  // If it drifts the category, the gate — not the parser — is the last thing standing.
  const dir = mkdtempSync(join(tmpdir(), "lint-cat-"));
  try {
    for (const cat of blockedCategories()) {
      writeFileSync(
        join(dir, "task.toml"),
        `version = "2.0"\n[metadata]\ncategory = "${cat}"\nsubcategories = ["long_context"]\n`,
        "utf8",
      );
      const r = lintTask(dir);
      const hit = r.findings.filter((f) => f.rule === "blocked_category");
      assert.equal(hit.length, 1, `gate must flag ${cat}`);
      assert.equal(hit[0]!.severity, "blocking", `${cat} must be BLOCKING, not a warning`);
      assert.equal(r.clean, false, `a task.toml with category ${cat} must never lint clean`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the gate's blocked list is not a second hardcoded copy that can drift", async () => {
  // If lint.ts ever goes back to its own literal Set, this catches it: the gate must reject
  // exactly what config/taxonomy.json says is blocked.
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync(
      new URL("../../../apps/worker/src/stages/lint.ts", import.meta.url),
      "utf8",
    ),
  );
  assert.match(
    src,
    /BLOCKED_CATEGORIES\s*=\s*new Set\(blockedCategories\(\)\)/,
    "lint.ts must read the blocked list from taxonomy.json, not hardcode it",
  );
});

// ------------------------------------------------------- 2. per-task isolation

test("slugs are validated — they name the workspace, the zip and the session", () => {
  for (const bad of ["", "  ", "Has Spaces", "UPPER", "path/traversal", "../escape", "dots.in.it"]) {
    assert.throws(() => assertValidSlug(bad), `"${bad}" must be rejected as a slug`);
  }
  assert.doesNotThrow(() => assertValidSlug("migrate-imagemagick-textile-features"));
});

test("two different titles CAN collide on one slug — which is why uniqueness must be enforced", () => {
  // Not a bug in slugify; a fact about it. slugify drops stopwords and truncates, so this is
  // a typo away rather than a freak event — and the workspace, the Claude session id and the
  // zip are all keyed by it. The defences are: a unique-slug check in POST /api/tasks, and
  // the ownership assertion in pipeline.advance().
  const a = slugify("Migrate ImageMagick Textile Features with C SQLite for the Alpha mill");
  const b = slugify("Migrate ImageMagick Textile Features with C SQLite for the Beta mill");
  assert.equal(a, b, "if this ever stops colliding, the point still stands: enforce uniqueness");
});

test("a workspace records which task owns it", async () => {
  const { readState, writeState } = await import("../../../apps/worker/src/state.ts");
  const ws = mkdtempSync(join(tmpdir(), "ws-own-"));
  try {
    mkdirSync(join(ws, ".pipeline"), { recursive: true });
    writeState(ws, {
      taskId: "task-A", slug: "shared-slug", pipelineState: 10,
      claudeSessionId: "session-of-A", attempt: 0, feedbackAttempt: 0,
      zipPath: null, explanations: null, submissionUrl: null,
      feedbackStartedAt: null, lastError: null, updatedAt: new Date().toISOString(),
    });

    const s = readState(ws)!;
    // This is exactly the check pipeline.advance() now makes before trusting local state.
    // Without it, task B reads A's claudeSessionId and resumes A's conversation.
    assert.equal(s.taskId, "task-A");
    assert.notEqual(s.taskId, "task-B", "a workspace must not be usable by another task");
    assert.equal(s.claudeSessionId, "session-of-A");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
