/**
 * VS Code windows: open one per task, cap how many exist, close the ones that are done.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THERE IS A CAP
 *
 * Measured on the target machine: 14 GB free, a Docker gate capped at 4 GB and two of them
 * concurrent, and a VS Code window costing ~300 MB. Eight windows plus two gates does not fit,
 * and the failure mode is the machine going down mid-build with eight tasks in flight. The
 * operator asked for this and the arithmetic agrees with them.
 *
 * The cap is a POOL, not a queue. A task that cannot get a window still builds — it just does not
 * get an editor, and the dashboard says so. A build must never wait on a window.
 *
 * ---------------------------------------------------------------------------------------------
 * THE SAFETY PROPERTY, AND THE MISTAKE THAT PROVES WHY IT MATTERS
 *
 * VS Code shares ONE main process across every window, including the operator's. There is no
 * per-window PID; you cannot kill a window. So a window has to be closed through the window
 * manager, by X11 window id — and the only hard question in this file is HOW WE KNOW WHICH ID IS
 * OURS.
 *
 * The answer is NOT the title. The operator has windows open called
 *
 *     harden-go-mlflow-build-locks        (five days old, real work)
 *     alpha-op-precious-work
 *     bravo-task-slug
 *
 * Those are TASK SLUGS. VS Code titles a window by its folder's basename, so a title match cannot
 * tell their window from ours, and getting it wrong destroys a person's work.
 *
 * While building this, a throwaway cleanup script of mine did exactly that — matched on the title
 * "Visual Studio Code" — and closed a window it did not own. That is the whole reason this comment
 * is this long. THE RULE:
 *
 *     SNAPSHOT every window id BEFORE spawning.
 *     ADOPT only an id that was NOT in that snapshot and IS a VS Code window.
 *     CLOSE only ids that are in our ledger.
 *
 * The operator's windows existed before the snapshot. They can never be adopted, whatever they are
 * called, however similar to a slug. That is the entire argument and it does not depend on any
 * string comparison.
 *
 * ---------------------------------------------------------------------------------------------
 * VS CODE IS A VIEWER, NOT THE DRIVER
 *
 * The Agent SDK builds the task headlessly. The window is opened so you can WATCH — and it works
 * because the SDK writes its transcript to ~/.claude/projects/<slugified-cwd>/<session>.jsonl,
 * which is the same store the VS Code Claude extension reads. That is now VERIFIED rather than
 * assumed: the extension bundle contains, literally,
 *
 *     join(homedir(), ".claude"), "projects")
 *
 * so the Claude panel really does show this build's own conversation. A missing `code` binary,
 * a headless box, or no X11 must never fail a build: you lose a window, not a task.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  closeWindow, isVsCodeWindow, listWindows, windowPid, windowTitle, x11Available, type WindowId,
} from "./x11.ts";

export interface OpenWindow {
  workspace: string;
  /** The X11 window id we adopted. The ONLY thing we are ever allowed to close. */
  id: WindowId;
  /**
   * The PID of the VS Code instance this window belonged to when we adopted it.
   *
   * Every VS Code window shares one main process, so this does NOT identify the window — it
   * identifies the INSTANCE, which is exactly the question we need answered before closing:
   * "is this still the same VS Code I adopted into?" If VS Code has restarted since, the id we
   * wrote down has been recycled and now means nothing. We refuse to close it.
   */
  pid: number;
  openedAt: number;
  /**
   * A LOGICAL clock, not a wall clock. Decides who gets evicted when the pool is full.
   *
   * This was Date.now() and it was wrong. Date.now() has millisecond resolution, so opening or
   * touching several windows inside the same millisecond gives them IDENTICAL timestamps and the
   * eviction sort becomes non-deterministic — it evicts whichever one the sort happened to put
   * first. The test caught it only when the suite was under load, which is precisely when the cap
   * does its job. A monotonic counter cannot tie.
   */
  usedAt: number;
}

/** Ticks once per use. Never goes backwards, never collides, does not care what time it is. */
let clock = 0;
const tick = (): number => (clock += 1);

/**
 * The window manager, as a dependency.
 *
 * Injected rather than imported, for one reason: the safety property of this file is a claim about
 * HOW these four functions are used, and a claim like that has to be TESTABLE. With a direct
 * import it is not — ES module bindings are immutable, so a test cannot stand in a fake X server,
 * and the only way to check "does it ever close the operator's window?" would be to open the
 * operator's window and find out.
 *
 * So: the pool takes an X11 it can be lied to about, and the tests lie to it — handing it windows
 * named exactly like the operator's real ones and asserting they are never touched.
 */
export interface X11Api {
  available(): boolean;
  list(): Promise<Set<WindowId>>;
  isVsCode(id: WindowId): Promise<boolean>;
  title(id: WindowId): Promise<string>;
  /** The owning client's PID. All VS Code windows share one — that is the point, see OpenWindow.pid. */
  pid(id: WindowId): Promise<number | null>;
  close(id: WindowId): Promise<void>;
}

/** The real one. */
export const realX11: X11Api = {
  available: x11Available,
  list: listWindows,
  isVsCode: isVsCodeWindow,
  title: windowTitle,
  pid: windowPid,
  close: closeWindow,
};

export interface EditorPoolOpts {
  /** How many windows may exist at once. */
  max: number;
  onNote?: (msg: string) => void;
  /** How the window gets launched. Overridable so a test can decide what (if anything) appears. */
  launch?: (workspace: string) => void;
  x11?: X11Api;
}

/**
 * The in-memory ledger of windows WE opened.
 *
 * In memory, and nowhere else — see the NO PERSISTENCE note below. It dies with the worker, and a
 * crashed worker's windows are never touched again.
 */
export class EditorPool {
  private windows = new Map<string, OpenWindow>();
  private readonly max: number;
  private readonly note: (msg: string) => void;
  private readonly x11: X11Api;
  private readonly launch: (workspace: string) => void;
  /** Serialises open/close: two concurrent opens racing the snapshot would adopt each other's window. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(o: EditorPoolOpts) {
    this.max = Math.max(0, o.max);
    this.note = o.onNote ?? (() => {});
    this.x11 = o.x11 ?? realX11;
    this.launch =
      o.launch ??
      ((workspace) => {
        spawn("code", ["--new-window", workspace], {
          detached: true,
          stdio: "ignore",
          // NOT windowsHide: on Windows, Electron inherits nCmdShow for its first window and would
          // open VS Code invisibly — real, focusable, and impossible to see.
        }).unref();
      });
  }

  get size(): number {
    return this.windows.size;
  }

  list(): OpenWindow[] {
    return [...this.windows.values()];
  }

  /** Run fn with the pool locked. The snapshot/adopt dance is not safe to interleave. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
  }

  // ------------------------------------------------------------ NO PERSISTENCE, ON PURPOSE
  //
  // An earlier version of this file PERSISTED the ledger and re-adopted its windows on restart, so
  // a crashed worker would not orphan them. An adversarial review killed it, and it was right on
  // both counts:
  //
  //   1. X WINDOW IDS ARE RECYCLED. Measured on this machine: six consecutive X clients were each
  //      allocated the identical id 0x5600001. The server frees and immediately reissues a client's
  //      resource-id base on disconnect. So after VS Code restarts — an update, a crash, or the
  //      operator quitting for the night — a window id we wrote down can come to mean a DIFFERENT
  //      window. Possibly one of theirs.
  //
  //   2. THE TITLE CHECK THAT WAS SUPPOSED TO CATCH THAT DOES NOT WORK. It re-verified a recorded
  //      id by checking the window's title still contained the workspace basename, and I argued
  //      that verifying an id is not the same as searching by title. It is, when the titles
  //      collide — and on this machine they DO:
  //
  //          workspace/automate-c-graphviz-worker-stained-glass-vault              (ours)
  //          ~/Documents/Working/automate-c-graphviz-worker-stained-glass-vault    (the operator's)
  //
  //      The same task, in both places, with a byte-identical window title. The operator works on
  //      the very tasks this system builds. The collision is not a coincidence; it is the job.
  //
  // So the ledger lives in memory and dies with the worker. A crashed worker leaves its windows
  // open and we NEVER touch them again — they are the operator's problem to close, which is a mild
  // annoyance. The alternative is a system that can close a stranger's window, and that is not a
  // trade.

  // ------------------------------------------------------------------ open

  /**
   * Open a window for this workspace, if there is room.
   *
   * Returns true if a window is now open for it. NEVER throws and never blocks a build: an editor
   * is a convenience, and a task that cannot get one still builds.
   */
  async open(workspace: string): Promise<boolean> {
    return this.serial(async () => {
      const have = this.windows.get(workspace);
      if (have) {
        have.usedAt = tick();
        return true;
      }
      if (this.max === 0) return false;

      if (!this.x11.available()) {
        this.note("no X11 display — skipping the editor window (the build is unaffected)");
        return false;
      }

      // Make room. Evict the least-recently-used window rather than refusing: the operator asked
      // for the FINISHED ones to close, and the LRU one is the best proxy we have for "finished"
      // when nothing has been explicitly released.
      if (this.windows.size >= this.max) {
        const victim = [...this.windows.values()].sort((a, b) => a.usedAt - b.usedAt)[0];
        if (!victim) return false;
        this.note(`editor pool full (${this.max}) — closing the least-recently-used: ${basename(victim.workspace)}`);
        await this.closeOne(victim);
      }

      // ---- THE SAFETY PROPERTY ---------------------------------------------------------------
      // Everything that exists RIGHT NOW is, by definition, not ours. Anything that appears after
      // this line and is a VS Code window, is.
      const before = await this.x11.list();

      try {
        this.launch(workspace);
      } catch (e) {
        this.note(`could not launch VS Code (${(e as Error).message}) — the build continues without it`);
        return false;
      }

      const id = await this.adopt(before);
      if (id === null) {
        this.note(
          `VS Code did not open a new window for ${basename(workspace)} within 20s — ` +
            `continuing without an editor. NOTHING was adopted, so nothing can be wrongly closed.`,
        );
        return false;
      }

      const pid = (await this.x11.pid(id)) ?? -1;
      this.windows.set(workspace, { workspace, id, pid, openedAt: Date.now(), usedAt: tick() });
      this.note(
        `opened VS Code on ${basename(workspace)} (${this.windows.size}/${this.max}) — ` +
          `the Claude panel shows this build's own session`,
      );
      return true;
    });
  }

  /**
   * Wait for EXACTLY ONE new VS Code window, and adopt it. Anything else: adopt nothing.
   *
   * The diff proves NOVELTY. It does not prove AUTHORSHIP — and an earlier version of this took
   * "the first new VS Code window" and called it ours. That is unsound, and the attack is not
   * exotic: the operator opens their own copy of the very task we are building (they have one; the
   * folders collide by name), our spawn is slow or reuses an existing window and contributes
   * nothing, and the single new window in the diff is THEIRS.
   *
   * So: two or more new windows is AMBIGUOUS, and ambiguity means we take none of them. A lost
   * window is cosmetic. Adopting somebody's five-day-old session is not.
   */
  private async adopt(before: Set<WindowId>): Promise<WindowId | null> {
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 500));

      const fresh: WindowId[] = [];
      for (const id of await this.x11.list()) {
        if (before.has(id)) continue;              // existed before we spawned => NOT OURS. Ever.
        if (this.claimed().has(id)) continue;      // already adopted for another workspace
        if (await this.x11.isVsCode(id)) fresh.push(id);
      }

      if (fresh.length === 1) return fresh[0]!;
      if (fresh.length > 1) {
        this.note(
          `${fresh.length} new VS Code windows appeared while opening this task — one of them may ` +
            `not be ours, so NONE were adopted. The build continues without an editor.`,
        );
        return null;
      }
      // zero so far: keep waiting.
    }
    return null;
  }

  private claimed(): Set<WindowId> {
    return new Set([...this.windows.values()].map((w) => w.id));
  }

  // ------------------------------------------------------------------ close

  /**
   * The task is done with its window. Close it.
   *
   * A no-op for a workspace we have no window for — which is the common case, and must stay quiet.
   */
  async release(workspace: string, why: string): Promise<void> {
    return this.serial(async () => {
      const w = this.windows.get(workspace);
      if (!w) return;
      this.note(`closing VS Code on ${basename(workspace)} — ${why}`);
      await this.closeOne(w);
    });
  }

  /** Mark a workspace as recently active, so it is not the one evicted when the pool fills. */
  touch(workspace: string): void {
    const w = this.windows.get(workspace);
    if (w) w.usedAt = tick();
  }

  /**
   * Close ONE window, by the id in our ledger. This is the only place a window is ever closed, and
   * the id comes from the ledger and nowhere else — never from a title, never from a search.
   */
  private async closeOne(w: OpenWindow): Promise<void> {
    this.windows.delete(w.workspace);

    // ---- THE LAST GATE, and it fails CLOSED ---------------------------------------------------
    //
    // X window ids are RECYCLED. Measured here: six consecutive X clients were each allocated the
    // identical id. The server reissues a client's resource-id base the moment it disconnects. So
    // if VS Code has restarted since we adopted — an update, a crash, the operator quitting for the
    // night — the id we are holding may now belong to a completely different window.
    //
    // Every VS Code window shares one main process, so its PID identifies the INSTANCE. If the PID
    // behind this id is not the one we adopted into, VS Code restarted and our id means nothing.
    // We do not close it. We do not go looking for the "real" one by title, because the operator
    // has folders whose names are byte-identical to our task slugs.
    //
    // The cost of being wrong here is somebody's five-day-old session. The cost of refusing is a
    // window left open. That is not a close call.
    try {
      const now = await this.x11.pid(w.id);
      if (now !== null && w.pid !== -1 && now !== w.pid) {
        this.note(
          `NOT closing the window for ${basename(w.workspace)}: VS Code has restarted since we ` +
            `opened it (pid ${w.pid} -> ${now}), so window id 0x${w.id.toString(16)} may now belong ` +
            `to someone else. X recycles window ids. Leaving it alone.`,
        );
        return;
      }
      await this.x11.close(w.id);
    } catch (e) {
      // A window we could not close is an orphan on screen. Annoying, never dangerous.
      this.note(`could not close the window for ${basename(w.workspace)}: ${(e as Error).message}`);
    }
  }

  /** Close everything we opened. For a clean worker shutdown. */
  async closeAll(): Promise<void> {
    return this.serial(async () => {
      for (const w of [...this.windows.values()]) await this.closeOne(w);
    });
  }
}
