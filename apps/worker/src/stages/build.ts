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
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { render, loadSummary, BUILD_CONTRACT } from "../claude/prompts.ts";
import { runTurn } from "../claude/session.ts";
import { toTaskToml } from "../../../../packages/shared/src/taxonomy.ts";
import type { ParsedTask } from "../../../../packages/shared/src/parse-task-blob.ts";
import { seedSkeleton, type SkeletonResult } from "./skeleton.ts";

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
}

export interface BuildOutput {
  sessionId: string | null;
  skeleton: SkeletonResult;
  summary: string | null;
}

export async function buildTask(input: BuildInput): Promise<BuildOutput> {
  const { workspace, task } = input;
  mkdirSync(join(workspace, ".pipeline"), { recursive: true });

  // Compaction summarises away the opening prompts on a long build, but CLAUDE.md is
  // re-injected on every request. This is the set of rules that has to survive that.
  // (It only reaches Claude because session.ts sets settingSources: ['project'].)
  writeFileSync(join(workspace, "CLAUDE.md"), BUILD_CONTRACT + "\n", "utf8");

  const skeleton = await seedSkeleton(workspace);
  if (skeleton.source === "zip") {
    await input.onProgress?.(
      `seeded skeleton (${skeleton.seeded.length} files)` +
        (skeleton.patched.length ? ` · patched ${skeleton.patched.join(", ")}` : ""),
    );
  }

  let sessionId = input.resuming ? (input.sessionId ?? null) : null;

  // ---- Turn 1: study the playbook -----------------------------------------
  // The playbook is 52 KB. It goes on disk and the prompt points at it, rather than being
  // pasted into the message: Claude reads files perfectly well, and this keeps the prompt
  // small and the transcript readable.
  const studyMarker = join(workspace, ".pipeline", "STUDY_DONE");
  if (!existsSync(studyMarker)) {
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

  // ---- The manifest is the evidence ---------------------------------------
  let missing = missingFromManifest(workspace);
  if (missing.length) {
    await input.onProgress?.(`incomplete: ${missing.join(", ")} — asking once more`);
    await runTurn({
      prompt:
        `The task tree is incomplete. These required files do not exist yet:\n\n` +
        missing.map((f) => `- ${f}`).join("\n") +
        `\n\nCreate them now, in this workspace, to the standard in CLAUDE.md. ` +
        `Do not explain what you would do; write the files.`,
      cwd: workspace,
      resume: sessionId,
      append: BUILD_CONTRACT,
      timeoutMin: input.buildTimeoutMin,
      label: "completing manifest",
      onProgress: input.onProgress,
    });
    missing = missingFromManifest(workspace);
    if (missing.length) throw new BuildIncomplete(missing);
  }

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
