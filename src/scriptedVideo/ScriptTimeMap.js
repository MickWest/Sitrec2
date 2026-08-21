// ScriptTimeMap.js — the compiled screen-time → world-frame map.
//
// The old model had ONE global mapping: world frame was a linear function of position
// within the script (`t / totalDuration * (frames - 1)`). That made script length the
// only speed control, and it was global — so lengthening any shot re-timed every other
// shot, and dwelling, replaying, freezing or slowing a moment were all inexpressible.
//
// Here the script compiles to an ordered list of SEGMENTS, each with its own screen
// range and its own source (world) range. The two are independent, which is what buys:
//
//   dwell / slow-mo   a long screen range over a short source range
//   freeze            sourceIn === sourceOut
//   replay            a later segment naming an earlier source range
//   scoping           source ranges need not cover the whole sitch
//
// Segments carry RESOLVED source frames. Nothing here derives one segment's source
// range from another's, so editing a shot cannot re-time its neighbours — the property
// the old model could not provide. Authoring shorthands (a running "rate", "continue
// from the previous shot") are resolved by the compiler into explicit numbers before
// they get here; they are never runtime state.

import {clamp} from "./ScriptMath";

// One compiled piece of the timeline. screenIn/screenOut are seconds of finished video;
// sourceIn/sourceOut are (fractional) sitch frames.
export function makeTimeSegment(screenIn, screenOut, sourceIn, sourceOut, extra = {}) {
    return {
        screenIn, screenOut, sourceIn, sourceOut,
        // "cut" | "continue" — whether the camera carries over from the previous
        // segment. Phase 2 consumes this; recorded now so the compiled shape is stable.
        transition: extra.transition ?? "continue",
        id: extra.id,
        label: extra.label,
    };
}

export class ScriptTimeMap {
    // `segments` must be ordered by screenIn and non-overlapping. `frames` is the sitch
    // length, used only to clamp and to build the degenerate fallback.
    constructor(segments, frames = 1) {
        this.frames = Math.max(1, frames);
        this.lastFrame = this.frames - 1;
        this.segments = (segments ?? []).filter(s => s && s.screenOut > s.screenIn);
    }

    get isEmpty() {
        return this.segments.length === 0;
    }

    // Total screen duration covered. Not necessarily the script's totalDuration —
    // concurrent (&) events can overhang the last camera beat.
    get screenDuration() {
        return this.isEmpty ? 0 : this.segments[this.segments.length - 1].screenOut;
    }

    // The segment containing screen time t. Before the first segment returns the first,
    // after the last returns the last, so frameAt() clamps rather than failing.
    segmentAt(t) {
        const segs = this.segments;
        if (segs.length === 0) return null;
        if (t <= segs[0].screenIn) return segs[0];

        // linear scan: shot counts are in the tens, and this is called per rendered
        // frame, so a binary search would be optimising the wrong thing
        for (let i = segs.length - 1; i >= 0; i--) {
            if (t >= segs[i].screenIn) return segs[i];
        }
        return segs[0];
    }

    // Screen seconds → fractional sitch frame.
    frameAt(t) {
        const seg = this.segmentAt(t);
        if (seg === null) return 0;

        const span = seg.screenOut - seg.screenIn;
        // A zero-width screen span cannot be interpolated across; take its start.
        if (span <= 0) return clamp(seg.sourceIn, 0, this.lastFrame);

        const f = clamp((t - seg.screenIn) / span, 0, 1);
        const frame = seg.sourceIn + (seg.sourceOut - seg.sourceIn) * f;
        return clamp(frame, 0, this.lastFrame);
    }

    // How fast world time is running here, in source frames per screen second. Zero for a
    // freeze, negative for a reversed segment. Commands that need PLAYBACK velocity (as
    // opposed to the world tangent at a frame) must scale by this — see
    // CScriptedVideo.sitFrameRateAt.
    rateAt(t) {
        const seg = this.segmentAt(t);
        if (seg === null) return 0;
        const span = seg.screenOut - seg.screenIn;
        if (span <= 0) return 0;
        return (seg.sourceOut - seg.sourceIn) / span;
    }

    // True when this is a single segment running the whole sitch start-to-end — i.e.
    // indistinguishable from the old global mapping. Used to keep the untouched-script
    // path provably identical.
    get isUniform() {
        return this.segments.length === 1;
    }

    // Compiled shape for the agent manifest / editor. Plain data, no live references.
    describe() {
        return this.segments.map((s, i) => ({
            index: i,
            id: s.id ?? null,
            label: s.label ?? null,
            screenIn: s.screenIn,
            screenOut: s.screenOut,
            sourceIn: s.sourceIn,
            sourceOut: s.sourceOut,
            transition: s.transition,
            // frames of world per second of screen; 0 = frozen, <0 = reversed
            rate: (s.screenOut > s.screenIn)
                ? (s.sourceOut - s.sourceIn) / (s.screenOut - s.screenIn)
                : 0,
        }));
    }
}

// ---------------------------------------------------------------------------------
// Source-time parsing
//
// A source time may be written as:
//    164          seconds into the sitch
//    "164.5"      the same, as a string
//    "f4920"      an explicit (fractional) sitch frame
//    "23:04:39"   a wall clock in the sitch's display timezone, on the sitch's start date
//    "1973-10-19T03:02:00Z"   an absolute instant
// Returns a fractional frame, or {error} — never a silent fallback, because a
// mis-parsed source time would silently show the wrong moment.
export function parseSourceTime(v, {fps = 30, frames = 1, startTimeMS = 0, tzOffsetMinutes = 0} = {}) {
    const last = Math.max(0, frames - 1);
    const bad = (msg) => ({error: `bad source time ${JSON.stringify(v)}: ${msg}`});

    if (typeof v === "number") {
        if (!Number.isFinite(v)) return bad("not finite");
        return {frame: v * fps};
    }
    if (typeof v !== "string") return bad("expected a number or string");

    const s = v.trim();
    if (s === "") return bad("empty");

    // explicit frame
    const mf = s.match(/^f(-?\d+(?:\.\d+)?)$/i);
    if (mf) return {frame: parseFloat(mf[1])};

    // plain seconds
    if (/^-?\d+(\.\d+)?$/.test(s)) return {frame: parseFloat(s) * fps};

    // wall clock HH:MM:SS[.mmm] on the sitch's start date, in its display timezone
    const mc = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?$/);
    if (mc) {
        const h = +mc[1], m = +mc[2], sec = mc[3] !== undefined ? parseFloat(mc[3]) : 0;
        if (h > 23 || m > 59 || sec >= 60) return bad("out of range");
        // local midnight of the sitch's start date, as UTC ms
        const startLocal = startTimeMS + tzOffsetMinutes * 60000;
        const dayLocal = Math.floor(startLocal / 86400000) * 86400000;
        let targetUTC = dayLocal + (h * 3600 + m * 60 + sec) * 1000 - tzOffsetMinutes * 60000;
        // a clock earlier than the start is assumed to be the following day — sitches
        // that cross local midnight are normal (the Coyne case starts at 23:02)
        if (targetUTC < startTimeMS - 1) targetUTC += 86400000;
        return {frame: ((targetUTC - startTimeMS) / 1000) * fps};
    }

    // absolute instant
    const ms = Date.parse(s);
    if (!Number.isNaN(ms)) return {frame: ((ms - startTimeMS) / 1000) * fps};

    return bad("unrecognised format");
}

// ---------------------------------------------------------------------------------
// Compile camera beats that carry explicit source windows into a ScriptTimeMap.
//
// Every beat MUST declare its window. There is deliberately no implicit baseline: an
// omitted window is an error, not a default. That is what makes the schedule fully
// explicit, so nothing about one shot can be derived from — and therefore perturbed
// by — any other shot.
//
// `beats` are {start, dur, source:{from,to}, id, label, transition}. Returns
// {map, errors}; `map` is null when anything failed to compile.
export function compileTimeMap(beats, opts = {}) {
    const frames = Math.max(1, opts.frames ?? 1);
    const last = frames - 1;
    const errors = [];
    const segments = [];

    for (const b of (beats ?? [])) {
        const where = b.label ? `"${b.label}"` : `shot at ${b.start}s`;

        if (!b.source || b.source.from === undefined || b.source.to === undefined) {
            errors.push(`${where}: no source window — every shot must declare one, e.g. `
                + `world 23:04:39..23:04:49`);
            continue;
        }

        const a = parseSourceTime(b.source.from, opts);
        const z = parseSourceTime(b.source.to, opts);
        if (a.error) { errors.push(`${where}: ${a.error}`); continue; }
        if (z.error) { errors.push(`${where}: ${z.error}`); continue; }

        // Outside the sitch is an ERROR, not a clamp: silently showing a different
        // moment than the author asked for is the worst possible failure here.
        for (const [name, r] of [["from", a], ["to", z]]) {
            if (r.frame < -0.5 || r.frame > last + 0.5) {
                errors.push(`${where}: source ${name} is frame ${r.frame.toFixed(1)}, `
                    + `outside the sitch (0..${last})`);
            }
        }

        segments.push(makeTimeSegment(b.start, b.start + b.dur, a.frame, z.frame, {
            id: b.id, label: b.label,
            transition: b.transition ?? "cut",
        }));
    }

    segments.sort((p, q) => p.screenIn - q.screenIn);

    for (let i = 1; i < segments.length; i++) {
        if (segments[i].screenIn < segments[i - 1].screenOut - 1e-6) {
            errors.push(`shots overlap in screen time at ${segments[i].screenIn}s`);
        }
    }

    if (errors.length) return {map: null, errors};
    return {map: new ScriptTimeMap(segments, frames), errors};
}

// The old behaviour, as one explicit segment: the whole script spans the whole sitch.
// `aFrame`/`bFrame` are honoured here — the previous mapper ignored them and always
// spanned 0..frames-1, so a video could not be scoped to part of a sitch.
export function uniformTimeMap(totalDuration, frames, aFrame, bFrame) {
    const last = Math.max(0, (frames ?? 1) - 1);
    const inFrame = Number.isFinite(aFrame) ? clamp(aFrame, 0, last) : 0;
    const outFrame = Number.isFinite(bFrame) ? clamp(bFrame, 0, last) : last;
    const dur = (totalDuration > 0) ? totalDuration : 0;
    if (dur <= 0) {
        return new ScriptTimeMap([], frames);
    }
    return new ScriptTimeMap(
        [makeTimeSegment(0, dur, inFrame, outFrame, {transition: "cut", label: "whole sitch"})],
        frames);
}
