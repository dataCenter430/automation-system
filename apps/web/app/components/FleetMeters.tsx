"use client";

import type { Fleet } from "./Shell";

/**
 * CLAUDE SESSIONS n/6 and DOCKER GATES n/2 — how loaded the worker is, right now.
 *
 * THE ONE RULE HERE: a stale reading is not a zero.
 *
 * The semaphores live in the worker process's memory; the web app cannot see into it, so the
 * worker publishes them to runs/.worker-status.json every 5s and /api/fleet reads that back.
 * A worker that has been killed leaves its last file behind — and that file says "0 in use,
 * 0 gates", which is pixel-for-pixel identical to a healthy idle worker.
 *
 * So when /api/fleet reports `stale`, these meters say WORKER NOT RUNNING. They do not draw
 * a confident, empty 0/6. The difference matters at 2am: an empty meter means "nothing to do",
 * and a stale one means "your queue is not moving and nobody is coming".
 */
export function FleetMeters({ fleet }: { fleet: Fleet | null }) {
  // No fleet at all (the route did not answer) is exactly as untrustworthy as a stale one.
  const down = !fleet || fleet.stale;

  const why = !fleet
    ? "/api/fleet did not answer, so the worker's load is unknown — not zero."
    : (fleet.note ??
      (fleet.ageSec === null
        ? "The worker has never written a heartbeat on this machine."
        : `No heartbeat for ${fmtAge(fleet.ageSec)} (anything older than ${fleet.staleAfterSec}s is stale). ` +
          `The worker writes one every 5s, even while parked in rate-limit backoff — so it is not running.`));

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
      <Meter
        label="Claude sessions"
        inUse={fleet?.claude?.inUse ?? null}
        max={fleet?.claude?.max ?? null}
        queued={fleet?.claude?.queued ?? 0}
        down={down}
      />
      <Meter
        label="Docker gates"
        inUse={fleet?.gates?.inUse ?? null}
        max={fleet?.gates?.max ?? null}
        queued={fleet?.gates?.queued ?? 0}
        down={down}
      />

      {/* Sessions frozen on an unanswered question. They are inside `inUse` — they hold their
          slots — so without this the meter reads "4/6 running" and looks healthy while four
          builds sit doing precisely nothing, waiting for you. The one meter where the number
          is a bill you are running up. */}
      {!down && !!fleet?.claude?.blocked && (
        <span className="pill" style={{ color: "var(--brand)" }} title="Claude sessions frozen inside an ask_human call, holding their build slots until you answer">
          <span className="dot pulse" />
          {fleet.claude.blocked} waiting on you
        </span>
      )}

      {down && (
        <span className="pill" style={{ color: "var(--bad)" }} title={why}>
          <span className="dot" />
          Worker not running
          {fleet?.ageSec != null && <span style={{ opacity: 0.75 }}> · {fmtAge(fleet.ageSec)} stale</span>}
        </span>
      )}
    </div>
  );
}

function Meter({
  label, inUse, max, queued, down,
}: {
  label: string;
  inUse: number | null;
  max: number | null;
  queued: number;
  down: boolean;
}) {
  // `max` is a config constant, not a live reading, so it stays legible even when the worker
  // is gone — but the numerator becomes an em-dash, because nobody knows what it is.
  const value = down || inUse === null ? "—" : String(inUse);
  const cap = max === null ? "—" : String(max);
  const pct = down || inUse === null || !max ? 0 : Math.min(100, (inUse / max) * 100);

  return (
    <div style={{ minWidth: 128 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, marginBottom: 5 }}>
        <span className="hdr">{label}</span>
        <span
          className="mono num"
          style={{ fontSize: 11, color: down ? "var(--dim)" : "var(--text)", whiteSpace: "nowrap" }}
        >
          {value}/{cap}
          {!down && queued > 0 && (
            <span style={{ color: "var(--warn)" }} title={`${queued} waiting for a slot`}>
              {" "}
              +{queued}
            </span>
          )}
        </span>
      </div>
      <div
        style={{
          height: 3, borderRadius: 2, background: "var(--line)", overflow: "hidden",
          opacity: down ? 0.4 : 1,
        }}
      >
        <div
          className="meter-fill"
          style={{ width: `${pct}%`, height: "100%", background: "var(--grad-primary)" }}
        />
      </div>
    </div>
  );
}

function fmtAge(sec: number): string {
  if (sec < 90) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
