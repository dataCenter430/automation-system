/**
 * The VS Code window pool.
 *
 * There is exactly one thing that can go badly wrong here, and it is not a crash: it is CLOSING A
 * WINDOW SOMEBODY ELSE OPENED. The operator has windows called
 *
 *     harden-go-mlflow-build-locks     (five days old, real work)
 *     alpha-op-precious-work
 *     bravo-task-slug
 *
 * Those are TASK SLUGS. VS Code titles a window by its folder basename, so nothing about a title
 * can distinguish their window from ours. Every test below exists to prove the code never tries.
 *
 * These are pure unit tests over the pool's decision logic — X11 is stubbed. The X layer itself was
 * proven end to end against the real display: a window was opened, adopted by diff, closed by id,
 * with zero collateral.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// ---------------------------------------------------------------------------------------------
// A fake X server. It models the ONE thing that matters: which window ids exist, and which of them
// belong to the operator (and must therefore survive everything this pool does).
// ---------------------------------------------------------------------------------------------
class FakeX {
    windows = new Map();
    closed = [];
    next = 0x100;
    /** A window the OPERATOR opened. If any of these is ever closed, the test has failed. */
    operatorWindow(title) {
        const id = this.next++;
        this.windows.set(id, { title, isCode: true, owner: "operator" });
        return id;
    }
    /** VS Code opening a window in response to our spawn. */
    spawnForUs(title) {
        const id = this.next++;
        this.windows.set(id, { title, isCode: true, owner: "us" });
        return id;
    }
    close(id) {
        this.closed.push(id);
        this.windows.delete(id);
    }
    operatorWindowsAlive() {
        return [...this.windows.values()].filter((w) => w.owner === "operator").length;
    }
    closedAnOperatorWindow() {
        // A window we closed that we never opened.
        return this.closed.some((id) => !this.ourIds.has(id));
    }
    ourIds = new Set();
    /** Every VS Code window shares one main process. Bumping this simulates a VS Code RESTART. */
    vscodePid = 4242;
}
/**
 * Build a pool wired to the fake X server.
 *
 * The pool takes its X11 and its launcher as DEPENDENCIES, which is the only reason this test can
 * exist: ES module bindings are immutable, so a monkeypatch of the real x11 module silently does
 * nothing. Injection is what makes "it never closes the operator's window" a claim a machine can
 * check, instead of a claim you find out about the hard way.
 */
async function makePool(x, opts) {
    const { EditorPool } = await import("../../../apps/worker/src/util/editor.ts");
    const dir = mkdtempSync(join(tmpdir(), "pool-"));
    const pool = new EditorPool({
        max: opts.max,
        // The launcher stands in for `spawn("code", ...)`. The test decides what — if anything —
        // VS Code puts on screen in response.
        launch: () => {
            const id = opts.onSpawn();
            if (id !== null)
                x.ourIds.add(id);
        },
        x11: {
            available: () => true,
            list: async () => new Set(x.windows.keys()),
            isVsCode: async (id) => x.windows.get(id)?.isCode ?? false,
            title: async (id) => x.windows.get(id)?.title ?? "",
            pid: async (id) => (x.windows.has(id) ? x.vscodePid : null),
            close: async (id) => x.close(id),
        },
    });
    return { pool, dir };
}
// =============================================================================================
test("THE OPERATOR'S WINDOWS ARE NEVER ADOPTED — even when named exactly like a task slug", async () => {
    const x = new FakeX();
    // The real thing, from the real machine. Every one of these is a slug.
    x.operatorWindow("harden-go-mlflow-build-locks - Visual Studio Code");
    x.operatorWindow("alpha-op-precious-work - Visual Studio Code");
    x.operatorWindow("bravo-task-slug - Visual Studio Code");
    const before = x.operatorWindowsAlive();
    assert.equal(before, 3);
    // Now we open a task whose slug is IDENTICAL to one of theirs. This is the worst case: a title
    // match would land squarely on the operator's five-day-old window.
    const { pool, dir } = await makePool(x, {
        max: 6,
        onSpawn: () => x.spawnForUs("harden-go-mlflow-build-locks - Visual Studio Code"),
    });
    try {
        const ok = await pool.open("/ws/harden-go-mlflow-build-locks");
        assert.equal(ok, true, "we should have adopted OUR new window");
        // The adopted id must be the one that appeared AFTER the snapshot — not the operator's.
        const [w] = pool.list();
        assert.ok(w);
        assert.equal(x.windows.get(w.id).owner, "us", "adopted the operator's window!");
        // And closing ours must leave all three of theirs standing.
        await pool.release("/ws/harden-go-mlflow-build-locks", "done");
        assert.equal(x.operatorWindowsAlive(), 3, "AN OPERATOR WINDOW WAS CLOSED");
        assert.equal(x.closedAnOperatorWindow(), false);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("if VS Code opens NO window, nothing is adopted — we never fall back to a guess", async () => {
    // The dangerous shape: the spawn fails or is slow, and a lazy implementation reaches for "well,
    // find a VS Code window whose title looks right". That is how you close somebody's work.
    const x = new FakeX();
    x.operatorWindow("migrate-imagemagick-textile-features - Visual Studio Code");
    const { pool, dir } = await makePool(x, { max: 6, onSpawn: () => null }); // nothing appears
    try {
        const ok = await pool.open("/ws/migrate-imagemagick-textile-features");
        assert.equal(ok, false, "must report failure rather than adopt something");
        assert.equal(pool.size, 0, "the ledger must stay empty");
        assert.equal(x.operatorWindowsAlive(), 1);
        assert.equal(x.closed.length, 0, "nothing may be closed");
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("the cap holds: the pool never exceeds max, and evicts the LEAST-RECENTLY-USED", async () => {
    const x = new FakeX();
    let n = 0;
    const { pool, dir } = await makePool(x, { max: 3, onSpawn: () => x.spawnForUs(`task-${n++}`) });
    try {
        for (const ws of ["/ws/a", "/ws/b", "/ws/c"])
            await pool.open(ws);
        assert.equal(pool.size, 3);
        // Touch a and b so c is the coldest.
        pool.touch("/ws/a");
        pool.touch("/ws/b");
        await pool.open("/ws/d");
        assert.equal(pool.size, 3, "the cap is a cap");
        const open = pool.list().map((w) => w.workspace).sort();
        assert.deepEqual(open, ["/ws/a", "/ws/b", "/ws/d"], "c was the coldest and should have gone");
        assert.equal(x.closed.length, 1);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("max: 0 means never open a window at all", async () => {
    const x = new FakeX();
    const { pool, dir } = await makePool(x, { max: 0, onSpawn: () => x.spawnForUs("x") });
    try {
        assert.equal(await pool.open("/ws/a"), false);
        assert.equal(pool.size, 0);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("re-opening the same workspace reuses its window rather than spawning a second", async () => {
    const x = new FakeX();
    let spawns = 0;
    const { pool, dir } = await makePool(x, {
        max: 6,
        onSpawn: () => { spawns += 1; return x.spawnForUs("a"); },
    });
    try {
        await pool.open("/ws/a");
        await pool.open("/ws/a");
        await pool.open("/ws/a");
        assert.equal(pool.size, 1);
        // The pool short-circuits before spawning, so only the first call ever reaches VS Code.
        assert.ok(spawns <= 1, `spawned ${spawns} times for one workspace`);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
// =============================================================================================
// THE TWO ATTACKS AN ADVERSARIAL REVIEW FOUND. Both were live against the first version of this
// pool, and both end with the operator's window closed. They are the reason it no longer persists
// a ledger and no longer adopts "the first new window".
// =============================================================================================
test("ATTACK: the operator opens THEIR copy of the same task while we are spawning", async () => {
    // The collision is real and it is not a coincidence — it is the job:
    //
    //     workspace/automate-c-graphviz-worker-stained-glass-vault            (ours)
    //     ~/Documents/Working/automate-c-graphviz-worker-stained-glass-vault  (theirs)
    //
    // Watching the system build task X is EXACTLY when a human opens their own copy of X. If our
    // spawn is slow, or VS Code reuses an existing window and contributes nothing, then the only new
    // window in the diff is THEIRS — and "adopt the first new VS Code window" takes it.
    //
    // A diff proves NOVELTY. It never proves AUTHORSHIP. So: more than one candidate => take none.
    const x = new FakeX();
    x.operatorWindow("some-old-thing - Visual Studio Code");
    const { pool, dir } = await makePool(x, {
        max: 6,
        onSpawn: () => {
            // Ours appears...
            const ours = x.spawnForUs("automate-c-graphviz-worker-stained-glass-vault - Visual Studio Code");
            // ...and at the same moment the operator opens THEIR identically-named copy.
            x.operatorWindow("automate-c-graphviz-worker-stained-glass-vault - Visual Studio Code");
            return ours;
        },
    });
    try {
        const ok = await pool.open("/ws/automate-c-graphviz-worker-stained-glass-vault");
        // TWO new VS Code windows appeared and nothing in X can tell us which is ours — no window
        // property carries the folder path, and the titles are byte-identical. So we take NEITHER.
        assert.equal(ok, false, "ambiguity must mean we adopt nothing");
        assert.equal(pool.size, 0);
        assert.equal(x.closed.length, 0, "nothing may be closed");
        assert.equal(x.closedAnOperatorWindow(), false);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("ATTACK: VS Code restarts, X RECYCLES our window id onto the operator's window", async () => {
    // Measured on the real machine: six consecutive X clients were each allocated the identical id
    // 0x5600001. The server reissues a client's resource-id base the moment it disconnects. So an id
    // we wrote down before a VS Code restart is a NUMBER, not a window — and the window now wearing
    // it may be the operator's.
    //
    // Every VS Code window shares one main process, so its PID identifies the INSTANCE. If that PID
    // has changed, our id means nothing and we refuse to close it.
    const x = new FakeX();
    const { pool, dir } = await makePool(x, {
        max: 6,
        onSpawn: () => x.spawnForUs("my-task - Visual Studio Code"),
    });
    try {
        await pool.open("/ws/my-task");
        assert.equal(pool.size, 1);
        const [w] = pool.list();
        const stolenId = w.id;
        // ---- VS Code restarts. Every window dies; the operator reopens; X hands the SAME id to one
        // ---- of THEIR windows.
        x.windows.delete(stolenId);
        x.vscodePid = 9999; // a NEW main process
        x.windows.set(stolenId, {
            title: "harden-go-mlflow-build-locks - Visual Studio Code",
            isCode: true,
            owner: "operator",
        });
        // The pool still thinks it owns that id. It must NOT close it.
        await pool.release("/ws/my-task", "done");
        assert.equal(x.closed.length, 0, "THE OPERATOR'S WINDOW WAS CLOSED ON A RECYCLED ID");
        assert.equal(x.operatorWindowsAlive(), 1);
        assert.equal(x.windows.get(stolenId)?.owner, "operator", "their window must still be there");
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
