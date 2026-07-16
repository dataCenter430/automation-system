/**
 * Zip a built task for upload.
 *
 * Two rules, both load-bearing, both confirmed against the real accepted zips:
 *
 *  1. CONTENTS AT THE ROOT. The archive contains environment/, solution/, tests/,
 *     instruction.md, task.toml directly — NOT a wrapper folder. The submission form
 *     says so out loud: "Zip file should have all files in the root, not under any folder."
 *
 *  2. LF + exec bits. archiver writes whatever mode we give it, and Windows gives it
 *     nothing useful, so set 0755 on scripts explicitly. Line endings are normalized
 *     first — a CRLF solve.sh dies inside the container with `bad interpreter: ^M`.
 */
// archiver is CommonJS (`export =`). createRequire keeps both the runtime call and the
// types working under NodeNext without an esModuleInterop default-import shim.
import { createRequire } from "node:module";
const archiver = createRequire(import.meta.url)("archiver");
import { createWriteStream, mkdirSync, existsSync, statSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { normalizeLineEndings } from "../util/lf.ts";
/**
 * Never ship build detritus or our own pipeline bookkeeping inside the task.
 *
 * The named list is for directories that do NOT start with a dot. Everything dot-prefixed is
 * excluded categorically — see isJunkDir() — because a denylist of tool caches always lags
 * the next tool.
 *
 * It lagged within the hour. We hardened the gate to run ruff (Snorkel's CI found 14 errors we
 * had not looked for), Claude duly started running `ruff check` inside the task directory to
 * check its own work, ruff wrote a `.ruff_cache/`, and the zip swept 15 cache files straight
 * into the submission. `.ruff_cache` was not on this list, because ruff was not part of this
 * workflow when the list was written. Nor will the next linter be.
 *
 * No dot-directory has any business inside a Terminus task: the tree is environment/,
 * solution/, tests/, task.toml, instruction.md. Dot-FILES are a different matter —
 * environment/.dockerignore is required — so this rule is about directories only.
 */
const EXCLUDE_DIRS = new Set(["node_modules", "__pycache__"]);
function isJunkDir(name) {
    return name.startsWith(".") || EXCLUDE_DIRS.has(name);
}
/** The entire shape of a Terminus task. Nothing else may sit at the root. */
const ROOT_ALLOWED = new Set(["task.toml", "instruction.md", "environment", "solution", "tests"]);
// `*.tmp.<pid>.<ts>` are Claude Code's own atomic-write temp files. They are normally
// cleaned up, but a crash mid-write leaves them behind — and they must never ship inside
// a submitted task. Same for CLAUDE.md, which is our build scaffolding, not the task's.
const EXCLUDE_FILES = /^(\.DS_Store|Thumbs\.db|CLAUDE\.md|.*\.pyc)$|\.tmp\.\d+\.\d+$/i;
/** Scripts must be executable in the container. */
const EXECUTABLE = /\.sh$/i;
export async function zipTask(taskDir, outZipPath) {
    if (!existsSync(taskDir))
        throw new Error(`No such task dir: ${taskDir}`);
    normalizeLineEndings(taskDir);
    mkdirSync(dirname(outZipPath), { recursive: true });
    const files = [];
    const walk = (dir, atRoot) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            if (e.isDirectory()) {
                if (isJunkDir(e.name))
                    continue;
                // A task tree is exactly task.toml, instruction.md, environment/, solution/, tests/.
                // Anything else at the root is build scratch. lint.ts blocks on it so the fixer
                // removes it; this is the belt to that pair of braces, because the gate verifies the
                // WORKSPACE and we ship the ZIP — and until now nothing kept those two in step.
                if (atRoot && !ROOT_ALLOWED.has(e.name))
                    continue;
                walk(join(dir, e.name), false);
                continue;
            }
            if (EXCLUDE_FILES.test(e.name))
                continue;
            if (atRoot && !ROOT_ALLOWED.has(e.name))
                continue;
            files.push(join(dir, e.name));
        }
    };
    walk(taskDir, true);
    if (files.length === 0)
        throw new Error(`Task dir is empty: ${taskDir}`);
    const archive = archiver("zip", { zlib: { level: 9 } });
    const out = createWriteStream(outZipPath);
    const done = new Promise((res, rej) => {
        out.on("close", () => res());
        archive.on("warning", (e) => { if (e.code !== "ENOENT")
            rej(e); });
        archive.on("error", rej);
    });
    archive.pipe(out);
    const entries = [];
    for (const abs of files) {
        // relative(taskDir, …) is what puts the contents at the archive root.
        const name = relative(taskDir, abs).split(sep).join("/");
        entries.push(name);
        archive.file(abs, { name, mode: EXECUTABLE.test(name) ? 0o755 : 0o644 });
    }
    await archive.finalize();
    await done;
    return { zipPath: outZipPath, bytes: statSync(outZipPath).size, entries: entries.sort() };
}
/**
 * Guard against the mistake that would silently invalidate every submission:
 * zipping the folder instead of its contents.
 */
export function assertNoWrapperDir(entries) {
    const required = ["task.toml", "instruction.md"];
    for (const r of required) {
        if (!entries.includes(r)) {
            const nested = entries.find((e) => e.endsWith(`/${r}`));
            throw new Error(nested
                ? `Zip has a wrapper directory: found "${nested}" but "${r}" must be at the archive root.`
                : `Zip is missing ${r} at the archive root.`);
        }
    }
    for (const dir of ["environment/", "solution/", "tests/"]) {
        if (!entries.some((e) => e.startsWith(dir))) {
            throw new Error(`Zip is missing the ${dir} directory at the archive root.`);
        }
    }
}
