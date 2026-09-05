import {Globals} from "../Globals";
import {runBotBenchAnalysis} from "./BotBenchRunner";
import {BotBenchWorkerPool} from "./BotBenchWorkerPool";

/** One analysis implementation, with worker fitting and main-thread reporting. */
export class BotBenchAnalysisPool {
    constructor(size) {
        this.workers = typeof Worker === "undefined" ? null : new BotBenchWorkerPool({size,
            createWorker: () => new Worker(new URL("./BotBenchWorker.js", import.meta.url)),
        });
        this.fallback = Promise.resolve();
        this.cancelled = false;
    }

    async run(record, {onProgress, isCancelled = () => false, yieldToDOM = async () => {}, ...options} = {}) {
        const cancelled = () => this.cancelled || isCancelled();
        if (cancelled()) throw new Error("cancelled");
        if (this.workers && !this.workers.closed) {
            try {
                // Only observations and declared constraints enter the worker.
                // Truth, labels, file handles and UI state stay with the caller.
                const fitted = await this.workers.run({dataset: record.dataset,
                    originLat: record.originLat, originLon: record.originLon,
                    groundZ: record.groundZ, kind: record.kind,
                    clipStartMs: record.clipStartMs, meta: {maxRangeM: record.meta?.maxRangeM}},
                options, {equatorRadius: Globals.equatorRadius, polarRadius: Globals.polarRadius}, onProgress);
                if (cancelled()) throw new Error("cancelled");
                return runBotBenchAnalysis(record, {...options, battery: fitted.battery,
                    fitElapsedMs: fitted.elapsedMs, isCancelled: cancelled});
            } catch (error) {
                if (cancelled() || !this.workers.closed) throw error;
                // A host may block workers. Recover through the same fit code,
                // serializing fallback fits so the UI keeps yielding normally.
                console.warn("BotBench workers unavailable; continuing on the main thread", error);
            }
        }
        const task = this.fallback.catch(() => {}).then(() => {
            if (cancelled()) throw new Error("cancelled");
            return runBotBenchAnalysis(record, {...options, isCancelled: cancelled,
                onProgress: async (fraction, label) => {
                    onProgress?.(fraction, label);
                    await yieldToDOM();
                }});
        });
        this.fallback = task;
        return task;
    }

    dispose() {
        this.cancelled = true;
        this.workers?.dispose();
    }
}
