// Fixed-wing aircraft physics model for LOS trajectory fitting.
// Kinematic model of a conventional aircraft in roughly straight, roughly
// level cruise: constant TAS through the air mass, heading integrates a
// linearly-varying turn rate, constant climb, constant wind advection.
//
// State is [x, y, z, psi] in ENU (x=East, y=North, z=Up), psi = heading
// in radians (0 = North, pi/2 = East).
//
// Parameters solved by optimizer:
//   0: initialRange — distance along first LOS ray (meters)
//   1: headingDeg   — initial true heading (degrees)
//   2: tas          — true airspeed (m/s)
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

export class FixedWingModel extends PhysicsModel {
    // Smooth kinematics: 1/30s substeps are plenty (base default 0.02s is
    // for stiff drag models) and much faster over long engagements.
    maxDt = 1 / 30;

    // Soft plausibility targets (see extraCost).
    tasTarget = 195.5;  // preferred TAS, m/s (380 kt)
    tasSigma = 77;      // TAS looseness, m/s (~150 kt)
    turnSigma = 0.5;    // straightness looseness, deg/s
    climbSigma = 8;     // level-flight looseness, m/s

    // Optional soft wind prior (m/s components + sigma). When set (the fit
    // node seeds it from the wind-guess GUI / the sitch's target wind), the
    // solved wind is pinned loosely to the guess — otherwise the free wind
    // parameters soak up trajectory ambiguity and drift to fantasy winds.
    windPriorE = null;
    windPriorN = null;
    windPriorSigma = 7.7;   // ~15 kt

    getName() {
        return "Fixed Wing Aircraft";
    }

    getParameterDefs() {
        // name, min, max, default, scale (initial simplex perturbation)
        return [
            {name: "initialRange", min: 1852, max: 83340, default: 55560, scale: 2000}, // 1..45 NM, default 30 NM
            {name: "headingDeg",   min: 0,    max: 360,   default: 250,   scale: 20},
            {name: "tas",          min: 25,   max: 360,   default: 195,   scale: 15},   // ~50..700 kt, default ~380 kt
            {name: "turnRate",     min: -4,   max: 4,     default: 0,     scale: 0.3},
            {name: "turnAccel",    min: -0.3, max: 0.3,   default: 0,     scale: 0.02},
            {name: "climb",        min: -40,  max: 40,    default: 0,     scale: 2},
            {name: "windE",        min: -40,  max: 40,    default: 0,     scale: 2},
            {name: "windN",        min: -40,  max: 40,    default: 0,     scale: 2},
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
        return [
            tas * Math.sin(psi) + params[6],    // dx/dt: air-mass velocity East + windE
            tas * Math.cos(psi) + params[7],    // dy/dt: air-mass velocity North + windN
            params[5],                          // dz/dt: climb
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
        let cost = (turnStart / this.turnSigma) ** 2
            + (turnEnd / this.turnSigma) ** 2
            + (climb / this.climbSigma) ** 2
            + ((tas - this.tasTarget) / this.tasSigma) ** 2;
        if (this.windPriorE !== null && this.windPriorN !== null) {
            cost += ((params[6] - this.windPriorE) / this.windPriorSigma) ** 2
                + ((params[7] - this.windPriorN) / this.windPriorSigma) ** 2;
        }
        return cost;
    }
}
