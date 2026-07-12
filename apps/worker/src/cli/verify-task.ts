/**
 * Run the verify gate against a task tree or an existing .zip, standalone.
 *
 *   npm run verify:task -- "../Working/automate-c-graphviz-worker-stained-glass-vault.zip"
 *   npm run verify:task -- "workspace/some-slug"
 *
 * Point this at a KNOWN-GOOD task first. If the gate can't grade a task that is already
 * accepted, the gate is broken — not the task. That's the whole reason this CLI exists
 * before any Claude session has ever run.
 */
import { mkdtempSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";
import { extractZip } from "../util/unzip.ts";
import { verifyTask } from "../stages/verify.ts";
import { formatFindings } from "../stages/lint.ts";
import { loadConfig } from "../config.ts";

const cfg = loadConfig();

function unzipTo(zipPath: string): string {
  const dir = mkdtempSync(join(tmpdir(), "tb-verify-"));
  extractZip(zipPath, dir);
  return dir;
}

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error("usage: npm run verify:task -- <task-dir|task.zip>");
    process.exit(2);
  }
  if (!existsSync(target)) {
    console.error(`No such path: ${target}`);
    process.exit(2);
  }

  const isZip = target.toLowerCase().endsWith(".zip");
  const taskDir = isZip ? unzipTo(resolve(target)) : resolve(target);
  const slug = basename(target).replace(/\.zip$/i, "");

  console.log(`\n▸ verifying  ${slug}`);
  console.log(`  task dir   ${taskDir}\n`);

  const runDir = resolve(cfg.paths.runs, slug, "verify-cli");
  mkdirSync(runDir, { recursive: true });

  const t0 = Date.now();
  const r = await verifyTask({
    taskDir,
    slug,
    runDir,
    cpus: cfg.docker.cpus,
    memoryMb: cfg.docker.memoryMb,
    buildTimeoutSec: cfg.docker.buildTimeoutSec,
    solveTimeoutSec: cfg.docker.solveTimeoutSec,
    testTimeoutSec: cfg.docker.testTimeoutSec,
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(0);

  console.log("─".repeat(70));
  console.log(`lint            ${r.lint.clean ? "clean" : `${r.lint.findings.filter((f) => f.severity === "blocking").length} blocking`}`);
  console.log(`oracle reward   ${r.oracleReward ?? "—"}   (must be 1)`);
  console.log(`null   reward   ${r.nullReward ?? "—"}   (must be 0)`);
  console.log(`logs            ${r.logsDir}`);
  console.log(`took            ${secs}s`);
  console.log("─".repeat(70));

  if (r.lint.findings.length) console.log("\n" + formatFindings(r.lint.findings));

  if (r.passed) {
    console.log("\n✅ GATE PASSED — oracle solves it, and the tests correctly fail without the solution.\n");
    process.exit(0);
  }

  console.log("\n❌ GATE FAILED\n");
  console.log(r.failureReport);
  console.log("\n(This is verbatim what gets handed back to the task's Claude session as the fix prompt.)\n");
  process.exit(1);
}

main().catch((e) => {
  console.error(`\n💥 ${e.message}\n`);
  process.exit(1);
});
