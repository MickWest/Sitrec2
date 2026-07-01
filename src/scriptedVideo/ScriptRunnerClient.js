// ScriptRunnerClient.js — main-thread front door to the sandboxed script runner.
//
// runScriptJS compiles user script text with `new AsyncFunction` and executes it.
// To keep that arbitrary code off the main thread (finding "B1"), the real run
// happens in ScriptRunnerWorker.js, which has no DOM/window/localStorage and has
// its network/storage globals neutered. This module owns that worker: a single
// long-lived instance (parses fire on nearly every edit / wheel drag), requestId
// correlation for latest-wins, and a main-thread watchdog that terminates and
// respawns the worker if a pathological script (`while(true){}`) wedges it — the
// in-worker MAX_RUN_MS/MAX_CALLS guards only fire when the script calls the API,
// so a tight non-API loop can only be killed from outside via terminate().
//
// Fallbacks preserve functionality where the worker can't run: no Worker (Jest /
// non-browser) or a worker that failed to spawn/crashed → run in-process. A
// hard-timeout does NOT fall back in-process (that would hang the page with the
// same pathological script) — it returns an error-shaped model.

import {runScriptJS} from "./ScriptJSRunner";

// Above the in-worker MAX_RUN_MS (2000) so a script that merely calls the API a
// lot finishes via the graceful in-worker guard; this only trips on a true CPU wedge.
const HARD_TIMEOUT_MS = 3000;

let worker = null;
let seq = 0;
const pending = new Map();   // requestId -> {resolve, timer, text, viewPresets}

function canUseWorker() {
    return typeof Worker !== "undefined";
}

function timeoutModel(message) {
    return {
        events: [], cameraBeats: [], totalDuration: 0,
        errors: [message],
        errorDetails: [{line: null, col: null, message}],
        numLanes: 1,
    };
}

function disposeWorker() {
    if (worker) {
        worker.onmessage = null;
        worker.onerror = null;
        worker.terminate();
        worker = null;
    }
}

// Resolve every in-flight request by running it in-process. Used when the worker
// crashes (onerror) — the alternative is leaving those promises to time out.
function drainPendingToFallback() {
    const dead = [...pending.values()];
    pending.clear();
    for (const p of dead) {
        clearTimeout(p.timer);
        Promise.resolve(runScriptJS(p.text, {viewPresets: p.viewPresets})).then(p.resolve);
    }
}

function ensureWorker() {
    if (worker) return worker;
    worker = new Worker(new URL("../workers/ScriptRunnerWorker.js", import.meta.url));
    worker.onmessage = (e) => {
        const {requestId, result} = e.data || {};
        const p = pending.get(requestId);
        if (!p) return;                 // stale (superseded / already timed out) — drop
        clearTimeout(p.timer);
        pending.delete(requestId);
        p.resolve(result);
    };
    worker.onerror = (e) => {
        console.warn("[ScriptRunner] worker error:", (e && e.message) || e);
        disposeWorker();                // will respawn lazily on the next call
        drainPendingToFallback();
    };
    return worker;
}

// Parse a script into the {events, cameraBeats, totalDuration, errors,
// errorDetails, numLanes} model. Always resolves (never rejects) — errors are
// carried in the model, matching runScriptJS's own contract.
export async function runScriptViaWorker(text, opts = {}) {
    const viewPresets = opts.viewPresets || {};
    const scriptText = String(text ?? "");

    if (!canUseWorker()) {
        return runScriptJS(scriptText, {viewPresets});     // Jest / non-browser
    }

    let w;
    try {
        w = ensureWorker();
    } catch (err) {
        console.warn("[ScriptRunner] worker spawn failed; running in-process:", err);
        return runScriptJS(scriptText, {viewPresets});
    }

    const requestId = ++seq;
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            pending.delete(requestId);
            console.warn("[ScriptRunner] script timed out — terminating worker");
            disposeWorker();            // kill the wedged worker; next call respawns
            resolve(timeoutModel("script ran too long — infinite loop?"));
        }, HARD_TIMEOUT_MS);

        pending.set(requestId, {resolve, timer, text: scriptText, viewPresets});

        try {
            w.postMessage({requestId, text: scriptText, viewPresets});
        } catch (err) {
            // e.g. viewPresets not structured-cloneable — degrade gracefully.
            clearTimeout(timer);
            pending.delete(requestId);
            console.warn("[ScriptRunner] postMessage failed; running in-process:", err);
            Promise.resolve(runScriptJS(scriptText, {viewPresets})).then(resolve);
        }
    });
}

// For tests / teardown.
export function terminateScriptRunnerWorker() {
    for (const p of pending.values()) clearTimeout(p.timer);
    pending.clear();
    disposeWorker();
}
