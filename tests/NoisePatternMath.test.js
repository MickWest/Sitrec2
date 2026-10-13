import {
    BAND_STRIDE, BANDS, SIG_COUNT, THUMB_SIZE, bandPassRow, createFeatureContext, createMatchScratch, extractFrameFeatures,
    avcChunkHasIdr, avcNalLengthSize,
    detrendZ, findPeriod, fitRule, gaussianSource, latticeFold, matchPair, matchProbes, mulberry32, planeDescriptors, planSegments,
    reducePair, temporalHighPass,
} from "../src/videoNoisePattern/NoisePatternMath";
import {displayIndexForFrame, frameForDisplayIndex} from "../src/videoQP/VideoQPAnalysis";
import {createSyntheticVideo} from "./noisePatternSynthetic";

function featuresOf(frame, width, height) {
    const ctx = createFeatureContext(width, height);
    const rowSize = ctx.columns * BAND_STRIDE;
    const out = {
        strips: [0, 1, 2].map(() => new Int8Array(rowSize)), live: [0, 1, 2].map(() => new Uint8Array(ctx.columns)),
        sigY: new Int8Array(SIG_COUNT), sigCb: new Int8Array(SIG_COUNT), thumb: new Float32Array(THUMB_SIZE),
    };
    const live = extractFrameFeatures(frame, ctx, out);
    return {out, live, ctx};
}

describe("plane formats", () => {
    const video = createSyntheticVideo({frames: 4, layer: {kind: "xor"}});
    const frame = video.frame(2);
    const {width, height} = video;
    const cw = width / 2, ch = height / 2;

    function asNV12() {
        const data = new Uint8Array(width * height + 2 * cw * ch);
        data.set(frame.data.subarray(0, width * height));
        const cb = frame.data.subarray(width * height, width * height + cw * ch);
        const cr = frame.data.subarray(width * height + cw * ch);
        for (let i = 0; i < cw * ch; i++) { data[width * height + 2 * i] = cb[i]; data[width * height + 2 * i + 1] = cr[i]; }
        const layout = [{offset: 0, stride: width}, {offset: width * height, stride: 2 * cw}];
        return {data, descriptors: planeDescriptors("NV12", layout, width, height)};
    }

    function asP10() {
        const words = Uint16Array.from(frame.data, v => v << 2);
        const layout = [{offset: 0, stride: 2 * width}, {offset: 2 * width * height, stride: 2 * cw},
            {offset: 2 * (width * height + cw * ch), stride: 2 * cw}];
        return {data: words, descriptors: planeDescriptors("I420P10", layout, width, height)};
    }

    test("I420, NV12 and 10-bit I420 give identical features", () => {
        const a = featuresOf(frame, width, height).out;
        for (const other of [asNV12(), asP10()]) {
            const b = featuresOf(other, width, height).out;
            for (let p = 0; p < 3; p++) {
                expect(Array.from(b.strips[p])).toEqual(Array.from(a.strips[p]));
                expect(Array.from(b.live[p])).toEqual(Array.from(a.live[p]));
            }
            expect(Array.from(b.sigY)).toEqual(Array.from(a.sigY));
            expect(Array.from(b.sigCb)).toEqual(Array.from(a.sigCb));
        }
    });

    test("doubling the contrast gives identical Int8 profiles", () => {
        const low = {...frame, data: Uint8Array.from(frame.data, v => 128 + Math.round((v - 128) / 4))};
        const high = {...frame, data: Uint8Array.from(low.data, v => 2 * v - 128)};
        const a = featuresOf(low, width, height).out, b = featuresOf(high, width, height).out;
        for (let p = 0; p < 3; p++) expect(Array.from(b.strips[p])).toEqual(Array.from(a.strips[p]));
    });
});

test("the macroblock notch leaves less than 2% of a 16-px periodic pattern", () => {
    const columns = 160;
    const live = new Uint8Array(columns).fill(1);
    const pattern = Float64Array.from({length: columns}, (_, x) => (x % 2 ? -1 : 1) * 50);
    const out = bandPassRow(pattern.slice(), live, columns, 8);
    const energy = (a) => a.reduce((s, v) => s + v * v, 0);
    expect(energy(out) / energy(pattern)).toBeLessThan(0.02);
});

test("the temporal high-pass removes a fixed overlay", () => {
    const m = 40, columns = 40, rowSize = columns * BAND_STRIDE;
    const g = gaussianSource(mulberry32(5));
    const overlay = Float64Array.from({length: rowSize}, (_, k) => (k % BAND_STRIDE < BANDS ? 60 * g() : 0));
    const raw = new Int8Array(m * rowSize);
    for (let i = 0; i < m; i++) {
        for (let k = 0; k < rowSize; k++) {
            if (k % BAND_STRIDE >= BANDS) continue;
            raw[i * rowSize + k] = Math.max(-96, Math.min(96, Math.round(overlay[k] + 10 * g())));
        }
    }
    const live = new Uint8Array(m * columns).fill(1);
    const valid = new Uint8Array(m).fill(1);
    const ncc = (a, b) => {
        let ab = 0, aa = 0, bb = 0;
        for (let k = 0; k < a.length; k++) { ab += a[k] * b[k]; aa += a[k] * a[k]; bb += b[k] * b[k]; }
        return ab / Math.sqrt(aa * bb);
    };
    expect(ncc(raw.subarray(0, rowSize), raw.subarray(20 * rowSize, 21 * rowSize))).toBeGreaterThan(0.9);
    const out = new Int8Array(m * rowSize), energies = new Float32Array(m * columns);
    temporalHighPass(raw, live, valid, m, columns, 0, m, out, energies);
    expect(Math.abs(ncc(out.subarray(0, rowSize), out.subarray(20 * rowSize, 21 * rowSize)))).toBeLessThan(0.1);
});

describe("blind strip assignment", () => {
    // brute force: every probe, position and band shift, with energies over the overlap
    function bruteForce(T, S, columns, V) {
        const P = Math.floor(columns / 2);
        const out = [];
        for (let k = 0; k < P; k++) {
            const scores = [];
            for (let dy = -V; dy <= V; dy++) {
                const b0 = Math.max(0, -dy), b1 = Math.min(BANDS, BANDS - dy);
                for (let s = 0; s + 1 < columns; s++) {
                    let dot = 0, et = 0, es = 0;
                    for (let c = 0; c < 2; c++) for (let b = b0; b < b1; b++) {
                        const t = T[(2 * k + c) * BAND_STRIDE + b], u = S[(s + c) * BAND_STRIDE + b + dy];
                        dot += t * u; et += t * t; es += u * u;
                    }
                    scores.push({s, dy, r: et > 0 && es > 0 ? dot / Math.sqrt(et * es) : 0});
                }
            }
            let best = scores[0];
            for (const x of scores) if (x.r > best.r) best = x;
            let second = -Infinity;
            for (const x of scores) if (Math.abs(x.s - best.s) >= 2 && x.r > second) second = x.r;
            out.push({c1: best.r, s: best.s, c2: second});
        }
        return out;
    }

    function randomProfile(columns, seed) {
        const g = gaussianSource(mulberry32(seed));
        const q = new Int8Array(columns * BAND_STRIDE);
        for (let x = 0; x < columns; x++) for (let b = 0; b < BANDS; b++) q[x * BAND_STRIDE + b] = Math.max(-96, Math.min(96, Math.round(30 * g())));
        return q;
    }

    const energies = (q, columns) => Float32Array.from({length: columns}, (_, x) => {
        let e = 0;
        for (let b = 0; b < BANDS; b++) e += q[x * BAND_STRIDE + b] ** 2;
        return e;
    });

    test.each([0, 1])("matches a brute-force search (vertical search %i)", (V) => {
        const columns = 24;
        const S = randomProfile(columns, 11);
        const T = randomProfile(columns, 12);
        // half of the target repeats the source, moved by 6 columns
        for (let x = 0; x < 12; x++) for (let b = 0; b < BANDS; b++) T[x * BAND_STRIDE + b] = S[(x + 6) * BAND_STRIDE + b];
        const scratch = createMatchScratch(columns);
        matchProbes(T, S, energies(T, columns), energies(S, columns), columns, V, scratch);
        const expected = bruteForce(T, S, columns, V);
        expected.forEach((e, k) => {
            expect(scratch.c1[k]).toBeCloseTo(e.c1, 5);
            expect(scratch.c2[k]).toBeCloseTo(e.c2, 5);
            expect(scratch.sBest[k]).toBe(e.s);
        });
        for (let k = 0; k < 6; k++) expect(scratch.sBest[k]).toBe(2 * k + 6);
        const out = new Float32Array(4);
        matchPair(T, S, energies(T, columns), energies(S, columns), columns, 8, V, scratch, out);
        expect(out[1]).toBeGreaterThanOrEqual(0.5);
        // the moved half is a shift of 6 columns to the left = -48 px
        expect(out[3]).toBe(-48);
    });

    test("fewer than 8 usable probes give no pair", () => {
        const scratch = createMatchScratch(12);
        const out = new Float32Array(4);
        reducePair(new Float32Array(6).fill(0.9), new Float32Array(6), new Int16Array(6), new Float32Array(6).fill(1), 6, 8, scratch, out);
        expect(Number.isNaN(out[1])).toBe(true);
    });
});

describe("period", () => {
    const curve = (fn) => Float64Array.from({length: 256}, (_, i) => fn(i + 1));
    const noise = (L) => Math.sin(L * 12.9898) * 1.5;

    test("sparse quantized lag curves do not divide peaks by an artificial epsilon", () => {
        const values = curve(L => L === 112 ? 0.17142857 : 0);
        const z = detrendZ(values);
        expect(z[111]).toBeCloseTo(Math.sqrt(240));
        expect(Array.from(z).filter(Number.isFinite).every(v => Math.abs(v) < 16)).toBe(true);
        expect(findPeriod(z, 256).period).toBeNull();
    });

    test("a completely flat lag curve has no defined strength", () => {
        const z = detrendZ(curve(() => 0.1));
        expect(Array.from(z).every(Number.isNaN)).toBe(true);
        expect(findPeriod(z, 256).significant).toEqual([]);
    });

    test("peaks at 32, 64, 96 and 128 give a period of 32", () => {
        const z = curve(L => [32, 64, 96, 128].includes(L) ? 20 : noise(L));
        const found = findPeriod(z, 128);
        expect(found.period).toBe(32);
        expect(found.strength).toBeCloseTo(20);
    });

    test("one peak is an isolated repeat, not a period", () => {
        const found = findPeriod(curve(L => L === 50 ? 15 : noise(L)), 200);
        expect(found.period).toBeNull();
        expect(found.significant).toEqual([50]);
    });

    test("noise has no period and nothing significant", () => {
        const found = findPeriod(curve(noise), 256);
        expect(found.period).toBeNull();
        expect(found.significant).toEqual([]);
    });
});

describe("strip lattice and rule", () => {
    test("300 jittered strip edges give the strip width, not a fraction of it", () => {
        const rng = mulberry32(3), g = gaussianSource(rng);
        for (const w of [10.667, 21.333]) {
            const bounds = Array.from({length: 300}, () => 5.5 + Math.floor(rng() * 60) * w + 0.4 * g());
            const lattice = latticeFold(bounds);
            expect(lattice.accepted).toBe(true);
            expect(Math.abs(lattice.w - w)).toBeLessThan(0.05);
        }
    });

    // a dense map: probe centers every 2 px, the source position given by mapFn(strip)
    function denseMapOf(width, w, o, sourceStrip, {offset = null, confident = 1} = {}) {
        const count = Math.floor((width - 16) / 2);
        const x = new Float32Array(count), dl = new Float32Array(count);
        const valid = new Uint8Array(count).fill(1), conf = new Uint8Array(count).fill(confident), margin = new Float32Array(count).fill(0.3);
        for (let t = 0; t < count; t++) {
            x[t] = 8 + 2 * t;
            const c = Math.floor((x[t] - o) / w);
            dl[t] = offset !== null ? offset : (sourceStrip(c) - c) * w;
        }
        return {count, x, dl, c1: new Float32Array(count).fill(0.8), margin, valid, confident: conf, colWidth: 2, wp: 8};
    }

    const lattice = {accepted: true, w: 16, origin: 0, n: 300, R: 0.9};

    test("recovers the XOR value of each pair", () => {
        const maps = [5, 9, 12, 3].map(d => denseMapOf(640, 16, 0, c => c ^ d));
        const rule = fitRule(maps, lattice, {frameWidth: 640});
        expect(rule.kind).toBe("xor");
        expect(rule.fitPairs).toBe(4);
        expect(rule.xor.map(f => f.d)).toEqual([5, 9, 12, 3]);
    });

    test("recovers a cyclic strip shift", () => {
        const maps = [3, 7].map(k => denseMapOf(640, 16, 0, c => (c + k) % 40));
        const rule = fitRule(maps, lattice, {frameWidth: 640});
        expect(rule.kind).toBe("cyclic");
        expect(rule.cyclic.map(f => f.k)).toEqual([3, 7]);
    });

    test("recovers a translation", () => {
        const maps = [-24, -48].map(offset => denseMapOf(320, 16, 0, null, {offset}));
        const rule = fitRule(maps, {accepted: false}, {frameWidth: 320});
        expect(rule.kind).toBe("translation");
        expect(rule.translation.map(f => f.shift)).toEqual([24, 48]);
    });

    test("random assignments fit no rule", () => {
        const rng = mulberry32(9);
        const maps = [0, 1, 2].map(() => {
            const table = Array.from({length: 64}, () => Math.floor(rng() * 40));
            return denseMapOf(640, 16, 0, c => table[c]);
        });
        expect(fitRule(maps, lattice, {frameWidth: 640}).kind).toBe("none");
    });
});

test("frameForDisplayIndex inverts displayIndexForFrame", () => {
    for (const speed of [0.5, 0.75, 1, 1.5, 2]) {
        const video = {videoSpeed: speed};
        for (let f = 0; f < 300; f++) {
            const d = displayIndexForFrame(video, f);
            expect(displayIndexForFrame(video, frameForDisplayIndex(video, d))).toBe(d);
        }
    }
    // a patched video that holds every third source frame for an extra slot
    const source = {videoSpeed: 1};
    const map = [];
    for (let s = 0; s < 100; s++) { map.push(s); if (s % 3 === 0) map.push(s); }
    const firstV = [];
    map.forEach((s, v) => { if (firstV[s] === undefined) firstV[s] = v; });
    const patched = {source, virtualToSource: (v) => map[Math.max(0, Math.min(map.length - 1, v))],
        sourceToVirtual: (s) => firstV[Math.max(0, Math.min(99, s))]};
    for (let v = 0; v < map.length; v++) {
        const d = displayIndexForFrame(patched, v);
        expect(displayIndexForFrame(patched, frameForDisplayIndex(patched, d))).toBe(d);
    }
});

describe("decode segments", () => {
    function plan(displayOf, groupStarts, segments, range = null) {
        return planSegments(groupStarts, Int32Array.from(displayOf), displayOf.length, range, segments);
    }

    test("closed GOPs: each chunk is decoded once and the kept ranges tile the video", () => {
        const n = 600, gop = 120;
        const displayOf = Array.from({length: n}, (_, c) => c);
        const starts = Array.from({length: n / gop}, (_, g) => g * gop);
        for (const count of [1, 2, 3, 10]) {
            const segments = plan(displayOf, starts, count);
            const decodes = new Uint8Array(n);
            for (const s of segments) for (let c = s.decodeFrom; c < s.decodeTo; c++) decodes[c]++;
            expect(Array.from(decodes).every(x => x === 1)).toBe(true);
            let next = 0;
            for (const s of segments) { expect(s.keepFrom).toBe(next); next = s.keepTo; }
            expect(next).toBe(n);
        }
    });

    test("open GOPs: the leading pictures of the next group are decoded with the previous one", () => {
        // each group: key, then two B pictures shown before the key, then the rest
        const displayOf = [], starts = [];
        let base = 0;
        for (let g = 0; g < 4; g++) {
            starts.push(displayOf.length);
            const lead = g === 0 ? 0 : 2;
            displayOf.push(base + lead);                  // key
            for (let i = 0; i < lead; i++) displayOf.push(base + i);
            for (let i = lead + 1; i < 30; i++) displayOf.push(base + i);
            base += 30;
        }
        const segments = plan(displayOf, starts, 4);
        let next = 0;
        for (const s of segments) {
            expect(s.keepFrom).toBe(next);
            next = s.keepTo;
            // every kept display index is decoded by this segment
            const decoded = new Set(displayOf.slice(s.decodeFrom, s.decodeTo));
            for (let d = s.keepFrom; d < s.keepTo; d++) expect(decoded.has(d)).toBe(true);
        }
        expect(next).toBe(120);
        // a range keeps only its frames
        const ranged = plan(displayOf, starts, 4, {from: 40, to: 70});
        expect(ranged[0].keepFrom).toBe(40);
        expect(ranged[ranged.length - 1].keepTo).toBe(71);
    });
});

describe("H.264 random access", () => {
    // length-prefixed NAL units: [4-byte length][nal header byte ...]
    function nal(type, payload = 3) {
        const len = 1 + payload;
        return [0, 0, 0, len, 0x60 | type, ...new Array(payload).fill(0xaa)];
    }
    test("avcC length size", () => {
        expect(avcNalLengthSize(null)).toBe(4);
        expect(avcNalLengthSize(new Uint8Array([1, 0x4d, 0x40, 0x1f, 0xff]))).toBe(4);
        expect(avcNalLengthSize(new Uint8Array([1, 0x4d, 0x40, 0x1f, 0xfd]))).toBe(2);
        expect(avcNalLengthSize(new Uint8Array([1, 0x4d, 0x40, 0x1f, 0xfe]).buffer)).toBe(3);
    });
    test("an SEI followed by an IDR slice is a random access point", () => {
        expect(avcChunkHasIdr(Uint8Array.from([...nal(6), ...nal(5)]))).toBe(true);
    });
    test("an SEI followed by a non-IDR I slice is not", () => {
        expect(avcChunkHasIdr(Uint8Array.from([...nal(6), ...nal(1)]))).toBe(false);
        expect(avcChunkHasIdr(Uint8Array.from([...nal(1), ...nal(1)]))).toBe(false);
    });
    test("data without a readable slice keeps the sync-sample flag", () => {
        expect(avcChunkHasIdr(Uint8Array.from([0, 0, 0, 1, 0x67, 0x4d]))).toBe(true);   // Annex B start code
        expect(avcChunkHasIdr(Uint8Array.from([...nal(6)]))).toBe(true);                // SEI only
        expect(avcChunkHasIdr(new Uint8Array(0))).toBe(true);
    });
    test("other NAL length sizes", () => {
        const two = (type) => [0, 2, 0x60 | type, 0xaa];
        expect(avcChunkHasIdr(Uint8Array.from([...two(6), ...two(5)]), 2)).toBe(true);
        expect(avcChunkHasIdr(Uint8Array.from([...two(6), ...two(1)]), 2)).toBe(false);
    });
});
