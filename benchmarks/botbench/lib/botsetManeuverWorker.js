// botsetManeuverWorker.js — worker_threads entry for the parallel maneuver
// botset driver.
//
// This file is the esbuild bundle root (run-botset-maneuvers.mjs bundles it to
// a single CJS file at run time, stubbing the lazy non-maneuver target modules)
// — it is never imported by the app or by Jest. One worker generates one batch
// folder via the same lib/botsetManeuverBatch.js the sequential bench uses, so
// the output is byte-identical to a sequential run.
//
// The driver ALSO requires the built bundle on the main thread (where
// parentPort is null) to read the sweep axes, so the task list can never drift
// from lib/botsetManeuvers.js.

import {parentPort, workerData} from "node:worker_threads";
import {generateBotsetManeuverBatch} from "./botsetManeuverBatch";
import {
    BOTSET_MANEUVER_SETS, BOTSET_MANEUVER_DURATIONS_SECONDS,
    BOTSET_MANEUVER_ERROR_LEVELS,
} from "./botsetManeuvers";

export const AXES = {
    sets: BOTSET_MANEUVER_SETS.map((s) => ({key: s.key, dirName: s.dirName})),
    durations: BOTSET_MANEUVER_DURATIONS_SECONDS,
    errorLabels: BOTSET_MANEUVER_ERROR_LEVELS.map((e) => e.label),
};

if (parentPort) {
    try {
        const result = generateBotsetManeuverBatch(workerData);
        parentPort.postMessage({ok: true, result});
    } catch (e) {
        parentPort.postMessage({ok: false, error: String(e && e.stack || e)});
    }
}
