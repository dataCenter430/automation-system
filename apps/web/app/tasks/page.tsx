"use client";

import { AddTask } from "../components/AddTask";
import { Queue } from "../components/Queue";
import { useFleetData } from "../components/Shell";

/**
 * TASKS — where a task is born, and where a human decides its fate.
 *
 *   left   NEW TASK   paste the blob → Preview (parses, writes NOTHING) → Add, which lands
 *                     it as a DRAFT. Inert. The worker will never touch it.
 *   right  ALL TASKS  the full table, including the ACTIONS column that carries the two
 *                     gates — Start Build (DRAFT only) and Approve & Submit (AWAITING
 *                     APPROVAL only, behind a confirm) — plus Retry, Log and Session.
 *
 * The shell in layout.tsx already wraps this page: it owns the top bar, the fleet meters,
 * the desktop notifications and THE poller. So this page renders a body and nothing else,
 * and reads the tasks the shell has already fetched rather than opening a second 3s poll
 * against the same rows.
 */
export default function TasksPage() {
  const { tasks, events, error, refresh } = useFleetData();

  return (
    <>
      <style>{CSS}</style>

      {error && (
        <div
          className="mono"
          style={{
            background: "rgba(244,63,94,.07)", border: "1px solid var(--bad)",
            color: "var(--bad)", padding: "10px 12px", borderRadius: 8, marginBottom: 16,
            fontSize: 11.5, lineHeight: 1.6, whiteSpace: "pre-wrap",
          }}
        >
          {error}
        </div>
      )}

      <div className="tasks-grid">
        <AddTask onAdded={refresh} />
        <Queue tasks={tasks} events={events} onChanged={refresh} />
      </div>
    </>
  );
}

/* The new-task panel is a fixed rail; the table takes what is left and scrolls inside
   itself, so the page body never scrolls sideways. */
const CSS = `
  .tasks-grid {
    display: grid;
    gap: 18px;
    align-items: start;
    grid-template-columns: 380px minmax(0, 1fr);
  }
  @media (max-width: 1100px) {
    .tasks-grid { grid-template-columns: minmax(0, 1fr); }
  }
`;
