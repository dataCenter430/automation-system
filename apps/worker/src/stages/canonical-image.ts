/**
 * "Does this task use an approved canonical base image?"
 *
 * A radio on the submission form, and the reason this file exists rather than a hardcoded `true`.
 *
 * IT IS AN ATTESTATION. Answering it is signing a statement about our own work, on a form Snorkel
 * uses to route CI. A wrong Yes is not a bug that costs a retry — it is a false claim, and it is
 * exactly the kind of thing that gets a submission rejected and an account looked at.
 *
 * So it is COMPUTED from the task's own Dockerfile, and the three possible answers are
 * true / false / **cannot determine** — where "cannot determine" is a refusal to sign, not a
 * default to Yes.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY NOT JUST TRUST THE BUILD CONTRACT
 *
 * BUILD_CONTRACT rule 5 says base images must be digest-pinned, and it was tempting to reason:
 * "we require pinning, therefore the image is canonical, therefore always answer Yes." Two things
 * are wrong with that.
 *
 *   1. LINT DOES NOT ENFORCE IT. lint.ts's `check_pinned_images` is a WARNING, and it says so in
 *      its own message: "Pinning is best practice; Snorkel's own skeleton is unpinned, so this is
 *      not treated as blocking." Nothing has ever blocked a task for its base image.
 *
 *   2. PINNED != CANONICAL. A digest-pinned image can be pinned to an image that is not on
 *      Snorkel's list at all. Pinning is a property of the reference; canonical is a property of
 *      the set.
 *
 * ---------------------------------------------------------------------------------------------
 * THE TWO-CHARACTER LANDMINE
 *
 * Snorkel's own documentation disagrees with itself about the Go image:
 *
 *   snorkel_canonical_image_best_practices.md   golang@sha256:…89540c06173ea77ac
 *   Dockerfile & Image Best Practices.txt       golang@sha256:…89540ce6173ea77ac
 *                                                                    ^^
 *
 * ...and our own playbook (prompts/summary.txt) shipped BOTH, so Claude could pick either. One of
 * them is not on the list. This check is what turns that from a silent false attestation into a
 * task that stops and asks.
 *
 * ---------------------------------------------------------------------------------------------
 * ONLY THE FINAL STAGE COUNTS
 *
 * A multi-stage Dockerfile may legitimately build in one image and run in another. Snorkel's
 * canonical doc: "the final stage is what agents and verifiers run in and is checked by CI." So
 * builder stages are exempt, and we check the LAST FROM — not the first, and not all of them.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { REPO_ROOT } from "../../../../packages/shared/src/paths.ts";

let cached: string[] | null = null;

/** Snorkel's approved list, from config/canonical-images.json. */
export function canonicalImages(): string[] {
  cached ??= (JSON.parse(readFileSync(resolve(REPO_ROOT, "config/canonical-images.json"), "utf8"))
    .images as string[]);
  return cached;
}

export type Verdict =
  | { canonical: true; image: string }
  | { canonical: false; image: string; why: string }
  /** We could not read the Dockerfile, or could not find a FROM. We do not sign what we cannot see. */
  | { canonical: null; image: null; why: string };

/**
 * Every `FROM` in a Dockerfile, in order, with `--platform=` and `AS <name>` stripped.
 *
 * Exported for the tests: the parsing is where this gets subtly wrong, and a parser that silently
 * picks the wrong FROM answers the attestation about the wrong image.
 */
export function fromLines(dockerfile: string): string[] {
  const out: string[] = [];
  for (const raw of dockerfile.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!/^FROM\s/i.test(line)) continue;
    const rest = line
      .replace(/^FROM\s+/i, "")
      .replace(/--platform=\S+\s*/i, "")
      .replace(/\s+AS\s+\S+\s*$/i, "")
      .trim();
    if (rest) out.push(rest);
  }
  return out;
}

/**
 * The image the agent and the verifier actually run in: the LAST stage's FROM.
 *
 * A final `FROM builder` (referring to an earlier stage by name) is not a base image at all — it
 * inherits one — so we resolve it back to the stage it names rather than reporting "builder" as
 * an image nobody has ever heard of.
 */
export function runtimeImage(dockerfile: string): string | null {
  const froms = fromLines(dockerfile);
  if (froms.length === 0) return null;

  const names = new Map<string, string>();
  for (const raw of dockerfile.replace(/\r\n/g, "\n").split("\n")) {
    const m = /^FROM\s+(?:--platform=\S+\s+)?(\S+)\s+AS\s+(\S+)\s*$/i.exec(raw.trim());
    if (m) names.set(m[2]!.toLowerCase(), m[1]!);
  }

  let img = froms[froms.length - 1]!;
  // Follow at most a few hops; a cycle in a Dockerfile is not our problem to solve.
  for (let i = 0; i < 8 && names.has(img.toLowerCase()); i += 1) {
    img = names.get(img.toLowerCase())!;
  }
  return img;
}

/** Judge one task's environment/Dockerfile. Never throws — an unreadable tree is `canonical: null`. */
export function canonicalBaseImage(taskDir: string): Verdict {
  const path = join(taskDir, "environment", "Dockerfile");
  if (!existsSync(path)) {
    return { canonical: null, image: null, why: `there is no environment/Dockerfile in ${taskDir}` };
  }

  let df: string;
  try {
    df = readFileSync(path, "utf8");
  } catch (e) {
    return { canonical: null, image: null, why: `environment/Dockerfile could not be read: ${(e as Error).message}` };
  }

  const img = runtimeImage(df);
  if (!img) {
    return { canonical: null, image: null, why: "environment/Dockerfile contains no FROM line" };
  }

  const list = canonicalImages();
  if (list.includes(img)) return { canonical: true, image: img };

  // A near-miss is worth saying out loud, because the one we know about is two characters long
  // and would otherwise read as an arbitrary "not on the list".
  const bare = img.split("@")[0];
  const sameName = list.find((c) => c.split("@")[0] === bare);
  const why = sameName
    ? `the image name matches a canonical entry but the DIGEST does not.\n` +
      `  ours:      ${img}\n` +
      `  canonical: ${sameName}\n` +
      `Snorkel's own docs disagree with each other about the Go digest (two characters apart), ` +
      `and our playbook shipped both. This is almost certainly that.`
    : `${img} is not on Snorkel's canonical list (config/canonical-images.json).`;

  return { canonical: false, image: img, why };
}
