/**
 * Thin, honest wrapper around the docker CLI.
 *
 * Uses `docker cp` rather than bind mounts on purpose: Windows host paths through
 * WSL2 bring path-translation and permission problems that look like task bugs but
 * aren't. Copying into the container is slower by a second and correct every time.
 */
import { spawn } from "node:child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export class DockerError extends Error {}

export function run(
  args: string[],
  opts: { timeoutSec?: number; cwd?: string } = {},
): Promise<ExecResult> {
  const timeoutMs = (opts.timeoutSec ?? 600) * 1000;

  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      cwd: opts.cwd,
      windowsHide: true,
      shell: false,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new DockerError(`Failed to spawn docker: ${err.message}. Is the docker CLI installed?`));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut });
    });
  });
}

/** Preflight. A dead daemon is the single most common cause of a confusing failure here. */
export async function assertDaemonUp(): Promise<void> {
  const r = await run(["info", "--format", "{{.ServerVersion}}"], { timeoutSec: 20 });
  if (r.code !== 0) {
    const said = (r.stderr || r.stdout).trim().split("\n")[0] ?? "";
    // On Linux the daemon is usually running fine and this user simply cannot read the
    // socket. Telling them to "start Docker" sends them looking in the wrong place.
    const fix =
      process.platform === "win32"
        ? "Start Docker Desktop and wait for it to report Running."
        : /permission denied/i.test(said)
          ? "You are not in the `docker` group: `sudo usermod -aG docker $USER`, then log out and back in."
          : "Start the daemon: `sudo systemctl start docker`.";
    throw new DockerError(`Docker daemon is not reachable. ${fix}\ndocker info said: ${said}`);
  }
}

export async function buildImage(
  tag: string,
  contextDir: string,
  timeoutSec: number,
): Promise<ExecResult> {
  // Network is ON for the build (apt/pip need it). It is OFF at test time — see runDetached.
  return run(["build", "-t", tag, "--progress", "plain", "."], {
    cwd: contextDir,
    timeoutSec,
  });
}

/**
 * Start the task container.
 *
 * Network mode MIRRORS the task's own allow_internet setting:
 *  - allow_internet = false (default) → `--network none`. If a supposedly-offline task only passes
 *    with a network, it is broken, and we want to find that out here rather than in review.
 *  - allow_internet = true → `--network bridge`. Snorkel welcomes true when the task genuinely needs
 *    the network (external info, web resources, an un-bundleable model), and its own eval runs the
 *    task WITH the network; forcing `none` here would fail a legitimately-online task's oracle.
 *
 * NO `-w` flag. The image's own WORKDIR must survive; some tests assert on $PWD.
 */
export async function runDetached(
  name: string,
  image: string,
  limits: { cpus: number; memoryMb: number; allowInternet?: boolean },
): Promise<void> {
  await run(["rm", "-f", name], { timeoutSec: 60 }); // idempotent: a crashed run may have left one
  const r = await run([
    "run", "-d",
    "--name", name,
    "--network", limits.allowInternet ? "bridge" : "none",
    "--cpus", String(limits.cpus),
    "--memory", `${limits.memoryMb}m`,
    image,
    "sleep", "infinity",
  ], { timeoutSec: 120 });

  if (r.code !== 0) {
    throw new DockerError(`Could not start container ${name}: ${r.stderr.trim() || r.stdout.trim()}`);
  }
}

export async function copyInto(container: string, hostPath: string, containerPath: string): Promise<void> {
  const r = await run(["cp", hostPath, `${container}:${containerPath}`], { timeoutSec: 180 });
  if (r.code !== 0) {
    throw new DockerError(`docker cp ${hostPath} -> ${container}:${containerPath} failed: ${r.stderr.trim()}`);
  }
}

export async function copyOut(container: string, containerPath: string, hostPath: string): Promise<void> {
  // Not fatal: /logs may legitimately not exist if the container died early, and the
  // caller needs the exec output to explain why more than it needs the (absent) logs.
  await run(["cp", `${container}:${containerPath}`, hostPath], { timeoutSec: 180 });
}

export function exec(container: string, cmd: string[], timeoutSec: number): Promise<ExecResult> {
  return run(["exec", container, ...cmd], { timeoutSec });
}

export async function remove(name: string): Promise<void> {
  await run(["rm", "-f", name], { timeoutSec: 60 });
}

export async function removeImage(tag: string): Promise<void> {
  await run(["rmi", "-f", tag], { timeoutSec: 120 });
}
