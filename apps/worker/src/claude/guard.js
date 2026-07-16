/**
 * The fence around an unattended agent.
 *
 * The worker runs Claude with nobody at the keyboard, so there is no human to approve a
 * tool call. That leaves two honest options: let it do anything (`bypassPermissions`), or
 * decide up front what "anything" means. This is the second.
 *
 * The rule is simple and deliberately boring: **Claude may write inside the task workspace
 * and nowhere else, and may not run a handful of shell constructs that are never part of
 * building a Terminus task.** Everything else — reading files, globbing, grepping, and
 * running docker/pytest/bash inside the workspace — is allowed without prompting, because
 * the build genuinely cannot happen otherwise.
 *
 * This is a guard rail, not a sandbox. It is not a security boundary against a determined
 * adversary — a shell is a shell, and anything with `bash` can in principle reach around a
 * pattern match. It exists to stop an ordinary bad turn (a confused `rm -rf ~`, a stray
 * `sudo`, a fix that "helpfully" edits your .env) from doing damage while you are asleep.
 * If you need a real boundary, run the worker in a container.
 *
 * Every refusal is surfaced to the caller, not swallowed: a guard that silently blocks a
 * legitimate command would look exactly like Claude being stupid, and you would spend an
 * evening debugging the wrong thing.
 */
import { isAbsolute, resolve, relative } from "node:path";
/** Tools whose input names a path we must keep inside the workspace. */
const PATH_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
/**
 * Shell constructs that are never part of building a task, and are expensive to get wrong.
 * Matched against the raw command string.
 */
const SHELL_DENY = [
    { re: /\bsudo\b|\bdoas\b|\bpkexec\b/, why: "runs as root" },
    // NOTE: recursive delete is NOT here. It is handled by rmIsContained(), because whether an
    // `rm -rf` is fine depends entirely on WHAT it deletes — and a flat ban was a live
    // contradiction: lint's no_tool_caches rule tells Claude "delete environment/.ruff_cache/",
    // and then the guard refused `rm -rf .ruff_cache`. A guard that forbids the thing the gate
    // demands teaches the model that the guard is noise to be routed around.
    { re: /\brm\b[^|;&]*\s+(\/|~|\$HOME)(\s|\/?\*|$)/, why: "deletes from / or your home directory" },
    { re: /\bmkfs\b|\bdd\s+if=|\bshred\b/, why: "destroys a filesystem or device" },
    { re: /\bchown\b|\bchmod\s+(-\w+\s+)*777\b/, why: "changes ownership/permissions broadly" },
    // curl|sh — the classic way an agent installs something it should not.
    { re: /\b(curl|wget)\b[^|;&]*\|\s*(ba)?sh\b/, why: "pipes a download straight into a shell" },
    { re: /\bgit\s+push\b/, why: "pushes to a remote" },
    { re: /\bnpm\s+publish\b|\bpip\s+.*\bupload\b/, why: "publishes a package" },
    { re: /\bshutdown\b|\breboot\b|\bhalt\b/, why: "powers off the machine" },
    { re: /\bcrontab\b|\bsystemctl\s+(enable|start)\b/, why: "installs persistence" },
];
/**
 * Paths where a mistake is silent and expensive: credentials, and the .env holding the
 * Supabase secret.
 *
 * `(^|[^\w])` means "start, or a non-word char" — which catches `/home/pug/.env` and
 * `cp .env /tmp` alike, while `\b` on the tail keeps `.envrc` and `.gitignore` (harmless, and
 * `.gitignore` is a file Claude legitimately writes) from matching.
 *
 * NOTE `.git` is deliberately NOT here for shell commands. It was, and it fired on this,
 * during a real fix turn:
 *
 *     find . -type f -not -path './.git/*' | sort
 *
 * That command AVOIDS .git — the exact opposite of touching it — and the guard refused it
 * twice before Claude routed around it. A guard that cries wolf on `--exclude-dir=.git`
 * teaches the model to work around the guard, which is worse than not having one. And it was
 * never load-bearing: the task workspace has no .git of its own, file-writing tools are
 * already confined to the workspace, and `rm -rf .git` is caught by the recursive-delete rule.
 */
const PROTECTED = [
    /(^|[^\w])\.claude\b/,
    /(^|[^\w])\.ssh\b/,
    /(^|[^\w])\.aws\b/,
    /(^|[^\w])\.gnupg\b/,
    /(^|[^\w])\.env\b/,
];
/**
 * Strip the parts of a command that EXCLUDE a path, before asking whether it touches one.
 *
 * `grep --exclude-dir=.claude`, `find -not -path './.env/*'`, `rsync --exclude .ssh` — every
 * one of these names a protected path precisely in order to stay away from it. Matching the
 * raw string cannot tell "read this" from "skip this", and the difference is the whole point.
 */
/**
 * Is every target of a recursive `rm` inside the task workspace?
 *
 * Deleting a directory is not dangerous; deleting the WRONG directory is. So judge the target,
 * not the flag. `rm -rf .ruff_cache` inside the workspace is housekeeping — and lint now
 * explicitly ORDERS it ("delete it, and run linters with --no-cache"). `rm -rf ~/Documents` is
 * not, and never will be.
 *
 * Two things are refused even inside the workspace: the workspace root itself, and a bare glob
 * (`rm -rf *`). Both wipe the build, and neither is ever the thing you meant.
 *
 * Returns null when the command is not a recursive rm at all (nothing to say), true/false
 * otherwise.
 */
function rmIsContained(workspace, cmd) {
    // Recursive only. `rm -f build.log` is ordinary and never came near this.
    if (!/\brm\b[^|;&]*\s-\w*r/i.test(cmd))
        return null;
    const ws = resolve(workspace);
    // Take the rm clause only — a compound command may legitimately do other things after it.
    const clause = /\brm\b([^|;&]*)/i.exec(cmd)?.[1] ?? "";
    const args = clause
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .filter((a) => !a.startsWith("-")); // drop flags
    if (args.length === 0)
        return false; // `rm -rf` with no target: refuse, it means nothing good
    for (const raw of args) {
        const a = raw.replace(/^['"]|['"]$/g, "");
        // A glob that could expand to anything, or a shell variable we cannot resolve, is not
        // something we can prove is contained — so we do not pretend we can.
        if (a === "*" || a === "." || a === ".." || a.startsWith("$"))
            return false;
        const abs = isAbsolute(a) ? a : resolve(ws, a);
        const rel = relative(ws, resolve(abs));
        if (rel === "" || rel.startsWith("..") || isAbsolute(rel))
            return false; // the ws itself, or outside it
        if (touchesProtected(a))
            return false;
    }
    return true;
}
function stripExclusions(cmd) {
    return cmd
        .replace(/--exclude(-dir)?[= ]\s*(['"]?)[^\s'"]+\2/g, " ")
        .replace(/-not\s+-path\s+(['"]?)[^\s'"]+\1/g, " ")
        .replace(/-path\s+(['"]?)[^\s'"]+\1\s+-prune/g, " ")
        .replace(/:!\S+/g, " "); // git pathspec exclusion
}
function insideWorkspace(workspace, p) {
    const abs = isAbsolute(p) ? p : resolve(workspace, p);
    const rel = relative(resolve(workspace), resolve(abs));
    // "" is the workspace itself; anything starting with ".." escaped it.
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
function touchesProtected(s) {
    for (const re of PROTECTED)
        if (re.test(s))
            return re.source;
    return null;
}
/**
 * Pure decision function — exported separately from the SDK callback so it can be unit
 * tested without spawning an agent.
 */
export function judge(workspace, toolName, input) {
    // --- File-writing tools: the path must be inside this task's workspace. ---
    if (PATH_TOOLS.has(toolName)) {
        const p = String(input.file_path ?? input.path ?? input.notebook_path ?? "");
        if (!p)
            return { allow: false, reason: `${toolName} called with no path.` };
        if (!insideWorkspace(workspace, p)) {
            return {
                allow: false,
                reason: `Refused: ${toolName} tried to write outside the task workspace (${p}). ` +
                    `You may only create and edit files inside ${workspace}.`,
            };
        }
        const hit = touchesProtected(p);
        if (hit)
            return { allow: false, reason: `Refused: ${toolName} targets a protected path (${p}).` };
        return { allow: true };
    }
    // --- Bash: allow it, but not the handful of things a task build never needs. ---
    if (toolName === "Bash") {
        const raw = String(input.command ?? "");
        // A path named in order to be SKIPPED is not a path being touched. See stripExclusions().
        const cmd = stripExclusions(raw);
        // Recursive delete is judged by its TARGET, not by its flag.
        const contained = rmIsContained(workspace, cmd);
        if (contained === false) {
            return {
                allow: false,
                reason: `Refused: that recursive delete is not confined to the task workspace. You may ` +
                    `\`rm -rf\` inside ${workspace} (deleting a stray cache directory, for instance), but ` +
                    `not the workspace itself, not a bare glob, and nothing outside it.`,
            };
        }
        for (const { re, why } of SHELL_DENY) {
            if (re.test(cmd)) {
                return {
                    allow: false,
                    reason: `Refused: that command ${why}, which is never part of building a task. ` +
                        `Work inside ${workspace} and do not touch the rest of the machine.`,
                };
            }
        }
        const hit = touchesProtected(cmd);
        if (hit) {
            return {
                allow: false,
                reason: `Refused: that command touches credentials or repo internals (matched /${hit}/).`,
            };
        }
        return { allow: true };
    }
    // Read / Glob / Grep / WebFetch / Task / TodoWrite — reading is not the risk here.
    return { allow: true };
}
