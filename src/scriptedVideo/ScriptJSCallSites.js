// ScriptJSCallSites.js — source call-site capture for the Scripted Video JS frontend.
//
// The JS script never runs during playback: it is executed once, instantly, with
// a record-only API to build the event timeline. For timeline↔editor
// cross-highlighting and wheel-editing of numeric arguments we need to know WHERE
// in the source text each recorded API call was written.
//
// V8 (Chrome/Edge/Node) reports frames inside `new AsyncFunction(...)` code as
// "<anonymous>:line:col". The wrapper V8 builds around the body shifts line
// numbers by an engine-defined amount, so instead of hardcoding that offset we
// compile a one-line prelude containing a probe call and measure the probe's
// reported line during the same run; user position = raw position - probe line.
// Engines with a different stack format (Safari/Firefox) yield no frames here —
// capture() returns nulls and the caller must fall back to order-based matching.

export const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// the eval-script position in a V8 frame, e.g.
//   "    at eval (eval at <anonymous> (http://x/y.js:1:2), <anonymous>:5:11)"
//   "    at shot (eval at <anonymous> (...), <anonymous>:2:9)"
//   "    at async <anonymous>:7:1"            (V8 async stack trace frame)
// Requires ":digits:digits" directly after "<anonymous>", which real-file frames
// like "at Object.<anonymous> (/path/file.js:1:2)" never have.
const FRAME_RE = /<anonymous>:(\d+):(\d+)\)?\s*$/;

// Every frame of `stack` that lies inside compiled user code, nearest call first,
// in raw (wrapper-offset) coordinates. [] on non-V8 stack formats.
export function rawUserFrames(stack) {
    const frames = [];
    for (const ln of String(stack || "").split("\n")) {
        const m = FRAME_RE.exec(ln);
        if (m) frames.push({line: +m[1], col: +m[2]});
    }
    return frames;
}

// First body line of every compiled script: strict mode + the calibration probe.
// MUST stay one line so user line N is body line N+1.
export const PRELUDE = '"use strict";__probe__();';

// Compile user script text into an AsyncFunction(probe, ...apiFns).
// Throws SyntaxError (with V8 positions relative to the wrapper) on bad input.
export function compileScript(text, apiNames) {
    return new AsyncFunction("__probe__", ...apiNames, PRELUDE + "\n" + text);
}

// A recorder is created per scheduling run. Pass `probe` as the AsyncFunction's
// first argument; call `capture()` at the top of each record-only API function.
// callSite = the frame nearest the API call (where the literal arguments live);
// chain = all user-code frames outward (call inside a helper → [helper line,
// invocation line, ...]), letting one literal map to every segment it produced.
export function makeCallSiteRecorder() {
    let probeLine = null;
    return {
        probe() {
            const f = rawUserFrames(new Error().stack);
            probeLine = f.length ? f[0].line : null;
        },
        capture() {
            if (probeLine === null) return {callSite: null, chain: []};
            const chain = rawUserFrames(new Error().stack)
                .map((f) => ({line: f.line - probeLine, col: f.col}))
                .filter((f) => f.line >= 1);   // drop prelude/wrapper frames
            return {callSite: chain[0] ?? null, chain};
        },
        // map a thrown error's stack to its user-script position (null if unknown)
        siteFromError(err) {
            if (probeLine === null) return null;
            const f = rawUserFrames(err && err.stack)
                .map((x) => ({line: x.line - probeLine, col: x.col}))
                .filter((x) => x.line >= 1);
            return f[0] ?? null;
        },
    };
}
