/**
 * POST-SUBMISSION FEEDBACK → DOWNLOAD → ANALYSE. The revise loop's front half, on the CLI.
 *
 * When a submission comes back needing revision, the operator's flow is:
 *   1. `stb submissions feedback <ID>`   — the AI + human-reviewer feedback text.
 *   2. `stb submissions download <ID>`   — the submitted files AND the difficulty-check artifact
 *                                          (transcripts/scores from the real agent runs).
 *   3. Hand both to a Claude session to analyse the issue and improve the task.
 *
 * The KEY QUALITY LEVER the operator asked for: when the feedback is a TRIVIAL / TOO-EASY signal,
 * the fix is not "patch a line" — it is "understand WHY the agent found it easy and make it harder",
 * and the evidence for that lives in the downloaded difficulty artifact (the agent transcripts). So a
 * too-easy verdict routes to a DIFFERENT prompt that is handed the transcripts, not the generic fix.
 *
 * TWO THINGS THE DOCS DO NOT PIN DOWN, so both are isolated behind one function each:
 *   - the exact SHAPE of `stb submissions feedback` output → classifyFeedback() (text heuristics).
 *   - the exact LAYOUT of the downloaded artifact folder → locateArtifacts() (searches, not assumes).
 * The term "difficulty_check_artifact" is the operator's, from the live platform; it appears in no
 * doc. So we SEARCH the download for difficulty evidence by shape, and degrade gracefully if absent.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { stb, type Runner } from "./cli.ts";

/** What kind of problem the feedback describes — decides which prompt the fix session gets. */
export type FeedbackKind =
  | "too-easy"        // the difficulty check / reviewer said trivial → analyse the artifact, make it harder
  | "ci-failure"      // an automated CI/LLMaJ check failed → fix that specific check
  | "reviewer-change" // a human asked for a specific change → surgical fix
  | "decline"         // fundamental: duplicate, flawed concept → rebuild or abandon, ask a human
  | "unknown";        // could not classify → show the human, do not guess

export interface FeedbackVerdict {
  kind: FeedbackKind;
  /** The lines that drove the classification, for the prompt and the dashboard. */
  signals: string[];
  /** The full feedback text, verbatim, always passed to the fix session. */
  raw: string;
}

/**
 * Classify the feedback text. HEURISTIC and calibratable — the exact wording Snorkel emits is
 * unverified, so this matches on robust phrases from the docs ("# After Submission.txt" Declined
 * reasons: "Too easy", "Similar task already exists", "Fundamental design issues"; the difficulty
 * bar's "worst model scores above 80%").
 *
 * Order matters: DECLINE (fatal) is checked before too-easy (which is one decline reason but is
 * salvageable by making the task harder), and CI failures before generic reviewer changes.
 */
export function classifyFeedback(raw: string): FeedbackVerdict {
  const text = raw.toLowerCase();
  const hits = (...res: RegExp[]) => res.flatMap((re) => raw.match(new RegExp(re, "gi")) ?? []);

  // Fundamental declines that making-it-harder cannot fix.
  const declineSignals = hits(
    /similar task already exists/,
    /duplicate/,
    /fundamental (design )?issue/,
    /core concept is flawed/,
    /unclear requirements/,
  );
  if (declineSignals.length) return { kind: "decline", signals: declineSignals, raw };

  // Too easy / trivial → the artifact-driven make-harder path.
  const tooEasy = hits(
    /too easy/,
    /trivial/,
    /worst model scores? above/,
    /(pass|solve|accuracy).{0,20}\b(8[1-9]|9\d|100)\s?%/,
    /not (hard|difficult) enough/,
    /difficulty (check|too low|below)/,
  );
  if (tooEasy.length) return { kind: "too-easy", signals: tooEasy, raw };

  // A specific automated check failed.
  const ci = hits(
    /\bcheck_[a-z_]+/,
    /\b(pinned_dependencies|validate_task_fields|ruff|typos|tests_or_solution_in_image)\b/,
    /ci (check )?fail/,
    /llmaj/,
    /\bBLOCK(S|ING|ED)?\b/,
  );
  if (ci.length) return { kind: "ci-failure", signals: ci, raw };

  // A human asked for a change (there is text, and it is not one of the above).
  if (text.trim().length > 0) {
    return { kind: "reviewer-change", signals: [], raw };
  }

  return { kind: "unknown", signals: [], raw };
}

/** `stb submissions feedback <ID>` — the AI + reviewer feedback, classified. */
export async function fetchFeedback(run: Runner, submissionId: string): Promise<FeedbackVerdict> {
  const r = await stb(run, ["submissions", "feedback", submissionId], { timeoutSec: 120 });
  return classifyFeedback(r.stdout);
}

/**
 * Find WHERE the download landed by reading the command's OWN OUTPUT.
 *
 * The operator's guidance: `stb submissions download` prints where it saved the difficulty-check
 * artifact (the agent run logs), and the system should read that from the command output rather than
 * assume a folder. So we parse the path out of stdout, tolerant of the exact phrasing:
 *   "Downloaded to /path", "Saved to: /path", "Extracted to ./dir", or a bare path line.
 */
export function parseDownloadPath(stdout: string): string | null {
  // Phrased forms first — most reliable.
  const phrased = /(?:download(?:ed)?|sav(?:ed|ing)|extract(?:ed)?|written|output|wrote)\b[^\n]*?\b(?:to|:|into|at)\s+["']?([^\s"']+)/i.exec(stdout);
  if (phrased?.[1]) return phrased[1];
  // Otherwise the last path-looking token in the output (downloads usually end by naming the dir).
  const paths = stdout.match(/(?:\/|\.\/|~\/|[A-Za-z]:\\)[\w./\\-]+/g);
  return paths?.[paths.length - 1] ?? null;
}

export interface Download {
  /** Where the artifact actually landed, resolved from the command output (or the cwd fallback). */
  dir: string;
  /** The command's stdout, kept so a human/log can see exactly what it reported. */
  stdout: string;
  /** True if we read the path from the output; false if we fell back to the working dir. */
  pathFromOutput: boolean;
}

/**
 * `stb submissions download <ID>` — pull the difficulty-check artifact (agent run logs for the
 * submitted task), then report where it went by reading the command's output.
 *
 * `cwd` is where we run it, so any relative extraction lands somewhere we control; the returned `dir`
 * is what stdout actually named (resolved against cwd if relative), falling back to cwd itself.
 */
export async function downloadSubmission(run: Runner, submissionId: string, cwd: string): Promise<Download> {
  const r = await stb(run, ["submissions", "download", submissionId], { timeoutSec: 300, cwd });
  const parsed = parseDownloadPath(r.stdout);
  const dir = parsed ? (isAbsolute(parsed) ? parsed : join(cwd, parsed)) : cwd;
  return { dir, stdout: r.stdout, pathFromOutput: parsed !== null };
}

export interface ArtifactSet {
  /** Files that look like agent-run evidence (transcripts, per-run logs, difficulty json). */
  difficultyArtifacts: string[];
  /** Everything else the download produced, for reference. */
  otherFiles: string[];
  /** Empty if the download produced nothing recognisable — the caller degrades gracefully. */
  found: boolean;
}

/**
 * Find the difficulty evidence inside a download, BY SHAPE not by a hard-coded path.
 *
 * "difficulty_check_artifact" is the operator's term from the live platform and appears in no doc, so
 * we do not assume its exact name. We walk the download and pick files whose name or extension marks
 * them as agent-run evidence: anything with "difficulty", "artifact", "transcript", "agent", "run",
 * "eval", or a .json/.jsonl/.log/.cast (asciinema) extension. Recalibrate the moment we see one real
 * download (scripts/stb-probe.sh, step 6).
 */
export function locateArtifacts(dir: string): ArtifactSet {
  const difficulty: string[] = [];
  const other: string[] = [];
  const EVIDENCE = /difficulty|artifact|transcript|agent|_run|eval|score|\.(jsonl?|log|cast)$/i;

  const walk = (d: string, depth: number): void => {
    if (depth > 6 || !existsSync(d)) return;
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) {
        walk(p, depth + 1);
      } else {
        (EVIDENCE.test(name) || EVIDENCE.test(p) ? difficulty : other).push(p);
      }
    }
  };
  walk(dir, 0);
  return { difficultyArtifacts: difficulty, otherFiles: other, found: difficulty.length > 0 };
}

/**
 * Assemble the evidence a fix session needs, capped so a giant transcript does not blow the prompt.
 * Reads the head of each artifact; the session can open the rest itself since they are on disk.
 */
export function summariseArtifacts(set: ArtifactSet, perFileChars = 4000, maxFiles = 8): string {
  if (!set.found) {
    return "(no difficulty artifact was found in the download — analyse from the feedback text alone, " +
      "and note in your summary that the transcript evidence was unavailable.)";
  }
  const parts: string[] = [];
  for (const p of set.difficultyArtifacts.slice(0, maxFiles)) {
    let head = "";
    try { head = readFileSync(p, "utf8").slice(0, perFileChars); } catch { head = "(unreadable)"; }
    parts.push(`=== ${p} ===\n${head}`);
  }
  if (set.difficultyArtifacts.length > maxFiles) {
    parts.push(`(+${set.difficultyArtifacts.length - maxFiles} more artifact files on disk under the download dir)`);
  }
  return parts.join("\n\n");
}

/** Which fix prompt a verdict routes to. Keeps the routing in one place. */
export function promptFor(kind: FeedbackKind): { template: string; needsArtifact: boolean } {
  switch (kind) {
    case "too-easy":        return { template: "11-too-easy.md", needsArtifact: true };
    case "ci-failure":      return { template: "05-feedback-fix.md", needsArtifact: false };
    case "reviewer-change": return { template: "06-revise.md", needsArtifact: false };
    case "decline":         return { template: "06-revise.md", needsArtifact: false }; // + ask_human first
    case "unknown":         return { template: "06-revise.md", needsArtifact: false };
  }
}
