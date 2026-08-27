// The FIXED-CAMERA spherical solve: one axis and one rate for the whole clip.
//
// The synthetic scene IS a fixed camera - the sky turns about one axis at a constant per-frame
// rate - so its truth is exactly what the constrained model should recover, and the free
// per-frame solve's tests give the comparison points.

import {buildSphericalScene} from "../src/starTrack/StarSyntheticSphere";
import {
    buildTrackletsSpherical, refineFixedAxisSpherical, classifyTracksSpherical,
    statesFromChain2D, seedFixedAxis,
} from "../src/starTrack/StarSolveSphere";
import {qAngle, qBetween, qFromAxisAngle, qConj, makeFrameState} from "../src/starTrack/StarSphere";
import {solveFrameChain} from "../src/starTrack/StarMatch";
import {makeLens} from "../src/CameraLens";

async function solveFixed(scene, opts = {}) {
    const chain = solveFrameChain(scene.perFrame);
    const states = statesFromChain2D(chain.cumulative, scene.lens, scene.size);
    let tracks = buildTrackletsSpherical(scene.perFrame, states, scene.lens, scene.size, opts);
    let refined = await refineFixedAxisSpherical(tracks, states, scene.lens, scene.size, opts);
    tracks = buildTrackletsSpherical(scene.perFrame, refined.states, scene.lens, scene.size, opts);
    refined = await refineFixedAxisSpherical(tracks, refined.states, scene.lens, scene.size, opts);
    const classified = classifyTracksSpherical(tracks, refined.states, scene.lens, scene.size, opts);
    return {tracks, ...refined, classified};
}

function worstOrientationErrorDeg(states, scene) {
    let worst = 0;
    for (let f = 0; f < scene.frames; f++) {
        worst = Math.max(worst, qAngle(qBetween(states[f].q, scene.states[f].q)));
    }
    return worst * 180 / Math.PI;
}

describe("seedFixedAxis", () => {
    test("recovers the rotation vector of an exact fixed-axis state set", () => {
        const axis = [0.3, -0.4, Math.sqrt(1 - 0.25)];
        const rate = 0.002;
        const states = [];
        for (let f = 0; f < 30; f++) {
            states.push(f === 3 ? null   // a missing frame does not vote
                : makeFrameState({q: qFromAxisAngle(axis, rate * f)}));
        }
        const seed = seedFixedAxis(states);
        expect(seed.f0).toBe(0);
        for (let k = 0; k < 3; k++) expect(seed.v[k]).toBeCloseTo(axis[k] * rate, 10);
    });
});

describe("the fixed-axis solve recovers the truth", () => {
    test("orientations match the commanded sky rotation, from the 2D chain seed alone", async () => {
        const scene = buildSphericalScene({seed: 7, frames: 30, starCount: 90, noise: 0.15});
        const {states, converged, rms, ratePerFrame, axis} = await solveFixed(scene);
        expect(converged).toBe(true);
        expect(worstOrientationErrorDeg(states, scene)).toBeLessThan(0.01);
        expect(rms).toBeLessThan(0.3);
        // Rate and axis: the scene's states are conj(axisAngle(axis, perFrame*f)), i.e. a
        // rotation vector of -perFrame*axis.
        const perFrame = 3.28 * Math.PI / 180 / 29;
        expect(ratePerFrame).toBeCloseTo(perFrame, 5);
        const a = 49 * Math.PI / 180;
        const sceneAxis = [Math.sin(a) * 0.866, -Math.sin(a) * 0.5, Math.cos(a)];
        for (let k = 0; k < 3; k++) expect(axis[k]).toBeCloseTo(-sceneAxis[k], 3);
    });

    test("no star is called moving, and a genuine mover still is", async () => {
        const scene = buildSphericalScene({seed: 11, frames: 40, starCount: 100, noise: 0.2,
            moverSpeedPx: 2.6});
        const {classified} = await solveFixed(scene);
        const moving = classified.filter((c) => c.klass === "moving");
        expect(moving.length).toBe(1);
        const stars = classified.filter((c) => c.klass === "star");
        expect(stars.length).toBeGreaterThan(80);
    });

    test("a 160-degree allsky fisheye with the pole 57 degrees off-axis, sub-pixel per frame", async () => {
        // The D'Antonio geometry: equisolid lens sized like the render's, celestial pole at
        // 33 deg altitude for a zenith camera, 86 frames of 15 s (0.0627 deg/frame). The 2D
        // similarity chain is a poor model of this field; the constrained solve must not care.
        const size = [1280, 720];
        const lens = makeLens({type: "equisolidFisheye", focalPx: 388, principal: [636, 364],
            refSize: size});
        const scene = buildSphericalScene({seed: 5, size, lens, frames: 86, starCount: 160,
            noise: 0.25, rotationDeg: 0.0627 * 85, poleOffsetDeg: 57});
        const {states, converged, ratePerFrame, classified} = await solveFixed(scene);
        expect(converged).toBe(true);
        expect(worstOrientationErrorDeg(states, scene)).toBeLessThan(0.02);
        expect(ratePerFrame * 180 / Math.PI).toBeCloseTo(0.0627, 3);
        expect(classified.filter((c) => c.klass === "moving").length).toBe(0);
    });

    test("excluded tracks do not shape the axis", async () => {
        const scene = buildSphericalScene({seed: 3, frames: 30, starCount: 60, noise: 0.15,
            hotPixels: 6});
        const chain = solveFrameChain(scene.perFrame);
        const states = statesFromChain2D(chain.cumulative, scene.lens, scene.size);
        const tracks = buildTrackletsSpherical(scene.perFrame, states, scene.lens, scene.size);
        // Hot pixels: the tracks that never move in pixels.
        const exclude = new Set();
        tracks.forEach((t, i) => {
            const xs = t.obs.map((o) => o.x), ys = t.obs.map((o) => o.y);
            if (Math.max(...xs) - Math.min(...xs) < 0.5 && Math.max(...ys) - Math.min(...ys) < 0.5) exclude.add(i);
        });
        expect(exclude.size).toBe(6);
        const r = await refineFixedAxisSpherical(tracks, states, scene.lens, scene.size, {exclude});
        expect(worstOrientationErrorDeg(r.states, scene)).toBeLessThan(0.01);
        for (const i of exclude) expect(r.map[i]).toBeNull();
    });

    test("aborts cleanly", async () => {
        const scene = buildSphericalScene({seed: 9, frames: 20, starCount: 40});
        const chain = solveFrameChain(scene.perFrame);
        const states = statesFromChain2D(chain.cumulative, scene.lens, scene.size);
        const tracks = buildTrackletsSpherical(scene.perFrame, states, scene.lens, scene.size);
        const r = await refineFixedAxisSpherical(tracks, states, scene.lens, scene.size,
            {shouldAbort: () => true});
        expect(r).toBeNull();
    });
});
