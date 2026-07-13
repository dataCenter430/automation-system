import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTaskBlob, ParseError } from "../src/parse-task-blob.ts";
import { toTaskToml, TaxonomyError } from "../src/taxonomy.ts";
import { slugify } from "../src/slug.ts";

/** The exact blob format pasted into the task-config page. */
const REAL_BLOB = `---
Interactive Challenges & Games/Long Context, DB Interaction

Automate C Graphviz Worker for Stained-Glass Vault Replays

The vault referee stalls whenever a stained-glass replay requires the old handbook-only adjudication path. Implement a C background worker that reads queued puzzle sessions from an SQLite database, applies the 50k+ token moderator manual's movement, color, and tie-break rules, and writes both the chosen replay moves and a Graphviz DOT decision graph. Verification runs the supplied referee CLI against fixed image fixtures and compares its terminal output snapshots and generated DOT summaries to golden files.

C
SQL
POSIX shell
Additional Inspiration
A small C project skeleton with a Makefile, SQLite connection helpers, a stubbed \`vault_worker.c\`, and an offline \`referee\` verification binary that seeds replay jobs and checks generated artifacts.
---`;

test("parses the real task blob into all six fields", () => {
  const p = parseTaskBlob(REAL_BLOB);

  assert.equal(p.category, "Interactive Challenges & Games");
  assert.equal(p.sub_category, "Long Context, DB Interaction");
  assert.equal(p.title, "Automate C Graphviz Worker for Stained-Glass Vault Replays");
  assert.equal(p.languages, "C, SQL, POSIX shell");

  assert.match(p.description, /^The vault referee stalls/);
  assert.match(p.description, /golden files\.$/);
  // The description must NOT swallow the language lines or the inspiration tail.
  assert.doesNotMatch(p.description, /POSIX shell/);
  assert.doesNotMatch(p.description, /Additional Inspiration/);

  assert.ok(p.additional_note);
  assert.match(p.additional_note!, /^A small C project skeleton/);
  assert.match(p.additional_note!, /checks generated artifacts\.$/);
});

test("keeps a multi-paragraph description intact", () => {
  // This is the case that breaks a naive "block[2] is the description" parser.
  const blob = `Debugging/Long Context

Fix The Thing

First paragraph of the description.

Second paragraph, still description.

Third paragraph too.

Python
Bash
Additional Inspiration
Some notes.`;

  const p = parseTaskBlob(blob);
  assert.equal(p.title, "Fix The Thing");
  assert.equal(p.languages, "Python, Bash");
  assert.equal(
    p.description,
    "First paragraph of the description.\n\nSecond paragraph, still description.\n\nThird paragraph too.",
  );
  assert.equal(p.additional_note, "Some notes.");
});

test("handles a blob with no Additional Inspiration section", () => {
  const blob = `Security/Tool Specific

Harden The Gate

A description that stands alone.

Go`;

  const p = parseTaskBlob(blob);
  assert.equal(p.additional_note, null);
  assert.equal(p.languages, "Go");
  assert.equal(p.description, "A description that stands alone.");
});

test("splits category on the FIRST slash only", () => {
  const p = parseTaskBlob(`Data Processing/API Integration, DB Interaction

T

D

SQL`);
  assert.equal(p.category, "Data Processing");
  assert.equal(p.sub_category, "API Integration, DB Interaction");
});

test("CRLF input parses the same as LF", () => {
  const p = parseTaskBlob(REAL_BLOB.replace(/\n/g, "\r\n"));
  assert.equal(p.title, "Automate C Graphviz Worker for Stained-Glass Vault Replays");
  assert.equal(p.languages, "C, SQL, POSIX shell");
});

test("throws a diagnostic ParseError when the blob is malformed", () => {
  assert.throws(() => parseTaskBlob("just one line"), ParseError);
  assert.throws(
    () => parseTaskBlob("No slash here\n\nTitle\n\nDesc\n\nC"),
    /must be "Category\/Sub-category"/,
  );
});

test("maps the blob's human labels onto task.toml enum values", () => {
  const p = parseTaskBlob(REAL_BLOB);
  const t = toTaskToml(p);

  assert.equal(t.category, "games");
  assert.deepEqual(t.subcategories, ["long_context", "db_interaction"]);
  // "POSIX shell" must normalize to bash, and nothing may silently pass through.
  assert.deepEqual(t.languages, ["c", "sql", "bash"]);
});

test("an unknown label passes THROUGH with a warning — it is not an error", () => {
  // THIS TEST USED TO ASSERT THE OPPOSITE, and the old reasoning was: "an invalid enum in task.toml
  // fails Snorkel's CI, so stop here, where a human is looking."
  //
  // That was wrong, and it cost two good tasks in one day. "Security & Cryptography" and "HCL" are
  // both perfectly valid, and both were refused at the paste box by OUR lookup table — not by
  // anything Snorkel requires. `languages` is FREE-FORM in task.toml; there was never anything to
  // validate it against. Snorkel adds languages and categories whenever it likes, and a closed
  // table on our side is a promise we cannot keep.
  //
  // So an unknown label is slugified, passed through, and WARNED about. If the guess is wrong,
  // Snorkel's validate_task_fields says so — and that check is actually authoritative, unlike ours.
  const r = toTaskToml({ category: "Underwater Basket Weaving", sub_category: "Long Context", languages: "C" });
  assert.equal(r.category, "underwater-basket-weaving");
  assert.deepEqual(r.subcategories, ["long_context"]);
  assert.deepEqual(r.languages, ["c"]);
  assert.equal(r.warnings.length, 1, "the human must SEE that we guessed");
});

test("...but a BLOCKED category is still refused, and that refusal is the point", () => {
  // The one thing that still throws. Not vocabulary validation — this is the guard that caught two
  // of our three rejections (software-engineering 0.95, data-processing 0.90), and it must fire at
  // the paste box, before a 45-minute build is spent on a task Snorkel will reject outright.
  assert.throws(
    () => toTaskToml({ category: "Software Engineering", sub_category: "Long Context", languages: "C" }),
    (e: Error) => {
      assert.ok(e instanceof TaxonomyError);
      assert.match(e.message, /NOT currently accepting/);
      return true;
    },
  );
});

test("derives the zip/workspace slug the way the existing builds are named", () => {
  assert.equal(
    slugify("Automate C Graphviz Worker for Stained-Glass Vault Replays"),
    "automate-c-graphviz-worker-stained-glass-vault",
  );
  assert.equal(slugify("Harden Go MLflow Build Locks"), "harden-go-mlflow-build-locks");
  assert.equal(slugify("Audit WandB Promotion Policies"), "audit-wandb-promotion-policies");
});
