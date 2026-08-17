// m1WorkerEntry.js — worker_threads entry for the parallel M1 driver.
//
// This file is the esbuild bundle root (run-m1-parallel.mjs bundles it to a
// single CJS file at run time, stubbing the lazy non-maneuver target modules)
// — it is never imported by the app or by Jest. One worker generates one
// batch folder via the same lib/m1Batch.js the sequential bench uses, so the
// output is byte-identical to a sequential run.
//
// The driver ALSO requires the built bundle on the main thread (where
// parentPort is null) to read the sweep axes, so the task list can never
// drift from lib/m1Set.js.

import {parentPort, workerData} from "node:worker_threads";
import {generateM1Batch} from "./m1Batch";
import {M1_DURATIONS_SECONDS, M1_ERROR_LEVELS} from "./m1Set";

export const AXES = {
    durations: M1_DURATIONS_SECONDS,
    errorLabels: M1_ERROR_LEVELS.map((e) => e.label),
};

if (parentPort) {
    try {
        const result = generateM1Batch(workerData);
        parentPort.postMessage({ok: true, result});
    } catch (e) {
        parentPort.postMessage({ok: false, error: String(e && e.stack || e)});
    }
}
