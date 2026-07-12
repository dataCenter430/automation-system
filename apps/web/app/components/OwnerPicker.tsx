"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The one control that decides terminus.task_owner.
 *
 * Two modes, because it has two callers:
 *   - no `owners` prop  → fetches /api/settings itself and reports the saved activeOwner
 *     up front via onChange, so a form (e.g. Add task) that never touches the select still
 *     ends up stamping the right owner.
 *   - `owners` given    → fully controlled by a parent that already holds the list
 *     (the settings page, whose list is unsaved and would otherwise disagree with disk).
 */
export function OwnerPicker({
  owners,
  value,
  onChange,
  disabled,
  id,
}: {
  owners?: string[];
  value?: string;
  onChange: (owner: string) => void;
  disabled?: boolean;
  id?: string;
}) {
  const [fetched, setFetched] = useState<{ activeOwner: string; owners: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A caller in self-fetch mode has no `value` to give back, so without somewhere to remember
  // the pick, `selected` stays pinned to the fetched activeOwner and the <select> — being
  // controlled — snaps straight back to it. The owner would be unchangeable from that form.
  const [picked, setPicked] = useState<string | null>(null);

  // Callers pass an inline arrow; keeping it in a ref stops the fetch below from re-running
  // on every parent render (and re-announcing the owner in a loop).
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const selfFetch = owners === undefined;

  useEffect(() => {
    if (!selfFetch) return;
    let cancelled = false;

    void (async () => {
      try {
        const r = await fetch("/api/settings", { cache: "no-store" });
        const j = await r.json();
        if (cancelled) return;
        if (!r.ok) { setError(j.error ?? "Could not load the owner list."); return; }
        setFetched({ activeOwner: j.activeOwner, owners: j.owners });
        onChangeRef.current(j.activeOwner);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();

    return () => { cancelled = true; };
  }, [selfFetch]);

  const list = owners ?? fetched?.owners ?? [];
  const selected = value ?? picked ?? fetched?.activeOwner ?? "";

  if (error) return <div style={S.err}>{error}</div>;

  return (
    <select
      id={id}
      value={selected}
      disabled={disabled || list.length === 0}
      onChange={(e) => {
        setPicked(e.target.value); // ignored when the parent controls `value`
        onChange(e.target.value);
      }}
      style={S.select}
    >
      {list.length === 0 ? (
        <option value="">{selfFetch && !fetched ? "Loading…" : "No owners configured"}</option>
      ) : (
        list.map((o) => <option key={o} value={o}>{o}</option>)
      )}
    </select>
  );
}

const S = {
  // <select> isn't covered by the global input styling in layout.tsx, so it carries the
  // dark-theme rules itself.
  select: {
    font: "inherit", background: "var(--panel2)", color: "var(--text)",
    border: "1px solid var(--line)", borderRadius: 6, padding: "8px 10px", minWidth: 200,
  } as React.CSSProperties,
  err: {
    padding: "9px 11px", background: "#2a1a1f", border: "1px solid var(--bad)",
    color: "var(--bad)", borderRadius: 6, fontSize: 13,
  } as React.CSSProperties,
};
