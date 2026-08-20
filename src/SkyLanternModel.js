// Sky Lantern physics model for LOS trajectory fitting.
//
// A sky lantern is a near-perfect wind tracer: it weighs ~100 g with ~0.5 m²
// of drag area, so it matches the local wind within seconds. The model is
// therefore pure wind-drift kinematics — the horizontal velocity IS the wind
// at the lantern's current altitude — rather than an ODE of buoyancy fighting
// gravity. (The previous formulation integrated a stiff near-cancellation of
// buoyancy vs gravity with free horizontal wind up to a 10-20x shear
// multiplier; the optimizer exploited that freedom into 60+ kt "lanterns"
// heading the wrong way. Validated against the accepted Aguadilla lantern
// path, this parameterization lands within ~35 m of the hand-fitted spline
// while the old one missed by over a kilometer.)
//
// Vertical motion is the lantern life cycle — any subset of the stages can
// fall inside the clip:
//
//   vz(t) = vRise                                        t <= tBurn   (flame lit)
//         = -vSink + (vRise + vSink) e^-((t-tBurn)/tau)  t >  tBurn   (cooling -> terminal sink)
//
// tBurn < 0 means the flame died before the clip starts (Aguadilla: the fit
// finds tBurn ≈ -80 s — a lantern already in its slow cooling descent).
//
// Wind varies with altitude as a linear fractional shear about the initial
// altitude, clamped to [0.25, 3]x so it can never reverse or blow up:
//
//   wind(h) = (windE, windN) * clamp(1 + shearPerM (h - h0), 0.25, 3)
//
// Parameters solved by optimizer:
//   0: initialRange — distance along first LOS ray (m)
//   1: windE        — east wind at the initial altitude (m/s)
//   2: windN        — north wind at the initial altitude (m/s)
//   3: shearPerM    — fractional wind-speed change per meter of altitude (1/m)
//   4: vRise        — ascent rate while the flame burns (m/s)
//   5: vSink        — terminal descent rate after cooling (m/s, positive down)
//   6: tBurn        — flame-out time relative to clip start (s)
//   7: tauCool      — buoyancy decay time constant after flame-out (s)
//
// State is [x, y, z, h0] in ENU: h0 (the geodetic shear-reference altitude) rides
// along as a constant so derivatives() needs no out-of-band context. The
// dynamics are smooth, non-stiff kinematics — a 3-state integration with a
// large step, ~7x faster than the old drag ODE.

import {PhysicsModel} from "./PhysicsModel";

const MULT_MIN = 0.25;  // wind shear multiplier floor (never reverses)
const MULT_MAX = 3.0;   // ...and ceiling (never a hurricane aloft)
const EARTH_R = 6371000;

// Reference RMS wind variation for the variability prior (m/s): roughly the
// amount a real wind wanders over a few minutes without anything remarkable
// happening. 1 cost unit = 0.02 deg of fit, so at this level the variation must
// buy 0.02 deg to be worth having; 3x this costs 9 units and needs real support.
// See SkyLanternModel._windVariationCost.
const WIND_VARIATION_REF = 2.0;

// Solve a 3x3 linear system M x = b (M row-major) by Gaussian elimination with
// partial pivoting. Returns null if singular (the caller falls back to a
// constant seed). Used by SkyLanternModel.seedFromTrack for the wind quadratic.
function _solve3(M, b) {
    const A = [
        [M[0], M[1], M[2], b[0]],
        [M[3], M[4], M[5], b[1]],
        [M[6], M[7], M[8], b[2]],
    ];
    for (let col = 0; col < 3; col++) {
        let piv = col;
        for (let r = col + 1; r < 3; r++) {
            if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
        }
        if (Math.abs(A[piv][col]) < 1e-12) return null;
        if (piv !== col) { const t = A[piv]; A[piv] = A[col]; A[col] = t; }
        for (let r = 0; r < 3; r++) {
            if (r === col) continue;
            const factor = A[r][col] / A[col][col];
            for (let c = col; c < 4; c++) A[r][c] -= factor * A[col][c];
        }
    }
    return [A[0][3] / A[0][0], A[1][3] / A[1][1], A[2][3] / A[2][2]];
}

export class SkyLanternModel extends PhysicsModel {
    // Smooth kinematics: big RK4 substeps are fine (the base 0.02 s default
    // exists for stiff drag models).
    maxDt = 0.25;

    // Optional soft wind prior (E/N m/s + sigma), sampled once from the loaded
    // sounding/GFS field at the fit's altitude and set on the instance before
    // fitting. When present, the fitted drift wind is pinned loosely to that
    // MEASURED wind (the "measured-corrected" policy) instead of the calm-air
    // preference — a wind tracer's drift should match the known winds aloft,
    // not slide slow to trade against range in the coupled range/wind pair.
    // Null (no usable wind field) falls back to the light-wind prior below.
    // Mirrors FixedWingModel.windPrior*.
    windPriorE = null;
    windPriorN = null;
    windPriorSigma = 7.7;   // ~15 kt

    // Clip duration in seconds, set by the caller before fitting. Normalises the
    // time-varying wind parameters so they are duration-invariant. Left null the
    // model reverts to constant wind — see _windAt.
    clipDuration = null;

    // Parameter seed inverted from a geometric track, set by seedFromTrack().
    // Null = unseeded (fit starts from the getParameterDefs defaults).
    seed = null;

    getName() {
        return "Sky Lantern";
    }

    getParameterDefs() {
        // name, min, max, default, scale (initial simplex perturbation)
        // Wind components bounded at 40 m/s (~78 kt each). A lantern is a wind
        // tracer: launch implies calm-ish SURFACE wind, but 40-45 kt at altitude
        // is ordinary — a ±13 m/s bound encoded the surface intuition and forced
        // the fit to fake faster drift with the shear multiplier (pinning both
        // bounds and inflating the residual). ±20 fixed that and left a subtler
        // case behind it.
        //
        // A BOX CUTS THE CORNER OFF THE CIRCLE, which is why ±20 still pinned.
        // A per-component bound b makes wind of magnitude b reachable from EVERY
        // bearing, but b*sqrt(2) only along the diagonal: at b=20 that is 39 kt
        // omnidirectional against 55 kt diagonal. The reachable set is a square;
        // the physical quantity is a magnitude, which is a circle. Measured on a
        // benchmark scenario, a true wind of 21.5 m/s on bearing 68 deg needed
        // windE = 20.0 — exactly the ceiling — so an ordinary 42 kt wind pinned
        // for no reason but its direction, and an active pin makes
        // judgeRepresentative() report "search incomplete".
        //
        // THIS BOUND IS A SEARCH RANGE, NOT A PHYSICAL ENVELOPE. That is a
        // deliberate change of role: at ±20 the box was doing double duty, both
        // bracketing the search and quietly excluding non-lantern motion, and
        // the two jobs wanted different numbers. Exclusion now rests where it
        // can be reasoned about — the extraCost speed prior below, which still
        // prefers light winds, and the kinematic ordinariness screen. The box no
        // longer refuses a fast wind; it declines to prefer one.
        //
        // The consequence, stated plainly: the diagonal now admits 110 kt, which
        // is not lantern-like. A magnitude constraint (speed and bearing, with
        // speed bounded) would give the circle the physics actually describes
        // and is the better long-term shape — see the corrections queue.
        return [
            {name: "initialRange", min: 200,    max: 30000, default: 3000,  scale: 500},
            {name: "windE",        min: -40,    max: 40,    default: 0,     scale: 2},
            {name: "windN",        min: -40,    max: 40,    default: 0,     scale: 2},
            {name: "shearPerM",    min: -0.004, max: 0.008, default: 0.001, scale: 0.001},
            {name: "vRise",        min: 0,      max: 4,     default: 1.5,   scale: 0.5},
            {name: "vSink",        min: 0,      max: 4,     default: 1.0,   scale: 0.5},
            {name: "tBurn",        min: -1200,  max: 600,   default: 60,    scale: 60},
            {name: "tauCool",      min: 10,     max: 240,   default: 60,    scale: 20},
            // Time-varying wind (see _windAt). Values are the linear and
            // quadratic CHANGE in each component across the whole clip, in m/s,
            // so they mean the same thing on a 60 s clip as on a 700 s one.
            // Bounds are deliberately generous: the variation prior in
            // extraCost, not the bound, is what limits how much the wind may
            // wander — a bound tight enough to bite would forbid a real gust
            // front as well as a fitting artefact.
            {name: "windDriftE",   min: -15,    max: 15,    default: 0,     scale: 1.5},
            {name: "windDriftN",   min: -15,    max: 15,    default: 0,     scale: 1.5},
            {name: "windCurveE",   min: -15,    max: 15,    default: 0,     scale: 1.5},
            {name: "windCurveN",   min: -15,    max: 15,    default: 0,     scale: 1.5},
        ];
    }

    // Invert a geometric track that already fits the sightlines (the best
    // Kalman-smoother / least-manoeuvring path) into a balloon parameter seed,
    // so the fit STARTS on that path and refines from there rather than
    // searching the 12-D space blind. This is the whole reason the time-varying
    // wind exists: unseeded, differential evolution cannot cover the enlarged
    // space at the shipping budget and pins parameters at their bounds (measured:
    // 2.46 deg, 4x worse than constant wind). Seeded from the smoother it lands
    // in the right basin and refines.
    //
    // A lantern IS a wind tracer, so the inversion is direct: the ground velocity
    // (dx/dt, dy/dt) is the wind, and the wind's linear + quadratic drift across
    // the clip is a least-squares quadratic of that velocity against normalised
    // time s = t/T — the exact inverse of _windAt (shear seeded to 0 so mult = 1,
    // making the quadratic read straight onto windE/windDriftE/windCurveE). The
    // vertical rate seeds the life-cycle so a level, rising or descending path is
    // reproduced. Everything is clamped to the parameter bounds, so a seed is
    // never silently repaired by the optimizer into something else.
    //
    // Stores the vector on this.seed; call seedParams() for it or read it via a
    // paramOverrides map. Uses this.clipDuration for the s normalisation to match
    // _windAt exactly; set clipDuration before calling.
    seedFromTrack(track, dataset) {
        const {sensorPos, times, count} = dataset;
        const T = this.clipDuration > 0 ? this.clipDuration
            : ((times[count - 1] - times[0]) || 1);
        const h = 3;  // half-window for velocity, matches DroneControlFit

        // Normal-equation accumulators for the quadratic v(s) = c0 + c1 s + c2 s^2,
        // fitted separately for the east and north wind components, plus the mean
        // vertical rate.
        let S0 = 0, S1 = 0, S2 = 0, S3 = 0, S4 = 0;
        let bE0 = 0, bE1 = 0, bE2 = 0, bN0 = 0, bN1 = 0, bN2 = 0;
        let vzSum = 0;
        for (let f = 0; f < count; f++) {
            const a = Math.max(0, f - h), b = Math.min(count - 1, f + h);
            const dt = (times[b] - times[a]) || 1e-6;
            const vE = (track[b * 3] - track[a * 3]) / dt;
            const vN = (track[b * 3 + 1] - track[a * 3 + 1]) / dt;
            const vz = (track[b * 3 + 2] - track[a * 3 + 2]) / dt;
            const s = (times[f] - times[0]) / T;
            const s2 = s * s;
            S0 += 1; S1 += s; S2 += s2; S3 += s2 * s; S4 += s2 * s2;
            bE0 += vE; bE1 += vE * s; bE2 += vE * s2;
            bN0 += vN; bN1 += vN * s; bN2 += vN * s2;
            vzSum += vz;
        }
        const E = _solve3([S0, S1, S2, S1, S2, S3, S2, S3, S4], [bE0, bE1, bE2])
            || [bE0 / (S0 || 1), 0, 0];
        const N = _solve3([S0, S1, S2, S1, S2, S3, S2, S3, S4], [bN0, bN1, bN2])
            || [bN0 / (S0 || 1), 0, 0];
        const meanVz = vzSum / (count || 1);

        const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : 0));
        // range along the first LOS ray
        const range = Math.hypot(
            track[0] - sensorPos[0], track[1] - sensorPos[1], track[2] - sensorPos[2]);
        // Vertical life-cycle: a constant rate of either sign is representable —
        // rising via the burn phase, descending via a fully-decayed cooling phase.
        const vRise = clamp(Math.max(meanVz, 0), 0, 4);
        const vSink = clamp(Math.max(-meanVz, 0), 0, 4);
        const rising = meanVz >= 0;
        const tBurn = rising ? clamp(T + 60, -1200, 600) : -1200;
        const tauCool = rising ? 60 : 30;

        this.seed = [
            clamp(range, 200, 30000),
            // Must match the windE/windN bounds above: a seed clamped tighter
            // than the search starts the optimizer on the wall it exists to let
            // the fit leave.
            clamp(E[0], -40, 40),        // windE  (v at s=0)
            clamp(N[0], -40, 40),        // windN
            0,                           // shearPerM — 0 so mult=1 and the
                                         // quadratic reads straight onto the wind
            vRise, vSink, tBurn, tauCool,
            clamp(E[1], -15, 15),        // windDriftE (linear in s)
            clamp(N[1], -15, 15),        // windDriftN
            clamp(E[2], -15, 15),        // windCurveE (quadratic in s)
            clamp(N[2], -15, 15),        // windCurveN
        ];
        return this.seed;
    }

    /** Seed vector in getParameterDefs order, or null if not yet seeded. */
    seedParams() {
        return this.seed ? this.seed.slice() : null;
    }

    // Wind at time t, before the altitude shear multiplier: the base wind plus a
    // smooth quadratic variation across the clip.
    //
    // WHY THIS EXISTS. With wind held constant the model can only produce a
    // straight ground track, and a straight track is not what the sightlines
    // want. Measured on the Generated Orbit Test sitch: a straight line tops out
    // at 0.572 deg however it is parameterised (a quadcopter constrained to no
    // turn, no accel and no wind reaches 0.572; the free 9-parameter quadcopter
    // only improves that to 0.541), while a Kalman smoother with enough freedom
    // reaches 0.11 deg and lands 33 m from truth against the balloon's 64 m.
    // The balloon was not failing to search — it had no mechanism to follow a
    // path that is only ROUGHLY straight. Real wind varies over minutes; this
    // gives it that, and nothing more.
    //
    // Normalised on this.clipDuration so the parameters are duration-invariant.
    // If a caller has not set it the variation terms are inert, which keeps the
    // model behaving exactly as before rather than silently mis-scaling.
    _windAt(t, params) {
        const T = this.clipDuration;
        if (!(T > 0)) return [params[1], params[2]];
        const s = t / T;
        const s2 = s * s;
        const at = (i) => (Number.isFinite(params[i]) ? params[i] : 0);
        return [
            params[1] + at(8) * s + at(10) * s2,
            params[2] + at(9) * s + at(11) * s2,
        ];
    }

    // Mean-square variation of the wind about its own time-average, in (m/s)^2.
    //
    // For w(s) = A s + B s^2 on s in [0,1], var = A^2/12 + A*B/6 + 4*B^2/45.
    // Closed form, so this costs nothing to evaluate inside the fit, and it is
    // duration-invariant by construction: the same physical gust costs the same
    // on any clip length. Same principle as QuadcopterModel._turnEffortCost.
    // Absent variation parameters read as zero, so a caller passing the original
    // 8-parameter vector gets the original constant-wind cost rather than NaN.
    _windVariationCost(params) {
        const at = (i) => (Number.isFinite(params[i]) ? params[i] : 0);
        const varOf = (A, B) => (A * A) / 12 + (A * B) / 6 + (4 * B * B) / 45;
        const total = varOf(at(8), at(10)) + varOf(at(9), at(11));
        return total / (WIND_VARIATION_REF * WIND_VARIATION_REF);
    }

    // Initial state: position along first LOS ray; geodetic h0 stashed in the state.
    getInitialState(params, dataset) {
        const range = params[0];
        const sx = dataset.sensorPos[0], sy = dataset.sensorPos[1], sz = dataset.sensorPos[2];
        const dx = dataset.losDir[0], dy = dataset.losDir[1], dz = dataset.losDir[2];
        const x0 = sx + range * dx;
        const y0 = sy + range * dy;
        const z0 = sz + range * dz;
        const h0 = z0 + (x0 * x0 + y0 * y0) / (2 * EARTH_R);
        return [x0, y0, z0, h0];
    }

    // Lantern life-cycle vertical rate (see header).
    _vz(t, params) {
        const vRise = params[4], vSink = params[5], tBurn = params[6], tau = params[7];
        if (t <= tBurn) return vRise;
        return -vSink + (vRise + vSink) * Math.exp(-(t - tBurn) / tau);
    }

    // ODE: derivatives of [x, y, z, h0] — horizontal velocity is the sheared
    // wind at the current altitude, vertical is the life-cycle profile.
    derivatives(state, params, t) {
        const x = state[0], y = state[1], z = state[2], h0 = state[3];
        const h = z + (x * x + y * y) / (2 * EARTH_R);
        const shear = params[3];
        let mult = 1 + shear * (h - h0);
        if (mult < MULT_MIN) mult = MULT_MIN;
        if (mult > MULT_MAX) mult = MULT_MAX;
        const w = this._windAt(t, params);
        const vx = w[0] * mult, vy = w[1] * mult;
        return [vx, vy, this._vz(t, params) - (x * vx + y * vy) / EARTH_R, 0];
    }

    // Closed-form geodetic altitude at time t (the prescribed dh/dt is exact;
    // used by extraCost to keep the whole profile above the surface without
    // integrating).
    _hAt(t, params, h0) {
        const vRise = params[4], vSink = params[5], tBurn = params[6], tau = params[7];
        // integral of the decay-phase vz over u seconds past burnout
        const decayInt = (u) => -vSink * u + (vRise + vSink) * tau * (1 - Math.exp(-u / tau));
        if (tBurn >= 0) {
            if (t <= tBurn) return h0 + vRise * t;
            return h0 + vRise * tBurn + decayInt(t - tBurn);
        }
        // clip starts mid-decay
        return h0 + decayInt(t - tBurn) - decayInt(-tBurn);
    }

    // Soft plausibility priors (added to meanErrDeg/errSigma in the fit cost).
    // The hard parameter bounds carry the real physics; these only nudge.
    extraCost(params, dataset, T) {
        let cost;
        if (this.windPriorE !== null && this.windPriorN !== null) {
            // measured-corrected: pin the fitted drift wind loosely to the
            // sampled winds-aloft, so the fit can't drag drift slow to trade
            // range against an invented calm.
            const dE = params[1] - this.windPriorE;
            const dN = params[2] - this.windPriorN;
            cost = (dE * dE + dN * dN) / (this.windPriorSigma ** 2);
        } else {
            // no usable wind field — fall back to preferring light winds: a
            // lantern launch implies calm-ish conditions (~19 kt costs 0.5;
            // 43 kt costs ~2.5 — real but increasingly unusual)
            const spd = Math.hypot(params[1], params[2]);
            cost = 0.5 * (spd / 10) ** 2;
        }
        // negative shear (wind slower higher up) is possible but less common
        if (params[3] < 0) cost += 0.5 * (params[3] / 0.002) ** 2;
        cost += this._windVariationCost(params);
        // soft sea-level floor on the closed-form altitude profile
        const sx = dataset.sensorPos[0] + params[0] * dataset.losDir[0];
        const sy = dataset.sensorPos[1] + params[0] * dataset.losDir[1];
        const sz = dataset.sensorPos[2] + params[0] * dataset.losDir[2];
        const h0 = sz + (sx * sx + sy * sy) / (2 * EARTH_R);
        for (let k = 0; k <= 16; k++) {
            const h = this._hAt(T * k / 16, params, h0);
            if (h < 0) cost += (h / 8) ** 2 / 17;
        }
        return cost;
    }

    // Display-only itemisation of extraCost above — see PhysicsModel.
    extraCostTerms(params, dataset, T) {
        const terms = {};
        if (this.windPriorE !== null && this.windPriorN !== null) {
            const dE = params[1] - this.windPriorE;
            const dN = params[2] - this.windPriorN;
            terms["wind toward measured"] = (dE * dE + dN * dN) / (this.windPriorSigma ** 2);
        } else {
            const spd = Math.hypot(params[1], params[2]);
            terms["calm-wind preference"] = 0.5 * (spd / 10) ** 2;
        }
        if (params[3] < 0) terms["negative shear"] = 0.5 * (params[3] / 0.002) ** 2;
        terms["wind variability"] = this._windVariationCost(params);
        const sx = dataset.sensorPos[0] + params[0] * dataset.losDir[0];
        const sy = dataset.sensorPos[1] + params[0] * dataset.losDir[1];
        const sz = dataset.sensorPos[2] + params[0] * dataset.losDir[2];
        const h0 = sz + (sx * sx + sy * sy) / (2 * EARTH_R);
        let below = 0;
        for (let k = 0; k <= 16; k++) {
            const h = this._hAt(T * k / 16, params, h0);
            if (h < 0) below += (h / 8) ** 2 / 17;
        }
        if (below) terms["below-surface profile"] = below;
        return terms;
    }
}
