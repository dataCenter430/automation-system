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
import { join, relative, sep } from "node:path";
import { parse as parseToml } from "smol-toml";
import { unchangedFromSkeleton } from "./skeleton.ts";
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
const BLOCKED_CATEGORIES = new Set(["software-engineering", "debugging", "data-processing"]);
const SUBCATEGORIES = new Set([
    "long_context", "tool_specific", "api_integration", "db_interaction", "ui_building",
]);
const CODEBASE_SIZES = new Set(["minimal", "small", "large"]);
const DIFFICULTIES = new Set(["easy", "medium", "hard", "unknown"]);
const MAX_ENV_BYTES = 100 * 1024 * 1024; // 100 MiB build context
const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MiB per file
/** Files whose CRLF line endings will break them inside a Linux container. */
const LF_REQUIRED = /\.(sh|py)$|(^|[\\/])Dockerfile$/i;
function walk(dir, out = []) {
    if (!existsSync(dir))
        return out;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory())
            walk(p, out);
        else
            out.push(p);
    }
    return out;
}
export function lintTask(taskDir) {
    const f = [];
    const add = (rule, severity, file, message) => f.push({ rule, severity, file, message });
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
        add("not_the_skeleton", "blocking", rel, `${rel} is still byte-for-byte the Default_Task_Skeleton. This is not a built task — ` +
            `it is the hello-world stub. Claude never wrote this file.`);
    }
    // ---- task.toml -----------------------------------------------------------
    const tomlPath = join(taskDir, "task.toml");
    if (existsSync(tomlPath)) {
        try {
            const t = parseToml(readFileSync(tomlPath, "utf8"));
            const md = t.metadata ?? {};
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
                add("validate_task_fields", "blocking", "task.toml", `category "${md.category}" is not one of: ${[...CATEGORIES].join(", ")}`);
            }
            if (md.category !== undefined && BLOCKED_CATEGORIES.has(md.category)) {
                add("blocked_category", "warning", "task.toml", `category "${md.category}" is BLOCKED — Snorkel is not currently accepting ` +
                    `${[...BLOCKED_CATEGORIES].join(", ")} tasks. Rebuild the task under an accepted ` +
                    `category, or change the task so it genuinely belongs to one.`);
            }
            for (const s of (md.subcategories ?? [])) {
                if (!SUBCATEGORIES.has(s)) {
                    add("validate_task_fields", "blocking", "task.toml", `subcategory "${s}" is not one of: ${[...SUBCATEGORIES].join(", ")}`);
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
                add("validate_task_fields", "blocking", "task.toml", `[agent] timeout_sec must be between 1 and 1800, got ${agentTimeout}`);
            }
            if (t.environment?.allow_internet !== false) {
                add("allow_internet", "blocking", "task.toml", "[environment] allow_internet must be false. All verifier deps must be baked into the image.");
            }
            if (typeof t.verifier?.timeout_sec !== "number") {
                add("validate_task_fields", "blocking", "task.toml", "[verifier] timeout_sec is required");
            }
        }
        catch (e) {
            add("validate_task_fields", "blocking", "task.toml", `task.toml is not valid TOML: ${e.message}`);
        }
    }
    // ---- Dockerfile ----------------------------------------------------------
    const dfPath = join(taskDir, "environment", "Dockerfile");
    if (existsSync(dfPath)) {
        const df = readFileSync(dfPath, "utf8");
        for (const line of df.split("\n")) {
            const m = /^\s*FROM\s+(\S+)/i.exec(line);
            if (m && !m[1].includes("@sha256:")) {
                // WARNING, not blocking. Snorkel's own Default_Task_Skeleton.zip ships an unpinned
                // `FROM python:3.13-slim-bookworm`, so their CI evidently tolerates it. Being
                // stricter than the platform would just burn Claude fix cycles on a non-issue —
                // and their Check-feedback stage is the authority anyway.
                add("check_pinned_images", "warning", "environment/Dockerfile", `Base image is not digest-pinned ("${m[1]}"). Pinning is best practice; Snorkel's own skeleton is unpinned, so this is not treated as blocking.`);
            }
        }
        // Tests and solution are MOUNTED at runtime, never baked in. Baking them in leaks
        // the answers into the image the agent gets.
        for (const bad of [/^\s*COPY\s+[^\n]*\bsolution\b/im, /^\s*COPY\s+[^\n]*\btests?\b/im,
            /^\s*ADD\s+[^\n]*\bsolution\b/im, /^\s*ADD\s+[^\n]*\btests?\b/im]) {
            if (bad.test(df)) {
                add("tests_or_solution_in_image", "blocking", "environment/Dockerfile", "Dockerfile must not COPY/ADD solution/ or tests/ into the image — they are mounted at runtime.");
            }
        }
        if (!/pytest/i.test(df)) {
            add("verifier_deps_baked", "blocking", "environment/Dockerfile", "pytest is not installed in the image. allow_internet=false means test.sh cannot pip-install at runtime.");
        }
        if (!/ctrf/i.test(df)) {
            add("verifier_deps_baked", "warning", "environment/Dockerfile", "pytest-json-ctrf does not appear to be installed, but tests/test.sh passes --ctrf.");
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
            add("check_test_sh", "blocking", "tests/test.sh", "test.sh must write /logs/verifier/reward.txt (1 on pass, 0 on fail) or the run errors with RewardNotFoundError.");
        }
        if (!/echo\s+1\s*>/.test(ts) || !/echo\s+0\s*>/.test(ts)) {
            add("check_test_sh", "blocking", "tests/test.sh", "test.sh must write a reward on BOTH the pass and the fail path.");
        }
        if (!/RC=\$\?\nif \[ "\$RC" -eq 0 \]; then/.test(ts)) {
            add("canonical_reward_block", "blocking", "tests/test.sh", 'The reward block must be exactly:\n  RC=$?\n  if [ "$RC" -eq 0 ]; then\n    echo 1 > /logs/verifier/reward.txt\n  else\n    echo 0 > /logs/verifier/reward.txt\n  fi\nNo comment or blank line between RC=$? and the if. This exact shape was a documented rejection.');
        }
        if (/^\s*exit\s+"?\$RC"?\s*$/m.test(ts)) {
            add("canonical_reward_block", "blocking", "tests/test.sh", 'Remove the trailing `exit "$RC"` — it is a documented rejection.');
        }
        if (/(pip\s+install|apt-get|apk\s+add|curl|wget)/.test(ts)) {
            add("no_runtime_install", "blocking", "tests/test.sh", "test.sh must not install anything or hit the network — there is no network at test time. Bake deps into environment/Dockerfile.");
        }
        if (!/pytest/.test(ts)) {
            add("check_test_sh", "blocking", "tests/test.sh", "Verifier must run pytest. test.sh is only the bash entry point.");
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
        if (!LF_REQUIRED.test(rel))
            continue;
        if (readFileSync(p).includes("\r\n")) {
            add("crlf", "blocking", rel, "File has CRLF line endings. Inside the container this yields `bad interpreter: /bin/bash^M` — an error that looks like Docker and is not. Must be LF.");
        }
    }
    // ---- build context size --------------------------------------------------
    const envDir = join(taskDir, "environment");
    let total = 0;
    for (const p of walk(envDir)) {
        const sz = statSync(p).size;
        total += sz;
        if (sz > MAX_FILE_BYTES) {
            add("check_build_context_size", "blocking", relative(taskDir, p).split(sep).join("/"), `File is ${(sz / 1048576).toFixed(1)} MiB; limit is 50 MiB.`);
        }
    }
    if (total > MAX_ENV_BYTES) {
        add("check_build_context_size", "blocking", "environment/", `Build context is ${(total / 1048576).toFixed(1)} MiB; limit is 100 MiB.`);
    }
    // ---- AI scaffolding must not ship with the task --------------------------
    for (const p of walk(taskDir)) {
        const base = p.split(sep).pop();
        if (/^(CLAUDE\.md|AGENTS\.md|skills?\.md|\.cursorrules)$/i.test(base)) {
            add("no_ai_scaffolding", "blocking", relative(taskDir, p).split(sep).join("/"), `${base} must not ship inside the task — it is a High-severity reviewer flag.`);
        }
    }
    return { findings: f, clean: !f.some((x) => x.severity === "blocking") };
}
export function formatFindings(findings) {
    if (findings.length === 0)
        return "No lint findings.";
    return findings
        .map((x) => `[${x.severity.toUpperCase()}] ${x.rule} — ${x.file}\n    ${x.message}`)
        .join("\n");
}
