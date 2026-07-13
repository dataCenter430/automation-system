/**
 * The taxonomy: Snorkel's DISPLAY labels -> task.toml's closed enum vocabularies.
 *
 * A wrong enum here is a blocking CI failure at Snorkel, and a wrong CATEGORY is a rejection —
 * so every one of these resolves at PASTE time, in front of a human, rather than 45 minutes into
 * a build.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

// =============================================================================================
// THE BUG THE OPERATOR HIT, and the whole class it belongs to.
// =============================================================================================

test("Snorkel's DISPLAY labels resolve — '&' and 'and' are the same word", async () => {
  const { toTaskToml } = await import("../src/taxonomy.ts");

  // The exact blob that failed: "Security & Cryptography/DB Interaction".
  const r = toTaskToml({
    category: "Security & Cryptography",
    sub_category: "DB Interaction",
    languages: "Lua, JavaScript",
  });
  assert.equal(r.category, "security");
  assert.deepEqual(r.subcategories, ["db_interaction"]);
  assert.deepEqual(r.languages, ["lua", "javascript"]);

  // Every spelling of the same label must fold to one thing. The old lookup only lowercased, so
  // each ampersand needed a duplicate key and the first label nobody had thought of threw.
  for (const label of [
    "Security & Cryptography",
    "security and cryptography",
    "SECURITY  &  CRYPTOGRAPHY",
    "Security &Cryptography",
  ]) {
    assert.equal(
      toTaskToml({ category: label, sub_category: "", languages: "" }).category,
      "security",
      label,
    );
  }
});

test("a BLOCKED label still refuses — and says WHY, not 'unknown category'", async () => {
  const { toTaskToml, TaxonomyError } = await import("../src/taxonomy.ts");

  // These are mapped ON PURPOSE rather than omitted. If "Data Processing" were simply missing from
  // the table, a paste would fail with "unknown category" — a confusing error that invites someone
  // to "fix" it by adding a mapping, which is the one thing they must not do. Mapping it means the
  // refusal is precise and names the real reason.
  for (const [label, resolved] of [
    ["Data Processing", "data-processing"],
    ["Software Engineering", "software-engineering"],
    ["Debugging", "debugging"],
  ] as const) {
    assert.throws(
      () => toTaskToml({ category: label, sub_category: "", languages: "" }),
      (e: Error) => {
        assert.ok(e instanceof TaxonomyError);
        assert.match(e.message, new RegExp(`resolves to "${resolved}"`));
        assert.match(e.message, /NOT currently accepting/);
        return true;
      },
      label,
    );
  }
});

test("$allowed holds task.toml ENUMS only — never a display label", async () => {
  // The bug that made the error message contradict itself. Someone hit "unknown category
  // 'Security & Cryptography'", and fixed it by pasting that LABEL into $allowed — which is the
  // list of legal task.toml VALUES. The error then read:
  //
  //     Unknown category "Security & Cryptography" ... (allowed values: ..., Security & Cryptography)
  //
  // Unknown, and listed as allowed. A label in here is always a bug.
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const { REPO_ROOT } = await import("../src/paths.ts");

  const t = JSON.parse(readFileSync(resolve(REPO_ROOT, "config/taxonomy.json"), "utf8"));
  for (const v of t.category.$allowed as string[]) {
    assert.match(v, /^[a-z][a-z-]*$/, `"${v}" is a display label, not a task.toml enum value`);
  }
  for (const v of t.subcategory.$allowed as string[]) {
    assert.match(v, /^[a-z][a-z_]*$/, `"${v}" is a display label, not a task.toml enum value`);
  }
});
