// capabilityTargets.js — ROUND 3 (emerging-threats): truth generators that
// exercise a capability dimension at a chosen multiple of a catalog envelope.
//
// The mission is DETECTION/ATTRIBUTION, not exclusion: a real adversary system
// might run ~20% outside a known envelope, or combine capabilities no catalog
// class has. Truth here always obeys PHYSICS (coherent accelerations); it
// exceeds an ENVELOPE, never Newton. lambda = 1.0 is the in-envelope control;
// 1.1/1.2 are the operationally hard marginal cases; 1.5/2.0 anchor the curve.
//
// Catalog envelopes come from src/VehicleModels.js (the production source of
// truth) so "exceedance" is measured against exactly what the fitters know.
//
// All generators return {positionENU: Float64Array(3n), profile} in the
// scenario ENU frame; `profile` records the exercised dimension and the
// realized peak so the record can report true exceedance precisely.

import {quadcopterById, fixedWingById} from "../../../src/VehicleModels";

const G = 9.80665;
const DEG = Math.PI / 180;

function smootherstep(x) {
    const t = Math.max(0, Math.min(1, x));
    return t * t * t * (t * (t * 6 - 15) + 10);
}

// A held segment schedule: ramp a scalar from a to b over [t0,t1], hold, ramp
// back. Substepped Euler integration (SUB per frame) keeps the realized track
// physically coherent even for the sharper dashes.
function integrate(n, fps, stepFn) {
    const SUB = 40;
    const dt = 1 / fps;
    const h = dt / SUB;
    const pos = new Float64Array(n * 3);
    const st = {x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0};
    stepFn.init(st);
    let peak = 0;
    for (let f = 0; f < n; f++) {
        pos[f * 3] = st.x; pos[f * 3 + 1] = st.y; pos[f * 3 + 2] = st.z;
        const t0 = f * dt;
        for (let s = 0; s < SUB; s++) {
            const t = t0 + s * h;
            peak = Math.max(peak, stepFn.step(st, t, h) ?? 0);
        }
    }
    return {pos, peak};
}

// ---- quad speed exceedance: level dash at lambda * catalog maxSpeed --------
// A drone that cruises in-envelope, then dashes at lambda*maxSpeed for a held
// segment, then decelerates. The dash airspeed is the exceeded quantity.
function quadSpeedProfile({n, fps, catalogId, lambda, startAGL = 500}) {
    const env = quadcopterById(catalogId);
    const vDash = lambda * env.maxSpeed;
    const dur = (n - 1) / fps;
    const onset = dur * 0.30, rise = Math.min(3, dur * 0.15);
    const hold = Math.max(4, dur * 0.30);
    const {pos, peak} = integrate(n, fps, {
        init(st) { st.z = startAGL; st.vx = env.maxSpeed * 0.4; },
        step(st, t, h) {
            let target = env.maxSpeed * 0.4;
            if (t >= onset && t < onset + rise) target = env.maxSpeed * 0.4 + (vDash - env.maxSpeed * 0.4) * smootherstep((t - onset) / rise);
            else if (t >= onset + rise && t < onset + rise + hold) target = vDash;
            else if (t >= onset + rise + hold && t < onset + 2 * rise + hold) target = vDash + (env.maxSpeed * 0.4 - vDash) * smootherstep((t - onset - rise - hold) / rise);
            else if (t >= onset + 2 * rise + hold) target = env.maxSpeed * 0.4;
            // first-order approach to target speed along +x (a coherent dash)
            const k = Math.min(1, h * 2);
            st.vx += (target - st.vx) * k;
            st.x += st.vx * h;
            return st.vx;
        },
    });
    return {positionENU: pos, profile: {kind: "quad-speed", catalogId,
        catalogMax: env.maxSpeed, lambda, realizedPeak: peak,
        realizedExceedance: peak / env.maxSpeed}};
}

// ---- quad climb exceedance: sustained climb at lambda * catalog maxAscent ---
function quadClimbProfile({n, fps, catalogId, lambda, startAGL = 300}) {
    const env = quadcopterById(catalogId);
    const vUp = lambda * env.maxAscent;
    const dur = (n - 1) / fps;
    const onset = dur * 0.25, rise = Math.min(2, dur * 0.1);
    const {pos, peak} = integrate(n, fps, {
        init(st) { st.z = startAGL; st.vx = 3; },
        step(st, t, h) {
            let target = 0;
            if (t >= onset && t < onset + rise) target = vUp * smootherstep((t - onset) / rise);
            else if (t >= onset + rise) target = vUp;
            const k = Math.min(1, h * 2);
            st.vz += (target - st.vz) * k;
            st.x += st.vx * h; st.z += st.vz * h;
            return st.vz;
        },
    });
    return {positionENU: pos, profile: {kind: "quad-climb", catalogId,
        catalogMax: env.maxAscent, lambda, realizedPeak: peak,
        realizedExceedance: peak / env.maxAscent}};
}

// ---- fixed-wing speed exceedance: dash at lambda * catalog tasMax -----------
function fixedwingSpeedProfile({n, fps, catalogId, lambda, altitudeAGL = 3000}) {
    const env = fixedWingById(catalogId);
    const vDash = lambda * env.tasMax;
    const vCruise = env.cruise;
    const dur = (n - 1) / fps;
    const onset = dur * 0.3, rise = Math.min(5, dur * 0.2), hold = Math.max(4, dur * 0.3);
    const {pos, peak} = integrate(n, fps, {
        init(st) { st.z = altitudeAGL; st.vx = vCruise; },
        step(st, t, h) {
            let target = vCruise;
            if (t >= onset && t < onset + rise) target = vCruise + (vDash - vCruise) * smootherstep((t - onset) / rise);
            else if (t >= onset + rise && t < onset + rise + hold) target = vDash;
            else if (t >= onset + rise + hold) target = vDash + (vCruise - vDash) * smootherstep(Math.min(1, (t - onset - rise - hold) / rise));
            const k = Math.min(1, h * 1.5);
            st.vx += (target - st.vx) * k;
            st.x += st.vx * h;
            return st.vx;
        },
    });
    return {positionENU: pos, profile: {kind: "fixedwing-speed", catalogId,
        catalogMax: env.tasMax, lambda, realizedPeak: peak,
        realizedExceedance: peak / env.tasMax}};
}

// ---- fixed-wing sustained-g turn: level turn at lambda * catalog gMax -------
// Fixed-wing g is CLASSIFICATION-ONLY in production (no g-envelope fit), so
// exceedance here is measured KINEMATICALLY (S2), not by fit relaxation.
// Constant TAS, constant-radius level turn; the turn's lateral g is the
// exceeded quantity. R = v^2/(g*sqrt(gLoad^2-1)); psiDot = v/R.
function fixedwingGProfile({n, fps, catalogId, lambda, altitudeAGL = 3000}) {
    const env = fixedWingById(catalogId);
    const gLoad = Math.max(1.2, lambda * env.gMax);
    const v = env.cruise;
    const latG = Math.sqrt(Math.max(0, gLoad * gLoad - 1));   // horizontal load
    const psiDot = latG * G / v;   // rad/s
    const dur = (n - 1) / fps;
    const onset = dur * 0.25, rise = Math.min(2, dur * 0.1);
    const {pos, peak} = integrate(n, fps, {
        init(st) { st.z = altitudeAGL; st.psi = 90 * DEG; },
        step(st, t, h) {
            let rate = 0;
            if (t >= onset && t < onset + rise) rate = psiDot * smootherstep((t - onset) / rise);
            else if (t >= onset + rise) rate = psiDot;
            st.psi = (st.psi ?? 90 * DEG) + rate * h;
            st.x += v * Math.sin(st.psi) * h;
            st.y += v * Math.cos(st.psi) * h;
            // realized lateral g at this instant
            return Math.sqrt(1 + (rate * v / G) ** 2);
        },
    });
    return {positionENU: pos, profile: {kind: "fixedwing-g", catalogId,
        catalogMax: env.gMax, lambda, realizedPeak: peak,
        realizedExceedance: peak / env.gMax, measuredBy: "kinematic"}};
}

// ---- NOVEL-TECH signatures (physically coherent, no catalog class) ----------
// N1 joint-envelope: 8g sustained turn AT 50 m/s (a fighter's g at a drone's
//    speed — no single catalog class holds both).
function novelJointEnvelope({n, fps, altitudeAGL = 2000}) {
    const v = 50, gLoad = 8;
    const psiDot = Math.sqrt(gLoad * gLoad - 1) * G / v;
    const dur = (n - 1) / fps, onset = dur * 0.2, rise = Math.min(2, dur * 0.1);
    const {pos, peak} = integrate(n, fps, {
        init(st) { st.z = altitudeAGL; st.psi = 90 * DEG; },
        step(st, t, h) {
            let rate = (t >= onset) ? psiDot * smootherstep(Math.min(1, (t - onset) / rise)) : 0;
            st.psi = (st.psi ?? 90 * DEG) + rate * h;
            st.x += v * Math.sin(st.psi) * h; st.y += v * Math.cos(st.psi) * h;
            return Math.sqrt(1 + (rate * v / G) ** 2);
        },
    });
    return {positionENU: pos, profile: {kind: "novel-joint-envelope",
        note: "8g turn at 50 m/s", realizedPeakG: peak}};
}
// N2 hover-to-dash: hold near-stationary, then accelerate to 150 m/s in ~3 s.
function novelHoverDash({n, fps, altitudeAGL = 1500}) {
    const dur = (n - 1) / fps, onset = dur * 0.4, rise = 3;
    const {pos, peak} = integrate(n, fps, {
        init(st) { st.z = altitudeAGL; },
        step(st, t, h) {
            let target = (t >= onset) ? 150 * smootherstep(Math.min(1, (t - onset) / rise)) : 0;
            const k = Math.min(1, h * 3);
            const prev = st.vx;
            st.vx += (target - st.vx) * k;
            st.x += st.vx * h;
            return Math.abs(st.vx - prev) / h / G;   // accel in g
        },
    });
    return {positionENU: pos, profile: {kind: "novel-hover-dash",
        note: "hover to 150 m/s in ~3 s", realizedPeakAccelG: peak}};
}
// N3 extreme vertical climb: sustained 100 m/s climb (classifier uses total
//    airspeed+climb and may absorb this as a fighter — a key attribution test).
function novelVerticalClimb({n, fps, altitudeAGL = 500}) {
    const dur = (n - 1) / fps, onset = dur * 0.2, rise = Math.min(3, dur * 0.15);
    const {pos, peak} = integrate(n, fps, {
        init(st) { st.z = altitudeAGL; },
        step(st, t, h) {
            let target = (t >= onset) ? 100 * smootherstep(Math.min(1, (t - onset) / rise)) : 0;
            const k = Math.min(1, h * 2);
            st.vz += (target - st.vz) * k;
            st.z += st.vz * h;
            return st.vz;
        },
    });
    return {positionENU: pos, profile: {kind: "novel-vertical-climb",
        note: "sustained 100 m/s climb", realizedPeakClimb: peak}};
}

const CAPABILITY = {
    "quad-speed": quadSpeedProfile,
    "quad-climb": quadClimbProfile,
    "fixedwing-speed": fixedwingSpeedProfile,
    "fixedwing-g": fixedwingGProfile,
};
const NOVEL = {
    "novel-joint-envelope": novelJointEnvelope,
    "novel-hover-dash": novelHoverDash,
    "novel-vertical-climb": novelVerticalClimb,
};

export function generateCapabilityTruth(spec, {n, fps}) {
    const p = spec.parameters ?? {};
    const valid = new Uint8Array(n).fill(1);
    const gen = CAPABILITY[p.dimension] ?? NOVEL[p.novelId];
    if (!gen) throw new Error(`botbench: unknown capability target ${p.dimension ?? p.novelId}`);
    const r = p.novelId ? gen({n, fps}) : gen({n, fps, catalogId: p.catalogId, lambda: p.lambda});
    return {
        target: {kind: "track", family: "capability", positionENU: r.positionENU, valid},
        capabilityProfile: r.profile,
    };
}
