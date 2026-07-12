"use client";

import { useCallback, useEffect, useState } from "react";
import { OwnerPicker } from "../components/OwnerPicker";

/**
 * Task owners.
 *
 * Nothing here is live until Save: edits are held locally so you can add someone and make
 * them active in one go, and so a half-finished list never becomes the owner stamped on the
 * next task. The active owner is the only field with teeth — it is written verbatim to
 * terminus.task_owner and is what Snorkel shows as the author of the submission.
 */
export default function SettingsPage() {
  const [owners, setOwners] = useState<string[]>([]);
  const [active, setActive] = useState("");
  const [saved, setSaved] = useState(""); // snapshot of what's on disk, to detect edits
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const snapshot = (o: string[], a: string) => JSON.stringify({ o, a });
  const dirty = loaded && snapshot(owners, active) !== saved;

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/settings", { cache: "no-store" });
      const j = await r.json();
      // Anything that isn't our own {error} shape (a Next crash page, a proxy) would otherwise
      // set error to undefined and render as a blank page with no clue what went wrong.
      if (!r.ok) { setError(j.error ?? `GET /api/settings failed with HTTP ${r.status}.`); return; }
      setOwners(j.owners);
      setActive(j.activeOwner);
      setSaved(snapshot(j.owners, j.activeOwner));
      setLoaded(true);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function add() {
    const name = draft.trim();
    setOk(null);
    if (!name) return;
    if (owners.some((o) => o.toLowerCase() === name.toLowerCase())) {
      setError(`${name} is already on the list.`);
      return;
    }
    setError(null);
    setOwners([...owners, name]);
    if (!active) setActive(name); // first owner added is the only sensible active one
    setDraft("");
  }

  function remove(name: string) {
    const next = owners.filter((o) => o !== name);
    setOwners(next);
    setOk(null);
    setError(null);
    // Removing the active owner would make the save fail validation, so hand the stamp to
    // whoever is left rather than bouncing the user off the API.
    if (name === active) setActive(next[0] ?? "");
  }

  async function save() {
    setBusy(true); setError(null); setOk(null);
    try {
      const r = await fetch("/api/settings", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ activeOwner: active, owners }),
      });
      const j = await r.json();
      if (!r.ok) { setError(j.error ?? `PUT /api/settings failed with HTTP ${r.status}.`); return; }
      setOwners(j.owners);
      setActive(j.activeOwner);
      setSaved(snapshot(j.owners, j.activeOwner));
      setOk(`Saved. New tasks will be stamped task_owner = ${j.activeOwner}.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: "32px 24px 80px" }}>
      <header style={{ marginBottom: 28 }}>
        <a href="/" style={{ fontSize: 12.5, color: "var(--dim)", textDecoration: "none" }}>← Queue</a>
        <h1 style={{ margin: "8px 0 0", fontSize: 22, fontWeight: 600 }}>Settings</h1>
        <p style={{ margin: "6px 0 0", color: "var(--dim)" }}>
          Who owns the tasks this machine submits. Stored in <code>config/owners.json</code>.
        </p>
      </header>

      <section style={S.card}>
        <h2 style={S.h2}>Task owners</h2>

        {!loaded && !error && <div style={{ fontSize: 13, color: "var(--dim)" }}>Loading…</div>}

        {owners.map((o) => (
          <div key={o} style={S.row}>
            <span style={{ fontSize: 13, flex: 1 }}>{o}</span>
            {o === active && (
              <span style={S.badge}>ACTIVE</span>
            )}
            <button style={S.btnRemove} disabled={busy} onClick={() => remove(o)}>Remove</button>
          </div>
        ))}

        {loaded && owners.length === 0 && (
          <div style={{ fontSize: 13, color: "var(--dim)", padding: "6px 0" }}>
            No owners yet. Add one below — a task cannot be submitted without an owner.
          </div>
        )}

        <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") add(); }}
            placeholder="New owner, e.g. Hercules"
            spellCheck={false}
          />
          <button style={S.btn} disabled={busy || !draft.trim()} onClick={add}>Add</button>
        </div>
      </section>

      <section style={S.card}>
        <h2 style={S.h2}>Active owner</h2>
        <p style={{ margin: "0 0 12px", fontSize: 12.5, color: "var(--dim)" }}>
          Stamped onto <code>terminus.task_owner</code> for <b>every new task</b> you add. Existing
          tasks keep the owner they were created with.
        </p>

        {/* The list here is the unsaved one, so the picker can't offer an owner you just removed.
            Held back until loaded, or an empty list would briefly claim "No owners configured"
            about a machine that has three. */}
        {loaded ? (
          <OwnerPicker owners={owners} value={active} onChange={setActive} disabled={busy} id="active-owner" />
        ) : (
          !error && <div style={{ fontSize: 13, color: "var(--dim)" }}>Loading…</div>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 16 }}>
          <button
            style={{ ...S.btn, marginTop: 0, background: "var(--accent)", color: "#0b0e14", borderColor: "var(--accent)", fontWeight: 600 }}
            disabled={busy || !dirty || owners.length === 0 || !active}
            onClick={save}
          >
            {busy ? "Saving…" : "Save"}
          </button>
          {dirty && !busy && (
            <span style={{ fontSize: 12, color: "var(--warn)" }}>Unsaved changes.</span>
          )}
        </div>

        {error && <div style={S.err}>{error}</div>}
        {ok && <div style={S.ok}>{ok}</div>}
      </section>
    </main>
  );
}

const S = {
  card: { background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 10, padding: 18, marginBottom: 24 },
  h2: { margin: "0 0 14px", fontSize: 15, fontWeight: 600 },
  row: {
    display: "flex", alignItems: "center", gap: 10,
    background: "var(--panel2)", border: "1px solid var(--line)", borderRadius: 8,
    padding: "9px 12px", marginBottom: 8,
  },
  badge: {
    fontSize: 10.5, fontWeight: 600, letterSpacing: 0.4, color: "var(--ok)",
    border: "1px solid var(--ok)", borderRadius: 4, padding: "1px 6px",
  },
  btn: { marginTop: 0, padding: "8px 16px", background: "var(--panel2)", color: "var(--text)", whiteSpace: "nowrap" as const },
  btnRemove: { padding: "5px 11px", fontSize: 12.5, background: "transparent", color: "var(--dim)" },
  err: { marginTop: 12, padding: "9px 11px", background: "#2a1a1f", border: "1px solid var(--bad)", color: "var(--bad)", borderRadius: 6, fontSize: 13, whiteSpace: "pre-wrap" as const },
  ok: { marginTop: 12, padding: "9px 11px", background: "#16241b", border: "1px solid var(--ok)", color: "var(--ok)", borderRadius: 6, fontSize: 13 },
};
