// VideoQPAnalysis - gets the quantization parameter (QP) statistics of every
// frame of the loaded video.
//
// The encoded bytes of each frame are already in memory (videoData.chunks). This
// module sends them to H264QPWorker, which parses the H.264 bitstream and returns
// the mean, minimum and maximum macroblock QP of each picture. Nothing is decoded
// to pixels, so a full video takes seconds.
//
// This module is loaded on first use only (see VideoQPGraph.js).

const BATCH_BYTES = 4 * 1024 * 1024;
const BATCH_CHUNKS = 256;

// source video data object -> {promise, result}
const analyses = new WeakMap();

// A patched video (CVideoPatchedData) is a wrapper. The chunks are on its source.
export function sourceVideoOf(videoData) {
    let video = videoData;
    while (video?.source && typeof video.virtualToSource === "function") video = video.source;
    return video;
}

// Sitch frame -> index of the picture in display order in the source video
export function displayIndexForFrame(videoData, frame) {
    let video = videoData;
    let f = Math.floor(frame);
    while (video?.source && typeof video.virtualToSource === "function") {
        f = video.virtualToSource(f);
        video = video.source;
    }
    return Math.floor(f / (video?.videoSpeed || 1));
}

// Returns null when the video can be analyzed, or a short reason when it cannot.
export function whyNotAnalyzable(videoData) {
    const source = sourceVideoOf(videoData);
    if (!source) return "noVideo";
    if (!source.chunks || source.chunks.length === 0) return "noEncodedVideo";
    const codec = source.config?.codec ?? "";
    if (!/^avc[13]/i.test(codec)) return "notH264";
    return null;
}

export function getVideoQPResult(videoData) {
    return analyses.get(sourceVideoOf(videoData))?.result ?? null;
}

// Starts the analysis, or returns the analysis that is in progress or complete.
// onUpdate() is called each time more frames are available.
// The result object is filled in place:
//   frames, done (count of analyzed frames), complete, error ({unsupported, message})
//   mean, min, max, sliceQP   Float32Array by DISPLAY index, NaN = no data
//   pictureType               array of "I" / "P" / "B" by display index
//   mbWidth, mbHeight
export function analyzeVideoQP(videoData, onUpdate) {
    const source = sourceVideoOf(videoData);
    const existing = analyses.get(source);
    if (existing) {
        existing.listeners.add(onUpdate);
        return existing.promise;
    }

    const frames = source.chunks.length;
    const result = {
        frames, done: 0, complete: false, error: null,
        mean: new Float32Array(frames).fill(NaN),
        min: new Float32Array(frames).fill(NaN),
        max: new Float32Array(frames).fill(NaN),
        sliceQP: new Float32Array(frames).fill(NaN),
        pictureType: new Array(frames).fill(""),
        mbWidth: 0, mbHeight: 0,
        version: 0,
    };
    const entry = {result, listeners: new Set([onUpdate]), promise: null};
    const notify = () => {
        result.version++;
        for (const listener of entry.listeners) listener?.(result);
    };

    const started = performance.now();
    entry.promise = runAnalysis(source, result, notify).catch((e) => {
        result.error = {unsupported: !!e.unsupported, message: e.message};
    }).then(() => {
        result.complete = true;
        result.elapsedMs = performance.now() - started;
        console.log(`[VideoQP] ${result.done} of ${result.frames} frames in ${(result.elapsedMs / 1000).toFixed(1)} s`
            + (result.error ? ` (${result.error.message})` : ""));
        notify();
        return result;
    });
    analyses.set(source, entry);
    return entry.promise;
}

async function runAnalysis(source, result, notify) {
    const worker = new Worker(new URL("../workers/H264QPWorker.js", import.meta.url));
    try {
        let waiting = null;
        worker.onmessage = (event) => waiting?.resolve(event.data);
        worker.onerror = (event) => waiting?.reject(new Error(event.message || "QP worker failed"));
        const request = (message, transfer) => new Promise((resolve, reject) => {
            waiting = {resolve, reject};
            worker.postMessage(message, transfer);
        });

        const description = source.config?.description;
        let avcC = null;
        if (description) {
            const bytes = description instanceof ArrayBuffer
                ? new Uint8Array(description)
                : new Uint8Array(description.buffer, description.byteOffset, description.byteLength);
            avcC = bytes.slice().buffer;
        }
        worker.postMessage({type: "init", avcC}, avcC ? [avcC] : []);

        const chunks = source.chunks;
        let next = 0;
        while (next < result.frames) {
            // The video was disposed or replaced during the analysis.
            if (source.chunks !== chunks || chunks.length < result.frames) {
                throw new Error("video changed during the analysis");
            }
            const items = [];
            const transfer = [];
            let bytes = 0;
            while (next < result.frames && items.length < BATCH_CHUNKS && bytes < BATCH_BYTES) {
                const chunk = chunks[next];
                const data = new ArrayBuffer(chunk.byteLength);
                chunk.copyTo(data);
                items.push({index: next, data});
                transfer.push(data);
                bytes += chunk.byteLength;
                next++;
            }
            const reply = await request({type: "chunks", items}, transfer);
            if (reply.type === "error") {
                const error = new Error(reply.message);
                error.unsupported = reply.unsupported;
                throw error;
            }
            if (reply.mbWidth) {
                result.mbWidth = reply.mbWidth;
                result.mbHeight = reply.mbHeight;
            }
            for (const item of reply.items) {
                if (item.empty) continue;
                // chunks are in decode order: the timestamp map gives the display order
                const timestamp = chunks[item.index].timestamp;
                const display = source.timestampToChunkIndex?.get(timestamp) ?? item.index;
                result.mean[display] = item.mean;
                result.min[display] = item.min;
                result.max[display] = item.max;
                result.sliceQP[display] = item.sliceQP;
                result.pictureType[display] = item.pictureType;
            }
            result.done = next;
            notify();
        }
    } finally {
        worker.onmessage = null;
        worker.onerror = null;
        worker.terminate();
    }
}
