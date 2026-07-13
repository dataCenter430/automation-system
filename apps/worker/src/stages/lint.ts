/**
 * Static checks on a built task tree. Runs in ~200ms, before Docker.
 *
 * These are ports of the blocking CI checks in documentation\Task Requirements.txt and
 * the reviewer send-backs in Reviewing Tasks docs\Review Checklist.md. Every one of them
 * would otherwise be discovered either six minutes into a Docker build or, worse, by a
 * human reviewer a day later. They also make excellent fix prompts: a lint finding names
 * exactly one rule and exactly one file.
 */
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join, relative, sep, basename, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { parse as parseToml } from "smol-toml";
import { unchangedFromSkeleton } from "./skeleton.ts";
import { blockedCategories } from "../../../../packages/shared/src/taxonomy.ts";

export type Severity = "blocking" | "warning";

export interface Finding {
  rule: string;
  severity: Severity;
  file: string;
  message: string;
}

export interface LintResult {
  findings: Finding[];
  clean: boolean; // no blocking findings
}

const REQUIRED_FILES = [
  "task.toml",
  "instruction.md",
  "environment/Dockerfile",
  "solution/solve.sh",
  "tests/test.sh",
  "tests/test_outputs.py",
];

const CATEGORIES = new Set([
  "system-administration", "build-and-dependency-management", "data-processing",
  "games", "software-engineering", "machine-learning", "debugging", "security",
  "scientific-computing",
]);

/**
 * Snorkel is not currently accepting tasks in these categories.
 *
 * This is checked here, against the task.toml Claude actually wrote, and not only at parse
 * time. Parse-time rejection stops a blocked task from being queued; this stops a task from
 * DRIFTING into a blocked category during the build. Without it, Claude could quietly write
 * `category = "debugging"` and every downstream check would wave it through.
 */
// Read from config/taxonomy.json, NOT a second hardcoded copy. Two lists of the same thing
// drift, and the one that drifts silently here is the gate — the last check standing between
// a blocked category and a submitted zip.
const BLOCKED_CATEGORIES = new Set(blockedCategories());
const SUBCATEGORIES = new Set([
  "long_context", "tool_specific", "api_integration", "db_interaction", "ui_building",
]);
const CODEBASE_SIZES = new Set(["minimal", "small", "large"]);
const DIFFICULTIES = new Set(["easy", "medium", "hard", "unknown"]);

const MAX_ENV_BYTES = 100 * 1024 * 1024; // 100 MiB build context
const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MiB per file

/** Files whose CRLF line endings will break them inside a Linux container. */
const LF_REQUIRED = /\.(sh|py)$|(^|[\\/])Dockerfile$/i;

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// ===========================================================================
// ruff — the linter Snorkel's CI actually runs on our Python
// ===========================================================================
//
// Snorkel's CI printed: "❌ tests: ruff found 14 error(s)" — F401 x2, F541 x9, F841 x1 and
// I001 x2, all in tests/test_outputs.py and tests/oracle.py. Our gate ran NO linter at all
// and reported "lint clean". That is the bug this rule exists to fix.
//
// The rule set is not a guess. Reproduced locally against the failing task with ruff 0.14.5:
//   ruff check --isolated --select E4,E7,E9,F   tests/  -> 12  (F401 x2, F541 x9, F841 x1)
//   ruff check --isolated --select E4,E7,E9,F,I tests/  -> 14  (+ I001 x2)   <- Snorkel's 14
//   adding E501 would give 17, so pycodestyle-full is NOT in their set.
// So Snorkel is running ruff defaults + isort. E4,E7,E9,F,I reproduces their number exactly,
// down to the line:col of the first five diagnostics they printed (10:8, 12:8, 199:9, 200:9,
// 201:9).
const RUFF_SELECT = "E4,E7,E9,F,I";

/** How many ruff diagnostics we spell out before collapsing the rest into one summary line. */
const RUFF_FINDING_CAP = 15;

interface RuffDiag {
  code: string | null;
  message: string;
  filename: string;
  location: { row: number; column: number };
}

/**
 * How to invoke ruff on this machine, or null if there is no way to.
 *
 * ruff is installed by `pip install --user` / `uv tool install`, which lands it at
 * ~/.local/bin/ruff — a directory that is on an interactive shell's PATH but very often NOT
 * on the PATH of a spawned worker process. So PATH alone is not enough: probe PATH, then the
 * known install locations, then `python3 -m ruff`.
 */
function ruffRunner(): { cmd: string; pre: string[] } | null {
  const onPath = spawnSync("bash", ["-lc", "command -v ruff"], { encoding: "utf8" });
  const fromPath = (onPath.stdout ?? "").trim();

  const cands = [
    process.env.RUFF_BIN,
    onPath.status === 0 && fromPath ? fromPath : undefined,
    join(homedir(), ".local", "bin", "ruff"),
    "/usr/local/bin/ruff",
    "/usr/bin/ruff",
  ].filter(Boolean) as string[];

  for (const c of cands) if (existsSync(c)) return { cmd: c, pre: [] };

  // Last resort before docker: ruff shipped as a Python module.
  const mod = spawnSync("python3", ["-m", "ruff", "--version"], { encoding: "utf8" });
  if (mod.status === 0) return { cmd: "python3", pre: ["-m", "ruff"] };

  return null;
}

/**
 * Run ruff over `targets` (relative to taskDir). Returns the diagnostics, or "unavailable"
 * if ruff could not be executed at all — never an empty array on failure. A gate that
 * silently reports "clean" because it could not find its linter is exactly the failure mode
 * that let 14 ruff errors reach Snorkel.
 *
 * --isolated is load-bearing: without it a stray pyproject.toml / ruff.toml ANYWHERE up the
 * directory tree (this repo has a .ruff_cache at its root) can silently disable rules and
 * hand us a false green that CI will not reproduce.
 */
function runRuff(taskDir: string, targets: string[]): RuffDiag[] | "unavailable" {
  if (targets.length === 0) return [];
  const args = [
    "check", "--isolated", "--no-cache",
    "--select", RUFF_SELECT,
    "--output-format", "json",
    ...targets,
  ];

  const runner = ruffRunner();
  let r = runner
    ? spawnSync(runner.cmd, [...runner.pre, ...args], { cwd: taskDir, encoding: "utf8", timeout: 60_000 })
    : null;

  if (!r || r.error || r.status === null) {
    // Docker fallback, pinned to the exact ruff we validated against. An unpinned image would
    // let the local gate and CI drift apart on a new rule release, which is the same class of
    // bug as not running the linter at all.
    r = spawnSync(
      "docker",
      ["run", "--rm", "-v", `${taskDir}:/io:ro`, "-w", "/io", "ghcr.io/astral-sh/ruff:0.14.5", ...args],
      { encoding: "utf8", timeout: 180_000 },
    );
    if (r.error || r.status === null) return "unavailable";
  }

  // 0 = clean, 1 = violations found, 2 = ruff itself errored (bad args, unparseable config).
  if (r.status !== 0 && r.status !== 1) return "unavailable";
  try {
    return JSON.parse(r.stdout || "[]") as RuffDiag[];
  } catch {
    return "unavailable";
  }
}

/** ruff reports absolute paths (and /io/... under the docker fallback). Make them task-relative. */
function ruffRel(taskDir: string, filename: string): string {
  let p = filename;
  if (p.startsWith("/io/")) p = p.slice(4);
  if (isAbsolute(p)) p = relative(taskDir, p);
  return p.split(sep).join("/");
}

/**
 * Files that do NOT count toward codebase_size.
 *
 * Snorkel counted 6 files in an environment/ that contains 7. The one it left out is the
 * Dockerfile — the build recipe is not part of the codebase the agent works with.
 */
const COUNT_EXCLUDE = /^(Dockerfile(\..+)?|docker-compose.*\.ya?ml|compose\.ya?ml)$/i;

/** Evidence that a task declared machine-learning actually has anything to do with ML. */
const ML_EVIDENCE = /torch|tensorflow|sklearn|scikit|keras|xgboost|\.ipynb|\btrain(ing)?\b|inference|\bmodel\b|\bdataset\b/i;

export function lintTask(taskDir: string): LintResult {
  const f: Finding[] = [];
  const add = (rule: string, severity: Severity, file: string, message: string) =>
    f.push({ rule, severity, file, message });

  // ---- required files ------------------------------------------------------
  for (const rf of REQUIRED_FILES) {
    if (!existsSync(join(taskDir, rf))) {
      add("required_files", "blocking", rf, `Missing required file: ${rf}`);
    }
  }

  // ---- the tree must not still be the skeleton -----------------------------
  //
  // The skeleton ships the whole manifest and is a working hello-world task, so a workspace
  // Claude never touched passes every other check in this file AND the Docker gate: oracle
  // reward 1, null reward 0, lint clean. Without this rule the pipeline will cheerfully zip
  // "write Hello, world! to hello.txt" and park it at READY TO SUBMIT.
  //
  // This is the last thing standing between a no-op build and Snorkel, so it is blocking.
  for (const rel of unchangedFromSkeleton(taskDir)) {
    add(
      "not_the_skeleton", "blocking", rel,
      `${rel} is still byte-for-byte the Default_Task_Skeleton. This is not a built task — ` +
        `it is the hello-world stub. Claude never wrote this file.`,
    );
  }

  // ---- task.toml -----------------------------------------------------------
  const tomlPath = join(taskDir, "task.toml");
  // Hoisted so the rules further down (codebase_size, category evidence) can cross-check the
  // DECLARED metadata against what is actually on disk. A declaration nobody checks against
  // reality is how `codebase_size = "small"` shipped on top of a 6-file environment.
  let meta: Record<string, any> = {};
  if (existsSync(tomlPath)) {
    try {
      const t = parseToml(readFileSync(tomlPath, "utf8")) as any;
      const md = t.metadata ?? {};
      meta = md;

      if (t.version !== "2.0") {
        add("validate_task_fields", "blocking", "task.toml", `version must be "2.0", got ${JSON.stringify(t.version)}`);
      }
      for (const key of ["author_name", "author_email", "difficulty", "category", "subcategories",
                         "number_of_milestones", "codebase_size", "languages", "tags"]) {
        if (md[key] === undefined) {
          add("validate_task_fields", "blocking", "task.toml", `[metadata] is missing required key: ${key}`);
        }
      }
      if (md.category !== undefined && !CATEGORIES.has(md.category)) {
        add("validate_task_fields", "blocking", "task.toml",
            `category "${md.category}" is not one of: ${[...CATEGORIES].join(", ")}`);
      }
      if (md.category !== undefined && BLOCKED_CATEGORIES.has(md.category)) {
        add("blocked_category", "blocking", "task.toml",
            `category "${md.category}" is BLOCKED — Snorkel is not currently accepting ` +
            `${[...BLOCKED_CATEGORIES].join(", ")} tasks. Rebuild the task under an accepted ` +
            `category, or change the task so it genuinely belongs to one.`);
      }
      for (const s of (md.subcategories ?? []) as string[]) {
        if (!SUBCATEGORIES.has(s)) {
          add("validate_task_fields", "blocking", "task.toml",
              `subcategory "${s}" is not one of: ${[...SUBCATEGORIES].join(", ")}`);
        }
      }
      if (md.codebase_size !== undefined && !CODEBASE_SIZES.has(md.codebase_size)) {
        add("validate_task_fields", "blocking", "task.toml", `codebase_size "${md.codebase_size}" must be minimal|small|large`);
      }
      if (md.difficulty !== undefined && !DIFFICULTIES.has(md.difficulty)) {
        add("validate_task_fields", "blocking", "task.toml", `difficulty "${md.difficulty}" must be easy|medium|hard`);
      }
      if (Array.isArray(md.tags) && (md.tags.length < 3 || md.tags.length > 6)) {
        add("validate_task_fields", "warning", "task.toml", `tags should be 3-6 entries, got ${md.tags.length}`);
      }
      // Documented rule: pytest is the verifier's language, so it must NOT be claimed as a
      // task language unless the agent actually writes Python.
      if (Array.isArray(md.languages) && md.languages.length === 0) {
        add("validate_task_fields", "blocking", "task.toml", "languages must not be empty");
      }

      const agentTimeout = t.agent?.timeout_sec;
      if (typeof agentTimeout !== "number" || agentTimeout < 1 || agentTimeout > 1800) {
        add("validate_task_fields", "blocking", "task.toml",
            `[agent] timeout_sec must be between 1 and 1800, got ${agentTimeout}`);
      }
      if (t.environment?.allow_internet !== false) {
        add("allow_internet", "blocking", "task.toml",
            "[environment] allow_internet must be false. All verifier deps must be baked into the image.");
      }
      if (typeof t.verifier?.timeout_sec !== "number") {
        add("validate_task_fields", "blocking", "task.toml", "[verifier] timeout_sec is required");
      }
    } catch (e) {
      add("validate_task_fields", "blocking", "task.toml", `task.toml is not valid TOML: ${(e as Error).message}`);
    }
  }

  // ---- codebase_size must match the environment that actually exists --------
  //
  // Snorkel: "❌ task.toml: codebase_size is 'small' but environment/ has 6 files (excluding
  // Dockerfile/docker-compose), expected 'minimal'". We validated codebase_size against the
  // closed vocabulary and never against reality, so a task could claim any band it liked.
  //
  // The 6 reproduces exactly as: environment/app/{docs/mill_handoff_dossier.md,
  // images/init_images.py, legacy/init_legacy_db.py, Makefile, src/migrate.cpp} plus
  // environment/.dockerignore. That tells us three things about how Snorkel counts:
  // recursive, DOTFILES INCLUDED, directories not counted — which is precisely what
  // readdirSync(withFileTypes) + walk() already gives us.
  //
  // Bands (playbook): minimal 0-20, small 20+, large 200+. Those ranges overlap at exactly 20
  // and 200, so rather than guess which side the boundary falls on we accept BOTH labels at
  // n === 20 and n === 200 and block everywhere else. 6 is nowhere near a boundary.
  const envDirForCount = join(taskDir, "environment");
  if (existsSync(envDirForCount) && meta.codebase_size !== undefined) {
    const n = walk(envDirForCount).filter((p) => !COUNT_EXCLUDE.test(basename(p))).length;
    const expected = n <= 20 ? "minimal" : n < 200 ? "small" : "large";
    const allowed = n === 20 ? ["minimal", "small"] : n === 200 ? ["small", "large"] : [expected];
    if (!allowed.includes(meta.codebase_size)) {
      add("codebase_size_matches_environment", "blocking", "task.toml",
          `codebase_size is '${meta.codebase_size}' but environment/ has ${n} files (excluding ` +
          `Dockerfile/docker-compose), expected '${expected}'. Either set codebase_size = ` +
          `"${expected}", or grow the environment past the band boundary (minimal 0-20, ` +
          `small 21-199, large 200+).`);
    }
  }

  // ---- the category a CLASSIFIER would predict, not the one we declared -----
  //
  // Snorkel: "❌ [category_classifier] Predicted category 'software-engineering' (confidence
  // 0.95) is blocked for this project." task.toml declared category = "machine-learning" — a
  // C++/SQLite migration tool with ImageMagick, in which no model is trained, served or even
  // loaded. blocked_category above only compares the DECLARED string against the blocked
  // list, so it waved this straight through. Relabelling does not help: the classifier reads
  // the task, not the label.
  //
  // Doing this properly needs an LLM and lintTask() is sync (verify.ts calls it inline), so
  // this is the offline backstop: if we claim machine-learning, SOMETHING in the task must be
  // about models. Warning, not blocking — the heuristic is coarse, and the authoritative
  // check belongs in an async classifier stage next to instruction-audit.ts.
  if (meta.category === "machine-learning") {
    const haystack = [
      existsSync(join(taskDir, "instruction.md")) ? readFileSync(join(taskDir, "instruction.md"), "utf8") : "",
      ...walk(join(taskDir, "environment")).map((p) => relative(taskDir, p)),
      ...((meta.tags ?? []) as string[]),
      ...((meta.languages ?? []) as string[]),
    ].join("\n");
    if (!ML_EVIDENCE.test(haystack)) {
      add("predicted_category_blocked", "warning", "task.toml",
          "declared machine-learning but nothing in the instruction or the environment trains, " +
          "serves or evaluates a model. A classifier will read the content and very likely call " +
          "this software-engineering, which is BLOCKED — and Snorkel blocks on the PREDICTED " +
          "category, not the declared one. Rework the task so it genuinely is not " +
          "software-engineering; renaming the label will not save it.");
    }
  }

  // ---- Dockerfile ----------------------------------------------------------
  const dfPath = join(taskDir, "environment", "Dockerfile");
  if (existsSync(dfPath)) {
    const df = readFileSync(dfPath, "utf8");

    for (const line of df.split("\n")) {
      const m = /^\s*FROM\s+(\S+)/i.exec(line);
      if (m && !m[1]!.includes("@sha256:")) {
        // WARNING, not blocking. Snorkel's own Default_Task_Skeleton.zip ships an unpinned
        // `FROM python:3.13-slim-bookworm`, so their CI evidently tolerates it. Being
        // stricter than the platform would just burn Claude fix cycles on a non-issue —
        // and their Check-feedback stage is the authority anyway.
        add("check_pinned_images", "warning", "environment/Dockerfile",
            `Base image is not digest-pinned ("${m[1]}"). Pinning is best practice; Snorkel's own skeleton is unpinned, so this is not treated as blocking.`);
      }
    }
    // Tests and solution are MOUNTED at runtime, never baked in. Baking them in leaks
    // the answers into the image the agent gets.
    for (const bad of [/^\s*COPY\s+[^\n]*\bsolution\b/im, /^\s*COPY\s+[^\n]*\btests?\b/im,
                       /^\s*ADD\s+[^\n]*\bsolution\b/im, /^\s*ADD\s+[^\n]*\btests?\b/im]) {
      if (bad.test(df)) {
        add("tests_or_solution_in_image", "blocking", "environment/Dockerfile",
            "Dockerfile must not COPY/ADD solution/ or tests/ into the image — they are mounted at runtime.");
      }
    }
    if (!/pytest/i.test(df)) {
      add("verifier_deps_baked", "blocking", "environment/Dockerfile",
          "pytest is not installed in the image. allow_internet=false means test.sh cannot pip-install at runtime.");
    }
    if (!/ctrf/i.test(df)) {
      add("verifier_deps_baked", "warning", "environment/Dockerfile",
          "pytest-json-ctrf does not appear to be installed, but tests/test.sh passes --ctrf.");
    }

    // A `RUN pip install \` + continuation lines is ONE command. Reading the file line by
    // line sees `pytest==8.4.1` as a line of its own and every rule below misfires, so join
    // continuations first and reason about whole commands.
    const dfJoined = df.replace(/\\\r?\n/g, " ");
    const dfLines = dfJoined.split("\n");

    // ---- pinned_dependencies ------------------------------------------------
    //
    // Playbook §4.2(c) and a BLOCKING line on the CI checklist: "[ ] pinned_dependencies —
    // every pip/npm/cargo/gem package has an exact version pin". lint.ts had NO such rule.
    // This particular Dockerfile happens to be pinned (pytest==8.4.1, pytest-json-ctrf==0.3.5)
    // so it did not fire here — which is exactly the problem: the gate is blind to it, and the
    // next unpinned dependency sails straight through into a CI rejection.
    const PIN_CHECKS: Array<{
      cmd: RegExp; drop: RegExp; pinned: (t: string) => boolean; eco: string; how: string;
    }> = [
      { cmd: /pip3?\s+install|python3?\s+-m\s+pip\s+install/,
        drop: /^(RUN|&&|\|\||python3?|-m|pip3?|install)$/,
        pinned: (t) => t.includes("=="), eco: "pip", how: "pkg==X.Y.Z" },
      { cmd: /npm\s+(?:install|i|add)\b/,
        drop: /^(RUN|&&|\|\||npm|install|i|add)$/,
        pinned: (t) => t.lastIndexOf("@") > 0, eco: "npm", how: "pkg@X.Y.Z" },
      { cmd: /cargo\s+install\b/,
        drop: /^(RUN|&&|\|\||cargo|install)$/,
        pinned: () => true, eco: "cargo", how: "--version X.Y.Z" },
      { cmd: /gem\s+install\b/,
        drop: /^(RUN|&&|\|\||gem|install)$/,
        pinned: () => true, eco: "gem", how: "-v X.Y.Z" },
    ];
    for (const line of dfLines) {
      for (const c of PIN_CHECKS) {
        if (!c.cmd.test(line)) continue;
        // -r/--requirement means the versions live in a requirements file;
        // pip_hash_locked_requirements below is the rule that owns that case.
        if (/(^|\s)(-r|--requirement)(\s|=)/.test(line)) continue;
        // cargo/gem carry the version in a FLAG, not on the package token.
        if (c.eco === "cargo" && !/--version[=\s]/.test(line)) {
          add("pinned_dependencies", "blocking", "environment/Dockerfile",
              `\`cargo install\` with no exact version pin (${c.how}). pinned_dependencies is a blocking CI check.`);
          continue;
        }
        if (c.eco === "gem" && !/(^|\s)-v[=\s]|--version[=\s]/.test(line)) {
          add("pinned_dependencies", "blocking", "environment/Dockerfile",
              `\`gem install\` with no exact version pin (${c.how}). pinned_dependencies is a blocking CI check.`);
          continue;
        }
        if (c.eco === "cargo" || c.eco === "gem") continue;
        const pkgs = line.trim().split(/\s+/)
          .filter((t) => !t.startsWith("-") && !c.drop.test(t) && !/^[;&|]+$/.test(t));
        for (const p of pkgs) {
          if (!c.pinned(p)) {
            add("pinned_dependencies", "blocking", "environment/Dockerfile",
                `${c.eco} package "${p}" is not pinned to an exact version (${c.how}). ` +
                `pinned_dependencies is a blocking CI check.`);
          }
        }
      }
    }

    // ---- pip_hash_locked_requirements ---------------------------------------
    //
    // Snorkel: "⚠️ Dockerfile:24: pip install with no Python lockfile (requirements.lock /
    // uv.lock / poetry.lock / requirements.txt with --require-hashes and --hash=sha256:).
    // Inline == pins only freeze direct deps." Documented send-back, WARNING severity — which
    // is what we mirror. Inline `pytest==8.4.1` freezes pytest and says nothing about the
    // dozen transitive packages pip will resolve, unpinned and unhashed, at build time.
    const LOCKFILES = /^(requirements\.lock|requirements\.txt|uv\.lock|poetry\.lock)$/i;
    for (const line of dfLines) {
      if (!/pip3?\s+install|-m\s+pip\s+install/.test(line)) continue;
      const hasHashes = /--require-hashes/.test(line);
      const m = /(?:-r|--requirement)[=\s]+(\S+)/.exec(line);
      if (!hasHashes || !m) {
        add("pip_hash_locked_requirements", "warning", "environment/Dockerfile",
            "`pip install` with no Python lockfile. Inline '==' pins only freeze DIRECT deps; " +
            "transitive deps are left unpinned and unhashed. Ship environment/requirements.lock " +
            "(pip-compile --generate-hashes), COPY it, and use: RUN python3 -m pip install " +
            "--no-cache-dir --break-system-packages --require-hashes --no-deps -r /tmp/requirements.lock");
        continue;
      }
      const named = basename(m[1]!);
      const lock = join(taskDir, "environment", named);
      if (!LOCKFILES.test(named)) {
        add("pip_hash_locked_requirements", "warning", "environment/Dockerfile",
            `Dockerfile installs from ${m[1]}, which is not a recognised lockfile name ` +
            `(requirements.lock, requirements.txt, uv.lock, poetry.lock).`);
      } else if (!existsSync(lock)) {
        add("pip_hash_locked_requirements", "warning", "environment/Dockerfile",
            `Dockerfile installs from ${m[1]} but no such file exists under environment/.`);
      } else if (!/--hash=sha256:/.test(readFileSync(lock, "utf8"))) {
        add("pip_hash_locked_requirements", "warning", `environment/${named}`,
            `${named} has no --hash=sha256: entries; --require-hashes will not protect anything.`);
      }
    }
  }

  // ---- .dockerignore -------------------------------------------------------
  const diPath = join(taskDir, "environment", ".dockerignore");
  if (!existsSync(diPath)) {
    add("check_dockerignore", "warning", "environment/.dockerignore", "Missing .dockerignore");
  }

  // ---- tests/test.sh: the canonical reward block ---------------------------
  // A rejection log in documentation\## Blocking Issues… calls out the EXACT shape:
  // no comment or blank line between `RC=$?` and the `if`, and no trailing `exit "$RC"`.
  const tsPath = join(taskDir, "tests", "test.sh");
  if (existsSync(tsPath)) {
    const ts = readFileSync(tsPath, "utf8").replace(/\r\n/g, "\n");

    if (!/reward\.txt/.test(ts)) {
      add("check_test_sh", "blocking", "tests/test.sh",
          "test.sh must write /logs/verifier/reward.txt (1 on pass, 0 on fail) or the run errors with RewardNotFoundError.");
    }
    if (!/echo\s+1\s*>/.test(ts) || !/echo\s+0\s*>/.test(ts)) {
      add("check_test_sh", "blocking", "tests/test.sh",
          "test.sh must write a reward on BOTH the pass and the fail path.");
    }
    if (!/RC=\$\?\nif \[ "\$RC" -eq 0 \]; then/.test(ts)) {
      add("canonical_reward_block", "blocking", "tests/test.sh",
          'The reward block must be exactly:\n  RC=$?\n  if [ "$RC" -eq 0 ]; then\n    echo 1 > /logs/verifier/reward.txt\n  else\n    echo 0 > /logs/verifier/reward.txt\n  fi\nNo comment or blank line between RC=$? and the if. This exact shape was a documented rejection.');
    }
    if (/^\s*exit\s+"?\$RC"?\s*$/m.test(ts)) {
      add("canonical_reward_block", "blocking", "tests/test.sh",
          'Remove the trailing `exit "$RC"` — it is a documented rejection.');
    }
    if (/(pip\s+install|apt-get|apk\s+add|curl|wget)/.test(ts)) {
      add("no_runtime_install", "blocking", "tests/test.sh",
          "test.sh must not install anything or hit the network — there is no network at test time. Bake deps into environment/Dockerfile.");
    }
    if (!/pytest/.test(ts)) {
      add("check_test_sh", "blocking", "tests/test.sh",
          "Verifier must run pytest. test.sh is only the bash entry point.");
    }
  }

  // ---- solution/solve.sh ---------------------------------------------------
  const solvePath = join(taskDir, "solution", "solve.sh");
  if (existsSync(solvePath)) {
    const s = readFileSync(solvePath, "utf8").replace(/\r\n/g, "\n");
    if (!/^#!/.test(s)) {
      add("solve_sh", "blocking", "solution/solve.sh", "Missing shebang (#!/bin/bash).");
    }
    if (!/set -euo pipefail/.test(s)) {
      add("solve_sh", "warning", "solution/solve.sh", "Should use `set -euo pipefail` so a silent partial solve can't pass.");
    }
  }

  // ---- CRLF: the failure that masquerades as a Docker bug -------------------
  for (const p of walk(taskDir)) {
    const rel = relative(taskDir, p).split(sep).join("/");
    if (!LF_REQUIRED.test(rel)) continue;
    if (readFileSync(p).includes("\r\n")) {
      add("crlf", "blocking", rel,
          "File has CRLF line endings. Inside the container this yields `bad interpreter: /bin/bash^M` — an error that looks like Docker and is not. Must be LF.");
    }
  }

  // ---- build context size --------------------------------------------------
  const envDir = join(taskDir, "environment");
  let total = 0;
  for (const p of walk(envDir)) {
    const sz = statSync(p).size;
    total += sz;
    if (sz > MAX_FILE_BYTES) {
      add("check_build_context_size", "blocking", relative(taskDir, p).split(sep).join("/"),
          `File is ${(sz / 1048576).toFixed(1)} MiB; limit is 50 MiB.`);
    }
  }
  if (total > MAX_ENV_BYTES) {
    add("check_build_context_size", "blocking", "environment/",
        `Build context is ${(total / 1048576).toFixed(1)} MiB; limit is 100 MiB.`);
  }

  // ---- the task tree has a known shape; anything else is detritus ----------
  //
  // A Terminus task is exactly: task.toml, instruction.md, environment/, solution/, tests/.
  // Nothing else belongs at the root.
  //
  // This exists because of an asymmetry that had gone unnoticed: THE GATE VERIFIES THE
  // WORKSPACE, BUT WE SHIP THE ZIP. Nothing asserted those were the same thing. So when Claude
  // — checking its own work, exactly as we asked it to — ran ruff (leaving a .ruff_cache/) and
  // zipped the tree to inspect it (leaving a 93 KB copy of the submission INSIDE the
  // submission), the gate still said VERIFIED. It was telling the truth about a tree that was
  // not quite the one going to Snorkel.
  //
  // zip.ts drops this junk categorically now, so it cannot reach Snorkel either way. But the
  // tree itself should be clean, and BLOCKING is right: the fixer deletes the file, and the
  // thing we verify becomes the thing we ship.
  const ROOT_ALLOWED = new Set(["task.toml", "instruction.md", "environment", "solution", "tests"]);
  for (const e of readdirSync(taskDir, { withFileTypes: true })) {
    // Dot-entries are ours or the tools'; zip.ts excludes every dot-directory, and .pipeline
    // is this pipeline's own bookkeeping. They are handled by no_tool_caches below.
    if (e.name.startsWith(".")) continue;
    if (ROOT_ALLOWED.has(e.name)) continue;
    add(
      "unexpected_root_entry", "blocking", e.name + (e.isDirectory() ? "/" : ""),
      `${e.name} is not part of a task. The tree is exactly task.toml, instruction.md, ` +
        `environment/, solution/ and tests/. Delete it — build scratch (an archive you made to ` +
        `inspect the submission, a notes file, a scratch script) must not ship inside the task.`,
    );
  }

  // ---- tool caches must not ship with the task -----------------------------
  //
  // We hardened the gate to run ruff. Claude, correctly, started running `ruff check` inside
  // the task directory to check its own work — and ruff wrote a `.ruff_cache/`, which the zip
  // then swept into the submission: fifteen cache files, sent to Snorkel as part of the task.
  //
  // zip.ts now excludes every dot-directory categorically, so the artefact is clean. This rule
  // is about the tree itself, and it is BLOCKING for one scope only: a cache directory under
  // environment/ is a live hazard, not untidiness — environment/ is the Docker build context,
  // so it gets baked into the image the agent under test runs in, and a stale ruff or pytest
  // cache in there can change what the task's own tooling does.
  //
  // Anywhere else in the tree it is a warning: the zip drops it, so it never reaches Snorkel.
  const CACHE_DIR = /^(\.ruff_cache|\.pytest_cache|\.mypy_cache|__pycache__|\.tox|\.cache|node_modules|\.venv)$/;
  const cacheDirs = (dir: string, out: string[] = []): string[] => {
    if (!existsSync(dir)) return out;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (CACHE_DIR.test(e.name)) out.push(join(dir, e.name));
      else cacheDirs(join(dir, e.name), out);
    }
    return out;
  };
  for (const d of cacheDirs(taskDir)) {
    const rel = relative(taskDir, d).split(sep).join("/");
    const inBuildContext = rel.startsWith("environment/");
    add(
      "no_tool_caches", inBuildContext ? "blocking" : "warning", rel + "/",
      inBuildContext
        ? `${rel}/ is a tool cache inside the Docker build context. It would be baked into the ` +
          `image the agent runs in. Delete it, and run linters with --no-cache.`
        : `${rel}/ is a tool cache. The zip drops it, so it will not reach Snorkel — but it ` +
          `should not be in the task tree. Run linters with --no-cache.`,
    );
  }

  // ---- AI scaffolding must not ship with the task --------------------------
  for (const p of walk(taskDir)) {
    const base = p.split(sep).pop()!;
    if (/^(CLAUDE\.md|AGENTS\.md|skills?\.md|\.cursorrules)$/i.test(base)) {
      add("no_ai_scaffolding", "blocking", relative(taskDir, p).split(sep).join("/"),
          `${base} must not ship inside the task — it is a High-severity reviewer flag.`);
    }
  }

  // ---- instruction.md states WHAT, never HOW -------------------------------
  //
  // Snorkel: "⚠️ [instruction_check] The instruction prescribes sequential developer workflow
  // steps and testing procedures rather than specifying what the code must do... Remove
  // prescriptive commands about rebuilding with make, running the migration tool, setting
  // environment variables." Our instruction.md did all three in one sentence: "rebuild it with
  // make in /app", "/app/bin/migrate --legacy ... --output ... --images ...", and "set
  // MIGRATION_TIMESTAMP=2024-11-15T00:00:00Z". Nothing in lint.ts even opened instruction.md.
  //
  // Heuristic, so WARNING. It cannot see intent, and one bare deliverable-producing script
  // with no flags is legitimate — the accepted reference instruction in prompts/summary.txt §5
  // says "run /app/run_audit.sh to regenerate /app/out/audit_report.json" and must stay clean.
  // What it catches is the shape Snorkel objected to: build commands, env vars, test commands,
  // and exact CLI invocations carrying flags.
  const instrPath = join(taskDir, "instruction.md");
  if (existsSync(instrPath)) {
    const instr = readFileSync(instrPath, "utf8");
    const PRESCRIPTIVE: Array<[RegExp, string]> = [
      [/\b(?:re)?build\s+(?:it\s+|the\s+\w+\s+)?with\s+\w+|\brun\s+make\b|\bmake\s+(?:clean|all|install|-j)\b|\bcmake\b|\bcargo\s+build\b|\bnpm\s+run\s+build\b|\bgo\s+build\b|\bg\+\+\s|\bgcc\s/i,
        "prescribes a build/rebuild command"],
      [/\b(?:set|export)\s+[A-Z][A-Z0-9_]{2,}\s*=|(?:^|\s)[A-Z][A-Z0-9_]{2,}=\S/m,
        "prescribes an environment variable assignment"],
      [/\bpytest\b|\bnpm\s+test\b|\bgo\s+test\b|\bcargo\s+test\b|\bctest\b|\brun\s+the\s+tests\b|\/tests\/test\.sh/i,
        "prescribes how to test — the test procedure belongs in tests/, not in the instruction"],
      [/\S+(?:\s+--[\w-]+(?:[= ]\S+)?){2,}/,
        "prescribes an exact CLI invocation with flags"],
    ];
    for (const [re, why] of PRESCRIPTIVE) {
      if (re.test(instr)) {
        add("instruction_prescribes_workflow", "warning", "instruction.md",
            `instruction.md ${why}. Snorkel's instruction_check rejects sequential developer-` +
            `workflow steps: state WHAT is wrong and WHAT correct behaviour looks like (absolute ` +
            `output paths, the output contract, the acceptance criteria). Build procedures, ` +
            `environment variables, test commands and verification steps belong in the test ` +
            `infrastructure. Naming one bare deliverable-producing script with no flags is fine.`);
      }
    }
    const SEQUENCED = /\bthen\s+run\b|\bafter\s+that,?\s+run\b|\bonce\s+(?:the\s+code\s+is|you(?:'ve|\s+have))\b[\s\S]{0,80}\b(?:then|and)\s+run\b|\bfirst,[\s\S]{0,120}\bthen\b/i;
    if (SEQUENCED.test(instr)) {
      add("instruction_prescribes_workflow", "warning", "instruction.md",
          "instruction.md reads as a sequence of developer steps rather than a specification of " +
          "required behaviour. The reviewer send-back is 'instruction.md written as implementation " +
          "guidance instead of a task definition'.");
    }
  }

  // ---- ruff: the lints Snorkel WILL run on our Python -----------------------
  //
  // This is the rule the whole file was missing. Snorkel found 14 ruff errors in tests/ and we
  // had shipped the task reporting "lint clean" — because nothing here ever ran a linter.
  // BLOCKING on tests/ and solution/, which is the scope Snorkel used (it labelled the group
  // "tests:" and did NOT report the 2 I001 errors that exist under environment/app/).
  const ruffTargets = ["tests", "solution"].filter((t) => existsSync(join(taskDir, t)));
  if (ruffTargets.length > 0) {
    const diags = runRuff(taskDir, ruffTargets);
    if (diags === "unavailable") {
      // Never silently pass. If we cannot run ruff we cannot certify the Python lints CI will
      // run, and saying nothing here is precisely how 14 errors reached Snorkel.
      add("ruff_clean", "warning", "tests/",
          "ruff could not be run (not on PATH, not at ~/.local/bin/ruff, no `python3 -m ruff`, " +
          "and the docker fallback failed) — this gate CANNOT certify the Python lints Snorkel " +
          "will run, and a clean report here means nothing. Install ruff 0.14.x " +
          "(`pip install --user ruff==0.14.5`) or make docker available, then re-run.");
    } else {
      for (const d of diags.slice(0, RUFF_FINDING_CAP)) {
        add("ruff_clean", "blocking", ruffRel(taskDir, d.filename),
            `${d.location.row}:${d.location.column}: ${d.code ?? "?"} ${d.message}`);
      }
      if (diags.length > RUFF_FINDING_CAP) {
        add("ruff_clean", "blocking", "tests/",
            `... and ${diags.length - RUFF_FINDING_CAP} more ruff diagnostics (${diags.length} total ` +
            `under --select ${RUFF_SELECT}). Run: ruff check --isolated --select ${RUFF_SELECT} ` +
            `${ruffTargets.join(" ")}`);
      }
    }
  }

  // ---- ruff over environment/: WARNING only --------------------------------
  //
  // The playbook says "All Python in the submission ... gets linted too", but Snorkel
  // demonstrably did NOT lint environment/ in this submission — environment/app/legacy/
  // init_legacy_db.py and environment/app/images/init_images.py carry 2 I001 errors it never
  // mentioned. Blocking here would be STRICTER than CI and would burn fix cycles on code the
  // agent only ever reads. So: surfaced, not enforced.
  if (existsSync(join(taskDir, "environment"))) {
    const envDiags = runRuff(taskDir, ["environment"]);
    if (envDiags !== "unavailable") {
      for (const d of envDiags.slice(0, RUFF_FINDING_CAP)) {
        add("ruff_environment_clean", "warning", ruffRel(taskDir, d.filename),
            `${d.location.row}:${d.location.column}: ${d.code ?? "?"} ${d.message} ` +
            `(environment/ Python — Snorkel did not lint this scope in the reference run, so this is not blocking)`);
      }
      if (envDiags.length > RUFF_FINDING_CAP) {
        add("ruff_environment_clean", "warning", "environment/",
            `... and ${envDiags.length - RUFF_FINDING_CAP} more ruff diagnostics under environment/.`);
      }
    }
  }

  return { findings: f, clean: !f.some((x) => x.severity === "blocking") };
}

export function formatFindings(findings: Finding[]): string {
  if (findings.length === 0) return "No lint findings.";
  return findings
    .map((x) => `[${x.severity.toUpperCase()}] ${x.rule} — ${x.file}\n    ${x.message}`)
    .join("\n");
}
