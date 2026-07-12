/**
 * Extract a zip, on whatever OS this is.
 *
 * This used to be a bare `execFileSync("powershell", ["Expand-Archive", ...])`, in two
 * places — the skeleton seeder (which runs on EVERY build) and the standalone verify CLI.
 * On Linux both threw ENOENT, so every build died before Claude was ever called.
 *
 * `archiver` is a dependency here, but it only writes archives; there is no reader in the
 * tree, so this shells out rather than adding one. `unzip` is the POSIX default and
 * `python3 -m zipfile` is the fallback for the minimal container that does not have it.
 */
import { execFileSync } from "node:child_process";
export function extractZip(zip, dest) {
    if (process.platform === "win32") {
        execFileSync("powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dest}' -Force`], { stdio: "pipe" });
        return;
    }
    try {
        execFileSync("unzip", ["-q", "-o", zip, "-d", dest], { stdio: "pipe" });
        return;
    }
    catch (e) {
        // `unzip` is not installed on every minimal Linux image. Python almost always is, and
        // its stdlib can do this — so try that before giving up on the whole build.
        try {
            execFileSync("python3", ["-m", "zipfile", "-e", zip, dest], { stdio: "pipe" });
            return;
        }
        catch {
            throw new Error(`Could not extract ${zip}: neither \`unzip\` nor \`python3 -m zipfile\` worked.\n` +
                `Install one of them (\`sudo apt install unzip\`).\n${e.message}`);
        }
    }
}
