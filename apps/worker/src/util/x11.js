/**
 * The smallest possible X11 client: enumerate windows, and politely ask the window manager to
 * close ONE of them, by id.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THIS FILE EXISTS AT ALL
 *
 * The worker opens a VS Code window per task so you can watch the build. Windows accumulate, and
 * eight of them plus two Docker gates does not fit in this machine's RAM. So they have to be
 * closed. And closing a VS Code window turns out to be the hardest part of the whole feature:
 *
 *   - There is NO per-window process. `code <path>` on a running VS Code sends an IPC message to
 *     the existing MAIN process and exits. Every window — ours and the operator's — is a renderer
 *     inside one shared process tree. You cannot kill a window.
 *
 *   - Killing that main process closes EVERY window, including the operator's. On this machine
 *     that is a five-day-old session with unsaved work.
 *
 *   - `xkill` is worse than it sounds: it kills the X CLIENT, which is that same shared main
 *     process. Same catastrophe, one keystroke.
 *
 *   - VS Code's CLI has no `close` verb. `--reuse-window` REPLACES the folder in an existing
 *     window, and VS Code picks which one — possibly the operator's. That is a hijack, not a close.
 *
 *   - Giving each task its own instance (`--user-data-dir`) DOES give us a killable PID, and the
 *     isolation is perfect. Measured on this machine: 1,404 MB per instance. Six of those is
 *     8.2 GB, on top of Docker's 8 GB. It does not fit. A window in the SHARED instance costs
 *     ~300 MB. That is a 4.5x difference and it decided the design.
 *
 * So: shared instance, and close the window through the window manager, by id.
 *
 * ---------------------------------------------------------------------------------------------
 * THE SAFETY PROPERTY — READ THIS BEFORE CHANGING ANYTHING HERE
 *
 * We NEVER identify a window by its title. The operator's open window is
 *
 *     ~/Documents/Working/harden-go-mlflow-build-locks
 *
 * and VS Code titles windows by the folder's BASENAME. That name IS a task slug — it looks
 * exactly like the ones this system generates. A title match cannot tell their window from ours,
 * and getting it wrong destroys their work.
 *
 * Instead: snapshot every window id BEFORE spawning, and adopt only an id that did not exist in
 * that snapshot. Their window existed before the snapshot, so it can never be adopted, whatever it
 * is called. That is the entire argument, and it holds no matter how similar the titles are.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY `xprop` FOR READS AND THE x11 SOCKET FOR THE WRITE
 *
 * xprop is installed everywhere and is read-only — it cannot close anything, which makes it the
 * right tool for the part that only needs to look. Closing needs a client that can send an event,
 * and the two standard ones (wmctrl, xdotool) are not installed and need sudo. `x11` is a pure-JS
 * X protocol client: no system package, no sudo, no native build.
 */
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
/** X11 is not always there — a headless box, a Wayland session, a worker with no DISPLAY. */
export function x11Available() {
    if (!process.env.DISPLAY)
        return false;
    try {
        execFileSync("xprop", ["-root", "_NET_SUPPORTED"], { stdio: "ignore", timeout: 3000 });
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Every top-level window the window manager knows about, right now.
 *
 * `_NET_CLIENT_LIST` is the EWMH property every compliant WM maintains. Reading it is the cheapest
 * honest way to answer "what exists", and it is the basis of the whole safety argument: a window
 * that is in this set BEFORE we spawn is, by construction, not ours.
 */
export async function listWindows() {
    try {
        const { stdout } = await execFileAsync("xprop", ["-root", "_NET_CLIENT_LIST"], { timeout: 5000 });
        return new Set([...stdout.matchAll(/0x[0-9a-f]+/gi)].map((m) => parseInt(m[0], 16)));
    }
    catch {
        return new Set();
    }
}
/** One property of one window, as a raw string. Empty when the window is gone. */
export async function windowProp(id, prop) {
    try {
        const { stdout } = await execFileAsync("xprop", ["-id", `0x${id.toString(16)}`, prop], { timeout: 5000 });
        return stdout.trim();
    }
    catch {
        return "";
    }
}
/** Is this window a VS Code window? (WM_CLASS, not the title — the title is attacker-shaped.) */
export async function isVsCodeWindow(id) {
    return /"[Cc]ode"/.test(await windowProp(id, "WM_CLASS"));
}
/**
 * The PID of the client that owns this window.
 *
 * For VS Code this is the SHARED main process — every window reports the same one. That is not a
 * limitation here, it is the whole point: it answers "is this still the same VS Code instance?",
 * which is the only question that makes a recorded window id meaningful. X recycles window ids on
 * client disconnect, so an id from before a VS Code restart is a number, not a window.
 */
export async function windowPid(id) {
    const raw = await windowProp(id, "_NET_WM_PID");
    const m = /= (\d+)/.exec(raw);
    return m ? Number(m[1]) : null;
}
/** The window's title. For LOGGING ONLY. Never for deciding what to close. */
export async function windowTitle(id) {
    const raw = await windowProp(id, "_NET_WM_NAME");
    return /= "(.*)"/.exec(raw)?.[1] ?? "";
}
/**
 * Ask the window manager to close ONE window, by id.
 *
 * This sends `_NET_CLOSE_WINDOW` — the EWMH message that means "the user clicked the [x]". It is
 * a REQUEST, not a kill: the window manager relays WM_DELETE_WINDOW to the application, which
 * gets to run its own shutdown. A shared main process survives, and every other window with it.
 * That is exactly what we want and exactly what `kill` would not give us.
 *
 * The 32-byte ClientMessage is built by hand because this x11 version does not expose a
 * marshaller. The layout is fixed by the X protocol:
 *
 *     0   BYTE    type   = 33 (ClientMessage)
 *     1   BYTE    format = 32
 *     2   CARD16  sequence (unused on a sent event)
 *     4   WINDOW  the window to close
 *     8   ATOM    _NET_CLOSE_WINDOW
 *    12   32-bit  timestamp        (0 = CurrentTime)
 *    16   32-bit  source indication (2 = a direct user action, which is what we are impersonating)
 *    20   12 bytes of zero
 */
export async function closeWindow(id) {
    const x11 = (await import("x11"));
    await new Promise((resolve, reject) => {
        x11.createClient((err, display) => {
            if (err)
                return reject(err instanceof Error ? err : new Error(String(err)));
            const X = display.client;
            const root = display.screen[0].root;
            X.InternAtom(false, "_NET_CLOSE_WINDOW", (e, atom) => {
                if (e)
                    return reject(e instanceof Error ? e : new Error(String(e)));
                const ev = Buffer.alloc(32);
                ev.writeUInt8(33, 0); // ClientMessage
                ev.writeUInt8(32, 1); // format: 32-bit data
                ev.writeUInt16LE(0, 2); // sequence
                ev.writeUInt32LE(id, 4); // the window — THE ONLY THING THAT DECIDES WHAT DIES
                ev.writeUInt32LE(atom, 8); // _NET_CLOSE_WINDOW
                ev.writeUInt32LE(0, 12); // timestamp: CurrentTime
                ev.writeUInt32LE(2, 16); // source: direct user action
                // 20..31 stay zero
                // Sent to the ROOT window: SubstructureRedirect|SubstructureNotify is how a client asks
                // the WM to act on another client's window.
                const SUBSTRUCTURE_REDIRECT = 1 << 20;
                const SUBSTRUCTURE_NOTIFY = 1 << 19;
                X.SendEvent(root, false, SUBSTRUCTURE_REDIRECT | SUBSTRUCTURE_NOTIFY, ev);
                // The socket is fire-and-forget; give the WM a moment to act before we tear it down.
                setTimeout(() => {
                    try {
                        X.terminate?.();
                    }
                    catch { /* the client is going away anyway */ }
                    resolve();
                }, 400);
            });
        });
    });
}
