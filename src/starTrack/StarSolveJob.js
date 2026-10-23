// The post-detection solve as one job: solveFrameChain, then solveStarField. Shared by the worker
// that runs it off the UI thread (src/workers/StarSolveWorker.js, a shim around
// handleStarSolveMessage below) and by the main-thread fallback in StarSolveOffThread.js.
//
// WHY A WORKER. On a 3247-frame clip the two solves take most of a minute, and they ran
// synchronously on the UI thread: the progress bar sat still, Abort could not be clicked, and the
// browser offered to stop the script - which, taken, skipped the run's cleanup and left the page
// blocked behind its own progress overlay.
//
// IDENTICAL, NOT EQUIVALENT. The worker runs the same solver source on a structured clone of the
// detections, and a structured clone keeps every number bit for bit, the order of every array,
// and every object shared WITHIN the message. What it cannot keep is identity with objects the
// main thread already holds: each observation's `src` is the detector record it came from, which
// the UI reads photometry and shape off, and a clone would hand it copies. So before replying the
// worker cuts every reference to an input detection out of the result (detachDetections) and the
// main thread puts the originals back (relinkDetections). The result the UI sees is then the one
// the synchronous call returned - same numbers, same order, same object sharing - and the
// detections are not cloned twice.
//
// Pure: no DOM, no THREE, no Sitrec globals.

import {solveFrameChain} from "./StarMatch";
import {solveStarField} from "./StarSolve";

// The chain's share of the whole solve, measured on a synthetic 3247-frame clip: 24.8 s of 53.6 s.
export const CHAIN_SHARE = 0.46;

// At most one progress report per stage per this many ms. The solver reports every frame and
// every iteration; a message per report would cost more than the bar is worth.
export const PROGRESS_INTERVAL_MS = 80;

/**
 * Wrap onProgress(stage, fraction) so it passes at most one report per `intervalMs` - except the
 * first report of a new stage, which always passes so the stage name changes when the stage does,
 * and the final one (fraction 1), which always passes so the bar ends full. The solve's last
 * stages are short, so the final report would otherwise usually fall inside the interval.
 */
export function throttleProgress(onProgress, intervalMs = PROGRESS_INTERVAL_MS, clock = Date.now) {
    let last = -Infinity, lastStage = null;
    return (stage, fraction) => {
        const now = clock();
        if (stage === lastStage && fraction < 1 && now - last < intervalMs) return;
        last = now;
        lastStage = stage;
        onProgress(stage, fraction);
    };
}

/**
 * The solve after detection, here on this thread: exactly the two calls the Star Tracker always
 * made, with progress.
 *
 * @param {Array<Array>} perFrame - accepted detections per analysed frame
 * @param {object} opts - solveStarField's options (solveFrameChain runs on its defaults)
 * @param {object} hooks
 *   `onProgress(stage, fraction)` - stage "chain" then "field"; fraction is of the WHOLE solve
 *   `onYield()` - awaited between the two halves, so a caller on the UI thread can repaint
 * @returns {Promise<{chain: object, solved: object}>}
 */
export async function solveAfterDetection(perFrame, opts = {}, {onProgress = () => {}, onYield = null} = {}) {
    const chain = solveFrameChain(perFrame, {}, (f) => onProgress("chain", CHAIN_SHARE * f));
    onProgress("field", CHAIN_SHARE);
    if (onYield) await onYield();
    const solved = solveStarField(perFrame, chain.cumulative, opts,
        (f) => onProgress("field", CHAIN_SHARE + (1 - CHAIN_SHARE) * f));
    return {chain, solved};
}

/**
 * Cut every reference to an input detection out of `result`, in place, and say where each was.
 *
 * Walks the whole result rather than only the places detections are known to be (today, each
 * observation's `src`), so a solver change that keeps a detection somewhere new is re-linked too
 * instead of quietly arriving as a copy. Each reference becomes null, and is recorded as its
 * holder, its key, and the detection's frame and index - the holder is an object INSIDE the
 * result, and posting the result and this record in one message keeps it the same object on the
 * other side.
 *
 * @returns {{holders: Array, keys: Array, frames: Int32Array, indices: Int32Array}}
 */
export function detachDetections(result, perFrame) {
    const where = new Map();
    for (let f = 0; f < perFrame.length; f++) {
        for (let i = 0; i < perFrame[f].length; i++) where.set(perFrame[f][i], [f, i]);
    }
    const holders = [], keys = [], frames = [], indices = [];
    const visit = (holder, key, stack) => {
        const v = holder[key];
        if (v === null || typeof v !== "object") return;
        const at = where.get(v);
        if (!at) { stack.push(v); return; }
        holders.push(holder); keys.push(key); frames.push(at[0]); indices.push(at[1]);
        holder[key] = null;
    };
    const seen = new Set();
    const stack = [result];
    while (stack.length) {
        const obj = stack.pop();
        if (seen.has(obj) || ArrayBuffer.isView(obj)) continue;
        seen.add(obj);
        if (obj instanceof Set || obj instanceof Map) {
            // No holder/key to put a detection back through. None of the solver's Sets or Maps
            // hold one; if one ever does, failing loudly beats returning a copy.
            for (const v of (obj instanceof Map ? [...obj.keys(), ...obj.values()] : obj)) {
                if (where.has(v)) throw new Error("a detection inside a Set or Map cannot be re-linked");
                if (v !== null && typeof v === "object") stack.push(v);
            }
        } else if (Array.isArray(obj)) {
            for (let i = 0; i < obj.length; i++) visit(obj, i, stack);
        } else {
            for (const key of Object.keys(obj)) visit(obj, key, stack);
        }
    }
    return {holders, keys, frames: Int32Array.from(frames), indices: Int32Array.from(indices)};
}

/** Put the original detections back where detachDetections cut them out. */
export function relinkDetections(relink, perFrame) {
    const {holders, keys, frames, indices} = relink;
    for (let k = 0; k < holders.length; k++) holders[k][keys[k]] = perFrame[frames[k]][indices[k]];
}

/**
 * The worker's message handler, as a plain function: the worker binds it to self.onmessage, and
 * the tests call it directly.
 *
 * In: {type: "solve", perFrame, opts}. Out, through post(message, transfer): any number of
 * {type: "progress", stage, fraction}, then one {type: "done", result, relink} or
 * {type: "error", message}. An error is reported rather than thrown, so the main thread gets a
 * reason instead of an opaque `onerror`.
 */
export async function handleStarSolveMessage(msg, post, clock = Date.now) {
    if (!msg || msg.type !== "solve") return;
    try {
        const onProgress = throttleProgress((stage, fraction) =>
            post({type: "progress", stage, fraction}), PROGRESS_INTERVAL_MS, clock);
        const result = await solveAfterDetection(msg.perFrame, msg.opts, {onProgress});
        const relink = detachDetections(result, msg.perFrame);
        post({type: "done", result, relink}, [relink.frames.buffer, relink.indices.buffer]);
    } catch (err) {
        post({type: "error", message: (err && err.message) || String(err)});
    }
}
