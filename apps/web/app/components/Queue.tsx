"use client";

import { Fragment, useState } from "react";
import { SessionView } from "./SessionView";
import {
  CLAUDE_LIVE,
  TASK_STATUS,
  fmtElapsed,
  sinceOf,
  stateMeta,
  useNow,
  type EventRow,
  type Task,
} from "./Shell";

/**
 * The queue table. RESTYLED, NOT RETHOUGHT — every action, every state and every counter
 * that was here before is still here. Two buttons are the whole system:
 *
 *   Start Build      — the ONLY thing that moves a task off DRAFT (0). Nothing spends a
 *                      Claude session or a Docker build until a human presses it.
 *   Approve & Submit — the ONLY irreversible click in the system. Offered on
 *                      AWAITING_APPROVAL (70) alone, and only behind a confirm().
 *   Retry            — FAILED (-1) and NEEDS_HUMAN (-2) alone.
 *
 * The nineteen states, their colours and their names come from Shell's STATE_META, which
 * renders packages/shared/src/status.ts. They are NOT collapsed into running/done/error: the
 * operator's next move after VERIFY FAILED (wait, the fixer is coming) is the opposite of the
 * one after NEEDS HUMAN (get up and look), and a table that fused them would lie about
 * whether it needs you. The 3px left stripe repeats the state colour, which is how eight rows
 * get scanned without reading a word.
 */
export function Queue({
  tasks,
  events,
  onChanged,
}: {
  tasks: Task[];
  events: EventRow[];
  onChanged: () => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [session, setSession] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const now = useNow();

  async function act(taskId: string, action: string) {
    setBusy(taskId);
    const r = await fetch(`/api/tasks/${taskId}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    });
    setBusy(null);
    if (!r.ok) alert((await r.json()).error);
    onChanged();
  }

  return (
    <section style={{ minWidth: 0 }}>
      <style>{CSS}</style>

      <header style={{ display: "flex", alignItems: "baseline", gap: 9, marginBottom: 11 }}>
        <h2 className="hdr" style={{ margin: 0, color: "var(--text)", fontWeight: 600 }}>
          All tasks
        </h2>
        <span className="mono num" style={{ fontSize: 11, color: "var(--dim)" }}>
          {tasks.length}
        </span>
      </header>

      {!tasks.length ? (
        <div
          className="mono"
          style={{
            background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 10,
            padding: "56px 0", textAlign: "center", color: "var(--dim)", fontSize: 12,
          }}
        >
          Nothing queued yet.
          <div style={{ marginTop: 6, fontSize: 11, opacity: 0.7 }}>
            Paste a task blob on the left to add one.
          </div>
        </div>
      ) : (
        <div
          className="scroll-x"
          style={{ background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 10 }}
        >
          {/* The fixed columns sum to ~990, so TITLE keeps a usable share at ordinary widths and
              the table only scrolls inside itself on a genuinely narrow screen. */}
          <table style={{ width: "100%", minWidth: 1120, borderCollapse: "collapse", tableLayout: "fixed" }}>
            <colgroup>
              <col style={{ width: 170 }} />
              <col />
              <col style={{ width: 158 }} />
              <col style={{ width: 92 }} />
              <col style={{ width: 134 }} />
              <col style={{ width: 52 }} />
              <col style={{ width: 68 }} />
              <col style={{ width: 76 }} />
              <col style={{ width: 254 }} />
            </colgroup>

            <thead>
              <tr>
                <Th first>Slug</Th>
                <Th>Title</Th>
                <Th>State</Th>
                <Th>Attempts</Th>
                <Th>Model</Th>
                <Th num>Tools</Th>
                <Th num>Cost</Th>
                <Th num title="Time since this task last moved">Elapsed</Th>
                <Th right>Actions</Th>
              </tr>
            </thead>

            <tbody>
              {tasks.map((t) => {
                const st = stateMeta(t.pipeline_state);
                const mine = events.filter((e) => e.task_id === t.task_id).slice(0, 6);
                const isOpen = open === t.task_id;
                const isSession = session === t.task_id;
                const selected = isOpen || isSession;
                const failed = t.pipeline_state === -1 || t.pipeline_state === -2;
                const since = sinceOf(t);

                // Two models in one session means the pin in config/pipeline.json moved under a
                // running build. That is worth knowing, so it is --warn, not a quiet join.
                const multiModel = t.models?.length > 1;

                return (
                  <Fragment key={t.task_id}>
                    <tr className="row" style={selected ? { background: "var(--panel2)" } : undefined}>
                      {/* The 3px stripe IS the state, repeated. A selected row takes the brand
                          colour instead — brand marks selection, never a status. */}
                      <Td stripe={selected ? "var(--brand)" : st.color}>
                        <span
                          className="mono"
                          style={{ fontSize: 12, ...ELIDE }}
                          title={t.slug ?? t.task_id}
                        >
                          {t.slug ?? t.task_id.slice(0, 8)}
                        </span>
                      </Td>

                      <Td>
                        <span style={{ fontSize: 12.5, color: "var(--dim)", ...ELIDE }} title={t.title}>
                          {t.title}
                        </span>
                      </Td>

                      {/* The state, and nothing but the state. Its hint rides along as a tooltip
                          so it can never push the row past 40px. */}
                      <Td>
                        <span className="pill" style={{ color: st.color }} title={st.hint}>
                          <i className={st.live ? "dot pulse" : "dot"} />
                          {st.name}
                        </span>
                      </Td>

                      {/* The fixer gets three swings at each gate. Knowing you are on the last one
                          is the difference between waiting and getting up. */}
                      <Td>
                        <span className="mono num" style={{ fontSize: 10, color: "var(--dim)", display: "block" }}>
                          {t.attempt > 0 && <span style={{ display: "block" }}>verify {t.attempt + 1}/3</span>}
                          {t.feedback_attempt > 0 && (
                            <span style={{ display: "block" }}>feedback {t.feedback_attempt + 1}/3</span>
                          )}
                          {!t.attempt && !t.feedback_attempt && <span style={{ opacity: 0.45 }}>—</span>}
                        </span>
                      </Td>

                      {/* MODEL IS PROVENANCE, NOT A CHOICE. It is pinned in config/pipeline.json and
                          read back out of the session transcript: this is the model that ACTUALLY
                          ran, not the one someone picked in a form. */}
                      <Td>
                        <span
                          className="mono"
                          title={
                            multiModel
                              ? "More than one model ran in this session — the pin moved mid-build"
                              : t.model ?? "no session transcript on this machine"
                          }
                          style={{
                            fontSize: 10.5,
                            color: multiModel ? "var(--warn)" : "var(--dim)",
                            opacity: t.model ? 1 : 0.45,
                            ...ELIDE,
                          }}
                        >
                          {multiModel ? t.models.join(" + ") : t.model ?? "—"}
                        </span>
                      </Td>

                      <Td num>{t.toolCalls ?? "—"}</Td>

                      {/* A partial cost is a FLOOR (some model had no price), and says so. */}
                      <Td num warn={t.costPartial}>
                        {typeof t.costUsd === "number"
                          ? `$${t.costUsd.toFixed(2)}${t.costPartial ? "*" : ""}`
                          : "—"}
                      </Td>

                      <Td num>{since === null ? "—" : fmtElapsed(now - since)}</Td>

                      <td style={{ ...TD, paddingLeft: 8 }}>
                        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", alignItems: "center" }}>
                          {/* GATE 1 — DRAFT (0) ONLY. Nothing spends money before this click. */}
                          {t.pipeline_state === 0 && (
                            <button
                              className="btn"
                              style={{ ...B, background: "var(--grad-primary)", color: "#fff", border: "1px solid transparent", fontWeight: 600 }}
                              disabled={busy === t.task_id}
                              onClick={() => act(t.task_id, "start")}
                            >
                              Start Build
                            </button>
                          )}

                          {/* GATE 2 — AWAITING_APPROVAL (70) ONLY, behind a confirm(). The one
                              irreversible action in the system. */}
                          {t.pipeline_state === 70 && (
                            <button
                              className="btn"
                              style={{ ...B, background: "var(--grad-approve)", color: "#06210f", border: "1px solid transparent", fontWeight: 700 }}
                              disabled={busy === t.task_id}
                              onClick={() => {
                                if (confirm("Submit to Snorkel? This cannot be undone.")) act(t.task_id, "approve");
                              }}
                            >
                              Approve &amp; Submit
                            </button>
                          )}

                          {/* FAILED (-1) and NEEDS_HUMAN (-2) ONLY. */}
                          {failed && (
                            <button
                              className="btn"
                              style={{ ...B, background: "var(--panel2)", color: "var(--text)" }}
                              disabled={busy === t.task_id}
                              onClick={() => act(t.task_id, "retry")}
                            >
                              Retry
                            </button>
                          )}

                          {/* Watch Claude work. This replaced the VS Code window — and unlike the
                              window, every concurrent build can be open at once. */}
                          {t.claude_session_id && (
                            <button
                              className="btn"
                              style={{
                                ...B,
                                background: isSession ? "var(--run)" : "transparent",
                                color: isSession ? "#04141d" : "var(--run)",
                                border: "1px solid var(--run)",
                                fontWeight: 600,
                              }}
                              onClick={() => setSession(isSession ? null : t.task_id)}
                            >
                              {isSession ? "Hide" : "Session"}
                            </button>
                          )}

                          <button
                            className="btn"
                            style={{ ...B, background: "transparent", color: "var(--dim)" }}
                            onClick={() => setOpen(isOpen ? null : t.task_id)}
                          >
                            {isOpen ? "Hide" : "Log"}
                          </button>
                        </div>
                      </td>
                    </tr>

                    {/* last_error, VERBATIM. Not summarised, not truncated to a headline — the
                        gate report or the stack exactly as it was written. */}
                    {t.last_error && failed && (
                      <tr style={{ background: "var(--panel2)" }}>
                        <Expand color="var(--bad)">
                          <pre
                            className="mono"
                            style={{
                              padding: "9px 11px", background: "rgba(244,63,94,.07)",
                              border: "1px solid var(--bad)", borderRadius: 6, color: "var(--bad)",
                              fontSize: 11.5, lineHeight: 1.5, whiteSpace: "pre-wrap",
                              maxHeight: 180, overflow: "auto",
                            }}
                          >
                            {t.last_error.slice(0, 1200)}
                          </pre>
                        </Expand>
                      </tr>
                    )}

                    {isSession && (
                      <tr style={{ background: "var(--panel2)" }}>
                        <Expand color="var(--brand)">
                          <SessionView taskId={t.task_id} live={CLAUDE_LIVE.has(t.pipeline_state)} />
                        </Expand>
                      </tr>
                    )}

                    {/* The Log: the event stream for this task, newest first. */}
                    {isOpen && (
                      <tr style={{ background: "var(--panel2)" }}>
                        <Expand color="var(--brand)">
                          <Meta t={t} />
                          {mine.length === 0 ? (
                            <div className="mono" style={{ fontSize: 11.5, color: "var(--dim)" }}>
                              No events yet.
                            </div>
                          ) : (
                            mine.map((e) => (
                              <div
                                key={e.id}
                                className="mono"
                                style={{ display: "flex", gap: 10, fontSize: 11.5, lineHeight: 1.7 }}
                              >
                                <span className="num" style={{ color: "var(--dim)", minWidth: 62 }}>
                                  {new Date(e.created_at).toLocaleTimeString([], {
                                    hour: "2-digit", minute: "2-digit", second: "2-digit",
                                  })}
                                </span>
                                <span style={{ color: "var(--dim)", minWidth: 74 }}>{e.stage}</span>
                                <span
                                  style={{
                                    color:
                                      e.status === "failed" ? "var(--bad)"
                                      : e.status === "completed" ? "var(--ok)"
                                      : "var(--text)",
                                  }}
                                >
                                  {e.message ?? e.status}
                                </span>
                              </div>
                            ))
                          )}
                        </Expand>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Meta({ t }: { t: Task }) {
  const bits: string[] = [];
  bits.push(`snorkel: ${TASK_STATUS[t.task_status] ?? t.task_status}`);
  if (t.claude_session_id) bits.push(`session ${t.claude_session_id.slice(0, 8)}`);
  if (t.zip_path) bits.push(`zip ${t.zip_path.split(/[\\/]/).pop()}`);
  if (t.assignment_id) bits.push(`assignment ${t.assignment_id.slice(0, 8)}`);
  return (
    <div className="mono" style={{ fontSize: 11, lineHeight: 1.6, color: "var(--dim)", marginBottom: 8 }}>
      {bits.join("  ·  ")}
    </div>
  );
}

/* -- table furniture ------------------------------------------------------------------- */

const ELIDE: React.CSSProperties = {
  display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
};

const TD: React.CSSProperties = {
  height: 40, padding: "0 12px", borderBottom: "1px solid var(--line)",
  verticalAlign: "middle", overflow: "hidden",
};

function Th({
  children, first, num, right, title,
}: {
  children: React.ReactNode; first?: boolean; num?: boolean; right?: boolean; title?: string;
}) {
  return (
    <th
      className="hdr"
      title={title}
      style={{
        textAlign: num || right ? "right" : "left", fontWeight: 500, whiteSpace: "nowrap",
        padding: "10px 12px", paddingLeft: first ? 15 : 12,
        borderBottom: "1px solid var(--line)",
      }}
    >
      {children}
    </th>
  );
}

function Td({
  children, stripe, num, warn,
}: {
  children: React.ReactNode; stripe?: string; num?: boolean; warn?: boolean;
}) {
  return (
    <td
      className={num ? "mono num" : undefined}
      style={{
        ...TD,
        ...(stripe ? { borderLeft: `3px solid ${stripe}`, paddingLeft: 12 } : {}),
        ...(num
          ? { textAlign: "right" as const, fontSize: 11, color: warn ? "var(--warn)" : "var(--dim)" }
          : {}),
      }}
    >
      {children}
    </td>
  );
}

/** A full-width row under a task: the log, the session, or the verbatim error. */
function Expand({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <td colSpan={9} style={{ borderLeft: `3px solid ${color}`, padding: "0 14px 14px" }}>
      {children}
    </td>
  );
}

const B: React.CSSProperties = {
  padding: "5px 10px", borderRadius: 6, cursor: "pointer", whiteSpace: "nowrap",
  fontFamily: "var(--mono)",
  fontSize: 10, lineHeight: 1, letterSpacing: "0.06em", textTransform: "uppercase",
};

/* Row hover, the live pulse and the reduced-motion kill switch all come from layout.tsx.
   The only thing this file adds is a hover on its own buttons. */
const CSS = `
  .btn { transition: filter 120ms ease; }
  .btn:hover:not(:disabled) { filter: brightness(1.14); }
`;
