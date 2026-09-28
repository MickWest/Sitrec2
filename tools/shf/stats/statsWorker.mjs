// statsWorker.mjs — worker thread for flare-stats.mjs. Receives one job at a time
// ({ date, lat, lon, altKm, minElevationDeg }) and posts back the night's counts.

import { parentPort, workerData } from "node:worker_threads";
import { createNightScanner } from "./statsCore.mjs";

const scanner = createNightScanner({ tleText: workerData.tleText });

parentPort.on("message", (job) => {
    try {
        parentPort.postMessage({ ok: true, result: scanner.scanNight(job) });
    } catch (err) {
        parentPort.postMessage({ ok: false, job, error: String(err && err.stack || err) });
    }
});
