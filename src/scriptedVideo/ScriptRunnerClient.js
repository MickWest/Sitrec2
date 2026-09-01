// ScriptRunnerClient.js — main-thread front door to the sandboxed script runner.
//
// Script text is compiled with `new AsyncFunction` and executed. That is arbitrary
// code, and it arrives from the sitch, so it runs ONLY inside ScriptRunnerWorker.js,
// which has no DOM/window/localStorage and has its network/storage globals neutered.
// This module owns that worker: a single long-lived instance (parses fire on nearly
// every edit / wheel drag), requestId correlation for latest-wins, and a main-thread
// watchdog that terminates and respawns the worker if a pathological script
// (`while(true){}`) wedges it — the in-worker MAX_RUN_MS/MAX_CALLS guards only fire
// when the script calls the API, so a tight non-API loop can only be killed from
// outside via terminate().
//
// THE WORKER RUNS THE SCRIPT, OR NOTHING DOES.
//
// There is deliberately no in-process fallback. Every route that used to have one —
// no Worker constructor, a worker that failed to spawn, a worker that crashed, a
// postMessage that threw — now resolves an error-shaped model instead. Those are
// exactly the conditions an attacker would try to induce: a sitch is loaded from a
// shared link and its script is parsed automatically on deserialization (see
// deserializeScriptedVideo in CScriptedVideo.js), so any path that reaches
// runScriptJS on the main thread turns a shared link into same-origin code
// execution with full DOM, storage and network access. Degrading to "run it in the
// page" is never the safe default; refusing to run is.
//
// The cost is that scripted video does not work where Worker is unavailable,
// including jsdom. That is intended — see tests/scriptRunnerWorker.test.js, which
// asserts the refusal rather than a fallback. Tests that need to exercise script
// semantics call runScriptJS from ScriptJSRunner directly, which is unchanged.

// Above the in-worker MAX_RUN_MS (2000) so a script that merely calls the API a
// lot finishes via the graceful in-worker guard; this only trips on a true CPU wedge.
const HARD_TIMEOUT_MS = 3000;

let worker = null;
let seq = 0;
const pending = new Map();   // requestId -> {resolve, timer}

function canUseWorker() {
    return typeof Worker !== "undefined";
}

// The shape runScriptJS itself returns, carrying the reason in `errors` so callers
// render it the way they render a script error. Deliberately not prefixed
// "syntax error" — CScriptedVideo.parse() treats that prefix as "keep the last good
// timeline", and a sandbox failure is not a half-typed line.
function errorModel(message) {
    return {
        events: [], cameraBeats: [], totalDuration: 0,
        errors: [message],
        errorDetails: [{line: null, col: null, message}],
        numLanes: 1,
    };
}

const NO_SANDBOX = "script sandbox unavailable — the script was NOT run";

function disposeWorker() {
    if (worker) {
        worker.onmessage = null;
        worker.onerror = null;
        worker.terminate();
        worker = null;
    }
}

// Resolve every in-flight request with the refusal. Used when the worker crashes
// (onerror) — the alternative is leaving those promises to time out. This used to
// re-run them in-process, which meant one induced worker crash executed EVERY
// pending script in the page.
function drainPendingToError() {
    const dead = [...pending.values()];
    pending.clear();
    for (const p of dead) {
        clearTimeout(p.timer);
        p.resolve(errorModel(NO_SANDBOX));
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
        drainPendingToError();
    };
    return worker;
}

// Parse a script into the {events, cameraBeats, totalDuration, errors,
// errorDetails, numLanes} model. Always resolves (never rejects) — errors are
// carried in the model, matching runScriptJS's own contract.
export async function runScriptViaWorker(text, opts = {}) {
    const viewPresets = opts.viewPresets || {};
    const tabs = opts.tabs || {};   // other script tabs, for the include command
    const scriptText = String(text ?? "");

    if (!canUseWorker()) {
        return errorModel(NO_SANDBOX);
    }

    let w;
    try {
        w = ensureWorker();
    } catch (err) {
        console.warn("[ScriptRunner] worker spawn failed; refusing to run:", err);
        return errorModel(NO_SANDBOX);
    }

    const requestId = ++seq;
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            pending.delete(requestId);
            console.warn("[ScriptRunner] script timed out — terminating worker");
            disposeWorker();            // kill the wedged worker; next call respawns
            resolve(errorModel("script ran too long — infinite loop?"));
        }, HARD_TIMEOUT_MS);

        pending.set(requestId, {resolve, timer});

        try {
            w.postMessage({requestId, text: scriptText, viewPresets, tabs});
        } catch (err) {
            // e.g. viewPresets not structured-cloneable — refuse rather than degrade.
            clearTimeout(timer);
            pending.delete(requestId);
            console.warn("[ScriptRunner] postMessage failed; refusing to run:", err);
            resolve(errorModel(NO_SANDBOX));
        }
    });
}

// For tests / teardown.
export function terminateScriptRunnerWorker() {
    for (const p of pending.values()) clearTimeout(p.timer);
    pending.clear();
    disposeWorker();
}
