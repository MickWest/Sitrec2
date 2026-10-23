// Main-thread half of the post-detection solve: solveAfterDetection in a Web Worker. See
// StarSolveJob.js for why, and for how the result comes back identical to the synchronous call.
//
// One worker per solve, terminated when it ends, whichever way it ends. A run does this solve
// once, and against most of a minute of work the worker's startup is nothing - so there is no
// pool to keep warm and no stale reply from an earlier run to tell apart.
//
// ABORT. The solve cannot be interrupted from inside - a refinement iteration is one synchronous
// block - so an abort TERMINATES the worker. `shouldAbort` is polled on a timer as well as on
// every message, so it is answered within a fraction of a second even in a stretch of the solve
// that reports nothing.
//
// FALLBACK. No Worker (Jest, non-browser) or a Worker that cannot be created: the same job runs on
// this thread, as it always used to - the same answer, with the page unresponsive until it ends.
// A worker that starts and then FAILS is not retried that way: it is reported as a failure, since
// the fallback is the minute of frozen page this exists to avoid.

import {relinkDetections, solveAfterDetection, throttleProgress} from "./StarSolveJob";

const ABORT_POLL_MS = 100;

/**
 * solveAfterDetection, in a worker when one is available.
 *
 * @param {Array<Array>} perFrame - accepted detections per analysed frame
 * @param {object} opts - solveStarField's options; plain data, so it can be posted
 * @param {object} hooks
 *   `onProgress(stage, fraction)` - stage "chain" then "field"; fraction is of the whole solve
 *   `shouldAbort()` - true to stop: the worker is terminated and the promise resolves null
 *   `onYield()` - the fallback awaits it between the two halves, so the page can repaint
 * @returns {Promise<{chain: object, solved: object}|null>} null only if aborted; rejects on failure
 */
export async function solveAfterDetectionOffThread(perFrame, opts = {}, hooks = {}) {
    const onProgress = hooks.onProgress || (() => {});
    const shouldAbort = hooks.shouldAbort || (() => false);

    let worker = null;
    // A single frame - a still, or a one-frame run - solves in well under a millisecond, and the
    // tweak optimizer runs those back to back: a worker would only add its startup.
    if (typeof Worker !== "undefined" && perFrame.length > 1) {
        try {
            worker = new Worker(new URL("../workers/StarSolveWorker.js", import.meta.url), {type: "module"});
        } catch (e) {
            console.warn("[StarTrack] solve worker failed to start; solving on the main thread", e);
        }
    }
    if (!worker) {
        return solveAfterDetection(perFrame, opts, {onProgress: throttleProgress(onProgress), onYield: hooks.onYield});
    }

    return new Promise((resolve, reject) => {
        let poll = null;
        const finish = (settle, value) => {
            clearInterval(poll);
            worker.onmessage = worker.onerror = worker.onmessageerror = null;
            worker.terminate();
            settle(value);
        };
        const abortIfAsked = () => {
            if (!shouldAbort()) return false;
            finish(resolve, null);
            return true;
        };

        worker.onmessage = (e) => {
            if (abortIfAsked()) return;
            const msg = e.data;
            if (msg.type === "progress") {
                onProgress(msg.stage, msg.fraction);
            } else if (msg.type === "done") {
                relinkDetections(msg.relink, perFrame);
                finish(resolve, msg.result);
            } else if (msg.type === "error") {
                finish(reject, new Error(`star solve worker: ${msg.message}`));
            }
        };
        // A worker that fails to load (a missing chunk after a rebuild) or dies outside the
        // handler's own try reports here, and the solve has nothing more to say: fail rather than
        // wait for a reply that will never come.
        worker.onerror = (e) => {
            finish(reject, new Error(`star solve worker: ${(e && e.message) || "failed to load or crashed"}`));
        };
        worker.onmessageerror = () => {
            finish(reject, new Error("star solve worker: a reply could not be read"));
        };

        poll = setInterval(abortIfAsked, ABORT_POLL_MS);
        try {
            worker.postMessage({type: "solve", perFrame, opts});
        } catch (e) {
            finish(reject, e);
        }
    });
}
