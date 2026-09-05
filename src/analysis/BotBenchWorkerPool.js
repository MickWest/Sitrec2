/** Bounded worker scheduling. No scene or UI imports; also usable by benchmarks. */
export function botBenchConcurrency(count, cores = globalThis.navigator?.hardwareConcurrency ?? 2) {
    return Math.max(1, Math.min(count, 16, Number.isFinite(cores) ? Math.max(1, Math.floor(cores) - 1) : 1));
}

/** Each buffer appears once, even when hypotheses share tracks/metrics. */
export function transferableBuffers(value) {
    const buffers = new Set(), seen = new Set();
    const visit = (v) => {
        if (!v || typeof v !== "object" || seen.has(v)) return;
        seen.add(v);
        if (ArrayBuffer.isView(v)) buffers.add(v.buffer);
        else if (v instanceof ArrayBuffer) buffers.add(v);
        else if (v instanceof Map) {
            for (const [key, item] of v) { visit(key); visit(item); }
        } else for (const item of Object.values(v)) visit(item);
    };
    visit(value);
    return [...buffers];
}

export class BotBenchWorkerPool {
    constructor({size, createWorker}) {
        this.size = Number.isFinite(size) ? Math.max(1, Math.floor(size)) : 1;
        this.createWorker = createWorker;
        this.slots = [];
        this.queue = [];
        this.nextId = 0;
        this.closed = false;
    }

    run(record, options, earthRadii, onProgress) {
        if (this.closed) return Promise.reject(new Error("cancelled"));
        return new Promise((resolve, reject) => {
            this.queue.push({id: this.nextId++, record, options, earthRadii, onProgress, resolve, reject});
            this.dispatch();
        });
    }

    dispatch() {
        if (this.closed) return;
        while (this.queue.length) {
            let slot = this.slots.find(s => !s.job);
            if (!slot) {
                if (this.slots.length >= this.size) return;
                try {
                    const worker = this.createWorker();
                    slot = {worker, job: null, ready: false};
                    this.slots.push(slot);
                    const current = slot;
                    worker.onmessage = ({data}) => {
                        if (data.ready) {
                            current.ready = true;
                            clearTimeout(current.startTimer);
                            this.send(current);
                            return;
                        }
                        const job = current.job;
                        if (!job || data.id !== job.id) return;
                        if (data.progress) {
                            job.onProgress?.(data.progress.fraction, data.progress.label);
                            return;
                        }
                        current.job = null;
                        if (data.error) job.reject(new Error(data.error));
                        else job.resolve({battery: data.battery, elapsedMs: data.elapsedMs});
                        this.dispatch();
                    };
                    worker.onerror = (event) => this.fail(new Error(event.message || "BOTBench worker failed"));
                    worker.onmessageerror = () => this.fail(new Error("BOTBench worker message could not be read"));
                    current.startTimer = setTimeout(() => this.fail(new Error("BOTBench worker did not start")), 30000);
                } catch (error) {
                    this.fail(error);
                    return;
                }
            }
            slot.job = this.queue.shift();
            if (slot.ready) this.send(slot);
        }
    }

    send(slot) {
        const job = slot.job;
        if (!job) return;
        // Keep the original input on the caller so replay, fallback and exports
        // all retain their arrays. Only fitted output buffers are transferred.
        const {id, record, options, earthRadii} = job;
        try { slot.worker.postMessage({id, record, options, earthRadii}); }
        catch (error) { this.fail(error); }
    }

    fail(error) {
        this.closed = true;
        for (const slot of this.slots) {
            clearTimeout(slot.startTimer);
            slot.worker.terminate();
            slot.job?.reject(error);
            slot.job = null;
        }
        for (const job of this.queue.splice(0)) job.reject(error);
    }

    dispose() { this.fail(new Error("cancelled")); }
}

/** Claim in input order; bound both fitting and the surrounding file I/O. */
export async function runBotBenchQueue(entries, concurrency, run, isCancelled = () => false) {
    let next = 0, failure;
    await Promise.all(Array.from({length: Math.min(entries.length, concurrency)}, async () => {
        while (!failure && !isCancelled() && next < entries.length) {
            const index = next++;
            try { await run(entries[index], index); }
            catch (error) { failure ??= error; }
        }
    }));
    if (failure) throw failure;
}
