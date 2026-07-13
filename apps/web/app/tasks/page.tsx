"use client";

import { useCallback, useEffect, useState } from "react";
import { Shell } from "../components/Shell";
import { AddTask } from "../components/AddTask";
import { Queue } from "../components/Queue";

/**
 * TASKS — where a task is born and where a human decides its fate.
 *
 * Left: NEW TASK. Paste the blob, preview what was parsed, add it as a DRAFT.
 * Right: ALL TASKS, the full table, with the ACTIONS column that carries the two gates
 *        (Start Build on DRAFT, Approve & Submit on AWAITING_APPROVAL) plus Retry, Log and
 *        Session.
 *
 * The poll is the same 3s poll the dashboard uses — /api/tasks returns every task, its
 * events, and the model/cost/tool-calls read back out of the session transcript on disk.
 */
export default function TasksPage() {
  const [data, setData] = useState<{ tasks: any[]; events: any[] }>({ tasks: [], events: [] });
  const [err, setErr] = useState<string | null>(null);

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

  return (
    <Shell>
      <style>{CSS}</style>

      {err && (
        <div style={{
          background: "rgba(244,63,94,.07)", border: "1px solid var(--bad)", color: "var(--bad)",
          padding: "10px 12px", borderRadius: 8, marginBottom: 18,
          font: '11.5px/1.6 ui-monospace, "JetBrains Mono", "Cascadia Code", Menlo, Consolas, monospace',
          whiteSpace: "pre-wrap",
        }}>
          {err}
        </div>
      )}

      <div className="t-grid">
        <AddTask onAdded={refresh} />
        <Queue tasks={data.tasks} events={data.events} onChanged={refresh} />
      </div>
    </Shell>
  );
}

const CSS = `
  .t-grid {
    display: grid;
    grid-template-columns: 380px minmax(0, 1fr);
    gap: 20px;
    align-items: start;
  }
  @media (max-width: 1100px) {
    .t-grid { grid-template-columns: minmax(0, 1fr); }
  }
`;
