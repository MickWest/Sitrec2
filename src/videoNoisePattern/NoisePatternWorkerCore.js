// NoisePatternWorkerCore - the message handlers of the Noise Pattern Detection workers.
//
// Pure: it has no Worker or VideoDecoder code of its own. src/workers/NoisePatternWorker.js
// wraps it with a WebCodecs decoder; the Jest tests wrap it with a synthetic frame source
// and run it on the test thread. Both run exactly this code, so the tests cover what the
// browser runs.
//
// Every request carries an id. A reply carries the same id; "features" replies are partial
// (more follow), every other reply ends the request. A failure replies
// {type: "error", id, message}.

import {
    ALIGNED_CURVES, BAND_STRIDE, LIVE_FRACTION, Q_SCALE, SIG_COUNT, THUMB_SIZE,
    alignedScore, analyzeCurves, createFeatureContext, createMatchScratch, denseMatch,
    extractFrameFeatures, fineProfile, fitRule, heldScores, latticeFold, boundariesOf, matchPair,
    preciseThresholds, residualImage, temporalHighPass, temporalHighPassSignatures,
} from "./NoisePatternMath";

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

// decoder: {decodeSegment(message, onFrame, more) -> Promise<{decoded, failed, mode, bits, accel}>,
//           decodeFrames(message, onFrame) -> Promise<{decoded, failed}>}
// onFrame({index, data, descriptors, mode, bits}) is called for each decoded frame.
export function createNoisePatternCore({post, decoder}) {
    let ctx = null;
    const scratchByColumns = new Map();
    const continuations = new Map();     // decode id -> {items: [], last, wake}

    const scratchFor = (columns) => {
        let s = scratchByColumns.get(columns);
        if (!s) { s = createMatchScratch(columns); scratchByColumns.set(columns, s); }
        return s;
    };

    function newBatch(size, columns) {
        const rowSize = columns * BAND_STRIDE;
        return {
            count: 0, size, columns,
            indices: new Int32Array(size),
            strips: [0, 1, 2].map(() => new Int8Array(size * rowSize)),
            live: [0, 1, 2].map(() => new Uint8Array(size * columns)),
            liveFraction: new Float32Array(size * 3),
            sigY: new Int8Array(size * SIG_COUNT), sigCb: new Int8Array(size * SIG_COUNT),
            thumbs: new Float32Array(size * THUMB_SIZE),
            sigSumY: new Float64Array(SIG_COUNT), sigSumCb: new Float64Array(SIG_COUNT),
        };
    }

    async function decode(message) {
        const started = now();
        const {id, keepFrom, keepTo, detail = 8, batchSize = 32} = message;
        let batch = null, featureMs = 0, frameMode = null, frameBits = 8, size = null;
        const flush = () => {
            if (!batch || !batch.count) return;
            const b = batch;
            batch = null;
            const transfer = [b.indices.buffer, ...b.strips.map(a => a.buffer), ...b.live.map(a => a.buffer),
                b.liveFraction.buffer, b.sigY.buffer, b.sigCb.buffer, b.thumbs.buffer, b.sigSumY.buffer, b.sigSumCb.buffer];
            post({type: "features", partial: true, id, count: b.count, columns: b.columns, width: size.width, height: size.height,
                colWidth: ctx.colWidth, indices: b.indices, strips: b.strips, live: b.live, liveFraction: b.liveFraction,
                sigY: b.sigY, sigCb: b.sigCb, thumbs: b.thumbs, sigSumY: b.sigSumY, sigSumCb: b.sigSumCb,
                mode: frameMode, bits: frameBits}, transfer);
        };
        const onFrame = (frame) => {
            if (frame.index < keepFrom || frame.index >= keepTo) return;
            const t0 = now();
            const width = frame.descriptors.planes[0].width, height = frame.descriptors.planes[0].height;
            if (!size) size = {width, height};
            else if (size.width !== width || size.height !== height) throw new Error("The frame size changed during analysis");
            if (!ctx || ctx.width !== width || ctx.height !== height || ctx.detail !== detail) ctx = createFeatureContext(width, height, detail);
            if (!batch) batch = newBatch(batchSize, ctx.columns);
            const i = batch.count++;
            const rowSize = ctx.columns * BAND_STRIDE;
            const out = {
                strips: batch.strips.map(a => a.subarray(i * rowSize, (i + 1) * rowSize)),
                live: batch.live.map(a => a.subarray(i * ctx.columns, (i + 1) * ctx.columns)),
                sigY: batch.sigY.subarray(i * SIG_COUNT, (i + 1) * SIG_COUNT),
                sigCb: batch.sigCb.subarray(i * SIG_COUNT, (i + 1) * SIG_COUNT),
                thumb: batch.thumbs.subarray(i * THUMB_SIZE, (i + 1) * THUMB_SIZE),
            };
            const liveFraction = extractFrameFeatures(frame, ctx, out);
            batch.indices[i] = frame.index;
            for (let p = 0; p < 3; p++) batch.liveFraction[i * 3 + p] = liveFraction[p];
            for (let k = 0; k < SIG_COUNT; k++) {
                batch.sigSumY[k] += out.sigY[k] / Q_SCALE;
                batch.sigSumCb[k] += out.sigCb[k] / Q_SCALE;
            }
            frameMode = frame.mode; frameBits = frame.bits;
            featureMs += now() - t0;
            if (batch.count === batch.size) flush();
        };
        // more chunks of a large segment arrive as "decodeChunks" messages
        const state = {items: [], last: message.last !== false, wake: null};
        continuations.set(id, state);
        const more = async () => {
            while (!state.items.length && !state.last) await new Promise(resolve => { state.wake = resolve; });
            const items = state.items;
            state.items = [];
            return {items, last: state.last};
        };
        let stats;
        try {
            stats = await decoder.decodeSegment(message, onFrame, more);
        } finally {
            continuations.delete(id);
        }
        flush();
        post({type: "segmentDone", id, decoded: stats.decoded, failed: stats.failed, accel: stats.accel,
            mode: frameMode, bits: frameBits, ms: now() - started, featureMs, decodeMs: stats.decodeMs});
    }

    function held({id, sigs, decoded, meanSig, rows}) {
        const scores = heldScores(sigs, decoded, meanSig, rows);
        post({type: "held", id, scores}, [scores.buffer]);
    }

    function prep(message) {
        const {id, rows, lo, hi, columns, raw, live, valid, validAny, sigY, sigCb} = message;
        const t0 = now();
        const count = hi - lo;
        const rowSize = columns * BAND_STRIDE;
        const strips = [], energies = [];
        for (let p = 0; p < 3; p++) {
            const out = new Int8Array(count * rowSize), e = new Float32Array(count * columns);
            temporalHighPass(raw[p], live[p], valid[p], rows, columns, lo, hi, out, e);
            strips.push(out); energies.push(e);
        }
        const sigs = [], norms = [];
        for (const s of [sigY, sigCb]) {
            const out = new Int8Array(count * SIG_COUNT), n = new Float32Array(count);
            temporalHighPassSignatures(s, validAny, rows, lo, hi, out, n);
            sigs.push(out); norms.push(n);
        }
        post({type: "prepped", id, strips, energies, sigs, norms, ms: now() - t0},
            [...strips.map(a => a.buffer), ...energies.map(a => a.buffer), ...sigs.map(a => a.buffer), ...norms.map(a => a.buffer)]);
    }

    // pairs: Int32Array [target, source, ...] as row numbers of the strips sent
    function search({id, columns, colWidth, V = 0, strips, energies, pairs}) {
        const t0 = now();
        const rowSize = columns * BAND_STRIDE;
        const scratch = scratchFor(columns);
        const n = pairs.length / 2;
        const results = new Float32Array(n * 4);
        for (let i = 0; i < n; i++) {
            const t = pairs[2 * i], s = pairs[2 * i + 1];
            matchPair(strips.subarray(t * rowSize, (t + 1) * rowSize), strips.subarray(s * rowSize, (s + 1) * rowSize),
                energies.subarray(t * columns, (t + 1) * columns), energies.subarray(s * columns, (s + 1) * columns),
                columns, colWidth, V, scratch, results, 4 * i);
        }
        post({type: "searchResult", id, results, ms: now() - t0}, [results.buffer]);
    }

    function aligned({id, sigs, norms, pairs}) {
        const n = pairs.length / 2;
        const results = new Float32Array(n * sigs.length);
        for (let i = 0; i < n; i++) {
            const t = pairs[2 * i], s = pairs[2 * i + 1];
            for (let k = 0; k < sigs.length; k++) {
                results[i * sigs.length + k] = alignedScore(sigs[k], t * SIG_COUNT, norms[k][t], sigs[k], s * SIG_COUNT, norms[k][s]);
            }
        }
        post({type: "alignedResult", id, results}, [results.buffer]);
    }

    function analyze({id, curves, R, lmax, lagMin}) {
        const analysis = analyzeCurves(curves, R, lmax, lagMin);
        const out = {};
        for (const [name, c] of Object.entries(analysis.curves)) {
            out[name] = {values: Float32Array.from(c.values), z: Float32Array.from(c.z), period: c.period, strength: c.strength,
                coverage: c.coverage, significant: c.significant, multiples: c.multiples, peaks: c.peaks};
        }
        post({type: "analysis", id, curves: out, verdictCurve: analysis.verdictCurve});
    }

    function thresholds({id, controls, n, floor}) {
        const tau = preciseThresholds(controls, n, floor);
        post({type: "thresholds", id, tau}, [tau.buffer]);
    }

    async function decodeFrames(message) {
        const {id, targets, plane} = message;
        const wanted = new Set(targets);
        const frames = [];
        const stats = await decoder.decodeFrames(message, (frame) => {
            if (!wanted.has(frame.index)) return;
            wanted.delete(frame.index);
            const fine = fineProfile(frame, plane);
            const image = residualImage(frame, plane);
            frames.push({index: frame.index, q: fine.q, live: fine.live, columns: fine.columns, colWidth: fine.colWidth,
                width: frame.descriptors.planes[0].width, height: frame.descriptors.planes[0].height, image});
        });
        post({type: "frames", id, frames, decoded: stats.decoded, failed: stats.failed},
            frames.flatMap(f => [f.q.buffer, f.live.buffer, f.image.pixels.buffer]));
    }

    function dense({id, target, source, colWidth}) {
        const map = denseMatch(target.q, source.q, Math.min(target.columns, source.columns), colWidth);
        post({type: "dense", id, map});
    }

    function fit({id, maps, frameWidth, lattice: given}) {
        const t0 = now();
        const lattice = given ?? latticeFold(boundariesOf(maps));
        const rule = fitRule(maps, lattice, {frameWidth});
        post({type: "fit", id, lattice, rule, ms: now() - t0});
    }

    async function handle(message) {
        try {
            switch (message.type) {
                case "decode": return await decode(message);
                case "decodeChunks": {
                    const state = continuations.get(message.id);
                    if (state) {
                        state.items.push(...message.items);
                        if (message.last) state.last = true;
                        state.wake?.();
                        state.wake = null;
                    }
                    return;
                }
                case "held": return held(message);
                case "prep": return prep(message);
                case "search": return search(message);
                case "aligned": return aligned(message);
                case "analyze": return analyze(message);
                case "thresholds": return thresholds(message);
                case "decodeFrames": return await decodeFrames(message);
                case "dense": return dense(message);
                case "fit": return fit(message);
                case "ping": return post({type: "pong", id: message.id});
                default: throw new Error(`Unknown message ${message.type}`);
            }
        } catch (error) {
            post({type: "error", id: message.id, message: error?.message ?? String(error)});
        }
    }

    return {handle};
}

// Planes are "live" (usable) when at least 20% of their columns are not flat.
export function planeIsLive(fraction) {
    return fraction >= LIVE_FRACTION;
}

export {ALIGNED_CURVES};
