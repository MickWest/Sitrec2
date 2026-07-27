// physicsSolvers.js — round 2: Sitrec's flagship (slow) traverse solvers
// normalized to the benchmark estimate interface. These are the methods the
// analysis gallery actually leads with, unmeasured in round 1:
//
//   physics-lantern     fitPhysicsModel + SkyLanternModel (free wind)
//   physics-quadcopter  fitPhysicsModel + QuadcopterModel (generic envelope)
//   physics-fixedwing   TraverseAnalysis.fitAircraft (DE, generic prior)
//   min-accel           fitPlausibleBestRange (finds its own range)
//   min-speed           traverseMinSpeed (slowest consistent object)
//
// DE budgets are the moderate deterministic ones used by the existing
// recovery/repro tests (pop 30 / gens 40 / stride 2) — NOT the in-app
// production budgets. Comparisons between solvers in this bench are fair
// (same budgets throughout); absolute quality may modestly undershoot the
// app. The drone-control (flown-inputs) fit is deferred: it requires the
// smoother-seeded control-inversion machinery from AnalyzeTraverse.
//
// All are deterministic: DE runs from its fixed default seed.

import {fitPhysicsModel} from "../../../src/LOSFitting";
import {SkyLanternModel} from "../../../src/SkyLanternModel";
import {QuadcopterModel} from "../../../src/QuadcopterModel";
import {fitAircraft, fitPlausibleBestRange, traverseMinSpeed} from "../../../src/TraverseAnalysis";
import {toLOSDataset, toTraverseDataset} from "./adapters";

const DE_OPTS = {optimizer: "de", dePop: 30, deGens: 40, sampleStride: 2};

function clipSeconds(scenario) {
    return (scenario.n - 1) / scenario.fps;
}

// Truth mean wind (E,N m/s) at mid-clip, for lantern wind-recovery scoring.
export function truthMeanWind(scenario) {
    const mid = (scenario.n >> 1) * 3;
    return {
        u: scenario.wind.sampledVelocityENU[mid],
        v: scenario.wind.sampledVelocityENU[mid + 1],
    };
}

export const PHYSICS_SOLVERS = [
    {
        id: "physics-lantern", family: "physics", outputKind: "track",
        options: {...DE_OPTS},
        async run(scenario) {
            const model = new SkyLanternModel();
            model.clipDuration = clipSeconds(scenario);
            const fit = await fitPhysicsModel(toLOSDataset(scenario),
                scenario.observation.excluded, model, DE_OPTS);
            if (!fit || !fit.positions) return null;
            const s = fit.params.solved ?? {};
            return {kind: "track", positions: fit.positions,
                parameterSummary: {
                    errDeg: fit.params.errDeg,
                    windE: s.windE, windN: s.windN, vRise: s.vRise,
                    tBurn: s.tBurn, range: s.initialRange ?? fit.params.solved?.range,
                    stopReason: fit.params.optimizer?.stopReason,
                    pinned: fit.params.pinned ?? null,
                }};
        },
    },
    {
        id: "physics-quadcopter", family: "physics", outputKind: "track",
        options: {...DE_OPTS},
        async run(scenario) {
            const model = new QuadcopterModel();
            if ("clipDuration" in model) model.clipDuration = clipSeconds(scenario);
            const fit = await fitPhysicsModel(toLOSDataset(scenario),
                scenario.observation.excluded, model, DE_OPTS);
            if (!fit || !fit.positions) return null;
            return {kind: "track", positions: fit.positions,
                parameterSummary: {
                    errDeg: fit.params.errDeg,
                    solved: fit.params.solved ?? null,
                    stopReason: fit.params.optimizer?.stopReason,
                }};
        },
    },
    {
        id: "physics-fixedwing", family: "physics", outputKind: "track",
        options: {},
        async run(scenario) {
            const fit = await fitAircraft(toTraverseDataset(scenario), {});
            if (!fit || !fit.track) return null;
            return {kind: "track", positions: fit.track,
                parameterSummary: {
                    errDeg: fit.errDeg,
                    tasMS: fit.params.tas, headingDeg: fit.params.heading,
                    turnRate: fit.params.turnRate, climbMS: fit.params.climb,
                    rangeM: fit.params.startDist,
                    pinned: fit.pinned ?? null,
                }};
        },
    },
    {
        id: "min-accel", family: "ray-constrained", outputKind: "track",
        options: {},
        async run(scenario) {
            const fit = await fitPlausibleBestRange(toTraverseDataset(scenario), {});
            if (!fit || !fit.track) return null;
            return {kind: "track", positions: fit.track,
                parameterSummary: {
                    foundRangeM: fit.startDist,
                    usedSpeedTarget: fit.usedSpeedTarget ?? null,
                    boundaryLimited: fit.boundaryLimited ?? null,
                    score: fit.score,
                }};
        },
    },
    {
        id: "min-speed", family: "ray-constrained", outputKind: "track",
        options: {},
        run(scenario) {
            const fit = traverseMinSpeed(toTraverseDataset(scenario), {});
            if (!fit || !fit.track) return null;
            const lam = fit.lam ? Array.from(fit.lam).sort((a, b) => a - b) : null;
            return {kind: "track", positions: fit.track,
                parameterSummary: {
                    medianRangeM: lam ? lam[lam.length >> 1] : null,
                }};
        },
    },
];
