/**
 * LOSFittingObservability.test.js — the CV-family conditioning diagnostic
 * (assessLinearFitConditioning) ported to production from BOT Bench
 * (benchmarks/botbench/, the reference implementation).
 *
 * Pins the properties the live fit nodes and the analysis gallery rely on:
 *  1. a straight-and-level sensor (the documented trap — its own path is a
 *     zero-residual CV solution) reads POOR even though its bounding-box span
 *     is huge (the failure isRangeUnobservable cannot see);
 *  2. a long orbit reads good, and the two are separated by orders of
 *     magnitude of rcond;
 *  3. collapse statistics: an on-sensor track is flagged, a genuine track is
 *     not, non-finite frames are excluded rather than mis-scored;
 *  4. ONE-WAY semantics: the result never claims more than "poor is a
 *     warning" — conditioning "good" carries no collapse claim by itself;
 *  5. it accepts both dataset forms (LOSFitting and TraverseAnalysis).
 */

import {
    assessLinearFitConditioning,
    fitConstantVelocity,
    LINEAR_RCOND_POOR,
    LINEAR_RCOND_MARGINAL,
} from "../src/LOSFitting";

const FPS = 10;

// Sensor path + sightlines at a truth target, LOSFitting dataset form.
// noiseDeg adds deterministic angular jitter (hash-based, no PRNG state):
// with EXACTLY clean sightlines a degenerate system's tie-break is arbitrary
// (the true CV balloon is a zero-residual solution too); real sightlines
// always carry noise, and noise is what pulls the collapsed solution onto
// the sensor path (benchmark: 100% of noisy straight-sensor scenes).
function makeScene(n, sensorAt, truthAt, noiseDeg = 0) {
    const sensorPos = new Float64Array(n * 3);
    const losDir = new Float64Array(n * 3);
    const times = new Float64Array(n);
    const hash = (k) => {
        const x = Math.sin((k + 7) * 12.9898) * 43758.5453;
        return (x - Math.floor(x)) * 2 - 1;
    };
    const s = noiseDeg * Math.PI / 180;
    for (let i = 0; i < n; i++) {
        const t = i / FPS;
        times[i] = t;
        const [sx, sy, sz] = sensorAt(t);
        const [tx, ty, tz] = truthAt(t);
        sensorPos[i * 3] = sx; sensorPos[i * 3 + 1] = sy; sensorPos[i * 3 + 2] = sz;
        let dx = tx - sx, dy = ty - sy, dz = tz - sz;
        const L = Math.hypot(dx, dy, dz) || 1;
        dx /= L; dy /= L; dz /= L;
        if (s > 0) {
            dx += hash(i * 3) * s; dy += hash(i * 3 + 1) * s; dz += hash(i * 3 + 2) * s;
            const L2 = Math.hypot(dx, dy, dz) || 1;
            dx /= L2; dy /= L2; dz /= L2;
        }
        losDir[i * 3] = dx; losDir[i * 3 + 1] = dy; losDir[i * 3 + 2] = dz;
    }
    return {sensorPos, losDir, times, count: n, maxRange: null};
}

const balloon = (t) => [6 * t, 5000 + 2 * t, 500];   // slow drifter at 5 km

// 60 s orbit, 70 m/s at 5 km radius — the benchmark's recoverable geometry.
const orbitSensor = (t) => {
    const w = 70 / 5000;
    return [5000 * Math.sin(w * t), 5000 - 5000 * Math.cos(w * t), 3000];
};
// Straight & level, 70 m/s — the trap: huge span, zero range information.
const straightSensor = (t) => [70 * t, 0, 3000];

describe("assessLinearFitConditioning", () => {
    test("flags the straight-sensor trap that span-based checks miss", () => {
        const straight = makeScene(601, straightSensor, balloon);
        const orbit = makeScene(601, orbitSensor, balloon);
        const aS = assessLinearFitConditioning(straight);
        const aO = assessLinearFitConditioning(orbit);

        // The straight sensor spans 4.2 km — "observable" to any bounding-box
        // test — yet is fully degenerate for CV-family fits.
        expect(aS.conditioning).toBe("poor");
        expect(aS.rcond).toBeLessThan(LINEAR_RCOND_POOR);
        expect(aO.conditioning).toBe("good");
        expect(aO.rcond).toBeGreaterThan(LINEAR_RCOND_MARGINAL);
        expect(aO.rcond / aS.rcond).toBeGreaterThan(100);
    });

    test("the trap is real: CV on a noisy straight-sensor scene collapses; the diagnostic + collapse stats catch it", () => {
        // 0.03 deg noise, matching the benchmark's primary condition.
        const straight = makeScene(151, straightSensor, balloon, 0.03);
        const cv = fitConstantVelocity(straight, new Set());
        expect(cv).not.toBeNull();
        const a = assessLinearFitConditioning(straight, {positions: cv.positions});
        // The fitted "object" sits essentially on the camera path.
        expect(a.collapse).toBe(true);
        expect(a.conditioning).toBe("poor");

        // And the same fit on the (equally noisy) orbit does NOT collapse.
        const orbit = makeScene(601, orbitSensor, balloon, 0.03);
        const cvO = fitConstantVelocity(orbit, new Set());
        const aO = assessLinearFitConditioning(orbit, {positions: cvO.positions});
        expect(aO.collapse).toBe(false);
        expect(aO.medianSignedRangeM).toBeGreaterThan(1000);
    });

    test("collapse statistics: on-sensor, behind-sensor and non-finite frames", () => {
        const orbit = makeScene(101, orbitSensor, balloon);
        // Fabricate a track that IS the sensor path (exact collapse)...
        const onSensor = orbit.sensorPos.slice();
        const a = assessLinearFitConditioning(orbit, {positions: onSensor});
        expect(a.onSensorFraction).toBe(1);
        expect(a.collapse).toBe(true);
        // ...and one with NaN frames: excluded from stats, not scored.
        const withNaN = orbit.sensorPos.slice();
        for (let f = 0; f < 50; f++) withNaN[f * 3] = NaN;
        const b = assessLinearFitConditioning(orbit, {positions: withNaN});
        expect(b.finiteFraction).toBeCloseTo(51 / 101, 9);
        expect(b.onSensorFraction).toBe(1);   // of the FINITE frames
    });

    test("a well-conditioned genuinely-close target is NEVER condemned by distance alone", () => {
        // Object 6 m from the sensor path with STRONG geometry (tight orbit
        // around it): median range < 10 m yet conditioning is good — the
        // near-camera rule must not fire (it requires poor conditioning).
        const closeTruth = (t) => [0, 6, 3000];
        const tightOrbit = (t) => {
            const w = 2 * Math.PI / 20;   // 20 s lap, 5 m radius, ~1.6 m/s
            return [5 * Math.sin(w * t), 5 * Math.cos(w * t), 3000];
        };
        const scene = makeScene(301, tightOrbit, closeTruth, 0.03);
        const a = assessLinearFitConditioning(scene, {positions: (() => {
            const p = new Float64Array(301 * 3);
            for (let f = 0; f < 301; f++) { p[f * 3] = 0; p[f * 3 + 1] = 6; p[f * 3 + 2] = 3000; }
            return p;
        })()});
        expect(a.conditioning).not.toBe("poor");
        expect(a.medianSignedRangeM).toBeLessThan(10);
        expect(a.collapse).toBe(false);
        expect(a.collapseReason).toBeNull();
    });

    test("excluded frames are excluded from collapse statistics too", () => {
        const orbit = makeScene(101, orbitSensor, balloon, 0.03);
        // Positions: genuine for active frames, ON-SENSOR for frames 0..49 —
        // which are all excluded. The fractions must ignore them.
        const positions = new Float64Array(101 * 3);
        const excluded = new Set();
        for (let f = 0; f < 101; f++) {
            if (f < 50) {
                excluded.add(f);
                positions.set([orbit.sensorPos[f * 3], orbit.sensorPos[f * 3 + 1],
                    orbit.sensorPos[f * 3 + 2]], f * 3);
            } else {
                positions.set([0, 5000, 500], f * 3);
            }
        }
        const a = assessLinearFitConditioning(orbit, {excluded, positions});
        expect(a.onSensorFraction).toBe(0);
        expect(a.collapse).toBe(false);
        // and without the exclusions the same positions DO trip on-sensor stats
        const b = assessLinearFitConditioning(orbit, {positions});
        expect(b.onSensorFraction).toBeGreaterThan(0.4);
    });

    test("one-way semantics: good conditioning never asserts collapse or range truth", () => {
        const orbit = makeScene(601, orbitSensor, balloon);
        const a = assessLinearFitConditioning(orbit);
        expect(a.conditioning).toBe("good");
        // Without positions there is NO collapse claim at all — the diagnostic
        // must not synthesize one from conditioning alone.
        expect(a.collapse).toBeUndefined();
        expect(a.medianSignedRangeM).toBeUndefined();
    });

    test("accepts the TraverseAnalysis dataset form {n, fps, S, D}", () => {
        const scene = makeScene(301, orbitSensor, balloon);
        const traverseForm = {n: scene.count, fps: FPS, S: scene.sensorPos, D: scene.losDir, W: null};
        const a = assessLinearFitConditioning(traverseForm);
        const b = assessLinearFitConditioning(scene);
        expect(a.rcond).toBeCloseTo(b.rcond, 12);
        expect(a.conditioning).toBe(b.conditioning);
    });

    test("degenerate inputs stay sane: too few frames reports unknown-poor, never throws", () => {
        const tiny = makeScene(1, orbitSensor, balloon);
        const a = assessLinearFitConditioning(tiny);
        expect(a.rcond).toBeNull();
        expect(a.conditioning).toBe("poor");
    });
});
