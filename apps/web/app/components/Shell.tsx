"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Notify } from "./Notify";
import { FleetMeters } from "./FleetMeters";

/**
 * The shell: the top bar, the fleet meters, the total burn, and the ONE poller.
 *
 * It sits in layout.tsx, so it wraps every page. Two consequences worth stating:
 *
 *   1. <Notify> is mounted here, which means the desktop alerts fire on whichever page you
 *      are looking at — including /tasks. That is the point of them: with eight two-hour
 *      builds running you are not watching the tab when one parks and asks for you.
 *
 *   2. /api/tasks and /api/fleet are polled HERE, once, every 3s, and handed down through a
 *      context. If each page polled for itself, the dashboard would be firing two requests
 *      per tick for the same rows the shell already has.
 */

// ---------------------------------------------------------------------------------------
// The shapes the API actually returns.
// ---------------------------------------------------------------------------------------

export interface Task {
  task_id: string;
  slug: string | null;
  title: string;
  category: string;
  sub_category: string;
  languages: string;
  task_status: number;
  pipeline_state: number;
  claude_session_id: string | null;
  attempt: number;
  feedback_attempt: number;
  last_error: string | null;
  zip_path: string | null;
  assignment_id: string | null;
  created_at: string;
  updated_at: string | null;

  /** Provenance, derived from the session transcript by /api/tasks. Never a fake zero. */
  model: string | null;
  models: string[];
  toolCalls: number | null;
  costUsd: number | null;
  costPartial: boolean;
}

export interface EventRow {
  id: number;
  task_id: string;
  stage: string;
  status: string;
  from_state: number | null;
  to_state: number | null;
  message: string | null;
  created_at: string;
}

export interface Fleet {
  pid: number | null;
  at: string | null;
  claude: { inUse: number; queued: number; max: number } | null;
  gates: { inUse: number; queued: number; max: number } | null;
  tasksInFlight: number | null;
  maxParallel: number | null;
  /** The worker stopped writing its heartbeat. A DEAD worker must not render as an IDLE one. */
  stale: boolean;
  ageSec: number | null;
  staleAfterSec: number;
  totalBurnUsd: number | null;
  burnPartial: boolean;
  tasksWithTranscript: number;
  note?: string;
}

// ---------------------------------------------------------------------------------------
// ALL NINETEEN STATES. packages/shared/src/status.ts is the source of truth; this is its
// rendering, and it is deliberately not collapsed into running/done/error.
//
// The operator's NEXT ACTION is what the colour has to encode, and it differs between states
// that a three-bucket model would fuse:
//
//   VERIFY_FAILED (35)  — the fixer is coming. Do nothing. (--warn: attempts are burning)
//   NEEDS_HUMAN  (-2)   — it refused to guess. Go and look. (--bad)
//
// Fusing those two would make the dashboard actively lie about whether you are needed.
// ---------------------------------------------------------------------------------------

export interface StateMeta {
  name: string;
  color: string;
  /** A process is running RIGHT NOW — the pill's dot pulses. */
  live: boolean;
  /** What the operator should do about it. */
  hint: string;
}

export const STATE_META: Record<number, StateMeta> = {
  0:  { name: "DRAFT",             color: "var(--dim)",  live: false, hint: "inert — the worker will never touch it. Nothing spends money until you press Start Build." },
  5:  { name: "QUEUED",            color: "var(--run)",  live: false, hint: "waiting for a worker slot" },
  10: { name: "BUILDING",          color: "var(--run)",  live: true,  hint: "Claude is writing the task" },
  20: { name: "BUILT",             color: "var(--run)",  live: false, hint: "built — heading for the docker gate" },
  30: { name: "VERIFYING",         color: "var(--run)",  live: true,  hint: "the docker gate: lint, classifier, image build, oracle run, null run" },
  35: { name: "VERIFY FAILED",     color: "var(--warn)", live: false, hint: "the gate rejected it. The fixer is coming — wait, do not intervene." },
  40: { name: "VERIFIED",          color: "var(--ok)",   live: false, hint: "the gate passed" },
  45: { name: "FIXING",            color: "var(--run)",  live: true,  hint: "Claude is fixing what the gate rejected" },
  50: { name: "ZIPPED",            color: "var(--run)",  live: false, hint: "packaged" },
  55: { name: "EXPLAINED",         color: "var(--run)",  live: true,  hint: "writing the explanation fields" },
  60: { name: "UPLOADING",         color: "var(--run)",  live: true,  hint: "driving Snorkel's form in Chrome" },
  65: { name: "CHECKING FEEDBACK", color: "var(--run)",  live: true,  hint: "waiting on Snorkel's own static checks" },
  67: { name: "FEEDBACK FAILED",   color: "var(--warn)", live: false, hint: "Snorkel's checks came back red. The remote fixer is coming — wait." },
  69: { name: "REMOTE FIX",        color: "var(--run)",  live: true,  hint: "Claude is fixing what Snorkel's checks rejected" },
  70: { name: "AWAITING APPROVAL", color: "var(--ok)",   live: false, hint: "Snorkel's checks are green. The irreversible click is yours." },
  80: { name: "SUBMITTING",        color: "var(--run)",  live: true,  hint: "submitting — this one cannot be taken back" },
  90: { name: "SUBMITTED",         color: "var(--ok)",   live: false, hint: "done" },
  [-1]: { name: "FAILED",          color: "var(--bad)",  live: false, hint: "it died. Read last_error, then Retry." },
  [-2]: { name: "NEEDS HUMAN",     color: "var(--bad)",  live: false, hint: "it stopped and refused to guess. Go and look." },
};

/** An unknown state is shown as itself, never bucketed into something reassuring. */
export function stateMeta(s: number): StateMeta {
  return (
    STATE_META[s] ?? {
      name: `STATE ${s}`,
      color: "var(--dim)",
      live: false,
      hint: "not a state in status.ts — the schema moved under the dashboard",
    }
  );
}

/** The stages where a Claude session is actually running, so SessionView keeps polling. */
export const CLAUDE_LIVE: ReadonlySet<number> = new Set([10, 45, 55, 69]);

/** Snorkel's own lifecycle (terminus.task_status) — NOT the pipeline state. */
export const TASK_STATUS = ["Working on", "AI review", "Human review", "Accepted"];

// ---------------------------------------------------------------------------------------
// Elapsed
// ---------------------------------------------------------------------------------------

/** When this task last moved. updated_at if the pipeline ever touched it, else created_at. */
export function sinceOf(t: Task): number | null {
  const raw = t.updated_at ?? t.created_at;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

export function fmtElapsed(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${String(h % 24).padStart(2, "0")}h`;
}

/** A once-a-second clock, so elapsed counts up without re-fetching anything. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

// ---------------------------------------------------------------------------------------
// The data every page reads
// ---------------------------------------------------------------------------------------

interface FleetData {
  tasks: Task[];
  events: EventRow[];
  fleet: Fleet | null;
  error: string | null;
  refresh: () => void;
}

const Ctx = createContext<FleetData>({
  tasks: [], events: [], fleet: null, error: null, refresh: () => {},
});

export function useFleetData(): FleetData {
  return useContext(Ctx);
}

const POLL_MS = 3000;

export function Shell({ children }: { children: React.ReactNode }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [fleet, setFleet] = useState<Fleet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const pathname = usePathname();

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/tasks", { cache: "no-store" });
      const j = await r.json();
      if (j.error) {
        setError(j.error);
      } else {
        setTasks(j.tasks ?? []);
        setEvents(j.events ?? []);
        setError(null);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const pullFleet = useCallback(async () => {
    try {
      const r = await fetch("/api/fleet", { cache: "no-store" });
      setFleet((await r.json()) as Fleet);
    } catch {
      // A blip on the fleet route must not blank the queue. FleetMeters renders a null
      // fleet as "unknown", which is the honest reading — never as an idle 0/6.
      setFleet(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void pullFleet();
    const id = setInterval(() => {
      void refresh();
      void pullFleet();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [refresh, pullFleet]);

  // Whose name new tasks are filed under. Submitting a batch as the wrong owner is annoying
  // to undo, so it stays on screen rather than buried in the settings page.
  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((j) => setOwner(typeof j?.activeOwner === "string" ? j.activeOwner : null))
      .catch(() => {});
  }, []);

  const burn =
    fleet?.totalBurnUsd === null || fleet?.totalBurnUsd === undefined
      ? "—"
      : `$${fleet.totalBurnUsd.toFixed(2)}`;

  return (
    <Ctx.Provider value={{ tasks, events, fleet, error, refresh }}>
      <header
        style={{
          position: "sticky", top: 0, zIndex: 20,
          background: "rgba(10, 11, 16, 0.88)", backdropFilter: "blur(8px)",
          borderBottom: "1px solid var(--line)",
        }}
      >
        <div
          style={{
            maxWidth: 1600, margin: "0 auto", padding: "10px 20px",
            display: "flex", alignItems: "center", gap: 22, flexWrap: "wrap", minHeight: 56,
          }}
        >
          {/* The wordmark. The dot is --brand and pulses: it is the only brand-coloured
              thing that moves, and it never means a status. */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            <span className="dot pulse" style={{ background: "var(--brand)", width: 7, height: 7 }} />
            <span
              className="mono"
              style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.2em", color: "var(--text)" }}
            >
              FLEET
            </span>
          </div>

          <nav style={{ display: "flex", gap: 4, flexShrink: 0 }}>
            <Tab href="/" label="DASHBOARD" active={pathname === "/"} />
            <Tab href="/tasks" label="TASKS" active={pathname?.startsWith("/tasks") ?? false} />
          </nav>

          <FleetMeters fleet={fleet} />

          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
            <span
              className="mono num"
              title={
                fleet?.burnPartial
                  ? "Some model in these sessions has no price in the table — this is a FLOOR, not a total."
                  : "API-list-price equivalent of every session with a transcript on this machine. " +
                    "These builds run on the Claude Code subscription, so no per-token bill exists."
              }
              style={{
                fontSize: 12,
                border: `1px solid ${fleet?.burnPartial ? "var(--warn)" : "var(--line)"}`,
                color: fleet?.burnPartial ? "var(--warn)" : "var(--text)",
                borderRadius: 6, padding: "6px 10px", whiteSpace: "nowrap",
                background: "var(--panel)",
              }}
            >
              <span style={{ color: "var(--dim)" }}>Total Burn </span>
              {burn}
              {fleet?.burnPartial ? " *" : ""}
            </span>

            <Notify tasks={tasks} />

            <a
              href="/settings"
              style={{
                fontSize: 12, color: "var(--dim)", textDecoration: "none",
                border: "1px solid var(--line)", borderRadius: 6, padding: "6px 10px",
                whiteSpace: "nowrap",
              }}
            >
              Settings{owner ? ` · ${owner}` : ""}
            </a>
          </div>
        </div>
      </header>

      <main style={{ maxWidth: 1600, margin: "0 auto", padding: "18px 20px 80px" }}>{children}</main>
    </Ctx.Provider>
  );
}

function Tab({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <a
      href={href}
      className="mono"
      style={{
        fontSize: 11, letterSpacing: "0.12em", textDecoration: "none",
        color: active ? "var(--text)" : "var(--dim)",
        padding: "6px 10px 7px",
        borderBottom: `2px solid ${active ? "var(--brand)" : "transparent"}`,
      }}
    >
      {label}
    </a>
  );
}
