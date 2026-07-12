/**
 * Regenerate prompts/summary.txt — the playbook every task build is grounded in.
 *
 *   npm run summary:build
 *   npm run summary:build -- --force     # overwrite the existing playbook
 *
 * summary.txt is a ~7,000-word distillation of the Snorkel docs, fed as PROMPT 1 to every
 * task-build session so that no build ever re-derives the rules (and drifts while doing it).
 * It is checked in and it is good — this script exists for the two cases where that isn't
 * enough:
 *
 *   1. a fresh machine that has the docs but not the playbook;
 *   2. Snorkel revises the docs, and the playbook must be refreshable without a code change.
 *
 * The generation runs as ONE Claude Agent SDK session with read-only doc access plus a single
 * write target. It writes to a STAGING file, never straight to summary.txt: a truncated
 * playbook is far worse than no change at all, because a thin playbook doesn't fail loudly —
 * it silently produces tasks that get rejected days later. So the staged output is measured
 * before it is allowed to replace anything.
 */
import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { REPO_ROOT, snorkelRoot } from "../packages/shared/src/paths.ts";
import { loadConfig } from "../apps/worker/src/config.ts";

/**
 * The docs that actually describe the task contract, listed explicitly rather than globbed:
 * documentation/ also holds sector lists, onboarding slides and recruiter emails, and feeding
 * those in dilutes the playbook with things no build ever needs.
 *
 * Paths are relative to documentation/. The names are hand-exported and carry emoji, a
 * truncation at 34 characters, and a real typo ("instruciton_guide.txt") — which is exactly
 * why matchDoc() below is fuzzy rather than an exact lookup.
 */
const SOURCE_DOCS = [
  "New Task Start Guide.txt",
  "Task Requirements.txt",
  "instruciton_guide.txt",
  "Rubric guide line.txt",
  "Milestone guide.txt",
  "snorkel_canonical_image_best_practices.md",
  "Dockerfile & Image Best Practices.txt",
  "Creating Docker Environment.txt",
  "## 🛑 Blocking Issues (must be fixe.txt",
  "WEAKNESSES DOCUMENTATION Claude Opu.txt",
  "Reviewing Tasks docs/Review Checklist.md",
  "Reviewing Tasks docs/Common Errors.md",
  "Reviewing Tasks docs/Long Context Task Checklist.md",
  "Reviewing Tasks docs/Review Guidelines.md",
];

/**
 * A playbook this much shorter than the current one is not a playbook, it's a stub. The
 * checked-in summary is ~52 KB; anything under 15 KB means the session ran out of turns or
 * bailed halfway through, and we must not let that land.
 */
const MIN_BYTES = 15_000;

/**
 * The size floor alone is a weak gate: a session that stops after section 5 but pads what it did
 * write sails past 15 KB, and the playbook lands missing the verifier and the rejection list. So
 * the staged file is also checked for all twelve `SECTION n.` markers — the shape the prompt
 * mandates, and the shape the checked-in playbook already has.
 *
 * Be clear about what this does NOT prove: a session that ignores the source docs and paraphrases
 * the old playbook produces a perfectly-shaped, perfectly-sized file. No local check can catch
 * that. Read the diff (`git diff prompts/summary.txt`) before you trust a regenerated playbook.
 */
const SECTION_COUNT = 12;

/** The mandated section numbers with no `SECTION n.` line in the staged playbook. */
function missingSections(text: string): number[] {
  const out: number[] = [];
  for (let n = 1; n <= SECTION_COUNT; n++) {
    if (!new RegExp(`^SECTION ${n}\\.`, "m").test(text)) out.push(n);
  }
  return out;
}

/** Collapse a doc name to its comparable core: no case, no extension, no spaces, no emoji. */
function normalize(p: string): string {
  return p
    .toLowerCase()
    .replace(/\.(txt|md)$/, "")
    .replace(/[^a-z0-9]/g, "");
}

/** Dice coefficient over character bigrams — 1.0 identical, ~0 unrelated. */
function similarity(a: string, b: string): number {
  const bigrams = (s: string) => {
    const out: string[] = [];
    for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
    return out;
  };
  const [ba, bb] = [bigrams(a), bigrams(b)];
  if (!ba.length || !bb.length) return a === b ? 1 : 0;
  const pool = [...bb];
  let hits = 0;
  for (const g of ba) {
    const i = pool.indexOf(g);
    if (i >= 0) {
      pool.splice(i, 1); // consume, so repeated bigrams can't be double-counted
      hits++;
    }
  }
  return (2 * hits) / (ba.length + bb.length);
}

/**
 * Find the file that IS this doc, tolerating renames.
 *
 * Exact names would be brittle in the one direction that hurts: if Snorkel ever fixes the
 * "instruciton_guide" typo, or re-exports "## 🛑 Blocking Issues (must be fixe.txt" with a
 * different truncation, an exact lookup drops the doc and the next playbook is quietly thinner.
 * Containment catches truncation and re-nesting; the similarity floor catches typo fixes.
 */
function matchDoc(wanted: string, candidates: string[]): { path: string; exact: boolean } | null {
  const w = normalize(wanted);
  let best: { path: string; score: number } | null = null;

  for (const c of candidates) {
    const n = normalize(c);
    let score: number;
    if (n === w) score = 1;
    // A moved or truncated file: one name is a prefix/substring of the other. The length floor
    // stops short stems ("Sector") from matching into a longer name by accident.
    else if (Math.min(n.length, w.length) >= 8 && (n.includes(w) || w.includes(n))) score = 0.9;
    else score = similarity(w, n);

    if (!best || score > best.score) best = { path: c, score };
  }

  if (!best || best.score < 0.75) return null;
  return { path: best.path, exact: best.score === 1 };
}

/** Every .txt/.md under documentation/, as paths relative to it. Non-docs (.pdf, .zip) can't
 *  be read by the session and would only create false matches, so they never enter the pool. */
function listDocs(root: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(resolve(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listDocs(root, rel));
    else if (/\.(txt|md)$/i.test(e.name)) out.push(rel);
  }
  return out;
}

function buildPrompt(docPaths: string[], stagePath: string, templatePath: string | null): string {
  return `You are regenerating the Terminus 2nd-Edition TASK BUILD PLAYBOOK.

This playbook is fed as the first prompt to every Claude session that builds a Snorkel task.
Those sessions read NOTHING ELSE about the rules — if a rule is not in this document, it does
not exist for them, and the task gets rejected. Completeness beats brevity everywhere.

STEP 1 — Read all of these source documents, in full:
${docPaths.map((p) => `  - ${p}`).join("\n")}
${
  templatePath
    ? `
STEP 2 — Read the CURRENT playbook at:
  ${templatePath}

Take its STRUCTURE ONLY: same 12 sections, same order, same plain-text formatting (=== rules
between sections, no markdown headers). It is a shape to fill, NOT a source. Do not copy its
content forward.

Every factual claim in what you write — every threshold, filename, field name and rule — must
come from the source documents in STEP 1. If the current playbook asserts something the docs no
longer say, DROP IT: a stale rule that survives a regeneration is the exact failure this rebuild
exists to prevent. If the docs no longer support a whole section, say so in that section rather
than back-filling it from the old text or from your own knowledge of Terminus.
`
    : `
STEP 2 — There is no existing playbook to use as a template. Build it from the section list below.
`
}
STEP 3 — Write the new playbook to EXACTLY this path (create it; do not touch any other file):
  ${stagePath}

REQUIRED SECTIONS, in this order. Each one MUST open with a line beginning exactly
"SECTION <n>." followed by its title — e.g. "SECTION 6. tests/ — THE VERIFIER" — because the
regeneration is REJECTED and thrown away if any of the ${SECTION_COUNT} markers is missing. If the
docs have gone quiet on a section, still write the section and say so in it; do not drop it.

   1. THE MANDATE — the acceptance bar. Difficulty bands, the pass-rate ceiling, the oracle
      invariant (reward == 1) and the null invariant (reward == 0).
   2. EXACT DIRECTORY STRUCTURE — the default non-milestone layout, file by file.
   3. task.toml — every field, its type, and which values are legal.
   4. environment/Dockerfile AND .dockerignore — pinned bases, what gets a Dockerfile rejected,
      what must exist in the image at runtime.
   5. instruction.md — how the prompt must sound: what to state, what to withhold, tone.
   6. tests/ — the verifier. How reward is computed and written, and the lint/ruff rules.
   7. solution/solve.sh — the oracle.
   8. HOW TO MAKE IT ACTUALLY HARD — the techniques that earn difficulty (genuine engineering
      depth), and explicitly what does NOT (piling on edge cases and fiddly requirements).
   9. REFERENCE IMPLEMENTATION — what an accepted task looks like end to end.
  10. THE REJECTION LIST — a self-audit checklist to run before declaring a task done.
  11. FALSE GREENS — the ways a task can look passing while being broken. Be blunt here.
  12. DOC CONTRADICTIONS — see below.

ADJUDICATION (this is the part that matters most):
The source docs contradict each other in places — they were written at different times by
different people. Do NOT paper over this and do NOT present both options as acceptable; a
build session cannot act on "either is fine".
  - Task Requirements.txt is AUTHORITATIVE. Where anything conflicts with it, it wins.
  - Otherwise the newer/more specific doc wins over the older/more general one.
  - Section 12 must LIST each contradiction you found, state which source said what, and give
    the single ruling the build session must follow. Every ruling must be actionable.

STYLE:
  - Plain text, not markdown. Imperative. Written AT the builder, not about the process.
  - Quote the exact strings, filenames, field names and thresholds from the docs — the build
    session pattern-matches on them.
  - Prefer a concrete rule over a principle. "Pin the base image by digest" beats "be careful
    with base images".

Target roughly 7,000 words. Write the file in one pass, then verify it is complete on disk.`;
}

const HELP = `
Regenerate prompts/summary.txt — the playbook every task build is grounded in.

  npm run summary:build              resolve the source docs and report; refuses if a playbook exists
  npm run summary:build -- --force   replace the existing playbook

--force is DESTRUCTIVE. It runs a Claude session for several minutes and atomically replaces the
document that grounds every task build. The staged output must clear a ${MIN_BYTES.toLocaleString()}-byte floor and
carry all ${SECTION_COUNT} sections or nothing is replaced — but neither check can tell a real distillation from
a re-write of the old playbook, so read the diff afterwards:  git diff prompts/summary.txt
`;

async function main() {
  // Reject unknown flags rather than ignoring them: a typo'd "--forse" would otherwise fall
  // through as a no-flag run, and on a machine with no playbook yet that silently starts a
  // multi-minute, real-money session instead of saying it did not understand the argument.
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    process.exit(0);
  }
  const unknown = args.filter((a) => a !== "--force");
  if (unknown.length) {
    console.error(`\n❌ Unknown argument: ${unknown.join(" ")}`);
    console.error(`   ↳ --force is the only flag.  npm run summary:build -- --force`);
    console.error(`     Or see:  npm run summary:build -- --help\n`);
    process.exit(2);
  }
  const force = args.includes("--force");
  const cfg = loadConfig();
  const docsRoot = cfg.paths.documentation;

  console.log("\n▸ regenerating the task-build playbook");
  console.log(`  docs       ${docsRoot}`);

  if (!existsSync(docsRoot)) {
    console.error(`\n❌ No documentation folder at ${docsRoot}`);
    console.error(
      `   ↳ SNORKEL_ROOT resolves to ${snorkelRoot()}. Set SNORKEL_ROOT in .env to the folder\n` +
        `     that contains documentation/, Working/ and Accepted/, then re-run.\n`,
    );
    process.exit(2);
  }

  // ── Resolve the source docs ────────────────────────────────────────────────
  const available = listDocs(docsRoot);
  const found: string[] = [];
  const missing: string[] = [];

  for (const wanted of SOURCE_DOCS) {
    const hit = matchDoc(wanted, available);
    if (!hit) {
      missing.push(wanted);
      continue;
    }
    found.push(resolve(docsRoot, hit.path));
    // Surface renames. A silent fuzzy match is how you end up debugging a playbook that was
    // built from a doc you didn't think it read.
    if (!hit.exact) console.log(`  ⚠️  "${wanted}" not found; using "${hit.path}"`);
  }

  if (missing.length) {
    console.log("");
    for (const m of missing) console.log(`  ⚠️  MISSING  ${m}`);
  }

  // Checked before the "generating anyway" note below: an empty docs folder is a misconfigured
  // SNORKEL_ROOT, not a thin-playbook risk, and it deserves the fix instruction instead.
  if (!found.length) {
    console.error(`\n❌ None of the ${SOURCE_DOCS.length} source docs are in ${docsRoot}. Nothing to distill.`);
    console.error(`   ↳ SNORKEL_ROOT resolves to ${snorkelRoot()}. Set it in .env to the folder that\n` +
      `     contains documentation/, Working/ and Accepted/, then re-run.\n`);
    process.exit(2);
  }

  if (missing.length) {
    console.log(
      `\n  ${missing.length} source doc(s) missing. Generating anyway, but the playbook will be\n` +
        `  thinner than the docs it is supposed to distill — check ${docsRoot} first.`,
    );
  }

  // ── Guard the existing playbook ────────────────────────────────────────────
  const target = resolve(REPO_ROOT, "prompts/summary.txt");
  const stage = resolve(REPO_ROOT, "prompts/summary.next.txt");
  const oldBytes = existsSync(target) ? statSync(target).size : 0;

  // Reported before the overwrite guard on purpose: someone who gets refused here still wants
  // to know whether their docs folder is complete, and re-running with --force to find out
  // would cost a full session.
  console.log(`  sources    ${found.length}/${SOURCE_DOCS.length} docs`);
  console.log(`  current    ${oldBytes ? `${oldBytes.toLocaleString()} bytes` : "none — first build"}`);

  if (oldBytes && !force) {
    console.error(`\n❌ ${relative(REPO_ROOT, target)} already exists (${oldBytes.toLocaleString()} bytes).`);
    console.error(`   ↳ Re-run with --force to replace it:  npm run summary:build -- --force\n`);
    process.exit(1);
  }

  console.log(`  writing    ${relative(REPO_ROOT, stage)}\n`);
  console.log("─".repeat(70));

  // Clear stage litter before generating. A killed session leaves both the stage file and the
  // Write tool's own `summary.next.txt.tmp.<pid>.<n>` scratch files behind, and anything sitting
  // in prompts/ that looks like a playbook is a trap for the next person reading this folder.
  // mkdir first: prompts/ is checked in, but on a partial checkout the sweep would otherwise die
  // on a bare ENOENT that tells the user nothing.
  const promptsDir = resolve(REPO_ROOT, "prompts");
  mkdirSync(promptsDir, { recursive: true });
  for (const f of readdirSync(promptsDir)) {
    if (f.startsWith("summary.next.txt")) rmSync(resolve(promptsDir, f), { force: true });
  }

  // ── Generate ───────────────────────────────────────────────────────────────
  const t0 = Date.now();
  let result: Awaited<ReturnType<typeof runSession>>;
  try {
    // Only a real playbook is worth handing over as a structure reference. A stub — the 0-byte
    // file left by a dead editor, or a truncated one that slipped past an older gate — would be
    // faithfully reproduced in shape, which is precisely the broken outcome this script guards.
    const template = oldBytes >= MIN_BYTES ? target : null;
    result = await runSession(found, stage, template, cfg.claude.buildTimeoutMin);
  } catch (e) {
    console.log("─".repeat(70));
    console.error(`\n❌ The Claude session failed: ${(e as Error).message}`);
    console.error(`   ↳ If this is an auth error, run \`claude login\` AS THIS OS USER — the Agent SDK\n` +
      `     uses your Claude Code subscription, not an API key.\n`);
    process.exit(1);
  }

  console.log("─".repeat(70));

  const mins = ((Date.now() - t0) / 60_000).toFixed(1);
  console.log(`turns           ${result.turns}`);
  console.log(`cost            $${result.costUsd.toFixed(4)}`);
  console.log(`took            ${mins} min`);
  console.log("─".repeat(70));

  if (!result.ok) {
    console.error(`\n❌ GENERATION FAILED (${result.subtype})\n`);
    for (const e of result.errors) console.error(`   ${e}`);
    console.error(`\n${relative(REPO_ROOT, target)} was NOT touched.\n`);
    process.exit(1);
  }

  // ── Measure before allowing it anywhere near the real file ─────────────────
  if (!existsSync(stage)) {
    console.error(`\n❌ The session reported success but never wrote ${relative(REPO_ROOT, stage)}.`);
    console.error(`   ↳ ${relative(REPO_ROOT, target)} was NOT touched.\n`);
    process.exit(1);
  }

  const newBytes = statSync(stage).size;
  const delta = oldBytes ? `${newBytes >= oldBytes ? "+" : ""}${(newBytes - oldBytes).toLocaleString()}` : "—";

  console.log(`old             ${oldBytes ? `${oldBytes.toLocaleString()} bytes` : "—"}`);
  console.log(`new             ${newBytes.toLocaleString()} bytes   (${delta})`);
  console.log("─".repeat(70));

  if (newBytes < MIN_BYTES) {
    console.error(
      `\n❌ REFUSING TO WRITE — the generated playbook is ${newBytes.toLocaleString()} bytes, under the\n` +
        `   ${MIN_BYTES.toLocaleString()}-byte floor. That means the generation was truncated, not that the docs got\n` +
        `   shorter. A thin playbook doesn't fail loudly: it silently produces tasks that get\n` +
        `   rejected days later, which is far worse than leaving the current one alone.\n`,
    );
    console.error(`   Inspect it:  ${relative(REPO_ROOT, stage)}`);
    console.error(`   ${oldBytes ? `${relative(REPO_ROOT, target)} was NOT touched.` : "No playbook was written."}\n`);
    process.exit(1);
  }

  // Structural gate. Bytes prove bulk, not completeness — this is what catches the session that
  // quit at section 7 having written plenty of words.
  const gaps = missingSections(readFileSync(stage, "utf8"));
  if (gaps.length) {
    console.error(
      `\n❌ REFUSING TO WRITE — the generated playbook has no SECTION ${gaps.join(", ")} heading.\n` +
        `   It cleared the size floor, so this is not a stub: the session wrote at length and still\n` +
        `   stopped short. A build session that never sees those sections cannot follow them.\n`,
    );
    console.error(`   Inspect it:  ${relative(REPO_ROOT, stage)}`);
    console.error(`   ${oldBytes ? `${relative(REPO_ROOT, target)} was NOT touched.` : "No playbook was written."}`);
    console.error(`   Re-run to try again:  npm run summary:build${force ? " -- --force" : ""}\n`);
    process.exit(1);
  }

  renameSync(stage, target); // same volume — atomic, so summary.txt is never half-written
  console.log(`\n✅ PLAYBOOK REGENERATED — ${relative(REPO_ROOT, target)}\n`);
  console.log(`   Distilled from ${found.length} doc(s). It is now PROMPT 1 for every task build,`);
  console.log(`   so read the diff before you trust it.\n`);
  process.exit(0);
}

interface SessionResult {
  ok: boolean;
  subtype: string;
  errors: string[];
  turns: number;
  costUsd: number;
}

async function runSession(
  docPaths: string[],
  stage: string,
  template: string | null,
  timeoutMin: number,
): Promise<SessionResult> {
  let result: SessionResult | null = null;

  // When the underlying CLI dies, the SDK throws a bare "exited with code 1" that names no
  // cause. Its stderr is the only place the real reason appears (expired auth, usage limit, a
  // rejected flag), so keep a rolling tail and hand it to the user instead of making them guess.
  const stderrTail: string[] = [];

  // Without this, a CLI that stalls hangs `npm run summary:build` forever with no output and no
  // way to tell it apart from a slow session — the same reason every turn in claude/session.ts
  // carries one. buildTimeoutMin is reused rather than adding a config key: this IS a build
  // session, and it finishes in ~8 of its 45 minutes.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMin * 60_000);

  try {
    for await (const msg of query({
      prompt: buildPrompt(docPaths, stage, template),
      options: {
        abortController: abort,
        cwd: REPO_ROOT,
        // Bypass is load-bearing, not laziness: the docs live under SNORKEL_ROOT, OUTSIDE cwd,
        // and every read of them would otherwise stop for approval in an unattended script.
        permissionMode: "bypassPermissions",
        systemPrompt: { type: "preset", preset: "claude_code" },
        // `tools` is what actually restricts the session; `allowedTools` only auto-approves, and
        // under bypassPermissions nothing prompts anyway — so an allowedTools list would have left
        // Bash/WebFetch/WebSearch sitting in the model's context, fully usable. This session reads
        // docs and writes one file. It has no business reaching git, Docker, or the network.
        tools: ["Read", "Glob", "Grep", "Write", "Edit"],
        stderr: (d) => {
          for (const line of d.split("\n")) {
            if (line.trim()) stderrTail.push(line.trimEnd());
          }
          if (stderrTail.length > 20) stderrTail.splice(0, stderrTail.length - 20);
        },
      },
    })) {
      if (msg.type === "assistant") {
        // The SDK types assistant content against @anthropic-ai/sdk, which isn't a direct
        // dependency, so the blocks arrive untyped. We only need the tool name for the trace.
        const blocks = (msg.message.content ?? []) as Array<{ type?: string; name?: string; input?: unknown }>;
        for (const b of blocks) {
          if (b.type !== "tool_use") continue;
          const file = (b.input as { file_path?: string } | undefined)?.file_path;
          console.log(`  · ${(b.name ?? "tool").padEnd(6)} ${file ? relative(REPO_ROOT, file) : ""}`);
        }
      }

      if (msg.type === "result") {
        result = {
          ok: msg.subtype === "success",
          subtype: msg.subtype,
          // Only the failure variants carry `errors`; success narrows it away.
          errors: msg.subtype === "success" ? [] : msg.errors,
          turns: msg.num_turns,
          costUsd: msg.total_cost_usd,
        };
      }
    }
  } catch (e) {
    const tail = stderrTail.join("\n").trim();
    // An abort surfaces as a generic stream error, so name the real cause before it reaches the
    // handler in main() and gets reported as an auth problem.
    const cause = abort.signal.aborted
      ? `no result after ${timeoutMin} minutes — the session is stalled, not slow.`
      : (e as Error).message;
    throw new Error(
      cause +
        (tail ? `\n\n   The CLI's own stderr, which is where the real reason is:\n${tail.replace(/^/gm, "   │ ")}` : ""),
    );
  } finally {
    clearTimeout(timer); // else the process lingers until the timeout fires, long after we're done
  }

  // No result message means the transport died mid-stream — treat it as a hard failure rather
  // than falling through to "the file wasn't written", which would blame the wrong thing.
  if (!result) throw new Error("the SDK stream ended without a result message");
  return result;
}

main().catch((e) => {
  console.error(`\n💥 ${(e as Error).message}\n`);
  process.exit(1);
});
