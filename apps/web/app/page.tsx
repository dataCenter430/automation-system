"use client";

import { useCallback, useState } from "react";
import { AwaitingHuman } from "./components/AwaitingHuman";
import { GateVerdict } from "./components/GateVerdict";
import { QuestionCard } from "./components/QuestionCard";
import { TaskTable } from "./components/TaskTable";
import { SessionView } from "./components/SessionView";
import {
  CLAUDE_LIVE, TASK_STATUS, stateMeta, useFleetData, type EventRow, type Task,
} from "./components/Shell";

/**
 * The dashboard. Three regions, one question each:
 *
 *   LEFT   is anything waiting on me?          (AwaitingHuman)
 *   CENTRE what is the fleet doing?            (TaskTable, and the transcript of the selected row)
 *   RIGHT  why did that gate go red?           (GateVerdict)
 *
 * Tasks and fleet load are polled once, in the Shell, every 3s and handed down — the poller
 * is not duplicated here.
 */
export default function Dashboard() {
  const { tasks, events, error, refresh } = useFleetData();
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  /**
   * The three human transitions. Every one is guarded server-side by the state it expects,
   * so a stale tab clicking twice cannot do anything unexpected — a 409 comes back and says
   * the task moved while you were looking at it.
   */
  const act = useCallback(
    async (taskId: string, action: "start" | "approve" | "approve_review" | "retry") => {
      setBusy(taskId);
      try {
        const r = await fetch(`/api/tasks/${taskId}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action }),
        });
        if (!r.ok) alert((await r.json()).error);
      } catch (e) {
        alert((e as Error).message);
      } finally {
        setBusy(null);
        refresh();
      }
    },
    [refresh],
  );

  const sel = tasks.find((t) => t.task_id === selected) ?? null;

  return (
    <>
      {error && (
        <div
          style={{
            background: "rgba(244, 63, 94, 0.08)", border: "1px solid var(--bad)", color: "var(--bad)",
            padding: "10px 12px", borderRadius: 8, marginBottom: 14, fontSize: 13,
          }}
        >
          {error}
        </div>
      )}

      <div className="grid">
        <AwaitingHuman
          tasks={tasks}
          onAct={act}
          busy={busy}
          selected={selected}
          onSelect={(id) => setSelected(id)}
        />

        {/* THE TABLE gets the full width, above everything else. It is the thing you SCAN —
            eight rows, six columns, every one of them a number or a state you are comparing
            ACROSS rows. That comparison is the only reason it exists, and a narrow middle
            column would cost it. */}
        <div className="table" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Except for this. A question is a live Claude session frozen mid-turn, holding a
              build slot — the one thing on this page where YOUR silence is actively costing
              something. It outranks the table. */}
          {tasks
            .filter((t) => t.question)
            .map((t) => (
              <QuestionCard key={t.question!.id} task={t} q={t.question!} onAnswered={refresh} />
            ))}

          <TaskTable tasks={tasks} selected={selected} onSelect={setSelected} onAct={act} busy={busy} />
        </div>

        {/* Below it, side by side: what happened to the row you just clicked. The transcript
            and the gate verdict answer the same question and are read together. */}
        <div className="main" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {sel && <Detail t={sel} events={events} />}
        </div>

        <GateVerdict taskId={selected} />
      </div>
    </>
  );
}

/**
 * The selected task, in full: what it is, what went wrong (verbatim), what happened (the
 * event log), and what Claude actually did (the transcript).
 */
function Detail({ t, events }: { t: Task; events: EventRow[] }) {
  const meta = stateMeta(t.pipeline_state);
  const failed = t.pipeline_state === -1 || t.pipeline_state === -2;
  const mine = events.filter((e) => e.task_id === t.task_id).slice(0, 12);

  const bits: string[] = [`snorkel: ${TASK_STATUS[t.task_status] ?? t.task_status}`];
  if (t.claude_session_id) bits.push(`session ${t.claude_session_id.slice(0, 8)}`);
  if (t.zip_path) bits.push(`zip ${t.zip_path.split(/[\\/]/).pop()}`);
  if (t.assignment_id) bits.push(`assignment ${t.assignment_id.slice(0, 8)}`);

  return (
    <section
      style={{
        background: "var(--panel)", border: "1px solid var(--line)",
        borderLeft: `3px solid ${meta.color}`, borderRadius: 10, padding: 14,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
        <span className="mono" style={{ fontSize: 13 }}>
          {t.slug ?? t.task_id.slice(0, 8)}
        </span>
        <span className="pill" style={{ color: meta.color }}>
          <span className={meta.live ? "dot pulse" : "dot"} />
          {meta.name}
        </span>
        <span style={{ fontSize: 12, color: "var(--dim)" }}>{meta.hint}</span>
      </div>

      <div style={{ fontSize: 12.5, color: "var(--dim)", marginTop: 5 }}>{t.title}</div>
      <div className="mono" style={{ fontSize: 10.5, color: "var(--dim)", marginTop: 5 }}>
        {bits.join("  ·  ")}
      </div>

      {/* last_error, exactly as the pipeline wrote it. Not summarised, not truncated — the
          stack trace or the CDP error IS the debugging information. */}
      {failed && t.last_error && (
        <pre
          className="mono"
          style={{
            marginTop: 11, padding: "9px 11px",
            background: "rgba(244, 63, 94, 0.07)", border: "1px solid var(--bad)",
            borderRadius: 6, color: "var(--bad)", fontSize: 11,
            whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 220, overflow: "auto",
          }}
        >
          {t.last_error}
        </pre>
      )}

      {/* The Log: the event stream, per task. */}
      <div style={{ marginTop: 13, borderTop: "1px solid var(--line)", paddingTop: 10 }}>
        <div className="hdr" style={{ marginBottom: 7 }}>Log</div>
        {mine.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--dim)" }}>No events yet.</div>
        ) : (
          <div style={{ maxHeight: 160, overflow: "auto" }}>
            {mine.map((e) => (
              <div key={e.id} className="mono" style={{ display: "flex", gap: 9, fontSize: 11, padding: "2px 0" }}>
                <span className="num" style={{ color: "var(--dim)", minWidth: 58, flexShrink: 0 }}>
                  {new Date(e.created_at).toLocaleTimeString([], {
                    hour: "2-digit", minute: "2-digit", second: "2-digit",
                  })}
                </span>
                <span style={{ color: "var(--dim)", minWidth: 66, flexShrink: 0 }}>{e.stage}</span>
                <span
                  style={{
                    color:
                      e.status === "failed" ? "var(--bad)"
                      : e.status === "completed" ? "var(--ok)"
                      : "var(--dim)",
                    minWidth: 0, wordBreak: "break-word",
                  }}
                >
                  {e.message ?? e.status}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* The transcript. SessionView already renders the prompt, every tool call and its
          result, the cost and the model badge — and it polls only while the build is live. */}
      <div style={{ marginTop: 13, borderTop: "1px solid var(--line)", paddingTop: 10 }}>
        <div className="hdr" style={{ marginBottom: 7 }}>Session</div>
        <SessionView taskId={t.task_id} live={CLAUDE_LIVE.has(t.pipeline_state)} slug={t.slug} />
      </div>
    </section>
  );
}
