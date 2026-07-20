/**
 * Tests for the pure-math traverse analysis core (src/TraverseAnalysis.js).
 *
 * Uses a synthetic scenario: a TURNING sensor (range along a LOS fan is only
 * observable when the sensor path curves — a constant-velocity sensor admits
 * zero-acceleration solutions at every scaled range) watching a
 * constant-velocity target through a constant wind.
 */

import {
    compareTrackToTruth,
    trackMetrics,
    meanAngularError,
    traverseConstSpeed,
    traverseConstAltitude,
    fitConstAltitude,
    fitFixedPoint,
    fitFixedDirection,
    traversePlausible,
    traverseMinSpeed,
    sweepConstAirSpeed,
    parabolicVertex,
    fitPlausibleBestRange,
    straightFlightScore,
    simulateAircraft,
    fitAircraft,
    KNOTS_TO_MS,
    METERS_PER_NM,
    rangeProfile,
    constAirSpeedTrack,
    sensorMotionStats,
    isRangeUnobservable,
    neutralTrackScore,
    slowRegimeWins,
    slowValleyContrast,
    pickConstAirRegime,
    SLOW_REGIME_MAX_SPEED_MS,
    SLOW_REGIME_MIN_CONTRAST,
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

    test("trackMetrics uses a physical-time differentiation window across frame rates", () => {
        const sample = (fps) => {
            const seconds = 10;
            const n = seconds * fps + 1;
            const S = new Float64Array(n * 3);
            const D = new Float64Array(n * 3);
            const W = new Float64Array(n * 3);
            const track = new Float64Array(n * 3);
            const radius = 1000, omega = 0.1;
            for (let f = 0; f < n; f++) {
                const t = f / fps;
                track[f * 3] = radius * Math.cos(omega * t);
                track[f * 3 + 1] = radius * Math.sin(omega * t);
                D[f * 3] = 1;
            }
            return trackMetrics({n, fps, S, D, W}, track);
        };
        const m15 = sample(15), m30 = sample(30), m60 = sample(60);
        for (const m of [m15, m30, m60]) {
            expect(m.airSpeed.mean).toBeCloseTo(100, 0);
            expect(m.gLoad.mean).toBeCloseTo(1000 * 0.1 * 0.1 / 9.81, 1);
        }
        expect(Math.abs(m15.gLoad.mean - m60.gLoad.mean)).toBeLessThan(0.02);
        expect(Math.abs(m30.turnRate.mean - m60.turnRate.mean)).toBeLessThan(0.05);
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

    test("simulateAircraft round-trips through patternSearchPolish", async () => {
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
        const {params, cost: c} = await patternSearchPolish(
            cost, perturbed, [200, 0.5, 2, 0.02, 0.002, 0.5]);
        expect(c).toBeLessThan(0.01);
        expect(Math.abs(params[0] - truth[0]) / truth[0]).toBeLessThan(0.1);
        expect(Math.abs(params[2] - truth[2]) / truth[2]).toBeLessThan(0.1);
    });

    test("simulateAircraft does not double-count curvature already carried by full-vector wind", () => {
        const n = 120, fps = 30, R = 6371000;
        const S = new Float64Array(n * 3);
        const D = new Float64Array(n * 3);
        const W = new Float64Array(n * 3);
        D[0] = 1;
        let x = 50000;
        const dx = 20 / fps;
        for (let f = 0; f < n; f++) {
            D[f * 3] = 1;
            if (f < n - 1) {
                const xNext = x + dx;
                W[f * 3] = dx;
                // A locally horizontal ECEF wind, expressed in the fixed
                // analysis ENU basis, already carries this vertical component.
                W[f * 3 + 2] = -(xNext * xNext - x * x) / (2 * R);
                x = xNext;
            }
        }
        const dataset = {n, fps, S, D, W};
        const track = simulateAircraft(dataset, [50000, 0, 0, 0, 0, 0]);
        const h0 = track[2] + track[0] * track[0] / (2 * R);
        for (let f = 1; f < n; f++) {
            const xx = track[f * 3], yy = track[f * 3 + 1], zz = track[f * 3 + 2];
            expect(zz + (xx * xx + yy * yy) / (2 * R)).toBeCloseTo(h0, 8);
        }
    });

    test("traverseConstAltitude sits at the given GEODETIC altitude and on the rays", () => {
        const {dataset} = makeDataset();
        const altZ = 4500;
        const {track, badFrames} = traverseConstAltitude(dataset, altZ);
        expect(badFrames).toBe(0);
        for (let f = 0; f < dataset.n; f++) {
            // constant-altitude now means the CURVED constant-geodetic shell:
            // geodetic altitude = ENU z + rho^2/(2R), not raw ENU z
            const x = track[f * 3], y = track[f * 3 + 1];
            const geodetic = track[f * 3 + 2] + (x * x + y * y) / (2 * 6371000);
            expect(geodetic).toBeCloseTo(altZ, 3);
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
        expect(fit.boundaryLimited).toBe(false);
    });

    test("fitConstAltitude reports an unresolved search-edge altitude", () => {
        const {dataset} = makeDataset({targetStart: [12000, 15000, 9000], targetVel: [90, 45, 0]});
        // This deliberately restricts the altitude/range band far below truth.
        const fit = fitConstAltitude(dataset, {rangeMin: 500, rangeMax: 1500, samples: 16});
        expect(fit.boundaryLimited).toBe(true);
        expect(["lo", "hi"]).toContain(fit.boundarySide);
    });

    test("rangeProfile marks a supported family that reaches an edge", async () => {
        const {dataset} = makeDataset({n: 180});
        const profile = await rangeProfile(dataset, {
            ranges: [1000, 2000, 3000],
            vTarget: null,
            keepTracks: false,
            K: 9,
            iters: 2,
        });
        expect(profile.boundaryLimited).toBe(true);
        expect(profile.familyLoIndex === 0 || profile.familyHiIndex === profile.length - 1).toBe(true);
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

    test("parabolicVertex is the exact three-point parabola vertex", () => {
        // Symmetric bracket with the minimum exactly at xb: vertex must be xb.
        // (The pre-fix formula proposed 2.5 here — outside the bracket.)
        expect(parabolicVertex(0, 1, 1, 0, 2, 1)).toBeCloseTo(1, 12);
        // Exact quadratic f(x) = (x - 1.1)^2 sampled at 0, 1, 2 — and at an
        // asymmetric bracket — must recover the true vertex exactly.
        const f = (x) => (x - 1.1) ** 2;
        expect(parabolicVertex(0, f(0), 1, f(1), 2, f(2))).toBeCloseTo(1.1, 12);
        expect(parabolicVertex(0.5, f(0.5), 1, f(1), 2, f(2))).toBeCloseTo(1.1, 12);
        // Collinear points define no parabola.
        expect(parabolicVertex(0, 0, 1, 1, 2, 2)).toBeNull();
    });

    test("trackMetrics: short supported A-B windows report real metrics, not zeros", () => {
        // 12 frames at 30 fps — the analyzer accepts >= 10-frame windows, but
        // the unclamped 0.5 s smoothing window used to trim the stats range
        // empty and silently return all-zero speed/g/turn stats, letting a
        // violent trajectory "pass the broad screen" at 0 kt / 0.00 g.
        const build = (mover) => {
            const n = 12, fps = 30;
            const S = new Float64Array(n * 3);
            const D = new Float64Array(n * 3);
            const W = new Float64Array(n * 3);
            const track = new Float64Array(n * 3);
            for (let f = 0; f < n; f++) {
                D[f * 3] = 1;
                const [x, y] = mover(f);
                track[f * 3] = x; track[f * 3 + 1] = y;
            }
            return trackMetrics({n, fps, S, D, W}, track);
        };
        // ~300 m/frame (9000 m/s) through a hard 90° turn at frame 6
        const violent = build(f => f < 6 ? [f * 300, 0] : [1500, (f - 5) * 300]);
        expect(violent.airSpeed.max).toBeGreaterThan(5000);   // m/s — not 0
        expect(violent.gLoad.max).toBeGreaterThan(50);        // not 0.00 g
        // A genuine constant-velocity mover still reads its true speed.
        const gentle = build(f => [f * (100 / 30), 0]);       // 100 m/s
        expect(gentle.airSpeed.mean).toBeCloseTo(100, 0);
        expect(gentle.gLoad.max).toBeLessThan(0.5);
    });

    test("trackMetrics: a window too short for ANY stats reads invalid, never zero", () => {
        const n = 6, fps = 30;
        const track = new Float64Array(n * 3);
        for (let f = 0; f < n; f++) track[f * 3] = f * 300;
        const m = trackMetrics({n, fps, S: new Float64Array(n * 3),
            D: new Float64Array(n * 3), W: new Float64Array(n * 3)}, track);
        // Non-finite is what the ranking's invalid-metrics guard keys on.
        expect(Number.isNaN(m.airSpeed.max)).toBe(true);
        expect(Number.isNaN(m.gLoad.max)).toBe(true);
    });

    test("traverseMinSpeed recovers a slow drifter under an orbiting sensor", () => {
        // Near-static target (2.24 m/s ≈ 4.3 kt) close to a turning sensor:
        // most apparent motion is the sensor's own parallax, so the slowest
        // consistent object is a near-static drifter at the true range.
        const {dataset, R0} = makeDataset({
            n: 300,
            windMs: [0, 0, 0],
            targetStart: [6000, 8000, 1500],
            targetVel: [2, 1, 0],
        });
        const {track, lam} = traverseMinSpeed(dataset, {});
        // Stays close to the rays (smoothing sheds pointing jitter, so allow
        // a few hundredths of a degree).
        expect(meanAngularError(dataset, track) * 180 / Math.PI).toBeLessThan(0.15);
        // The solved object is SLOW — the drifting-lantern reading, nowhere
        // near a fast-mover interpretation.
        const m = trackMetrics(dataset, track);
        expect(m.airSpeed.mean).toBeLessThan(6);      // m/s (truth 2.24)
        // The turning sensor pins the range: median slant range near truth.
        const med = Array.from(lam).sort((a, b) => a - b)[Math.floor(lam.length / 2)];
        expect(Math.abs(med - R0) / R0).toBeLessThan(0.5);
    }, 30000);

    test("sweepConstAirSpeed expands past a touched grid edge and dedupes ranges", async () => {
        // True range ~19.3 km; the initial grid tops out at 6 km, so the
        // supported family touches the high edge and must expand geometrically
        // (the original GoFast defect silently reported the edge cell).
        const {dataset, R0, airSpeed} = makeDataset({n: 240});
        const sweep = await sweepConstAirSpeed(dataset, {
            ranges: [2000, 3000, 4500, 6000],
            speeds: [airSpeed * 0.75, airSpeed, airSpeed * 1.25],
            speedTarget: airSpeed,
            expand: true,
        });
        // Expansion happened, and the returned grid is sorted and deduplicated
        // (duplicate rows would corrupt the range-major heatmap indexing).
        expect(Math.max(...sweep.ranges)).toBeGreaterThan(6000);
        for (let i = 1; i < sweep.ranges.length; i++) {
            expect(sweep.ranges[i]).toBeGreaterThan(sweep.ranges[i - 1]);
        }
        expect(sweep.results.length).toBe(sweep.ranges.length * sweep.speeds.length);
        // The winner is found in the expanded region, near the true range.
        expect(sweep.best.startDist).toBeGreaterThan(6000);
        expect(Math.abs(sweep.best.startDist - R0) / R0).toBeLessThan(0.6);
    }, 60000);

    test("sweepConstAirSpeed reports an unexpanded user-capped edge as boundary-limited", async () => {
        const {dataset, airSpeed} = makeDataset({n: 240});
        const sweep = await sweepConstAirSpeed(dataset, {
            ranges: [2000, 3000, 4500, 6000],   // all far below the ~19.3 km truth
            speeds: [airSpeed * 0.75, airSpeed, airSpeed * 1.25],
            speedTarget: airSpeed,
            expand: false,
        });
        expect(sweep.boundaryLimited).toBe(true);
        expect(sweep.boundaryAxes.range).toBe(true);
    }, 60000);

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

    test("fitAircraft discloses its soft priors in the {total, terms} schema (TA-08)", async () => {
        const {dataset, airSpeed} = makeDataset();
        // Push the cruise-speed target well below the true speed so the fit must
        // trade residual against the speed prior — that term must then be
        // disclosed rather than shaping the solution invisibly.
        const fit = await fitAircraft(dataset, {
            tasTarget: airSpeed * 0.5, tasSigma: 20, runs: 2, pop: 48, gens: 80,
            rangeMin: 2000, rangeMax: 40000,
        });
        const priors = fit.params.priors;
        expect(priors).not.toBeNull();
        expect(priors.total).toBeGreaterThan(0);
        // The itemised terms sum to the reported total, and every term is a
        // positive, finite number of degrees.
        const sum = Object.values(priors.terms).reduce((a, b) => a + b, 0);
        expect(sum).toBeCloseTo(priors.total, 6);
        for (const v of Object.values(priors.terms)) {
            expect(Number.isFinite(v)).toBe(true);
            expect(v).toBeGreaterThan(0);
        }
        // The offset cruise-speed target guarantees that term is present.
        expect(Object.keys(priors.terms)).toEqual(
            expect.arrayContaining(["cruise-speed target"]));
    }, 60000);

    test("fitAircraft fails closed when every candidate has a non-finite residual", async () => {
        const {dataset, airSpeed} = makeDataset({n: 24});
        const poisoned = {...dataset, D: Float64Array.from(dataset.D)};
        poisoned.D[0] = NaN;
        await expect(fitAircraft(poisoned, {
            tasTarget: airSpeed, runs: 1, pop: 6, gens: 2,
            rangeMin: 2000, rangeMax: 40000,
        })).rejects.toThrow("no finite solution");
    });

    test("fitAircraft observes cancellation inside differential evolution", async () => {
        const {dataset, airSpeed} = makeDataset({n: 24});
        let checks = 0;
        await expect(fitAircraft(dataset, {
            tasTarget: airSpeed, runs: 1, pop: 20, gens: 20,
            rangeMin: 2000, rangeMax: 40000,
            shouldCancel: () => ++checks >= 7,
        })).rejects.toThrow("cancelled");
        expect(checks).toBeLessThan(20);
    });
});

describe("compareTrackToTruth", () => {
    const N = 300, FPS = 30;

    // straight-line track builder: pos(f) = start + vel * f/fps (ENU meters)
    function line(start, vel, n = N, fps = FPS) {
        const arr = new Float64Array(n * 3);
        for (let f = 0; f < n; f++) {
            arr[f * 3] = start[0] + vel[0] * f / fps;
            arr[f * 3 + 1] = start[1] + vel[1] * f / fps;
            arr[f * 3 + 2] = start[2] + vel[2] * f / fps;
        }
        return arr;
    }

    function makeCompareDataset(n = N, fps = FPS) {
        // stationary sensor at the origin — compareTrackToTruth only uses {n, fps, S}
        return {n, fps, S: new Float64Array(n * 3)};
    }

    test("identical tracks score 0 with concurring aspects", () => {
        const ds = makeCompareDataset();
        const truthArr = line([5000, 8000, 1000], [50, 20, 1]);
        const tc = compareTrackToTruth(ds, truthArr, {track: truthArr});
        expect(tc.comparable).toBe(true);
        expect(tc.score).toBeCloseTo(0, 9);
        expect(tc.sep3D.max).toBeCloseTo(0, 9);
        expect(tc.horizontal.mean).toBeCloseTo(0, 9);
        expect(tc.altitude.meanAbs).toBeCloseTo(0, 9);
        expect(tc.speed.meanAbsDiff).toBeCloseTo(0, 9);
        expect(tc.heading.meanAbsDiff).toBeCloseTo(0, 9);
        expect(tc.framesUsed).toBe(N);
    });

    test("constant altitude offset isolates to the altitude aspect", () => {
        const ds = makeCompareDataset();
        const truthArr = line([5000, 8000, 1000], [50, 20, 0]);
        const hypArr = line([5000, 8000, 1250], [50, 20, 0]);   // 250 m high
        const tc = compareTrackToTruth(ds, hypArr, {track: truthArr});
        expect(tc.score).toBeCloseTo(250, 6);
        expect(tc.horizontal.mean).toBeCloseTo(0, 6);
        expect(tc.altitude.meanAbs).toBeCloseTo(250, 6);
        expect(tc.altitude.meanSigned).toBeCloseTo(250, 6);   // above truth
        expect(tc.speed.meanAbsDiff).toBeCloseTo(0, 6);
        expect(tc.heading.meanAbsDiff).toBeCloseTo(0, 6);
    });

    test("different velocity shows in speed and heading, not just position", () => {
        const ds = makeCompareDataset();
        const truthArr = line([5000, 8000, 1000], [50, 0, 0]);   // due east 50 m/s
        const hypArr = line([5000, 8000, 1000], [0, 50, 0]);     // due north 50 m/s
        const tc = compareTrackToTruth(ds, hypArr, {track: truthArr});
        expect(tc.speed.meanAbsDiff).toBeCloseTo(0, 6);          // same speed...
        expect(tc.heading.meanAbsDiff).toBeCloseTo(90, 4);       // ...90° apart
        expect(tc.score).toBeGreaterThan(0);
    });

    test("validity mask restricts scoring to the truth's time window", () => {
        const ds = makeCompareDataset();
        const truthArr = line([5000, 8000, 1000], [50, 20, 0]);
        const hypArr = line([5000, 8000, 1100], [50, 20, 0]);    // 100 m high
        const valid = new Uint8Array(N);
        for (let f = 50; f < 200; f++) valid[f] = 1;
        const tc = compareTrackToTruth(ds, hypArr, {track: truthArr, valid});
        expect(tc.comparable).toBe(true);
        expect(tc.framesUsed).toBe(150);
        expect(tc.score).toBeCloseTo(100, 6);
    });

    test("fewer than 5 usable frames is not comparable", () => {
        const ds = makeCompareDataset();
        const truthArr = line([5000, 8000, 1000], [50, 20, 0]);
        const valid = new Uint8Array(N);   // all zero
        valid[0] = valid[1] = valid[2] = 1;
        const tc = compareTrackToTruth(ds, truthArr, {track: truthArr, valid});
        expect(tc.comparable).toBe(false);
        expect(tc.framesUsed).toBe(3);
    });

    test("hovering truth yields no heading comparison", () => {
        const ds = makeCompareDataset();
        const truthArr = line([5000, 8000, 1000], [0, 0, 0]);    // stationary
        const hypArr = line([5010, 8000, 1000], [30, 0, 0]);
        const tc = compareTrackToTruth(ds, hypArr, {track: truthArr});
        expect(tc.comparable).toBe(true);
        expect(tc.heading).toBe(null);
        expect(tc.speed.meanAbsDiff).toBeCloseTo(30, 4);
    });
});

describe("sensor motion observability (sensorMotionStats / isRangeUnobservable)", () => {
    test("static sensor: zero span, range unobservable at any working distance", () => {
        const n = 200, fps = 30;
        const S = new Float64Array(n * 3);       // all zeros — tripod sensor
        const D = new Float64Array(n * 3);
        for (let f = 0; f < n; f++) {
            const az = 0.2 * (f / n);            // slow LOS sweep, origin fixed
            D[f * 3] = Math.sin(az); D[f * 3 + 1] = Math.cos(az); D[f * 3 + 2] = 0;
        }
        const stats = sensorMotionStats({n, fps, S, D, W: new Float64Array(n * 3)});
        expect(stats.pathLen).toBe(0);
        expect(stats.span).toBe(0);
        expect(isRangeUnobservable(stats, 20 * METERS_PER_NM)).toBe(true);
        expect(isRangeUnobservable(stats, 500)).toBe(true);
    });

    test("orbiting sensor: kilometers of baseline, range observable", () => {
        const {dataset} = makeDataset({n: 300});
        const stats = sensorMotionStats(dataset);
        expect(stats.span).toBeGreaterThan(500);
        expect(stats.pathLen).toBeGreaterThanOrEqual(stats.span * 0.9);
        expect(isRangeUnobservable(stats, 20 * METERS_PER_NM)).toBe(false);
    });

    test("GPS jitter inflates pathLen but not span — span drives the verdict", () => {
        const n = 300, fps = 30;
        const S = new Float64Array(n * 3);
        // deterministic +-1.5 m zig-zag: huge accumulated path, tiny bounding box
        for (let f = 0; f < n; f++) S[f * 3] = (f % 2) ? 1.5 : -1.5;
        const D = new Float64Array(n * 3);
        for (let f = 0; f < n; f++) { D[f * 3 + 1] = 1; }
        const stats = sensorMotionStats({n, fps, S, D, W: new Float64Array(n * 3)});
        expect(stats.pathLen).toBeGreaterThan(500);
        expect(stats.span).toBeLessThan(4);
        expect(isRangeUnobservable(stats, 20 * METERS_PER_NM)).toBe(true);
    });

    test("small absolute baselines still observe range at close working distances", () => {
        const n = 100, fps = 30;
        const S = new Float64Array(n * 3);
        for (let f = 0; f < n; f++) S[f * 3] = 10 * (f / (n - 1));   // 10 m of travel
        const stats = sensorMotionStats({n, fps, S, D: new Float64Array(n * 3), W: new Float64Array(n * 3)});
        expect(isRangeUnobservable(stats, 200)).toBe(false);        // drone at 200 m
        expect(isRangeUnobservable(stats, 100 * METERS_PER_NM)).toBe(true); // jet at 100 NM
    });

    test("the cutoff constants are pinned: 1e-3 of the working distance, 2 m floor", () => {
        // Bracket the ratio at a 20 NM anchor (threshold 37.04 m): a mutation of
        // the 1e-3 constant in either direction flips one of these.
        const anchor20NM = 20 * METERS_PER_NM;
        expect(isRangeUnobservable({span: 30}, anchor20NM)).toBe(true);
        expect(isRangeUnobservable({span: 45}, anchor20NM)).toBe(false);
        // Bracket the 2 m floor (anchor small enough that the ratio term is <2).
        expect(isRangeUnobservable({span: 1.5}, 1000)).toBe(true);
        expect(isRangeUnobservable({span: 3}, 1000)).toBe(false);
    });
});

describe("constant-air-speed regime pick (pickConstAirRegime)", () => {
    // The REAL pipeline the analysis runs: fast sweep + slow range profile with
    // the production slow options, then the exact production pick function —
    // not hand-picked candidates, which can pass regardless of the mechanism.
    async function runPick(dataset, ranges, speedTarget = 380 * KNOTS_TO_MS) {
        const sweep = await sweepConstAirSpeed(dataset, {ranges, speedTarget});
        const slowProfile = await rangeProfile(dataset, {
            ranges: sweep.ranges,
            vTarget: 5 * KNOTS_TO_MS, vSigma: 20 * KNOTS_TO_MS, scoreSpeedWeight: 0.2,
        });
        return pickConstAirRegime(dataset, sweep, slowProfile);
    }

    test("balloon-like scene: decisive slow valley demotes the fast representative", async () => {
        // Slow drifter at ~8.7 km from an ORBITING sensor (the generated-balloon
        // scenario in miniature): real parallax pins the range, so the slow
        // profile has a sharp valley near truth and the pick must flip.
        const slow = makeDataset({n: 240, windMs: [0, 0, 0],
            targetStart: [5000, 7000, 1200], targetVel: [3, 2, 1]});
        const R0 = slow.R0;
        const ranges = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4].map((k) => k * R0);
        const pick = await runPick(slow.dataset, ranges);
        expect(pick.useSlow).toBe(true);
        expect(pick.slow.speed).toBeLessThanOrEqual(SLOW_REGIME_MAX_SPEED_MS);
        expect(pick.slow.contrast).toBeGreaterThanOrEqual(SLOW_REGIME_MIN_CONTRAST);
        // the promoted range is the truth range, not a near-field artifact
        expect(pick.slow.row.startDist).toBeGreaterThan(R0 * 0.5);
        expect(pick.slow.row.startDist).toBeLessThan(R0 * 1.6);
    }, 120000);

    test("degenerate narrow-baseline CV scene: flat slow valley blocks the flip", async () => {
        // Straight-and-level sensor watching a CV jet — bearings-only CV-on-CV:
        // a slow rider exists at EVERY range, so the slow profile is flat and its
        // argmin is an arbitrary member of a tied family. The honest headline is
        // the fast sweep's family-ambiguity answer; the flip must NOT fire even
        // though the slow row's neutral score beats the fast representative's.
        const n = 240, fps = 30;
        const S = new Float64Array(n * 3), D = new Float64Array(n * 3);
        const W = new Float64Array(n * 3);
        for (let f = 0; f < n; f++) {
            const t = f / fps;
            S[f * 3] = 110 * t; S[f * 3 + 1] = 0; S[f * 3 + 2] = 8000;
            const tx = 30000 + 100 * t, ty = 35000 + 110 * t, tz = 6000 + 5 * t;
            const dx = tx - S[f * 3], dy = ty - S[f * 3 + 1], dz = tz - S[f * 3 + 2];
            const dl = Math.hypot(dx, dy, dz);
            D[f * 3] = dx / dl; D[f * 3 + 1] = dy / dl; D[f * 3 + 2] = dz / dl;
        }
        const dataset = {n, fps, S, D, W};
        const R0 = Math.hypot(30000, 35000, 6000 - 8000);
        const ranges = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3].map((k) => k * R0);
        const pick = await runPick(dataset, ranges);
        expect(pick.useSlow).toBe(false);
    }, 120000);

    test("a fast argmin row can never masquerade as a slow-drift answer", () => {
        // Flat-family scenes can park the slow profile's argmin on a FAST row
        // despite the 5-kt prior; the speed bound must reject it outright,
        // whatever the scores say.
        const dataset = makeDataset({n: 180}).dataset;
        const fastRow = {startDist: 20000, score: 0.01,
            metrics: {airSpeed: {mean: 190}}};                  // ~370 kt
        const flatValley = Array.from({length: 10}, (_, i) => ({
            startDist: 5000 + i * 5000, score: 0.01 + 0.001 * i,
            metrics: {airSpeed: {mean: 190}},
        }));
        flatValley[3] = fastRow;
        const sweep = {best: {startDist: 15000, speed: 190}};
        const pick = pickConstAirRegime(dataset, sweep, flatValley);
        expect(pick.useSlow).toBe(false);
        expect(pick.slow).toBe(null);   // rejected before scoring, not outscored
    }, 60000);

    test("slowRegimeWins demands a decisive margin and finite scores", () => {
        expect(slowRegimeWins(10, 9.5)).toBe(false);   // within margin — keep fast
        expect(slowRegimeWins(10, 7.9)).toBe(true);    // decisive win
        expect(slowRegimeWins(10, NaN)).toBe(false);
        expect(slowRegimeWins(NaN, 5)).toBe(true);     // fast invalid, slow valid
        expect(slowRegimeWins(NaN, NaN)).toBe(false);
    });

    test("slowValleyContrast separates sharp valleys from flat families", () => {
        const row = (score) => ({score});
        // sharp valley: wrong ranges score an order of magnitude worse
        expect(slowValleyContrast([100, 40, 8, 45, 90].map(row))).toBeGreaterThanOrEqual(2.5);
        // flat family: every range rides about equally well
        expect(slowValleyContrast([10, 9.5, 9, 9.2, 10, 9.8].map(row))).toBeLessThan(1.5);
        // degenerate inputs read as flat (contrast 1), never as decisive
        expect(slowValleyContrast(null)).toBe(1);
        expect(slowValleyContrast([row(5), row(6)])).toBe(1);
    });
});
