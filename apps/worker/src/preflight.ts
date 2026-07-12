/**
 * Refuse to start on a broken machine, and say exactly how to fix it.
 *
 * Every one of these has already bitten us: the Docker daemon was down, Chrome can't
 * expose CDP from the default profile, and the Agent SDK silently has no credentials if
 * the worker runs as a different OS user than the one that ran `claude login`.
 */
import "dotenv/config";
import { existsSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT, snorkelRoot } from "../../../packages/shared/src/paths.ts";
import * as docker from "./docker/runner.ts";
import { skeletonStatus } from "./stages/skeleton.ts";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
  required: boolean;
}

async function checkDocker(): Promise<Check> {
  try {
    await docker.assertDaemonUp();
    const v = await docker.run(["info", "--format", "{{.ServerVersion}}"], { timeoutSec: 20 });
    return { name: "Docker daemon", ok: true, detail: `v${v.stdout.trim()}`, required: true };
  } catch (e) {
    const msg = (e as Error).message;
    // On Linux the daemon is usually fine and the socket is simply not readable by this
    // user. "Start Docker Desktop" is actively misleading there, and it cost us an
    // afternoon once.
    const denied = /permission denied/i.test(msg);
    const fix =
      process.platform === "win32"
        ? "Start Docker Desktop and wait for it to report Running."
        : denied
          ? "You are not in the `docker` group: run `sudo usermod -aG docker $USER`, then log out and back in (or `newgrp docker`)."
          : "Start the daemon: `sudo systemctl start docker`.";
    return { name: "Docker daemon", ok: false, detail: msg.split("\n")[0]!, fix, required: true };
  }
}

function checkClaudeLogin(): Check {
  // The SDK spawns the Claude Code CLI, which reads credentials from ~/.claude. If the
  // worker runs as a different user than the one that logged in, this directory is absent
  // and every build fails with an auth error 20 minutes in rather than at boot.
  const dir = join(homedir(), ".claude");
  const creds = [join(dir, ".credentials.json"), join(dir, "credentials.json")];
  const found = creds.find((p) => existsSync(p));
  if (found) {
    return { name: "Claude Code login", ok: true, detail: `credentials at ${dir}`, required: true };
  }
  if (existsSync(dir)) {
    return {
      name: "Claude Code login", ok: true,
      detail: `${dir} exists (credentials may be in the OS keychain)`, required: true,
    };
  }
  return {
    name: "Claude Code login", ok: false, detail: `no ~/.claude for user ${homedir()}`,
    fix: "Run `claude login` AS THIS OS USER. The Agent SDK uses your Claude Code subscription, not an API key.",
    required: true,
  };
}

async function checkSupabase(): Promise<Check> {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    return {
      name: "Supabase", ok: false, detail: "SUPABASE_URL / SUPABASE_SECRET_KEY not set",
      fix: "Copy .env.example to .env and fill it in.", required: true,
    };
  }
  try {
    const r = await fetch(`${url}/rest/v1/terminus?select=task_id&limit=1`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) {
      return {
        name: "Supabase", ok: false, detail: `HTTP ${r.status}`,
        fix: "Check SUPABASE_SECRET_KEY (the sb_secret_… one, not the publishable key).",
        required: true,
      };
    }
    return { name: "Supabase", ok: true, detail: "terminus table reachable", required: true };
  } catch (e) {
    return { name: "Supabase", ok: false, detail: (e as Error).message, required: true };
  }
}

async function checkChromeCdp(): Promise<Check> {
  const cdp = process.env.CDP_URL ?? "http://127.0.0.1:9222";
  const launchHint =
    (process.platform === "win32"
      ? "Run scripts/launch-chrome.ps1. "
      : "Run `bash scripts/launch-chrome.sh`. ") +
    "You CANNOT attach to a normally-launched Chrome: the debug port only exists if Chrome " +
    "was STARTED with --remote-debugging-port, and Chrome 136+ refuses that flag on the " +
    "default user-data-dir.";
  try {
    const r = await fetch(`${cdp}/json/version`, { signal: AbortSignal.timeout(5_000) });
    if (!r.ok) {
      return { name: "Chrome CDP", ok: false, detail: `HTTP ${r.status} from ${cdp}`, fix: launchHint, required: false };
    }
    const j = (await r.json()) as { Browser?: string };
    return { name: "Chrome CDP", ok: true, detail: `${j.Browser ?? "connected"} at ${cdp}`, required: false };
  } catch {
    return { name: "Chrome CDP", ok: false, detail: `nothing listening on ${cdp}`, fix: launchHint, required: false };
  }
}

function checkPlaybook(): Check {
  const p = resolve(REPO_ROOT, "prompts/summary.txt");
  if (!existsSync(p)) {
    return {
      name: "Playbook (summary.txt)", ok: false, detail: "missing",
      fix: `Run: npm run summary:build  (reads ${snorkelRoot()}/documentation). Without the playbook, every build is ungrounded and gets rejected.`,
      required: true,
    };
  }
  const bytes = statSync(p).size;
  if (bytes < 2000) {
    return {
      name: "Playbook (summary.txt)", ok: false, detail: `only ${bytes} bytes — looks truncated`,
      fix: "Run: npm run summary:build", required: true,
    };
  }
  return { name: "Playbook (summary.txt)", ok: true, detail: `${(bytes / 1024).toFixed(0)} KB`, required: true };
}

function checkSkeleton(): Check {
  const s = skeletonStatus();
  if (s.exists) {
    return { name: "Task skeleton", ok: true, detail: s.path!.split(/[\\/]/).pop()!, required: false };
  }
  return {
    name: "Task skeleton", ok: false, detail: "not found",
    fix: "Put Default_Task_Skeleton.zip in <SNORKEL_ROOT>/documentation, or set SKELETON_ZIP in .env. " +
         "Without it Claude builds from scratch, which still works but re-derives the boilerplate.",
    required: false,
  };
}

export async function preflight(): Promise<Check[]> {
  return [
    checkClaudeLogin(),
    await checkDocker(),
    await checkSupabase(),
    checkPlaybook(),
    checkSkeleton(),
    await checkChromeCdp(), // not required: build+verify work fine without a browser
  ];
}

export function report(checks: Check[]): boolean {
  console.log("");
  for (const c of checks) {
    const icon = c.ok ? "✅" : c.required ? "❌" : "⚠️ ";
    console.log(`${icon} ${c.name.padEnd(24)} ${c.detail}`);
    if (!c.ok && c.fix) console.log(`   ↳ ${c.fix}`);
  }
  const blocking = checks.filter((c) => !c.ok && c.required);
  console.log("");
  if (blocking.length) {
    console.log(`Cannot start: ${blocking.length} required check(s) failed.\n`);
    return false;
  }
  const warn = checks.filter((c) => !c.ok);
  if (warn.length) console.log(`Starting anyway. ${warn.length} optional check(s) failed — browser stages will be unavailable.\n`);
  return true;
}

// Standalone: npm run preflight
//
// The hand-rolled `file:///${argv[1]}` form this used to use produced FOUR slashes on Linux
// (argv[1] already starts with "/"), so it never matched, and `npm run preflight` printed
// nothing and exited 0 — which reads exactly like "all checks passed".
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const checks = await preflight();
  process.exit(report(checks) ? 0 : 1);
}
