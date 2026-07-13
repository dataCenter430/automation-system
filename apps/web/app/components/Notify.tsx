"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Tell the human when the machine needs them.
 *
 * The whole design parks tasks at two places and waits: NEEDS_HUMAN (something ambiguous —
 * a broken selector, an inconclusive verdict, an unconfirmed Submit button) and
 * AWAITING_APPROVAL (Snorkel's checks are green; the irreversible click is yours). With one
 * task you notice. With eight running for two hours each, you will not be looking at the tab
 * when it happens, and a task can sit parked for hours for no reason.
 *
 * So: a real desktop notification, via the browser's Notification API. Chrome shows it as an
 * OS-level alert even when the tab is in the background.
 *
 * Notified once per (task, state). Re-notifying on every 3-second poll would train you to
 * dismiss them without reading, which is worse than not notifying at all.
 */

const WANTS_YOU: Record<number, { title: string; body: (slug: string) => string; urgent: boolean }> = {
  [-2]: {
    title: "Task needs you",
    body: (s) => `${s} stopped and is asking for a human. It refused to guess.`,
    urgent: true,
  },
  [-1]: {
    title: "Task failed",
    body: (s) => `${s} failed. Open its Log to see why.`,
    urgent: false,
  },
  70: {
    title: "Ready to submit",
    body: (s) => `${s} passed Snorkel's checks. The Submit click is yours.`,
    urgent: true,
  },
};

export function Notify({ tasks }: { tasks: any[] }) {
  const [perm, setPerm] = useState<NotificationPermission>("default");
  const seen = useRef<Set<string>>(new Set());
  const primed = useRef(false);

  useEffect(() => {
    if (typeof Notification !== "undefined") setPerm(Notification.permission);
  }, []);

  useEffect(() => {
    if (perm !== "granted" || typeof Notification === "undefined") return;

    // On the first render after load, record what is ALREADY parked without alerting. A page
    // refresh should not re-fire a notification for something that has been sitting there
    // since yesterday.
    //
    // A live QUESTION is the exception: it is not "parked", it is a Claude session frozen
    // right now, burning a build slot and a countdown. If one is open when you load the page,
    // you should be told — even if it was asked before you got here.
    if (!primed.current) {
      for (const t of tasks) {
        if (WANTS_YOU[t.pipeline_state]) seen.current.add(`${t.task_id}:${t.pipeline_state}`);
      }
      primed.current = true;
    }

    for (const t of tasks) {
      // ---- A build stopped to ask you something. This outranks every state below. ----
      //
      // Keyed by the QUESTION id, not the task: one task can ask several questions over a
      // two-hour build, and each is a fresh reason to interrupt you. requireInteraction is
      // non-negotiable here — a question notification that fades away after four seconds is
      // a build slot frozen for thirty minutes because you were making coffee.
      if (t.question) {
        const key = `q:${t.question.id}`;
        if (!seen.current.has(key)) {
          seen.current.add(key);
          const n = new Notification("Claude is asking you", {
            body: `${t.slug ?? t.task_id.slice(0, 8)} — ${t.question.question}`,
            tag: key,
            requireInteraction: true,
          });
          n.onclick = () => {
            window.focus();
            n.close();
          };
        }
        continue;
      }

      const rule = WANTS_YOU[t.pipeline_state];
      if (!rule) continue;
      const key = `${t.task_id}:${t.pipeline_state}`;
      if (seen.current.has(key)) continue;
      seen.current.add(key);

      const n = new Notification(rule.title, {
        body: rule.body(t.slug ?? t.task_id.slice(0, 8)),
        tag: key,                    // Chrome collapses duplicates by tag
        requireInteraction: rule.urgent, // the approval prompt should not vanish on its own
      });
      n.onclick = () => {
        window.focus();
        n.close();
      };
    }
  }, [tasks, perm]);

  if (typeof Notification === "undefined") return null;

  if (perm === "granted") {
    return (
      <span style={{ fontSize: 11.5, color: "var(--dim)" }}>
        🔔 desktop alerts on — you will be told when a task needs you
      </span>
    );
  }

  if (perm === "denied") {
    return (
      <span style={{ fontSize: 11.5, color: "var(--warn)" }}>
        🔕 desktop alerts blocked in Chrome — a parked task will wait silently until you look
      </span>
    );
  }

  return (
    <button
      onClick={async () => setPerm(await Notification.requestPermission())}
      style={{
        padding: "4px 10px", fontSize: 12, cursor: "pointer",
        background: "var(--panel2)", color: "var(--text)",
      }}
    >
      🔔 Enable desktop alerts
    </button>
  );
}
