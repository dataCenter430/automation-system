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

export function SessionView({ taskId, live, slug }: { taskId: string; live: boolean; slug?: string | null }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ costUsd?: number; transcript?: string; models?: string[] } | null>(null);
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
        setMeta({ costUsd: j.costUsd, transcript: j.transcript, models: j.models });
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

  const toolCalls = turns.filter((t) => t.kind === "tool").length;

  return (
    <div>
      {/* ---- header: what you are looking at, and whether it is chasing the tail ---- */}
      <div
        style={{
          display: "flex", alignItems: "center", gap: 10, marginBottom: 9,
          fontSize: 11.5, color: "var(--dim)", flexWrap: "wrap",
        }}
      >
        <span className="hdr" style={{ color: "var(--text)" }}>
          Transcript{slug ? `: ${slug}` : ""}
        </span>

        {/* Which model actually built this task. Provenance, not trivia — and if more than
            one shows up, the pin changed underneath you mid-build and you want to know. */}
        {meta?.models?.length ? (
          <span
            className="mono"
            style={{
              fontSize: 10,
              color: meta.models.length > 1 ? "var(--warn)" : "var(--violet)",
              border: `1px solid ${meta.models.length > 1 ? "var(--warn)" : "var(--violet)"}`,
              borderRadius: 4, padding: "1px 6px", fontWeight: 600,
            }}
            title={meta.models.length > 1 ? "More than one model ran in this session" : "The model that built this task"}
          >
            {meta.models.join(" + ")}
          </span>
        ) : null}

        <span className="mono num" style={{ fontSize: 11 }}>{toolCalls} tool calls</span>
        {live && <span style={{ color: "var(--run)" }}>● live</span>}

        {/* AUTO-FOLLOW. It is a toggle, not a checkbox, because its state is the thing you
            need to read at a glance: ON means the pane is chasing a live build and will jump
            under you; OFF means you scrolled up to read something and it is holding still.
            Scrolling up turns it OFF by itself — see the handler below. */}
        <button
          onClick={() => setFollow((f) => !f)}
          className="mono"
          style={{
            marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6,
            fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase",
            padding: "3px 8px", borderRadius: 5,
            border: `1px solid ${follow ? "var(--run)" : "var(--line)"}`,
            color: follow ? "var(--run)" : "var(--dim)",
            background: "transparent",
          }}
          title={
            follow
              ? "The pane is following the live build. Scroll up to stop it."
              : "Holding still. Click to jump back to the end and follow again."
          }
        >
          <span className={follow && live ? "dot pulse" : "dot"} style={{ width: 5, height: 5 }} />
          Auto-follow {follow ? "on" : "off"}
        </button>
      </div>

      {/* ---- the transcript itself ---- */}
      <div
        onScroll={(e) => {
          const el = e.currentTarget;
          // Turn off auto-follow the moment the user scrolls up to read something. A pane that
          // yanks you back to the bottom while you are mid-sentence is a pane you stop using.
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          if (!atBottom && follow) setFollow(false);
        }}
        style={{
          maxHeight: 480, overflow: "auto", background: "#0b0e14",
          border: "1px solid var(--line)", borderRadius: 8, padding: "12px 14px",
          fontFamily: "var(--mono)", fontSize: 12, lineHeight: 1.6,
        }}
      >
        {turns.map((t, i) => {
          if (t.kind === "prompt") {
            return (
              <Speaker key={i} at={t.at} who="USER" color="var(--violet)">
                <pre style={PRE}>{t.text}</pre>
              </Speaker>
            );
          }
          if (t.kind === "text") {
            return (
              <Speaker key={i} at={t.at} who="ASSISTANT" color="var(--brand)">
                <div style={{ whiteSpace: "pre-wrap", color: "var(--text)" }}>{t.text}</div>
              </Speaker>
            );
          }
          if (t.kind === "thinking") {
            return (
              <Speaker key={i} at={t.at} who="THINKING" color="var(--dim)">
                <div style={{ whiteSpace: "pre-wrap", color: "var(--dim)", fontStyle: "italic" }}>{t.text}</div>
              </Speaker>
            );
          }

          // ---- a tool call. Boxed, because it is a different KIND of thing from speech:
          // the model did something to the machine, and it should not read as another
          // paragraph. Collapsed by default — the input can be a 200-line file write.
          if (t.kind === "tool") {
            const open = expanded === i;
            return (
              <div
                key={i}
                style={{
                  margin: "8px 0", border: "1px solid var(--line)", borderRadius: 6,
                  background: "var(--panel)", overflow: "hidden",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px" }}>
                  <span style={{ color: "var(--run)", flex: "none" }}>•</span>
                  <span className="mono" style={{ fontSize: 11, color: "var(--run)", flex: "none" }}>
                    TOOL_CALL: {t.name}
                  </span>
                  <span
                    className="mono"
                    style={{
                      fontSize: 11, color: "var(--dim)", flex: 1, minWidth: 0,
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}
                    title={t.detail}
                  >
                    {t.detail}
                  </span>
                  {t.input && (
                    <button
                      onClick={() => setExpanded(open ? null : i)}
                      className="mono"
                      style={{
                        flex: "none", fontSize: 9.5, letterSpacing: "0.08em", textTransform: "uppercase",
                        padding: "2px 7px", borderRadius: 4,
                        border: "1px solid var(--line)", background: "transparent", color: "var(--dim)",
                      }}
                    >
                      {open ? "Collapse" : "Expand"}
                    </button>
                  )}
                </div>
                {open && (
                  <pre
                    style={{
                      ...PRE, color: "var(--dim)", margin: 0, padding: "8px 10px",
                      borderTop: "1px solid var(--line)", background: "#0b0e14",
                    }}
                  >
                    {t.input}
                  </pre>
                )}
              </div>
            );
          }

          if (t.kind === "result") {
            return (
              <Speaker key={i} at={t.at} who="RESULT" color={t.ok ? "var(--ok)" : "var(--bad)"}>
                <div
                  style={{
                    whiteSpace: "pre-wrap", wordBreak: "break-word",
                    color: t.ok ? "var(--dim)" : "var(--bad)",
                  }}
                >
                  {t.text.split("\n").slice(0, 3).join("\n").slice(0, 220)}
                  {t.text.length > 220 ? " …" : ""}
                </div>
              </Speaker>
            );
          }

          return (
            <div
              key={i}
              className="mono num"
              style={{
                color: "var(--ok)", fontSize: 11, padding: "6px 0",
                borderTop: "1px solid var(--line)", marginTop: 8,
              }}
            >
              turn complete · {t.turns} turns
            </div>
          );
        })}
        <div ref={endRef} />
      </div>

      {/* ---- footer: the running compute, and where the raw transcript lives ----
          NOT A BILL. See claude/no-billing.ts — every Claude call runs on the ~/.claude
          subscription (a flat fee), and ANTHROPIC_API_KEY is stripped from the environment
          before every spawn. This figure is what the same tokens WOULD have cost on the
          metered API, and it is the only honest measure of how much work this build did. */}
      <div
        style={{
          display: "flex", alignItems: "baseline", gap: 10, marginTop: 8,
          fontSize: 10.5, color: "var(--dim)",
        }}
      >
        <span className="mono">Running compute</span>
        {meta?.transcript && (
          <code style={{ fontSize: 10, opacity: 0.7, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
            {meta.transcript}
          </code>
        )}
        <span
          className="mono num"
          style={{ marginLeft: "auto", color: "var(--text)" }}
          title="API-equivalent, not billed — these builds run on your ~/.claude subscription."
        >
          ≈${(meta?.costUsd ?? 0).toFixed(4)}
        </span>
      </div>
    </div>
  );
}

/**
 * One speaker turn: [USER], [ASSISTANT], [RESULT].
 *
 * The bracketed label is deliberate. This is a TRANSCRIPT — a record of who said what — and a
 * transcript that renders every party in the same voice is a wall of text you cannot skim. The
 * bracket says "this is a speaker tag, not content", which is exactly the convention a terminal
 * log already uses, and this thing sits next to a terminal.
 */
function Speaker({
  at, who, color, children,
}: {
  at: string | null;
  who: string;
  color: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ margin: "10px 0" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 3 }}>
        <span className="mono" style={{ fontSize: 10.5, color, letterSpacing: "0.06em", fontWeight: 600 }}>
          [{who}]
        </span>
        <span className="mono num" style={{ fontSize: 10, color: "var(--dim)", opacity: 0.7 }}>
          {time(at)}
        </span>
      </div>
      {children}
    </div>
  );
}

const PRE: React.CSSProperties = {
  margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word",
  fontSize: 11.5, color: "var(--text)", maxHeight: 260, overflow: "auto",
};
