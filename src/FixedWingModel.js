// Fixed-wing aircraft physics model for LOS trajectory fitting.
// Kinematic model of a conventional aircraft in roughly straight, roughly
// level/cruise approximation: constant horizontal airspeed through the air mass, heading integrates a
// linearly-varying turn rate, constant climb, constant wind advection.
//
// State is [x, y, z, psi] in ENU (x=East, y=North, z=Up), psi = heading
// in radians (0 = North, pi/2 = East).
//
// Parameters solved by optimizer:
//   0: initialRange — distance along first LOS ray (meters)
//   1: headingDeg   — initial heading in the sensor-origin ENU frame (degrees)
//   2: tas          — horizontal airspeed (legacy parameter name, m/s)
//   3: turnRate     — initial turn rate (deg/s, positive = clockwise)
//   4: turnAccel    — turn rate change (deg/s^2)
//   5: climb        — vertical speed (m/s, positive = up)
//   6: windE        — east wind component (m/s)
//   7: windN        — north wind component (m/s)
//
// Pure LOS angular error is hugely ambiguous for this model (near-perfect
// fits exist over a wide family of turning trajectories), so extraCost()
// adds soft plausibility priors: prefer straight, level flight near a
// typical cruise speed. The tuning matches the validated fitAircraft()
// in TraverseAnalysis.js (checked against real Gimbal data).

import {PhysicsModel} from "./PhysicsModel";

const DEG = Math.PI / 180;
const EARTH_R = 6371000;

export class FixedWingModel extends PhysicsModel {
    // Smooth kinematics: 1/30s substeps are plenty (base default 0.02s is
    // for stiff drag models) and much faster over long engagements.
    maxDt = 1 / 30;

    // Soft plausibility targets (see extraCost).
    tasTarget = 195.5;  // preferred horizontal airspeed, m/s (380 kt)
    tasSigma = 77;      // speed-prior looseness, m/s (~150 kt)
    turnSigma = 0.5;    // straightness looseness, deg/s
    climbSigma = 8;     // level-flight looseness, m/s

    // Optional soft wind prior (m/s components + sigma). When set (the fit
    // node seeds it from the wind-guess GUI / the sitch's target wind), the
    // solved wind is pinned loosely to the guess — otherwise the free wind
    // parameters soak up trajectory ambiguity and drift to fantasy winds.
    windPriorE = null;
    windPriorN = null;
    windPriorSigma = 7.7;   // ~15 kt

    // Optional airframe envelope (a FIXED_WING_MODELS catalog entry, or null
    // for the generic conventional prior). When set to a specific type
    // (Cessna 172, F/A-18, …) it tightens the speed/climb bounds and shifts the
    // cruise-speed prior to that airframe, so the fit can only find a
    // trajectory that particular aircraft could actually fly. Null keeps the
    // original generic bounds (25..360 m/s horizontal airspeed) — the AUTO behaviour.
    envelope = null;

    getName() {
        return "Fixed Wing Aircraft";
    }

    // Cruise-speed prior target/looseness — from the selected airframe when
    // one is chosen, else the generic 380 kt / 150 kt defaults above.
    _tasTarget() { return this.envelope ? this.envelope.cruise : this.tasTarget; }
    _tasSigma()  { return this.envelope
        ? Math.max(20, (this.envelope.tasMax - this.envelope.tasMin) * 0.35)
        : this.tasSigma; }

    getParameterDefs() {
        // name, min, max, default, scale (initial simplex perturbation)
        const env = this.envelope;
        const tasMin = env ? env.tasMin : 25;      // ~50 kt generic floor
        const tasMax = env ? env.tasMax : 360;     // ~700 kt generic ceiling
        const climbMax = env ? env.climbMax : 40;
        const tasDefault = Math.min(Math.max(env ? env.cruise : 195, tasMin), tasMax);
        return [
            {name: "initialRange", min: 1852, max: 83340, default: 55560, scale: 2000}, // 1..45 NM, default 30 NM
            {name: "headingDeg",   min: 0,        max: 360,     default: 250,        scale: 20},
            {name: "tas",          min: tasMin,   max: tasMax,  default: tasDefault, scale: 15},
            {name: "turnRate",     min: -4,       max: 4,       default: 0,          scale: 0.3},
            {name: "turnAccel",    min: -0.3,     max: 0.3,     default: 0,          scale: 0.02},
            {name: "climb",        min: -climbMax,max: climbMax,default: 0,          scale: 2},
            {name: "windE",        min: -40,      max: 40,      default: 0,          scale: 2},
            {name: "windN",        min: -40,      max: 40,      default: 0,          scale: 2},
        ];
    }

    // Initial state: position along first LOS ray, initial heading in radians
    getInitialState(params, dataset) {
        const range = params[0];
        const sx = dataset.sensorPos[0], sy = dataset.sensorPos[1], sz = dataset.sensorPos[2];
        const dx = dataset.losDir[0], dy = dataset.losDir[1], dz = dataset.losDir[2];
        return [
            sx + range * dx,
            sy + range * dy,
            sz + range * dz,
            params[1] * DEG,
        ];
    }

    // ODE: derivatives of [x, y, z, psi]
    derivatives(state, params, t) {
        const psi = state[3];
        const tas = params[2];
        const vx = tas * Math.sin(psi) + params[6];
        const vy = tas * Math.cos(psi) + params[7];
        return [
            vx,                                  // dx/dt: air-mass velocity East + windE
            vy,                                  // dy/dt: air-mass velocity North + windN
            // `climb` is geodetic dh/dt. In a fixed ENU tangent frame,
            // h≈z+(x²+y²)/2R, hence dz/dt=dh/dt-(x vx+y vy)/R.
            params[5] - (state[0] * vx + state[1] * vy) / EARTH_R,
            (params[3] + params[4] * t) * DEG,  // dpsi/dt: linearly varying turn rate
        ];
    }

    // Soft plausibility priors, added to meanErrDeg/errSigma in the fit cost:
    // penalize turning at start AND end of the engagement (so turnAccel can't
    // hide a turn), climbing/descending, and speeds away from typical cruise.
    extraCost(params, dataset, T) {
        const tas = params[2];
        const turnStart = params[3];
        const turnEnd = params[3] + params[4] * T;
        const climb = params[5];
        const tasTarget = this._tasTarget();
        const tasSigma = this._tasSigma();
        let cost = (turnStart / this.turnSigma) ** 2
            + (turnEnd / this.turnSigma) ** 2
            + (climb / this.climbSigma) ** 2
            + ((tas - tasTarget) / tasSigma) ** 2;
        if (this.windPriorE !== null && this.windPriorN !== null) {
            cost += ((params[6] - this.windPriorE) / this.windPriorSigma) ** 2
                + ((params[7] - this.windPriorN) / this.windPriorSigma) ** 2;
        }
        return cost;
    }

    // Display-only itemisation of extraCost above — see PhysicsModel.
    //
    // Worth surfacing for the opposite reason to the balloon's: these are
    // priors pushing AGAINST maneuvering (turn, climb, off-cruise speed), so
    // they are the anomaly-side counterpart of the calm-wind preference. An
    // aircraft fit that only works by spending budget here is one the data did
    // not really want, and that should be as visible as the balloon's.
    extraCostTerms(params, dataset, T) {
        const tas = params[2];
        const turnStart = params[3];
        const turnEnd = params[3] + params[4] * T;
        const climb = params[5];
        const terms = {
            "turn at start": (turnStart / this.turnSigma) ** 2,
            "turn at end": (turnEnd / this.turnSigma) ** 2,
            "climb/descent": (climb / this.climbSigma) ** 2,
            "off cruise speed": ((tas - this._tasTarget()) / this._tasSigma()) ** 2,
        };
        if (this.windPriorE !== null && this.windPriorN !== null) {
            terms["wind toward measured"] =
                ((params[6] - this.windPriorE) / this.windPriorSigma) ** 2
                + ((params[7] - this.windPriorN) / this.windPriorSigma) ** 2;
        }
        return terms;
    }
}
