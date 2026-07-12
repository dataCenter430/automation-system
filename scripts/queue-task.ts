import "dotenv/config";
import { parseTaskBlob } from "../packages/shared/src/parse-task-blob.ts";
import { toTaskToml } from "../packages/shared/src/taxonomy.ts";
import { slugify } from "../packages/shared/src/slug.ts";
import { db } from "../packages/shared/src/supabase.ts";
import { PipelineState, TaskStatus } from "../packages/shared/src/status.ts";
import { randomUUID } from "node:crypto";

const BLOB = `Machine Learning & AI/Long Context, Tool Specific

Migrate ImageMagick Textile Features with C++ SQLite Checksums

A reproducible C++ SQLite migration should be the end state for the legacy textile-defect classifier feature store. The provided 60k-token mill handoff dossier describes how ImageMagick measurements from loom-frame PNGs must be normalized, which obsolete rows must be retired, and how model-threshold provenance is represented in the new schema. The migration converts the seeded legacy SQL database into the v3 schema, recomputes deterministic image features with ImageMagick, and emits checksum files that match the verifier's canonical database dump.

C++
SQL
Bash`;

const parsed = parseTaskBlob(BLOB);
const toml = toTaskToml(parsed);
const slug = slugify(parsed.title);
const task_id = randomUUID();

// Clear the earlier throwaway test row so the queue shows only this run.
await db().from("terminus").delete().eq("task_id", "a5de5c52-a2ed-412d-b8a4-744b794b1796");

const { error } = await db().from("terminus").insert({
  task_id, slug, ...parsed,
  task_status: TaskStatus.WORKING_ON,
  payment_status: 0,
  pipeline_state: PipelineState.QUEUED,   // == what the "Start Build" button does
  task_owner: "Pug",
});
if (error) { console.error(error.message); process.exit(1); }

console.log("queued for build");
console.log("  task_id  :", task_id);
console.log("  slug     :", slug);
console.log("  category :", parsed.category, "->", toml.category);
console.log("  langs    :", toml.languages.join(", "));
