// Main-thread half of Bright Triples: identifyBrightTriples in a Web Worker.
//
// At the default (magnitude 3, the whole sky, a 101 deg field) the catalog has about 255,000
// triples and the run takes about two seconds - long enough to freeze the page on this thread.
//
// One worker per run, terminated when it ends, whichever way it ends, as StarSolveOffThread does.
// ABORT terminates the worker: the matcher cannot be interrupted from inside. `shouldAbort` is
// polled on a timer as well as on every message.
//
// FALLBACK. No Worker (Jest, non-browser) or one that cannot be created: the same run on this
// thread, with the same answer. A worker that starts and then fails is reported as a failure.

import {identifyBrightTriples} from "./StarTriples";

const ABORT_POLL_MS = 100;

/**
 * identifyBrightTriples, in a worker when one is available.
 *
 * @param {object} args - identifyBrightTriples's arguments, without onProgress; plain data
 * @param {object} hooks
 *   `onProgress(stage, fraction)` - stage "catalog" then "match"
 *   `shouldAbort()` - true to stop: the worker is terminated and the promise resolves null
 * @returns {Promise<object|null>} the result, or null if aborted; rejects on failure
 */
export async function identifyBrightTriplesOffThread(args, hooks = {}) {
    const onProgress = hooks.onProgress || (() => {});
    const shouldAbort = hooks.shouldAbort || (() => false);

    let worker = null;
    if (typeof Worker !== "undefined") {
        try {
            worker = new Worker(new URL("../workers/BrightTriplesWorker.js", import.meta.url), {type: "module"});
        } catch (e) {
            console.warn("[Bright Triples] worker failed to start; running on the main thread", e);
        }
    }
    if (!worker) return identifyBrightTriples({...args, onProgress});

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
            if (msg.type === "progress") onProgress(msg.stage, msg.fraction);
            else if (msg.type === "done") finish(resolve, msg.result);
            else if (msg.type === "error") finish(reject, new Error(`Bright Triples worker: ${msg.message}`));
        };
        // A worker that fails to load (a missing chunk after a rebuild) or dies outside the
        // handler's own try reports here, and there will be no reply.
        worker.onerror = (e) => {
            finish(reject, new Error(`Bright Triples worker: ${(e && e.message) || "failed to load or crashed"}`));
        };
        worker.onmessageerror = () => {
            finish(reject, new Error("Bright Triples worker: a reply could not be read"));
        };
        poll = setInterval(abortIfAsked, ABORT_POLL_MS);
        try {
            worker.postMessage({type: "run", args});
        } catch (e) {
            finish(reject, e);
        }
    });
}
