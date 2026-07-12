"use client";

import { useCallback, useEffect, useState } from "react";
import { AddTask } from "./components/AddTask";
import { Queue } from "./components/Queue";
import { Notify } from "./components/Notify";

export default function Page() {
  const [data, setData] = useState<{ tasks: any[]; events: any[] }>({ tasks: [], events: [] });
  const [err, setErr] = useState<string | null>(null);
  const [owner, setOwner] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/tasks", { cache: "no-store" });
      const j = await r.json();
      if (j.error) setErr(j.error);
      else { setData(j); setErr(null); }
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  // Show whose name new tasks will be filed under. Submitting a batch under the wrong owner
  // is annoying to undo, so it belongs on screen rather than buried in a settings page.
  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((j) => setOwner(j?.activeOwner ?? null))
      .catch(() => {});
  }, []);

  return (
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: "32px 24px 80px" }}>
      <header style={{ marginBottom: 28, display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>Snorkel Automation Workflow</h1>
          <p style={{ margin: "6px 0 0", color: "var(--dim)" }}>
            Terminus task queue. Adding a task does not start it — you decide when.
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
          {/* With eight two-hour builds running, you will not be watching the tab at the
              moment one parks and asks for you. */}
          <Notify tasks={data.tasks} />
          <a
            href="/settings"
            style={{
              color: "var(--dim)", textDecoration: "none", fontSize: 13,
              border: "1px solid var(--line)", borderRadius: 6, padding: "6px 12px",
              whiteSpace: "nowrap",
            }}
          >
            Settings{owner ? ` · ${owner}` : ""}
          </a>
        </div>
      </header>

      {err && (
        <div style={{
          background: "#2a1a1f", border: "1px solid var(--bad)", color: "var(--bad)",
          padding: "10px 12px", borderRadius: 8, marginBottom: 20,
        }}>
          {err}
        </div>
      )}

      <AddTask onAdded={refresh} />
      <Queue tasks={data.tasks} events={data.events} onChanged={refresh} />
    </main>
  );
}
