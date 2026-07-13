"use client";

import { useEffect, useRef, useState } from "react";
import type { PendingQuestion, Task } from "./Shell";

/**
 * A build has stopped to ask you something.
 *
 * This is the sharpest thing on the dashboard, and it should be: everywhere else, waiting is
 * cheap — a task sits at AWAITING_APPROVAL and nothing is lost but time. Here, a live Claude
 * session is frozen mid-turn inside the tool call, HOLDING one of six build slots, and it will
 * stay frozen until you answer or the clock runs out. Three unanswered questions is half the
 * fleet stopped. So the card shows the cost of your silence, in seconds, counting down.
 *
 * THE COUNTDOWN IS NOT A DEADLINE, IT IS A DISCLOSURE.
 *
 * When it hits zero the build does not fail — it is told "nobody answered, use your best
 * judgment, and say what you decided alone." That is the honest trade (a fleet that deadlocks
 * because someone went to bed is worse than a build that proceeds on a stated assumption), but
 * it means an ignored question becomes an UNSUPERVISED DESIGN DECISION on a task that will
 * carry your name to Snorkel. The card says exactly that, rather than implying the question
 * politely disappears.
 *
 * Free text sits alongside the options on purpose. The model proposes the choices it can see;
 * the whole reason a human is here is that it may not have seen the right one.
 */
export function QuestionCard({
  task,
  q,
  onAnswered,
}: {
  task: Task;
  q: PendingQuestion;
  onAnswered: () => void;
}) {
  const [free, setFree] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [left, setLeft] = useState(() => secsLeft(q.expiresAt));
  const box = useRef<HTMLTextAreaElement>(null);

  // A per-second tick, not the 3s task poll: this number is the point of the card.
  useEffect(() => {
    setLeft(secsLeft(q.expiresAt));
    const id = setInterval(() => setLeft(secsLeft(q.expiresAt)), 1000);
    return () => clearInterval(id);
  }, [q.expiresAt, q.id]);

  // A new question means a new answer box. Without this, text typed for a question that timed
  // out would still be sitting there when the next one arrives.
  useEffect(() => {
    setFree("");
    setErr(null);
  }, [q.id]);

  async function send(answer: string) {
    if (!answer.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/tasks/${task.task_id}/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The id is what makes a stale click safe: the poll is 3s wide, so this button can
        // genuinely be pressed for a question that expired a moment ago. The server refuses
        // (409) rather than applying the answer to whatever is being asked now.
        body: JSON.stringify({ id: q.id, answer }),
      });
      if (!r.ok) {
        setErr((await r.json()).error ?? `HTTP ${r.status}`);
        return;
      }
      onAnswered();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const expired = left <= 0;

  return (
    <section
      style={{
        background: "rgba(232, 121, 249, 0.05)",
        border: "1px solid var(--brand)",
        borderRadius: 10,
        padding: 14,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <span className="hdr" style={{ color: "var(--brand)" }}>
          Claude is asking you
        </span>
        <span className="mono num" style={{ marginLeft: "auto", fontSize: 11, color: expired ? "var(--warn)" : "var(--dim)" }}>
          {expired ? "deciding alone…" : `${fmt(left)} left`}
        </span>
      </div>

      <div className="mono" style={{ fontSize: 10.5, color: "var(--dim)", marginBottom: 11 }}>
        {task.slug ?? task.task_id.slice(0, 8)} · the build is stopped, holding a slot
      </div>

      <p style={{ margin: "0 0 9px", fontSize: 14, lineHeight: 1.5, color: "var(--text)", fontWeight: 600 }}>
        {q.question}
      </p>

      {q.context && (
        <p style={{ margin: "0 0 12px", fontSize: 12.5, lineHeight: 1.6, color: "var(--dim)" }}>
          {q.context}
        </p>
      )}

      {q.options.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 7, marginBottom: 12 }}>
          {q.options.map((o, i) => (
            <button
              key={`${q.id}:${i}`}
              disabled={busy}
              onClick={() => send(o.detail ? `${o.label} — ${o.detail}` : o.label)}
              style={{
                textAlign: "left", padding: "9px 11px", cursor: busy ? "wait" : "pointer",
                background: "var(--panel2)", color: "var(--text)",
                border: "1px solid var(--line)", borderRadius: 6,
              }}
              onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--brand)")}
              onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--line)")}
            >
              <div style={{ fontSize: 13, fontWeight: 600 }}>{o.label}</div>
              {o.detail && (
                <div style={{ fontSize: 12, color: "var(--dim)", marginTop: 3, lineHeight: 1.5 }}>
                  {o.detail}
                </div>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Always offered. The model proposes what it can see; you are here because it may not
          have seen the right answer. */}
      <textarea
        ref={box}
        value={free}
        disabled={busy}
        onChange={(e) => setFree(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send(free);
        }}
        placeholder={
          q.options.length
            ? "…or tell it something else. (⌘/Ctrl+Enter to send)"
            : "Your answer. (⌘/Ctrl+Enter to send)"
        }
        rows={3}
        className="mono"
        style={{
          width: "100%", padding: "8px 10px", fontSize: 12.5, lineHeight: 1.5,
          background: "var(--bg)", color: "var(--text)",
          border: "1px solid var(--line)", borderRadius: 6, resize: "vertical",
        }}
      />

      <button
        className="mono"
        disabled={busy || !free.trim()}
        onClick={() => void send(free)}
        style={{
          width: "100%", marginTop: 8, padding: "8px 10px",
          fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", fontWeight: 700,
          cursor: busy || !free.trim() ? "not-allowed" : "pointer",
          opacity: busy || !free.trim() ? 0.45 : 1,
          background: "var(--grad-approve)", color: "#04220f", border: "none",
        }}
      >
        {busy ? "Sending…" : "Send answer"}
      </button>

      {err && (
        <div style={{ marginTop: 8, fontSize: 12, color: "var(--bad)", lineHeight: 1.5 }}>
          {err}
        </div>
      )}

      <p style={{ margin: "11px 0 0", fontSize: 11, color: "var(--dim)", lineHeight: 1.6 }}>
        {expired
          ? "Nobody answered in time, so the build is choosing for itself. It will say what it decided in its final message — read it."
          : "If you do not answer, the build will not fail — it will decide for itself and tell you what it chose. That is an unsupervised design decision on a task that goes to Snorkel with your name on it."}
      </p>
    </section>
  );
}

function secsLeft(iso: string): number {
  const ms = new Date(iso).getTime() - Date.now();
  return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
}

function fmt(s: number): string {
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}
