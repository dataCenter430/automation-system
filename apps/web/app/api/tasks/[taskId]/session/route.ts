/**
 * The live session view — what replaced watching the VS Code window.
 *
 * The old build path drove a real VS Code window so a human could see the prompt go in and
 * the work come out. Going headless bought us Linux support and 8 concurrent builds, but it
 * took that away, and a heartbeat saying "building · 8m · 4 tool calls" is not visibility.
 *
 * Nothing is actually hidden, though: the Agent SDK writes the COMPLETE transcript of every
 * session to ~/.claude/projects/<cwd with non-alphanumerics as '-'>/<session-id>.jsonl —
 * the exact prompt we sent, every message Claude wrote, every tool call with its input, and
 * every result. This route parses that file and hands it to the dashboard, so you can watch
 * all 8 builds at once instead of the one that happened to have window focus.
 *
 * Read-only. It never writes, and it never touches the pipeline.
 */
import { NextResponse } from "next/server";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { db } from "../../../../../../../packages/shared/src/supabase.ts";
import { REPO_ROOT, expandPath } from "../../../../../../../packages/shared/src/paths.ts";

export const dynamic = "force-dynamic";

/** Same encoding Claude Code uses for its per-project transcript directory. */
function transcriptPath(workspace: string, sessionId: string): string {
  const dir = resolve(workspace).replace(/[^a-zA-Z0-9]/g, "-");
  return join(homedir(), ".claude", "projects", dir, `${sessionId}.jsonl`);
}

function workspaceRoot(): string {
  try {
    const cfg = JSON.parse(readFileSync(resolve(REPO_ROOT, "config/pipeline.json"), "utf8"));
    return expandPath(cfg.paths.workspace);
  } catch {
    return resolve(REPO_ROOT, "workspace");
  }
}

type Turn =
  | { kind: "prompt"; at: string | null; text: string }
  | { kind: "text"; at: string | null; text: string }
  | { kind: "thinking"; at: string | null; text: string }
  | { kind: "tool"; at: string | null; name: string; detail: string; input: string }
  | { kind: "result"; at: string | null; ok: boolean; text: string }
  | { kind: "cost"; at: string | null; usd: number; turns: number };

/** A short, readable label for a tool call — the same shape the worker logs. */
function detailOf(name: string, i: any): string {
  const short = (p: unknown) => String(p ?? "").split("/").slice(-2).join("/");
  switch (name) {
    case "Bash": return String(i?.command ?? "").replace(/\s+/g, " ").slice(0, 120);
    case "Write": case "Edit": case "MultiEdit": case "Read": return short(i?.file_path);
    case "Glob": case "Grep": return String(i?.pattern ?? "").slice(0, 60);
    default: return "";
  }
}

function textOf(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b: any) => b?.type === "text").map((b: any) => b.text ?? "").join("\n").trim();
}

export async function GET(_req: Request, ctx: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await ctx.params;

  const { data: row, error } = await db()
    .from("terminus")
    .select("slug, claude_session_id")
    .eq("task_id", taskId)
    .single();

  if (error || !row) return NextResponse.json({ error: "task not found" }, { status: 404 });
  if (!row.slug) return NextResponse.json({ turns: [], note: "no workspace yet" });
  if (!row.claude_session_id) {
    return NextResponse.json({ turns: [], note: "no Claude session has started for this task yet" });
  }

  const ws = join(workspaceRoot(), row.slug);
  const file = transcriptPath(ws, row.claude_session_id);

  if (!existsSync(file)) {
    return NextResponse.json({
      turns: [],
      note:
        `No transcript at ${file}. Either the session has not written anything yet, or it ` +
        `belongs to a different machine (a workspace copied from elsewhere carries a session ` +
        `id whose conversation did not come with it).`,
    });
  }

  const turns: Turn[] = [];
  let cost = 0;
  let numTurns = 0;

  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let m: any;
    try { m = JSON.parse(line); } catch { continue; }
    const at = m.timestamp ?? null;

    // What WE sent — this is the prompt the old VS Code panel showed you being typed in.
    if (m.type === "user" && m.message?.content) {
      const c = m.message.content;
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b?.type === "tool_result") {
            const t = typeof b.content === "string" ? b.content : textOf(b.content);
            turns.push({ kind: "result", at, ok: !b.is_error, text: String(t).slice(0, 2000) });
          } else if (b?.type === "text") {
            turns.push({ kind: "prompt", at, text: String(b.text).slice(0, 20000) });
          }
        }
      } else if (typeof c === "string") {
        turns.push({ kind: "prompt", at, text: c.slice(0, 20000) });
      }
      continue;
    }

    if (m.type === "assistant" && Array.isArray(m.message?.content)) {
      for (const b of m.message.content) {
        if (b?.type === "text" && String(b.text).trim()) {
          turns.push({ kind: "text", at, text: String(b.text).slice(0, 8000) });
        } else if (b?.type === "thinking" && String(b.thinking ?? "").trim()) {
          turns.push({ kind: "thinking", at, text: String(b.thinking).slice(0, 4000) });
        } else if (b?.type === "tool_use") {
          turns.push({
            kind: "tool", at,
            name: String(b.name),
            detail: detailOf(String(b.name), b.input),
            input: JSON.stringify(b.input ?? {}, null, 1).slice(0, 3000),
          });
        }
      }
      continue;
    }

    if (m.type === "result") {
      cost = Number(m.total_cost_usd ?? cost);
      numTurns = Number(m.num_turns ?? numTurns);
      turns.push({ kind: "cost", at, usd: cost, turns: numTurns });
    }
  }

  return NextResponse.json({
    turns,
    sessionId: row.claude_session_id,
    workspace: ws,
    transcript: file,
    bytes: statSync(file).size,
    costUsd: cost,
  });
}
