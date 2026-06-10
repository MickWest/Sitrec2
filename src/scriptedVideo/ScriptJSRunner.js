// ScriptJSRunner.js — the Scripted Video scheduling kernel.
//
// The script language IS JavaScript, but the script never runs during playback:
// it is executed once, instantly, against a record-only API to produce the
// {events, cameraBeats, totalDuration, errors, numLanes} model that playback,
// the timeline widget, the camera engine and the renderer consume. A virtual
// clock stands in for time:
//
//   zoom("A", 6)          records an event at the current clock, returns a handle
//   await handle          advances the clock to that event's end (never backward)
//   sleep(n)              advances the clock by n, records nothing (await optional)
//   await all(a, b, ...)  advances to the latest end of several handles
//   at(off, fn)           runs fn() with the clock temporarily off seconds ahead
//   atStart(h, off, fn)   the same, relative to handle h's START (sugar &N lines)
//   wait(n)               is a COMMAND (visible camera-hold bar); sleep is invisible
//
// So the presence or absence of `await` is the concurrency syntax: un-awaited
// commands run concurrently, awaited ones are sequential. DSL-flavored lines
// (`zoom OE-LNC 6`, `& text "cap" 4`, `# comment`) are rewritten into JS by
// ScriptSugar.js before compilation, which keeps old saved scripts working.
//
// Each recorded event carries its source call site ({line, col}, captured via
// ScriptJSCallSites.js) so the timeline and wheel-editing can map back to the
// text; a literal inside a loop maps to all the events it produced.
//
// Guards: an API-call cap and a wall-clock cap abort runaway loops that call
// the API. A while(true){} that never calls the API can still hang the page —
// running this pass in a Worker is planned hardening, not yet done.

import {COMMANDS, COMMAND_ALIASES, buildEvent} from "./ScriptCommands";
import {desugarScript} from "./ScriptSugar";
import {AsyncFunction, PRELUDE, makeCallSiteRecorder} from "./ScriptJSCallSites";

const MAX_CALLS = 5000;     // API calls per run (events can't exceed this)
const MAX_RUN_MS = 2000;    // wall-clock budget for the scheduling run

class CScriptAbort extends Error {}

// Assign each timed event to a horizontal "lane" so overlapping events stack on
// separate rows in the timeline display. Returns the lane count.
export function assignLanes(events) {
    const timed = events.filter((e) => e.dur > 0).sort((a, b) => a.start - b.start || a.line - b.line);
    const laneEnds = [];
    for (const e of timed) {
        let placed = false;
        for (let i = 0; i < laneEnds.length; i++) {
            if (e.start >= laneEnds[i] - 1e-6) { e._lane = i; laneEnds[i] = e.start + e.dur; placed = true; break; }
        }
        if (!placed) { e._lane = laneEnds.length; laneEnds.push(e.start + e.dur); }
    }
    return Math.max(1, laneEnds.length);
}

// which friendly view name is active at time t (last "view" cut at or before t)
export function activeViewAt(events, defaultView, t) {
    let v = defaultView;
    for (const e of events) {
        if (e.type === "view" && e.start <= t + 1e-6) v = e.view;
    }
    return v;
}

// Run a script. Resolves in microtasks (no real timers are ever awaited) with
// {events, cameraBeats, totalDuration, errors, errorDetails, numLanes}.
// errors are display strings ("line N: msg"); errorDetails are machine-readable
// {line, col, message} for agents and future editor squiggles.
// opts.viewPresets = the app's CustomManager.viewPresets, so view("ThreeWide")
// can validate preset names at parse time (pure callers just omit it).
export async function runScriptJS(text, opts = {}) {
    const ctx = {viewPresets: opts.viewPresets || {}};
    const {code, lineInfo} = desugarScript(text);
    const events = [], cameraBeats = [], errors = [], errorDetails = [];
    let clock = 0, maxEnd = 0, aborted = false, calls = 0;
    const rec = makeCallSiteRecorder();
    const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
    const t0 = now();

    const pushError = (site, msg) => {
        errors.push(site ? `line ${site.line}: ${msg}` : msg);
        errorDetails.push({line: site?.line ?? null, col: site?.col ?? null, message: msg});
    };

    // desugar-time diagnostics (e.g. a DSL-shaped line with an unknown command)
    lineInfo.forEach((info, i) => { if (info?.error) pushError({line: i + 1, col: 1}, info.error); });

    const guard = () => {
        if (aborted) throw new CScriptAbort("script aborted");
        aborted = (++calls > MAX_CALLS) || (now() - t0 > MAX_RUN_MS);
        if (aborted) throw new CScriptAbort(calls > MAX_CALLS
            ? `script made over ${MAX_CALLS} calls — runaway loop?`
            : "script ran too long — infinite loop?");
    };

    // a thenable command handle: awaiting it jumps the clock to its end
    const makeHandle = (start, end) => ({
        isScriptHandle: true, start, end,
        then(resolve) { clock = Math.max(clock, end); resolve(undefined); },
    });

    const apiNames = [], apiFns = [];
    const define = (name, fn) => { apiNames.push(name); apiFns.push(fn); };

    // one record-only API function per registry command
    let lastTarget;   // "assume last target": zoom OE-LNC 5 → orbit 6 180 reuses OE-LNC
    for (const type of Object.keys(COMMANDS)) {
        const def = COMMANDS[type];
        define(type, (...argv) => {
            guard();
            const {callSite, chain} = rec.capture();
            let failed = false;
            const error = (msg) => { failed = true; pushError(callSite, msg); return null; };
            // a number where the target belongs (or no args at all) means the
            // target was omitted — shift and substitute the most recent one
            const a0 = def.args[0];
            if (a0 && a0.assumeLast && (argv.length === 0 || typeof argv[0] === "number")) {
                argv = [lastTarget, ...argv];
            }
            const partial = buildEvent(type, def, argv, error, ctx);
            if (failed || !partial) return makeHandle(clock, clock);
            const e = {type, start: clock, line: callSite?.line ?? 0, callSite, chain, ...partial};
            if (e.dur == null) e.dur = 0;
            if (e.dur < 0) { pushError(callSite, `negative duration ${e.dur}s`); return makeHandle(clock, clock); }
            const info = callSite ? lineInfo[callSite.line - 1] : null;
            e.spans = info?.spans ?? {};      // sugar lines are wheel-editable
            e.offSpan = info?.offSpan ?? null;
            events.push(e);
            if (def.cameraBeat) cameraBeats.push(e);
            if (a0 && a0.assumeLast && e.target) lastTarget = e.target;
            maxEnd = Math.max(maxEnd, e.start + e.dur);
            return makeHandle(e.start, e.start + e.dur);
        });
    }
    // aliases (title→text, on→show, off→hide) share the canonical command's fn
    for (const [alias, target] of Object.entries(COMMAND_ALIASES)) {
        define(alias, apiFns[apiNames.indexOf(target)]);
    }

    define("sleep", (secs) => {
        guard();
        if (typeof secs !== "number" || !isFinite(secs)) pushError(rec.capture().callSite, "sleep(secs) needs a number");
        else clock += Math.max(0, secs);
    });
    define("all", (...hs) => {
        guard();
        const valid = hs.filter((h) => h && h.isScriptHandle);
        return makeHandle(
            valid.length ? Math.min(...valid.map((h) => h.start)) : clock,
            valid.length ? Math.max(...valid.map((h) => h.end)) : clock);
    });
    // run fn() with the clock temporarily moved; fn must be synchronous
    const runAt = (t, fn) => { const saved = clock; clock = t; try { return fn(); } finally { clock = saved; } };
    define("at", (off, fn) => { guard(); return runAt(clock + (Number(off) || 0), fn); });
    define("atStart", (h, off, fn) => { guard(); return runAt((h?.start ?? 0) + (Number(off) || 0), fn); });

    let fn;
    try {
        // __sp is the sugar spine variable (assignable parameter, initially undefined)
        fn = new AsyncFunction("__probe__", ...apiNames, "__sp", PRELUDE + "\n" + code);
    } catch (e) {
        const msg = "syntax error: " + e.message;
        return {events, cameraBeats, totalDuration: 0, errors: [msg],
            errorDetails: [{line: null, col: null, message: msg}], numLanes: 1};
    }
    try {
        await fn(rec.probe, ...apiFns, undefined);
    } catch (e) {
        if (e instanceof CScriptAbort) pushError(null, e.message);
        else pushError(rec.siteFromError(e), (e && e.message) || String(e));
    }

    // camera beats sorted by start (for latest-start-wins resolution)
    cameraBeats.sort((a, b) => a.start - b.start);
    return {events, cameraBeats, totalDuration: maxEnd, errors, errorDetails, numLanes: assignLanes(events)};
}
