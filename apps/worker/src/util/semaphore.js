/**
 * A counting semaphore, because "how many tasks at once" is really two different questions.
 *
 * A Claude build turn is network-bound: it spends almost all of its time waiting on the API,
 * so eight of them can run on a four-core box quite happily. A Docker gate is not — it does
 * a real image build and two container runs, and config/pipeline.json hands each one 2 CPUs
 * and 4 GB. On a 4-core machine, two gates already saturate it; eight would thrash, and every
 * gate would time out together and be recorded as a task failure that never happened.
 *
 * So the worker runs up to `worker.maxParallelTasks` tasks, but the Claude turns and the
 * Docker gates each queue behind their own limit.
 */
export class Semaphore {
    available;
    waiting = [];
    max;
    // NOTE: a TypeScript parameter property (`constructor(private readonly max: number)`) is
    // NOT usable here. This repo runs .ts directly under Node's --experimental-strip-types,
    // which only ERASES types — it cannot synthesise the field assignment a parameter property
    // implies. tsc accepts it happily and the worker then dies at import time with
    // ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX. Assign the field explicitly.
    constructor(max) {
        this.max = max;
        this.available = max;
    }
    /** Number of holders currently inside. */
    get inUse() {
        return this.max - this.available;
    }
    /** Number of callers queued behind the limit. */
    get queued() {
        return this.waiting.length;
    }
    /** True if the next run() would have to wait. */
    get wouldBlock() {
        return this.available === 0;
    }
    async acquire() {
        if (this.available > 0) {
            this.available -= 1;
            return;
        }
        await new Promise((resolve) => this.waiting.push(resolve));
    }
    release() {
        const next = this.waiting.shift();
        if (next) {
            // Hand the slot straight to the next waiter rather than incrementing and racing.
            next();
            return;
        }
        this.available += 1;
    }
    /**
     * Run `fn` holding one slot. The slot is always given back — a gate that throws must not
     * leak its permit, or the worker quietly strangles itself one failure at a time.
     */
    async run(fn) {
        await this.acquire();
        try {
            return await fn();
        }
        finally {
            this.release();
        }
    }
}
