"use client";

import { useState } from "react";

/**
 * The queue. Two buttons matter:
 *
 *   Start Build      — the ONLY thing that moves a task off DRAFT. Nothing spends a
 *                      Claude session or a Docker build until you press it.
 *   Approve & Submit — the ONLY irreversible click in the system. Offered only after
 *                      Snorkel's own Check-feedback has come back green.
 */

const STATE: Record<number, { name: string; color: string; hint?: string }> = {
  0:  { name: "DRAFT",             color: "var(--dim)",  hint: "inert — nothing will happen until you start it" },
  5:  { name: "QUEUED",            color: "var(--run)" },
  10: { name: "BUILDING",          color: "var(--run)" },
  20: { name: "BUILT",             color: "var(--run)" },
  30: { name: "VERIFYING",         color: "var(--run)",  hint: "docker: oracle + null run" },
  35: { name: "VERIFY FAILED",     color: "var(--warn)" },
  40: { name: "VERIFIED",          color: "var(--ok)" },
  45: { name: "FIXING",            color: "var(--run)" },
  50: { name: "ZIPPED",            color: "var(--run)" },
  55: { name: "EXPLAINED",         color: "var(--run)" },
  60: { name: "UPLOADING",         color: "var(--run)" },
  65: { name: "CHECKING FEEDBACK", color: "var(--run)",  hint: "waiting on Snorkel's static checks" },
  67: { name: "FEEDBACK FAILED",   color: "var(--warn)" },
  69: { name: "REMOTE FIX",        color: "var(--run)" },
  70: { name: "READY TO SUBMIT",   color: "var(--ok)",   hint: "Snorkel's checks passed. Your call." },
  80: { name: "SUBMITTING",        color: "var(--run)" },
  90: { name: "SUBMITTED",         color: "var(--ok)" },
  [-1]: { name: "FAILED",          color: "var(--bad)" },
  [-2]: { name: "NEEDS YOU",       color: "var(--bad)" },
};

const TASK_STATUS = ["Working on", "AI review", "Human review", "Accepted"];

export function Queue({ tasks, events, onChanged }: { tasks: any[]; events: any[]; onChanged: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

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

  if (!tasks.length) {
    return (
      <section style={{ color: "var(--dim)", textAlign: "center", padding: "50px 0" }}>
        Nothing queued yet.
      </section>
    );
  }

  return (
    <section>
      <h2 style={{ margin: "0 0 14px", fontSize: 15, fontWeight: 600 }}>
        Queue <span style={{ color: "var(--dim)", fontWeight: 400 }}>({tasks.length})</span>
      </h2>

      {tasks.map((t) => {
        const st = STATE[t.pipeline_state] ?? { name: `STATE ${t.pipeline_state}`, color: "var(--dim)" };
        const mine = events.filter((e) => e.task_id === t.task_id).slice(0, 6);
        const isOpen = open === t.task_id;
        const failed = t.pipeline_state === -1 || t.pipeline_state === -2;

        return (
          <div key={t.task_id} style={{
            background: "var(--panel)", border: "1px solid var(--line)",
            borderLeft: `3px solid ${st.color}`, borderRadius: 8,
            padding: "13px 15px", marginBottom: 10,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                  <code style={{ fontSize: 13, color: "var(--text)" }}>{t.slug ?? t.task_id.slice(0, 8)}</code>
                  <span style={{
                    fontSize: 10.5, fontWeight: 600, letterSpacing: 0.4,
                    color: st.color, border: `1px solid ${st.color}`,
                    borderRadius: 4, padding: "1px 6px",
                  }}>
                    {st.name}
                  </span>
                  {t.attempt > 0 && (
                    <span style={{ fontSize: 11, color: "var(--dim)" }}>verify {t.attempt + 1}/3</span>
                  )}
                  {t.feedback_attempt > 0 && (
                    <span style={{ fontSize: 11, color: "var(--dim)" }}>feedback {t.feedback_attempt + 1}/3</span>
                  )}
                </div>
                <div style={{ fontSize: 12.5, color: "var(--dim)", marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {t.title}
                </div>
                {st.hint && (
                  <div style={{ fontSize: 11.5, color: "var(--dim)", marginTop: 3, fontStyle: "italic" }}>{st.hint}</div>
                )}
              </div>

              <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                {t.pipeline_state === 0 && (
                  <button
                    style={{ ...B, background: "var(--accent)", color: "#0b0e14", borderColor: "var(--accent)", fontWeight: 600 }}
                    disabled={busy === t.task_id}
                    onClick={() => act(t.task_id, "start")}
                  >
                    Start Build
                  </button>
                )}
                {t.pipeline_state === 70 && (
                  <button
                    style={{ ...B, background: "var(--ok)", color: "#0b0e14", borderColor: "var(--ok)", fontWeight: 600 }}
                    disabled={busy === t.task_id}
                    onClick={() => {
                      if (confirm("Submit to Snorkel? This cannot be undone.")) act(t.task_id, "approve");
                    }}
                  >
                    Approve &amp; Submit
                  </button>
                )}
                {failed && (
                  <button style={B} disabled={busy === t.task_id} onClick={() => act(t.task_id, "retry")}>
                    Retry
                  </button>
                )}
                <button style={{ ...B, color: "var(--dim)", background: "transparent" }}
                        onClick={() => setOpen(isOpen ? null : t.task_id)}>
                  {isOpen ? "Hide" : "Log"}
                </button>
              </div>
            </div>

            {t.last_error && failed && (
              <pre style={{
                margin: "10px 0 0", padding: "9px 11px", background: "#2a1a1f",
                border: "1px solid var(--bad)", borderRadius: 6, color: "var(--bad)",
                fontSize: 11.5, whiteSpace: "pre-wrap", maxHeight: 160, overflow: "auto",
              }}>
                {t.last_error.slice(0, 1200)}
              </pre>
            )}

            {isOpen && (
              <div style={{ marginTop: 11, borderTop: "1px solid var(--line)", paddingTop: 10 }}>
                <Meta t={t} />
                {mine.length === 0 ? (
                  <div style={{ fontSize: 12, color: "var(--dim)" }}>No events yet.</div>
                ) : (
                  mine.map((e) => (
                    <div key={e.id} style={{ display: "flex", gap: 9, fontSize: 12, padding: "2px 0" }}>
                      <span style={{ color: "var(--dim)", minWidth: 56 }}>
                        {new Date(e.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                      </span>
                      <span style={{ color: "var(--dim)", minWidth: 66 }}>{e.stage}</span>
                      <span style={{
                        color: e.status === "failed" ? "var(--bad)"
                             : e.status === "completed" ? "var(--ok)" : "var(--dim)",
                      }}>
                        {e.message ?? e.status}
                      </span>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}

function Meta({ t }: { t: any }) {
  const bits: string[] = [];
  bits.push(`snorkel: ${TASK_STATUS[t.task_status] ?? t.task_status}`);
  if (t.claude_session_id) bits.push(`session ${t.claude_session_id.slice(0, 8)}`);
  if (t.zip_path) bits.push(`zip ${t.zip_path.split(/[\\/]/).pop()}`);
  if (t.assignment_id) bits.push(`assignment ${t.assignment_id.slice(0, 8)}`);
  return (
    <div style={{ fontSize: 11.5, color: "var(--dim)", marginBottom: 8 }}>
      {bits.join("  ·  ")}
    </div>
  );
}

const B: React.CSSProperties = {
  padding: "5px 11px", fontSize: 12.5,
  background: "var(--panel2)", color: "var(--text)",
};
