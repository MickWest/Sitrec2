// NoisePatternJob - the coordinator of Video > Forensics > Noise Pattern Detection.
//
// It runs on the page thread but does no heavy work there. It splits the work into
// messages for a pool of workers (decoding and per-frame features, preparation, the blind
// strip search) and a GPU worker (the search, when that is faster), and assembles the
// results. Each message handler copies a few MB at most, so the page stays responsive.
//
// Stages (see NoisePatternMath for the formulas):
//   spawn     start the workers
//   ingest    decode every frame once, in parallel segments of whole key-frame groups, and
//             keep compact features: strip profiles of Y, Cb and Cr, aligned signatures,
//             a 32x18 thumbnail
//   held      find held (repeated) pictures
//   prep      temporal high-pass of the features
//   coarse    lag scan: 24 reference frames x lags 1..Longest lag, five curves
//   precise   every frame against the frame one period later, with controls
//   longRange how far the repeat reaches (k x period, k up to 64)
//   refine    re-decode the best pairs, dense offset maps, strip lattice, re-ordering rule
//
// Loaded on first use only (see VideoNoisePattern.js).

import {
    ALIGNED_CURVES, BAND_STRIDE, CURVES, LAG_MIN, LIVE_FRACTION, SIG_COUNT, STRIP_CURVES, STRONG_Z, SIGNIFICANT_Z,
    TEMPORAL_HALF, THUMB_SIZE, HELD_NCC, assignmentMap, bitReversedOrder, lagPair, matchedRuns, medianOf,
    avcChunkHasIdr, avcNalLengthSize, offsetSegments, pairRuleFit, planFrameDecodes, planSegments, referenceIndices, thumbNCC,
} from "./NoisePatternMath";
import {sourceVideoOf} from "../videoQP/VideoQPAnalysis";
import {offsetPairs, planOffsetFrames} from "./NoiseOffsetMath";

export const NOISE_PATTERN_STAGES = ["spawn", "ingest", "held", "prep", "coarse", "precise", "longRange", "refine", "offsetDecode", "offsetSearch", "offsetVerify"];
const DECODE_CONCURRENCY = 8;
const IDLE_TERMINATE_MS = 60000;
const MESSAGE_BYTES = 8 * 1024 * 1024;
export const NOISE_PATTERN_CACHE_LIMIT = 384 * 1024 * 1024;
const CALIBRATION_PAIRS = 512;
const MAX_REFINE_PAIRS = 12;
const MAX_FINE_FRAMES = 64;
const NOTIFY_MS = 150;

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const visibility = () => (typeof document !== "undefined" ? document.visibilityState : "n/a");
const pause = () => new Promise(resolve => setTimeout(resolve, 0));

export function normalizeNoisePatternOptions(options = {}) {
    const lag = Math.round(Number(options.longestLag));
    return {
        longestLag: Number.isFinite(lag) ? Math.max(32, Math.min(2000, lag)) : 256,
        detail: Number(options.detail) === 4 ? 4 : 8,
        vertical: [0, 1, 3].includes(Number(options.vertical)) ? Number(options.vertical) : 0,
        held: options.held === "picture" ? "picture" : "leave",
        frames: options.frames === "ab" ? "ab" : "all",
        searchOn: ["fastest", "gpu", "cpu"].includes(options.searchOn) ? options.searchOn : "fastest",
        offsetSearch: options.offsetSearch !== false,
        range: options.range ?? null,
        references: Math.max(4, Math.min(64, Math.round(options.references ?? 24))),
    };
}

// Bytes kept per frame by the feature cache, for the memory check before a run.
export function estimateFeatureBytes(width, frames, detail = 8) {
    const colWidth = 8 * Math.max(1, Math.ceil(width / 1920)) / (detail === 4 ? 2 : 1);
    const columns = Math.floor(width / colWidth);
    const prepped = 3 * columns * BAND_STRIDE + 3 * columns * 4 + 2 * SIG_COUNT + 8 + THUMB_SIZE * 4 + 16;
    return frames * prepped;
}

// ---------------------------------------------------------------------------------------
// Lanes: one request at a time to a worker (or to an in-thread core in the tests)

export function workerLaneCount() {
    const cores = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4;
    return Math.max(2, Math.min(12, cores - 2));
}

export function createLane(kind, port) {
    const pending = new Map();
    let nextId = 1;
    let dead = false;
    const failAll = (message) => {
        for (const entry of pending.values()) entry.reject(new Error(message));
        pending.clear();
    };
    port.onMessage((data) => {
        const entry = pending.get(data?.id);
        if (!entry) return;
        if (data.type === "error") {
            pending.delete(data.id);
            const error = new Error(data.message);
            error.lane = kind;
            entry.reject(error);
            return;
        }
        if (data.partial) {
            try { entry.onPartial?.(data); } catch (error) { pending.delete(data.id); entry.reject(error); }
            return;
        }
        pending.delete(data.id);
        entry.resolve(data);
    });
    port.onError((message) => { dead = true; failAll(message || `${kind} worker failed`); });
    const lane = {
        kind,
        get dead() { return dead; },
        request(message, {transfer = [], onPartial = null, onStart = null} = {}) {
            if (dead) return Promise.reject(new Error("Worker stopped"));
            const id = nextId++;
            return new Promise((resolve, reject) => {
                pending.set(id, {resolve, reject, onPartial});
                try {
                    port.post({...message, id}, transfer);
                    onStart?.(id, lane);
                } catch (error) {
                    pending.delete(id);
                    reject(error);
                }
            });
        },
        send(message, transfer = []) { if (!dead) port.post(message, transfer); },
        terminate() { dead = true; port.terminate(); failAll("Worker stopped"); },
    };
    return lane;
}

function workerPort(worker) {
    return {
        post: (message, transfer) => worker.postMessage(message, transfer),
        onMessage: (fn) => { worker.onmessage = (event) => fn(event.data); },
        onError: (fn) => { worker.onerror = (event) => { event.preventDefault?.(); fn(event.message); }; },
        terminate: () => worker.terminate(),
    };
}

// An in-thread port around a NoisePatternWorkerCore: replies arrive asynchronously and in
// order, as from a worker. Used by the tests, and when Worker does not exist.
export function localPort(createCore) {
    let handler = null;
    let alive = true;
    const core = createCore((data) => { setTimeout(() => { if (alive) handler?.(data); }, 0); });
    return {
        post: (message) => { setTimeout(() => { if (alive) core.handle(message); }, 0); },
        onMessage: (fn) => { handler = fn; },
        onError: () => {},
        terminate: () => { alive = false; },
    };
}

let cpuPool = null;
let gpuState = null;
let idleTimer = null;

function spawnCpuWorker() {
    return new Worker(new URL("../workers/NoisePatternWorker.js", import.meta.url));
}

function spawnGpuWorker() {
    return new Worker(new URL("../workers/NoisePatternGpuWorker.js", import.meta.url));
}

function cpuLanes(count) {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (cpuPool && cpuPool.length === count && !cpuPool.some(lane => lane.dead)) return cpuPool;
    for (const lane of cpuPool ?? []) lane.terminate();
    cpuPool = Array.from({length: count}, () => createLane("cpu", workerPort(spawnCpuWorker())));
    return cpuPool;
}

function defaultGpu() {
    if (gpuState?.lane && !gpuState.lane.dead) return gpuState;
    if (typeof Worker === "undefined" || typeof navigator === "undefined" || !navigator.gpu) return null;
    const lane = createLane("gpu", workerPort(spawnGpuWorker()));
    gpuState = {lane, ready: lane.request({type: "gpuInit"}).then(reply => reply.info), uploaded: null};
    gpuState.ready.catch(() => {});
    return gpuState;
}

// A folder scan owns its workers: closing the single-video window must not stop it,
// and its feature uploads must not replace the window's CPU/GPU stores.
export function createNoisePatternWorkerSession() {
    let lanes = null, gpu = null;
    return {
        hooks: {
            cache: false,
            keepSelection: true,
            lanes: () => lanes ??= Array.from({length: workerLaneCount()}, () => createLane("cpu", workerPort(spawnCpuWorker()))),
            gpu: () => {
                if (gpu) return gpu;
                if (typeof navigator === "undefined" || !navigator.gpu) return null;
                const lane = createLane("gpu", workerPort(spawnGpuWorker()));
                gpu = {lane, ready: lane.request({type: "gpuInit"}).then(reply => reply.info), uploaded: null};
                gpu.ready.catch(() => {});
                return gpu;
            },
        },
        dispose() {
            for (const lane of lanes ?? []) lane.terminate();
            gpu?.lane.terminate();
            lanes = gpu = null;
        },
    };
}

// Stops every worker. Called when the window is hidden or closed, when the sitch changes,
// and after a minute without work.
export function terminateNoisePatternWorkers() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    for (const lane of cpuPool ?? []) lane.terminate();
    cpuPool = null;
    gpuState?.lane.terminate();
    gpuState = null;
}

function scheduleIdleTerminate() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { idleTimer = null; terminateNoisePatternWorkers(); }, IDLE_TERMINATE_MS);
}

// source video -> {key, chunks, chunkCount, store}
const featureCache = new WeakMap();

export function forgetNoisePatternFeatures(source) {
    if (source) featureCache.delete(source);
}

// Work-stealing queue over a set of lanes. build() runs when a lane is free, so data is
// copied for a message only just before it is sent.
class Scheduler {
    constructor(lanes, onSlice) {
        this.idle = lanes.slice();
        this.queue = [];
        this.onSlice = onSlice;
    }

    run(task, priority = false) {
        return new Promise((resolve, reject) => {
            const entry = {task, resolve, reject};
            if (priority) this.queue.unshift(entry); else this.queue.push(entry);
            this.pump();
        });
    }

    pump() {
        while (this.idle.length && this.queue.length) {
            const lane = this.idle.shift();
            const entry = this.queue.shift();
            let built;
            const t0 = now();
            try {
                built = entry.task.build();
            } catch (error) {
                this.idle.push(lane);
                entry.reject(error);
                continue;
            }
            this.onSlice?.(now() - t0);
            lane.request(built.message, built).then(entry.resolve, entry.reject)
                .finally(() => { this.idle.push(lane); this.pump(); });
        }
    }
}

// Rows of a store, copied into one block: a slice when they are contiguous.
function gather(array, size, rows) {
    const out = new array.constructor(rows.length * size);
    const first = rows[0], last = rows[rows.length - 1];
    if (last - first + 1 === rows.length) {
        out.set(array.subarray(first * size, (last + 1) * size));
    } else {
        rows.forEach((row, i) => out.set(array.subarray(row * size, (row + 1) * size), i * size));
    }
    return out;
}

// ---------------------------------------------------------------------------------------

export function startNoisePatternJob(videoData, options, hooks = {}) {
    return new NoisePatternRun(videoData, options, hooks).api;
}

class NoisePatternRun {
    constructor(videoData, options, hooks) {
        this.video = videoData;
        this.source = sourceVideoOf(videoData);
        this.options = normalizeNoisePatternOptions(options);
        this.hooks = hooks;
        this.cancelled = false;
        this.lastNotify = 0;
        this.fineFrames = new Map();
        const chunks = this.source?.chunks ?? [];
        const lastDisplay = Math.max(0, chunks.length - 1);
        const range = this.options.range;
        this.range = range
            ? {from: Math.max(0, Math.min(lastDisplay, Math.floor(range.from))), to: Math.max(0, Math.min(lastDisplay, Math.floor(range.to)))}
            : {from: 0, to: lastDisplay};
        if (this.range.to < this.range.from) this.range = {from: this.range.to, to: this.range.from};
        this.result = {
            status: "running", stage: "spawn", error: null, version: 0, complete: false, cached: false,
            options: {...this.options, range: undefined},
            video: {name: this.source?.filename ?? this.video?.filename ?? "", frames: chunks.length,
                codec: this.source?.config?.codec ?? "", width: 0, height: 0},
            range: {...this.range},
            progress: {done: 0, total: 0},
            counts: {frames: this.range.to - this.range.from + 1, decoded: 0, failed: 0, held: 0, valid: [0, 0, 0], validAny: 0, sequence: 0},
            representation: {mode: null, bits: 8, accel: null},
            timings: {}, throughput: {},
            backend: {lanes: 0, decodeLanes: 0, search: null, mode: this.options.searchOn, reason: "", calibration: null, adapter: null},
            mainThreadMaxMs: 0,
            visibility: {start: visibility(), end: null},
            picture: this.options.held === "picture",
            lags: null, curves: {}, analysis: null,
            verdict: {kind: "pending"},
            precise: null, longRange: null, pictureRepeat: null, refine: null, selection: null,
            offset: {status: this.options.offsetSearch ? "pending" : "disabled", matches: []},
            byDisplay: null,
            benchmark: null,
        };
        this.api = {
            result: this.result,
            videoData: this.video,
            cancel: () => this.cancel(),
            analyzePair: (source, target) => this.analyzePair(source, target),
            selectPair: (source, target) => this.selectPair(source, target),
            benchmark: () => this.benchmark(),
            bestPairAtLag: (curve, lag) => this.bestPairAtLag(curve, lag),
            pairForDisplay: (display) => this.pairForDisplay(display),
            neighborPair: (display, direction) => this.neighborPair(display, direction),
        };
        this.api.promise = this.execute();
    }

    // ---- bookkeeping

    notify(force = false) {
        if (this.cancelled) return;
        const t = now();
        if (!force && t - this.lastNotify < NOTIFY_MS) return;
        this.lastNotify = t;
        this.result.version++;
        try { this.hooks.onUpdate?.(this.result); } catch (error) { console.warn("Noise pattern update failed", error); }
    }

    slice(ms) {
        if (ms > this.result.mainThreadMaxMs) this.result.mainThreadMaxMs = ms;
    }

    timed(fn) {
        const t0 = now();
        try { return fn(); } finally { this.slice(now() - t0); }
    }

    setStage(stage, total = 0) {
        this.check();
        this.result.stage = stage;
        this.result.progress = {done: 0, total};
        this.notify(true);
    }

    check() {
        if (this.cancelled) throw new Error("Stopped");
    }

    cancel() {
        if (this.cancelled || this.result.complete) return;
        this.result.status = "stopped";
        this.result.version++;
        try { this.hooks.onUpdate?.(this.result); } catch { /* ignore */ }
        this.cancelled = true;
        if (this.hooks.lanes) for (const lane of this.lanes ?? []) lane.terminate();
        else terminateNoisePatternWorkers();
    }

    cacheKey() {
        return JSON.stringify({detail: this.options.detail, range: this.range, held: this.options.held});
    }

    // ---- main sequence

    async execute() {
        const r = this.result;
        const started = now();
        try {
            if (!this.source?.chunks?.length || !this.source.config) throw new Error("The video has no encoded frames to read");
            this.setStage("spawn");
            this.lanes = this.hooks.lanes ? this.hooks.lanes() : cpuLanes(workerLaneCount());
            r.backend.lanes = this.lanes.length;
            this.scheduler = new Scheduler(this.lanes, ms => this.slice(ms));
            await Promise.all(this.lanes.map(lane => lane.request({type: "ping"})));
            r.timings.spawn = now() - started;
            const key = this.cacheKey();
            const cached = this.hooks.cache === false ? null : featureCache.get(this.source);
            if (cached && cached.key === key && cached.chunks === this.source.chunks && cached.chunkCount === this.source.chunks.length) {
                this.store = cached.store;
                r.cached = true;
                Object.assign(r.representation, this.store.representation);
            } else {
                await this.ingest();
                await this.heldStage();
                this.buildSequence();
                await this.prep();
                if (this.hooks.cache !== false) {
                    featureCache.set(this.source, {key, chunks: this.source.chunks, chunkCount: this.source.chunks.length, store: this.store});
                }
            }
            this.publishStore();
            await this.coarse();
            if (r.verdict.period) {
                await this.precise();
                await this.longRange();
                await this.refine();
            }
            if (this.options.offsetSearch) await this.offsetSearch();
            r.status = "done";
        } catch (error) {
            if (this.cancelled) r.status = "stopped";
            else {
                r.status = "error";
                r.error = error?.message ?? String(error);
                console.warn("Noise Pattern Detection failed:", error);
            }
        } finally {
            r.timings.total = now() - started;
            r.visibility.end = visibility();
            r.complete = true;
            r.stage = "done";
            if (!this.hooks.lanes && !this.cancelled) scheduleIdleTerminate();
            this.notify(true);
        }
        return r;
    }

    // ---- ingest

    displayMap() {
        if (this.displayOf) return;
        const src = this.source, chunks = src.chunks;
        this.chunkCount = chunks.length;
        this.displayOf = new Int32Array(chunks.length).fill(-1);
        for (let c = 0; c < chunks.length; c++) {
            const d = src.timestampToChunkIndex?.get(chunks[c].timestamp);
            if (d !== undefined) this.displayOf[c] = d;
        }
        this.groupStarts = (src.groups ?? []).map(group => group.frame);
        // Segments may only start where a cold decoder can start: for H.264 that is an IDR
        // chunk. A "key" chunk with only a non-IDR I slice is merged into the group before it.
        this.mergedStarts = 0;
        if (/^avc[13]/i.test(String(src.config?.codec ?? "")) && this.groupStarts.length > 1) {
            const lengthSize = avcNalLengthSize(src.config?.description);
            const starts = [this.groupStarts[0]];
            for (let i = 1; i < this.groupStarts.length; i++) {
                const chunk = chunks[this.groupStarts[i]];
                const bytes = new Uint8Array(chunk.byteLength);
                chunk.copyTo(bytes);
                if (avcChunkHasIdr(bytes, lengthSize)) starts.push(this.groupStarts[i]);
                else this.mergedStarts++;
            }
            this.groupStarts = starts;
        }
    }

    // Runs one decode segment. A decoder failure, whether the whole segment was rejected or
    // only part of it came out (the worker reports that as an error with frames failed), is
    // retried once from the start of the segment before it (pre-roll). A second failure keeps
    // what was decoded, skips the rest and counts it: the analysis goes on, and the verdict
    // says how many frames it does not cover. The feature store ignores a frame it already
    // holds, so a retry never counts a frame twice.
    async decodeSegmentWithRetry(scheduler, segments, i, buildFor) {
        const segment = segments[i];
        const attempt = (from) => scheduler.run({build: () => buildFor(from)});
        let first = null, error = null;
        try {
            first = await attempt(segment.decodeFrom);
            if (!first.error || !(first.failed > 0)) return first;
            error = first.error;
        } catch (e) {
            error = String(e?.message ?? e);
        }
        const prev = i > 0 ? segments[i - 1].decodeFrom : -1;
        if (prev >= 0 && prev < segment.decodeFrom && !this.cancelled) {
            try {
                const reply = await attempt(prev);
                reply.prerolled = true;
                // the recovery is reported with the error that made it necessary
                reply.error = reply.error ?? error;
                if (reply.failed > 0 && reply.error) reply.partial = true;
                return reply;
            } catch (e) {
                error = String(e?.message ?? e);
            }
        }
        console.warn(`Noise Pattern Detection: frames ${segment.keepFrom}-${segment.keepTo - 1} could not be decoded (${error})`);
        return {decoded: first?.decoded ?? 0, failed: first ? first.failed : segment.keepTo - segment.keepFrom,
            accel: first?.accel, error, skipped: true};
    }

    chunkItems(from, to, limitBytes = MESSAGE_BYTES) {
        const items = [], transfer = [];
        let bytes = 0, c = from;
        for (; c < to; c++) {
            const chunk = this.source.chunks[c];
            const data = new ArrayBuffer(chunk.byteLength);
            chunk.copyTo(data);
            items.push({data, type: chunk.type, timestamp: chunk.timestamp, duration: chunk.duration ?? undefined, index: this.displayOf[c]});
            transfer.push(data);
            bytes += data.byteLength;
            if (bytes >= limitBytes) { c++; break; }
        }
        return {items, transfer, next: c};
    }

    async sendRest(lane, id, segment, from) {
        let c = from;
        while (c < segment.decodeTo && !this.cancelled) {
            await pause();
            const part = this.timed(() => this.chunkItems(c, segment.decodeTo));
            c = part.next;
            lane.send({type: "decodeChunks", id, items: part.items, last: c >= segment.decodeTo}, part.transfer);
        }
    }

    async ingest() {
        const r = this.result;
        this.displayMap();
        const t0 = now();
        this.setStage("ingest", r.counts.frames);
        const decodeLanes = this.lanes.slice(0, Math.min(DECODE_CONCURRENCY, this.lanes.length));
        r.backend.decodeLanes = decodeLanes.length;
        const segments = planSegments(this.groupStarts, this.displayOf, this.chunkCount, this.range, 2 * this.lanes.length);
        if (!segments.length) throw new Error("The video has no key frames in the range");
        const scheduler = new Scheduler(decodeLanes, ms => this.slice(ms));
        const accels = new Set();
        let decoded = 0, failed = 0, decodeErrors = 0, skippedSegments = 0, prerolled = 0, lastError = null;
        await Promise.all(segments.map((segment, i) => this.decodeSegmentWithRetry(scheduler, segments, i, (decodeFrom) => {
            const first = this.chunkItems(decodeFrom, segment.decodeTo);
            const last = first.next >= segment.decodeTo;
            return {
                message: {type: "decode", config: this.source.config, accel: "prefer-software", items: first.items,
                    keepFrom: segment.keepFrom, keepTo: segment.keepTo, detail: this.options.detail, batchSize: 32, last},
                transfer: first.transfer,
                onPartial: (data) => this.timed(() => this.storeFeatures(data)),
                onStart: last ? null : (id, lane) => { this.sendRest(lane, id, segment, first.next); },
            };
        }).then(reply => {
            decoded += reply.decoded;
            failed += reply.failed;
            if (reply.accel) accels.add(reply.accel);
            if (reply.error) { decodeErrors++; lastError = reply.error; }
            if (reply.skipped) skippedSegments++;
            if (reply.prerolled) prerolled++;
        })));
        if (!this.store?.decodedCount) throw new Error(lastError ? `No frame of the video could be decoded (${lastError})` : "No frame of the video could be decoded");
        r.counts.decoded = this.store.decodedCount;
        r.counts.failed = r.counts.frames - this.store.decodedCount;
        // kept on the store, so that a cached rerun (new settings, same features) reports them too
        this.store.decodeReport = {decodeErrors, skippedSegments, prerolledSegments: prerolled,
            mergedKeyFrames: this.mergedStarts, lastDecodeError: lastError};
        Object.assign(r.counts, this.store.decodeReport);
        r.representation.accel = [...accels].join(", ");
        this.store.representation = {...r.representation};
        r.timings.ingest = now() - t0;
        r.throughput.ingestFps = this.store.decodedCount / Math.max(1e-3, r.timings.ingest / 1000);
        void decoded; void failed;
    }

    storeFeatures(data) {
        const r = this.result;
        if (this.cancelled) return;
        let store = this.store;
        if (!store) {
            const rows = this.range.to - this.range.from + 1;
            const {columns} = data;
            const rowSize = columns * BAND_STRIDE;
            store = this.store = {
                rows, columns, rowSize, colWidth: data.colWidth, width: data.width, height: data.height, from: this.range.from,
                raw: [0, 1, 2].map(() => new Int8Array(rows * rowSize)),
                live: [0, 1, 2].map(() => new Uint8Array(rows * columns)),
                liveFraction: new Float32Array(rows * 3),
                decoded: new Uint8Array(rows), held: new Uint8Array(rows), heldScore: new Float32Array(rows).fill(NaN),
                sigYRaw: new Int8Array(rows * SIG_COUNT), sigCbRaw: new Int8Array(rows * SIG_COUNT),
                thumbs: new Float32Array(rows * THUMB_SIZE),
                sigSumY: new Float64Array(SIG_COUNT), sigSumCb: new Float64Array(SIG_COUNT), sigCount: 0, decodedCount: 0,
                representation: null,
            };
            r.video.width = data.width;
            r.video.height = data.height;
        }
        if (data.columns !== store.columns || data.width !== store.width || data.height !== store.height) {
            throw new Error("The frame size changed during analysis");
        }
        const {rowSize, columns} = store;
        for (let i = 0; i < data.count; i++) {
            const row = data.indices[i] - store.from;
            if (row < 0 || row >= store.rows || store.decoded[row]) continue;
            store.decoded[row] = 1;
            store.decodedCount++;
            for (let p = 0; p < 3; p++) {
                store.raw[p].set(data.strips[p].subarray(i * rowSize, (i + 1) * rowSize), row * rowSize);
                store.live[p].set(data.live[p].subarray(i * columns, (i + 1) * columns), row * columns);
                store.liveFraction[row * 3 + p] = data.liveFraction[i * 3 + p];
            }
            store.sigYRaw.set(data.sigY.subarray(i * SIG_COUNT, (i + 1) * SIG_COUNT), row * SIG_COUNT);
            store.sigCbRaw.set(data.sigCb.subarray(i * SIG_COUNT, (i + 1) * SIG_COUNT), row * SIG_COUNT);
            store.thumbs.set(data.thumbs.subarray(i * THUMB_SIZE, (i + 1) * THUMB_SIZE), row * THUMB_SIZE);
        }
        for (let k = 0; k < SIG_COUNT; k++) { store.sigSumY[k] += data.sigSumY[k]; store.sigSumCb[k] += data.sigSumCb[k]; }
        store.sigCount += data.count;
        r.representation.mode = data.mode;
        r.representation.bits = data.bits;
        r.progress.done = store.decodedCount;
        this.notify();
    }

    async heldStage() {
        const r = this.result, store = this.store;
        const t0 = now();
        this.setStage("held", store.rows);
        const meanSig = new Float64Array(SIG_COUNT);
        for (let k = 0; k < SIG_COUNT; k++) meanSig[k] = store.sigSumY[k] / Math.max(1, store.sigCount);
        const windowRows = 1024;
        const tasks = [];
        for (let a = 0; a < store.rows; a += windowRows) {
            const b = Math.min(store.rows, a + windowRows);
            const start = Math.max(0, a - 1);
            tasks.push(this.scheduler.run({
                build: () => ({message: {type: "held", rows: b - start, meanSig,
                    sigs: store.sigYRaw.slice(start * SIG_COUNT, b * SIG_COUNT), decoded: store.decoded.slice(start, b)}}),
            }).then(reply => this.timed(() => {
                for (let row = a; row < b; row++) {
                    const score = reply.scores[row - start];
                    store.heldScore[row] = score;
                    store.held[row] = score >= HELD_NCC ? 1 : 0;
                }
                r.progress.done += b - a;
                this.notify();
            })));
        }
        await Promise.all(tasks);
        let held = 0;
        for (let row = 0; row < store.rows; row++) held += store.held[row];
        store.heldCount = held;
        r.timings.held = now() - t0;
    }

    buildSequence() {
        const store = this.store;
        const picture = this.options.held === "picture";
        const seq = [];
        for (let row = 0; row < store.rows; row++) {
            if (picture && store.decoded[row] && store.held[row]) continue;
            seq.push(row);
        }
        store.picture = picture;
        store.seq = Int32Array.from(seq);
        const n = seq.length;
        store.n = n;
        store.valid = [0, 1, 2].map(p => {
            const v = new Uint8Array(n);
            for (let q = 0; q < n; q++) {
                const row = seq[q];
                v[q] = store.decoded[row] && store.liveFraction[row * 3 + p] >= LIVE_FRACTION && (picture || !store.held[row]) ? 1 : 0;
            }
            return v;
        });
        store.validAny = new Uint8Array(n);
        for (let q = 0; q < n; q++) store.validAny[q] = store.valid[0][q] || store.valid[1][q] ? 1 : 0;
        // where each row sits in the sequence (-1: not in it)
        store.qOfRow = new Int32Array(store.rows).fill(-1);
        for (let q = 0; q < n; q++) store.qOfRow[seq[q]] = q;
    }

    async prep() {
        const r = this.result, store = this.store;
        const t0 = now();
        const {n, rowSize, columns, seq} = store;
        this.setStage("prep", n);
        const bytesPerRow = 3 * rowSize + 3 * columns + 2 * SIG_COUNT + 4;
        const windowRows = Math.max(32, Math.floor(MESSAGE_BYTES / bytesPerRow) - 2 * TEMPORAL_HALF);
        store.strips = [0, 1, 2].map(() => new Int8Array(n * rowSize));
        store.energies = [0, 1, 2].map(() => new Float32Array(n * columns));
        store.sigs = [new Int8Array(n * SIG_COUNT), new Int8Array(n * SIG_COUNT)];
        store.norms = [new Float32Array(n), new Float32Array(n)];
        const tasks = [];
        for (let lo = 0; lo < n; lo += windowRows) {
            const hi = Math.min(n, lo + windowRows);
            const a = Math.max(0, lo - TEMPORAL_HALF), b = Math.min(n, hi + TEMPORAL_HALF);
            tasks.push(this.scheduler.run({
                build: () => {
                    const rows = Array.from(seq.subarray(a, b));
                    const raw = store.raw.map(arr => gather(arr, rowSize, rows));
                    const live = store.live.map(arr => gather(arr, columns, rows));
                    const valid = store.valid.map(v => v.slice(a, b));
                    const validAny = store.validAny.slice(a, b);
                    const sigY = gather(store.sigYRaw, SIG_COUNT, rows), sigCb = gather(store.sigCbRaw, SIG_COUNT, rows);
                    return {message: {type: "prep", rows: b - a, lo: lo - a, hi: hi - a, columns, raw, live, valid, validAny, sigY, sigCb},
                        transfer: [...raw, ...live, ...valid, validAny, sigY, sigCb].map(x => x.buffer)};
                },
            }).then(reply => this.timed(() => {
                for (let p = 0; p < 3; p++) {
                    store.strips[p].set(reply.strips[p], lo * rowSize);
                    store.energies[p].set(reply.energies[p], lo * columns);
                }
                for (let k = 0; k < 2; k++) {
                    store.sigs[k].set(reply.sigs[k], lo * SIG_COUNT);
                    store.norms[k].set(reply.norms[k], lo);
                }
                r.progress.done += hi - lo;
                this.notify();
            })));
        }
        await Promise.all(tasks);
        // the raw features are not needed again for this store
        store.raw = null; store.live = null; store.sigYRaw = null; store.sigCbRaw = null;
        r.timings.prep = now() - t0;
    }

    publishStore() {
        const r = this.result, store = this.store;
        r.video.width = store.width;
        r.video.height = store.height;
        r.counts.decoded = store.decodedCount;
        r.counts.failed = r.counts.frames - store.decodedCount;
        if (store.decodeReport) Object.assign(r.counts, store.decodeReport);
        r.counts.held = store.heldCount ?? 0;
        r.counts.sequence = store.n;
        r.counts.valid = store.valid.map(v => v.reduce((s, x) => s + x, 0));
        r.counts.validAny = store.validAny.reduce((s, x) => s + x, 0);
        r.columns = store.columns;
        r.colWidth = store.colWidth;
        const frames = store.rows;
        r.byDisplay = {
            from: store.from, rows: frames,
            decoded: store.decoded, held: store.held, heldScore: store.heldScore,
            tested: new Uint8Array(frames), matched: new Uint8Array(frames),
            score: new Float32Array(frames).fill(NaN), tau: new Float32Array(frames).fill(NaN),
        };
    }

    // ---- search backends

    planeOfCurve(curve) {
        return {"S-Y": 0, "S-Cb": 1, "S-Cr": 2, "A-Yfine": 0, "A-Cbmid": 1}[curve];
    }

    cpuSearchTask(plane, pairs, V, onResult) {
        const store = this.store;
        return {
            build: () => {
                const rows = [...new Set(pairs)].sort((a, b) => a - b);
                const local = new Map(rows.map((row, i) => [row, i]));
                const localPairs = Int32Array.from(pairs, q => local.get(q));
                const strips = gather(store.strips[plane], store.rowSize, rows);
                const energies = gather(store.energies[plane], store.columns, rows);
                return {message: {type: "search", columns: store.columns, colWidth: store.colWidth, V, strips, energies, pairs: localPairs},
                    transfer: [strips.buffer, energies.buffer, localPairs.buffer]};
            },
            onResult,
        };
    }

    // Splits a list of pairs into CPU tasks of nearby frames (each message at most 8 MB).
    splitPairs(pairs, maxRows) {
        const order = [];
        for (let i = 0; i < pairs.length / 2; i++) order.push(i);
        order.sort((a, b) => Math.min(pairs[2 * a], pairs[2 * a + 1]) - Math.min(pairs[2 * b], pairs[2 * b + 1]));
        const groups = [];
        let current = [], rows = new Set();
        for (const i of order) {
            const t = pairs[2 * i], s = pairs[2 * i + 1];
            const extra = (rows.has(t) ? 0 : 1) + (rows.has(s) ? 0 : 1);
            if (current.length && (rows.size + extra > maxRows || current.length >= 512)) {
                groups.push(current); current = []; rows = new Set();
            }
            current.push(i); rows.add(t); rows.add(s);
        }
        if (current.length) groups.push(current);
        return groups;
    }

    async searchCPU(plane, pairs, V, onProgress) {
        const results = new Float32Array(pairs.length * 2).fill(NaN);
        const store = this.store;
        const maxRows = Math.max(8, Math.floor(MESSAGE_BYTES / (store.rowSize + store.columns * 4)));
        const groups = this.splitPairs(pairs, maxRows);
        await Promise.all(groups.map(group => {
            const sub = new Int32Array(group.length * 2);
            group.forEach((i, j) => { sub[2 * j] = pairs[2 * i]; sub[2 * j + 1] = pairs[2 * i + 1]; });
            return this.scheduler.run(this.cpuSearchTask(plane, sub, V)).then(reply => this.timed(() => {
                group.forEach((i, j) => results.set(reply.results.subarray(4 * j, 4 * j + 4), 4 * i));
                onProgress?.(group.length);
            }));
        }));
        return results;
    }

    async gpuEnsureUploaded() {
        const gpu = this.gpu;
        if (gpu.uploaded === this.store) return;
        const store = this.store;
        const rowBytes = store.rowSize + store.columns * 4;
        const rowsPerSlice = Math.max(1, Math.floor(MESSAGE_BYTES / rowBytes));
        for (let p = 0; p < 3; p++) {
            for (let a = 0; a < store.n; a += rowsPerSlice) {
                this.check();
                const b = Math.min(store.n, a + rowsPerSlice);
                const {strips, energies} = this.timed(() => ({
                    strips: store.strips[p].slice(a * store.rowSize, b * store.rowSize),
                    energies: store.energies[p].slice(a * store.columns, b * store.columns),
                }));
                await gpu.lane.request({type: "upload", plane: p, columns: store.columns, rows: store.n, offsetRow: a, strips, energies},
                    {transfer: [strips.buffer, energies.buffer]});
            }
        }
        gpu.uploaded = store;
    }

    async searchGPU(plane, pairs) {
        await this.gpuEnsureUploaded();
        const reply = await this.gpu.lane.request({type: "search", plane, pairs: Int32Array.from(pairs), colWidth: this.store.colWidth});
        return reply.results;
    }

    // Starts the GPU worker and uploads the profiles. Returns false (with the reason in the
    // result) when the GPU cannot be used.
    async gpuReady() {
        const r = this.result;
        if (this.gpuChecked !== undefined) return this.gpuChecked;
        this.gpuChecked = false;
        try {
            this.gpu = this.hooks.gpu ? this.hooks.gpu() : defaultGpu();
            if (!this.gpu) { r.backend.reason = "WebGPU is not available in this browser"; return false; }
            const t0 = now();
            r.backend.adapter = await this.gpu.ready;
            await this.gpuEnsureUploaded();
            r.timings.gpuSetup = now() - t0;
            this.gpuChecked = true;
        } catch (error) {
            if (this.cancelled) throw error;
            r.backend.reason = `GPU unavailable: ${error.message}`;
        }
        return this.gpuChecked;
    }

    gpuFailed(error) {
        if (this.cancelled) throw error;
        this.result.backend.reason = `GPU failed, using the CPU workers: ${error.message}`;
        this.result.backend.search = "cpu";
        this.backend = "cpu";
    }

    // Searches pairs on the chosen backend; strip curves with a vertical search use the CPU.
    async searchPairs(plane, pairs, V, onProgress) {
        if (this.backend === "gpu" && V === 0) {
            try {
                const results = await this.searchGPU(plane, pairs);
                onProgress?.(pairs.length / 2);
                return results;
            } catch (error) {
                this.gpuFailed(error);
            }
        }
        return this.searchCPU(plane, pairs, V, onProgress);
    }

    async alignedPairs(pairs) {
        const store = this.store;
        const results = new Float32Array(pairs.length).fill(NaN);
        const maxRows = Math.max(8, Math.floor(MESSAGE_BYTES / (2 * SIG_COUNT + 8)));
        const groups = this.splitPairs(pairs, maxRows);
        await Promise.all(groups.map(group => this.scheduler.run({
            build: () => {
                const sub = [];
                group.forEach(i => sub.push(pairs[2 * i], pairs[2 * i + 1]));
                const rows = [...new Set(sub)].sort((a, b) => a - b);
                const local = new Map(rows.map((row, i) => [row, i]));
                const localPairs = Int32Array.from(sub, q => local.get(q));
                const sigs = store.sigs.map(s => gather(s, SIG_COUNT, rows));
                const norms = store.norms.map(nm => Float32Array.from(rows, row => nm[row]));
                return {message: {type: "aligned", sigs, norms, pairs: localPairs},
                    transfer: [...sigs.map(s => s.buffer), ...norms.map(nm => nm.buffer), localPairs.buffer]};
            },
        }).then(reply => this.timed(() => {
            group.forEach((i, j) => { results[2 * i] = reply.results[2 * j]; results[2 * i + 1] = reply.results[2 * j + 1]; });
        }))));
        return results;
    }

    // ---- coarse lag scan

    async chooseBackend(calibrationPairs, onCalibrated) {
        const r = this.result;
        const mode = this.options.searchOn;
        const V = this.options.vertical;
        this.backend = "cpu";
        r.backend.search = "cpu";
        if (mode === "cpu") { r.backend.reason = "CPU workers selected"; return; }
        if (V > 0) { r.backend.reason = "The vertical search runs on the CPU workers"; return; }
        const t0 = now();
        if (!(await this.gpuReady())) return;
        if (mode === "gpu") {
            this.backend = "gpu"; r.backend.search = "gpu"; r.backend.reason = "GPU selected";
            return;
        }
        // Fastest: the same pairs on both, warm
        if (!calibrationPairs.length) { this.backend = "gpu"; r.backend.search = "gpu"; return; }
        const pairs = Int32Array.from(calibrationPairs);
        const count = pairs.length / 2;
        const tCpu0 = now();
        const lanesN = this.lanes.length;
        const per = Math.ceil(count / lanesN);
        const cpuResults = new Float32Array(count * 4);
        await Promise.all(Array.from({length: Math.ceil(count / per)}, (_, k) => {
            const a = k * per, b = Math.min(count, a + per);
            return this.scheduler.run(this.cpuSearchTask(1, pairs.slice(2 * a, 2 * b), 0)).then(reply => {
                cpuResults.set(reply.results, 4 * a);
            });
        }));
        const cpuMs = now() - tCpu0;
        let gpuMs = NaN, gpuResults = null;
        try {
            await this.searchGPU(1, pairs.slice(0, Math.min(pairs.length, 128)));
            const tGpu0 = now();
            gpuResults = await this.searchGPU(1, pairs);
            gpuMs = now() - tGpu0;
        } catch (error) {
            this.gpuFailed(error);
        }
        let maxDelta = 0, mismatchedNaN = 0;
        if (gpuResults) {
            for (let i = 0; i < count; i++) {
                const a = cpuResults[4 * i + 1], b = gpuResults[4 * i + 1];
                if (Number.isNaN(a) !== Number.isNaN(b)) mismatchedNaN++;
                else if (Number.isFinite(a)) maxDelta = Math.max(maxDelta, Math.abs(a - b));
            }
        }
        const cpuRate = count / Math.max(1e-3, cpuMs / 1000), gpuRate = gpuResults ? count / Math.max(1e-3, gpuMs / 1000) : 0;
        r.backend.calibration = {pairs: count, cpuMs, gpuMs, cpuPairsPerSec: cpuRate, gpuPairsPerSec: gpuRate,
            maxDeltaC: gpuResults ? maxDelta : NaN, nanMismatches: mismatchedNaN};
        r.timings.calibration = now() - t0;
        if (gpuResults && gpuRate > cpuRate) {
            this.backend = "gpu"; r.backend.search = "gpu";
            r.backend.reason = "Fastest: the GPU was faster on the calibration pairs";
        } else if (gpuResults) {
            r.backend.reason = "Fastest: the CPU workers were faster on the calibration pairs";
        }
        onCalibrated?.(cpuResults);
    }

    async coarse() {
        const r = this.result, store = this.store;
        const t0 = now();
        const {n} = store;
        const Nv = r.counts.validAny;
        const lmax = Math.min(this.options.longestLag, Math.floor(Nv / 4));
        const R = this.options.references;
        r.lags = {lmax, lagMin: LAG_MIN, R, picture: store.picture};
        if (lmax < 2 * LAG_MIN) {
            r.verdict = {kind: "cannot", reason: "tooFew", frames: Nv};
            this.setStage("coarse");
            r.timings.coarse = now() - t0;
            return;
        }
        const order = bitReversedOrder(R);
        const V = this.options.vertical;
        const refs = {};
        const rows = {};
        const extra = {};
        for (let p = 0; p < 3; p++) refs[STRIP_CURVES[p]] = referenceIndices(store.valid[p], n, R);
        const alignedRefs = referenceIndices(store.validAny, n, R);
        for (const name of ALIGNED_CURVES) refs[name] = alignedRefs;
        for (const name of CURVES) rows[name] = new Float32Array(R * lmax).fill(NaN);
        for (const name of STRIP_CURVES) extra[name] = {Q: new Float32Array(R * lmax).fill(NaN), shift: new Float32Array(R * lmax).fill(NaN), nValid: new Float32Array(R * lmax).fill(NaN)};
        r.lags.refs = refs;
        r.curves = {};
        for (const name of CURVES) r.curves[name] = {rows: rows[name], ...extra[name]};
        // pairs of each strip curve, in reference order
        const stripPairs = STRIP_CURVES.map((name, p) => {
            const list = [], where = [];
            for (const a of order) {
                const ref = refs[name][a];
                if (ref === undefined) continue;
                for (let L = 1; L <= lmax; L++) {
                    const pair = lagPair(ref, L, n, store.valid[p]);
                    if (!pair) continue;
                    list.push(pair[0], pair[1]);
                    where.push(a * lmax + L - 1);
                }
            }
            return {list, where};
        });
        const alignedList = [], alignedWhere = [];
        for (const a of order) {
            const ref = alignedRefs[a];
            if (ref === undefined) continue;
            for (let L = 1; L <= lmax; L++) {
                const pair = lagPair(ref, L, n, store.validAny);
                if (!pair) continue;
                alignedList.push(pair[0], pair[1]);
                alignedWhere.push(a * lmax + L - 1);
            }
        }
        const total = stripPairs.reduce((s, x) => s + x.where.length, 0) + alignedWhere.length;
        this.setStage("coarse", total);
        const write = (p, start, results) => {
            const name = STRIP_CURVES[p], {where} = stripPairs[p];
            for (let i = 0; i < results.length / 4; i++) {
                const cell = where[start + i];
                rows[name][cell] = results[4 * i + 1];
                extra[name].Q[cell] = results[4 * i];
                extra[name].nValid[cell] = results[4 * i + 2];
                extra[name].shift[cell] = results[4 * i + 3];
            }
        };
        // Search on: the first 512 Cb pairs measure both backends
        const calibrationCount = Math.min(CALIBRATION_PAIRS, stripPairs[1].where.length);
        let skipCb = 0;
        await this.chooseBackend(stripPairs[1].list.slice(0, 2 * calibrationCount), (cpuResults) => {
            write(1, 0, cpuResults);
            skipCb = calibrationCount;
            r.progress.done += calibrationCount;
        });
        const tSearch = now();
        // progressive analysis while the pairs come in
        let analyzing = null, dirty = false;
        const progressive = () => {
            if (analyzing) { dirty = true; return; }
            analyzing = this.analyze(rows, R, lmax, true).finally(() => {
                analyzing = null;
                if (dirty && !this.cancelled) { dirty = false; progressive(); }
            });
        };
        const aligned = this.alignedPairs(alignedList).then(results => this.timed(() => {
            for (let i = 0; i < alignedWhere.length; i++) {
                rows["A-Yfine"][alignedWhere[i]] = results[2 * i];
                rows["A-Cbmid"][alignedWhere[i]] = results[2 * i + 1];
            }
            r.progress.done += alignedWhere.length;
        }));
        const searches = [];
        for (let p = 0; p < 3; p++) {
            const {list, where} = stripPairs[p];
            const start = p === 1 ? skipCb : 0;
            if (start >= where.length) continue;
            // one request per reference on the CPU, so the curves fill in progressively
            if (this.backend === "gpu" && V === 0) {
                searches.push(this.searchPairs(p, list.slice(2 * start), V).then(results => this.timed(() => {
                    write(p, start, results);
                    r.progress.done += results.length / 4;
                    progressive();
                    this.notify();
                })));
            } else {
                let a = start;
                while (a < where.length) {
                    const ref = Math.floor(where[a] / lmax);
                    let b = a;
                    while (b < where.length && Math.floor(where[b] / lmax) === ref) b++;
                    const begin = a;
                    searches.push(this.searchCPU(p, list.slice(2 * a, 2 * b), V).then(results => this.timed(() => {
                        write(p, begin, results);
                        r.progress.done += results.length / 4;
                        progressive();
                        this.notify();
                    })));
                    a = b;
                }
            }
        }
        await Promise.all([...searches, aligned]);
        r.timings.coarseSearch = now() - tSearch;
        r.throughput.coarsePairsPerSec = (total - alignedWhere.length) / Math.max(1e-3, r.timings.coarseSearch / 1000);
        r.throughput.coarseBackend = this.backend;
        while (analyzing) await analyzing;
        await this.analyze(rows, R, lmax, false);
        r.timings.coarse = now() - t0;
        this.decideVerdict();
    }

    async analyze(rows, R, lmax, partial) {
        const curves = {};
        for (const name of CURVES) curves[name] = rows[name].slice();
        const reply = await this.scheduler.run({build: () => ({message: {type: "analyze", curves, R, lmax, lagMin: LAG_MIN}})}, true);
        if (this.cancelled) return;
        this.timed(() => {
            for (const [name, c] of Object.entries(reply.curves)) Object.assign(this.result.curves[name], c);
            this.result.analysis = {verdictCurve: reply.verdictCurve, partial};
        });
        this.notify(!partial);
    }

    decideVerdict() {
        const r = this.result;
        const name = r.analysis?.verdictCurve;
        const significant = [];
        for (const curve of CURVES) for (const L of r.curves[curve]?.significant ?? []) significant.push({curve, lag: L, z: r.curves[curve].z[L - 1]});
        if (name) {
            const c = r.curves[name];
            const P = c.period;
            r.verdict = {kind: "repeat", curve: name, plane: this.planeOfCurve(name), strip: name.startsWith("S-"),
                period: P, strength: c.strength,
                strengthLabel: c.strength >= STRONG_Z ? "strong" : c.strength >= SIGNIFICANT_Z ? "clear" : "weak",
                coverage: c.coverage, references: r.lags.R,
                isolated: significant.filter(s => s.lag % P !== 0)};
        } else if (significant.length) {
            r.verdict = {kind: "isolated", isolated: significant.sort((a, b) => b.z - a.z)};
        } else {
            r.verdict = {kind: "none"};
        }
        this.notify(true);
    }

    // ---- precise pass

    async scorePairs(pairs, onProgress) {
        const v = this.result.verdict;
        if (v.strip) {
            const results = await this.searchPairs(v.plane, pairs, this.options.vertical, onProgress);
            const scores = new Float32Array(pairs.length / 2);
            for (let i = 0; i < scores.length; i++) scores[i] = results[4 * i + 1];
            return {scores, results};
        }
        const aligned = await this.alignedPairs(pairs);
        const sig = v.curve === "A-Yfine" ? 0 : 1;
        const scores = new Float32Array(pairs.length / 2);
        for (let i = 0; i < scores.length; i++) scores[i] = aligned[2 * i + sig];
        onProgress?.(scores.length);
        return {scores, results: null};
    }

    validOfVerdict() {
        const v = this.result.verdict;
        return v.strip ? this.store.valid[v.plane] : this.store.validAny;
    }

    async precise() {
        const r = this.result, store = this.store;
        const t0 = now();
        const P = r.verdict.period;
        const n = store.n;
        const valid = this.validOfVerdict();
        const pairs = [], controls = [];
        const pairSource = [], controlSource = [];
        for (let q = 0; q + P < n; q++) {
            if (valid[q] && valid[q + P]) { pairs.push(q + P, q); pairSource.push(q); }
            const c = q + P + Math.ceil(P / 2);
            if (q % 2 === 0 && c < n && valid[q] && valid[c]) { controls.push(c, q); controlSource.push(q); }
        }
        this.setStage("precise", pairSource.length + controlSource.length);
        const all = Int32Array.from([...pairs, ...controls]);
        const {scores, results} = await this.scorePairs(all, (k) => { r.progress.done += k; this.notify(); });
        const m = new Float32Array(n).fill(NaN), control = new Float32Array(n).fill(NaN), pairC = new Float32Array(n).fill(NaN);
        this.timed(() => {
            for (let i = 0; i < pairSource.length; i++) {
                const q = pairSource[i], c = scores[i];
                pairC[q] = c;
                if (Number.isFinite(c)) {
                    m[q] = Number.isFinite(m[q]) ? Math.max(m[q], c) : c;
                    m[q + P] = Number.isFinite(m[q + P]) ? Math.max(m[q + P], c) : c;
                }
            }
            for (let i = 0; i < controlSource.length; i++) control[controlSource[i]] = scores[pairSource.length + i];
        });
        const floor = r.verdict.strip ? 0.25 : 0.05;
        const reply = await this.scheduler.run({build: () => ({message: {type: "thresholds", controls: control.slice(), n, floor}})});
        const tau = reply.tau;
        const rawMatched = new Uint8Array(n);
        let tested = 0;
        for (let q = 0; q < n; q++) {
            if (Number.isFinite(m[q])) tested++;
            rawMatched[q] = Number.isFinite(m[q]) && Number.isFinite(tau[q]) && m[q] >= tau[q] ? 1 : 0;
        }
        const runs = matchedRuns(rawMatched, n, P, 2 * P);
        const matched = new Uint8Array(n);
        for (const [a, b] of runs) for (let q = a; q <= b; q++) matched[q] = rawMatched[q];
        let matchedCount = 0;
        for (let q = 0; q < n; q++) matchedCount += matched[q];
        // results by display frame
        const bd = r.byDisplay;
        for (let q = 0; q < n; q++) {
            const row = store.seq[q];
            if (Number.isFinite(m[q])) bd.tested[row] = 1;
            bd.matched[row] = matched[q];
            bd.score[row] = m[q];
            bd.tau[row] = tau[q];
        }
        // the same picture again (looped footage or copied frames) instead of a noise layer
        const thumbScores = (list, lagFor) => {
            const out = [];
            for (const q of list) {
                const a = store.seq[q], b = store.seq[q + lagFor];
                if (b === undefined) continue;
                const v = thumbNCC(store.thumbs, a * THUMB_SIZE, store.thumbs, b * THUMB_SIZE);
                if (Number.isFinite(v)) out.push(v);
            }
            return out;
        };
        const matchedSources = pairSource.filter(q => matched[q] && matched[q + P]);
        const matchedThumbs = thumbScores(matchedSources, P);
        const controlThumbs = thumbScores(controlSource.filter(q => matched[q]), P + Math.ceil(P / 2));
        const med = (values) => values.length ? medianOf(Float64Array.from(values), values.length) : NaN;
        const matchedMedian = med(matchedThumbs), controlMedian = med(controlThumbs);
        r.pictureRepeat = {matchedMedian, controlMedian,
            repeats: matchedMedian >= 0.95 && !(controlMedian >= 0.95)};
        const toDisplay = (q) => store.from + store.seq[q];
        r.precise = {period: P, n, tested, matched: matchedCount, rawMatched: rawMatched.reduce((s, x) => s + x, 0),
            runs: runs.map(([a, b]) => [toDisplay(a), toDisplay(b)]), m, tau, control, pairC, matchedFlags: matched,
            pairs: pairSource.length, controls: controlSource.length, floor,
            shift: results ? (() => { const s = new Float32Array(n).fill(NaN); pairSource.forEach((q, i) => { s[q] = results[4 * i + 3]; }); return s; })() : null};
        r.counts.tested = tested;
        r.counts.matched = matchedCount;
        r.timings.precise = now() - t0;
        this.notify(true);
    }

    // ---- long range

    async longRange() {
        const r = this.result, store = this.store;
        const t0 = now();
        const P = r.verdict.period;
        const n = store.n;
        const valid = this.validOfVerdict();
        const matchedList = [];
        for (let q = 0; q < n; q++) if (r.precise.matchedFlags[q]) matchedList.push(q);
        if (!matchedList.length) { r.longRange = null; return; }
        const anchors = [];
        const count = Math.min(8, matchedList.length);
        for (let i = 0; i < count; i++) anchors.push(matchedList[Math.floor((i + 0.5) * matchedList.length / count)]);
        const pairs = [], meta = [];
        for (const a of new Set(anchors)) {
            for (let k = 2; k <= 64; k++) {
                const j = a + k * P;
                if (j >= n) break;
                if (!valid[j]) continue;
                pairs.push(j, a);
                meta.push({a, j, k});
            }
        }
        this.setStage("longRange", meta.length);
        if (!meta.length) { r.longRange = null; r.timings.longRange = now() - t0; return; }
        const {scores} = await this.scorePairs(Int32Array.from(pairs), (k) => { r.progress.done += k; });
        let best = null;
        const tau = r.precise.tau;
        meta.forEach((entry, i) => {
            const c = scores[i];
            const threshold = Number.isFinite(tau[entry.a]) ? tau[entry.a] : tau[entry.j];
            if (Number.isFinite(c) && Number.isFinite(threshold) && c >= threshold) {
                const lag = store.seq[entry.j] - store.seq[entry.a];
                if (!best || lag > best.lag) best = {lag, k: entry.k, source: store.from + store.seq[entry.a], target: store.from + store.seq[entry.j], C: c, tau: threshold};
            }
        });
        r.longRange = best;
        r.timings.longRange = now() - t0;
        this.notify(true);
    }

    // ---- refine

    offsetDecodeTask(run, type, extra) {
        this.check();
        const part = this.chunkItems(run.decodeFrom, run.decodeTo), last = part.next >= run.decodeTo;
        return {message: {type, config: this.source.config, accel: "prefer-software", items: part.items,
            targets: Int32Array.from(run.targets), last, ...extra}, transfer: part.transfer,
        onStart: last ? null : (id, lane) => { this.sendRest(lane, id, run, part.next); }};
    }

    async offsetSearch() {
        const r = this.result, out = r.offset, store = this.store, started = now();
        // Keep the column result available even if this independent stage fails.
        try {
            const plan = planOffsetFrames(store.decoded, store.held, store.from);
            out.pictures = plan.pictures; out.sampled = plan.selected.length; out.pilot = plan.pilot;
            out.lumaStep = 4 * Math.max(1, Math.ceil(Math.max(store.width / 1280, store.height / 720)));
            const frames = new Map();
            this.displayMap();
            this.setStage("offsetDecode", plan.targets.length);
            const runs = planFrameDecodes(this.groupStarts, this.displayOf, this.chunkCount, plan.targets);
            await Promise.all(runs.map(run => this.scheduler.run({build: () => {
                return this.offsetDecodeTask(run, "offsetFrames", {step: out.lumaStep});
            }}).then(reply => {
                this.check();
                for (const frame of reply.frames) frames.set(frame.index, frame);
                r.progress.done += reply.frames.length; this.notify();
            })));
            const selected = plan.selected.filter(f => frames.has(f.frame) && frames.has(f.previous));
            out.missing = plan.selected.length - selected.length;
            out.sampled = selected.length;
            const pairs = offsetPairs(selected, this.options.longestLag, r.picture);
            out.pairs = pairs.length; out.proposals = 0; out.testedPairs = 0;
            this.setStage("offsetSearch", pairs.length * 3);
            const progress = [0, 0, 0], candidates = [];
            await Promise.all([0, 1, 2].map(plane => this.scheduler.run({build: () => {
                this.check();
                // Copies are bounded compact images, not native video frames.
                const samples = selected.map(s => ({index: s.index, frame: s.frame, current: frames.get(s.frame).planes[plane], previous: frames.get(s.previous).planes[plane]}));
                const transfer = [...new Set(samples.flatMap(s => [s.current.pixels.buffer, s.previous.pixels.buffer]))];
                return {message: {type: "offsetSearch", frames: samples, pairs}, transfer, onPartial: reply => {
                    this.check(); progress[plane] = reply.done; out.testedPairs = r.progress.done = progress.reduce((a, b) => a + b, 0); this.notify();
                }};
            }}).then(reply => {
                this.check(); out.proposals += reply.proposals;
                for (const c of reply.candidates) {
                    const a = selected[c.a], b = selected[c.b];
                    candidates.push({source: a.frame, target: b.frame, previousSource: a.previous, previousTarget: b.previous,
                        plane, x: c.x * c.scaleX, y: c.y * c.scaleY, tx: c.tx * c.scaleX, ty: c.ty * c.scaleY,
                        width: c.width * c.scaleX, height: c.height * c.scaleY, coarseScore: c.score, proposal: c.proposal, step: out.lumaStep});
                }
            })));
            frames.clear();
            this.setStage("offsetVerify", candidates.length);
            const requests = candidates.flatMap((c, i) => [
                {frame: c.source, x: c.x, y: c.y}, {frame: c.previousSource, x: c.x, y: c.y},
                {frame: c.target, x: c.tx, y: c.ty}, {frame: c.previousTarget, x: c.tx, y: c.ty},
            ].map((f, j) => ({...f, width: c.width, height: c.height, plane: c.plane, key: `${i}:${j}`})));
            const targets = [...new Set(requests.map(c => c.frame))].sort((a, b) => a - b), crops = new Map();
            const cropRuns = planFrameDecodes(this.groupStarts, this.displayOf, this.chunkCount, targets);
            await Promise.all(cropRuns.map(run => this.scheduler.run({build: () => {
                const wanted = new Set(run.targets);
                return this.offsetDecodeTask(run, "offsetCrops", {crops: requests.filter(c => wanted.has(c.frame))});
            }}).then(reply => { this.check(); for (const c of reply.crops) crops.set(c.key, c.image); })));
            // Small batches keep native refinements cancellable and spread across workers.
            const verified = [];
            await Promise.all(Array.from({length: Math.ceil(candidates.length / 4)}, (_, batch) => this.scheduler.run({build: () => {
                this.check();
                const items = candidates.slice(batch * 4, batch * 4 + 4).map((candidate, j) => ({candidate,
                    crops: [0, 1, 2, 3].map(k => crops.get(`${batch * 4 + j}:${k}`))}));
                out.missingCrops = (out.missingCrops ?? 0) + items.filter(item => item.crops.some(c => !c)).length;
                const transfer = items.flatMap(item => item.crops.filter(Boolean).map(c => c.pixels.buffer));
                for (let j = 0; j < items.length; j++) for (let k = 0; k < 4; k++) crops.delete(`${batch * 4 + j}:${k}`);
                return {message: {type: "offsetVerify", items}, transfer};
            }}).then(reply => { this.check(); verified.push(...reply.matches); r.progress.done = Math.min(candidates.length, r.progress.done + 4); this.notify(); })));
            verified.sort((a, b) => b.score - a.score);
            // Native work is already capped at 24 per plane. Preserve every
            // surviving plane/lag candidate rather than letting one channel's
            // high-scoring scene detail hide another channel's weaker texture.
            out.matches = verified;
            out.screeningVersion = 1;
            out.screened = verified.filter(m => m.screening?.passed).length;
            out.suppressed = verified.length - out.screened;
            out.candidates = candidates.length;
            out.status = "done";
        } catch (error) {
            if (this.cancelled) throw error;
            out.status = "error"; out.error = error?.message ?? String(error);
        }
        r.timings.offset = now() - started;
        this.notify(true);
    }

    async decodeFineFrames(displays, plane = this.result.verdict.plane ?? 1) {
        if (this.finePlane !== plane) { this.fineFrames.clear(); this.finePlane = plane; }
        const wanted = displays.filter(d => !this.fineFrames.has(d));
        if (wanted.length) {
            this.displayMap();
            const runs = planFrameDecodes(this.groupStarts, this.displayOf, this.chunkCount, wanted);
            await Promise.all(runs.map(run => this.scheduler.run({
                build: () => {
                    const part = this.chunkItems(run.decodeFrom, run.decodeTo, Infinity);
                    return {message: {type: "decodeFrames", config: this.source.config, accel: "prefer-software",
                        items: part.items, targets: Int32Array.from(run.targets), plane}, transfer: part.transfer};
                },
            }).then(reply => this.timed(() => {
                for (const frame of reply.frames) this.fineFrames.set(frame.index, frame);
            }))));
            while (this.fineFrames.size > MAX_FINE_FRAMES) {
                const oldest = this.fineFrames.keys().next().value;
                if (displays.includes(oldest)) break;
                this.fineFrames.delete(oldest);
            }
        }
        return displays.map(d => this.fineFrames.get(d) ?? null);
    }

    async denseMap(sourceFrame, targetFrame) {
        const reply = await this.scheduler.run({build: () => ({message: {type: "dense",
            target: {q: targetFrame.q, columns: targetFrame.columns}, source: {q: sourceFrame.q, columns: sourceFrame.columns},
            colWidth: targetFrame.colWidth}})});
        return reply.map;
    }

    async refine() {
        const r = this.result, store = this.store;
        const t0 = now();
        const P = r.verdict.period;
        const matched = r.precise.matchedFlags;
        const candidates = [];
        for (let q = 0; q + P < store.n; q++) {
            const c = r.precise.pairC[q];
            if (matched[q] && matched[q + P] && Number.isFinite(c) && c >= r.precise.tau[q]) candidates.push({q, c});
        }
        candidates.sort((a, b) => b.c - a.c);
        const chosen = [];
        for (const cand of candidates) {
            if (chosen.length >= MAX_REFINE_PAIRS) break;
            if (chosen.every(other => Math.abs(other.q - cand.q) >= P)) chosen.push(cand);
        }
        this.setStage("refine", chosen.length * 2 + 1);
        if (!chosen.length) { r.refine = {pairs: [], lattice: null, rule: null}; r.timings.refine = now() - t0; return; }
        const toDisplay = (q) => store.from + store.seq[q];
        const displays = [...new Set(chosen.flatMap(c => [toDisplay(c.q), toDisplay(c.q + P)]))];
        await this.decodeFineFrames(displays);
        r.progress.done += chosen.length;
        const pairs = chosen.map(c => ({source: toDisplay(c.q), target: toDisplay(c.q + P), q: c.q, C: c.c,
            lag: toDisplay(c.q + P) - toDisplay(c.q), tau: r.precise.tau[c.q]}));
        const maps = await Promise.all(pairs.map(async (pair) => {
            const [s, t] = [this.fineFrames.get(pair.source), this.fineFrames.get(pair.target)];
            if (!s || !t) return null;
            const map = await this.denseMap(s, t);
            r.progress.done++;
            return map;
        }));
        const fit = await this.scheduler.run({build: () => ({message: {type: "fit", maps, frameWidth: store.width}})});
        const lattice = fit.lattice, rule = fit.rule;
        pairs.forEach((pair, i) => {
            pair.map = maps[i];
            pair.fit = rule?.pairs?.[maps.slice(0, i + 1).filter(Boolean).length - 1] ?? null;
            if (!maps[i]) pair.fit = null;
        });
        r.refine = {pairs, lattice, rule, ms: fit.ms};
        r.timings.refine = now() - t0;
        // default selection: the refined pair with the highest score
        const best = pairs.find(p => p.map) ?? pairs[0];
        if (best && !this.hooks.keepSelection) await this.selectPair(best.source, best.target);
        this.notify(true);
    }

    // ---- one pair, on request (the pair viewer and the debug hook)

    // Workers stop when the window is hidden; a later request for a pair starts them again.
    ensureLanes() {
        if (this.hooks.lanes || !this.lanes?.some(lane => lane.dead)) return;
        this.lanes = cpuLanes(workerLaneCount());
        this.scheduler = new Scheduler(this.lanes, ms => this.slice(ms));
        if (this.gpu?.lane?.dead) { this.gpu = null; this.gpuChecked = undefined; }
    }

    // The reference pair at one lag with the highest score on a curve: {source, target, C}.
    bestPairAtLag(curve, lag) {
        const r = this.result, store = this.store;
        const lmax = r.lags?.lmax;
        const name = curve ?? r.verdict?.curve ?? "S-Cb";
        const rows = r.curves[name]?.rows, refs = r.lags?.refs?.[name];
        if (!store?.seq || !rows || !refs || !(lag >= 1 && lag <= lmax)) return null;
        const valid = name.startsWith("S-") ? store.valid[this.planeOfCurve(name)] : store.validAny;
        let best = null;
        refs.forEach((ref, a) => {
            const c = rows[a * lmax + lag - 1];
            if (!Number.isFinite(c) || (best && c <= best.C)) return;
            const pair = lagPair(ref, lag, store.n, valid);
            if (pair) best = {target: store.from + store.seq[pair[0]], source: store.from + store.seq[pair[1]], C: c};
        });
        return best;
    }

    // The precise pair that a frame takes part in, with the higher score.
    pairForDisplay(display) {
        const r = this.result, store = this.store, P = r.precise?.period;
        if (!P || !store?.qOfRow) return null;
        const q = store.qOfRow[display - store.from];
        if (!(q >= 0)) return null;
        const options = [];
        if (Number.isFinite(r.precise.pairC[q])) options.push({q, c: r.precise.pairC[q]});
        if (q - P >= 0 && Number.isFinite(r.precise.pairC[q - P])) options.push({q: q - P, c: r.precise.pairC[q - P]});
        if (!options.length) return null;
        options.sort((a, b) => b.c - a.c);
        const {q: s, c} = options[0];
        return {source: store.from + store.seq[s], target: store.from + store.seq[s + P], C: c};
    }

    // The next (direction 1) or previous (-1) matched precise pair after a source frame.
    neighborPair(display, direction) {
        const r = this.result, store = this.store, P = r.precise?.period;
        if (!P || !store?.qOfRow) return null;
        let q = store.qOfRow[display - store.from];
        if (!(q >= 0)) q = direction > 0 ? -1 : store.n;
        for (let k = q + direction; k >= 0 && k + P < store.n; k += direction) {
            if (r.precise.matchedFlags[k] && Number.isFinite(r.precise.pairC[k])) {
                return {source: store.from + store.seq[k], target: store.from + store.seq[k + P], C: r.precise.pairC[k]};
            }
        }
        return null;
    }

    async analyzePair(sourceDisplay, targetDisplay) {
        const r = this.result, store = this.store;
        if (!store?.strips || !r.verdict) throw new Error("Run the analysis first");
        this.ensureLanes();
        sourceDisplay = Math.round(sourceDisplay);
        targetDisplay = Math.round(targetDisplay);
        const plane = r.verdict.plane ?? 1;
        const strip = r.verdict.strip ?? true;
        const qs = store.qOfRow[sourceDisplay - store.from] ?? -1, qt = store.qOfRow[targetDisplay - store.from] ?? -1;
        let C = NaN, Q = NaN, nValid = 0, shift = NaN;
        if (qs >= 0 && qt >= 0) {
            if (strip) {
                const results = await this.searchCPU(plane, Int32Array.from([qt, qs]), this.options.vertical);
                Q = results[0]; C = results[1]; nValid = results[2]; shift = results[3];
            } else {
                const aligned = await this.alignedPairs(Int32Array.from([qt, qs]));
                C = aligned[r.verdict.curve === "A-Yfine" ? 0 : 1];
            }
        }
        const tau = qs >= 0 ? r.precise?.tau?.[qs] ?? NaN : NaN;
        const [sourceFrame, targetFrame] = await this.decodeFineFrames([sourceDisplay, targetDisplay], plane);
        let map = null;
        if (sourceFrame && targetFrame) map = await this.denseMap(sourceFrame, targetFrame);
        const lattice = r.refine?.lattice?.accepted ? r.refine.lattice : null;
        const rule = r.refine?.rule;
        // the strip numbering of the whole run (w, origin, k0), so d is comparable across pairs
        const w = rule?.w ?? lattice?.w, o = rule?.origin ?? lattice?.origin, k0 = rule?.k0 ?? 0;
        const fit = map ? pairRuleFit(map, {w: lattice ? w : NaN, o, k0}) : {xor: null, translation: null};
        let confident = 0, inStrip = 0, wholeStrip = 0;
        if (map) {
            for (let t = 0; t < map.count; t++) {
                if (!map.confident[t]) continue;
                confident++;
                if (w > 0) {
                    const phase = (((map.x[t] - o) % w) + w) % w;
                    if (Math.abs(phase - w / 2) <= w / 2 - 6) {
                        inStrip++;
                        const k = Math.round(map.dl[t] / w);
                        if (Math.abs(map.dl[t] - k * w) <= 3) wholeStrip++;
                    }
                }
            }
        }
        return {
            source: sourceDisplay, target: targetDisplay, lag: targetDisplay - sourceDisplay, plane,
            curve: r.verdict.curve, C, Q, nValid, shift, tau, matched: Number.isFinite(C) && Number.isFinite(tau) && C >= tau,
            map, lattice: lattice ?? null, w, origin: o, k0,
            xor: fit.xor, translation: fit.translation,
            probes: {confident, inStrip, wholeStrip, wholeStripFraction: inStrip ? wholeStrip / inStrip : NaN},
            assignment: map && w > 0 ? assignmentMap(map, w, o, k0, 0) : [],
            segments: map ? offsetSegments(map) : [],
            images: {source: sourceFrame?.image ?? null, target: targetFrame?.image ?? null},
            frameWidth: store.width, frameHeight: store.height,
        };
    }

    async selectPair(sourceDisplay, targetDisplay) {
        const pair = await this.analyzePair(sourceDisplay, targetDisplay);
        if (this.cancelled) return pair;
        this.result.selection = pair;
        this.notify(true);
        return pair;
    }

    // ---- benchmark: ingest on the CPU workers, then the coarse and precise searches on both

    async benchmark() {
        const r = this.result, store = this.store;
        if (!store?.strips || this.cancelled) throw new Error("Run the analysis first");
        this.ensureLanes();
        const rows = [];
        // ingest, CPU workers only (features are decoded again and discarded)
        const t0 = now();
        const ingestRun = await this.benchmarkIngest();
        rows.push({stage: "ingest", backend: "cpu", ms: ingestRun.ms, rate: ingestRun.fps, unit: "frames/s", frames: ingestRun.frames});
        rows.push({stage: "ingest", backend: "gpu", ms: NaN, rate: NaN, unit: "frames/s", note: "no GPU decode lane"});
        // coarse + precise pairs of the Cb plane (or the verdict plane)
        const plane = r.verdict.strip ? r.verdict.plane : 1;
        const pairs = this.benchmarkPairs(plane);
        const tc = now();
        const cpu = await this.searchCPU(plane, pairs, 0);
        const cpuMs = now() - tc;
        rows.push({stage: "search", backend: "cpu", ms: cpuMs, rate: pairs.length / 2 / (cpuMs / 1000), unit: "pairs/s", pairs: pairs.length / 2});
        let gpuRow = {stage: "search", backend: "gpu", ms: NaN, rate: NaN, unit: "pairs/s", pairs: pairs.length / 2};
        if (await this.gpuReady()) {
            try {
                await this.searchGPU(plane, pairs.slice(0, 256));
                const tg = now();
                const gpu = await this.searchGPU(plane, pairs);
                const gpuMs = now() - tg;
                let maxDelta = 0;
                for (let i = 0; i < pairs.length / 2; i++) {
                    const a = cpu[4 * i + 1], b = gpu[4 * i + 1];
                    if (Number.isFinite(a) && Number.isFinite(b)) maxDelta = Math.max(maxDelta, Math.abs(a - b));
                }
                gpuRow = {...gpuRow, ms: gpuMs, rate: pairs.length / 2 / (gpuMs / 1000), maxDeltaC: maxDelta};
            } catch (error) {
                gpuRow.note = error.message;
            }
        } else gpuRow.note = r.backend.reason;
        rows.push(gpuRow);
        r.benchmark = {rows, ms: now() - t0, visibility: visibility()};
        this.notify(true);
        return r.benchmark;
    }

    benchmarkPairs(plane) {
        const r = this.result, store = this.store;
        const pairs = [];
        const lmax = r.lags?.lmax ?? 0;
        const refs = r.lags?.refs?.[STRIP_CURVES[plane]] ?? [];
        for (const ref of refs) for (let L = 1; L <= lmax; L++) {
            const pair = lagPair(ref, L, store.n, store.valid[plane]);
            if (pair) pairs.push(pair[0], pair[1]);
        }
        const P = r.verdict.period;
        if (P) for (let q = 0; q + P < store.n; q++) if (store.valid[plane][q] && store.valid[plane][q + P]) pairs.push(q + P, q);
        return Int32Array.from(pairs);
    }

    async benchmarkIngest() {
        this.displayMap();
        const t0 = now();
        const segments = planSegments(this.groupStarts, this.displayOf, this.chunkCount, this.range, 2 * this.lanes.length);
        const decodeLanes = this.lanes.slice(0, Math.min(DECODE_CONCURRENCY, this.lanes.length));
        const scheduler = new Scheduler(decodeLanes, ms => this.slice(ms));
        let frames = 0;
        await Promise.all(segments.map((segment, i) => this.decodeSegmentWithRetry(scheduler, segments, i, (decodeFrom) => {
            const part = this.chunkItems(decodeFrom, segment.decodeTo, Infinity);
            return {message: {type: "decode", config: this.source.config, accel: "prefer-software", items: part.items,
                keepFrom: segment.keepFrom, keepTo: segment.keepTo, detail: this.options.detail, batchSize: 32, last: true},
            transfer: part.transfer, onPartial: (data) => { frames += data.count; }};
        })));
        const ms = now() - t0;
        return {ms, frames, fps: frames / Math.max(1e-3, ms / 1000)};
    }
}
