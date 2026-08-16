// targets.js — truth generators for every target family (PLAN.md "Target
// definitions"). Truth deliberately lives OUTSIDE every benchmarked solver's
// model class except in cells explicitly labeled oracle-compatible controls
// (aircraft-cruise, constant-wind floaters, clean noise).
//
// Frame: scenario ENU, origin at the target's initial ground point, z = height
// above (flat-proxy) site ground. All returned tracks are Float64Array(3n).
//
// Balloons ride src/BalloonPhysics.integrateBalloonPositions (kinematic riser
// with seeded gusts — labeled as such, not full buoyancy dynamics), converted
// from ECEF to scenario ENU displacements. Aircraft use independent truth
// equations, NOT TraverseAnalysis.simulateAircraft, so the physics fitters
// stay benchmarkable later without an inverse crime.

import {FLAT_GEOID, integrateBalloonPositions} from "../../../src/BalloonPhysics";
import {ecefDisplacementToENU} from "../../../src/TrackExportMath";
import {makeStream} from "./rng";

const G = 9.80665;
const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// Balloons (risers and floaters) via BalloonPhysics
// ---------------------------------------------------------------------------

function balloonTrack({site, n, fps, windSeed, wind, startAGL, ascentRate}) {
    const startAltMSL = startAGL + site.groundElevationMSL;
    // Gusts are WIND stochasticity, so they draw from the wind component
    // stream (rngSeeds.wind), keeping the declared per-component seed
    // independence real — the target stream stays free for target behavior.
    const ecef = integrateBalloonPositions({
        startLat: site.latDeg, startLon: site.lonDeg, startAltMSL,
        launchDelay: 0,
        ascentRate,
        variabilityPct: wind.variabilityPct,
        seed: windSeed,
        frames: n,
        dt: 1 / fps,
        // Scenarios are generated on a flat plane (altitude = Z + groundElevationMSL),
        // so there is no geoid here by construction. Stating it keeps the set
        // reproducible: the altMSL fed back to windAt drives the layered wind
        // profile, and a real N (-40.7 m at the ocean site) would move every
        // balloon truth track.
        geoidOffset: FLAT_GEOID,
    }, wind.windAt);

    const origin = ecef[0].position;
    const pos = new Float64Array(n * 3);
    for (let f = 0; f < n; f++) {
        const e = ecefDisplacementToENU(origin, ecef[f].position, site.latDeg, site.lonDeg);
        pos[f * 3] = e.east;
        pos[f * 3 + 1] = e.north;
        pos[f * 3 + 2] = e.up + startAGL;
    }
    return pos;
}

// ---------------------------------------------------------------------------
// Tethered aerostat — SIMPLIFIED tether constraint, not a validated model.
// Tilt relaxes (tau 5 s) toward an equilibrium proportional to wind speed
// (3 deg per m/s, capped at 30 deg) in the downwind direction, plus a small
// 12 s crosswind sway. Altitude follows the tether geometry.
// ---------------------------------------------------------------------------

function aerostatTrack({n, fps, seed, wind}) {
    const L = 600;              // tether length, m
    const TILT_MAX = 30 * DEG;
    const TAU = 5;              // response time, s
    const SWAY_PERIOD = 12;
    const stream = makeStream(seed);
    const swayPhase = stream.uniform() * 2 * Math.PI;

    const pos = new Float64Array(n * 3);
    const dt = 1 / fps;
    let tilt = 0, dirE = 1, dirN = 0;
    for (let f = 0; f < n; f++) {
        const t = f / fps;
        const {u, v} = wind.meanAt(L);  // local layer near operating altitude
        const speed = Math.hypot(u, v);
        const tiltEq = Math.min(TILT_MAX, speed * 3 * DEG);
        const k = Math.min(1, dt / TAU);
        tilt += (tiltEq - tilt) * k;
        if (speed > 0.1) {
            const wE = u / speed, wN = v / speed;
            dirE += (wE - dirE) * k;
            dirN += (wN - dirN) * k;
            const dl = Math.hypot(dirE, dirN) || 1;
            dirE /= dl; dirN /= dl;
        }
        // crosswind sway: +/-1.5 deg scaled by how loaded the tether is
        const sway = 1.5 * DEG * (tilt / TILT_MAX) * Math.sin(2 * Math.PI * t / SWAY_PERIOD + swayPhase);
        const cE = -dirN, cN = dirE;   // crosswind unit
        const sinT = Math.sin(tilt), cosT = Math.cos(tilt);
        const sinS = Math.sin(sway);
        pos[f * 3] = L * (sinT * dirE + sinS * cE);
        pos[f * 3 + 1] = L * (sinT * dirN + sinS * cN);
        pos[f * 3 + 2] = L * cosT;
    }
    return pos;
}

// ---------------------------------------------------------------------------
// Bird — 15 m/s airspeed, Ornstein-Uhlenbeck heading meander (6 s correlation,
// ~25 deg stationary std), 10 m peak-to-peak / 8 s altitude porpoising, wind
// advection added as drift.
// ---------------------------------------------------------------------------

function birdTrack({n, fps, seed, wind, startAGL = 500, airspeed = 15}) {
    const stream = makeStream(seed);
    const dt = 1 / fps;
    const TAU = 6;
    const STD = 25 * DEG;
    const sigma = STD * Math.sqrt(2 / TAU);   // OU driving noise
    const psi0 = stream.uniform() * 2 * Math.PI;
    const porpPhase = stream.uniform() * 2 * Math.PI;

    const pos = new Float64Array(n * 3);
    let x = 0, y = 0, dPsi = 0;
    for (let f = 0; f < n; f++) {
        const t = f / fps;
        const alt = startAGL + 5 * Math.sin(2 * Math.PI * t / 8 + porpPhase);
        pos[f * 3] = x;
        pos[f * 3 + 1] = y;
        pos[f * 3 + 2] = alt;
        const psi = psi0 + dPsi;
        const {u, v} = wind.meanAt(alt);
        x += (airspeed * Math.sin(psi) + u) * dt;
        y += (airspeed * Math.cos(psi) + v) * dt;
        dPsi += (-dPsi / TAU) * dt + sigma * Math.sqrt(dt) * stream.gaussian();
    }
    return pos;
}

// ---------------------------------------------------------------------------
// Aircraft — independent truth equations (deliberately NOT simulateAircraft).
// cruise: constant air velocity east + wind advection => exact CV control.
// turn:   constant 15 deg bank (right), 2 m/s climb, wind advection.
// ---------------------------------------------------------------------------

function aircraftTrack({n, fps, wind, kind, altitudeAGL = 3000, airspeed = 150}) {
    const pos = new Float64Array(n * 3);
    const {u, v} = wind.meanAt(altitudeAGL);
    if (kind === "cruise") {
        for (let f = 0; f < n; f++) {
            const t = f / fps;
            pos[f * 3] = (airspeed + u) * t;
            pos[f * 3 + 1] = v * t;
            pos[f * 3 + 2] = altitudeAGL;
        }
        return pos;
    }
    // turn: heading psi(t) = psi0 + omega t (right turn), air-relative arc +
    // wind drift, analytic integral of [sin psi, cos psi].
    const bank = 15 * DEG;
    const omega = (G / airspeed) * Math.tan(bank);
    const psi0 = 90 * DEG;   // start heading east
    const climb = 2;
    for (let f = 0; f < n; f++) {
        const t = f / fps;
        const psi = psi0 + omega * t;
        // integral of v_air over [0,t]
        const ix = (airspeed / omega) * (Math.cos(psi0) - Math.cos(psi));
        const iy = (airspeed / omega) * (Math.sin(psi) - Math.sin(psi0));
        pos[f * 3] = ix + u * t;
        pos[f * 3 + 1] = iy + v * t;
        pos[f * 3 + 2] = altitudeAGL + climb * t;
    }
    return pos;
}

// ---------------------------------------------------------------------------
// Anomalous aircraft-like target + its ordinary-maneuver control.
// Base: 120 m/s east, level at 3000 m AGL. One event per scenario (PLAN.md
// anomaly tuples). Substepped integration (40/frame) keeps the declared event
// profile and the integrated truth in close agreement even for the 0.5 s pulse.
// ---------------------------------------------------------------------------

function smoothstep(x) {
    const t = Math.max(0, Math.min(1, x));
    return t * t * (3 - 2 * t);
}

// Build the event descriptor pair (anomalous + ordinary control) for a tuple id.
// Control derivation rules are the contract's: pulses at 2.5 g, transitions
// scaled to <= 2.5 g, impulses replaced by a 2 s raised-cosine at <= 2.5 g.
export function anomalyEventFor(tupleId, anomalous) {
    const CAP_G = 2.5;
    switch (tupleId) {
        case "pulse-20g":
            return {family: "pulse", onsetSeconds: 5, durationSeconds: 2.0,
                peakG: anomalous ? 20 : CAP_G, lateral: "left"};
        case "pulse-100g":
            return {family: "pulse", onsetSeconds: 9, durationSeconds: 0.5,
                peakG: anomalous ? 100 : CAP_G, lateral: "right"};
        case "transition-90":
            return {family: "transition", onsetSeconds: 5, durationSeconds: 2.0,
                speed0: 120, speed1: 250, headingChangeDeg: 90, capG: anomalous ? null : CAP_G};
        case "transition-180":
            return {family: "transition", onsetSeconds: 9, durationSeconds: 1.0,
                speed0: 120, speed1: 300, headingChangeDeg: -180, capG: anomalous ? null : CAP_G};
        case "impulse-east":
            return anomalous
                ? {family: "impulse", onsetSeconds: 5, deltaVENU: [150, 0, 0]}
                : {family: "impulse-control", onsetSeconds: 5, durationSeconds: 2.0,
                    deltaVENU: [150, 0, 0], capG: CAP_G};
        case "impulse-north":
            return anomalous
                ? {family: "impulse", onsetSeconds: 9, deltaVENU: [0, 150, 0]}
                : {family: "impulse-control", onsetSeconds: 9, durationSeconds: 2.0,
                    deltaVENU: [0, 150, 0], capG: CAP_G};
        default:
            throw new Error(`botbench: unknown anomaly tuple "${tupleId}"`);
    }
}

function anomalousTrack({n, fps, event, altitudeAGL = 3000, baseSpeed = 120}) {
    const pos = new Float64Array(n * 3);
    const SUB = 40;
    const dt = 1 / fps;
    const h = dt / SUB;

    // Transitions live in Cartesian velocity space: v(tau) smoothsteps from v0
    // to v1' = v0 + s*(v1 - v0). "Scale the requested velocity-change vector"
    // (the control rule) is then exact and analytic: smoothstep's max slope is
    // 1.5, so peak accel = 1.5*|v1'-v0|/duration and
    // s = min(1, capG*g*duration / (1.5*|v1-v0|)).
    let ev = event;
    if (ev.family === "transition") {
        const psi1 = 90 * DEG + ev.headingChangeDeg * DEG;   // initial heading east
        const v0 = [ev.speed0, 0];
        const v1 = [ev.speed1 * Math.sin(psi1), ev.speed1 * Math.cos(psi1)];
        const dv = [v1[0] - v0[0], v1[1] - v0[1]];
        const dvMag = Math.hypot(dv[0], dv[1]);
        const s = ev.capG != null
            ? Math.min(1, (ev.capG * G * ev.durationSeconds) / (1.5 * dvMag))
            : 1;
        ev = {...ev, v0, dvScaled: [dv[0] * s, dv[1] * s], scale: s,
              peakAccelG: (1.5 * dvMag * s / ev.durationSeconds) / G};
    } else if (ev.family === "impulse-control") {
        // Record the APPLIED delta-v (capped), so event metadata matches the
        // trajectory rather than the requested anomalous delta-v.
        const mag = Math.hypot(...ev.deltaVENU);
        ev = {...ev, appliedDeltaVMagnitudeMS:
            Math.min(mag, ev.capG * G * ev.durationSeconds / 2)};
    }

    let x = 0, y = 0, z = altitudeAGL;
    let vx = baseSpeed, vy = 0, vz = 0;   // east
    let impulseDone = false;

    const transitionVel = (t) => {
        const tau = (t - ev.onsetSeconds) / ev.durationSeconds;
        const h01 = smoothstep(tau);
        return {vx: ev.v0[0] + ev.dvScaled[0] * h01,
                vy: ev.v0[1] + ev.dvScaled[1] * h01};
    };

    for (let f = 0; f < n; f++) {
        pos[f * 3] = x; pos[f * 3 + 1] = y; pos[f * 3 + 2] = z;
        const t0 = f * dt;
        for (let s = 0; s < SUB; s++) {
            const t = t0 + s * h;
            if (ev.family === "pulse") {
                const te = t - ev.onsetSeconds;
                if (te >= 0 && te < ev.durationSeconds) {
                    const a = ev.peakG * G * Math.sin(Math.PI * te / ev.durationSeconds);
                    const vh = Math.hypot(vx, vy) || 1;
                    // lateral-left = 90 deg CCW from velocity (viewed from above)
                    const sgn = ev.lateral === "left" ? 1 : -1;
                    const axu = sgn * (-vy / vh), ayu = sgn * (vx / vh);
                    vx += a * axu * h;
                    vy += a * ayu * h;
                }
            } else if (ev.family === "transition") {
                const te = t - ev.onsetSeconds;
                if (te >= 0 && te <= ev.durationSeconds) {
                    const vNow = transitionVel(t + h);
                    vx = vNow.vx; vy = vNow.vy;
                }
            } else if (ev.family === "impulse") {
                if (!impulseDone && t >= ev.onsetSeconds) {
                    vx += ev.deltaVENU[0];
                    vy += ev.deltaVENU[1];
                    vz += ev.deltaVENU[2];
                    impulseDone = true;
                }
            } else if (ev.family === "impulse-control") {
                const te = t - ev.onsetSeconds;
                if (te >= 0 && te < ev.durationSeconds) {
                    // raised-cosine acceleration, peak capped at capG
                    const mag = Math.hypot(...ev.deltaVENU);
                    const dvCap = Math.min(mag, ev.capG * G * ev.durationSeconds / 2);
                    const aPeak = 2 * dvCap / ev.durationSeconds;   // mean*2
                    const a = 0.5 * aPeak * (1 - Math.cos(2 * Math.PI * te / ev.durationSeconds));
                    vx += a * (ev.deltaVENU[0] / mag) * h;
                    vy += a * (ev.deltaVENU[1] / mag) * h;
                    vz += a * (ev.deltaVENU[2] / mag) * h;
                }
            }
            x += vx * h; y += vy * h; z += vz * h;
        }
    }
    return {positionENU: pos, eventUsed: ev};
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

// spec.target: {kind, family, parameters}. Returns the BotScenario `target`
// object (without venus — that lives in venus.js to keep the astronomy import
// out of the common path), plus events[] for anomalous kinds.
export function generateTargetTruth(targetSpec, {site, n, fps, seed, windSeed, wind}) {
    const p = targetSpec.parameters ?? {};
    const valid = new Uint8Array(n).fill(1);
    const mk = (positionENU) => ({kind: "track", family: targetSpec.family, positionENU, valid});

    switch (targetSpec.kind) {
        case "party-rising":
            return {target: mk(balloonTrack({site, n, fps, windSeed, wind,
                startAGL: p.startAGL ?? 300, ascentRate: p.ascentRate ?? 3})), events: []};
        case "weather-rising":
            return {target: mk(balloonTrack({site, n, fps, windSeed, wind,
                startAGL: p.startAGL ?? 300, ascentRate: p.ascentRate ?? 5})), events: []};
        case "party-neutral":
            return {target: mk(balloonTrack({site, n, fps, windSeed, wind,
                startAGL: p.startAGL ?? 500, ascentRate: 0})), events: []};
        case "hab-stable":
            return {target: mk(balloonTrack({site, n, fps, windSeed, wind,
                startAGL: p.startAGL, ascentRate: 0})), events: []};
        case "tethered-aerostat":
            return {target: mk(aerostatTrack({n, fps, seed, wind})), events: []};
        case "bird":
            return {target: mk(birdTrack({n, fps, seed, wind})), events: []};
        case "aircraft-cruise":
            return {target: mk(aircraftTrack({n, fps, wind, kind: "cruise"})), events: []};
        case "aircraft-turn":
            return {target: mk(aircraftTrack({n, fps, wind, kind: "turn"})), events: []};
        case "anomalous": {
            const event = anomalyEventFor(p.tupleId, p.anomalous);
            const {positionENU, eventUsed} = anomalousTrack({n, fps, event});
            const endSeconds = eventUsed.family === "impulse"
                ? eventUsed.onsetSeconds + 1 / fps
                : eventUsed.onsetSeconds + eventUsed.durationSeconds;
            return {
                target: mk(positionENU),
                events: [{
                    eventId: `${p.tupleId}${p.anomalous ? "" : "-control"}`,
                    pairId: null,   // filled by generateScenario from spec
                    family: eventUsed.family.startsWith("impulse") ? "impulse"
                        : eventUsed.family,
                    anomalous: !!p.anomalous,
                    onsetSeconds: eventUsed.onsetSeconds,
                    endSeconds,
                    directionENU: eventDirection(eventUsed),
                    parameters: {...eventUsed},
                }],
            };
        }
        default: {
            if (targetSpec.family === "real") {
                // Targets cut from real GPS tracks; the bench registers the
                // windowed segment first (see lib/realSegments.js).
                // eslint-disable-next-line global-require
                const {generateRealSegmentTruth} = require("./realSegments");
                return generateRealSegmentTruth(targetSpec, {n, fps});
            }
            if (targetSpec.family === "maneuver") {
                // MANEUVER-CLASS track types (shape taxonomy, first pass) live
                // in their own module; this dispatcher stays the single entry.
                // eslint-disable-next-line global-require
                const {generateManeuverTruth} = require("./maneuverTargets");
                return generateManeuverTruth(targetSpec, {n, fps, seed});
            }
            throw new Error(`botbench: unknown target kind "${targetSpec.kind}"`);
        }
    }
}

function eventDirection(ev) {
    // Transition: the ACTUAL (scaled) velocity-change direction — not a sign
    // placeholder (audit fix: the metadata must match the applied delta-v).
    if (ev.dvScaled) {
        const m = Math.hypot(ev.dvScaled[0], ev.dvScaled[1]) || 1;
        return [ev.dvScaled[0] / m, ev.dvScaled[1] / m, 0];
    }
    if (ev.deltaVENU) {
        const m = Math.hypot(...ev.deltaVENU) || 1;
        return [ev.deltaVENU[0] / m, ev.deltaVENU[1] / m, ev.deltaVENU[2] / m];
    }
    // pulse: base velocity is east; lateral-left = north, lateral-right = south
    return ev.lateral === "left" ? [0, 1, 0] : [0, -1, 0];
}
