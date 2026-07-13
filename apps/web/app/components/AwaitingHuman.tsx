"use client";

import { fmtElapsed, sinceOf, stateMeta, useNow, type Task } from "./Shell";

/**
 * AWAITING HUMAN — the rail that answers "is anything waiting on me?"
 *
 * Three states park a task in front of a person, and the action is different for each:
 *
 *   AWAITING_APPROVAL (70) → APPROVE & SUBMIT. The ONLY irreversible action in the system,
 *                            so it is the only one behind a confirm(), and it is offered
 *                            NOWHERE ELSE — a task not at 70 cannot be submitted from here.
 *   NEEDS_HUMAN      (-2)  → RETRY. It stopped and refused to guess. Go and look first.
 *   FAILED           (-1)  → RETRY. It died. last_error says why, verbatim, on its row.
 *
 * Note what is NOT here: DRAFT. A draft is inert, not waiting — it is waiting for nothing,
 * because nobody has asked for it to run. Start Build lives on the row, next to the task it
 * would spend money on.
 */

/** The states that genuinely block on a person. Everything else resolves itself. */
const BLOCKED_ON_YOU = [70, -2, -1];

export function AwaitingHuman({
  tasks, onAct, busy, selected, onSelect,
}: {
  tasks: Task[];
  onAct: (taskId: string, action: "approve" | "retry") => void;
  busy: string | null;
  selected: string | null;
  onSelect: (taskId: string) => void;
}) {
  const now = useNow();

  // 70 first: an approval is a person standing still, waiting. A failure is already stopped.
  const waiting = tasks
    .filter((t) => BLOCKED_ON_YOU.includes(t.pipeline_state))
    .sort((a, b) => BLOCKED_ON_YOU.indexOf(a.pipeline_state) - BLOCKED_ON_YOU.indexOf(b.pipeline_state));

  return (
    <section
      className="rail"
      style={{ background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 10, padding: 14 }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <span className="hdr">Awaiting human</span>
        <span
          className="mono num"
          style={{
            fontSize: 10, minWidth: 18, textAlign: "center",
            color: waiting.length ? "var(--bad)" : "var(--dim)",
            border: `1px solid ${waiting.length ? "var(--bad)" : "var(--line)"}`,
            borderRadius: 4, padding: "2px 5px",
          }}
        >
          {waiting.length}
        </span>
      </div>

      {waiting.length === 0 ? (
        <p style={{ margin: 0, fontSize: 12.5, color: "var(--dim)", lineHeight: 1.6 }}>
          Nothing is waiting on you. Every task is either inert, running, or done — the fleet will
          tell you the moment one needs a decision.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {waiting.map((t) => {
            const meta = stateMeta(t.pipeline_state);
            const since = sinceOf(t);
            const isSelected = selected === t.task_id;
            const approve = t.pipeline_state === 70;

            return (
              <div
                key={t.task_id}
                onClick={() => onSelect(t.task_id)}
                className="row"
                style={{
                  cursor: "pointer",
                  background: isSelected ? "var(--panel2)" : "transparent",
                  border: "1px solid var(--line)",
                  borderLeft: `3px solid ${isSelected ? "var(--brand)" : meta.color}`,
                  borderRadius: 6, padding: "9px 10px",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <span className="pill" style={{ color: meta.color }}>
                    <span className={meta.live ? "dot pulse" : "dot"} />
                    {meta.name}
                  </span>
                  <span className="mono num" style={{ fontSize: 10, color: "var(--dim)", marginLeft: "auto" }}>
                    {fmtElapsed(since === null ? null : now - since)}
                  </span>
                </div>

                <div
                  className="mono"
                  style={{
                    fontSize: 12, color: "var(--text)", marginBottom: 8,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}
                  title={t.title}
                >
                  {t.slug ?? t.task_id.slice(0, 8)}
                </div>

                {approve ? (
                  <button
                    className="mono"
                    disabled={busy === t.task_id}
                    onClick={(e) => {
                      e.stopPropagation();
                      // The one click that cannot be taken back.
                      if (confirm("Submit to Snorkel? This cannot be undone.")) onAct(t.task_id, "approve");
                    }}
                    style={{
                      width: "100%", padding: "7px 10px", fontSize: 10, letterSpacing: "0.1em",
                      textTransform: "uppercase", fontWeight: 700,
                      background: "var(--grad-approve)", color: "#04220f", border: "none",
                    }}
                  >
                    Approve &amp; Submit
                  </button>
                ) : (
                  <button
                    className="mono"
                    disabled={busy === t.task_id}
                    onClick={(e) => {
                      e.stopPropagation();
                      onAct(t.task_id, "retry");
                    }}
                    style={{
                      width: "100%", padding: "7px 10px", fontSize: 10, letterSpacing: "0.1em",
                      textTransform: "uppercase", fontWeight: 700,
                      background: "var(--panel2)", color: "var(--text)", border: "1px solid var(--line)",
                    }}
                  >
                    Retry
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      <a
        href="/tasks"
        className="mono"
        style={{
          display: "block", marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--line)",
          fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase",
          color: "var(--brand)", textDecoration: "none",
        }}
      >
        + New task
      </a>
    </section>
  );
}
