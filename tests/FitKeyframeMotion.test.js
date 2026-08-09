// Tests for the fit-keyframe camera interpolation (src/FitKeyframeMotion.js) — the pure maths
// behind "Fit Keyframe Motion". The module is deliberately plain-array/no-three so it can be
// tested here without the renderer.

import {interpolateFitCamera, lerpAngleDeg} from "../src/FitKeyframeMotion";

const kf = (frame, position, azDeg = 0, elDeg = 0, rollDeg = 0, vfovDeg = 30) => ({
    frame,
    solved: {position, azDeg, elDeg, rollDeg, vfovDeg},
});

describe("lerpAngleDeg", () => {
    test("plain interpolation away from the wrap", () => {
        expect(lerpAngleDeg(10, 30, 0.5)).toBeCloseTo(20, 10);
        expect(lerpAngleDeg(-40, -20, 0.25)).toBeCloseTo(-35, 10);
    });

    test("takes the short way across +/-180", () => {
        // 170 -> -170 is 20 degrees apart through 180, not 340 back through zero.
        expect(lerpAngleDeg(170, -170, 0.5)).toBeCloseTo(180, 10);
        expect(lerpAngleDeg(-170, 170, 0.5)).toBeCloseTo(-180, 10);
        // Quarter of the way: 170 + 5.
        expect(lerpAngleDeg(170, -170, 0.25)).toBeCloseTo(175, 10);
    });

    test("endpoints are exact", () => {
        expect(lerpAngleDeg(170, -170, 0)).toBeCloseTo(170, 10);
        // t=1 may land on a co-terminal angle (190 == -170 on the circle).
        const end = lerpAngleDeg(170, -170, 1);
        expect(((end - -170) % 360 + 360) % 360).toBeCloseTo(0, 10);
    });
});

describe("interpolateFitCamera", () => {
    test("no usable keyframes -> null", () => {
        expect(interpolateFitCamera([], 10)).toBeNull();
        expect(interpolateFitCamera(null, 10)).toBeNull();
        expect(interpolateFitCamera([{frame: 5, solved: null}], 10)).toBeNull();
    });

    test("provisional (unfitted) solutions never drive the motion", () => {
        const seeded = kf(60, [999, 999, 999], 45);
        seeded.solved.fitted = false;
        // Alone, a seeded guess produces no camera at all.
        expect(interpolateFitCamera([seeded], 30)).toBeNull();
        // Next to a fitted keyframe, the fitted solution HOLDS — the camera never flies
        // toward the guess.
        const fitted = kf(0, [0, 0, 0], 10);
        fitted.solved.fitted = true;
        const mid = interpolateFitCamera([fitted, seeded], 30);
        expect(mid.position).toEqual([0, 0, 0]);
        expect(mid.azDeg).toBe(10);
        // Upgrading it to fitted brings it into the motion.
        seeded.solved.fitted = true;
        expect(interpolateFitCamera([fitted, seeded], 30).position[0]).toBeCloseTo(499.5, 8);
    });

    test("a single keyframe holds everywhere", () => {
        const frames = [kf(50, [1, 2, 3], 10, 20, 5, 40)];
        for (const f of [0, 50, 99]) {
            const s = interpolateFitCamera(frames, f);
            expect(s.position).toEqual([1, 2, 3]);
            expect(s.azDeg).toBe(10);
            expect(s.vfovDeg).toBe(40);
        }
    });

    test("holds the end solutions before the first and after the last keyframe", () => {
        const frames = [kf(10, [0, 0, 0], 0), kf(20, [100, 0, 0], 90)];
        expect(interpolateFitCamera(frames, 0).position).toEqual([0, 0, 0]);
        expect(interpolateFitCamera(frames, 500).position).toEqual([100, 0, 0]);
        expect(interpolateFitCamera(frames, 500).azDeg).toBe(90);
    });

    test("linear, constant-speed position between two keyframes", () => {
        const frames = [kf(100, [0, 0, 0]), kf(200, [1000, -500, 250])];
        for (const t of [0.1, 0.25, 0.5, 0.9]) {
            const s = interpolateFitCamera(frames, 100 + 100 * t);
            expect(s.position[0]).toBeCloseTo(1000 * t, 8);
            expect(s.position[1]).toBeCloseTo(-500 * t, 8);
            expect(s.position[2]).toBeCloseTo(250 * t, 8);
        }
        // Constant speed: equal frame steps move equal distances.
        const d = (a, b) => Math.hypot(
            b.position[0] - a.position[0],
            b.position[1] - a.position[1],
            b.position[2] - a.position[2]);
        const s0 = interpolateFitCamera(frames, 110);
        const s1 = interpolateFitCamera(frames, 120);
        const s2 = interpolateFitCamera(frames, 130);
        expect(d(s0, s1)).toBeCloseTo(d(s1, s2), 8);
    });

    test("exact at the keyframes themselves", () => {
        const frames = [kf(10, [0, 0, 0], 5, 1, 0, 20), kf(20, [100, 0, 0], 15, 3, 2, 40)];
        const at10 = interpolateFitCamera(frames, 10);
        expect(at10.position).toEqual([0, 0, 0]);
        expect(at10.azDeg).toBe(5);
        const at20 = interpolateFitCamera(frames, 20);
        expect(at20.position).toEqual([100, 0, 0]);
        expect(at20.vfovDeg).toBe(40);
    });

    test("angles and FOV interpolate; az and roll take the short way round", () => {
        const frames = [
            kf(0, [0, 0, 0], 170, 10, 179, 20),
            kf(10, [0, 0, 0], -170, 20, -179, 40),
        ];
        const mid = interpolateFitCamera(frames, 5);
        expect(mid.azDeg).toBeCloseTo(180, 8);          // not 0
        expect(Math.abs(mid.rollDeg)).toBeCloseTo(180, 8);  // not 0
        expect(mid.elDeg).toBeCloseTo(15, 8);
        expect(mid.vfovDeg).toBeCloseTo(30, 8);
    });

    test("three keyframes: each span interpolates against its own bracket", () => {
        const frames = [kf(0, [0, 0, 0]), kf(10, [100, 0, 0]), kf(30, [100, 200, 0])];
        expect(interpolateFitCamera(frames, 5).position[0]).toBeCloseTo(50, 8);
        const late = interpolateFitCamera(frames, 20);
        expect(late.position[0]).toBeCloseTo(100, 8);
        expect(late.position[1]).toBeCloseTo(100, 8);
    });

    test("unsorted input and null-solved entries are handled", () => {
        const frames = [
            {frame: 20, solved: null},                   // ignored
            kf(30, [300, 0, 0]),
            kf(10, [100, 0, 0]),
        ];
        const s = interpolateFitCamera(frames, 20);
        expect(s.position[0]).toBeCloseTo(200, 8);       // interpolates 10 -> 30 across the gap
    });

    test("returns fresh objects — mutating a result cannot corrupt the keyframes", () => {
        const frames = [kf(0, [1, 2, 3]), kf(10, [4, 5, 6])];
        const s = interpolateFitCamera(frames, 0);
        s.position[0] = 999;
        expect(interpolateFitCamera(frames, 0).position[0]).toBe(1);
    });
});
