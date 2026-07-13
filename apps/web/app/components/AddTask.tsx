"use client";

import { useState } from "react";

/**
 * Paste → Preview → Add. RESTYLED, NOT REDESIGNED: every byte of behaviour below is the
 * behaviour that was here before.
 *
 * The preview step is the whole point: you see the six parsed fields and the resolved
 * task.toml enums BEFORE anything is written. A blob that mis-splits gets caught here, in
 * two seconds, rather than 45 minutes into a build of the wrong task.
 *
 * Note what this form deliberately does NOT have:
 *   - no MODEL field. The model is pinned in config/pipeline.json; it is provenance, not a
 *     choice, and the queue reads back the one that actually ran.
 *   - no INITIAL STATE field. It would let a human drop a task straight into
 *     AWAITING_APPROVAL and skip the Docker gate entirely. Everything lands at DRAFT.
 */

/** The stack is defined once, in layout.tsx. Nothing here re-declares it. */
const MONO = "var(--mono)";

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

  /** Local state only. Writes nothing, calls nothing. */
  function doClear() {
    setTaskId(""); setBlob(""); setPreview(null); setSlug(""); setError(null);
  }

  const dirty = !!(taskId || blob || preview);

  return (
    <section style={S.card}>
      <style>{CSS}</style>

      <h2 style={S.h2}>New task</h2>

      <label style={S.label} htmlFor="at-uuid">Task UUID</label>
      <input
        id="at-uuid"
        style={S.input}
        value={taskId}
        onChange={(e) => setTaskId(e.target.value)}
        placeholder="a5de5c52-a2ed-412d-b8a4-744b794b1796"
        spellCheck={false}
      />

      <label style={{ ...S.label, marginTop: 16 }} htmlFor="at-blob">Task text</label>
      <textarea
        id="at-blob"
        style={{ ...S.input, ...S.area }}
        value={blob}
        onChange={(e) => { setBlob(e.target.value); setPreview(null); }}
        rows={10}
        placeholder={"Interactive Challenges & Games/Long Context, DB Interaction\n\nAutomate C Graphviz Worker for Stained-Glass Vault Replays\n\nThe vault referee stalls whenever…\n\nC\nSQL\nPOSIX shell\nAdditional Inspiration\nA small C project skeleton with a Makefile…"}
        spellCheck={false}
      />

      {error && <div style={S.err}>{error}</div>}

      {!preview ? (
        <div style={S.actions}>
          <button
            className="a-btn"
            style={S.primary}
            disabled={busy || !blob.trim()}
            onClick={doParse}
          >
            {busy ? "Parsing…" : "Preview"}
          </button>
          <button className="a-btn" style={S.quiet} disabled={busy || !dirty} onClick={doClear}>
            Clear
          </button>
        </div>
      ) : (
        <>
          {/* THE SIX PARSED FIELDS — exactly what will be written to the six columns. */}
          <div style={S.preview}>
            <div style={S.previewHead}>Parsed</div>
            <Row k="Category"      v={preview.parsed.category} />
            <Row k="Sub-category"  v={preview.parsed.sub_category} />
            <Row k="Title"         v={preview.parsed.title} />
            <Row k="Languages"     v={preview.parsed.languages} />
            <Row k="Description"   v={preview.parsed.description} clamp />
            <Row k="Additional"    v={preview.parsed.additional_note ?? "(none)"} clamp />

            {/* THE RESOLVED CLOSED VOCABULARIES. A blocked category comes back as
                taxonomyError, and while it is set the add button below stays disabled. */}
            <div style={{ borderTop: "1px solid var(--line)", margin: "12px 0 0", paddingTop: 12 }}>
              <div style={S.previewHead}>Resolved for task.toml</div>
              {preview.taxonomyError ? (
                <div style={{ ...S.err, marginTop: 0 }}>{preview.taxonomyError}</div>
              ) : (
                <div style={{ font: `11.5px/1.7 ${MONO}`, color: "var(--ok)", wordBreak: "break-word" }}>
                  <div>category = &quot;{preview.toml.category}&quot;</div>
                  <div>subcategories = {JSON.stringify(preview.toml.subcategories)}</div>
                  <div>languages = {JSON.stringify(preview.toml.languages)}</div>
                </div>
              )}
            </div>
          </div>

          {/* The slug names the workspace, the zip, the docker image and Claude's session.
              Editable here; validated server-side, where a clash is refused. */}
          <label style={{ ...S.label, marginTop: 16 }} htmlFor="at-slug">Slug / zip name</label>
          <input
            id="at-slug"
                style={{ ...S.input, fontFamily: MONO, fontSize: 12.5 }}
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            spellCheck={false}
          />

          <div style={S.actions}>
            <button
              className="a-btn"
              style={S.primary}
              disabled={busy || !taskId.trim() || !!preview.taxonomyError}
              onClick={doAdd}
            >
              Add to queue
            </button>
            <button className="a-btn" style={S.quiet} disabled={busy} onClick={() => setPreview(null)}>
              Back
            </button>
          </div>

          <p style={S.note}>
            This only queues it as a <b style={{ color: "var(--text)" }}>draft</b>. Nothing builds
            until you press <b style={{ color: "var(--text)" }}>Start Build</b>.
          </p>
        </>
      )}
    </section>
  );
}

function Row({ k, v, clamp }: { k: string; v: string; clamp?: boolean }) {
  return (
    <div style={{ display: "flex", gap: 10, padding: "4px 0", alignItems: "flex-start" }}>
      <span style={{
        font: `10px/1.6 ${MONO}`, letterSpacing: ".1em", textTransform: "uppercase",
        color: "var(--dim)", minWidth: 92, flexShrink: 0, paddingTop: 1,
      }}>
        {k}
      </span>
      <span style={{
        fontSize: 12.5, lineHeight: 1.5, color: "var(--text)", minWidth: 0, wordBreak: "break-word",
        ...(clamp ? { display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical" as const, overflow: "hidden" } : {}),
      }}>
        {v}
      </span>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  card: {
    background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 10,
    padding: 18, minWidth: 0,
  },
  h2: {
    margin: "0 0 16px", font: `600 11px/1 ${MONO}`, letterSpacing: ".12em",
    textTransform: "uppercase", color: "var(--text)",
  },
  label: {
    display: "block", font: `500 10px/1 ${MONO}`, letterSpacing: ".12em",
    textTransform: "uppercase", color: "var(--dim)", marginBottom: 7,
  },
  input: {
    width: "100%", background: "var(--panel2)", color: "var(--text)",
    border: "1px solid var(--line)", borderRadius: 6, padding: "9px 11px",
    fontSize: 13, fontFamily: MONO,
  },
  area: { minHeight: 200, resize: "vertical", lineHeight: 1.55, fontSize: 12.5 },
  actions: { display: "flex", gap: 8, marginTop: 16, alignItems: "center" },
  primary: {
    padding: "9px 16px", borderRadius: 6, border: "1px solid transparent", cursor: "pointer",
    background: "var(--grad-primary, linear-gradient(90deg,#8b5cf6,#ec4899))", color: "#fff",
    font: `600 10px/1 ${MONO}`, letterSpacing: ".1em", textTransform: "uppercase",
  },
  quiet: {
    padding: "9px 14px", borderRadius: 6, border: "1px solid var(--line)", cursor: "pointer",
    background: "transparent", color: "var(--dim)",
    font: `500 10px/1 ${MONO}`, letterSpacing: ".1em", textTransform: "uppercase",
  },
  err: {
    marginTop: 14, padding: "10px 12px", background: "rgba(244,63,94,.07)",
    border: "1px solid var(--bad)", color: "var(--bad)", borderRadius: 6,
    font: `11.5px/1.6 ${MONO}`, whiteSpace: "pre-wrap", wordBreak: "break-word",
    maxHeight: 260, overflow: "auto",
  },
  preview: {
    marginTop: 16, padding: 14, background: "var(--panel2)",
    border: "1px solid var(--line)", borderRadius: 8,
  },
  previewHead: {
    font: `500 10px/1 ${MONO}`, letterSpacing: ".12em", textTransform: "uppercase",
    color: "var(--dim)", marginBottom: 8,
  },
  note: { margin: "12px 0 0", fontSize: 12, lineHeight: 1.6, color: "var(--dim)" },
};

/* Input focus, the disabled state and the reduced-motion kill switch all come from
   layout.tsx. The only thing this file adds is a hover on its own buttons. */
const CSS = `
  .a-btn { transition: filter 120ms ease; }
  .a-btn:hover:not(:disabled) { filter: brightness(1.14); }
`;
