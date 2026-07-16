"use client";

import { fmtElapsed, sinceOf, stateMeta, useNow, type Task } from "./Shell";

/**
 * The queue, dense enough to scan eight builds without reading a word.
 *
 * STATE | SLUG | MODEL | TOOLS | COST | ELAPSED, plus one unlabelled cell holding the row's
 * single legal action. Every row carries a 3px left stripe in its state colour — that stripe
 * is the whole scanning mechanism, so it is the state's colour and never the brand's, except
 * on the selected row where brand means "this is the one you are looking at".
 *
 * THE GATES, and they are the reason this component holds buttons at all:
 *
 *   Start Build      — DRAFT (0) only. It is the first thing that spends money, so it sits on
 *                      the row it would spend it on, and it exists nowhere else.
 *   Approve & Submit — AWAITING_APPROVAL (70) only, behind confirm(). Irreversible.
 *   Retry            — FAILED (-1) and NEEDS_HUMAN (-2) only.
 *
 * There is deliberately no way to reach any other transition from this table. The worker owns
 * the other sixteen states; a human clicking into the middle of them is how you skip a gate.
 *
 * MODEL is provenance, not choice: it is the model that ACTUALLY answered, read back from the
 * session transcript. The pin lives in config/pipeline.json. Two models in one session means
 * the pin changed under a running build — shown in --warn, because you want to know that.
 *
 * STALLED, and why this table takes a `workerDead` prop at all:
 *
 * A row's pipeline_state is the last thing a worker WROTE. It is not, and has never been,
 * evidence that a worker is still there. When the worker died silently on 2026-07-13 this
 * table went on rendering VERIFYING with a pulsing dot for an hour and forty minutes, and a
 * pulsing dot means "this is happening right now" — so the obvious reading was that the lint
 * gate had hung, and the next hour went into the gate instead of into the corpse. The meters
 * directly above knew perfectly well the worker was gone; the row did not ask them.
 *
 * So a live-looking state is now cross-checked against the heartbeat, and when the worker is
 * stale every one of them reads STALLED. The state itself is not lost — it moves into the
 * tooltip, where it is diagnosis rather than a claim about the present.
 */

const COLS = "3px 152px minmax(180px, 1fr) 140px 62px 78px 86px 104px";

export function TaskTable({
  tasks, selected, onSelect, onAct, busy, workerDead,
}: {
  tasks: Task[];
  selected: string | null;
  onSelect: (taskId: string | null) => void;
  onAct: (taskId: string, action: "start" | "approve" | "retry") => void;
  busy: string | null;
  /** The worker's heartbeat is stale. Nothing is advancing ANY task, whatever the rows say. */
  workerDead: boolean;
}) {
  const now = useNow();

  return (
    <section
      style={{
        background: "var(--panel)", border: "1px solid var(--line)",
        borderRadius: 10, overflow: "hidden",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 14px 10px" }}>
        <span className="hdr">Queue</span>
        <span className="mono num" style={{ fontSize: 10, color: "var(--dim)" }}>
          {tasks.length}
        </span>
      </div>

      <div className="scroll-x">
        <div style={{ minWidth: 800 }}>
          {/* Column headers: 10px mono, uppercase, .12em. */}
          <div
            style={{
              display: "grid", gridTemplateColumns: COLS, alignItems: "center",
              gap: 10, padding: "0 14px 8px 0",
              borderBottom: "1px solid var(--line)",
            }}
          >
            <span />
            <span className="hdr">State</span>
            <span className="hdr">Slug</span>
            <span className="hdr">Model</span>
            <span className="hdr" style={{ textAlign: "right" }}>Tools</span>
            <span className="hdr" style={{ textAlign: "right" }}>Cost</span>
            <span className="hdr" style={{ textAlign: "right" }}>Elapsed</span>
            <span />
          </div>

          {tasks.length === 0 ? (
            <div style={{ padding: "40px 14px", textAlign: "center", color: "var(--dim)", fontSize: 13 }}>
              Nothing queued yet. Paste a Snorkel task blob on the{" "}
              <a href="/tasks" style={{ color: "var(--brand)" }}>Tasks</a> page to add one — it lands as a
              DRAFT and stays inert until you start it.
            </div>
          ) : (
            tasks.map((t) => {
              const meta = stateMeta(t.pipeline_state);
              const isSel = selected === t.task_id;

              // A state that CLAIMS to be running, with no worker running it. The dot must not
              // pulse and the name must not be believed — this row is a corpse, not a build.
              const stalled = workerDead && meta.live;
              const color = stalled ? "var(--bad)" : meta.color;
              const hint = stalled
                ? `STALLED in ${meta.name}. The worker is not running, so nothing is advancing ` +
                  `this task — it is not slow, it is abandoned. Start the worker ` +
                  `(npm run worker:supervised); its boot sweep re-enters this state and picks ` +
                  `the task back up where it left off.`
                : meta.hint;
              const since = sinceOf(t);
              const multiModel = t.models.length > 1;

              return (
                <div
                  key={t.task_id}
                  className="row"
                  onClick={() => onSelect(isSel ? null : t.task_id)}
                  title={hint}
                  style={{
                    display: "grid", gridTemplateColumns: COLS, alignItems: "center",
                    gap: 10, height: 40, paddingRight: 14, cursor: "pointer",
                    background: isSel ? "var(--panel2)" : "transparent",
                    borderBottom: "1px solid var(--line)",
                  }}
                >
                  {/* The stripe. Eight rows, one glance. */}
                  <span
                    style={{
                      width: 3, height: "100%",
                      background: isSel ? "var(--brand)" : color,
                    }}
                  />

                  <span className="pill" style={{ color, justifySelf: "start", marginLeft: 11 }}>
                    {/* No pulse when stalled. The pulse is this table's one claim about the
                        PRESENT tense, and it is the claim that misled someone for an hour. */}
                    <span className={meta.live && !stalled ? "dot pulse" : "dot"} />
                    {stalled ? "STALLED" : meta.name}
                  </span>

                  <span style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                    {/* The chevron marks the row whose transcript and gate verdict are showing
                        below. The row's background changes too, but a background is a weak
                        signal on a dark table with eight rows and a coloured stripe on each —
                        the caret is the one mark that says "this one, the one you clicked". */}
                    <span
                      className="mono"
                      aria-hidden
                      style={{
                        color: "var(--brand)", fontSize: 11, flex: "none", width: 8,
                        opacity: isSel ? 1 : 0,
                      }}
                    >
                      ›
                    </span>
                    <span
                      className="mono"
                      style={{
                        fontSize: 12, color: "var(--text)", fontWeight: isSel ? 600 : 400,
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      }}
                      title={t.title}
                    >
                      {t.slug ?? t.task_id.slice(0, 8)}
                    </span>
                    {/* Attempts, burning. Three is all there is. */}
                    {t.attempt > 0 && <Attempt label="verify" n={t.attempt + 1} of={3} />}
                    {t.feedback_attempt > 0 && <Attempt label="feedback" n={t.feedback_attempt + 1} of={3} />}
                  </span>

                  <span
                    className="mono"
                    title={multiModel ? `TWO MODELS RAN IN ONE SESSION: ${t.models.join(", ")}` : (t.model ?? "no session transcript on this machine")}
                    style={{
                      fontSize: 10.5,
                      color: multiModel ? "var(--warn)" : t.model ? "var(--dim)" : "var(--dim)",
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}
                  >
                    {multiModel ? t.models.join(" + ") : (t.model ?? "—")}
                  </span>

                  <span className="mono num" style={{ fontSize: 11, color: "var(--dim)", textAlign: "right" }}>
                    {t.toolCalls ?? "—"}
                  </span>

                  <span
                    className="mono num"
                    title={
                      t.costPartial
                        ? "A model in this session has no price in the table — this is a FLOOR, not a total."
                        : t.costUsd === null
                          ? "No priced usage in this session's transcript."
                          : "API-list-price equivalent. These builds run on the subscription, so no per-token bill exists."
                    }
                    style={{
                      fontSize: 11, textAlign: "right",
                      color: t.costPartial ? "var(--warn)" : t.costUsd === null ? "var(--dim)" : "var(--text)",
                    }}
                  >
                    {/* Four decimals, not two. A build turn costs cents, and $0.02 vs $0.05 is
                        the difference between a task that went cleanly and one that burned two
                        fix attempts — rounding it to the penny throws that away. (It is an
                        API-equivalent figure, not a bill: see claude/no-billing.ts.) */}
                    {t.costUsd === null ? "—" : `$${t.costUsd.toFixed(4)}${t.costPartial ? "*" : ""}`}
                  </span>

                  <span className="mono num" style={{ fontSize: 11, color: "var(--dim)", textAlign: "right" }}>
                    {fmtElapsed(since === null ? null : now - since)}
                  </span>

                  <span style={{ justifySelf: "end" }} onClick={(e) => e.stopPropagation()}>
                    <Action t={t} onAct={onAct} busy={busy} />
                  </span>
                </div>
              );
            })
          )}
        </div>
      </div>
    </section>
  );
}

/** The row's one legal action, or nothing at all. */
function Action({
  t, onAct, busy,
}: {
  t: Task;
  onAct: (taskId: string, action: "start" | "approve" | "retry") => void;
  busy: string | null;
}) {
  const disabled = busy === t.task_id;

  // DRAFT: the gate before anything is spent.
  if (t.pipeline_state === 0) {
    return (
      <button
        className="mono"
        disabled={disabled}
        onClick={() => onAct(t.task_id, "start")}
        title="Nothing has spent money on this task yet. This is the click that starts it."
        style={{ ...BTN, background: "var(--grad-primary)", color: "#0a0b10", border: "none", fontWeight: 700 }}
      >
        Start build
      </button>
    );
  }

  // AWAITING_APPROVAL: the gate before anything is irreversible.
  if (t.pipeline_state === 70) {
    return (
      <button
        className="mono"
        disabled={disabled}
        onClick={() => {
          if (confirm("Submit to Snorkel? This cannot be undone.")) onAct(t.task_id, "approve");
        }}
        title="Snorkel's checks are green. This submits, and it cannot be undone."
        style={{ ...BTN, background: "var(--grad-approve)", color: "#04220f", border: "none", fontWeight: 700 }}
      >
        Approve
      </button>
    );
  }

  if (t.pipeline_state === -1 || t.pipeline_state === -2) {
    return (
      <button
        className="mono"
        disabled={disabled}
        onClick={() => onAct(t.task_id, "retry")}
        title="Resumes from the last clean state, keeping the Claude session and its context."
        style={{ ...BTN, background: "var(--panel2)", color: "var(--text)", border: "1px solid var(--line)" }}
      >
        Retry
      </button>
    );
  }

  // Every other state belongs to the worker. There is nothing here for a human to press.
  return null;
}

function Attempt({ label, n, of }: { label: string; n: number; of: number }) {
  return (
    <span
      className="mono num"
      title={`${label} attempt ${n} of ${of}`}
      style={{
        fontSize: 9.5, color: "var(--warn)", border: "1px solid var(--warn)",
        borderRadius: 3, padding: "1px 4px", whiteSpace: "nowrap", flexShrink: 0, opacity: 0.9,
      }}
    >
      {label} {n}/{of}
    </span>
  );
}

const BTN: React.CSSProperties = {
  padding: "5px 9px", fontSize: 9.5, letterSpacing: "0.08em",
  textTransform: "uppercase", whiteSpace: "nowrap", borderRadius: 5,
};
