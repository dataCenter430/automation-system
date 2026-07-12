/**
 * Read/write config/owners.json — the owner list and the ACTIVE owner.
 *
 * activeOwner is what gets stamped onto terminus.task_owner when a task is added, so it is
 * worth guarding: a typo'd or removed owner silently mislabels every submission that
 * follows, and nobody notices until the work is already in Snorkel under the wrong name.
 * Hence the validation below is strict and every rejection says what to do about it.
 */
import { NextResponse } from "next/server";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { REPO_ROOT } from "../../../../../packages/shared/src/paths.ts";

// This route touches the filesystem, which the edge runtime has no access to.
export const runtime = "nodejs";

interface OwnerSettings {
  $comment?: string;
  activeOwner: string;
  owners: string[];
}

const SHAPE_HINT = `Expected shape: { "activeOwner": "Pug", "owners": ["Hercules", "Mickey", "Pug"] }`;

// Restored on save if someone deleted it, so the file never stops explaining itself.
const DEFAULT_COMMENT =
  "activeOwner is stamped onto every new task's terminus.task_owner column at add time — " +
  "it is who Snorkel will see as the owner of the submission. Edit this from the web UI " +
  "(/settings) rather than by hand: PUT /api/settings validates that activeOwner is one of " +
  "owners, which hand-editing does not.";

/** A message the human can act on, surfaced as a 400 rather than a stack trace. */
class BadRequest extends Error {}

/**
 * REPO_ROOT is derived from paths.ts's own location on disk. That is exact for the worker
 * (Node runs the .ts file in place) but not necessarily for Next, which bundles server
 * code into .next/ — so fall back to walking up from cwd. Still no absolute path anywhere:
 * both routes discover the repo by finding config/owners.json itself.
 */
function ownersFile(): string {
  const fromRepoRoot = resolve(REPO_ROOT, "config/owners.json");
  if (existsSync(fromRepoRoot)) return fromRepoRoot;

  let dir = process.cwd(); // `next dev` runs from apps/web
  for (;;) {
    const candidate = resolve(dir, "config/owners.json");
    if (existsSync(candidate)) return candidate;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(
    `config/owners.json not found (looked in ${fromRepoRoot} and upward from ${process.cwd()}).\n` +
      `Create it at the repo root with exactly this content, then reload:\n` +
      `${JSON.stringify({ $comment: DEFAULT_COMMENT, activeOwner: "Pug", owners: ["Pug"] }, null, 2)}`,
  );
}

/**
 * Strict on purpose. This file decides who every submission is credited to, and the harm is
 * silent: a hand-edited typo mislabels task after task and nobody notices until the work is
 * already in Snorkel under a name that doesn't exist. PUT can't be the only guard, because
 * nothing stops an editor — so the read path refuses a file it cannot vouch for and says
 * precisely which line to fix.
 */
function read(): OwnerSettings {
  const file = ownersFile();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${(e as Error).message}\n${SHAPE_HINT}`);
  }

  const settings = raw as Partial<OwnerSettings>;
  if (!Array.isArray(settings.owners) || typeof settings.activeOwner !== "string") {
    throw new Error(`${file} is missing activeOwner or owners.\n${SHAPE_HINT}`);
  }

  // A number or null here reaches the browser and blows up the settings page on .toLowerCase().
  const bad = settings.owners.findIndex((o) => typeof o !== "string" || !o.trim());
  if (bad !== -1) {
    throw new Error(
      `${file}: owners[${bad}] is ${JSON.stringify(settings.owners[bad])}, not a name.\n` +
        `Every entry must be a quoted, non-empty name — delete that entry and reload. ${SHAPE_HINT}`,
    );
  }

  // An empty list is the one inconsistency we tolerate: it is the first-run/recovery state,
  // and /settings can only dig you out of it if this read succeeds.
  const owners = settings.owners as string[];
  const known = owners.some((o) => o.toLowerCase() === settings.activeOwner!.trim().toLowerCase());
  if (owners.length > 0 && !known) {
    throw new Error(
      `${file}: activeOwner is "${settings.activeOwner}", who is not in owners (${owners.join(", ")}).\n` +
        `Every new task would be credited to a name that is not on the list. Edit the file and set\n` +
        `"activeOwner" to one of: ${owners.join(", ")} — then reload /settings.`,
    );
  }

  return {
    $comment: typeof settings.$comment === "string" && settings.$comment ? settings.$comment : DEFAULT_COMMENT,
    activeOwner: settings.activeOwner,
    owners,
  };
}

function write(settings: OwnerSettings): void {
  // $comment first so the file still explains itself after a UI-driven save. LF + trailing
  // newline: JSON.stringify never emits CRLF and Node does no newline translation, so the
  // file stays byte-identical whether it was last written on Windows or by an editor.
  const ordered = {
    $comment: settings.$comment ?? DEFAULT_COMMENT,
    activeOwner: settings.activeOwner,
    owners: settings.owners,
  };
  writeFileSync(ownersFile(), `${JSON.stringify(ordered, null, 2)}\n`, "utf8");
}

function cleanOwners(input: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new BadRequest(`owners must be a non-empty list of names. ${SHAPE_HINT}`);
  }

  const cleaned: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string" || !raw.trim()) {
      throw new BadRequest("Every owner needs a name — remove the blank entry and save again.");
    }
    const name = raw.trim();
    // Dedupe case-insensitively: "Pug" and "pug" would render as two indistinguishable
    // rows, yet only one of them could ever equal the activeOwner we stamp on a task.
    if (!cleaned.some((o) => o.toLowerCase() === name.toLowerCase())) cleaned.push(name);
  }
  return cleaned;
}

export async function GET() {
  try {
    return NextResponse.json(read());
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

/**
 * Partial update: send owners, activeOwner, or both. Whatever you omit is kept as-is, so
 * the Add-task form can flip the active owner without having to resend the whole list.
 */
export async function PUT(req: Request) {
  try {
    // A junk body is the caller's fault, not the server's: without this it escapes as a 500
    // reading "Unexpected token 'o'", which sends the human off debugging the wrong machine.
    let body: { activeOwner?: unknown; owners?: unknown };
    try {
      body = (await req.json()) as { activeOwner?: unknown; owners?: unknown };
    } catch {
      throw new BadRequest(`Request body is not valid JSON. ${SHAPE_HINT}`);
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new BadRequest(`Request body must be a JSON object. ${SHAPE_HINT}`);
    }

    const current = read();

    const owners = body.owners === undefined ? cleanOwners(current.owners) : cleanOwners(body.owners);

    let wanted = current.activeOwner;
    if (body.activeOwner !== undefined) {
      if (typeof body.activeOwner !== "string" || !body.activeOwner.trim()) {
        throw new BadRequest("activeOwner must be the name of one of the owners.");
      }
      wanted = body.activeOwner.trim();
    }

    // Match loosely, store the canonical spelling from the list — otherwise a request that
    // says "pug" would persist an activeOwner that no owner row equals.
    const activeOwner = owners.find((o) => o.toLowerCase() === wanted.toLowerCase());
    if (!activeOwner) {
      throw new BadRequest(
        `activeOwner "${wanted}" is not in the owner list (${owners.join(", ")}). ` +
          `Add them as an owner first, or pick one of the existing owners.`,
      );
    }

    const saved: OwnerSettings = { $comment: current.$comment, activeOwner, owners };
    write(saved);
    return NextResponse.json(saved);
  } catch (e) {
    if (e instanceof BadRequest) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
