/**
 * The build stage.
 *
 * Seeds the skeleton, then runs two Claude turns in the task workspace: study the playbook,
 * then build the task. The session id is persisted the moment it exists, so a crash resumes
 * the conversation rather than paying for it twice.
 *
 * Completion is never taken on Claude's word. A turn ending is necessary but not sufficient:
 * the manifest must physically exist on disk. If Claude stops early we hand it back the list
 * of missing files exactly once, and if it still will not produce them the stage fails loudly
 * rather than passing a half-built task to the Docker gate.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { render, loadSummary, BUILD_CONTRACT } from "../claude/prompts.ts";
import { runTurn, sessionExists } from "../claude/session.ts";
import { toTaskToml } from "../../../../packages/shared/src/taxonomy.ts";
import type { ParsedTask } from "../../../../packages/shared/src/parse-task-blob.ts";
import { seedSkeleton, unchangedFromSkeleton, type SkeletonResult } from "./skeleton.ts";
import { openInEditor } from "../util/open-editor.ts";
import {
  designGate, readDesign, validateDesign, DesignInvalid, type Design,
} from "./design-gate.ts";
import { categorySpec } from "./categories.ts";
import type { RejectedDesign } from "../state.ts";

/** The category's authoritative definition, rendered for a prompt. */
export function categorySpecText(category: string): string {
  const s = categorySpec(category);
  if (!s) return `(no spec on file for "${category}" — fall back to the playbook's section 3.)`;
  return [
    `**Deliverable.** ${s.deliverable}`,
    ``,
    `**Graded on.** ${s.gradedOn}`,
    ``,
    `**Test names in this category look like:**`,
    ...s.testNamesLikeThis.map((t) => `  - \`${t}\``),
    ``,
    `**NOT like:** ${s.notThis}`,
    ``,
    `**The trap:** ${s.theTrap}`,
  ].join("\n");
}

/** The approved design, rendered back into the build prompt so the build realises THAT. */
export function designSummary(d: Design | null): string {
  if (!d) return "(no design on file — build from the category spec above.)";
  return [
    `**Deliverable.** ${d.deliverable}`,
    ``,
    `**Graded on.** ${d.gradedOn}`,
    ``,
    `**Grading axis.** \`${d.gradingAxis}\``,
    ``,
    `**The tests you committed to (write these, and do not write an equality test that is not here):**`,
    ...d.testNames.map((t) => `  - \`${t}\``),
  ].join("\n");
}

/**
 * THE DESIGN GATE LOOP: state a design, classify it, iterate until it is clean.
 *
 * The session writes `.pipeline/design.json` and stops. We classify it with the SAME panel that
 * will judge the finished build, so a design that clears this gate is a design whose build will
 * clear the real one. Blocked → hand the verdict straight back and ask again. Each round costs a
 * short turn plus four Haiku calls; the thing it replaces cost up to eighteen minutes a round.
 *
 * If it cannot produce a clean design in `maxRounds`, we do NOT block the build. The design gate
 * is an accelerator, not a new way to fail: the real gate still stands behind it, and a task that
 * dies here would die there anyway — but with a Docker run's worth of evidence instead of none.
 * We log loudly and carry on.
 */
async function runDesignGate(args: {
  workspace: string;
  declared: string;
  ledger: RejectedDesign[];
  maxRounds: number;
  resume: string | null;
  timeoutMin: number;
  model?: string;
  onSessionId: (id: string) => Promise<void>;
  onProgress?: (m: string) => Promise<void>;
}): Promise<Design | null> {
  let resume = args.resume;
  let feedback = "";

  // A DESIGN THAT ALREADY CLEARED THE GATE IS NOT RE-OPENED.
  //
  // Without this, a resumed build (crash recovery, a restarted worker) re-runs the design turn from
  // scratch — and a fresh design turn can legitimately produce a DIFFERENT design from the one the
  // half-built tree on disk already implements. The build would then be handed a design it is not
  // building, the drift check would fire against a tree that never agreed to it, and the resume
  // would be strictly worse than no resume at all.
  //
  // The marker is the approved design itself: if design.json is on disk and still passes, that IS
  // the approval, and re-deriving it can only introduce disagreement.
  const onDisk = readDesign(args.workspace);
  if (onDisk) {
    try {
      const d = validateDesign(onDisk);
      const v = await designGate(d, args.declared, args.ledger, args.model);
      if (v.ok) {
        await args.onProgress?.(`design already approved on disk · axis "${d.gradingAxis}" — not re-opening it`);
        return d;
      }
    } catch {
      // Unusable design.json from an older build. Fall through and state a new one.
    }
  }

  for (let round = 1; round <= args.maxRounds; round++) {
    await args.onProgress?.(`turn 2: stating the design (round ${round}/${args.maxRounds})`);

    const turn = await runTurn({
      prompt: render("09-design.md", {
        category: args.declared,
        categorySpec: categorySpecText(args.declared),
        rejectedDesigns: renderLedger(args.ledger) + feedback,
      }),
      cwd: args.workspace,
      resume,
      append: BUILD_CONTRACT,
      timeoutMin: args.timeoutMin,
      label: "designing",
      onSessionId: async (id) => { resume = id; await args.onSessionId(id); },
      onProgress: args.onProgress,
    });
    resume = turn.sessionId ?? resume;

    let design: Design;
    try {
      design = validateDesign(readDesign(args.workspace));
    } catch (e) {
      if (!(e instanceof DesignInvalid)) throw e;
      feedback = `\n\n## Your last design was not usable\n\n${(e as Error).message}\n`;
      await args.onProgress?.(`design round ${round}: unusable — ${(e as Error).message}`);
      continue;
    }

    const verdict = await designGate(design, args.declared, args.ledger, args.model);
    if (verdict.ok) {
      await args.onProgress?.(`✅ ${verdict.report}`);
      return design;
    }

    await args.onProgress?.(`design round ${round} REJECTED — ${verdict.report.split("\n")[0]}`);
    feedback = `\n\n## Your last design was REJECTED\n\n${verdict.report}\n`;
  }

  // OUT OF ROUNDS. Return NULL — never the last design.
  //
  // Returning readDesign() here would hand the build turn the design that was JUST REJECTED, under
  // a heading that says "the design you already committed to, and cleared the classifier with".
  // That is not a degraded gate, it is a lie: the build would be told a blocked design was approved
  // and would faithfully implement it. Better to say nothing and let the build fall back to the
  // category spec, which is at least true.
  //
  // We do NOT fail the task. The design gate is an accelerator, not a new way to die: the real gate
  // still stands behind it, and a task that cannot state a clean design would have been blocked
  // anyway — but now it is blocked with a Docker run's worth of evidence rather than none.
  rmSync(join(args.workspace, ".pipeline", "design.json"), { force: true });
  await args.onProgress?.(
    `⚠️  the design gate could not reach a clean design in ${args.maxRounds} rounds. Building from ` +
      `the category spec alone; the category classifier will still judge the result.`,
  );
  return null;
}

/** The ledger, rendered for a prompt. render() has no loops, so it is pre-joined here. */
export function renderLedger(ledger: RejectedDesign[]): string {
  if (!ledger.length) return "";
  return [
    `## Designs that have ALREADY been rejected — do not propose any of these again`,
    ``,
    `A design's identity is its GRADING AXIS plus WHAT ITS TESTS ASSERT. Change the domain, the`,
    `nouns and the file names all you like: if the assertions are the same, it is the same design,`,
    `and it will be rejected exactly as it was before. That is not a hypothetical — it is what`,
    `happened here, three times.`,
    ``,
    `You MAY reuse an axis if you are genuinely asserting something different. You may NOT`,
    `re-propose the same axis asserting the same things.`,
    ``,
    ...ledger.map(
      (r) =>
        `- **attempt ${r.attempt}** · axis \`${r.gradingAxis}\` · blocked as **${r.predicted}** (${r.confidence})\n` +
        `  - deliverable: ${r.deliverable.slice(0, 180)}\n` +
        `  - graded on: ${r.gradedOn.slice(0, 180)}\n` +
        `  - why it was blocked: ${r.why.slice(0, 240)}`,
    ),
  ].join("\n");
}

/** What a finished task must physically contain. Claude's word is never the evidence. */
export const MANIFEST = [
  "task.toml",
  "instruction.md",
  "environment/Dockerfile",
  "solution/solve.sh",
  "tests/test.sh",
  "tests/test_outputs.py",
];

export function missingFromManifest(taskDir: string): string[] {
  return MANIFEST.filter((f) => !existsSync(join(taskDir, f)));
}

/**
 * Written by US, not by Claude, once a build turn has actually returned AND left a complete
 * manifest that is not just the skeleton.
 *
 * The crash-recovery path used to ask "are all the manifest files present?" and treat yes as
 * "the build finished, only the DB transition was lost". That is wrong, and dangerously so:
 * seedSkeleton() lays down the entire manifest before Claude is ever called, so a build that
 * died on its first tool call leaves a workspace that looks complete. The recovered task then
 * skips the build, passes the Docker gate (the skeleton is a working hello-world task), and
 * parks at READY TO SUBMIT.
 *
 * A marker we write ourselves is evidence. Files existing is not.
 */
const BUILD_DONE = ".pipeline/BUILD_DONE";

export function buildAlreadyComplete(taskDir: string): boolean {
  return (
    existsSync(join(taskDir, BUILD_DONE)) &&
    missingFromManifest(taskDir).length === 0 &&
    unchangedFromSkeleton(taskDir).length === 0
  );
}

/** Claude's turn ended, but the task tree is not complete. A human should look. */
export class BuildIncomplete extends Error {
  missing: string[];
  constructor(missing: string[]) {
    super(
      `Claude finished its turn but these files are still missing: ${missing.join(", ")}. ` +
        `The task tree is incomplete, so it was not handed to the Docker gate.`,
    );
    this.name = "BuildIncomplete";
    this.missing = missing;
  }
}

export interface BuildInput {
  task: ParsedTask;
  slug: string;
  workspace: string; // absolute
  studyTimeoutMin: number;
  buildTimeoutMin: number;
  onSessionId: (id: string) => Promise<void>;
  onProgress?: (msg: string) => Promise<void>;
  /** True when resuming: continue the existing conversation instead of starting one. */
  resuming?: boolean;
  /** The session to resume, when resuming. */
  sessionId?: string | null;
  /** Open a VS Code window on the workspace so the build can be watched in an editor. */
  openEditor?: boolean;

  /**
   * Every design the classifier has already rejected for THIS task.
   *
   * A rebuild that does not know what was already tried is condemned to try it again — which
   * is precisely what happened: three rebuilds, three domains, one grading axis, four
   * rejections. The design gate refuses any design reusing a rejected axis, and the prompt
   * shows the session the whole ledger so it does not have to be refused to find out.
   */
  rejectedDesigns?: RejectedDesign[];
  /** How many times the session may restate its design before we give up and build anyway. */
  designRounds?: number;
  designTimeoutMin?: number;
  /**
   * The model the design gate classifies with. It MUST be the same one the real gate uses —
   * Snorkel's CI announces REVIEW_MODEL="claude-haiku-4-5" and we ask the same model the same
   * question. A design gate judging with a different model would be a different gate, and its
   * approval would predict nothing.
   */
  classifierModel?: string;
}

export interface BuildOutput {
  sessionId: string | null;
  skeleton: SkeletonResult;
  summary: string | null;
}

export async function buildTask(input: BuildInput): Promise<BuildOutput> {
  const { workspace, task } = input;
  mkdirSync(join(workspace, ".pipeline"), { recursive: true });

  // BUILD_CONTRACT is injected through the SDK's systemPrompt.append (see session.ts), NOT
  // written to CLAUDE.md in the task tree.
  //
  // It used to be a CLAUDE.md, on the reasoning that a long build compacts and compaction
  // summarises away the opening prompts, whereas CLAUDE.md is re-read every request. The
  // reasoning was right; the mechanism was fatal. lint.ts blocks CLAUDE.md inside a task
  // ("must not ship inside the task — it is a High-severity reviewer flag"), and the gate
  // lints the workspace — so every build wrote a file that guaranteed its own gate failure,
  // then burned all three fix attempts and landed in FAILED.
  //
  // The system prompt is the better home anyway: it is not part of the conversation, so
  // compaction cannot touch it, and it never ends up in the zip.
  const stale = join(workspace, "CLAUDE.md");
  if (existsSync(stale)) rmSync(stale, { force: true });

  // Open a VS Code window on this task, if configured. The SDK still drives the build — this
  // is a viewer. Because the SDK's session lands in this workspace's own Claude project
  // store, the extension's Claude panel shows you this build's conversation.
  if (input.openEditor) {
    void openInEditor(workspace, (m) => void input.onProgress?.(m));
  }

  const skeleton = await seedSkeleton(workspace);
  if (skeleton.source === "zip") {
    await input.onProgress?.(
      `seeded skeleton (${skeleton.seeded.length} files)` +
        (skeleton.patched.length ? ` · patched ${skeleton.patched.join(", ")}` : ""),
    );
  }

  // A recorded session id is worthless without its transcript. If the workspace came from
  // another machine, the id is a ghost: resuming it fails, and — the subtle part — trusting
  // it would let the STUDY_DONE marker below skip the playbook turn, because that marker
  // means "the session that is about to build this has read the playbook". If that session
  // is gone, nothing has read it, and we would build ungrounded.
  let sessionId = input.resuming ? (input.sessionId ?? null) : null;
  if (sessionId && !sessionExists(workspace, sessionId)) {
    await input.onProgress?.(
      `recorded session ${sessionId.slice(0, 8)} is not on this machine — rebuilding from a fresh session`,
    );
    sessionId = null;
  }

  // ---- Turn 1: study the playbook -----------------------------------------
  // The playbook is 52 KB. It goes on disk and the prompt points at it, rather than being
  // pasted into the message: Claude reads files perfectly well, and this keeps the prompt
  // small and the transcript readable.
  //
  // The marker only means "the session that is about to build this has already read the
  // playbook". If we are NOT resuming a session, whatever read it is gone, and skipping the
  // study turn would build ungrounded against a fresh context — which is the one failure
  // mode that produces a confidently-wrong task the gate cannot catch.
  const studyMarker = join(workspace, ".pipeline", "STUDY_DONE");
  if (!sessionId || !existsSync(studyMarker)) {
    writeFileSync(join(workspace, ".pipeline", "TERMINUS_PLAYBOOK.md"), loadSummary(), "utf8");
    await input.onProgress?.("turn 1: studying the playbook");

    const study = await runTurn({
      prompt: render("01-study.md", {
        summary: "See `.pipeline/TERMINUS_PLAYBOOK.md` in this workspace. Read it in full.",
      }),
      cwd: workspace,
      resume: sessionId,
      append: BUILD_CONTRACT,
      timeoutMin: input.studyTimeoutMin,
      label: "studying playbook",
      onSessionId: async (id) => {
        sessionId = id;
        await input.onSessionId(id);
      },
      onProgress: input.onProgress,
    });
    sessionId = study.sessionId ?? sessionId;
    // We write the marker, not Claude. A sentinel Claude has to remember to write is a
    // sentinel it can forget to write.
    writeFileSync(studyMarker, new Date().toISOString(), "utf8");
    await input.onProgress?.(`playbook read · $${study.costUsd.toFixed(2)}`);
  }

  // ---- Turn 2: THE DESIGN GATE --------------------------------------------
  //
  // State the design; have it classified; only then build. This exists because a task was
  // rejected four times, and every rejection arrived only AFTER a full build turn — one of
  // which ran eighteen minutes. Between them the session rebuilt the task from scratch twice,
  // into three unrelated deliverables, all graded "the agent's output matches a reference",
  // which is data-processing and is blocked. The domain moved every time. The grading axis
  // never moved once.
  //
  // Every fact the classifier used to reject those builds was present before a single file
  // was written. So we ask for those facts first. A blocked design now costs a paragraph.
  const toml = toTaskToml(task);
  const design = await runDesignGate({
    workspace,
    declared: toml.category,
    ledger: input.rejectedDesigns ?? [],
    maxRounds: input.designRounds ?? 4,
    model: input.classifierModel,
    resume: sessionId,
    onSessionId: async (id) => { sessionId = id; await input.onSessionId(id); },
    onProgress: input.onProgress,
    timeoutMin: input.designTimeoutMin ?? 15,
  });

  // ---- Turn 3: build the task ---------------------------------------------
  const build = await runTurn({
    prompt: render("02-build.md", {
      title: task.title,
      category: task.category,
      sub_category: task.sub_category,
      languages: task.languages,
      description: task.description,
      additional_note: task.additional_note,
      toml_category: toml.category,
      toml_subcategories: JSON.stringify(toml.subcategories),
      toml_languages: JSON.stringify(toml.languages),
      workspace,
      // The build session has never, until now, been shown the authoritative definition of the
      // category it is building for. categorySpec() was called in exactly one place: inside the
      // FAILURE message, after the task had already been built and rejected. Telling a session
      // what its category requires only once it has got it wrong is not a system, it is a scold.
      categorySpec: categorySpecText(toml.category),
      // The design it just committed to, and cleared the classifier with. The build's job is to
      // realise THIS, not to reopen the question.
      approvedDesign: designSummary(design),
    }),
    cwd: workspace,
    resume: sessionId,
    append: BUILD_CONTRACT,
    timeoutMin: input.buildTimeoutMin,
    label: "building",
    onSessionId: async (id) => {
      sessionId = id;
      await input.onSessionId(id);
    },
    onProgress: input.onProgress,
  });
  sessionId = build.sessionId ?? sessionId;
  await input.onProgress?.(
    `build turn done · ${build.toolCalls} tool calls · $${build.costUsd.toFixed(2)}`,
  );

  // ---- Evidence, not assertions -------------------------------------------
  // Two ways this can be a lie: files missing, or files present but still the skeleton's.
  // The second is the dangerous one — see buildAlreadyComplete() above.
  let missing = missingFromManifest(workspace);
  let untouched = unchangedFromSkeleton(workspace);

  if (missing.length || untouched.length) {
    const complaint = [
      ...missing.map((f) => `- ${f} does not exist`),
      ...untouched.map((f) => `- ${f} is still the untouched skeleton stub (the hello-world placeholder)`),
    ].join("\n");
    await input.onProgress?.(`build not real yet — asking once more:\n${complaint}`);

    await runTurn({
      prompt:
        `The task tree is not built. Specifically:\n\n${complaint}\n\n` +
        `The skeleton you were given is a hello-world placeholder ("write Hello, world! to ` +
        `hello.txt"). It is NOT the task. Replace it: write the real instruction.md, the real ` +
        `solution, and real tests for the task described earlier, to the standard in CLAUDE.md. ` +
        `Do not explain what you would do; write the files.`,
      cwd: workspace,
      resume: sessionId,
      append: BUILD_CONTRACT,
      timeoutMin: input.buildTimeoutMin,
      label: "completing the build",
      onProgress: input.onProgress,
    });

    missing = missingFromManifest(workspace);
    untouched = unchangedFromSkeleton(workspace);
    if (missing.length || untouched.length) {
      throw new BuildIncomplete([
        ...missing,
        ...untouched.map((f) => `${f} (still the skeleton stub)`),
      ]);
    }
  }

  // Only now is the build real. The marker is what crash recovery trusts.
  writeFileSync(join(workspace, ".pipeline", "BUILD_DONE"), new Date().toISOString(), "utf8");

  return { sessionId, skeleton, summary: build.text.split("\n")[0] ?? null };
}

/** Feed a failure back into the SAME conversation. The gate, not Claude, decides if it's fixed. */
export async function fixTask(args: {
  workspace: string;
  sessionId: string | null;
  template: "03-fix.md" | "05-feedback-fix.md" | "06-revise.md" | "07-rubric-fix.md";
  vars: Record<string, string | number>;
  timeoutMin: number;
  onProgress?: (msg: string) => Promise<void>;
}): Promise<void> {
  const r = await runTurn({
    prompt: render(args.template, { workspace: args.workspace, ...args.vars }),
    cwd: args.workspace,
    resume: args.sessionId,
    append: BUILD_CONTRACT,
    timeoutMin: args.timeoutMin,
    label: "fixing",
    onProgress: args.onProgress,
  });
  await args.onProgress?.(`fix turn done · ${r.toolCalls} tool calls · $${r.costUsd.toFixed(2)}`);

  const missing = missingFromManifest(args.workspace);
  if (missing.length) throw new BuildIncomplete(missing);
}
