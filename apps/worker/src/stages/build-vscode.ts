/**
 * The visual build stage.
 *
 * Seeds the skeleton, opens VS Code on the task workspace, starts a NEW Claude conversation
 * in the extension, and sends the two prompts. The human watches it all happen.
 *
 * Completion is NOT read off the screen. Each turn ends when Claude writes its sentinel file
 * AND the required files exist on disk (see ../vscode/watch.ts). If the sentinel never
 * arrives, or arrives while the task is incomplete, the stage fails loudly instead of
 * handing a half-built task to the Docker gate.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { render, loadSummary, BUILD_CONTRACT } from "../claude/prompts.ts";
import { toTaskToml } from "../../../../packages/shared/src/taxonomy.ts";
import type { ParsedTask } from "../../../../packages/shared/src/parse-task-blob.ts";
import { openWorkspace, newConversation, sendPrompt } from "../vscode/ui.ts";
import { waitForTurn, clearSentinel, findSession, type WatchResult } from "../vscode/watch.ts";
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

export class BuildIncomplete extends Error {
  watch: WatchResult;
  constructor(watch: WatchResult) {
    super(watch.reason);
    this.name = "BuildIncomplete";
    this.watch = watch;
  }
}

export interface VsBuildInput {
  task: ParsedTask;
  slug: string;
  workspace: string; // absolute
  studyTimeoutMin: number;
  buildTimeoutMin: number;
  onSessionId: (id: string) => Promise<void>;
  onProgress?: (msg: string) => Promise<void>;
  /** True when resuming: the conversation already exists, don't start a new one. */
  resuming?: boolean;
}

export interface VsBuildOutput {
  sessionId: string | null;
  skeleton: SkeletonResult;
  summary: string | null;
}

export async function buildTaskVisually(input: VsBuildInput): Promise<VsBuildOutput> {
  const { workspace, task } = input;
  mkdirSync(workspace, { recursive: true });

  // Compaction summarises away the opening prompts on a long build, but CLAUDE.md is
  // re-injected on every request. This is the set of rules that has to survive that.
  writeFileSync(join(workspace, "CLAUDE.md"), BUILD_CONTRACT + "\n", "utf8");

  const skeleton = await seedSkeleton(workspace);
  if (skeleton.source === "zip") {
    await input.onProgress?.(
      `seeded skeleton (${skeleton.seeded.length} files)` +
        (skeleton.patched.length ? ` · patched ${skeleton.patched.join(", ")}` : ""),
    );
  }

  const toml = toTaskToml(task);

  await openWorkspace(workspace);
  await input.onProgress?.("VS Code open — starting a new Claude conversation");

  if (!input.resuming) {
    await newConversation(workspace);
  }

  // ---- Prompt 1: study the playbook ---------------------------------------
  if (!existsSync(join(workspace, ".pipeline", "STUDY_DONE"))) {
    clearSentinel(workspace, "STUDY_DONE"); // a stale sentinel would "finish" this instantly
    // Write the playbook into the workspace and REFERENCE it, rather than embedding 52 KB
    // in a chat message. Claude reads files perfectly well, and this keeps every prompt
    // small enough to type - no clipboard, which on this machine is permanently contended.
    writeFileSync(join(workspace, ".pipeline", "TERMINUS_PLAYBOOK.md"), loadSummary(), "utf8");
    await sendPrompt(
      workspace,
      render("01-study.md", { summary: "See `.pipeline/TERMINUS_PLAYBOOK.md` in this workspace. Read it in full." }),
      "PROMPT_01_STUDY",
    );
    await input.onProgress?.("prompt 1 sent (playbook) — watching for STUDY_DONE");

    const study = await waitForTurn({
      workspace,
      sentinelName: "STUDY_DONE",
      timeoutMin: input.studyTimeoutMin,
      onHeartbeat: async (h) => {
        await input.onProgress?.(`studying playbook · ${h.elapsedSec}s · ${h.toolCalls} tool calls`);
      },
    });
    if (!study.done) throw new BuildIncomplete(study);

    const s = findSession(workspace);
    if (s) await input.onSessionId(s.sessionId);
  }

  // ---- Prompt 2: build the task -------------------------------------------
  clearSentinel(workspace, "BUILD_DONE");
  await sendPrompt(workspace, render("02-build.md", {
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
  }), "PROMPT_02_BUILD");
  await input.onProgress?.("prompt 2 sent (task spec) — Claude is building");

  const build = await waitForTurn({
    workspace,
    sentinelName: "BUILD_DONE",
    timeoutMin: input.buildTimeoutMin,
    requireFiles: MANIFEST,
    onHeartbeat: async (h) => {
      await input.onProgress?.(
        `building · ${Math.floor(h.elapsedSec / 60)}m${h.elapsedSec % 60}s · ${h.toolCalls} tool calls` +
          (h.idleSec > 120 ? ` · idle ${h.idleSec}s` : ""),
      );
    },
  });
  if (!build.done) throw new BuildIncomplete(build);

  const session = findSession(workspace);
  if (session) await input.onSessionId(session.sessionId);

  return {
    sessionId: session?.sessionId ?? null,
    skeleton,
    summary: build.sentinelText,
  };
}

/** Feed a failure back into the SAME visible conversation. */
export async function fixTaskVisually(args: {
  workspace: string;
  template: "03-fix.md" | "05-feedback-fix.md";
  vars: Record<string, string | number>;
  timeoutMin: number;
  onProgress?: (msg: string) => Promise<void>;
}): Promise<WatchResult> {
  clearSentinel(args.workspace, "BUILD_DONE");

  await openWorkspace(args.workspace); // no-op if already open
  await sendPrompt(
    args.workspace,
    render(args.template, { workspace: args.workspace, ...args.vars }),
    "PROMPT_03_FIX",
  );
  await args.onProgress?.("failure pasted into the Claude conversation — watching for BUILD_DONE");

  const r = await waitForTurn({
    workspace: args.workspace,
    sentinelName: "BUILD_DONE",
    timeoutMin: args.timeoutMin,
    requireFiles: MANIFEST,
    onHeartbeat: async (h) => {
      await args.onProgress?.(`fixing · ${h.elapsedSec}s · ${h.toolCalls} tool calls`);
    },
  });
  if (!r.done) throw new BuildIncomplete(r);
  return r;
}
