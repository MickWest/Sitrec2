// GPU worker for Video > Forensics > Noise Pattern Detection: holds the strip profiles on
// the GPU and runs the blind strip assignment there (see NoisePatternGpu.js). Every
// failure is reported to the page, which then uses the CPU workers instead.

import {createGpuSearch} from "../videoNoisePattern/NoisePatternGpu";

let gpu = null;
let starting = null;

const post = (data, transfer = []) => self.postMessage(data, transfer);

self.onmessage = async ({data}) => {
    const {id} = data;
    try {
        if (data.type === "gpuInit") {
            starting = starting ?? createGpuSearch();
            gpu = await starting;
            post({type: "gpuReady", id, info: gpu.info});
        } else if (data.type === "upload") {
            if (!gpu) throw new Error("The GPU is not started");
            await gpu.upload(data.plane, data.columns, data.rows, data.offsetRow, data.strips, data.energies);
            post({type: "uploaded", id});
        } else if (data.type === "search") {
            if (!gpu) throw new Error("The GPU is not started");
            const started = performance.now();
            const results = await gpu.search(data.plane, data.pairs, data.colWidth);
            post({type: "searchResult", id, results, ms: performance.now() - started}, [results.buffer]);
        } else if (data.type === "release") {
            gpu?.release();
            post({type: "released", id});
        } else {
            throw new Error(`Unknown message ${data.type}`);
        }
    } catch (error) {
        starting = error?.name === "GpuSearchError" && !gpu ? null : starting;
        post({type: "error", id, message: error?.message ?? String(error)});
    }
};
