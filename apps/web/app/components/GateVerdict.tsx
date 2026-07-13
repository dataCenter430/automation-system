"use client";

import { useEffect, useState } from "react";

/**
 * GATE VERDICT — the five checks, as they ACTUALLY ran.
 *
 *   01 LINTING · 02 CLASSIFIER · 03 DOCKER BUILD · 04 ORACLE RUN · 05 NULL RUN
 *
 * These are the PHASES INSIDE VERIFY_RUNNING (30). They are not pipeline states and they
 * never appear in the state column — a task is VERIFYING, and this panel is where you find
 * out what that means right now.
 *
 * THE RULE: a check that did not run is SKIPPED, and it must LOOK skipped — greyed, with a
 * dash, and the reason it never ran. The gate short-circuits (a blocking lint finding means
 * Docker is never invoked; a failed image means no container runs; an oracle scoring 0 means
 * the null run never happens), so most red gates leave three checks that simply did not
 * execute. Drawing those as green ticks would be a lie in the most dangerous direction: it
 * would say "the oracle passed" about a task whose oracle never started.
 *
 * The route derives all of this from the artifacts on disk under runs/<slug>/verify-<n>/,
 * because those are the only things that cannot lie about what happened.
 */

type Status = "pass" | "fail" | "skipped" | "pending";

interface Check {
  n: number;
  id: string;
  label: string;
  status: Status;
  detail: string;
}

interface Verdict {
  slug: string;
  attempt: number | null;
  runDir: string | null;
  running?: boolean;
  passed: boolean;
  checks: Check[];
  error?: string;
}

const GLYPH: Record<Status, string> = {
  pass: "✓",
  fail: "✗",
  pending: "◔",
  skipped: "–",
};

const COLOR: Record<Status, string> = {
  pass: "var(--ok)",
  fail: "var(--bad)",
  pending: "var(--run)",
  skipped: "var(--dim)",
};

export function GateVerdict({ taskId }: { taskId: string | null }) {
  const [v, setV] = useState<Verdict | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!taskId) {
      setV(null);
      setErr(null);
      return;
    }
    let stop = false;

    const pull = async () => {
      try {
        const r = await fetch(`/api/tasks/${taskId}/gate`, { cache: "no-store" });
        const j = (await r.json()) as Verdict;
        if (stop) return;
        if (!r.ok || j.error) {
          setErr(j.error ?? `gate route returned ${r.status}`);
          setV(null);
        } else {
          setV(j);
          setErr(null);
        }
      } catch (e) {
        if (!stop) setErr((e as Error).message);
      }
    };

    void pull();
    const id = setInterval(pull, 3000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [taskId]);

  return (
    <section
      className="gate"
      style={{ background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 10, padding: 14 }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <span className="hdr">Gate verdict</span>
        {v?.attempt != null && (
          <span className="mono num" style={{ fontSize: 10, color: "var(--dim)" }}>
            verify-{v.attempt}
          </span>
        )}
        {v && (
          <span
            className="pill"
            style={{ marginLeft: "auto", color: v.running ? "var(--run)" : v.passed ? "var(--ok)" : "var(--dim)" }}
          >
            <span className={v.running ? "dot pulse" : "dot"} />
            {v.running ? "Running" : v.passed ? "Passed" : "Incomplete"}
          </span>
        )}
      </div>

      {!taskId ? (
        <p style={{ margin: 0, fontSize: 12.5, color: "var(--dim)", lineHeight: 1.6 }}>
          Select a task to see how its Docker gate actually went — the five checks, and for every
          one that did not run, the reason it did not.
        </p>
      ) : err ? (
        <p style={{ margin: 0, fontSize: 12.5, color: "var(--dim)", lineHeight: 1.6 }}>{err}</p>
      ) : !v ? (
        <p style={{ margin: 0, fontSize: 12.5, color: "var(--dim)" }}>Reading the gate artifacts…</p>
      ) : (
        <div>
          {v.checks.map((c) => (
            <div
              key={c.id}
              style={{
                display: "flex", gap: 9, alignItems: "flex-start",
                padding: "9px 0", borderTop: "1px solid var(--line)",
                opacity: c.status === "skipped" ? 0.55 : 1,
              }}
            >
              <span
                className={c.status === "pending" ? "mono pulse" : "mono"}
                style={{ color: COLOR[c.status], fontSize: 12, lineHeight: "16px", width: 12, flexShrink: 0 }}
              >
                {GLYPH[c.status]}
              </span>

              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span
                    className="mono"
                    style={{
                      fontSize: 10.5, letterSpacing: "0.1em", textTransform: "uppercase",
                      color: c.status === "skipped" ? "var(--dim)" : "var(--text)",
                    }}
                  >
                    {c.label}
                  </span>
                  {/* Said out loud, not merely implied by a grey tick. */}
                  {c.status === "skipped" && (
                    <span
                      className="mono"
                      style={{
                        fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase",
                        color: "var(--dim)", border: "1px solid var(--line)",
                        borderRadius: 3, padding: "1px 4px",
                      }}
                    >
                      Skipped
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 11.5, color: "var(--dim)", lineHeight: 1.5, marginTop: 3, wordBreak: "break-word" }}>
                  {c.detail}
                </div>
              </div>

              {/* 01–05, down the right edge. */}
              <span className="mono num" style={{ fontSize: 10, color: "var(--dim)", flexShrink: 0, opacity: 0.7 }}>
                {String(c.n).padStart(2, "0")}
              </span>
            </div>
          ))}

          {v.runDir && (
            <div
              className="mono"
              style={{ fontSize: 9.5, color: "var(--dim)", marginTop: 10, wordBreak: "break-all", opacity: 0.75 }}
            >
              {v.runDir}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
