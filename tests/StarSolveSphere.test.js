// The spherical Stage 3, scored against a synthetic scene whose truth is known exactly.
//
// The headline test is "the measured failure does not happen": a wide lens with the sky rotating
// about an axis near the frame corner, where the 2D similarity calls edge stars movers. That is
// the bug this whole path exists to fix, so it is asserted directly rather than inferred from an
// aggregate.

import {buildSphericalScene, clipLens} from "../src/starTrack/StarSyntheticSphere";
import {
    buildTrackletsSpherical, refineGlobalSpherical, classifyTracksSpherical,
    estimateNoiseSpherical, tangentBasis, tangentTo, meanDirection, medianDirection,
    statesFromChain2D,
} from "../src/starTrack/StarSolveSphere";
import {makeFrameState, qAngle, qBetween, refToFrame, qRotate} from "../src/starTrack/StarSphere";
import {buildTracklets, classifyTracks} from "../src/starTrack/StarSolve";
import {solveFrameChain} from "../src/starTrack/StarMatch";

const SIZE = [1280, 720];

/**
 * The designed flow: the 2D chain BOOTSTRAPS, the spherical solve produces the answer.
 *
 * No truth is leaked in - the initial orientations come from the existing 2D solve, which is
 * exactly what the migration plan specifies. Starting cold from the identity does not work and
 * the failure is worth recording: 3.28 deg over 40 frames puts the late frames ~50 px from an
 * identity prediction, ten times the association gate, so every frame starts fresh tracks and the
 * refinement never sees a track to refine.
 */
function solveSpherical(scene, opts = {}) {
    const chain = solveFrameChain(scene.perFrame);
    let states = statesFromChain2D(chain.cumulative, scene.lens, scene.size);
    let tracks = buildTrackletsSpherical(scene.perFrame, states, scene.lens, scene.size, opts);
    let refined = refineGlobalSpherical(tracks, states, scene.lens, scene.size, opts);
    // Re-associate against the refined orientations, as the 2D solve also does: the first
    // association ran under a chart that is wrong at the frame edges by about 10 px.
    tracks = buildTrackletsSpherical(scene.perFrame, refined.states, scene.lens, scene.size, opts);
    refined = refineGlobalSpherical(tracks, refined.states, scene.lens, scene.size, opts);
    const classified = classifyTracksSpherical(tracks, refined.states, scene.lens, scene.size, opts);
    return {tracks, ...refined, classified};
}

describe("tangent frames", () => {
    test("the basis is orthonormal and perpendicular to the direction", () => {
        for (const d of [[0, 0, 1], [1, 0, 0], [0.3, -0.5, 0.81]]) {
            const n = Math.hypot(...d);
            const dn = d.map((v) => v / n);
            const {e1, e2} = tangentBasis(dn);
            expect(Math.hypot(...e1)).toBeCloseTo(1, 12);
            expect(Math.hypot(...e2)).toBeCloseTo(1, 12);
            expect(e1[0] * dn[0] + e1[1] * dn[1] + e1[2] * dn[2]).toBeCloseTo(0, 12);
            expect(e2[0] * dn[0] + e2[1] * dn[1] + e2[2] * dn[2]).toBeCloseTo(0, 12);
            expect(e1[0] * e2[0] + e1[1] * e2[1] + e1[2] * e2[2]).toBeCloseTo(0, 12);
        }
    });

    test("a tangent offset stays on the sphere and moves the right way", () => {
        const d = [0, 0, 1];
        const b = tangentBasis(d);
        const moved = tangentTo(d, b, 0.05, 0);
        expect(Math.hypot(...moved)).toBeCloseTo(1, 12);
        expect(Math.acos(moved[2])).toBeCloseTo(Math.atan(0.05), 6);
    });

    test("mean and median directions are unit vectors", () => {
        const rays = [[0, 0, 1], [0.01, 0, 0.99995], [-0.01, 0.01, 0.9999]];
        expect(Math.hypot(...meanDirection(rays))).toBeCloseTo(1, 12);
        expect(Math.hypot(...medianDirection(rays))).toBeCloseTo(1, 12);
        expect(meanDirection([])).toBeNull();
    });
});

describe("the spherical solve recovers the truth", () => {
    test("orientations match the commanded sky rotation", () => {
        const scene = buildSphericalScene({seed: 7, frames: 30, starCount: 90, noise: 0.15});
        const {states} = solveSpherical(scene);
        // Gauge is frame 0, and so is the scene's, so the two are directly comparable.
        let worst = 0;
        for (let f = 0; f < scene.frames; f++) {
            worst = Math.max(worst, qAngle(qBetween(states[f].q, scene.states[f].q)));
        }
        expect(worst * 180 / Math.PI).toBeLessThan(0.02);
    });

    test("the map matches the true star directions", () => {
        const scene = buildSphericalScene({seed: 9, frames: 30, starCount: 90, noise: 0.15});
        const {tracks, map} = solveSpherical(scene);
        const long = map.filter((d, i) => d && tracks[i].obs.length > 20);
        expect(long.length).toBeGreaterThan(50);
        // every recovered direction should coincide with SOME true star, to well under a pixel
        let worst = 0;
        for (const d of long) {
            let best = Infinity;
            for (const s of scene.stars) {
                const dot = Math.min(1, d[0] * s[0] + d[1] * s[1] + d[2] * s[2]);
                best = Math.min(best, Math.acos(dot));
            }
            worst = Math.max(worst, best * scene.lens.focalPx);
        }
        expect(worst).toBeLessThan(1.0);
    });

    test("residuals settle at the noise level, not above it", () => {
        const scene = buildSphericalScene({seed: 11, frames: 30, starCount: 90, noise: 0.2});
        const {rms, converged} = solveSpherical(scene);
        expect(rms).toBeLessThan(0.5);
        expect(converged).toBe(true);
    });
});

describe("the measured failure does not happen here", () => {
    // 3.28 deg of rotation about an axis 49 deg off the boresight, on an ~89 deg lens - the real
    // clip's geometry. The 2D path calls the edge stars movers; this one must not.
    const SCENE = () => buildSphericalScene({
        seed: 4242, frames: 40, starCount: 110, noise: 0.15,
        rotationDeg: 3.28, poleOffsetDeg: 49,
    });

    test("no star is called moving, including at the frame edges", () => {
        const scene = SCENE();
        const {classified} = solveSpherical(scene);
        const movers = classified.filter((c) => c.klass === "moving");
        expect(movers).toHaveLength(0);
    });

    test("the 2D path on the SAME data does manufacture movers", () => {
        // The control. If this ever comes out at zero too, the synthetic scene has stopped
        // reproducing the real geometry and the test above has lost its meaning.
        const scene = SCENE();
        const chain = solveFrameChain(scene.perFrame);
        const tracks = buildTracklets(scene.perFrame, chain.cumulative);
        const classified = classifyTracks(tracks, chain.cumulative,
            tracks.map((t) => {
                const xs = t.obs.map((o) => o.x).sort((a, b) => a - b);
                const ys = t.obs.map((o) => o.y).sort((a, b) => a - b);
                return [xs[xs.length >> 1], ys[ys.length >> 1]];
            }));
        expect(classified.filter((c) => c.klass === "moving").length).toBeGreaterThan(0);
    });

    test("a genuine mover is still found", () => {
        const scene = buildSphericalScene({
            seed: 4242, frames: 40, starCount: 110, noise: 0.15,
            rotationDeg: 3.28, poleOffsetDeg: 49, moverSpeedPx: 2.6,
        });
        const {tracks, classified} = solveSpherical(scene);
        const movers = classified.filter((c) => c.klass === "moving");
        expect(movers.length).toBeGreaterThanOrEqual(1);
        // and it is the fastest thing in the scene, by a clear margin
        const best = movers.reduce((a, b) => (b.totalDrift > a.totalDrift ? b : a));
        expect(best.totalDrift).toBeGreaterThan(50);
    });

    test("a still field with no mover invents none", () => {
        const scene = buildSphericalScene({
            seed: 55, frames: 30, starCount: 90, noise: 0.15, rotationDeg: 0,
        });
        const {classified} = solveSpherical(scene);
        expect(classified.filter((c) => c.klass === "moving")).toHaveLength(0);
    });
});

describe("things the planar fixture could not express", () => {
    test("stars that leave the lens footprint are tracked while they are visible", () => {
        // A big rotation sweeps part of the field out of frame.
        const scene = buildSphericalScene({
            seed: 71, frames: 30, starCount: 120, noise: 0.15, rotationDeg: 14, poleOffsetDeg: 60,
        });
        const {tracks, classified} = solveSpherical(scene);
        const partial = tracks.filter((t) => t.obs.length > 5 && t.obs.length < scene.frames);
        expect(partial.length).toBeGreaterThan(0);
        // none of the partial ones should be branded a mover just for going out of frame
        const partialMovers = classified.filter(
            (c) => c.klass === "moving" && tracks[c.index].obs.length < scene.frames);
        expect(partialMovers).toHaveLength(0);
    });

    test("dropouts do not fragment a star into a mover", () => {
        const scene = buildSphericalScene({
            seed: 83, frames: 30, starCount: 80, noise: 0.15, dropoutRate: 0.15,
        });
        const {classified} = solveSpherical(scene);
        expect(classified.filter((c) => c.klass === "moving")).toHaveLength(0);
    });

    test("a track whose direction has no image this frame is not matched to something else", () => {
        // A reference direction behind the camera must yield null from refToFrame, and a null
        // prediction must remove that track from consideration rather than being read as (0,0) -
        // which would gate it onto whatever detection happens to sit near the frame origin.
        const scene = buildSphericalScene({seed: 91, frames: 4, starCount: 20});
        const st = makeFrameState();
        expect(refToFrame(st, scene.lens, [0, 0, -1], scene.size)).toBeNull();

        const behind = {obs: [{f: 0, x: 5, y: 5}], rays: [[0, 0, -1]], ref: [0, 0, -1], first: 0, last: 0};
        const tracks = buildTrackletsSpherical(
            [[], [{x: 5, y: 5}]], [st, st], scene.lens, scene.size);
        // The detection at (5,5) in frame 1 starts its own track; nothing was available to match.
        expect(tracks).toHaveLength(1);
        expect(tracks[0].obs).toHaveLength(1);
        // And a track pointing backwards contributes no usable prediction.
        expect(refToFrame(st, scene.lens, behind.ref, scene.size)).toBeNull();
    });
});

describe("contaminants must not shape the solve that judges them", () => {
    test("a camera-fixed artifact reads as a fast mover on the sphere - so it must be excluded", () => {
        // This is the failure mode, asserted directly: a hot pixel holds its PIXEL position while
        // the sky rotates, so its reference direction sweeps and the spherical classifier - which
        // has no artifact test - calls it moving. The pipeline therefore has to keep the 2D
        // pass's cameraFixed verdict rather than overwrite it with this one.
        const scene = buildSphericalScene({
            seed: 6001, frames: 40, starCount: 100, noise: 0.15,
            rotationDeg: 3.28, poleOffsetDeg: 49, hotPixels: 3,
        });
        const {tracks, classified} = solveSpherical(scene);
        // find the track sitting at a constant pixel position
        const fixed = tracks.map((t, i) => ({t, i})).filter(({t}) => {
            if (t.obs.length < 20) return false;
            const xs = t.obs.map((o) => o.x), ys = t.obs.map((o) => o.y);
            return (Math.max(...xs) - Math.min(...xs)) < 1 && (Math.max(...ys) - Math.min(...ys)) < 1;
        });
        expect(fixed.length).toBeGreaterThan(0);
        // Every one of them is called moving by the spherical classifier. That is CORRECT
        // behaviour for a module with no artifact test, and exactly why the caller must exclude.
        for (const {i} of fixed) {
            expect(classified[i].klass).toBe("moving");
        }
    });

    test("excluding a track keeps it out of the map and out of the orientations", () => {
        const scene = buildSphericalScene({
            seed: 6002, frames: 30, starCount: 90, noise: 0.15, rotationDeg: 3.0, poleOffsetDeg: 45,
        });
        const chain = solveFrameChain(scene.perFrame);
        const states = statesFromChain2D(chain.cumulative, scene.lens, scene.size);
        const tracks = buildTrackletsSpherical(scene.perFrame, states, scene.lens, scene.size);
        const exclude = new Set([0, 1, 2]);
        const r = refineGlobalSpherical(tracks, states, scene.lens, scene.size, {exclude});
        for (const i of exclude) {
            expect(r.map[i]).toBeNull();
            // but it still gets a direction, so it can be classified like anything else
            expect(tracks[i].ref).not.toBeNull();
        }
    });

    test("the orientation fit is robust: gross outliers do not drag it", () => {
        const clean = buildSphericalScene({
            seed: 6003, frames: 24, starCount: 80, noise: 0.15, rotationDeg: 3.0, poleOffsetDeg: 45,
        });
        const solvedClean = solveSpherical(clean);

        // Same scene, but a handful of detections displaced hard in every frame.
        const dirty = buildSphericalScene({
            seed: 6003, frames: 24, starCount: 80, noise: 0.15, rotationDeg: 3.0, poleOffsetDeg: 45,
        });
        for (const dets of dirty.perFrame) {
            for (let k = 0; k < 6 && k < dets.length; k++) {
                dets[k] = {x: dets[k].x + 90, y: dets[k].y - 70};
            }
        }
        const solvedDirty = solveSpherical(dirty);

        // The recovered orientations should still track the truth despite the contamination.
        let worst = 0;
        for (let f = 0; f < dirty.frames; f++) {
            worst = Math.max(worst, qAngle(qBetween(solvedDirty.states[f].q, dirty.states[f].q)));
        }
        expect(worst * 180 / Math.PI).toBeLessThan(0.15);
    });

    test("excluded tracks do not inflate sigma", () => {
        const scene = buildSphericalScene({
            seed: 6004, frames: 30, starCount: 90, noise: 0.15,
            rotationDeg: 3.0, poleOffsetDeg: 45, moverSpeedPx: 3.0,
        });
        const {tracks, states, classified} = solveSpherical(scene);
        const movers = new Set(classified.filter((c) => c.klass === "moving").map((c) => c.index));
        const withAll = estimateNoiseSpherical(tracks, states, scene.lens, scene.size);
        const without = estimateNoiseSpherical(tracks, states, scene.lens, scene.size, {exclude: movers});
        expect(without).toBeLessThanOrEqual(withAll + 1e-9);
    });
});

describe("noise estimation", () => {
    test("sigma tracks the injected noise", () => {
        for (const noise of [0.15, 0.5]) {
            const scene = buildSphericalScene({seed: 31, frames: 30, starCount: 90, noise});
            const {tracks, states} = solveSpherical(scene);
            const sigma = estimateNoiseSpherical(tracks, states, scene.lens, scene.size);
            expect(sigma).toBeGreaterThan(noise * 0.4);
            expect(sigma).toBeLessThan(noise * 2.5 + 0.2);
        }
    });

    test("sigma never drops below the floor", () => {
        const scene = buildSphericalScene({seed: 41, frames: 20, starCount: 60, noise: 0});
        const {tracks, states} = solveSpherical(scene);
        expect(estimateNoiseSpherical(tracks, states, scene.lens, scene.size)).toBeGreaterThanOrEqual(0.15);
    });
});
