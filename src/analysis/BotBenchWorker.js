import {Globals} from "../Globals";
import {cacheableBotBenchBattery, fitBotBenchRecord} from "./BotBenchFit";
import {transferableBuffers} from "./BotBenchWorkerPool";

self.onmessage = async ({data: {id, record, options, earthRadii}}) => {
    try {
        Object.assign(Globals, earthRadii);
        let lastProgress = -Infinity;
        const start = Date.now();
        const fitted = await fitBotBenchRecord(record, {
            ...options,
            onProgress: (fraction, label) => {
                const now = performance.now();
                if (now - lastProgress < 100 && fraction < 1) return;
                lastProgress = now;
                self.postMessage({id, progress: {fraction, label}});
            },
        });
        const battery = cacheableBotBenchBattery(fitted);
        self.postMessage({id, battery, elapsedMs: Date.now() - start}, transferableBuffers(battery));
    } catch (error) {
        self.postMessage({id, error: error?.message ?? String(error)});
    }
};
self.postMessage({ready: true});
