// The Star Tracker's post-detection solve in a Web Worker must hand the UI exactly what the
// synchronous call did: the same numbers, in the same order, with the same objects shared - and
// each observation's `src` must be the ORIGINAL detector record, not the copy a structured clone
// makes.
//
// Jest has no Worker, so the transport is simulated with structuredClone, the algorithm
// postMessage uses: the handler is called directly on a cloned request and its replies are cloned
// back, and a FakeWorker does the same behind the real client so its protocol, abort and error
// paths run too. What this cannot cover is the browser itself - the worker chunk loading in each
// build, and the page staying responsive while it runs.

import {solveFrameChain} from "../src/starTrack/StarMatch";
import {solveStarField} from "../src/starTrack/StarSolve";
import {mulberry32} from "../src/starTrack/StarSynthetic";
import {
    CHAIN_SHARE, PROGRESS_INTERVAL_MS, detachDetections, handleStarSolveMessage, relinkDetections,
    solveAfterDetection,
} from "../src/starTrack/StarSolveJob";
import {solveAfterDetectionOffThread} from "../src/starTrack/StarSolveOffThread";

jest.setTimeout(120000);

// The options the Star Tracker passes for a multi-frame clip.
const OPTS = {minObservations: 8, driftSignificance: 5, driftMinSigmas: 12, trackMaxGap: 10};

/**
 * Per-frame detections for a panning, slowly rotating camera: stars that flicker, one that
 * vanishes for longer than the gap allowance (so its pieces are MERGED, and merged tracks share
 * observation objects with their pieces), hot pixels (so the camera-fixed search applies), and a
 * mover. Records carry the detector's photometry and shape fields, which the UI reads off `src`.
 */
function makeClip(nFrames = 90, seed = 7) {
    const rng = mulberry32(seed);
    const W = 640, H = 400;
    const stars = [];
    for (let k = 0; k < 90; k++) {
        stars.push({x: -150 + rng() * (W + 300), y: -100 + rng() * (H + 200),
            flux: Math.exp(4 + rng() * 4), p: rng() < 0.3 ? 0.7 : 0.97});
    }
    // Bright, central, and gone for 20 frames in the middle.
    stars.push({x: W / 2 + 20, y: H / 2 - 10, flux: 3000, p: 1, gap: [35, 55]});
    const hot = [[80, 60], [500, 320], [300, 90]];
    const perFrame = [];
    for (let f = 0; f < nFrames; f++) {
        const th = 0.01 * Math.sin(f / 40), tx = 1.6 * f, ty = 0.7 * f;
        const c = Math.cos(th), s = Math.sin(th);
        const dets = [];
        const add = (x, y, flux) => {
            if (x < 0 || y < 0 || x >= W || y >= H) return;
            dets.push({x, y, flux, area: 4 + flux / 300, apertureFlux: flux * 0.9,
                apertureComplete: rng() < 0.9, apertureContaminated: rng() < 0.05,
                peakSNR: 5 + flux / 50, width: 3, height: 3, elongation: 1 + rng() * 0.2});
        };
        const noise = () => (rng() - 0.5) * 0.5;
        for (const st of stars) {
            if (st.gap && f >= st.gap[0] && f < st.gap[1]) continue;
            if (rng() > st.p) continue;
            const x = st.x - W / 2, y = st.y - H / 2;
            add(c * x - s * y + W / 2 + tx + noise(), s * x + c * y + H / 2 + ty + noise(), st.flux);
        }
        for (const [x, y] of hot) if (rng() < 0.95) add(x + noise(), y + noise(), 400);
        add(100 + 3 * f + noise(), 300 - 1.5 * f + noise(), 900);         // the mover
        perFrame.push(dets);
    }
    return perFrame;
}

/** The synchronous solve, exactly as the Star Tracker made it before the worker. */
function syncSolve(perFrame, opts = OPTS) {
    const chain = solveFrameChain(perFrame);
    const solved = solveStarField(perFrame, chain.cumulative, opts);
    return {chain, solved};
}

/**
 * Deep, order-preserving plain-JSON copy. Numbers are kept bit-distinguishable (-0, NaN). A
 * detection is written as `det:f:i` ONLY when it is the very object in `perFrame` - a copy would
 * be written out field by field and fail the comparison. An object met a second time is written as
 * a back-reference, so which objects are shared is part of the comparison too.
 *
 * Sets and Maps are recognised by their tag, not instanceof: in Jest, structuredClone builds its
 * copies in Node's own realm rather than the test's, where instanceof fails. (A browser builds
 * them in the receiving page's realm, so the UI is unaffected.)
 */
function canonicalise(value, perFrame) {
    const detId = new Map();
    perFrame.forEach((d, f) => d.forEach((s, i) => detId.set(s, `det:${f}:${i}`)));
    const seen = new Map();
    const num = (v) => (Object.is(v, -0) ? "-0" : Number.isNaN(v) ? "NaN"
        : v === Infinity ? "Inf" : v === -Infinity ? "-Inf" : v);
    const walk = (v, p) => {
        if (typeof v === "number") return num(v);
        if (v === undefined) return "__undef";
        if (v === null || typeof v !== "object") return v;
        if (detId.has(v)) return detId.get(v);
        if (seen.has(v)) return {__ref: seen.get(v)};
        seen.set(v, p);
        const tag = Object.prototype.toString.call(v);
        if (tag === "[object Set]") return {__set: [...v].map((x, i) => walk(x, `${p}{${i}}`))};
        if (tag === "[object Map]") return {__map: [...v].map(([k, x], i) => [walk(k, p), walk(x, `${p}<${i}>`)])};
        if (ArrayBuffer.isView(v)) return {__typed: Array.from(v, num)};
        if (Array.isArray(v)) return v.map((x, i) => walk(x, `${p}[${i}]`));
        const out = {};
        for (const k of Object.keys(v)) out[k] = walk(v[k], `${p}.${k}`);
        return out;
    };
    return JSON.stringify(walk(value, "$"));
}

/** Compare two canonical forms, failing with the first differing path rather than megabytes. */
function expectSameSolve(actual, expected, perFrame) {
    const a = canonicalise(actual, perFrame), b = canonicalise(expected, perFrame);
    if (a === b) return;
    const walk = (x, y, p) => {
        if (typeof x !== typeof y || x === null || y === null || typeof x !== "object") {
            return x === y ? null : `${p}: ${JSON.stringify(x)?.slice(0, 120)} vs ${JSON.stringify(y)?.slice(0, 120)}`;
        }
        const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
        for (const k of keys) {
            const d = walk(x[k], y[k], `${p}.${k}`);
            if (d) return d;
        }
        return null;
    };
    throw new Error(`solve results differ at ${walk(JSON.parse(a), JSON.parse(b), "$")}`);
}

/** Every distinct observation reachable from the tracks, merged pieces included. */
function allObservations(solved) {
    const out = new Set();
    const visit = (t) => {
        for (const o of t.obs) out.add(o);
        for (const piece of t.mergedFrom || []) visit(piece);
    };
    solved.tracks.forEach(visit);
    return [...out];
}

/** The handler, called as the worker calls it, with both directions structured-cloned. */
async function runHandler(perFrame, opts = OPTS, clock = undefined) {
    const replies = [];
    await handleStarSolveMessage(structuredClone({type: "solve", perFrame, opts}),
        (msg, transfer) => replies.push(structuredClone(msg, {transfer})), clock);
    return replies;
}

let quietLog;
beforeAll(() => { quietLog = jest.spyOn(console, "log").mockImplementation(() => {}); });
afterAll(() => quietLog.mockRestore());

const clip = makeClip();
let reference = null;
const syncReference = () => (reference ??= syncSolve(clip));

describe("Star Tracker solve off the UI thread", () => {
    test("the test clip exercises merged tracks and camera-fixed sources", () => {
        // Without these the identity tests below would not cover the sharing that matters.
        const {chain, solved} = syncReference();
        expect(chain.cameraFixed.applied).toBe(true);
        expect(solved.tracks.some((t) => t.mergedFrom)).toBe(true);
        expect(solved.classified.some((c) => c.klass === "moving")).toBe(true);
    });

    test("the solve does not change its input detections, so it can run on copies", () => {
        const perFrame = makeClip();
        const before = JSON.stringify(perFrame);
        syncSolve(perFrame);
        expect(JSON.stringify(perFrame)).toBe(before);
    });

    test("the handler's reply, re-linked, is the synchronous result with the original detections", async () => {
        const replies = await runHandler(clip);
        const done = replies[replies.length - 1];
        expect(done.type).toBe("done");
        relinkDetections(done.relink, clip);

        expectSameSolve(done.result, syncReference(), clip);

        // Spelled out for the field the UI reads: every observation's src IS a record in perFrame.
        const obs = allObservations(done.result.solved);
        expect(obs.length).toBeGreaterThan(1000);
        for (const o of obs) expect(clip[o.f]).toContain(o.src);
        expect(done.relink.holders.length).toBe(obs.length);
    });

    test("progress runs chain then field, never backwards, from 0 to 1", async () => {
        const calls = [];
        await solveAfterDetection(clip, OPTS, {onProgress: (stage, fraction) => calls.push([stage, fraction])});
        expect(calls.length).toBeGreaterThan(100);
        expect(calls[0][0]).toBe("chain");
        expect(calls[calls.length - 1]).toEqual(["field", 1]);
        let last = 0, sawField = false;
        for (const [stage, fraction] of calls) {
            expect(fraction).toBeGreaterThanOrEqual(last);
            if (stage === "field") sawField = true;
            else expect(sawField).toBe(false);
            expect(fraction).toBeLessThanOrEqual(stage === "chain" ? CHAIN_SHARE : 1);
            last = fraction;
        }
    });

    test("the worker throttles progress messages", async () => {
        // A clock that moves 1 ms per reading: hundreds of reports become a handful of messages.
        let t = 0;
        const replies = await runHandler(clip, OPTS, () => t++);
        const progress = replies.filter((m) => m.type === "progress");
        expect(progress.length).toBeGreaterThan(1);
        expect(progress.length).toBeLessThan(t / PROGRESS_INTERVAL_MS + 3);
        expect(progress[0].stage).toBe("chain");
        expect(progress[0].fraction).toBeLessThan(0.01);
        expect(progress.some((m) => m.stage === "field")).toBe(true);
        // The final report is never throttled away, so the bar ends full.
        expect(progress[progress.length - 1]).toEqual({type: "progress", stage: "field", fraction: 1});
    });

    test("a solver error comes back as an error message, not a throw", async () => {
        const replies = await runHandler([[{x: 1, y: 1}], null], OPTS);
        expect(replies[replies.length - 1].type).toBe("error");
        expect(typeof replies[replies.length - 1].message).toBe("string");
    });

    test("detachDetections finds a detection wherever it is held", () => {
        const perFrame = [[{x: 1}, {x: 2}], [{x: 3}]];
        const result = {a: [perFrame[0][1]], b: {c: perFrame[1][0], d: [{e: perFrame[0][0]}]},
            plain: {x: 1}, set: new Set([1, 2])};
        const back = structuredClone({result, relink: detachDetections(result, perFrame)});
        expect(back.result.a[0]).toBeNull();
        relinkDetections(back.relink, perFrame);
        expect(back.result.a[0]).toBe(perFrame[0][1]);
        expect(back.result.b.c).toBe(perFrame[1][0]);
        expect(back.result.b.d[0].e).toBe(perFrame[0][0]);
        expect(back.result.plain).toEqual({x: 1});

        expect(() => detachDetections({s: new Set([perFrame[0][0]])}, perFrame)).toThrow(/Set or Map/);
    });
});

/**
 * A Worker that runs the real handler on this thread, with structured-clone transport both ways
 * and asynchronous delivery, as a browser's would be.
 */
class FakeWorker {
    static instances = [];
    static mode = "handler";      // or "loadError", "throwOnCreate"

    constructor(url, options) {
        if (FakeWorker.mode === "throwOnCreate") throw new Error("no workers here");
        this.url = String(url);
        this.options = options;
        this.terminated = false;
        FakeWorker.instances.push(this);
    }

    postMessage(msg) {
        const data = structuredClone(msg);
        setTimeout(() => {
            if (this.terminated) return;
            if (FakeWorker.mode === "loadError") {
                this.onerror?.({message: "chunk failed to load"});
                return;
            }
            handleStarSolveMessage(data, (reply, transfer) => {
                const copy = structuredClone(reply, {transfer});
                setTimeout(() => { if (!this.terminated) this.onmessage?.({data: copy}); }, 0);
            });
        }, 0);
    }

    terminate() { this.terminated = true; }
}

describe("solveAfterDetectionOffThread", () => {
    afterEach(() => {
        delete global.Worker;
        FakeWorker.instances = [];
        FakeWorker.mode = "handler";
    });

    test("with no Worker it solves on this thread, as before", async () => {
        expect(typeof Worker).toBe("undefined");
        let yields = 0;
        const out = await solveAfterDetectionOffThread(clip, OPTS, {onYield: async () => { yields++; }});
        expect(yields).toBe(1);
        expectSameSolve(out, syncReference(), clip);
    });

    test("a Worker that cannot be created falls back to this thread", async () => {
        global.Worker = FakeWorker;
        FakeWorker.mode = "throwOnCreate";
        const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
        try {
            const out = await solveAfterDetectionOffThread(clip, OPTS);
            expectSameSolve(out, syncReference(), clip);
            expect(warn).toHaveBeenCalled();
        } finally {
            warn.mockRestore();
        }
    });

    test("in a worker: the synchronous result, the original detections, progress, and the worker ended", async () => {
        global.Worker = FakeWorker;
        const progress = [];
        const out = await solveAfterDetectionOffThread(clip, OPTS,
            {onProgress: (stage, fraction) => progress.push([stage, fraction])});
        expect(FakeWorker.instances.length).toBe(1);
        const w = FakeWorker.instances[0];
        expect(w.url).toMatch(/workers\/StarSolveWorker\.js$/);
        expect(w.options).toEqual({type: "module"});
        expect(w.terminated).toBe(true);

        expectSameSolve(out, syncReference(), clip);
        for (const o of allObservations(out.solved)) expect(clip[o.f]).toContain(o.src);
        expect(progress.length).toBeGreaterThan(0);
        expect(progress[0][0]).toBe("chain");
    });

    test("a single frame never starts a worker", async () => {
        global.Worker = FakeWorker;
        const one = [clip[0]];
        const out = await solveAfterDetectionOffThread(one, OPTS);
        expect(FakeWorker.instances.length).toBe(0);
        expectSameSolve(out, syncSolve(one), one);
    });

    test("an abort terminates the worker and resolves null", async () => {
        global.Worker = FakeWorker;
        let seen = 0;
        const out = await solveAfterDetectionOffThread(clip, OPTS, {
            onProgress: () => { seen++; },
            shouldAbort: () => seen > 0,
        });
        expect(out).toBeNull();
        expect(seen).toBe(1);
        expect(FakeWorker.instances[0].terminated).toBe(true);
    });

    test("a worker that fails to load rejects, rather than hanging", async () => {
        global.Worker = FakeWorker;
        FakeWorker.mode = "loadError";
        await expect(solveAfterDetectionOffThread(clip, OPTS)).rejects.toThrow(/chunk failed to load/);
        expect(FakeWorker.instances[0].terminated).toBe(true);
    });

    test("an error inside the solve rejects with its message", async () => {
        global.Worker = FakeWorker;
        await expect(solveAfterDetectionOffThread([[{x: 1, y: 1}], null], OPTS))
            .rejects.toThrow(/star solve worker: /);
        expect(FakeWorker.instances[0].terminated).toBe(true);
    });
});
