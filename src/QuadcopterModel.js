// Quadcopter (multirotor) physics model for LOS trajectory fitting.
//
// Unlike a fixed-wing aircraft, a multirotor is HOVER-capable: it needs no
// forward airspeed to stay aloft, can start and stop, move slowly in any
// direction, turn on the spot, and climb/descend far more steeply than a
// plane. What distinguishes one drone from another is its ENVELOPE — top
// horizontal speed and max ascent/descent rate — so the model carries an
// optional catalog envelope (DJI Mini, Air 3, FPV racer, …) that bounds the
// fit. A solution that would demand more than a given drone can do simply is
// not that drone, and the residual LOS error says so honestly.
//
// Kinematics: the craft moves at air-relative horizontal speed v along heading psi, with v
// free to change (constant along-track accel, so it can spin up from hover or
// coast to a stop), psi turning at a linearly-varying rate (quads turn quickly),
// a constant climb rate, and constant wind advection. A GPS-held hover in wind
// is represented by an air-relative velocity opposing the solved wind; v=0 is
// passive drift, not a claim of zero ground speed.
//
// State is [x, y, z, psi, v] in ENU (x=East, y=North, z=Up):
//   x,y,z  position (m)
//   psi    heading (rad, 0 = North, pi/2 = East)
//   v      air-relative horizontal speed along heading (m/s)
//
// Parameters solved by the optimizer:
//   0: initialRange — distance along the first LOS ray (m)
//   1: headingDeg   — initial heading in the sensor-origin ENU frame (deg)
//   2: speed        — initial air-relative speed (m/s) [0 .. envelope maxSpeed]
//   3: accel        — along-track acceleration (m/s^2)
//   4: turnRate     — initial turn rate (deg/s, + = clockwise)
//   5: turnAccel    — turn-rate change (deg/s^2)
//   6: climb        — vertical speed (m/s, + = up)  [-maxDescent .. maxAscent]
//   7: windE        — east wind (m/s)
//   8: windN        — north wind (m/s)

import {PhysicsModel} from "./PhysicsModel";

const DEG = Math.PI / 180;
const EARTH_R = 6371000;

export class QuadcopterModel extends PhysicsModel {
    // Smooth kinematics: 1/30 s substeps are plenty (the 0.02 s base default is
    // for stiff drag models).
    maxDt = 1 / 30;

    // Optional airframe envelope (a QUADCOPTER_MODELS catalog entry, or null
    // for the generic "any multirotor" envelope). Set to a specific drone to
    // bound the fit to that model's real speed / climb capability.
    envelope = null;

    // Optional soft wind prior (see FixedWingModel) — when the fit node wires a
    // wind guess, the solved wind is loosely pinned to it instead of drifting.
    windPriorE = null;
    windPriorN = null;
    windPriorSigma = 5;   // ~10 kt

    getName() {
        return "Quadcopter";
    }

    _maxSpeed()   { return this.envelope ? this.envelope.maxSpeed   : 60; }
    _maxAscent()  { return this.envelope ? this.envelope.maxAscent  : 30; }
    _maxDescent() { return this.envelope ? this.envelope.maxDescent : 30; }

    getParameterDefs() {
        // name, min, max, default, scale (initial simplex perturbation)
        const maxSpeed = this._maxSpeed();
        const maxAscent = this._maxAscent();
        const maxDescent = this._maxDescent();
        return [
            // A visible multirotor is a near-field object — keep the range
            // search local (50 m .. 20 km). A quad hypothesis at tens of NM
            // simply won't reach the rays, which is the correct verdict.
            {name: "initialRange", min: 50,   max: 20000, default: 1000, scale: 300},
            {name: "headingDeg",   min: 0,    max: 360,   default: 0,    scale: 30},
            {name: "speed",        min: 0,    max: maxSpeed, default: Math.min(5, maxSpeed), scale: Math.max(1, maxSpeed * 0.1)},
            {name: "accel",        min: -3,   max: 3,     default: 0,    scale: 0.3},
            {name: "turnRate",     min: -60,  max: 60,    default: 0,    scale: 5},   // quads turn fast
            {name: "turnAccel",    min: -10,  max: 10,    default: 0,    scale: 1},
            {name: "climb",        min: -maxDescent, max: maxAscent, default: 0, scale: 1},
            {name: "windE",        min: -15,  max: 15,    default: 0,    scale: 2},
            {name: "windN",        min: -15,  max: 15,    default: 0,    scale: 2},
        ];
    }

    // Initial state: position along the first LOS ray, initial heading & speed.
    getInitialState(params, dataset) {
        const range = params[0];
        const sx = dataset.sensorPos[0], sy = dataset.sensorPos[1], sz = dataset.sensorPos[2];
        const dx = dataset.losDir[0], dy = dataset.losDir[1], dz = dataset.losDir[2];
        return [
            sx + range * dx,
            sy + range * dy,
            sz + range * dz,
            params[1] * DEG,
            params[2],
        ];
    }

    // ODE: derivatives of [x, y, z, psi, v]
    derivatives(state, params, t) {
        const psi = state[3];
        const v = state[4];
        const vx = v * Math.sin(psi) + params[7];
        const vy = v * Math.cos(psi) + params[8];
        return [
            vx,                                   // dx/dt: air-relative East + windE
            vy,                                   // dy/dt: air-relative North + windN
            params[6] - (state[0] * vx + state[1] * vy) / EARTH_R,
            (params[4] + params[5] * t) * DEG,   // dpsi/dt: linearly varying turn rate
            params[3],                           // dv/dt: along-track acceleration
        ];
    }

    // Soft plausibility priors, added to meanErrDeg/errSigma in the fit cost.
    // The hard bounds carry the envelope at the endpoints; this keeps the speed
    // inside the envelope for the WHOLE clip (accel can push it past mid-flight),
    // gently discourages violent turn-rate changes, and prefers light/near-guess
    // wind (a quad in position hold barely drifts).
    extraCost(params, dataset, T) {
        const maxSpeed = this._maxSpeed();
        const v0 = params[2], accel = params[3];
        let cost = 0;
        for (let k = 0; k <= 8; k++) {
            const v = Math.abs(v0 + accel * T * k / 8);
            if (v > maxSpeed) cost += ((v - maxSpeed) / 2) ** 2 / 9;
        }
        // gentle smoothness prior on turn acceleration
        cost += 0.1 * (params[5] / 5) ** 2;
        // wind: pin to guess if provided, else prefer light wind
        if (this.windPriorE !== null && this.windPriorN !== null) {
            cost += ((params[7] - this.windPriorE) / this.windPriorSigma) ** 2
                + ((params[8] - this.windPriorN) / this.windPriorSigma) ** 2;
        } else {
            const wspd = Math.hypot(params[7], params[8]);
            cost += 0.3 * (wspd / 6) ** 2;
        }
        return cost;
    }
}
