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
    // Recursive delete only. A plain `rm -f build.log` is ordinary and must stay allowed —
    // blocking it just teaches the model to work around the guard.
    { re: /\brm\b[^|;&]*\s-\w*r/i, why: "is a recursive delete" },
    // ...and any rm aimed at the root, the home directory, or a bare glob of one.
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
 * Paths that must never be written or read-modified, even by a command that otherwise looks
 * fine. These are the ones where a mistake is silent and expensive: credentials, the repo's
 * own source, and the .env that holds the Supabase secret.
 */
/**
 * These are matched against BOTH file paths and raw shell commands, so the boundaries have
 * to work in either. `(^|[^\w])` means "start, or a non-word char" — which catches
 * `/home/pug/.env` and `cp .env /tmp` alike, while `\b` on the tail keeps `.envrc` and
 * `.gitignore` (harmless, and `.gitignore` is a file Claude legitimately writes) from
 * matching.
 */
const PROTECTED = [
    /(^|[^\w])\.claude\b/,
    /(^|[^\w])\.ssh\b/,
    /(^|[^\w])\.aws\b/,
    /(^|[^\w])\.gnupg\b/,
    /(^|[^\w])\.env\b/,
    /(^|[^\w])\.git\b/,
];
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
        const cmd = String(input.command ?? "");
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
