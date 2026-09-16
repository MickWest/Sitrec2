import {Globals} from "../Globals";
import {runBotBenchAnalysis} from "./BotBenchRunner";
import {BotBenchWorkerPool} from "./BotBenchWorkerPool";
import {unitsFromTexts} from "./BotBenchUnitTexts";

/** One analysis implementation, with worker fitting and main-thread reporting. */
export class BotBenchAnalysisPool {
    constructor(size) {
        this.workers = typeof Worker === "undefined" ? null : new BotBenchWorkerPool({size,
            createWorker: () => new Worker(new URL("./BotBenchWorker.js", import.meta.url)),
        });
        this.fallback = Promise.resolve();
        this.cancelled = false;
    }

    /**
     * Fit and analyse one record. `options.units`, when given, is the stored-unit
     * text bundle BotBenchUnitTexts describes; the result carries `units` (what was
     * fitted) and `migrated` (what came out of a schema-2 blob) for the caller to store.
     */
    async run(record, {onProgress, isCancelled = () => false, yieldToDOM = async () => {}, ...options} = {}) {
        const cancelled = () => this.cancelled || isCancelled();
        if (cancelled()) throw new Error("cancelled");
        if (this.workers && !this.workers.closed) {
            try {
                // Only observations and declared constraints enter the worker.
                // Truth, labels, file handles and UI state stay with the caller.
                const fitted = await this.workers.run({dataset: record.dataset,
                    losSamples: record.losSamples,
                    originLat: record.originLat, originLon: record.originLon,
                    groundZ: record.groundZ, kind: record.kind,
                    clipStartMs: record.clipStartMs, meta: {maxRangeM: record.meta?.maxRangeM}},
                options, {equatorRadius: Globals.equatorRadius, polarRadius: Globals.polarRadius}, onProgress);
                if (cancelled()) throw new Error("cancelled");
                const {units: unitTexts, ...analysisOptions} = options;
                const out = await runBotBenchAnalysis(record, {...analysisOptions, battery: fitted.battery,
                    fitElapsedMs: fitted.elapsedMs, isCancelled: cancelled});
                if (out && typeof out === "object") {
                    out.units = fitted.units ?? {};
                    out.migrated = fitted.migrated ?? {};
                    out.legacyHeld = fitted.legacyHeld ?? [];
                }
                return out;
            } catch (error) {
                if (cancelled() || !this.workers.closed) throw error;
                // A host may block workers. Recover through the same fit code,
                // serializing fallback fits so the UI keeps yielding normally.
                console.warn("BotBench workers unavailable; continuing on the main thread", error);
            }
        }
        const task = this.fallback.catch(() => {}).then(async () => {
            if (cancelled()) throw new Error("cancelled");
            const {units: unitTexts, ...analysisOptions} = options;
            const {cached, migrated, legacyHeld} = unitsFromTexts(unitTexts);
            const out = await runBotBenchAnalysis(record, {...analysisOptions,
                units: unitTexts ? {cached} : null,
                isCancelled: cancelled,
                onProgress: async (fraction, label) => {
                    onProgress?.(fraction, label);
                    await yieldToDOM();
                }});
            if (out && typeof out === "object") {
                out.migrated = migrated;
                out.legacyHeld = legacyHeld;
            }
            return out;
        });
        this.fallback = task;
        return task;
    }

    dispose() {
        this.cancelled = true;
        this.workers?.dispose();
    }
}
