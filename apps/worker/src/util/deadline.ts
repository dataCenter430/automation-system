/**
 * A promise that cannot outlive its deadline.
 *
 * WHY THIS IS ITS OWN FILE. On 2026-07-13 the VM's NIC dropped and re-leased mid-poll. The
 * worker's tick loop was awaiting a Supabase fetch; the socket went away underneath it and
 * THE PROMISE NEVER SETTLED — it did not resolve, and, crucially, it did not reject either.
 *
 * That distinction is the whole point. A fetch that REJECTS on a dead socket is the happy
 * path: it throws, something catches it, the loop takes the next tick. There is no defence
 * against a promise that just... stops, other than to stop waiting on it. try/catch cannot
 * help you — there is nothing to catch. A retry cannot help you — you never got control back
 * to retry from. Only a deadline can.
 *
 * The consequence, in full: the poll loop wedged, so the heartbeat froze; the in-flight
 * Claude session held its own handles and kept logging for another twelve minutes; and when
 * it finished, the process had no live handles and no runnable work, so node's event loop
 * drained and the worker exited with code 0 and not one line of output. It stayed dead for
 * an hour and forty minutes.
 */

/** Thrown when the deadline wins. Distinct from any error the wrapped promise might throw. */
export class Timeout extends Error {
  constructor(what: string, ms: number) {
    super(`${what} did not answer within ${ms / 1000}s`);
    this.name = "Timeout";
  }
}

/**
 * Resolve with `p`, or reject with `Timeout` after `ms` — whichever happens first.
 *
 * The timer is always cleared, on both paths. A leaked timer would hold the event loop open
 * past a clean shutdown, which is a milder version of the same class of bug: a process whose
 * liveness no longer reflects whether it has anything to do.
 *
 * Note this does not CANCEL the underlying work — a fetch left in orbit stays in orbit until
 * its socket finally gives up. It cannot: there is no portable way to cancel an arbitrary
 * promise. What it guarantees is that the CALLER gets control back, which is the only thing
 * the poll loop actually needs in order to survive.
 */
export function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((ok, fail) => {
    const timer = setTimeout(() => fail(new Timeout(what, ms)), ms);
    p.then(
      (v) => { clearTimeout(timer); ok(v); },
      (e) => { clearTimeout(timer); fail(e); },
    );
  });
}
