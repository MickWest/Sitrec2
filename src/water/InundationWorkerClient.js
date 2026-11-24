// One worker owns the numeric tile cache. A pool would duplicate that cache
// and change the deterministic order used to resolve overlapping tile levels.
export class InundationCancelled extends Error {
    constructor() { super("Inundation calculation cancelled"); this.name = "AbortError"; }
}

export class InundationWorkerClient {
    constructor(worker) {
        this.worker = worker;
        this.nextId = 0;
        this.pending = null;
        worker.onmessage = ({data}) => {
            const pending = this.pending;
            if (!pending || pending.id !== data.id) return;
            if (data.progress) { pending.onProgress?.(data.progress); return; }
            if (data.error) {
                this.pending = null;
                pending.reject(new Error(data.error));
            } else {
                try {
                    // A result can finish in the worker just before Lock or a
                    // new request cancels its reply. Commit cache edits only
                    // when this client actually accepts that geometry result.
                    if (pending.type === "geometry") this.worker.postMessage({type: "accept", id: pending.id});
                    this.pending = null;
                    pending.resolve(data.result);
                } catch (error) { this.fail(error); }
            }
        };
        worker.onerror = event => this.fail(new Error(event.message || "Inundation worker failed"));
        worker.onmessageerror = () => this.fail(new Error("Inundation worker returned unreadable data"));
    }

    request(type, payload, transfer = [], onProgress) {
        this.cancel();
        if (this.error) return Promise.reject(this.error);
        return new Promise((resolve, reject) => {
            const id = ++this.nextId;
            this.pending = {id, type, resolve, reject, onProgress};
            try { this.worker.postMessage({id, type, payload}, transfer); }
            catch (error) { this.fail(error); }
        });
    }

    cancel() {
        if (!this.pending) return;
        const {id, reject} = this.pending;
        this.pending = null;
        reject(new InundationCancelled());
        try { this.worker.postMessage({type: "cancel", id}); }
        catch (error) { this.fail(error); }
    }

    clearGeometry() {
        this.cancel();
        if (this.error) return;
        try { this.worker.postMessage({type: "clearGeometry"}); }
        catch (error) { this.fail(error); }
    }

    fail(error) {
        this.error = error;
        this.pending?.reject(error);
        this.pending = null;
        this.worker.terminate();
    }

    dispose() { this.cancel(); this.worker.terminate(); this.error = new InundationCancelled(); }
}

export function createInundationWorker() {
    if (typeof Worker === "undefined") return null;
    try {
        return new InundationWorkerClient(new Worker(new URL("./InundationWorker.js", import.meta.url), {type: "module"}));
    } catch (_) {
        // Restricted environments can use the same raster math with UI yields.
        return null;
    }
}
