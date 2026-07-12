/**
 * Seed the task workspace from the official Terminus skeleton before Claude starts.
 *
 * Two things worth knowing about that skeleton, both discovered by reading it:
 *
 * 1. Its `tests/test.sh` ships the EXACT pattern Snorkel's own rejection log calls a
 *    blocking issue — a comment and a blank line between `RC=$?` and the `if`, plus a
 *    trailing `exit "$RC"`. The skeleton predates that feedback and was never updated. So
 *    we patch it to the canonical form on the way in. Seeding a known-rejected file and
 *    then paying a Claude fix cycle to un-break it would be silly.
 *
 * 2. Its Dockerfile is not digest-pinned. That is Snorkel's own current template, so we
 *    treat pinning as a warning rather than a blocker (see stages/lint.ts).
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { extractZip } from "../util/unzip.ts";
import { snorkelRoot, REPO_ROOT } from "../../../../packages/shared/src/paths.ts";
/** The canonical reward block, verbatim from the ACCEPTED task, not from the skeleton. */
const CANONICAL_TEST_SH = `#!/bin/bash

# Verifier dependencies are baked into environment/Dockerfile so the run is offline.
# Add task-specific verifier-only Python packages there, not here.

mkdir -p /logs/verifier

# The image must set a WORKDIR; running from / means the Dockerfile forgot one.
if [ "$PWD" = "/" ]; then
    echo "Error: No working directory set. Please set a WORKDIR in your Dockerfile before running this script."
    exit 1
fi

python -m pytest -o cache_dir=/tmp/pytest_cache \\
  --ctrf /logs/verifier/ctrf.json /tests/test_outputs.py -rA
RC=$?
if [ "$RC" -eq 0 ]; then
  echo 1 > /logs/verifier/reward.txt
else
  echo 0 > /logs/verifier/reward.txt
fi
`;
export function skeletonPath() {
    const fromEnv = process.env.SKELETON_ZIP;
    const candidates = [
        fromEnv ? resolve(fromEnv) : null,
        resolve(snorkelRoot(), "documentation", "Default_Task_Skeleton.zip"),
        resolve(REPO_ROOT, "templates", "Default_Task_Skeleton.zip"),
    ].filter(Boolean);
    return candidates.find((p) => existsSync(p)) ?? null;
}
export function skeletonStatus() {
    const p = skeletonPath();
    return { path: p, exists: p !== null };
}
/** Some skeletons wrap everything in one folder; ours does not. Handle both. */
function unwrapRoot(dir) {
    const entries = readdirSync(dir, { withFileTypes: true });
    const visible = entries.filter((e) => !e.name.startsWith("__MACOSX") && !e.name.startsWith("."));
    if (visible.length === 1 && visible[0].isDirectory()) {
        const inner = join(dir, visible[0].name);
        // Only unwrap if the inner folder actually looks like a task tree.
        if (existsSync(join(inner, "task.toml")) || existsSync(join(inner, "tests")))
            return inner;
    }
    return dir;
}
/**
 * Copy the skeleton into `workspace`, NEVER overwriting anything already there.
 *
 * The never-overwrite rule is what makes this safe to call on a resumed build: a worker
 * that crashed mid-build and restarts must not have Claude's work clobbered by a fresh
 * skeleton copy.
 */
/**
 * Which manifest files are still byte-for-byte the skeleton's?
 *
 * This exists because of a bug that nearly submitted a hello-world task to Snorkel. The
 * skeleton zip ships the ENTIRE manifest — task.toml, instruction.md, Dockerfile, solve.sh,
 * test.sh, test_outputs.py — and it is a self-consistent little task: solve.sh writes
 * hello.txt, the tests check for hello.txt. So a workspace where Claude did *nothing* still
 * has a complete manifest, still passes the Docker gate (oracle 1, null 0, lint clean), and
 * still zips and uploads.
 *
 * "The files exist" is therefore not evidence of a build. This is.
 */
const SKELETON_EVIDENCE = ["instruction.md", "solution/solve.sh", "tests/test_outputs.py"];
let cachedSkeleton = null;
function skeletonContents() {
    if (cachedSkeleton)
        return cachedSkeleton;
    const m = new Map();
    const zip = skeletonPath();
    if (zip) {
        const tmp = mkdtempSync(join(tmpdir(), "tb-skel-cmp-"));
        try {
            extractZip(zip, tmp);
            const root = unwrapRoot(tmp);
            for (const rel of SKELETON_EVIDENCE) {
                const p = join(root, ...rel.split("/"));
                if (existsSync(p))
                    m.set(rel, readFileSync(p, "utf8").replace(/\r\n/g, "\n").trim());
            }
        }
        finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    }
    cachedSkeleton = m;
    return m;
}
/** Returns the manifest files that Claude never touched. Empty means a real build happened. */
export function unchangedFromSkeleton(taskDir) {
    const skel = skeletonContents();
    if (skel.size === 0)
        return []; // no skeleton to compare against — nothing to say
    const same = [];
    for (const [rel, body] of skel) {
        const p = join(taskDir, ...rel.split("/"));
        if (!existsSync(p))
            continue;
        if (readFileSync(p, "utf8").replace(/\r\n/g, "\n").trim() === body)
            same.push(rel);
    }
    return same;
}
export async function seedSkeleton(workspace) {
    const zip = skeletonPath();
    if (!zip)
        return { source: "none", path: null, seeded: [], patched: [] };
    mkdirSync(workspace, { recursive: true });
    const tmp = mkdtempSync(join(tmpdir(), "tb-skel-"));
    try {
        extractZip(zip, tmp);
        const root = unwrapRoot(tmp);
        const seeded = [];
        const walk = (src, rel) => {
            for (const e of readdirSync(src, { withFileTypes: true })) {
                const from = join(src, e.name);
                const relPath = rel ? `${rel}/${e.name}` : e.name;
                const to = join(workspace, relPath);
                if (e.isDirectory()) {
                    mkdirSync(to, { recursive: true });
                    walk(from, relPath);
                    continue;
                }
                if (existsSync(to))
                    continue; // resumed build — do not clobber Claude's work
                cpSync(from, to);
                seeded.push(relPath);
            }
        };
        walk(root, "");
        // Patch the reward block. The skeleton's version is a documented rejection; ours is
        // copied from the task that actually got accepted.
        const patched = [];
        const testSh = join(workspace, "tests", "test.sh");
        if (existsSync(testSh)) {
            const cur = readFileSync(testSh, "utf8").replace(/\r\n/g, "\n");
            const isCanonical = /RC=\$\?\nif \[ "\$RC" -eq 0 \]; then/.test(cur) && !/^\s*exit\s+"?\$RC"?\s*$/m.test(cur);
            if (!isCanonical) {
                writeFileSync(testSh, CANONICAL_TEST_SH, "utf8");
                patched.push("tests/test.sh (canonical reward block)");
            }
        }
        return { source: "zip", path: zip, seeded, patched };
    }
    finally {
        rmSync(tmp, { recursive: true, force: true });
    }
}
