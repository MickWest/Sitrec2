// Main-thread half of the parallel spherical solve: refineGlobalSphericalAsync.
//
// WHY. Analysing a dense Milky Way timelapse (2443 tracks over 160 frames) spent ~121 s of a
// ~150 s run inside refineGlobalSpherical, all of it synchronous on the UI thread - long enough
// that Chrome repeatedly offered to kill the page. Nothing else in Star Track is close.
//
// WHAT IS PARALLEL, AND WHY BOTH HALVES HAD TO BE. Measured at that scale on a forced
// 12-iteration solve:
//
//     per-frame orientation fit    65-76%     independent across FRAMES
//     per-track direction update   12-19%     independent across TRACKS
//     per-track residual sum       10-16%     independent across TRACKS
//     gauge re-pin                 <0.1%      stays here, it is free
//
// The obvious split - move the orientation fit, it is the big one - caps out at 1/(0.30 + 0.70/8)
// = 2.6x on eight cores, because the per-track third stays serial. Splitting both reaches the
// core count. They chunk on different axes, so each iteration is two scatter/gather rounds with a
// barrier between them.
//
// DETERMINISM, which is the constraint that shaped everything else here. Rendered-pixel
// regression tests compare star overlays, so this must return what the synchronous solve returns
// exactly, for ANY worker count, on any machine. Three things make that true:
//
//   - the workers run the SAME kernels, imported from StarSolveSphere.js, not a copy;
//   - every frame's fit and every track's update is independent of the others, so a chunk
//     boundary cannot change a value - only where it is computed;
//   - the cost is reduced from PER-TRACK partials summed in track index order, never as a running
//     total over whatever order chunks happen to come back in. Floating-point addition is not
//     associative; the synchronous path was changed to sum the same way so the two agree bit for
//     bit rather than closely. See the note in refineGlobalSpherical.
//
// FALLBACK. No Worker (Jest, non-browser), a spawn failure, a worker error, or a problem too
// small to be worth the setup all run the synchronous solve instead. It is the same code, so a
// fallback costs time and changes no result.

import {
    STAR_SPHERE_DEFAULTS, planGlobalSpherical, refineGlobalSpherical, applyGauge, unpackMap,
    packStates, createChunkResponder,
} from "./StarSolveSphere";

// Chunks per worker per phase. More than one so a frame that happens to be expensive - a frame
// with a full anchor row, where refineRotationPixels runs all twelve of its Gauss-Newton steps -
// does not leave seven workers idle at the end of a round. Four is enough to smooth that out
// without making the per-chunk message overhead visible.
const CHUNKS_PER_WORKER = 4;

// Below this the synchronous solve finishes in well under a second, and spawning a pool and
// shipping it the observations costs more than it saves.
const MIN_OBSERVATIONS_FOR_POOL = 5000;

// Workers hold the flattened observations - about 7 MB on the clip that motivated this, times the
// pool size - so an idle pool is not free. A run does two solves back to back, so the pool is
// kept briefly rather than torn down between them.
const IDLE_TERMINATE_MS = 60000;

let pool = null;
let idleTimer = null;
let generation = 0;
let queue = Promise.resolve();       // solves run one at a time; see runExclusive

export function sphereWorkersAvailable() {
    return typeof Worker !== "undefined";
}

function defaultWorkerCount() {
    // One core left for the UI thread, which still renders the progress bar and stays responsive
    // to the abort button while this runs.
    const n = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4;
    return Math.max(1, Math.min(8, n - 1));
}

function makeSlot() {
    const slot = {
        w: new Worker(new URL("../workers/StarSphereWorker.js", import.meta.url)),
        resolve: null, reject: null,
    };
    slot.w.onmessage = (e) => {
        const done = slot.resolve, fail = slot.reject;
        slot.resolve = slot.reject = null;
        if (e.data && e.data.type === "error") {
            if (fail) fail(new Error(`star sphere worker: ${e.data.message}`));
            return;
        }
        if (done) done(e.data);
    };
    slot.w.onerror = (err) => {
        const fail = slot.reject;
        slot.resolve = slot.reject = null;
        if (fail) fail(err instanceof Error ? err : new Error(String((err && err.message) || err)));
    };
    return slot;
}

function ensurePool(count) {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (pool && pool.length === count) return pool;
    terminateSphereWorkers();
    pool = [];
    for (let i = 0; i < count; i++) pool.push(makeSlot());
    return pool;
}

function scheduleIdleTerminate() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { idleTimer = null; terminateSphereWorkers(); }, IDLE_TERMINATE_MS);
}

export function terminateSphereWorkers() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (!pool) return;
    for (const slot of pool) {
        slot.w.onmessage = null;
        slot.w.onerror = null;
        // Terminate, not a polite stop flag: a chunk already inside refineRotationPixels cannot
        // be interrupted from the outside any other way, and an abort has to be immediate.
        slot.w.terminate();
        // A terminated worker will never answer, so anything waiting on it has to be failed here
        // or it waits forever - a hung analysis with no error, which is the worst way to lose.
        const fail = slot.reject;
        slot.resolve = slot.reject = null;
        if (fail) fail(new Error("star sphere worker terminated"));
    }
    pool = null;
}

/** One request/response on a worker. Only ever one in flight per worker. */
function send(slot, msg) {
    return new Promise((resolve, reject) => {
        slot.resolve = resolve;
        slot.reject = reject;
        slot.w.postMessage(msg);
    });
}

// A LANE is one unit of concurrency, and the only thing the solve loop below knows about its
// workers. Backing it with a Worker or with a direct call to the same responder the Worker wraps
// is the difference between the parallel path and the fallback - and it is the seam the tests use
// to drive the real orchestration at arbitrary lane counts without needing a Worker at all.
function workerLane(slot) {
    return {
        init: (p) => send(slot, p),
        round: (p) => { slot.w.postMessage(p); },
        chunk: (msg) => send(slot, msg),
    };
}

/** A lane that answers on this thread. The no-Worker fallback, and the test seam. */
export function localLane() {
    const responder = createChunkResponder();
    return {
        init: async (p) => { responder.init(p); },
        round: (p) => responder.round(p),
        // `transfer` is dropped here exactly as the worker drops it into postMessage's second
        // argument, so both lane kinds hand the solve loop the same shape.
        chunk: async (msg) => {
            const {transfer, ...result} = responder.chunk(msg);
            return result;
        },
    };
}

/**
 * Hand [lo, hi) ranges to whichever lane is free, until `total` is covered.
 *
 * Work-stealing rather than a fixed split, so an unevenly expensive phase still finishes together
 * - one frame with a full anchor row can cost several times what a sparse one does. Results are
 * applied by their own lo/hi, so the order they arrive in cannot affect the answer.
 */
async function scatter(lanes, gen, type, total, apply) {
    const chunk = Math.max(1, Math.ceil(total / (lanes.length * CHUNKS_PER_WORKER)));
    let next = 0;
    await Promise.all(lanes.map(async (lane) => {
        for (;;) {
            // Single-threaded between awaits, so this claim needs no lock.
            const lo = next;
            if (lo >= total) return;
            const hi = Math.min(total, lo + chunk);
            next = hi;
            apply(await lane.chunk({type, gen, lo, hi}));
        }
    }));
}

/** Broadcast the round's shared state. Fire and forget: per-lane message order is guaranteed. */
function broadcastRound(lanes, gen, map, states) {
    const packed = packStates(states);
    for (const lane of lanes) {
        lane.round({
            type: "round", gen,
            // Copies, not transfers: every lane needs its own, and transferring would detach the
            // buffer the next one is about to be handed.
            map: map.slice(),
            statesQ: packed.q.slice(), statesS: packed.s.slice(), statesValid: packed.valid.slice(),
        });
    }
}

/** Solves are serialised - one pool, and a second solve must not interleave rounds with the first. */
function runExclusive(fn) {
    const run = queue.then(fn, fn);
    queue = run.then(() => {}, () => {});
    return run;
}

class Aborted extends Error {}

/**
 * refineGlobalSpherical across a worker pool.
 *
 * Identical arguments, identical result - including the `tracks[i].ref` write-back, which is
 * applied here rather than left to the caller precisely because a worker cannot mutate the
 * caller's objects and a caller that forgot would silently feed gnomonicChart,
 * classifyTracksSpherical and the identify chart stale directions.
 *
 * @param {object} opts  everything refineGlobalSpherical takes, plus:
 *   `shouldAbort()`  polled at every phase boundary; aborts and returns null
 *   `onProgress({iteration, iterations, phase})`  called at each phase boundary
 *   `workerCount`    override; tests use it to prove the answer is lane-count independent
 *   `lanes`          inject lanes directly, bypassing Worker creation (tests)
 * @returns {Promise<object|null>} null only if aborted
 */
export async function refineGlobalSphericalAsync(tracks, initialStates, lens, size, opts = {}) {
    const shouldAbort = opts.shouldAbort || (() => false);
    const plan = planGlobalSpherical(tracks, initialStates.length, opts);

    if (!opts.lanes
        && (!sphereWorkersAvailable() || plan.obs.f.length < MIN_OBSERVATIONS_FOR_POOL)) {
        return refineGlobalSpherical(tracks, initialStates, lens, size, opts);
    }

    if (opts.lanes) {
        // Injected lanes belong to the caller: no pool, no idle timer, no teardown here.
        return solveOverLanes(opts.lanes, plan, tracks, initialStates, lens, size, opts)
            .catch((e) => { if (e instanceof Aborted) return null; throw e; });
    }

    try {
        return await runExclusive(async () => {
            if (shouldAbort()) return null;
            const slots = ensurePool(opts.workerCount || defaultWorkerCount());
            const lanes = slots.map(workerLane);
            const out = await solveOverLanes(lanes, plan, tracks, initialStates, lens, size, opts);
            scheduleIdleTerminate();
            return out;
        });
    } catch (e) {
        terminateSphereWorkers();
        if (e instanceof Aborted) return null;
        // A worker failure must not take the analysis down: the synchronous solve is the same
        // code and produces the same answer, it just takes longer.
        console.warn("[StarTrack] spherical worker pool failed; solving on the main thread", e);
        if (shouldAbort()) return null;
        return refineGlobalSpherical(tracks, initialStates, lens, size, opts);
    }
}

/**
 * The solve loop, over whatever lanes it is given.
 *
 * Structurally the same loop as the synchronous refineGlobalSpherical, with each of its two heavy
 * phases replaced by a scatter/gather and a barrier. The gauge and the convergence test stay here
 * because they are cross-cutting and cost nothing.
 */
async function solveOverLanes(lanes, plan, tracks, initialStates, lens, size, opts) {
    const O = {...STAR_SPHERE_DEFAULTS, ...opts};
    const shouldAbort = opts.shouldAbort || (() => false);
    const onProgress = opts.onProgress || (() => {});
    const gen = ++generation;
    const {nTracks, nFrames} = plan;

    // The static half of the plan, once per lane. Structured-cloned into each worker, so each
    // gets its own copy of the observation arrays; about 7 MB each on the clip that motivated
    // this, which is why an idle pool is torn down rather than kept forever.
    await Promise.all(lanes.map((lane) => lane.init({
        type: "init", gen,
        lens, size, kernelOpts: plan.kernelOpts,
        obs: plan.obs, anchors: plan.anchors, excludeMask: plan.excludeMask,
    })));

    let map = plan.map;
    let states = initialStates.map((s) => (s ? {...s} : null));
    let rms = Infinity, iterations = 0, converged = false;

    const checkAbort = () => { if (shouldAbort()) throw new Aborted(); };

    for (let iter = 0; iter < O.refineIterations; iter++) {
        iterations = iter + 1;
        checkAbort();
        onProgress({iteration: iterations, iterations: O.refineIterations, phase: "orientations"});

        // --- orientations, given the map: chunked across FRAMES ---
        broadcastRound(lanes, gen, map, states);
        const nextStates = states.slice();
        await scatter(lanes, gen, "orient", nFrames, (r) => {
            for (let f = r.lo; f < r.hi; f++) {
                if (!r.ok[f - r.lo]) continue;          // too few anchors: state left alone
                const b = (f - r.lo) * 4;
                nextStates[f] = {
                    ...states[f],
                    q: [r.q[b], r.q[b + 1], r.q[b + 2], r.q[b + 3]],
                    inliers: r.inliers[f - r.lo],
                };
            }
        });
        states = nextStates;

        // --- gauge: pin the first solved frame to the identity ---
        ({map, states} = applyGauge(map, states));

        checkAbort();
        onProgress({iteration: iterations, iterations: O.refineIterations, phase: "map"});

        // --- map and cost, given the orientations: chunked across TRACKS ---
        broadcastRound(lanes, gen, map, states);
        const dirs = new Float64Array(nTracks * 3).fill(NaN);
        const sseByTrack = new Float64Array(nTracks);
        const cntByTrack = new Int32Array(nTracks);
        await scatter(lanes, gen, "tracks", nTracks, (r) => {
            dirs.set(r.dirs, r.lo * 3);
            sseByTrack.set(r.sse, r.lo);
            cntByTrack.set(r.count, r.lo);
        });
        map = dirs;

        // Summed in TRACK INDEX order, never in the order the chunks came back in - that is what
        // makes the answer independent of the lane count and of scheduling.
        let sse = 0, count = 0;
        for (let i = 0; i < nTracks; i++) { sse += sseByTrack[i]; count += cntByTrack[i]; }

        const next = count ? Math.sqrt(sse / count) : Infinity;
        if (Math.abs(rms - next) < O.refineTolerance) { rms = next; converged = true; break; }
        rms = next;
    }

    checkAbort();
    onProgress({iteration: iterations, iterations: O.refineIterations, phase: "directions"});

    // --- the settled reference direction for every track ---
    broadcastRound(lanes, gen, map, states);
    const refFlat = new Float64Array(nTracks * 3).fill(NaN);
    await scatter(lanes, gen, "refs", nTracks, (r) => refFlat.set(r.dirs, r.lo * 3));

    const refs = unpackMap(refFlat, nTracks);
    // The write-back, last and all at once, so an abort mid-solve leaves the tracks with the
    // directions they came in with rather than a half-updated set.
    for (let i = 0; i < nTracks; i++) tracks[i].ref = refs[i];

    return {states, map: unpackMap(map, nTracks), rms, iterations, converged, refs};
}
