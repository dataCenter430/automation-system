export const metadata = {
  title: "Snorkel Automation Workflow",
  description: "Terminus task queue",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <style>{`
          :root {
            --bg: #0f1115; --panel: #171a21; --panel2: #1d212a; --line: #272c37;
            --text: #e6e8ec; --dim: #8b94a7; --accent: #7aa2f7; --ok: #7fd88f;
            --warn: #e0af68; --bad: #f7768e; --run: #7dcfff;
          }
          * { box-sizing: border-box; }
          body {
            margin: 0; background: var(--bg); color: var(--text);
            font: 14px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
          }
          button { font: inherit; cursor: pointer; border-radius: 6px; border: 1px solid var(--line); }
          textarea, input {
            font: inherit; background: var(--panel2); color: var(--text);
            border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; width: 100%;
          }
          textarea { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 13px; }
          input:focus, textarea:focus { outline: none; border-color: var(--accent); }
        `}</style>
        {children}
      </body>
    </html>
  );
}
