// rockV3Worker.js — worker_threads entry for the parallel rock_v3 driver.
//
// This file is the esbuild bundle root (run-rock-v3.mjs bundles it to a single
// CJS file at run time, stubbing the lazy target modules the set never uses)
// and is never imported by the app or by Jest. One worker generates one batch
// folder through lib/rockV3Batch.js, so the output is byte-identical to a
// sequential run.
//
// The driver also requires the bundle on the main thread (where parentPort is
// null) to read the axes and the track table, so the task list and the master
// manifest can never drift from lib/rockV3.js.

import {parentPort, workerData} from "node:worker_threads";
import {setSit} from "../../../src/Globals";
import {generateRockV3Batch} from "./rockV3Batch";
import {ROCK_V3, ROCK_V3_ERROR_LEVELS, rockTrackTable, rockDefinitionHash} from "./rockV3";
import {GENERATOR_VERSION} from "./generateScenario";

export const AXES = {
    dirName: ROCK_V3.dirName,
    durations: ROCK_V3.durations,
    errorLabels: ROCK_V3_ERROR_LEVELS.map((e) => e.label),
};

export const DATASET = {
    name: ROCK_V3.name,
    seed: ROCK_V3.seed,
    generatorVersion: GENERATOR_VERSION,
    fps: ROCK_V3.fps,
    fovFullDeg: ROCK_V3.fovFullDeg,
    epochISO: ROCK_V3.epochISO,
    perClass: ROCK_V3.perClass,
    classes: ROCK_V3.classes.map((c) => c.key),
    platform: ROCK_V3.platform,
    rangeM: ROCK_V3.rangeM,
};

export {rockTrackTable, rockDefinitionHash};

if (parentPort) {
    try {
        // The balloon integrator falls back to Sit.lat/lon in places; the Jest
        // benches set the same values, so a worker and a bench agree byte for
        // byte.
        setSit({name: "rock-v3", frames: 10000, fps: workerData.fps ?? ROCK_V3.fps, simSpeed: 1, lat: 40, lon: -105});
        const result = generateRockV3Batch(workerData);
        parentPort.postMessage({ok: true, result});
    } catch (e) {
        parentPort.postMessage({ok: false, error: String(e && e.stack || e)});
    }
}
