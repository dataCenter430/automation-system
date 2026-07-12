import { readFileSync } from "node:fs";
import { REPO_ROOT, expandPath } from "../../../packages/shared/src/paths.ts";
import { resolve } from "node:path";
let cached = null;
/**
 * Load config/pipeline.json, resolved from the REPO root rather than process.cwd() —
 * the worker must behave the same whether you launch it from the repo, from a service
 * wrapper, or from a scheduled task on the target machine.
 */
export function loadConfig() {
    if (cached)
        return cached;
    const raw = JSON.parse(readFileSync(resolve(REPO_ROOT, "config/pipeline.json"), "utf8"));
    // Expand ${SNORKEL_ROOT} / ${REPO_ROOT} so no absolute path is ever baked into the repo.
    raw.paths = {
        workspace: expandPath(raw.paths.workspace),
        runs: expandPath(raw.paths.runs),
        zipOutput: expandPath(raw.paths.zipOutput),
        documentation: expandPath(raw.paths.documentation),
    };
    cached = raw;
    return raw;
}
