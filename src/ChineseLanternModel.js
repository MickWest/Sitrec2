// Chinese Lantern physics model for LOS trajectory fitting.
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
//   wind(z) = (windE, windN) * clamp(1 + shearPerM (z - z0), 0.25, 3)
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
// State is [x, y, z, z0] in ENU: z0 (the shear reference altitude) rides
// along as a constant so derivatives() needs no out-of-band context. The
// dynamics are smooth, non-stiff kinematics — a 3-state integration with a
// large step, ~7x faster than the old drag ODE.

import {PhysicsModel} from "./PhysicsModel";

const MULT_MIN = 0.25;  // wind shear multiplier floor (never reverses)
const MULT_MAX = 3.0;   // ...and ceiling (never a hurricane aloft)

export class ChineseLanternModel extends PhysicsModel {
    // Smooth kinematics: big RK4 substeps are fine (the base 0.02 s default
    // exists for stiff drag models).
    maxDt = 0.25;

    getName() {
        return "Chinese Lantern";
    }

    getParameterDefs() {
        // name, min, max, default, scale (initial simplex perturbation)
        // Wind components bounded at 20 m/s (~39 kt each, 55 kt vector max).
        // A lantern is a wind tracer: launch implies calm-ish SURFACE wind,
        // but 40-45 kt at altitude is ordinary — a ±13 m/s bound encoded the
        // surface intuition and forced the fit to fake faster drift with the
        // shear multiplier (pinning both bounds and inflating the residual).
        // The extraCost speed prior below still prefers light winds.
        return [
            {name: "initialRange", min: 200,    max: 30000, default: 3000,  scale: 500},
            {name: "windE",        min: -20,    max: 20,    default: 0,     scale: 2},
            {name: "windN",        min: -20,    max: 20,    default: 0,     scale: 2},
            {name: "shearPerM",    min: -0.004, max: 0.008, default: 0.001, scale: 0.001},
            {name: "vRise",        min: 0,      max: 4,     default: 1.5,   scale: 0.5},
            {name: "vSink",        min: 0,      max: 4,     default: 1.0,   scale: 0.5},
            {name: "tBurn",        min: -1200,  max: 600,   default: 60,    scale: 60},
            {name: "tauCool",      min: 10,     max: 240,   default: 60,    scale: 20},
        ];
    }

    // Initial state: position along first LOS ray; z0 stashed in the state.
    getInitialState(params, dataset) {
        const range = params[0];
        const sx = dataset.sensorPos[0], sy = dataset.sensorPos[1], sz = dataset.sensorPos[2];
        const dx = dataset.losDir[0], dy = dataset.losDir[1], dz = dataset.losDir[2];
        const z0 = sz + range * dz;
        return [sx + range * dx, sy + range * dy, z0, z0];
    }

    // Lantern life-cycle vertical rate (see header).
    _vz(t, params) {
        const vRise = params[4], vSink = params[5], tBurn = params[6], tau = params[7];
        if (t <= tBurn) return vRise;
        return -vSink + (vRise + vSink) * Math.exp(-(t - tBurn) / tau);
    }

    // ODE: derivatives of [x, y, z, z0] — horizontal velocity is the sheared
    // wind at the current altitude, vertical is the life-cycle profile.
    derivatives(state, params, t) {
        const z = state[2], z0 = state[3];
        const shear = params[3];
        let mult = 1 + shear * (z - z0);
        if (mult < MULT_MIN) mult = MULT_MIN;
        if (mult > MULT_MAX) mult = MULT_MAX;
        return [params[1] * mult, params[2] * mult, this._vz(t, params), 0];
    }

    // Closed-form altitude at time t (wind never affects z, so z(t) is exact;
    // used by extraCost to keep the whole profile above the surface without
    // integrating).
    _zAt(t, params, z0) {
        const vRise = params[4], vSink = params[5], tBurn = params[6], tau = params[7];
        // integral of the decay-phase vz over u seconds past burnout
        const decayInt = (u) => -vSink * u + (vRise + vSink) * tau * (1 - Math.exp(-u / tau));
        if (tBurn >= 0) {
            if (t <= tBurn) return z0 + vRise * t;
            return z0 + vRise * tBurn + decayInt(t - tBurn);
        }
        // clip starts mid-decay
        return z0 + decayInt(t - tBurn) - decayInt(-tBurn);
    }

    // Soft plausibility priors (added to meanErrDeg/errSigma in the fit cost).
    // The hard parameter bounds carry the real physics; these only nudge.
    extraCost(params, dataset, T) {
        // prefer light winds: a lantern launch implies calm-ish conditions
        // (~19 kt costs 0.5; 43 kt costs ~2.5 — real but increasingly unusual)
        const spd = Math.hypot(params[1], params[2]);
        let cost = 0.5 * (spd / 10) ** 2;
        // negative shear (wind slower higher up) is possible but less common
        if (params[3] < 0) cost += 0.5 * (params[3] / 0.002) ** 2;
        // soft sea-level floor on the closed-form altitude profile
        const sz = dataset.sensorPos[2];
        const z0 = sz + params[0] * dataset.losDir[2];
        for (let k = 0; k <= 16; k++) {
            const z = this._zAt(T * k / 16, params, z0);
            if (z < 0) cost += (z / 8) ** 2 / 17;
        }
        return cost;
    }
}
