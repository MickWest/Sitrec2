// maneuverTargets.js — MANEUVER-CLASS truth generators (first pass 2026-08-15;
// completed to the full thirteen-type table 2026-08-16).
//
// The track-type taxonomy: THIRTEEN shape classes from a static point through
// a figure-eight. The shapes themselves are mostly mundane (a thermalling
// raptor flies a corkscrew; an aerobatic plane flies a loop); anomalousness is
// a PARAMETER (speed, g, amplitude), not the shape — so every generator takes
// overridable parameters and records the realized peaks in its profile, ready
// for capability-ladder-style sweeps (the maneuver botsets in
// lib/botsetManeuvers.js are the first such sweep). Defaults below give one
// clearly mundane or clearly anomalous instance per kind, per the agreed table:
//   mundane: static-point, straight-cv, straight-ca, slow-turn, sine-wave,
//            corkscrew, vertical-loop, figure-eight
//   anomalous: accel-instant (speed step, no ramp), turn90-instant (infinite
//              accel), zigzag (58 g transitions), highg-turn (50 g sustained),
//              hypersonic-glide (Mach ~5)
//
// Same contract as targets.js generators: scenario ENU, origin at the target's
// initial ground point, z = height above (flat-proxy) site ground, returns
// Float64Array(3n). Deterministic; the seeded stream is used ONLY for the
// onset draws of turn90-instant and accel-instant (the "event happens in
// 20–80% of the track" rule).
// No wind coupling in this first pass: these targets are self-propelled and
// their shape IS the signal under test.

import {makeStream} from "./rng";

const G = 9.80665;
const DEG = Math.PI / 180;

function smoothstep(x) {
    const t = Math.max(0, Math.min(1, x));
    return t * t * (3 - 2 * t);
}

// Substepped integrator for the heading-rate kinds (zigzag, figure-eight,
// turn90). SUB matches targets.js/capabilityTargets.js so event profiles and
// integrated truth agree even through sharp transitions.
function integrateHeading(n, fps, {altitudeAGL, speed, psi0 = 90 * DEG, rateAt, impulseAt = null}) {
    const SUB = 40;
    const dt = 1 / fps;
    const h = dt / SUB;
    const pos = new Float64Array(n * 3);
    let x = 0, y = 0, psi = psi0, peakRate = 0;
    let impulseDone = false;
    for (let f = 0; f < n; f++) {
        pos[f * 3] = x;
        pos[f * 3 + 1] = y;
        pos[f * 3 + 2] = altitudeAGL;
        const t0 = f * dt;
        for (let s = 0; s < SUB; s++) {
            const t = t0 + s * h;
            if (impulseAt !== null && !impulseDone && t >= impulseAt.t) {
                psi += impulseAt.deltaPsi;   // instantaneous heading step, |v| preserved
                impulseDone = true;
            }
            const rate = rateAt ? rateAt(t) : 0;
            if (Math.abs(rate) > peakRate) peakRate = Math.abs(rate);
            psi += rate * h;
            x += speed * Math.sin(psi) * h;
            y += speed * Math.cos(psi) * h;
        }
    }
    return {pos, peakRate};
}

// ---- the ten kinds ---------------------------------------------------------

function staticPoint({n, p}) {
    const startAGL = p.startAGL ?? 500;
    const pos = new Float64Array(n * 3);
    for (let f = 0; f < n; f++) pos[f * 3 + 2] = startAGL;
    return {pos, profile: {startAGL}};
}

function straightCV({n, fps, p}) {
    const alt = p.altitudeAGL ?? 3000;
    const speed = p.speed ?? 100;
    const pos = new Float64Array(n * 3);
    for (let f = 0; f < n; f++) {
        pos[f * 3] = speed * (f / fps);
        pos[f * 3 + 2] = alt;
    }
    return {pos, profile: {speed}};
}

function straightCA({n, fps, p}) {
    const alt = p.altitudeAGL ?? 3000;
    const v0 = p.v0 ?? 60;
    const accel = p.accel ?? 5;               // 0.51 g longitudinal — airliner-plausible
    const pos = new Float64Array(n * 3);
    for (let f = 0; f < n; f++) {
        const t = f / fps;
        pos[f * 3] = v0 * t + 0.5 * accel * t * t;
        pos[f * 3 + 2] = alt;
    }
    const dur = (n - 1) / fps;
    return {pos, profile: {v0, accel,
        realizedPeakSpeedMS: v0 + accel * dur}};
}

// Slow, constant-radius turn: the mundane turning anchor. Constant speed and
// turn rate from frame 0 — a wide lazy circle, no event to detect.
function slowTurn({n, fps, p}) {
    const alt = p.altitudeAGL ?? 3000;
    const speed = p.speed ?? 100;
    const R = p.radiusM ?? 3000;
    const omega = speed / R;
    const {pos} = integrateHeading(n, fps, {altitudeAGL: alt, speed,
        rateAt: () => omega});
    return {pos, profile: {speed, radiusM: R,
        periodSeconds: 2 * Math.PI / omega,
        realizedPeakGLoad: omega * speed / G}};
}

// Straight line with an INSTANTANEOUS speed change — the along-track
// complement of turn90-instant (speed steps, direction holds). The onset
// follows the same 20–80% seeded rule.
function accelInstant({n, fps, p, seed, anomalous}) {
    const alt = p.altitudeAGL ?? 3000;
    const v0 = p.v0 ?? 20;
    const v1 = p.v1 ?? 200;
    const dur = (n - 1) / fps;
    const onsetSeconds = p.onsetSeconds
        ?? dur * (0.2 + 0.6 * makeStream(seed).uniform());
    const pos = new Float64Array(n * 3);
    for (let f = 0; f < n; f++) {
        const t = f / fps;
        pos[f * 3] = t < onsetSeconds
            ? v0 * t
            : v0 * onsetSeconds + v1 * (t - onsetSeconds);
        pos[f * 3 + 2] = alt;
    }
    const dv = v1 - v0;
    return {pos, profile: {v0, v1, onsetSeconds,
            deltaVMagnitudeMS: Math.abs(dv)},
        events: [{eventId: "accel-instant", family: "impulse", anomalous,
            onsetSeconds, endSeconds: onsetSeconds + 1 / fps,
            directionENU: [Math.sign(dv) || 1, 0, 0],
            parameters: {v0, v1, deltaVMS: dv}}]};
}

function turn90Instant({n, fps, p, seed, anomalous}) {
    const alt = p.altitudeAGL ?? 3000;
    const speed = p.speed ?? 120;
    const turnDeg = p.headingChangeDeg ?? 90;
    const dur = (n - 1) / fps;
    // Contract rule: the turn happens in 20–80% of the track. Drawn from the
    // target stream so the same truth key always places it identically.
    const onsetSeconds = p.onsetSeconds
        ?? dur * (0.2 + 0.6 * makeStream(seed).uniform());
    const {pos} = integrateHeading(n, fps, {altitudeAGL: alt, speed,
        impulseAt: {t: onsetSeconds, deltaPsi: -turnDeg * DEG}});   // CCW positive turn = -psi
    // Event delta-v: v1 - v0 for an east start, |v| preserved.
    const psi1 = 90 * DEG - turnDeg * DEG;
    const dv = [speed * Math.sin(psi1) - speed, speed * Math.cos(psi1)];
    const m = Math.hypot(dv[0], dv[1]) || 1;
    return {pos, profile: {speed, headingChangeDeg: turnDeg,
            onsetSeconds, deltaVMagnitudeMS: m},
        events: [{eventId: "turn90-instant", family: "impulse", anomalous,
            onsetSeconds, endSeconds: onsetSeconds + 1 / fps,
            directionENU: [dv[0] / m, dv[1] / m, 0],
            parameters: {headingChangeDeg: turnDeg, speedMS: speed}}]};
}

function zigzag({n, fps, p, anomalous}) {
    const alt = p.altitudeAGL ?? 3000;
    const speed = p.speed ?? 120;
    const swing = (p.swingDeg ?? 90) * DEG;   // total swing, ±swing/2 about east
    const period = p.periodSeconds ?? 4;
    const trans = p.transitionSeconds ?? 0.5;
    // Square-wave heading with smoothstep edges. Peak rate = 1.5·swing/trans
    // (smoothstep max slope); peak lateral accel = speed · peak rate.
    const target = (t) => {
        const k = Math.floor(t / period);
        const sign = (k % 2 === 0) ? 1 : -1;
        const tk = t - k * period;
        const half = swing / 2;
        if (tk < trans) return -sign * half + sign * swing * smoothstep(tk / trans);
        return sign * half;
    };
    const rateAt = (t) => {
        const eps = 1e-3;
        return (target(t + eps) - target(t - eps)) / (2 * eps);
    };
    const {pos, peakRate} = integrateHeading(n, fps, {altitudeAGL: alt, speed, rateAt});
    const peakGLoad = speed * peakRate / G;
    const dur = (n - 1) / fps;
    return {pos, profile: {speed, swingDeg: p.swingDeg ?? 90,
            periodSeconds: period, transitionSeconds: trans,
            realizedPeakGLoad: peakGLoad},
        // The anomaly is sustained: every transition exceeds the envelope, so
        // the event window is the whole track (first transition is at t=0).
        events: [{eventId: "zigzag-sustained", family: "sustained",
            anomalous, onsetSeconds: 0, endSeconds: dur,
            directionENU: [1, 0, 0],   // mean track axis (base heading east)
            parameters: {swingDeg: p.swingDeg ?? 90, periodSeconds: period,
                transitionSeconds: trans, peakGLoad}}]};
}

function highgTurn({n, fps, p, anomalous}) {
    const alt = p.altitudeAGL ?? 3000;
    const speed = p.speed ?? 240;
    const gLoad = p.gLoad ?? 50;
    // With a lead-in (the default) the track flies straight for 20% of the
    // clip and rolls into the turn over a short rise; without one it turns at
    // full rate from frame 0, so there is no straight reference segment and
    // no onset event inside the window to detect.
    const leadIn = p.leadIn ?? true;
    // Level coordinated turn: horizontal load sqrt(g²−1), rate = latG·G/v.
    const psiDot = Math.sqrt(Math.max(0, gLoad * gLoad - 1)) * G / speed;
    const dur = (n - 1) / fps;
    const onset = leadIn ? dur * 0.2 : 0;
    const rise = Math.min(2, dur * 0.1);
    const rateAt = leadIn
        ? (t) => (t < onset) ? 0 : psiDot * smoothstep((t - onset) / rise)
        : () => psiDot;
    const {pos, peakRate} = integrateHeading(n, fps, {altitudeAGL: alt, speed, rateAt});
    const realized = Math.sqrt(1 + (peakRate * speed / G) ** 2);
    return {pos, profile: {speed, gLoad, leadIn, turnRadiusM: speed / psiDot,
            realizedPeakGLoad: realized},
        events: [{eventId: "highg-turn-sustained", family: "sustained",
            anomalous, onsetSeconds: onset, endSeconds: dur,
            // Initial centripetal direction: heading east, clockwise turn,
            // center to the south.
            directionENU: [0, -1, 0],
            parameters: {gLoad, speedMS: speed, realizedPeakGLoad: realized}}]};
}

function hypersonicGlide({n, fps, p, anomalous}) {
    const alt = p.altitudeAGL ?? 25000;
    const speed = p.speed ?? 1700;            // ~Mach 5.7 at altitude
    const dip = (p.dipDeg ?? 2) * DEG;
    const dipS = p.dipSeconds ?? 10;
    // "dive" (default) noses down; "pullup" is the same raised-cosine
    // flight-path-angle excursion mirrored upward.
    const sense = p.sense ?? "dive";
    const sgn = sense === "pullup" ? 1 : -1;
    const dur = (n - 1) / fps;
    const onset = dur * 0.4;
    // Raised-cosine flight-path-angle dip: gentle (~2 g vertical) — the
    // anomaly signature is the SPEED regime, not the maneuver.
    const gamma = (t) => {
        const tau = (t - onset) / dipS;
        if (tau < 0 || tau > 1) return 0;
        return sgn * dip * 0.5 * (1 - Math.cos(2 * Math.PI * tau));
    };
    const pos = new Float64Array(n * 3);
    const SUB = 40, h = 1 / fps / SUB;
    let x = 0, z = alt, peakVz = 0;
    for (let f = 0; f < n; f++) {
        pos[f * 3] = x;
        pos[f * 3 + 2] = z;
        const t0 = f / fps;
        for (let s = 0; s < SUB; s++) {
            const g = gamma(t0 + s * h);
            x += speed * Math.cos(g) * h;
            z += speed * Math.sin(g) * h;
            if (Math.abs(speed * Math.sin(g)) > peakVz) peakVz = Math.abs(speed * Math.sin(g));
        }
    }
    return {pos, profile: {speed, dipDeg: p.dipDeg ?? 2,
            dipSeconds: dipS, sense, realizedPeakSinkMS: peakVz},
        // The anomaly is the speed regime itself, not the gentle dip, so the
        // event window is the whole track.
        events: [{eventId: "hypersonic-speed", family: "sustained",
            anomalous, onsetSeconds: 0, endSeconds: dur,
            directionENU: [1, 0, 0],   // velocity axis
            parameters: {speedMS: speed, dipDeg: p.dipDeg ?? 2, sense}}]};
}

function sineWave({n, fps, p, anomalous}) {
    const alt = p.altitudeAGL ?? 1000;
    const speed = p.speed ?? 60;
    const A = p.amplitudeM ?? 200;
    const period = p.periodSeconds ?? 20;
    const plane = p.plane ?? "horizontal";
    const omega = 2 * Math.PI / period;
    const pos = new Float64Array(n * 3);
    for (let f = 0; f < n; f++) {
        const t = f / fps;
        pos[f * 3] = speed * t;
        pos[f * 3 + 1] = plane === "horizontal" ? A * Math.sin(omega * t) : 0;
        pos[f * 3 + 2] = alt + (plane === "vertical" ? A * Math.sin(omega * t) : 0);
    }
    const peakG = A * omega * omega / G;
    const dur = (n - 1) / fps;
    return {pos, profile: {speed, amplitudeM: A,
            periodSeconds: period, plane, realizedPeakGLoad: peakG},
        // The weave is sustained — it runs the whole track — so the event
        // window is the whole track (same rule as zigzag). Emitted for the
        // mundane member too, anomalous:false, so a plausible/impossible pair
        // shares a comparable window (the ANOMALY-CONTROL rule).
        events: [{eventId: "sine-wave-sustained", family: "sustained",
            anomalous, onsetSeconds: 0, endSeconds: dur,
            directionENU: [1, 0, 0],   // mean track axis (base heading east)
            parameters: {amplitudeM: A, periodSeconds: period, plane,
                peakGLoad: peakG}}]};
}

function corkscrew({n, fps, p}) {
    const startAGL = p.startAGL ?? 500;
    const R = p.radiusM ?? 100;
    const period = p.periodSeconds ?? 12;
    const climb = p.climbRate ?? 3;
    const omega = 2 * Math.PI / period;
    const pos = new Float64Array(n * 3);
    for (let f = 0; f < n; f++) {
        const t = f / fps;
        pos[f * 3] = R * Math.sin(omega * t);
        pos[f * 3 + 1] = R * (1 - Math.cos(omega * t));
        pos[f * 3 + 2] = startAGL + climb * t;
    }
    return {pos, profile: {radiusM: R, periodSeconds: period,
        climbRate: climb, tangentialSpeedMS: omega * R,
        realizedPeakGLoad: omega * omega * R / G}};
}

function verticalLoop({n, fps, p, anomalous}) {
    const alt = p.altitudeAGL ?? 2000;
    const speed = p.speed ?? 80;
    const R = p.radiusM ?? 200;
    const dur = (n - 1) / fps;
    const onset = (p.onsetFraction ?? 0.25) * dur;
    const omega = speed / R;
    const loopEnd = onset + 2 * Math.PI / omega;
    const pos = new Float64Array(n * 3);
    const xAtOnset = speed * onset;
    for (let f = 0; f < n; f++) {
        const t = f / fps;
        if (t < onset) {
            pos[f * 3] = speed * t;
            pos[f * 3 + 2] = alt;
        } else if (t < loopEnd) {
            const th = omega * (t - onset);
            pos[f * 3] = xAtOnset + R * Math.sin(th);
            pos[f * 3 + 2] = alt + R * (1 - Math.cos(th));
        } else {
            pos[f * 3] = xAtOnset + speed * (t - loopEnd);
            pos[f * 3 + 2] = alt;
        }
    }
    const peakG = speed * speed / R / G;
    return {pos, profile: {speed, radiusM: R,
            onsetSeconds: onset, loopSeconds: 2 * Math.PI / omega,
            realizedPeakGLoad: peakG},
        // The event is the loop itself: straight flight outside it. A slow
        // loop can outlast a short clip, so the window clamps to the track.
        events: [{eventId: "vertical-loop-sustained", family: "sustained",
            anomalous, onsetSeconds: onset,
            endSeconds: Math.min(loopEnd, dur),
            directionENU: [0, 0, 1],   // initial centripetal direction (center above)
            parameters: {speedMS: speed, radiusM: R, peakGLoad: peakG}}]};
}

function figureEight({n, fps, p, anomalous}) {
    const alt = p.altitudeAGL ?? 1000;
    const speed = p.speed ?? 60;
    const R = p.radiusM ?? 300;
    const trans = p.transitionSeconds ?? 1;
    const omega = speed / R;
    const circleS = 2 * Math.PI / omega;      // one full circle per lobe
    // Turn rate alternates sign each circle, smoothstepped through zero so the
    // reversal is a rolled transition, not a curvature discontinuity.
    const rateAt = (t) => {
        const k = Math.floor(t / circleS);
        const sign = (k % 2 === 0) ? 1 : -1;
        const tk = t - k * circleS;
        if (tk < trans && k > 0) {
            return omega * (-sign + 2 * sign * smoothstep(tk / trans));
        }
        return sign * omega;
    };
    const {pos} = integrateHeading(n, fps, {altitudeAGL: alt, speed, rateAt});
    const peakG = omega * speed / G;
    const dur = (n - 1) / fps;
    return {pos, profile: {speed, radiusM: R,
            lobeSeconds: circleS, realizedPeakGLoad: peakG},
        // It weaves from frame 0, so the window is the whole track (same rule
        // as zigzag and the sine wave).
        events: [{eventId: "figure-eight-sustained", family: "sustained",
            anomalous, onsetSeconds: 0, endSeconds: dur,
            directionENU: [1, 0, 0],   // initial velocity axis (heading east)
            parameters: {speedMS: speed, radiusM: R, peakGLoad: peakG}}]};
}

// ---- dispatcher ------------------------------------------------------------

const KINDS = {
    "static-point": staticPoint,
    "straight-cv": straightCV,
    "straight-ca": straightCA,
    "slow-turn": slowTurn,
    "accel-instant": accelInstant,
    "turn90-instant": turn90Instant,
    "zigzag": zigzag,
    "highg-turn": highgTurn,
    "hypersonic-glide": hypersonicGlide,
    "sine-wave": sineWave,
    "corkscrew": corkscrew,
    "vertical-loop": verticalLoop,
    "figure-eight": figureEight,
};

export const MANEUVER_KINDS = Object.keys(KINDS);

// Default anomalousness per kind AT DEFAULT PARAMETERS (the agreed table).
// The interchange truth flag reads spec.target.parameters.anomalous, so specs
// must carry the flag explicitly — build them from this table (see
// maneuver.bench.test.js) so the spec and the generator cannot disagree.
export const MANEUVER_ANOMALOUS = {
    "static-point": false,
    "straight-cv": false,
    "straight-ca": false,
    "slow-turn": false,
    "accel-instant": true,
    "turn90-instant": true,
    "zigzag": true,
    "highg-turn": true,
    "hypersonic-glide": true,
    "sine-wave": false,
    "corkscrew": false,
    "vertical-loop": false,
    "figure-eight": false,
};

export function generateManeuverTruth(targetSpec, {n, fps, seed}) {
    const gen = KINDS[targetSpec.kind];
    if (!gen) throw new Error(`botbench: unknown maneuver kind "${targetSpec.kind}"`);
    const p = targetSpec.parameters ?? {};
    // Resolved flag: explicit spec value wins (a parameter sweep can make a
    // mundane-parameter variant of an anomalous shape), else the table.
    const anomalous = p.anomalous ?? MANEUVER_ANOMALOUS[targetSpec.kind];
    const r = gen({n, fps, p, seed, anomalous});
    const valid = new Uint8Array(n).fill(1);
    return {
        target: {kind: "track", family: "maneuver", positionENU: r.pos, valid,
            profile: {kind: targetSpec.kind, variant: p.variant ?? null,
                ...r.profile, anomalous}},
        events: r.events ?? [],
    };
}
