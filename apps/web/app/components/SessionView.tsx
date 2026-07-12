"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Watch a build happen.
 *
 * This is the replacement for the VS Code window: the exact prompt that went in, everything
 * Claude wrote back, every tool call it made and what came out of it — live, and for as many
 * concurrent builds as you like, which the window could never do (only one window can hold
 * keyboard focus, which is why GUI automation caps you at one build at a time).
 */

type Turn =
  | { kind: "prompt"; at: string | null; text: string }
  | { kind: "text"; at: string | null; text: string }
  | { kind: "thinking"; at: string | null; text: string }
  | { kind: "tool"; at: string | null; name: string; detail: string; input: string }
  | { kind: "result"; at: string | null; ok: boolean; text: string }
  | { kind: "cost"; at: string | null; usd: number; turns: number };

const time = (s: string | null) =>
  s ? new Date(s).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";

export function SessionView({ taskId, live }: { taskId: string; live: boolean }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ costUsd?: number; transcript?: string } | null>(null);
  const [follow, setFollow] = useState(true);
  const [expanded, setExpanded] = useState<number | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let stop = false;
    const pull = async () => {
      try {
        const r = await fetch(`/api/tasks/${taskId}/session`, { cache: "no-store" });
        const j = await r.json();
        if (stop) return;
        setTurns(j.turns ?? []);
        setNote(j.note ?? null);
        setMeta({ costUsd: j.costUsd, transcript: j.transcript });
      } catch { /* the poll is best-effort; a blip should not blank the view */ }
    };
    pull();
    // Only poll while the build is actually running — a finished session never changes.
    const id = live ? setInterval(pull, 2500) : undefined;
    return () => { stop = true; if (id) clearInterval(id); };
  }, [taskId, live]);

  useEffect(() => {
    if (follow) endRef.current?.scrollIntoView({ block: "end" });
  }, [turns.length, follow]);

  if (note && !turns.length) {
    return <div style={{ fontSize: 12, color: "var(--dim)", padding: "8px 0" }}>{note}</div>;
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8, fontSize: 11.5, color: "var(--dim)" }}>
        <span>{turns.filter((t) => t.kind === "tool").length} tool calls</span>
        {meta?.costUsd ? <span>${meta.costUsd.toFixed(2)}</span> : null}
        {live && <span style={{ color: "var(--run)" }}>● live</span>}
        <label style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 5, cursor: "pointer" }}>
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          follow
        </label>
      </div>

      <div
        onScroll={(e) => {
          const el = e.currentTarget;
          // Turn off auto-follow the moment the user scrolls up to read something.
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          if (!atBottom && follow) setFollow(false);
        }}
        style={{
          maxHeight: 480, overflow: "auto", background: "#0b0e14",
          border: "1px solid var(--line)", borderRadius: 6, padding: "10px 12px",
          fontSize: 12, lineHeight: 1.55,
        }}
      >
        {turns.map((t, i) => {
          if (t.kind === "prompt") {
            return (
              <Block key={i} at={t.at} label="PROMPT" color="var(--accent)">
                <pre style={PRE}>{t.text}</pre>
              </Block>
            );
          }
          if (t.kind === "text") {
            return (
              <Block key={i} at={t.at} label="CLAUDE" color="var(--text)">
                <div style={{ whiteSpace: "pre-wrap", color: "var(--text)" }}>{t.text}</div>
              </Block>
            );
          }
          if (t.kind === "thinking") {
            return (
              <Block key={i} at={t.at} label="thinking" color="var(--dim)">
                <div style={{ whiteSpace: "pre-wrap", color: "var(--dim)", fontStyle: "italic" }}>{t.text}</div>
              </Block>
            );
          }
          if (t.kind === "tool") {
            const open = expanded === i;
            return (
              <div key={i} style={{ display: "flex", gap: 8, padding: "1px 0" }}>
                <span style={{ color: "var(--dim)", minWidth: 58 }}>{time(t.at)}</span>
                <span
                  onClick={() => setExpanded(open ? null : i)}
                  style={{ cursor: "pointer", flex: 1, minWidth: 0 }}
                  title="click for the full tool input"
                >
                  <span style={{ color: "var(--run)" }}>⚙ {t.name}</span>{" "}
                  <span style={{ color: "var(--dim)" }}>{t.detail}</span>
                  {open && <pre style={{ ...PRE, color: "var(--dim)", marginTop: 4 }}>{t.input}</pre>}
                </span>
              </div>
            );
          }
          if (t.kind === "result") {
            return (
              <div key={i} style={{ display: "flex", gap: 8, padding: "1px 0" }}>
                <span style={{ color: "var(--dim)", minWidth: 58 }} />
                <span style={{ color: t.ok ? "var(--dim)" : "var(--bad)", whiteSpace: "pre-wrap", flex: 1, minWidth: 0 }}>
                  {"  ↳ "}
                  {t.text.split("\n").slice(0, 3).join("\n").slice(0, 220)}
                  {t.text.length > 220 ? " …" : ""}
                </span>
              </div>
            );
          }
          return (
            <div key={i} style={{ color: "var(--ok)", padding: "4px 0", borderTop: "1px solid var(--line)", marginTop: 6 }}>
              turn complete · ${t.usd.toFixed(2)} · {t.turns} turns
            </div>
          );
        })}
        <div ref={endRef} />
      </div>

      {meta?.transcript && (
        <div style={{ fontSize: 10.5, color: "var(--dim)", marginTop: 6 }}>
          transcript: <code>{meta.transcript}</code>
        </div>
      )}
    </div>
  );
}

function Block({ at, label, color, children }: { at: string | null; label: string; color: string; children: React.ReactNode }) {
  return (
    <div style={{ margin: "8px 0", paddingLeft: 8, borderLeft: `2px solid ${color}` }}>
      <div style={{ fontSize: 10, letterSpacing: 0.5, color, marginBottom: 2 }}>
        {label} <span style={{ color: "var(--dim)" }}>{time(at)}</span>
      </div>
      {children}
    </div>
  );
}

const PRE: React.CSSProperties = {
  margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word",
  fontSize: 11.5, color: "var(--text)", maxHeight: 260, overflow: "auto",
};
