import { Shell } from "./components/Shell";

export const metadata = {
  title: "FLEET — Snorkel Automation Workflow",
  description: "Terminus task queue",
};

/**
 * The tokens live here, once. Every component reads them; nothing hard-codes a hex.
 *
 * Two colour systems, deliberately kept apart:
 *   BRAND    (--brand / --violet / --pink) — the FLEET dot, the active tab, the primary
 *            action. It is never a status. A pink row would mean nothing.
 *   SEMANTIC (--run / --ok / --warn / --bad) — what a task is DOING. These four are the
 *            only colours allowed to describe state, which is what makes eight rows
 *            scannable without reading a word.
 *
 * Dark only, on purpose: this sits next to a terminal at 2am.
 *
 * No webfonts — the CSP blocks CDNs, and a font that fails to load silently re-flows the
 * whole table. The mono stack is what the machine already has.
 */
const GLOBAL = `
:root {
  --bg: #0a0b10;
  --panel: #12141b;
  --panel2: #171a22;
  --line: #232733;
  --text: #e8eaf0;
  --dim: #6f7787;

  --brand: #e879f9;
  --violet: #8b5cf6;
  --pink: #ec4899;
  --grad-primary: linear-gradient(90deg, #8b5cf6, #ec4899);
  --grad-approve: linear-gradient(90deg, #4ade80, #22c55e);

  --run: #38bdf8;
  --ok: #4ade80;
  --warn: #fbbf24;
  --bad: #f43f5e;

  --mono: ui-monospace, "JetBrains Mono", "Cascadia Code", Menlo, Consolas, monospace;
  --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;

  color-scheme: dark;
}

* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; max-width: 100%; overflow-x: hidden; }
body {
  background: var(--bg);
  color: var(--text);
  font: 14px/1.55 var(--sans);
  -webkit-font-smoothing: antialiased;
}
code, pre, .mono { font-family: var(--mono); }
pre { margin: 0; }

/* Digits never dance. Every column of numbers is tabular. */
.num { font-variant-numeric: tabular-nums; font-feature-settings: "tnum" 1; }

/* Column headers and every other 10px label. */
.hdr {
  font: 10px/1 var(--mono);
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--dim);
}

/* State pill: the colour is the state's, the fill is nothing. */
.pill {
  display: inline-flex; align-items: center; gap: 5px;
  font: 10px/1 var(--mono);
  text-transform: uppercase; letter-spacing: 0.08em;
  border: 1px solid currentColor; border-radius: 4px;
  padding: 3px 6px; background: transparent; white-space: nowrap;
}
.dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: none; }

/* Motion, restrained: a 2s pulse on anything live, and nothing else that moves on its own. */
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
.pulse { animation: pulse 2s ease-in-out infinite; }
.meter-fill { transition: width 300ms ease; }
.row { transition: background 120ms ease; }
.row:hover { background: var(--panel2); }

button { font: inherit; cursor: pointer; border-radius: 6px; border: 1px solid var(--line); background: var(--panel2); color: var(--text); }
button:disabled { opacity: 0.45; cursor: not-allowed; }
input, textarea {
  font: inherit; background: var(--panel2); color: var(--text);
  border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; width: 100%;
}
textarea { font-family: var(--mono); font-size: 13px; }
input:focus, textarea:focus { outline: none; border-color: var(--violet); }
a { color: inherit; }

/* ---------------------------------------------------------------------------------------
   FOUR REGIONS, and the shape is load-bearing rather than decorative.

   +------+---------------------------------------+
   | rail |  table          (spans the full width) |
   |      +--------------------------+------------+
   |      |  transcript              |  gate      |
   +------+--------------------------+------------+

   The TABLE gets the whole width because it is the thing you scan: eight rows, six columns,
   and every one of them is a number or a state you are comparing ACROSS rows. Squeezing it
   into a middle column to keep a third rail company would cost the comparison, which is the
   only reason the table exists.

   The GATE drops BELOW it, beside the transcript, because both answer the same question —
   "what happened to the row I just clicked?" — and they should be read together. A gate
   verdict pinned to the top-right, level with a table row it has nothing to do with, is just
   a panel that happens to be nearby.

   The RAIL spans both rows: "is anything waiting on me?" is not scoped to a selection.
   --------------------------------------------------------------------------------------- */
.grid {
  display: grid; gap: 16px; align-items: start;
  grid-template-columns: 272px minmax(0, 1fr) 344px;
  grid-template-rows: auto minmax(0, 1fr);
  grid-template-areas:
    "rail table table"
    "rail main  gate";
}
.rail  { grid-area: rail;  min-width: 0; }
.table { grid-area: table; min-width: 0; }
.main  { grid-area: main;  min-width: 0; }
.gate  { grid-area: gate;  min-width: 0; }

/* Below ~1250 the transcript stops being wide enough to read a tool call in, so the gate
   goes under it rather than squeezing the thing you are actually reading. */
@media (max-width: 1250px) {
  .grid {
    grid-template-columns: 272px minmax(0, 1fr);
    grid-template-areas: "rail table" "rail main" "rail gate";
  }
}
@media (max-width: 900px) {
  .grid {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas: "table" "rail" "main" "gate";
  }
}
.scroll-x { overflow-x: auto; }

/* The meter bars in the top bar. Gradient fill, hairline track. */
.meter-track {
  height: 3px; border-radius: 3px; background: var(--line); overflow: hidden;
}
.meter-fill {
  display: block; height: 100%; border-radius: 3px;
  background: var(--grad-primary);
  transition: width 300ms ease;
}

/* A numbered gate card: circular verdict glyph, title, detail, ordinal. */
.gate-card {
  display: flex; align-items: flex-start; gap: 10px;
  border: 1px solid var(--line); border-radius: 8px;
  background: var(--panel2); padding: 11px 12px;
}
.gate-glyph {
  width: 18px; height: 18px; border-radius: 50%; flex: none; margin-top: 1px;
  display: grid; place-items: center;
  font: 700 10px/1 var(--mono);
  border: 1px solid currentColor;
}
.gate-ord {
  font: 10px/1 var(--mono); color: var(--dim);
  font-variant-numeric: tabular-nums; flex: none; margin-top: 3px;
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <style>{GLOBAL}</style>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
