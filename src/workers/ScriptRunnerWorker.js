// ScriptRunnerWorker.js — sandboxed execution of Scripted-Video scripts.
//
// The Scripted-Video "script" IS JavaScript: runScriptJS compiles the user's
// text with `new AsyncFunction(body)` and runs it once against a record-only API
// to build the timeline model. Running that in the page main world is an
// arbitrary-code-execution risk — a prompt-injected chatbot script could read
// BYOK LLM keys, hit same-origin authenticated endpoints, or touch the DOM
// (finding "B1"). Running it in a dedicated Worker structurally removes DOM,
// `window`, `document`, and `localStorage` (they don't exist in a worker).
//
// But a bare worker still has `fetch`, `XMLHttpRequest`, `WebSocket`,
// `importScripts`, `indexedDB`, `caches`, `EventSource`, and can spawn a nested
// `Worker`/`SharedWorker` — every one a cookie-bearing exfiltration/SSRF vector,
// and a nested worker would get a fresh, un-neutered global scope (the key
// bypass). So we neuter all of them here, at module-eval time, BEFORE any
// `onmessage` can arrive to compile user code. The runner and its imports are
// pure (ScriptCommands/ScriptSugar/ScriptJSCallSites/ScriptMath — no network,
// no THREE, no DOM), so neutering these cannot break a legitimate parse.
//
// Residual: dynamic `import()` cannot be deleted (it is an operator, not a
// binding); a document-level CSP `connect-src`/`worker-src` would close that and
// is recommended as an orthogonal follow-up (none exists today).

(function neuterGlobals() {
    // Independent, individually-sufficient exfil/SSRF vectors — remove every one.
    // `Worker`/`SharedWorker` are the critical ones: a child worker starts with a
    // fresh scope that would re-obtain everything we delete here.
    const DENY = [
        "fetch", "XMLHttpRequest", "WebSocket", "importScripts",
        "indexedDB", "caches", "EventSource",
        "Worker", "SharedWorker", "BroadcastChannel",
    ];
    for (const name of DENY) {
        // Force an OWN `undefined` data property on the global. This shadows the
        // binding whether it lives directly on `self` (interface objects like
        // Worker/XMLHttpRequest) OR on the prototype (operations like `fetch`,
        // getter-only attributes like `indexedDB`). Do NOT `delete` — deleting an
        // own shadow re-exposes a prototype binding underneath (this is how an
        // earlier version left `fetch`/`indexedDB` live). A getter-only inherited
        // attribute also can't be shadowed by plain assignment, so defineProperty
        // is required, not `self[name] = undefined`.
        try {
            Object.defineProperty(self, name, {value: undefined, writable: false, configurable: false});
        } catch (e) {
            try { self[name] = undefined; } catch (e2) { /* non-writable — ignore */ }
        }
    }
    // navigator.sendBeacon is a fire-and-forget exfil channel.
    try {
        if (self.navigator && "sendBeacon" in self.navigator) self.navigator.sendBeacon = undefined;
    } catch (e) { /* ignore */ }
})();

import {runScriptJS} from "../scriptedVideo/ScriptJSRunner";

// Protocol: main thread posts {requestId, text, viewPresets, tabs}; we reply with
// {requestId, result} where result is runScriptJS's full model. Post the WHOLE
// model in ONE message: structured clone preserves the shared object identity
// between `events` and `cameraBeats` entries only within a single postMessage,
// and the main thread relies on that identity (it mutates events in place and
// reads the poses back off cameraBeats).
self.onmessage = async (e) => {
    const {requestId, text, viewPresets, tabs} = e.data || {};
    try {
        const result = await runScriptJS(String(text ?? ""), {viewPresets: viewPresets || {}, tabs: tabs || {}});
        self.postMessage({requestId, result});
    } catch (err) {
        // Should be rare (runScriptJS catches script errors internally), but never
        // let a throw wedge the worker — return an error-shaped model instead.
        const message = (err && err.message) || String(err);
        self.postMessage({
            requestId,
            result: {
                events: [], cameraBeats: [], totalDuration: 0,
                errors: ["worker error: " + message],
                errorDetails: [{line: null, col: null, message: "worker error: " + message}],
                numLanes: 1,
            },
        });
    }
};
