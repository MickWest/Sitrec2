/**
 * Tests for the pure-math traverse analysis core (src/TraverseAnalysis.js).
 *
 * Uses a synthetic scenario: a TURNING sensor (range along a LOS fan is only
 * observable when the sensor path curves — a constant-velocity sensor admits
 * zero-acceleration solutions at every scaled range) watching a
 * constant-velocity target through a constant wind.
 */

import {
    trackMetrics,
    meanAngularError,
    traverseConstSpeed,
    traverseConstAltitude,
    fitConstAltitude,
    fitFixedPoint,
    fitFixedDirection,
    traversePlausible,
    fitPlausibleBestRange,
    straightFlightScore,
    simulateAircraft,
    fitAircraft,
    KNOTS_TO_MS,
    METERS_PER_NM,
} from "../src/TraverseAnalysis";
import {patternSearchPolish} from "../src/DifferentialEvolution";

// Build a synthetic dataset: sensor on a turning path, CV target, constant wind.
function makeDataset({
    n = 600,
    fps = 30,
    windMs = [8, 4, 0],
    targetStart = [12000, 15000, 4500],
    targetVel = [90, 45, 0.5],   // ground-frame m/s
} = {}) {
    const S = new Float64Array(n * 3);
    const D = new Float64Array(n * 3);
    const W = new Float64Array(n * 3);
    const target = new Float64Array(n * 3);
    const Rs = 2500, omega = 0.035;  // sensor turn: radius m, rad/s (~2 deg/s)
    for (let f = 0; f < n; f++) {
        const t = f / fps;
        S[f * 3] = Rs * Math.sin(omega * t);
        S[f * 3 + 1] = Rs * (1 - Math.cos(omega * t));
        S[f * 3 + 2] = 3000 + 2 * t;
        target[f * 3] = targetStart[0] + targetVel[0] * t;
        target[f * 3 + 1] = targetStart[1] + targetVel[1] * t;
        target[f * 3 + 2] = targetStart[2] + targetVel[2] * t;
        let dx = target[f * 3] - S[f * 3];
        let dy = target[f * 3 + 1] - S[f * 3 + 1];
        let dz = target[f * 3 + 2] - S[f * 3 + 2];
        const dl = Math.hypot(dx, dy, dz);
        D[f * 3] = dx / dl; D[f * 3 + 1] = dy / dl; D[f * 3 + 2] = dz / dl;
        W[f * 3] = windMs[0] / fps; W[f * 3 + 1] = windMs[1] / fps; W[f * 3 + 2] = windMs[2] / fps;
    }
    const dataset = {n, fps, S, D, W};
    const R0 = Math.hypot(
        targetStart[0] - S[0], targetStart[1] - S[1], targetStart[2] - S[2]);
    const airVel = [targetVel[0] - windMs[0], targetVel[1] - windMs[1], targetVel[2] - windMs[2]];
    const airSpeed = Math.hypot(...airVel);
    const heading = (Math.atan2(airVel[0], airVel[1]) * 180 / Math.PI + 360) % 360;
    return {dataset, target, R0, airSpeed, heading, targetVel};
}

describe("TraverseAnalysis core", () => {

    test("trackMetrics recovers speeds, heading rate, and near-zero g for a CV target", () => {
        const {dataset, target, airSpeed} = makeDataset();
        const m = trackMetrics(dataset, target);
        expect(m.airSpeed.mean).toBeCloseTo(airSpeed, 0);
        expect(m.airSpeed.std).toBeLessThan(0.5);
        expect(m.gLoad.max).toBeLessThan(0.02);
        expect(m.turnRate.std).toBeLessThan(0.1);
        expect(meanAngularError(dataset, target)).toBeLessThan(1e-7);
    });

    test("traverseConstSpeed with true range and speed reproduces the target track", () => {
        const {dataset, target, R0, airSpeed} = makeDataset();
        const {track, badFrames} = traverseConstSpeed(dataset, R0, airSpeed, {airSpeed: true});
        expect(badFrames).toBe(0);
        let maxErr = 0;
        for (let f = 0; f < dataset.n; f++) {
            const e = Math.hypot(
                track[f * 3] - target[f * 3],
                track[f * 3 + 1] - target[f * 3 + 1],
                track[f * 3 + 2] - target[f * 3 + 2]);
            if (e > maxErr) maxErr = e;
        }
        expect(maxErr).toBeLessThan(25);   // meters, over 20 s at ~12-25 km range
    });

    test("traversePlausible stays on the rays and prefers the true range", () => {
        const {dataset, R0, airSpeed} = makeDataset();
        const run = (R) => {
            const {track} = traversePlausible(dataset, R, {vTarget: airSpeed, vSigma: 10});
            expect(meanAngularError(dataset, track)).toBeLessThan(1e-6);
            return straightFlightScore(trackMetrics(dataset, track));
        };
        const atTrue = run(R0);
        // wrong ranges require real maneuvering to stay on the LOS fan
        expect(atTrue).toBeLessThan(run(R0 * 1.5));
        expect(atTrue).toBeLessThan(run(R0 * 0.6));
    });

    test("simulateAircraft round-trips through patternSearchPolish", () => {
        const {dataset} = makeDataset();
        // truth: straight level-ish flight
        const truth = [15000, 65, 100, 0.15, 0, 1.5];
        const track = simulateAircraft(dataset, truth);
        // replace dataset rays with rays pointing at this aircraft
        const {n, S} = dataset;
        const D = dataset.D;
        for (let f = 0; f < n; f++) {
            let dx = track[f * 3] - S[f * 3];
            let dy = track[f * 3 + 1] - S[f * 3 + 1];
            let dz = track[f * 3 + 2] - S[f * 3 + 2];
            const dl = Math.hypot(dx, dy, dz);
            D[f * 3] = dx / dl; D[f * 3 + 1] = dy / dl; D[f * 3 + 2] = dz / dl;
        }
        const cost = (p) => {
            const t = simulateAircraft(dataset, p);
            return meanAngularError(dataset, t) * 180 / Math.PI;
        };
        const perturbed = [16500, 62, 92, 0.05, 0.01, 0];
        const {params, cost: c} = patternSearchPolish(cost, perturbed, [200, 0.5, 2, 0.02, 0.002, 0.5]);
        expect(c).toBeLessThan(0.01);
        expect(Math.abs(params[0] - truth[0]) / truth[0]).toBeLessThan(0.1);
        expect(Math.abs(params[2] - truth[2]) / truth[2]).toBeLessThan(0.1);
    });

    test("traverseConstAltitude sits at the given altitude and on the rays", () => {
        const {dataset} = makeDataset();
        const altZ = 4500;
        const {track, badFrames} = traverseConstAltitude(dataset, altZ);
        expect(badFrames).toBe(0);
        for (let f = 0; f < dataset.n; f++) {
            expect(track[f * 3 + 2]).toBeCloseTo(altZ, 3);   // exact altitude
        }
        expect(meanAngularError(dataset, track)).toBeLessThan(1e-6);   // on the rays (acos roundoff near 1)
    });

    test("fitConstAltitude recovers the altitude of a level target", () => {
        // level target: zero climb
        const {dataset, target} = makeDataset({targetVel: [90, 45, 0]});
        const trueAlt = target[2 + 3 * Math.floor(dataset.n / 2)];
        const fit = fitConstAltitude(dataset, {
            rangeMin: 3000, rangeMax: 40000, samples: 30,
        });
        expect(Math.abs(fit.altZ - trueAlt)).toBeLessThan(300);   // metres
        expect(meanAngularError(dataset, fit.track)).toBeLessThan(1e-6);
    });

    test("fitFixedPoint recovers a genuinely stationary target", () => {
        // stationary target: zero velocity
        const {dataset} = makeDataset({targetVel: [0, 0, 0]});
        const truth = [12000, 15000, 4500];
        const fit = fitFixedPoint(dataset, {});
        expect(fit.errDeg).toBeLessThan(0.05);
        expect(Math.hypot(fit.point[0] - truth[0], fit.point[1] - truth[1], fit.point[2] - truth[2]))
            .toBeLessThan(300);
    });

    test("fitFixedPoint fits a MOVING target poorly (high residual)", () => {
        const {dataset} = makeDataset();   // moving CV target
        const fit = fitFixedPoint(dataset, {});
        expect(fit.errDeg).toBeGreaterThan(0.2);   // no single point explains a moving object
    });

    test("fitFixedDirection: constant direction fits a distant object, not a near mover", () => {
        // a genuinely distant (near-fixed-direction) object
        const far = makeDataset({targetStart: [4e6, 3e6, 1e6], targetVel: [0, 0, 0]});
        const dirFar = fitFixedDirection(far.dataset);
        expect(dirFar.errDeg).toBeLessThan(0.2);
        // a near moving object sweeps too much for a fixed direction
        const near = makeDataset();
        const dirNear = fitFixedDirection(near.dataset);
        expect(dirNear.errDeg).toBeGreaterThan(dirFar.errDeg);
    });

    test("fitPlausibleBestRange finds the true range without being told it", () => {
        const {dataset, R0, airSpeed} = makeDataset();
        const fit = fitPlausibleBestRange(dataset, {
            vTarget: airSpeed,
            vSigma: 15,
            rangeMin: 0.5 * METERS_PER_NM,
            rangeMax: 20 * METERS_PER_NM,
        });
        // stays on the rays and recovers a range near the truth (within 25%)
        expect(meanAngularError(dataset, fit.track)).toBeLessThan(1e-4);
        expect(Math.abs(fit.startDist - R0) / R0).toBeLessThan(0.25);
        // the found range should beat a badly-wrong range on smoothness
        const wrong = traversePlausible(dataset, R0 * 2.2, {vTarget: airSpeed, vSigma: 15});
        expect(fit.score).toBeLessThan(straightFlightScore(trackMetrics(dataset, wrong.track)));
    }, 30000);

    test("fitAircraft recovers a plausible CV target from LOS data alone", async () => {
        const {dataset, R0, airSpeed, heading} = makeDataset();
        const fit = await fitAircraft(dataset, {
            tasTarget: airSpeed,
            tasSigma: 30,
            runs: 2,
            pop: 48,
            gens: 80,
            rangeMin: 2000,
            rangeMax: 40000,
        });
        expect(fit.errDeg).toBeLessThan(0.05);
        expect(Math.abs(fit.params.startDist - R0) / R0).toBeLessThan(0.25);
        expect(Math.abs(fit.params.tas - airSpeed) / airSpeed).toBeLessThan(0.25);
        let dh = ((fit.params.heading - heading) % 360 + 540) % 360 - 180;
        expect(Math.abs(dh)).toBeLessThan(15);
    }, 60000);
});
