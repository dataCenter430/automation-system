/**
 * Force LF on the files that run inside a Linux container.
 *
 * Claude builds these on a Windows host. A solve.sh that lands with CRLF produces
 *   bash: /solution/solve.sh: /bin/bash^M: bad interpreter: No such file or directory
 * which looks like a Docker or mount problem and is neither. Normalize before both
 * verify and zip, and let the linter reject any that slip through.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

const NEEDS_LF = /\.(sh|py|toml|md)$|(^|[\\/])Dockerfile$|(^|[\\/])Makefile$|(^|[\\/])\.dockerignore$/i;

export function normalizeLineEndings(root: string): string[] {
  const changed: string[] = [];

  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === ".git" || e.name === "node_modules" || e.name === ".pipeline") continue;
        walk(p);
        continue;
      }
      if (!NEEDS_LF.test(e.name) && !NEEDS_LF.test(p)) continue;
      if (statSync(p).size > 20 * 1024 * 1024) continue; // don't rewrite a huge corpus

      const buf = readFileSync(p);
      if (!buf.includes("\r\n")) continue;

      writeFileSync(p, buf.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
      changed.push(p.split(sep).join("/"));
    }
  };

  walk(root);
  return changed;
}
