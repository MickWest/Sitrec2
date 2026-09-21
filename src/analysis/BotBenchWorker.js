import {Globals} from "../Globals";
import {cacheableBotBenchBattery, fitBotBenchRecord} from "./BotBenchFit";
import {transferableBuffers} from "./BotBenchWorkerPool";
import {unitsFromTexts} from "./BotBenchUnitTexts";

// Each worker runs one case at a time. Keep CAS buffers local to that worker;
// transferring a completed result must never detach or expose these arrays.
const sweepWorkspaces = {};

self.onmessage = async ({data: {id, record, options, earthRadii}}) => {
    try {
        Object.assign(Globals, earthRadii);
        let lastProgress = -Infinity;
        const start = Date.now();
        // Stored fit units arrive as blob text and are decoded here, off the
        // main thread; a schema-2 battery blob is split into units the same way.
        const {units: unitTexts, ...fitOptions} = options;
        const {cached, migrated, legacyHeld} = unitsFromTexts(unitTexts);
        const fitted = await fitBotBenchRecord(record, {
            ...fitOptions,
            sweepWorkspaces,
            units: {cached},
            onProgress: (fraction, label) => {
                const now = performance.now();
                if (now - lastProgress < 100 && fraction < 1) return;
                lastProgress = now;
                self.postMessage({id, progress: {fraction, label}});
            },
        });
        const battery = cacheableBotBenchBattery(fitted);
        const out = {id, battery, elapsedMs: Date.now() - start, units: fitted.units ?? {}, migrated, legacyHeld};
        self.postMessage(out, transferableBuffers(out));
    } catch (error) {
        self.postMessage({id, error: error?.message ?? String(error)});
    }
};
self.postMessage({ready: true});
