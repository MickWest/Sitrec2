// Lens self-calibration, and - mostly - the gate that decides when NOT to trust it.
//
// Fitting a lens is the easy half. The half that matters is refusing to fit one when the clip
// does not constrain it, because a confident wrong lens is worse than no lens: it would bend the
// geometry of every downstream measurement while looking like an improvement.

import {calibrateLens, scanLens, radialExcitation, chooseBaseline, correspondences} from "../src/starTrack/StarCalibrate";
import {buildSphericalScene, clipLens} from "../src/starTrack/StarSyntheticSphere";
import {buildTrackletsSpherical, statesFromChain2D} from "../src/starTrack/StarSolveSphere";
import {solveFrameChain} from "../src/starTrack/StarMatch";
import {lensFOV} from "../src/CameraLens";

const SIZE = [1280, 720];

/** Tracks from a scene, via the normal bootstrap route. */
function tracksFor(scene) {
    const chain = solveFrameChain(scene.perFrame);
    const states = statesFromChain2D(chain.cumulative, clipLens(scene.size), scene.size);
    return buildTrackletsSpherical(scene.perFrame, states, clipLens(scene.size), scene.size);
}

describe("calibration recovers a known lens", () => {
    test("a wide fisheye clip with real rotation is calibrated close to truth", () => {
        const scene = buildSphericalScene({
            seed: 1001, frames: 40, starCount: 120, noise: 0.15,
            rotationDeg: 3.28, poleOffsetDeg: 49,
        });
        const tracks = tracksFor(scene);
        const r = calibrateLens(tracks, scene.frames, scene.size);
        expect(r.accepted).toBe(true);
        // Truth is orthographic f=914. The recovered focal should be within a few percent, and
        // the field of view - which is what actually matters downstream - much closer still.
        expect(r.lens.focalPx).toBeGreaterThan(830);
        expect(r.lens.focalPx).toBeLessThan(1010);
        const fov = lensFOV(r.lens, scene.size);
        const truth = lensFOV(scene.lens, scene.size);
        expect(Math.abs(fov.hfov - truth.hfov)).toBeLessThan(8);
    });

    test("the principal point lands near the image centre, as a real one does", () => {
        const scene = buildSphericalScene({
            seed: 1002, frames: 40, starCount: 120, noise: 0.15, rotationDeg: 3.5, poleOffsetDeg: 45,
        });
        const r = calibrateLens(tracksFor(scene), scene.frames, scene.size);
        expect(r.accepted).toBe(true);
        expect(Math.abs(r.lens.principal[0] - 640)).toBeLessThan(180);
        expect(Math.abs(r.lens.principal[1] - 360)).toBeLessThan(140);
    });

    test("a narrow rectilinear clip is not dressed up as a fisheye", () => {
        // A long lens: every model agrees, so the gate should either return rectilinear or
        // refuse. What it must NOT do is adopt a confident wide-angle lens.
        const scene = buildSphericalScene({
            seed: 1003, frames: 40, starCount: 100, noise: 0.15,
            rotationDeg: 1.2, poleOffsetDeg: 40,
            lens: {...clipLens(SIZE), type: "rectilinear", focalPx: 4200},
        });
        const r = calibrateLens(tracksFor(scene), scene.frames, scene.size);
        if (r.accepted) {
            const fov = lensFOV(r.lens, SIZE);
            expect(fov.hfov).toBeLessThan(40);
        } else {
            expect(r.reason).toBeTruthy();
        }
    });
});

describe("the gate refuses what it cannot see", () => {
    test("a PURE ROLL is refused, however large and however clean", () => {
        // The case that a naive gate passes: the sky turns a long way, the stars cover the whole
        // frame, the fit is beautiful - and it carries no lens information at all, because every
        // radial lens maps a roll to the same rotation about the principal point.
        const scene = buildSphericalScene({
            seed: 2001, frames: 40, starCount: 120, noise: 0.15,
            rotationDeg: 12, poleOffsetDeg: 0,          // axis ON the boresight
        });
        const r = calibrateLens(tracksFor(scene), scene.frames, scene.size);
        expect(r.accepted).toBe(false);
        expect(r.reason).toMatch(/roll/i);
    });

    test("a nearly still camera is refused", () => {
        const scene = buildSphericalScene({
            seed: 2002, frames: 30, starCount: 100, noise: 0.15, rotationDeg: 0.02,
        });
        const r = calibrateLens(tracksFor(scene), scene.frames, scene.size);
        expect(r.accepted).toBe(false);
        expect(r.reason).toMatch(/rotation/i);
    });

    test("too few correspondences is refused rather than fitted", () => {
        const scene = buildSphericalScene({seed: 2003, frames: 12, starCount: 8, noise: 0.15});
        const r = calibrateLens(tracksFor(scene), scene.frames, scene.size);
        expect(r.accepted).toBe(false);
        expect(r.reason).toMatch(/correspondence/i);
    });

    test("an empty track list is refused without throwing", () => {
        const r = calibrateLens([], 30, SIZE);
        expect(r.accepted).toBe(false);
    });
});

describe("radial excitation", () => {
    test("a roll produces coverage but no radial motion", () => {
        // Points on a circle about the centre, rotated about that centre: radii never change.
        const A = [], B = [];
        for (let i = 0; i < 40; i++) {
            const t = i * 0.157, r = 100 + (i % 5) * 60;
            A.push([640 + r * Math.cos(t), 360 + r * Math.sin(t)]);
            B.push([640 + r * Math.cos(t + 0.2), 360 + r * Math.sin(t + 0.2)]);
        }
        const ex = radialExcitation(A, B, [640, 360]);
        expect(ex.radialMotion).toBeLessThan(1e-9);
        expect(ex.spanMax - ex.spanMin).toBeGreaterThan(200);   // coverage is fine...
    });

    test("an off-axis rotation does move stars across radii", () => {
        const scene = buildSphericalScene({
            seed: 3001, frames: 20, starCount: 90, noise: 0.1, rotationDeg: 4, poleOffsetDeg: 50,
        });
        const tracks = tracksFor(scene);
        const base = chooseBaseline(tracks, scene.frames, 25);
        const ex = radialExcitation(base.A, base.B, [640, 360]);
        expect(ex.radialMotion).toBeGreaterThan(2);
    });
});

describe("baseline choice", () => {
    test("prefers the widest baseline that still shares enough tracks", () => {
        const scene = buildSphericalScene({seed: 4001, frames: 40, starCount: 100, noise: 0.15});
        const tracks = tracksFor(scene);
        const base = chooseBaseline(tracks, scene.frames, 25);
        expect(base.f1 - base.f0).toBeGreaterThan(20);
        expect(base.A.length).toBeGreaterThanOrEqual(25);
    });

    test("correspondences only pairs tracks seen in BOTH frames", () => {
        const tracks = [
            {obs: [{f: 0, x: 1, y: 1}, {f: 5, x: 2, y: 2}]},
            {obs: [{f: 0, x: 3, y: 3}]},
            {obs: [{f: 5, x: 4, y: 4}]},
        ];
        const c = correspondences(tracks, 0, 5);
        expect(c.A).toHaveLength(1);
        expect(c.index).toEqual([0]);
    });
});
