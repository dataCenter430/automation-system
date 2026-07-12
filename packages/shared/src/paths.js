/**
 * Path resolution, portable across machines.
 *
 * This system is developed on one machine and runs on another, so NOTHING may hard-code
 * an absolute path. Everything is derived from two roots, both overridable by env:
 *
 *   REPO_ROOT     — this repo. Derived from this file's location; never configured.
 *   SNORKEL_ROOT  — the folder holding documentation/, Working/, Accepted/.
 *                   Defaults to the repo's parent, which is how it is laid out today
 *                   (E:\Work\Snorkel\Snorkel-Automation-Workflow → E:\Work\Snorkel).
 *
 * config/pipeline.json may use ${SNORKEL_ROOT} and ${REPO_ROOT} tokens, which are
 * expanded here.
 */
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
const HERE = dirname(fileURLToPath(import.meta.url)); // packages/shared/src
export const REPO_ROOT = resolve(HERE, "../../..");
export function snorkelRoot() {
    const fromEnv = process.env.SNORKEL_ROOT;
    if (fromEnv)
        return resolve(fromEnv);
    return resolve(REPO_ROOT, "..");
}
/** Expand ${SNORKEL_ROOT} / ${REPO_ROOT} and make the result absolute. */
export function expandPath(p) {
    const expanded = p
        .replace(/\$\{SNORKEL_ROOT\}/g, snorkelRoot())
        .replace(/\$\{REPO_ROOT\}/g, REPO_ROOT);
    return isAbsolute(expanded) ? resolve(expanded) : resolve(REPO_ROOT, expanded);
}
/**
 * The docs must be present or the playbook can't be regenerated on a new machine.
 * Fail loudly at setup time rather than mysteriously at build time.
 */
export function assertSnorkelRoot() {
    const root = snorkelRoot();
    if (!existsSync(resolve(root, "documentation"))) {
        throw new Error(`SNORKEL_ROOT is ${root}, but there is no documentation/ folder there.\n` +
            `Set SNORKEL_ROOT in .env to the folder that contains documentation/, Working/ and Accepted/.`);
    }
}
