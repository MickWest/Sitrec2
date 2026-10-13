// The Noise Pattern Detection coordinator on synthetic videos, with in-thread lanes that
// run the same worker core as the browser (only the decoder is replaced by the generator).

import {createLane, localPort, startNoisePatternJob} from "../src/videoNoisePattern/NoisePatternJob";
import {createNoisePatternCore} from "../src/videoNoisePattern/NoisePatternWorkerCore";
import {CURVES, LAG_MIN, createMatchScratch, matchPair} from "../src/videoNoisePattern/NoisePatternMath";
import {createFakeVideoData, createSyntheticVideo} from "./noisePatternSynthetic";

jest.setTimeout(180000);

const videos = new Map();
function video(name, spec) {
    if (!videos.has(name)) {
        const v = createSyntheticVideo(spec);
        const frames = new Map();
        const cached = {...v, frame: (i) => { if (!frames.has(i)) frames.set(i, v.frame(i)); return frames.get(i); }};
        videos.set(name, cached);
    }
    return videos.get(name);
}

const XOR = () => video("xor", {layer: {kind: "xor"}});

function syntheticDecoder(v, stats) {
    return {
        async decodeSegment(message, onFrame, more) {
            stats.segments++;
            const items = [...message.items];
            let last = message.last !== false;
            while (!last) { const next = await more(); items.push(...next.items); last = next.last; }
            let decoded = 0;
            for (const item of items) {
                if (item.index < message.keepFrom || item.index >= message.keepTo) continue;
                onFrame({index: item.index, ...v.frame(item.index), mode: "native", bits: 8});
                decoded++;
            }
            stats.frames += decoded;
            return {decoded, failed: 0, accel: "synthetic"};
        },
        async decodeFrames(message, onFrame) {
            let decoded = 0;
            for (const item of message.items) {
                if (!message.targets.includes(item.index)) continue;
                onFrame({index: item.index, ...v.frame(item.index), mode: "native", bits: 8});
                decoded++;
            }
            return {decoded, failed: 0};
        },
    };
}

// A port that holds back the replies of some message types, to make a lane slower.
function delayedPort(port, delays) {
    let handler = null;
    port.onMessage((data) => {
        const wait = delays[data.type] ?? 0;
        if (wait) setTimeout(() => handler?.(data), wait); else handler?.(data);
    });
    return {...port, onMessage: (fn) => { handler = fn; }};
}

function lanesFor(v, count, stats = {segments: 0, frames: 0}, delays = null) {
    return () => Array.from({length: count}, () => {
        let port = localPort(post => createNoisePatternCore({post, decoder: syntheticDecoder(v, stats)}));
        if (delays) port = delayedPort(port, delays);
        return createLane("cpu", port);
    });
}

// A GPU lane that answers with the CPU arithmetic: optionally slow, or failing.
function fakeGpu({delay = 0, fail = false} = {}) {
    const planes = new Map();
    const scratch = new Map();
    let handler = null;
    const lane = createLane("gpu", {
        post(message) {
            setTimeout(() => {
                const reply = (data) => setTimeout(() => handler?.({...data, id: message.id}), delay);
                if (fail && message.type === "search") return reply({type: "error", message: "simulated GPU failure"});
                if (message.type === "gpuInit") return reply({type: "gpuReady", info: {vendor: "test", architecture: "fake", packedDot: true}});
                if (message.type === "upload") {
                    let entry = planes.get(message.plane);
                    if (!entry || entry.rows !== message.rows) {
                        entry = {rows: message.rows, columns: message.columns,
                            strips: new Int8Array(message.rows * message.columns * 48), energies: new Float32Array(message.rows * message.columns)};
                        planes.set(message.plane, entry);
                    }
                    entry.strips.set(message.strips, message.offsetRow * message.columns * 48);
                    entry.energies.set(message.energies, message.offsetRow * message.columns);
                    return reply({type: "uploaded"});
                }
                if (message.type === "search") {
                    const entry = planes.get(message.plane);
                    const {columns} = entry, rowSize = columns * 48;
                    if (!scratch.has(columns)) scratch.set(columns, createMatchScratch(columns));
                    const n = message.pairs.length / 2;
                    const results = new Float32Array(n * 4);
                    for (let i = 0; i < n; i++) {
                        const t = message.pairs[2 * i], s = message.pairs[2 * i + 1];
                        matchPair(entry.strips.subarray(t * rowSize, (t + 1) * rowSize), entry.strips.subarray(s * rowSize, (s + 1) * rowSize),
                            entry.energies.subarray(t * columns, (t + 1) * columns), entry.energies.subarray(s * columns, (s + 1) * columns),
                            columns, message.colWidth, 0, scratch.get(columns), results, 4 * i);
                    }
                    return reply({type: "searchResult", results});
                }
                return reply({type: "error", message: "unknown"});
            }, 0);
        },
        onMessage(fn) { handler = fn; },
        onError() {},
        terminate() {},
    });
    return () => ({lane, ready: lane.request({type: "gpuInit"}).then(r => r.info), uploaded: null});
}

async function run(v, options = {}, hooks = {}) {
    const job = startNoisePatternJob(createFakeVideoData(v), {offsetSearch: false, references: 8, searchOn: "cpu", ...options},
        {lanes: lanesFor(v, 4), cache: false, ...hooks});
    return job.promise;
}

function maxZ(r, curve) {
    let best = -Infinity;
    const z = r.curves[curve]?.z ?? [];
    for (let L = LAG_MIN; L <= r.lags.lmax; L++) if (Number.isFinite(z[L - 1])) best = Math.max(best, z[L - 1]);
    return best;
}

function medianShiftAt(r, curve, L) {
    const values = [];
    for (let a = 0; a < r.lags.R; a++) {
        const v = r.curves[curve].shift[a * r.lags.lmax + L - 1];
        if (Number.isFinite(v)) values.push(v);
    }
    values.sort((x, y) => x - y);
    return values[values.length >> 1];
}

describe("an XOR-permuted 32-frame noise loop in Cb", () => {
    let r;
    beforeAll(async () => { r = await run(XOR()); });

    test("is found every 32 frames on the Cb strip curve", () => {
        expect(r.status).toBe("done");
        expect(r.verdict.kind).toBe("repeat");
        expect(r.verdict.curve).toBe("S-Cb");
        expect(r.verdict.period).toBe(32);
        const z = r.curves["S-Cb"].z;
        for (const L of [32, 64, 96]) expect(z[L - 1]).toBeGreaterThanOrEqual(8);
        expect(r.verdict.strength).toBeGreaterThanOrEqual(8);
        expect(r.verdict.coverage).toBeGreaterThanOrEqual(6);
        for (let L = LAG_MIN; L <= r.lags.lmax; L++) if (L % 32) expect(z[L - 1]).toBeLessThan(6);
        expect(r.curves["S-Y"].period).toBeNull();
    });

    test("matches at least 90% of the frames", () => {
        expect(r.precise.matched / r.precise.tested).toBeGreaterThanOrEqual(0.9);
    });

    test("maps 16-px strips and the XOR value of each block pair", () => {
        expect(r.refine.lattice.accepted).toBe(true);
        expect(Math.abs(r.refine.rule.w - 16)).toBeLessThanOrEqual(0.3);
        expect(r.refine.rule.kind).toBe("xor");
        const pairs = r.refine.pairs.filter(p => p.fit?.xor);
        const right = pairs.filter(p => p.fit.xor.d === ((Math.floor(p.source / 32) & 31) ^ (Math.floor(p.target / 32) & 31)));
        expect(right.length / r.refine.pairs.length).toBeGreaterThanOrEqual(0.8);
    });

    test("gives the same result with 1 lane and with 4 lanes", async () => {
        const one = await run(XOR(), {}, {lanes: lanesFor(XOR(), 1)});
        for (const name of CURVES) {
            expect(Array.from(one.curves[name].rows)).toEqual(Array.from(r.curves[name].rows));
            expect(Array.from(one.curves[name].z)).toEqual(Array.from(r.curves[name].z));
        }
        expect(Array.from(one.byDisplay.matched)).toEqual(Array.from(r.byDisplay.matched));
        expect(one.refine.rule.w).toBe(r.refine.rule.w);
    });
});

test("a translated loop is found, with its shift", async () => {
    const r = await run(video("translate", {layer: {kind: "translate", shiftX: 24}}));
    expect(r.verdict.period).toBe(32);
    for (const L of [32, 64, 96]) expect(Math.abs(medianShiftAt(r, "S-Cb", L) - 24 * L / 32)).toBeLessThanOrEqual(8);
    expect(r.refine.rule.kind).toBe("translation");
    for (const pair of r.refine.pairs) {
        expect(Math.abs(pair.fit.translation.shift - 24 * pair.lag / 32)).toBeLessThanOrEqual(2);
    }
});

test("a layer that moves down is found only with the vertical search", async () => {
    const v = video("vertical", {height: 360, layer: {kind: "vertical", shiftY: 8}});
    const off = await run(v);
    const strength = Math.max(0, ...CURVES.map(name => off.curves[name].period ? off.curves[name].strength : 0));
    expect(off.verdict.kind === "repeat" ? strength : 0).toBeLessThan(6);
    const on = await run(v, {vertical: 3});
    expect(on.verdict.kind).toBe("repeat");
    expect(on.verdict.period).toBe(32);
});

describe.each([
    ["fresh noise", {}],
    ["codec-like noise", {codecLike: true}],
])("%s", (name, spec) => {
    test("has no repeat", async () => {
        const r = await run(video(name, spec));
        expect(r.verdict.kind).toBe("none");
        for (const curve of CURVES) expect(maxZ(r, curve)).toBeLessThan(6);
    });
});

test("held frames: three frames per picture, counted as pictures", async () => {
    const v = video("held", {frames: 480, framesPerPicture: 3, layer: {kind: "still", clip: 8}});
    const r = await run(v, {held: "picture"});
    expect(r.counts.held).toBe(320);
    expect(r.verdict.kind).toBe("repeat");
    expect(r.verdict.period).toBe(8);
    expect(r.picture).toBe(true);
});

test("looped footage is reported as a repeated picture", async () => {
    const r = await run(video("loop", {frames: 480, pictureLoop: 50}));
    expect(r.verdict.period).toBe(50);
    expect(r.pictureRepeat.repeats).toBe(true);
});

test("stop ends the run with no later updates", async () => {
    let updates = 0, afterStop = 0, stopped = false;
    const job = startNoisePatternJob(createFakeVideoData(XOR()), {offsetSearch: false, references: 8, searchOn: "cpu"}, {
        lanes: lanesFor(XOR(), 4), cache: false,
        onUpdate: (r) => { updates++; if (stopped) afterStop++; if (r.stage === "coarse" && !stopped) { stopped = true; job.cancel(); } },
    });
    const r = await job.promise;
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(r.status).toBe("stopped");
    expect(afterStop).toBe(1);   // the "stopped" update itself
    expect(updates).toBeGreaterThan(1);
});

describe("search backends", () => {
    test("Fastest uses the GPU when it is faster, and the results agree", async () => {
        const r = await run(XOR(), {searchOn: "fastest"}, {lanes: lanesFor(XOR(), 4, undefined, {searchResult: 100}), gpu: fakeGpu()});
        expect(r.backend.search).toBe("gpu");
        expect(r.backend.calibration.gpuPairsPerSec).toBeGreaterThan(r.backend.calibration.cpuPairsPerSec);
        expect(r.backend.calibration.maxDeltaC).toBe(0);
        expect(r.verdict.period).toBe(32);
    });

    test("Fastest uses the CPU workers when the GPU is slower", async () => {
        const r = await run(XOR(), {searchOn: "fastest"}, {gpu: fakeGpu({delay: 400})});
        expect(r.backend.search).toBe("cpu");
        expect(r.verdict.period).toBe(32);
    });

    test("a GPU failure falls back to the CPU workers and says so", async () => {
        const r = await run(XOR(), {searchOn: "gpu"}, {gpu: fakeGpu({fail: true})});
        expect(r.status).toBe("done");
        expect(r.backend.search).toBe("cpu");
        expect(r.backend.reason).toMatch(/GPU failed/);
        expect(r.verdict.period).toBe(32);
    });
});

test("a second run with another Longest lag reuses the decoded features", async () => {
    const v = XOR();
    const data = createFakeVideoData(v);
    const stats = {segments: 0, frames: 0};
    const first = await startNoisePatternJob(data, {offsetSearch: false, references: 8, searchOn: "cpu"}, {lanes: lanesFor(v, 4, stats)}).promise;
    expect(first.cached).toBe(false);
    expect(stats.frames).toBe(v.frames);
    const segments = stats.segments;
    expect(segments).toBeGreaterThan(0);
    const second = await startNoisePatternJob(data, {offsetSearch: false, references: 8, searchOn: "cpu", longestLag: 64}, {lanes: lanesFor(v, 4, stats)}).promise;
    expect(second.cached).toBe(true);
    expect(second.timings.ingest).toBeUndefined();
    expect(stats.segments).toBe(segments);
    expect(stats.frames).toBe(v.frames);
    expect(second.lags.lmax).toBe(64);
    expect(second.verdict.period).toBe(32);
});

describe("decoder failures", () => {
    // A decoder that fails for the segment holding frame F when started cold (its first item
    // is the segment's own start) and works when the job pre-rolls from the segment before;
    // `always` fails both ways, `partial` delivers the first half and then reports the error.
    function decoderFailingAt(v, stats, F, {always = false, partial = false} = {}) {
        const base = syntheticDecoder(v, stats);
        return {...base, async decodeSegment(message, onFrame, more) {
            const holds = message.keepFrom <= F && F < message.keepTo;
            const cold = (message.items[0]?.index ?? message.keepFrom) >= message.keepFrom;
            if (!holds || !(always || cold)) return base.decodeSegment(message, onFrame, more);
            if (!partial) throw new Error("Decoding error.");
            const items = [...message.items];
            let last = message.last !== false;
            while (!last) { const next = await more(); items.push(...next.items); last = next.last; }
            const half = message.keepFrom + ((message.keepTo - message.keepFrom) >> 1);
            let decoded = 0;
            for (const item of items) {
                if (item.index < message.keepFrom || item.index >= half) continue;
                onFrame({index: item.index, ...v.frame(item.index), mode: "native", bits: 8});
                decoded++;
            }
            return {decoded, failed: message.keepTo - half, accel: "synthetic", error: "Decoding error."};
        }};
    }
    const lanesWith = (decoder, count = 4) => () => Array.from({length: count},
        () => createLane("cpu", localPort(post => createNoisePatternCore({post, decoder}))));
    const stats = () => ({segments: 0, frames: 0});

    test("a cold-start failure is recovered by decoding from the segment before it", async () => {
        const v = XOR();
        const r = await run(v, {}, {lanes: lanesWith(decoderFailingAt(v, stats(), 200))});
        expect(r.status).toBe("done");
        expect(r.counts.failed).toBe(0);
        expect(r.counts.prerolledSegments).toBe(1);
        expect(r.counts.decodeErrors).toBe(1);
        expect(r.counts.skippedSegments).toBe(0);
        expect(r.verdict.period).toBe(32);
    });

    test("a partial failure is retried and recovered, and counted once", async () => {
        const v = XOR();
        const r = await run(v, {}, {lanes: lanesWith(decoderFailingAt(v, stats(), 200, {partial: true}))});
        expect(r.status).toBe("done");
        expect(r.counts.failed).toBe(0);
        expect(r.counts.decoded).toBe(r.counts.frames);
        expect(r.counts.prerolledSegments).toBe(1);
        expect(r.counts.decodeErrors).toBe(1);
    });

    test("a segment that fails twice is skipped, and the counts say so", async () => {
        const v = XOR();
        const r = await run(v, {}, {lanes: lanesWith(decoderFailingAt(v, stats(), 200, {always: true}))});
        expect(r.status).toBe("done");
        expect(r.counts.skippedSegments).toBe(1);
        expect(r.counts.failed).toBeGreaterThan(0);
        expect(r.counts.decoded + r.counts.failed).toBe(r.counts.frames);
        expect(r.counts.lastDecodeError).toBe("Decoding error.");
    });
});

test("the independent 2-D stage detects displaced texture when the column scan has too few frames", async () => {
    const v = createSyntheticVideo({frames: 40, width: 256, height: 256, fresh: 0.2,
        layer: {kind: "vertical", clip: 7, shiftY: 48, sigma: 4}});
    const r = await run(v, {offsetSearch: true, longestLag: 32});
    expect(r.status).toBe("done");
    expect(r.verdict.kind).toBe("cannot");
    expect(r.offset.status).toBe("done");
    expect(r.offset.pairs).toBeGreaterThan(0);
    expect(r.offset.matches.some(m => m.plane === 1 && Math.abs(m.dy) === 48 && m.score > 0.6)).toBe(true);
    for (const m of r.offset.matches) {
        expect(m.target).toBeGreaterThan(m.source);
        expect(m.sourceCrop.pixels.length).toBe(m.sourceCrop.width * m.sourceCrop.height);
    }
});

test("stopping the additional stage preserves the completed column result", async () => {
    const v = createSyntheticVideo({frames: 40, width: 160, height: 160});
    let job;
    job = startNoisePatternJob(createFakeVideoData(v), {offsetSearch: true, searchOn: "cpu"}, {
        lanes: lanesFor(v, 2), cache: false,
        onUpdate: r => { if (r.stage === "offsetDecode") job.cancel(); },
    });
    const r = await job.promise;
    expect(r.status).toBe("stopped");
    expect(r.verdict.kind).toBe("cannot");
    expect(r.offset.matches).toEqual([]);
});
