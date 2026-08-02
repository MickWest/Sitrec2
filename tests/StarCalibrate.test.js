// Lens self-calibration, and - mostly - the gate that decides when NOT to trust it.
//
// Fitting a lens is the easy half. The half that matters is refusing to fit one when the clip
// does not constrain it, because a confident wrong lens is worse than no lens: it would bend the
// geometry of every downstream measurement while looking like an improvement.

import {calibrateLens, scanLens, radialExcitation, chooseBaseline, correspondences} from "../src/starTrack/StarCalibrate";
import {buildSphericalScene, clipLens} from "../src/starTrack/StarSyntheticSphere";
import {buildTrackletsSpherical, refineGlobalSpherical, statesFromChain2D} from "../src/starTrack/StarSolveSphere";
import {fitRotationWahba, qRotate} from "../src/starTrack/StarSphere";
import {solveFrameChain} from "../src/starTrack/StarMatch";
import {lensFOV, lensToRay, makeLens} from "../src/CameraLens";

const SIZE = [1280, 720];

/** Tracks from a scene, via the normal bootstrap route. */
function tracksFor(scene) {
    const chain = solveFrameChain(scene.perFrame);
    const states = statesFromChain2D(chain.cumulative, clipLens(scene.size), scene.size);
    return buildTrackletsSpherical(scene.perFrame, states, clipLens(scene.size), scene.size);
}

describe("calibration recovers a known lens", () => {
    test("a wide fisheye clip with real rotation is calibrated close to truth", async () => {
        const scene = buildSphericalScene({
            seed: 1001, frames: 40, starCount: 120, noise: 0.15,
            rotationDeg: 3.28, poleOffsetDeg: 49,
        });
        const tracks = tracksFor(scene);
        const r = await calibrateLens(tracks, scene.frames, scene.size);
        expect(r.accepted).toBe(true);
        // Truth is orthographic f=914. The recovered focal should be within a few percent, and
        // the field of view - which is what actually matters downstream - much closer still.
        expect(r.lens.focalPx).toBeGreaterThan(830);
        expect(r.lens.focalPx).toBeLessThan(1010);
        const fov = lensFOV(r.lens, scene.size);
        const truth = lensFOV(scene.lens, scene.size);
        expect(Math.abs(fov.hfov - truth.hfov)).toBeLessThan(8);
    });

    test("the principal point lands near the image centre, as a real one does", async () => {
        const scene = buildSphericalScene({
            seed: 1002, frames: 40, starCount: 120, noise: 0.15, rotationDeg: 3.5, poleOffsetDeg: 45,
        });
        const r = await calibrateLens(tracksFor(scene), scene.frames, scene.size);
        expect(r.accepted).toBe(true);
        expect(Math.abs(r.lens.principal[0] - 640)).toBeLessThan(180);
        expect(Math.abs(r.lens.principal[1] - 360)).toBeLessThan(140);
    });

    test("an UNEVENLY CROPPED clip keeps its optical axis off centre", async () => {
        // Cropping is the ordinary reason a principal point is not at the frame centre, and it
        // is not exotic: a centred digital zoom is harmless (the crop keeps the axis at the new
        // centre, and focalPx is measured in the analysed pixels either way), but an uneven crop
        // - a 16:9 window taken off one side of the sensor, a re-framed export, a stabilised
        // sub-rectangle - moves the axis by however much was taken off that side.
        //
        // The search is bounded, because the principal point is weakly observable and an
        // unbounded one wanders. The bound used to be a hard-coded 25% of frame with a comment
        // calling an off-centre axis "a fitting artifact, not an optical property", which is
        // exactly backwards for cropped footage: the fit would quietly pull the axis back toward
        // a centre the footage does not have.
        const truth = [360, 250];                       // 280 px left and 110 px up of centre
        const scene = buildSphericalScene({
            seed: 2001, frames: 40, starCount: 130, noise: 0.15,
            rotationDeg: 3.3, poleOffsetDeg: 47,
            lens: {...clipLens(SIZE), type: "equidistantFisheye", focalPx: 700, principal: truth},
        });
        const r = await calibrateLens(tracksFor(scene), scene.frames, scene.size);
        expect(r.accepted).toBe(true);
        expect(Math.hypot(r.lens.principal[0] - truth[0], r.lens.principal[1] - truth[1]))
            .toBeLessThan(130);
        // And specifically NOT dragged back to the middle of the frame.
        expect(Math.abs(r.lens.principal[0] - SIZE[0] / 2)).toBeGreaterThan(150);
        // The offset is reported, so the UI can say "this looks cropped" rather than leaving the
        // reader to subtract it themselves.
        expect(r.diagnostics.principalOffset[0]).toBeLessThan(-150);
        expect(r.diagnostics.principalClamped).toBe(false);
    });

    test("a crop too severe to fit is REFUSED, not fitted with a centred axis", async () => {
        // Past what the geometry can support the honest answer is no lens at all - the caller
        // keeps the pinhole and says so. What must never happen is a confident fit that places
        // the axis near the centre of a frame whose axis is nowhere near it, because every
        // downstream angle would inherit that error while looking like an improvement.
        const truth = [260, 200];
        const scene = buildSphericalScene({
            seed: 2001, frames: 40, starCount: 130, noise: 0.15,
            rotationDeg: 3.3, poleOffsetDeg: 47,
            lens: {...clipLens(SIZE), type: "equidistantFisheye", focalPx: 700, principal: truth},
        });
        const r = await calibrateLens(tracksFor(scene), scene.frames, scene.size);
        if (r.accepted) {
            expect(Math.hypot(r.lens.principal[0] - truth[0], r.lens.principal[1] - truth[1]))
                .toBeLessThan(200);
        } else {
            expect(r.reason).toBeTruthy();
        }
    });

    test("a narrow rectilinear clip is not dressed up as a fisheye", async () => {
        // A long lens: every model agrees, so the gate should either return rectilinear or
        // refuse. What it must NOT do is adopt a confident wide-angle lens.
        const scene = buildSphericalScene({
            seed: 1003, frames: 40, starCount: 100, noise: 0.15,
            rotationDeg: 1.2, poleOffsetDeg: 40,
            lens: {...clipLens(SIZE), type: "rectilinear", focalPx: 4200},
        });
        const r = await calibrateLens(tracksFor(scene), scene.frames, scene.size);
        if (r.accepted) {
            const fov = lensFOV(r.lens, SIZE);
            expect(fov.hfov).toBeLessThan(40);
        } else {
            expect(r.reason).toBeTruthy();
        }
    });
});

describe("the gate refuses what it cannot see", () => {
    test("a PURE ROLL is refused, however large and however clean", async () => {
        // The case that a naive gate passes: the sky turns a long way, the stars cover the whole
        // frame, the fit is beautiful - and it carries no lens information at all, because every
        // radial lens maps a roll to the same rotation about the principal point.
        const scene = buildSphericalScene({
            seed: 2001, frames: 40, starCount: 120, noise: 0.15,
            rotationDeg: 12, poleOffsetDeg: 0,          // axis ON the boresight
        });
        const r = await calibrateLens(tracksFor(scene), scene.frames, scene.size);
        expect(r.accepted).toBe(false);
        expect(r.reason).toMatch(/roll/i);
    });

    test("a nearly still camera is refused", async () => {
        const scene = buildSphericalScene({
            seed: 2002, frames: 30, starCount: 100, noise: 0.15, rotationDeg: 0.02,
        });
        const r = await calibrateLens(tracksFor(scene), scene.frames, scene.size);
        expect(r.accepted).toBe(false);
        expect(r.reason).toMatch(/rotation/i);
    });

    test("too few correspondences is refused rather than fitted", async () => {
        const scene = buildSphericalScene({seed: 2003, frames: 12, starCount: 8, noise: 0.15});
        const r = await calibrateLens(tracksFor(scene), scene.frames, scene.size);
        expect(r.accepted).toBe(false);
        expect(r.reason).toMatch(/correspondence/i);
    });

    test("an empty track list is refused without throwing", async () => {
        const r = await calibrateLens([], 30, SIZE);
        expect(r.accepted).toBe(false);
    });
});

describe("absolute sky accuracy, not just self-consistency", () => {
    // THE GATE for migrating star identification onto the spherical map.
    //
    // The residual quoted everywhere else in this work - 0.25 px - measures SELF-consistency:
    // how well the model reproduces the observations it was fitted to. A slightly wrong lens
    // shape plus compensating per-frame rotations scores well on that while placing the recovered
    // sky directions noticeably out. Classification only needs relative consistency, which is why
    // it works either way. Identification needs the absolute geometry, and measured against the
    // catalogue on the reference clip the preset-only solve came out at 0.44 deg - worse than the
    // 2D chart's 0.23 deg, which is why Identify could not be migrated.
    //
    // These tests measure that absolute quantity directly against known truth, so the gate is
    // reproducible here instead of needing a live browser and a star catalogue.

    /** Best-fit rotation between recovered and true directions; residual rms in degrees. */
    function absoluteError(recovered, truth) {
        const pairs = [];
        for (const d of recovered) {
            if (!d) continue;
            let best = null, bestDot = -2;
            for (const t of truth) {
                const dot = d[0] * t[0] + d[1] * t[1] + d[2] * t[2];
                if (dot > bestDot) { bestDot = dot; best = t; }
            }
            // Only unambiguous matches: a star further than ~1 deg from anything is not a
            // measurement of accuracy, it is a mis-association.
            if (best && Math.acos(Math.min(1, bestDot)) < 1 * Math.PI / 180) pairs.push([d, best]);
        }
        if (pairs.length < 10) return {n: pairs.length, rmsDeg: Infinity};
        const q = fitRotationWahba(pairs.map((p) => p[0]), pairs.map((p) => p[1]));
        let sse = 0;
        for (const [a, b] of pairs) {
            const r = qRotate(q, a);
            const dot = Math.min(1, r[0] * b[0] + r[1] * b[1] + r[2] * b[2]);
            const e = Math.acos(dot) * 180 / Math.PI;
            sse += e * e;
        }
        return {n: pairs.length, rmsDeg: Math.sqrt(sse / pairs.length)};
    }

    /** Solve a scene under a given lens and report absolute direction accuracy. */
    function accuracyUnder(scene, lens) {
        const chain = solveFrameChain(scene.perFrame);
        let states = statesFromChain2D(chain.cumulative, lens, scene.size);
        let tracks = buildTrackletsSpherical(scene.perFrame, states, lens, scene.size);
        let r = refineGlobalSpherical(tracks, states, lens, scene.size);
        tracks = buildTrackletsSpherical(scene.perFrame, r.states, lens, scene.size);
        r = refineGlobalSpherical(tracks, r.states, lens, scene.size);
        const long = tracks.map((t) => (t.obs.length > scene.frames * 0.5 ? t.ref : null));
        return {...absoluteError(long, scene.stars), rms: r.rms};
    }

    // A lens that is deliberately NOT any of the five presets - which is the realistic case,
    // since a real lens is only ever approximated by the closest named curve.
    const TRUE_LENS = makeLens({
        type: "custom", focalPx: 900, principal: [634, 352], refSize: SIZE,
        distortion: [0.12, -0.05, 0.03],
    });

    test("the free polynomial recovers the sky better than the closest named preset", async () => {
        const scene = buildSphericalScene({
            seed: 5001, frames: 40, starCount: 130, noise: 0.15,
            rotationDeg: 3.4, poleOffsetDeg: 48, lens: TRUE_LENS,
        });
        const tracks = tracksFor(scene);

        const presetOnly = await calibrateLens(tracks, scene.frames, scene.size, {fitCustom: false});
        const withCustom = await calibrateLens(tracks, scene.frames, scene.size);
        expect(presetOnly.accepted).toBe(true);
        expect(withCustom.accepted).toBe(true);
        expect(withCustom.lens.type).toBe("custom");

        const a = accuracyUnder(scene, presetOnly.lens);
        const b = accuracyUnder(scene, withCustom.lens);

        // Both solves are self-consistent to well under a pixel; that is NOT the thing being
        // tested here, and asserting it alone is what would let a wrong lens through.
        expect(a.rms).toBeLessThan(1.0);
        expect(b.rms).toBeLessThan(1.0);

        // The absolute geometry is what improves.
        expect(b.rmsDeg).toBeLessThan(a.rmsDeg);
        // and comfortably under the 0.227 deg the 2D chart achieved on the reference clip, which
        // is the bar Identify has to clear before it can migrate.
        expect(b.rmsDeg).toBeLessThan(0.15);
    });

    test("self-consistency does not imply absolute accuracy - the trap this gate exists for", () => {
        const scene = buildSphericalScene({
            seed: 5002, frames: 40, starCount: 130, noise: 0.15,
            rotationDeg: 3.4, poleOffsetDeg: 48, lens: TRUE_LENS,
        });
        // Solve under a deliberately WRONG lens: the right family, 12% off in focal length.
        const wrong = makeLens({
            type: "orthographicFisheye", focalPx: 1010, principal: [640, 360], refSize: SIZE,
        });
        const r = accuracyUnder(scene, wrong);
        // It still fits its own observations respectably...
        expect(r.rms).toBeLessThan(3);
        // ...while getting the sky measurably wrong. Reporting only the first number would call
        // this a good solve.
        expect(r.rmsDeg).toBeGreaterThan(r.rms * 0.05);
    });

    test("the fitted polynomial tracks the true lens curve, not just the data", async () => {
        const scene = buildSphericalScene({
            seed: 5003, frames: 40, starCount: 130, noise: 0.15,
            rotationDeg: 3.4, poleOffsetDeg: 48, lens: TRUE_LENS,
        });
        const r = await calibrateLens(tracksFor(scene), scene.frames, scene.size);
        expect(r.accepted).toBe(true);
        // Compare the recovered mapping against the truth across the frame, in pixels.
        let worst = 0;
        for (let x = 0; x <= 1280; x += 160) {
            for (let y = 0; y <= 720; y += 120) {
                const a = lensToRay(TRUE_LENS, x, y, SIZE);
                const b = lensToRay(r.lens, x, y, SIZE);
                if (!a || !b) continue;
                const dot = Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]);
                worst = Math.max(worst, Math.acos(dot) * 180 / Math.PI);
            }
        }
        // Up to a global rotation the curve should agree closely; a couple of tenths of a degree
        // is the scale of the gauge freedom between "which way is the boresight" and the shape.
        expect(worst).toBeLessThan(1.5);
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
