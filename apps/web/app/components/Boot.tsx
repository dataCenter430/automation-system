"use client";

import { useEffect, useRef, useState } from "react";
import type { Fleet, Task } from "./Shell";

/**
 * The boot screen.
 *
 * Every line here is TRUE or it does not tick.
 *
 * A loading sequence is the easiest place in a product to lie, because nobody checks: you
 * stagger six reassuring ✓s over 1.2 seconds and the user feels the system is solid. This
 * console's entire value is that it does not lie about state — a stale worker reads as dead
 * rather than idle, a skipped gate check reads as skipped rather than passed — and a fake
 * boot sequence would undo that on the very first screen a person sees.
 *
 * So each step is bound to a real milestone:
 *
 *   handshake              /api/fleet answered at all
 *   claude sessions · N    N is the worker's OWN reported limit, not a constant we typed here
 *   docker gates · N       likewise
 *   task manifest          /api/tasks answered; the count is the count
 *   oracle harness         the worker's heartbeat is FRESH — and if it is stale, this line
 *                          turns amber and says the worker is not running, because that is
 *                          the single most useful thing the screen could tell you
 *   console online         both fetches landed
 *
 * If the worker is dead, you learn it here, in the first second, instead of pressing Start
 * Build and waiting for a task that will never move.
 *
 * The stagger (110ms) is for legibility, not theatre: it exists so six lines resolving in the
 * same frame can still be read. It cannot outrun the data — a step never ticks before its
 * milestone is real, and a fast fetch just means the screen is gone quickly.
 */

type StepState = "pending" | "ok" | "warn" | "fail";

interface Step {
  key: string;
  label: string;
  state: StepState;
  note?: string;
}

const STAGGER_MS = 110;
const FADE_MS = 420;

export function Boot({
  fleet,
  tasks,
  error,
  ready,
  onDone,
}: {
  fleet: Fleet | null;
  tasks: Task[];
  error: string | null;
  /** Both first fetches have landed (or failed). */
  ready: boolean;
  onDone: () => void;
}) {
  const [revealed, setRevealed] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const startedAt = useRef(Date.now());

  const workerDead = !!fleet && fleet.stale === true;
  const noWorker = !!fleet && fleet.claude?.max == null;

  const steps: Step[] = [
    {
      key: "handshake",
      label: "handshake · fleet-alpha",
      state: error ? "fail" : fleet ? "ok" : "pending",
      note: error ?? undefined,
    },
    {
      key: "claude",
      label: `warming claude sessions · ${fleet?.claude?.max ?? "—"}`,
      state: fleet?.claude?.max != null ? "ok" : fleet ? "warn" : "pending",
    },
    {
      key: "gates",
      label: `priming docker gates · ${fleet?.gates?.max ?? "—"}`,
      state: fleet?.gates?.max != null ? "ok" : fleet ? "warn" : "pending",
    },
    {
      key: "manifest",
      label: `loading task manifest${ready ? ` · ${tasks.length}` : ""}`,
      state: error ? "fail" : ready ? "ok" : "pending",
    },
    {
      key: "oracle",
      // The one line that earns its place. A boot screen that ticks green while the worker is
      // dead is worse than no boot screen.
      label: workerDead || noWorker ? "worker not running — nothing will build" : "verifying oracle harness",
      state: !fleet ? "pending" : workerDead || noWorker ? "warn" : "ok",
      note: workerDead ? `last heartbeat ${fleet?.ageSec ?? "?"}s ago` : undefined,
    },
    {
      key: "online",
      label: error ? "console online · degraded" : "console online",
      state: error ? "warn" : ready ? "ok" : "pending",
    },
  ];

  const settled = steps.filter((s) => s.state !== "pending").length;
  const pct = Math.round((Math.min(revealed, settled) / steps.length) * 100);

  // Reveal in order, but never ahead of the truth: a step is only revealed once its milestone
  // has actually settled.
  useEffect(() => {
    if (revealed >= settled) return;
    const id = setTimeout(() => setRevealed((n) => n + 1), STAGGER_MS);
    return () => clearTimeout(id);
  }, [revealed, settled]);

  // Leave once everything that can settle has been revealed. A minimum on screen only so the
  // thing does not flash — 500ms, not a fabricated two-second "boot".
  useEffect(() => {
    if (!ready || revealed < steps.length) return;
    const held = Date.now() - startedAt.current;
    const wait = Math.max(0, 500 - held);
    const a = setTimeout(() => setLeaving(true), wait);
    const b = setTimeout(onDone, wait + FADE_MS);
    return () => {
      clearTimeout(a);
      clearTimeout(b);
    };
  }, [ready, revealed, steps.length, onDone]);

  return (
    <div className={`boot ${leaving ? "boot-out" : ""}`} role="status" aria-live="polite">
      <style>{CSS}</style>

      <div className="boot-glow" aria-hidden />

      <div className="boot-stage">
        <div className="orbit" aria-hidden>
          <span className="ring ring-a" />
          <span className="ring ring-b" />
          <span className="core" />
        </div>

        <div className="eyebrow">Snorkel · Automation</div>
        <h1 className="wordmark">Fleet Alpha</h1>

        <div className="bar" aria-hidden>
          <span className="fill" style={{ width: `${pct}%` }} />
        </div>

        <div className="status">
          <span className="caret">›</span>
          <span className="status-text">
            {error ? "console online · degraded" : pct < 100 ? "booting" : "console online"}
          </span>
          <span className="cursor" aria-hidden />
          <span className="pct num">{String(pct).padStart(3, "0")}%</span>
        </div>

        <ul className="steps">
          {steps.slice(0, revealed).map((s) => (
            <li key={s.key} className={`step step-${s.state} ${s.key === "online" ? "step-last" : ""}`}>
              <span className="glyph" aria-hidden>
                {s.state === "ok" ? "✓" : s.state === "warn" ? "!" : s.state === "fail" ? "×" : "·"}
              </span>
              <span className="label">{s.label}</span>
              {s.note && <span className="note">{s.note}</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

const CSS = `
.boot {
  position: fixed; inset: 0; z-index: 90;
  display: grid; place-items: center;
  background: var(--bg);
  overflow: hidden;
  opacity: 1;
  transition: opacity ${FADE_MS}ms ease;
}
.boot-out { opacity: 0; pointer-events: none; }

/* The ambient wash from the reference. Two soft lobes, no hard edges, no banding. */
.boot-glow {
  position: absolute; inset: -20%;
  background:
    radial-gradient(38% 42% at 22% 18%, rgba(139, 92, 246, 0.30), transparent 68%),
    radial-gradient(46% 48% at 82% 76%, rgba(56, 189, 248, 0.24), transparent 70%);
  filter: blur(28px);
}

.boot-stage {
  position: relative;
  width: min(460px, 88vw);
  display: flex; flex-direction: column; align-items: center;
}

/* ---- the orbit: an arc that sweeps a still core ---- */
.orbit { position: relative; width: 132px; height: 132px; margin-bottom: 34px; }
.ring {
  position: absolute; inset: 0; border-radius: 50%;
  border: 1px solid transparent;
}
.ring-a {
  border-top-color: var(--run);
  border-right-color: rgba(125, 211, 252, 0.45);
  animation: spin 2.4s linear infinite;
}
.ring-b {
  inset: 13px;
  border-bottom-color: rgba(232, 121, 249, 0.55);
  animation: spin 3.6s linear infinite reverse;
}
.core {
  position: absolute; top: 50%; left: 50%;
  width: 13px; height: 13px; margin: -6.5px 0 0 -6.5px;
  border-radius: 50%;
  background: var(--brand);
  box-shadow: 0 0 18px 4px rgba(232, 121, 249, 0.45);
  animation: breathe 2.6s ease-in-out infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes breathe {
  0%, 100% { opacity: 0.72; transform: scale(1); }
  50%      { opacity: 1;    transform: scale(1.12); }
}

.eyebrow {
  font: 500 10.5px/1 var(--mono);
  letter-spacing: .42em; text-transform: uppercase;
  color: var(--dim); margin-bottom: 14px;
}
.wordmark {
  margin: 0 0 30px;
  font: 500 30px/1 var(--mono);
  letter-spacing: .22em; text-transform: uppercase;
  background: linear-gradient(90deg, #8b5cf6, #e879f9);
  -webkit-background-clip: text; background-clip: text;
  color: transparent;
}

.bar {
  width: 100%; height: 2px; border-radius: 2px;
  background: var(--line); overflow: hidden;
}
.fill {
  display: block; height: 100%;
  background: linear-gradient(90deg, #8b5cf6, #e879f9);
  transition: width 260ms ease;
}

.status {
  width: 100%; margin-top: 12px;
  display: flex; align-items: center; gap: 7px;
  font: 500 11.5px/1 var(--mono);
  color: var(--dim);
}
.caret { color: var(--brand); }
.status-text { text-transform: uppercase; letter-spacing: .12em; color: var(--text); }
.cursor {
  width: 6px; height: 12px; background: var(--run);
  animation: blink 1s steps(2, start) infinite;
}
@keyframes blink { 50% { opacity: 0; } }
.pct { margin-left: auto; color: var(--dim); }

.steps {
  width: 100%; margin: 30px 0 0; padding: 0; list-style: none;
  display: flex; flex-direction: column; gap: 9px;
}
.step {
  display: flex; align-items: baseline; gap: 10px;
  font: 12px/1.4 var(--mono);
  color: var(--dim);
  animation: rise 320ms ease both;
}
@keyframes rise {
  from { opacity: 0; transform: translateY(4px); }
  to   { opacity: 1; transform: none; }
}
.glyph { width: 10px; flex: none; }
.step-ok   .glyph { color: var(--ok); }
.step-warn .glyph { color: var(--warn); }
.step-fail .glyph { color: var(--bad); }
.step-warn .label { color: var(--warn); }
.step-fail .label { color: var(--bad); }
.step-last .label { color: var(--text); font-weight: 600; }
.note { color: var(--dim); opacity: .75; font-size: 11px; }

/* Motion is decoration here; the information is the text. Take it all away on request. */
@media (prefers-reduced-motion: reduce) {
  .ring-a, .ring-b, .core, .cursor { animation: none; }
  .step { animation: none; }
  .fill, .boot { transition: none; }
  .ring-a { border-top-color: var(--run); }
}
`;
