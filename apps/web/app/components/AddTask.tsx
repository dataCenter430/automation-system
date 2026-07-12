"use client";

import { useState } from "react";

/**
 * Paste → Preview → Add.
 *
 * The preview step is the whole point: you see the six parsed fields and the resolved
 * task.toml enums BEFORE anything is written. A blob that mis-splits gets caught here, in
 * two seconds, rather than 45 minutes into a build of the wrong task.
 */
export function AddTask({ onAdded }: { onAdded: () => void }) {
  const [taskId, setTaskId] = useState("");
  const [blob, setBlob] = useState("");
  const [preview, setPreview] = useState<any>(null);
  const [slug, setSlug] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function doParse() {
    setBusy(true); setError(null); setPreview(null);
    const r = await fetch("/api/parse", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ blob }),
    });
    const j = await r.json();
    setBusy(false);
    if (!r.ok) { setError(j.error); return; }
    setPreview(j);
    setSlug(j.slug);
  }

  async function doAdd() {
    setBusy(true); setError(null);
    const r = await fetch("/api/tasks", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ task_id: taskId.trim(), slug, parsed: preview.parsed }),
    });
    const j = await r.json();
    setBusy(false);
    if (!r.ok) { setError(j.error); return; }
    setTaskId(""); setBlob(""); setPreview(null); setSlug("");
    onAdded();
  }

  return (
    <section style={S.card}>
      <h2 style={S.h2}>Add task</h2>

      <label style={S.label}>Task ID</label>
      <input
        value={taskId}
        onChange={(e) => setTaskId(e.target.value)}
        placeholder="a5de5c52-a2ed-412d-b8a4-744b794b1796"
        spellCheck={false}
      />

      <label style={{ ...S.label, marginTop: 14 }}>Task text</label>
      <textarea
        value={blob}
        onChange={(e) => { setBlob(e.target.value); setPreview(null); }}
        rows={10}
        placeholder={"Interactive Challenges & Games/Long Context, DB Interaction\n\nAutomate C Graphviz Worker for Stained-Glass Vault Replays\n\nThe vault referee stalls whenever…\n\nC\nSQL\nPOSIX shell\nAdditional Inspiration\nA small C project skeleton with a Makefile…"}
        spellCheck={false}
      />

      {error && <div style={S.err}>{error}</div>}

      {!preview ? (
        <button style={S.btn} disabled={busy || !blob.trim()} onClick={doParse}>
          {busy ? "Parsing…" : "Preview"}
        </button>
      ) : (
        <>
          <div style={S.preview}>
            <Row k="Category"      v={preview.parsed.category} />
            <Row k="Sub-category"  v={preview.parsed.sub_category} />
            <Row k="Title"         v={preview.parsed.title} />
            <Row k="Languages"     v={preview.parsed.languages} />
            <Row k="Description"   v={preview.parsed.description} clamp />
            <Row k="Additional"    v={preview.parsed.additional_note ?? "(none)"} clamp />

            <div style={{ borderTop: "1px solid var(--line)", margin: "10px 0", paddingTop: 10 }}>
              <div style={{ fontSize: 12, color: "var(--dim)", marginBottom: 6 }}>
                resolved for task.toml
              </div>
              {preview.taxonomyError ? (
                <div style={S.err}>{preview.taxonomyError}</div>
              ) : (
                <code style={{ fontSize: 12, color: "var(--ok)" }}>
                  category = &quot;{preview.toml.category}&quot; · subcategories ={" "}
                  {JSON.stringify(preview.toml.subcategories)} · languages ={" "}
                  {JSON.stringify(preview.toml.languages)}
                </code>
              )}
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 4 }}>
              <span style={{ fontSize: 12, color: "var(--dim)", minWidth: 92 }}>Slug / zip name</span>
              <input value={slug} onChange={(e) => setSlug(e.target.value)} spellCheck={false} />
            </div>
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <button
              style={{ ...S.btn, background: "var(--accent)", color: "#0b0e14", borderColor: "var(--accent)" }}
              disabled={busy || !taskId.trim() || !!preview.taxonomyError}
              onClick={doAdd}
            >
              Add to queue
            </button>
            <button style={S.btnGhost} onClick={() => setPreview(null)}>Back</button>
          </div>
          <p style={{ margin: "10px 0 0", fontSize: 12, color: "var(--dim)" }}>
            This only queues it as a draft. Nothing builds until you press <b>Start Build</b>.
          </p>
        </>
      )}
    </section>
  );
}

function Row({ k, v, clamp }: { k: string; v: string; clamp?: boolean }) {
  return (
    <div style={{ display: "flex", gap: 10, padding: "3px 0", alignItems: "flex-start" }}>
      <span style={{ fontSize: 12, color: "var(--dim)", minWidth: 92, flexShrink: 0 }}>{k}</span>
      <span style={{
        fontSize: 13,
        ...(clamp ? { display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical" as const, overflow: "hidden" } : {}),
      }}>
        {v}
      </span>
    </div>
  );
}

const S = {
  card: { background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 10, padding: 18, marginBottom: 24 },
  h2: { margin: "0 0 14px", fontSize: 15, fontWeight: 600 },
  label: { display: "block", fontSize: 12, color: "var(--dim)", marginBottom: 5 },
  btn: { marginTop: 14, padding: "8px 16px", background: "var(--panel2)", color: "var(--text)" },
  btnGhost: { marginTop: 14, padding: "8px 16px", background: "transparent", color: "var(--dim)" },
  err: { marginTop: 12, padding: "9px 11px", background: "#2a1a1f", border: "1px solid var(--bad)", color: "var(--bad)", borderRadius: 6, fontSize: 13, whiteSpace: "pre-wrap" as const },
  preview: { marginTop: 14, padding: 14, background: "var(--panel2)", border: "1px solid var(--line)", borderRadius: 8 },
};
