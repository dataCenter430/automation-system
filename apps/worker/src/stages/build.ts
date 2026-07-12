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
    openInEditor(workspace, (m) => void input.onProgress?.(m));
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

  // ---- Turn 2: build the task ---------------------------------------------
  const toml = toTaskToml(task);
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
  template: "03-fix.md" | "05-feedback-fix.md";
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
