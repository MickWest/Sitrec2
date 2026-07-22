// solvers.js — the eight primary solver configurations plus the MC2 sentinel
// (PLAN.md "Solver configurations"). Each run returns a normalized estimate:
//   {kind: "track", positions: Float64Array(3n), parameterSummary}
//   {kind: "direction", directionENU: [x,y,z], parameterSummary}
// or null when the underlying fitter returns null.
//
// CAUTION (contract): the fitters' native result.residuals are in MIXED UNITS
// (metres for CV/CA/KS, radians for MC/ALSQ) — they are never used here; all
// cross-solver residuals are recomputed in metrics.js through one shared
// clamped dot-angle reducer.

import {
    fitConstantVelocity,
    fitConstantAcceleration,
    fitKalmanFilter,
    fitAlternatingLSQ,
    fitMonteCarlo2,
} from "../../../src/LOSFitting";
import {fitFixedPoint, fitFixedDirection} from "../../../src/TraverseAnalysis";
import {toLOSDataset, toActiveTraverseDataset} from "./adapters";
import {deriveSeed} from "./rng";

function trackEstimate(fit, params = {}) {
    if (!fit || !fit.positions) return null;
    return {kind: "track", positions: fit.positions, parameterSummary: params};
}

export const SOLVERS = [
    {
        id: "cv", family: "least-squares", outputKind: "track", options: {},
        run(scenario) {
            const fit = fitConstantVelocity(toLOSDataset(scenario), scenario.observation.excluded);
            return trackEstimate(fit, fit ? {P0: fit.params.P0, V: fit.params.V} : {});
        },
    },
    {
        id: "ca", family: "least-squares", outputKind: "track", options: {},
        run(scenario) {
            const fit = fitConstantAcceleration(toLOSDataset(scenario), scenario.observation.excluded);
            return trackEstimate(fit, fit ? {...fit.params} : {});
        },
    },
    ...[["ks-default", 1e-4], ["ks-q1e-5", 1e-5], ["ks-q1e-3", 1e-3]].map(([id, q]) => ({
        id, family: "kalman-rts", outputKind: "track",
        options: {processNoise: q, measurementNoise: 1.0},
        run(scenario) {
            const fit = fitKalmanFilter(toLOSDataset(scenario), scenario.observation.excluded,
                {processNoise: q, measurementNoise: 1.0});
            return trackEstimate(fit, {processNoise: q, measurementNoise: 1.0});
        },
    })),
    {
        id: "alsq2", family: "alternating-lsq", outputKind: "track",
        options: {order: 2, iterations: 12},
        run(scenario) {
            const fit = fitAlternatingLSQ(toLOSDataset(scenario), scenario.observation.excluded,
                {order: 2, iterations: 12});
            return trackEstimate(fit, {order: 2});
        },
    },
    {
        id: "fixed-point", family: "geometric", outputKind: "track", options: {},
        run(scenario) {
            const {dataset} = toActiveTraverseDataset(scenario);
            if (dataset.n < 2) return null;
            const fit = fitFixedPoint(dataset);
            if (!fit || !fit.point || !fit.point.every(Number.isFinite)) return null;
            // Expand back to the full frame grid: the same point every frame.
            const positions = new Float64Array(scenario.n * 3);
            for (let f = 0; f < scenario.n; f++) {
                positions[f * 3] = fit.point[0];
                positions[f * 3 + 1] = fit.point[1];
                positions[f * 3 + 2] = fit.point[2];
            }
            return {kind: "track", positions,
                parameterSummary: {point: fit.point, nativeErrDeg: fit.errDeg}};
        },
    },
    {
        id: "fixed-direction", family: "geometric", outputKind: "direction", options: {},
        run(scenario) {
            const {dataset} = toActiveTraverseDataset(scenario);
            if (dataset.n < 2) return null;
            const fit = fitFixedDirection(dataset);
            if (!fit || !fit.dir || !fit.dir.every(Number.isFinite)) return null;
            return {kind: "direction", directionENU: fit.dir,
                parameterSummary: {nativeErrDeg: fit.errDeg}};
        },
    },
];

// MC2 sentinel (8 named scenarios only — never part of the primary grid, and
// excluded from classifier training).
export function mc2Solver(realizedRmsDeg) {
    return {
        id: "mc2-sentinel", family: "monte-carlo", outputKind: "track",
        options: {order: 2, numTrials: 500, losUncertaintyDeg: realizedRmsDeg},
        run(scenario) {
            // Deterministic sentinel (contract): seed derives from the scenario.
            const seed = deriveSeed(scenario.scenarioId, scenario.scenarioSeed,
                "mc2", scenario.generatorVersion);
            const fit = fitMonteCarlo2(toLOSDataset(scenario), scenario.observation.excluded,
                {order: 2, numTrials: 500, seed,
                    losUncertaintyDeg: Math.max(realizedRmsDeg, 1e-3)});
            return trackEstimate(fit, {order: 2, numTrials: 500, seed});
        },
    };
}
