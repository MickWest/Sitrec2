// CloudNoiseWorker.js - generates the volumetric-cloud noise off the main thread.
//
// Message in:  {job: "shape", size, z0, z1, seed} | {job: "detail", size, seed} | {job: "weather", size, seed}
// Message out: {job, z0, z1, bytes} with bytes transferred (no copy), or {error}.
// The generators are the same module the main thread and Jest use (CloudNoise.js),
// so a worker and a fallback main-thread run produce identical bytes.

import {generateDetail, generateShapeSlices, generateWeather, shapeContext} from "../clouds/CloudNoise";

let context = null;
let contextSeed = null;

self.onmessage = (event) => {
    const message = event.data;
    try {
        let bytes;
        if (message.job === "shape") {
            if (!context || contextSeed !== message.seed) {
                context = shapeContext(message.seed);
                contextSeed = message.seed;
            }
            bytes = generateShapeSlices(message.size, message.z0, message.z1, message.seed, context);
        } else if (message.job === "detail") {
            bytes = generateDetail(message.size, message.seed);
        } else if (message.job === "weather") {
            bytes = generateWeather(message.size, message.seed);
        } else {
            throw new Error("Unknown cloud noise job " + message.job);
        }
        self.postMessage({job: message.job, z0: message.z0, z1: message.z1, bytes}, [bytes.buffer]);
    } catch (error) {
        self.postMessage({job: message.job, error: String(error?.message ?? error)});
    }
};
