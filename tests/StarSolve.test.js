// Stage 3 of Star Track: the global star map and the classification built on it.
//
// The synthetic generator knows which source is the moving object, where every star really is, and
// what the camera really did - so every claim below is scored against truth rather than against
// the pipeline's own opinion.

import {applyTransform, invertTransform, solveFrameChain} from "../src/starTrack/StarMatch";
import {detectSources, rejectReason} from "../src/starTrack/StarDetect";
import {buildScene, mulberry32, renderFrame} from "../src/starTrack/StarSynthetic";
import {
    buildTracklets,
    classifyTracks,
    estimateNoise,
    refineGlobal,
    solveStarField,
} from "../src/starTrack/StarSolve";

const W = 320, H = 192;
const DENSE = {starCount: 160, fieldMargin: 120};

function detectClip(scene) {
    const out = [], truth = [];
    for (let f = 0; f < scene.params.frames; f++) {
        const r = renderFrame(scene, f);
        out.push(detectSources(r.rgba, scene.params.width, scene.params.height)
            .sources.filter((s) => !rejectReason(s)));
        truth.push(r.truth);
    }
    return {perFrame: out, truth};
}

/** A synthetic clip solved end to end, shared across the tests that need one. */
function solvedClip(overrides = {}) {
    const scene = buildScene({
        width: W, height: H, frames: 24, seed: 4242,
        laser: false, ...DENSE, ...overrides,
    });
    const {perFrame, truth} = detectClip(scene);
    const chain = solveFrameChain(perFrame);
    const solved = solveStarField(perFrame, chain.cumulative);
    return {scene, perFrame, truth, chain, solved};
}

describe("StarSolve global refinement", () => {
    test("removes the drift that the chained solution accumulates", () => {
        // The whole reason Stage 3 exists. A chain integrates every step's error; solving all the
        // frames against one shared map leaves nothing to accumulate. Measured as the scatter of
        // each star's position in the reference frame, which is what the drift shows up as.
        const {perFrame, chain} = solvedClip();
        const tracks = buildTracklets(perFrame, chain.cumulative);
        const long = tracks.filter((t) => t.obs.length >= 12);
        expect(long.length).toBeGreaterThanOrEqual(8);

        // Scatter of the CHAINED solution.
        const chainScatter = long.map((t) => {
            const xs = t.obs.map((o) => o.rx), ys = t.obs.map((o) => o.ry);
            const mx = xs.reduce((a, b) => a + b) / xs.length;
            const my = ys.reduce((a, b) => a + b) / ys.length;
            return Math.sqrt(xs.reduce((a, x, i) => a + (x - mx) ** 2 + (ys[i] - my) ** 2, 0) / xs.length);
        });

        const refined = refineGlobal(tracks, chain.cumulative);
        const afterScatter = long.map((t, k) => {
            const i = tracks.indexOf(t);
            const s = refined.stars[i];
            if (!s) return Infinity;
            let sse = 0, n = 0;
            for (const o of t.obs) {
                const T = refined.transforms[o.f];
                if (!T) continue;
                const inv = invertTransform(T);
                const [rx, ry] = applyTransform(inv, o.x, o.y);
                sse += (rx - s[0]) ** 2 + (ry - s[1]) ** 2;
                n++;
            }
            return Math.sqrt(sse / n);
        });

        const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
        expect(med(afterScatter)).toBeLessThan(med(chainScatter));
        // ...and in absolute terms it should be down at the astrometric noise, not pixels of drift.
        expect(med(afterScatter)).toBeLessThan(0.6);
    });

    test("converges, and the residual is at the noise level", () => {
        // Measured on the FINAL solve, the one built from confirmed stars only. A refinement over
        // every track necessarily includes the hot pixels and the mover, whose residuals against a
        // star map are enormous by definition - so its RMS describes the contaminants, not the fit.
        const {solved} = solvedClip();
        expect(solved.converged).toBe(true);
        expect(solved.rms).toBeLessThan(0.5);
    });

    test("the gauge is pinned, so the map does not wander between runs", () => {
        // The solution is only defined up to a global rigid motion. Left free that null direction
        // drifts and nothing settles; anchoring frame 0 to the identity makes the map's
        // coordinates simply "frame 0 pixels".
        const {perFrame, chain} = solvedClip();
        const tracks = buildTracklets(perFrame, chain.cumulative);
        const refined = refineGlobal(tracks, chain.cumulative);
        const T0 = refined.transforms[0];
        expect(T0.A[0]).toBeCloseTo(1, 6);
        expect(T0.A[1]).toBeCloseTo(0, 6);
        expect(T0.B[0]).toBeCloseTo(0, 4);
        expect(T0.B[1]).toBeCloseTo(0, 4);
    });
});

describe("StarSolve classification", () => {
    test("finds the moving object, and does not mistake a star for one", () => {
        // The claim the whole feature rests on. Scored against the generator's own record of where
        // the object was, so a lucky guess cannot pass.
        const {truth, solved} = solvedClip({movingObject: true});

        const movers = solved.classified.filter((c) => c.klass === "moving");
        expect(movers.length).toBe(1);

        // The mover must actually be the object: check its track's raw positions against the
        // frames where truth says the object was visible.
        const track = solved.tracks[movers[0].index];
        let hits = 0, tested = 0;
        for (const o of track.obs) {
            const t = truth[o.f] && truth[o.f].object;
            if (!t) continue;
            tested++;
            if (Math.hypot(o.x - t.x, o.y - t.y) < 4) hits++;
        }
        expect(tested).toBeGreaterThan(8);
        expect(hits / tested).toBeGreaterThan(0.8);
    });

    test("stars are classified as stars, in bulk", () => {
        const {solved} = solvedClip();
        const usable = solved.classified.filter((c) => c.klass !== "short");
        const stars = usable.filter((c) => c.klass === "star");
        expect(usable.length).toBeGreaterThanOrEqual(10);
        // The field is overwhelmingly stars, and must be reported that way - a classifier that
        // hedged by calling everything "moving" would find the object too.
        expect(stars.length / usable.length).toBeGreaterThan(0.75);
    });

    test("with no moving object present, none is invented", () => {
        // The failure that matters most: a false "moving" call on a clip of nothing but stars.
        const {solved} = solvedClip({movingObject: false});
        expect(solved.classified.filter((c) => c.klass === "moving").length).toBe(0);
    });

    test("a camera-TRACKED target is reported as moving, not rejected as an artifact", () => {
        // The failure mode that would matter most, because it discards the primary finding.
        //
        // When the operator follows the object, it stays nearly stationary in frame while the sky
        // sweeps past - GEOMETRICALLY THE SAME SIGNATURE as a hot pixel. A ratio of frame-motion to
        // sky-motion cannot separate them at all. What separates them is absolute: a hot pixel
        // holds its pixel position to within a fraction of a pixel indefinitely, and nobody tracks
        // that well by hand.
        //
        // The tracklets are built by hand rather than through detection and association, because
        // the quantities under test are the frame and sky excursions themselves - going through a
        // scene would make the test depend on association gates instead of on the rule.
        const nF = 40;
        const transforms = [];
        for (let f = 0; f < nF; f++) transforms.push({A: [1, 0], B: [6 * f, 3 * f]});

        const rnd = mulberry32(9001);
        const src = {apertureFlux: 900, apertureComplete: true, apertureContaminated: false};
        const mk = (posAt) => {
            const obs = [];
            for (let f = 0; f < nF; f++) {
                const [x, y] = posAt(f);
                const inv = invertTransform(transforms[f]);
                const [rx, ry] = applyTransform(inv, x, y);
                obs.push({f, x, y, rx, ry, src});
            }
            return {obs, first: 0, last: nF - 1};
        };

        const tracks = [];
        // Sky-fixed stars: constant map position, so they sweep across the frame.
        for (let i = 0; i < 12; i++) {
            const sx = 20 + rnd() * 260, sy = 20 + rnd() * 140;
            tracks.push(mk((f) => {
                const [x, y] = applyTransform(transforms[f], sx, sy);
                return [x + (rnd() - 0.5) * 0.6, y + (rnd() - 0.5) * 0.6];
            }));
        }
        // Hot pixels: fixed in FRAME coordinates to within detection noise.
        const hots = [[60, 40], [180, 90], [250, 130]];
        for (const [hx, hy] of hots) {
            tracks.push(mk(() => [hx + (rnd() - 0.5) * 0.4, hy + (rnd() - 0.5) * 0.4]));
        }
        // The tracked target: held near frame centre, wandering as a human tracker does.
        const targetIndex = tracks.length;
        tracks.push(mk((f) => [150 + (rnd() - 0.5) * 4 + f * 1.2, 95 + (rnd() - 0.5) * 4]));

        const stars = tracks.map((t) => {
            const xs = t.obs.map((o) => o.rx).sort((a, b) => a - b);
            const ys = t.obs.map((o) => o.ry).sort((a, b) => a - b);
            return [xs[xs.length >> 1], ys[ys.length >> 1]];
        });
        const cls = classifyTracks(tracks, transforms, stars);

        // The target must be reported as moving - NOT swallowed by the camera-fixed rule.
        expect(cls[targetIndex].klass).toBe("moving");
        // ...while the genuine artifacts still are camera-fixed.
        for (let i = 12; i < 15; i++) expect(cls[i].klass).toBe("cameraFixed");
        // ...and the stars are stars.
        for (let i = 0; i < 12; i++) expect(cls[i].klass).toBe("star");
    });

    test("hot pixels are identified as camera-fixed, not as movers", () => {
        // They are fixed in the FRAME while the sky sweeps past, so against the star map they
        // appear to move fast - the one artifact most likely to be misreported as an object.
        const {solved} = solvedClip({hotPixels: 6, movingObject: false});
        const fixed = solved.classified.filter((c) => c.klass === "cameraFixed");
        expect(fixed.length).toBeGreaterThan(0);
        expect(solved.classified.filter((c) => c.klass === "moving").length).toBe(0);
    });

    test("the noise estimate tracks the actual scatter, and is pooled not per-track", () => {
        // Every classification threshold is in sigmas, so sigma has to be an estimate of
        // MEASUREMENT noise. Taking each track's own median residual first and then the median of
        // those looks equivalent and is not: a star's residual comes from a fit driven by that
        // star, so it is biased low by overfitting - it reported 0.05 px where the astrometry was
        // really ~0.3 px, and a six-fold underestimate makes a 0.02 px/frame wobble score 8.9
        // sigma. Built here from synthetic residuals of known size, where the truth is not in doubt.
        const transforms = [];
        for (let f = 0; f < 20; f++) transforms.push({A: [1, 0], B: [0, 0]});
        const build = (scatter) => {
            const rnd = mulberry32(77);
            const tracks = [], stars = [];
            for (let i = 0; i < 25; i++) {
                const sx = rnd() * 300, sy = rnd() * 180;
                stars.push([sx, sy]);
                const obs = [];
                for (let f = 0; f < 20; f++) {
                    obs.push({f, x: sx + (rnd() - 0.5) * scatter * 2, y: sy + (rnd() - 0.5) * scatter * 2});
                }
                tracks.push({obs, first: 0, last: 19});
            }
            return estimateNoise(tracks, transforms, stars, {noiseFloor: 1e-6});
        };
        const small = build(0.5), large = build(4.0);
        expect(large).toBeGreaterThan(small * 4);

        // End to end, the scale-free thresholds find the same single object on clips whose noise
        // differs by a factor of four.
        const clean = solvedClip({noiseSigma: 1.2, chromaSigma: 0.8});
        const noisy = solvedClip({noiseSigma: 5.0, chromaSigma: 4.0});
        expect(clean.solved.classified.filter((c) => c.klass === "moving").length).toBe(1);
        expect(noisy.solved.classified.filter((c) => c.klass === "moving").length).toBe(1);
    });

    test("a track too short to judge is reported as short, not guessed at", () => {
        const {perFrame, chain} = solvedClip();
        const tracks = buildTracklets(perFrame, chain.cumulative);
        const refined = refineGlobal(tracks, chain.cumulative);
        const classified = classifyTracks(tracks, refined.transforms, refined.stars);
        for (const c of classified) {
            if (c.n < 8) expect(c.klass).toBe("short");
        }
    });
});

describe("StarSolve tracklet association", () => {
    const identity = (n) => Array.from({length: n}, () => ({A: [1, 0], B: [0, 0]}));

    test("a track never holds two detections from the same frame", () => {
        // Assigning detections one at a time to their nearest track lets two sources a few pixels
        // apart both join it. The track then claims two positions for one instant, and the
        // refinement averages a pair of distinct stars into a single map entry that then drags on
        // every transform that sees it.
        const perFrame = [];
        for (let f = 0; f < 10; f++) {
            perFrame.push([
                {x: 100, y: 100, flux: 500},
                {x: 103, y: 101, flux: 400},     // well inside the association radius of the first
                {x: 200, y: 150, flux: 600},
            ]);
        }
        const tracks = buildTracklets(perFrame, identity(10));
        for (const t of tracks) {
            const frames = t.obs.map((o) => o.f);
            expect(new Set(frames).size).toBe(frames.length);
        }
        // Both close sources survive as separate tracks rather than being merged into one.
        expect(tracks.filter((t) => t.obs.length >= 8).length).toBe(3);
    });

    test("identities are not swapped when a cheaper assignment exists", () => {
        // Maximising the number of matches says nothing about WHICH detection goes to which track,
        // and the crossed assignment is usually available at the same cardinality. Two tracks at
        // x = 0 and x = 6, with detections arriving at x = 0.1 and x = 1: straight costs
        // 0.1 + 5.0, crossed costs 1.0 + 5.9, and both continue two tracks. Taking the crossed one
        // swaps the two sources' identities, merging their histories and corrupting the map.
        const idT = Array.from({length: 6}, () => ({A: [1, 0], B: [0, 0]}));
        const perFrame = [];
        for (let f = 0; f < 4; f++) perFrame.push([{x: 0, y: 0, flux: 500}, {x: 6, y: 0, flux: 400}]);
        perFrame.push([{x: 0.1, y: 0, flux: 500}, {x: 1.0, y: 0, flux: 400}]);
        perFrame.push([{x: 0, y: 0, flux: 500}, {x: 6, y: 0, flux: 400}]);

        const tracks = buildTracklets(perFrame, idT, {trackRadius: 10});
        expect(tracks.length).toBe(2);

        // The track that lived at x = 0 must have taken the 0.1 detection, not the 1.0 one.
        const nearZero = tracks.find((t) => Math.abs(t.obs[0].x) < 0.001);
        const atFive = nearZero.obs.find((o) => o.f === 4);
        expect(atFive.x).toBeCloseTo(0.1, 6);
    });

    test("no track is stranded beside a detection it could have taken", () => {
        // The property that matters, over randomised tangles rather than one hand-built case.
        //
        // A track left unmatched while an unclaimed detection sits inside its gate is a star split
        // in two for no reason. That situation is exactly an augmenting path of length one, so its
        // absence is a necessary condition of a maximum matching - and it is what a greedy pass
        // gets wrong when it spends the only track a detection could use on a pairing that had
        // alternatives.
        //
        // HONEST NOTE ON WHAT THIS DOES AND DOES NOT GUARD. The matcher backs out earlier choices
        // (augmenting paths) so that maximum cardinality is guaranteed rather than hoped for. This
        // test asserts the resulting property, but it does not demonstrate that the backing-out is
        // what achieves it: trying each detection's options nearest-first, taking detections
        // fewest-options-first, already resolves every configuration found. A sweep of 1600 random
        // tangles across four gate radii produced ZERO violations with the backing-out removed.
        // The augmenting is kept because it makes the guarantee structural instead of resting on a
        // heuristic that happens to work, but its practical effect here is nil, and a future
        // simplification that removes it would not be caught by this test.
        const R = 25;
        for (let seed = 1; seed <= 120; seed++) {
            const rnd = mulberry32(seed);
            // A cluster of sources, then a partly-overlapping cluster one frame later.
            const a = [], b = [];
            const n = 4 + Math.floor(rnd() * 6);
            for (let i = 0; i < n; i++) a.push({x: rnd() * 60, y: rnd() * 60, flux: 500});
            for (let i = 0; i < n; i++) b.push({x: rnd() * 60, y: rnd() * 60, flux: 500});

            const idT = [{A: [1, 0], B: [0, 0]}, {A: [1, 0], B: [0, 0]}];
            const tracks = buildTracklets([a, b], idT, {trackRadius: R});

            // Which tracks picked up a detection in frame 1, and which detections went unused.
            const continued = new Set(), usedX = new Set();
            for (const t of tracks) {
                const o1 = t.obs.find((o) => o.f === 1);
                if (o1) { continued.add(t); usedX.add(`${o1.x},${o1.y}`); }
            }
            const spare = b.filter((d) => !usedX.has(`${d.x},${d.y}`));

            for (const t of tracks) {
                if (continued.has(t)) continue;
                const o0 = t.obs.find((o) => o.f === 0);
                if (!o0) continue;         // a track that only began in frame 1
                for (const d of spare) {
                    const dist = Math.hypot(o0.x - d.x, o0.y - d.y);
                    expect(dist).toBeGreaterThan(R);
                }
            }
        }
    });

    test("a mover near the gate speed survives a missed detection", () => {
        // The association gate is 6 px and the target clip's object crosses the sky at ~2.6
        // px/frame - so a single missed detection put it 5+ px from its last seen position,
        // right at the gate edge, and its track fragmented or held depending on nothing but
        // which frames dropped out. A constant-velocity prediction puts the gate where the
        // object will actually be; a star's fitted velocity is zero, so stars are unaffected.
        const N = 30, SPEED = 3.5;
        const perFrame = [];
        for (let f = 0; f < N; f++) {
            perFrame.push((f === 10 || f === 20)
                ? []                                        // one missed detection, twice
                : [{x: 100 + SPEED * f, y: 200, flux: 500}]);
        }
        const identity = perFrame.map(() => ({A: [1, 0], B: [0, 0]}));

        // The discriminating half: gated on the last seen position, each miss is a 7 px step
        // that exceeds the gate, and the track really does fragment.
        const old = buildTracklets(perFrame, identity, {predictiveAssociation: false});
        expect(old.length).toBe(3);

        const now = buildTracklets(perFrame, identity, {});
        expect(now.length).toBe(1);
        expect(now[0].obs.length).toBe(N - 2);
    });

    test("a tied processing order cannot steal a track from its own detection", () => {
        // A track established at x=703; then a second source appears at 700, LISTED FIRST in
        // the frame's detection array. Both detections gate onto the one track, the tie on
        // option count is broken by array order, and augmenting cannot help - the maximum
        // cardinality is one either way. So the first-listed detection walks off with the
        // track at 3 px while the track's own detection at 0 px spawns a fragment: identity
        // theft by array order, and downstream the stolen track reads as a mover. The
        // improvement pass must be able to TRANSFER a track to an unmatched detection that
        // fits it better, not merely swap between assigned pairs.
        const perFrame = [];
        for (let f = 0; f < 5; f++) {
            perFrame.push([{x: 703, y: 300, flux: 100}]);
        }
        for (let f = 5; f < 10; f++) {
            perFrame.push([{x: 700, y: 300, flux: 100}, {x: 703, y: 300, flux: 100}]);
        }
        const identity = perFrame.map(() => ({A: [1, 0], B: [0, 0]}));
        const tracks = buildTracklets(perFrame, identity, {});
        expect(tracks.length).toBe(2);
        const t703 = tracks.find((t) => t.obs[0].x === 703);
        expect(t703.obs.every((o) => o.x === 703)).toBe(true);
        expect(t703.obs.length).toBe(10);
    });

    test("assignment is globally optimal, not merely locally unimprovable", () => {
        // Tracks at x=12 and 15; a frame offers detections at 9, 11 and 20. The locally stuck
        // state pairs 12-11 and 15-20 (squared cost 1 + 25 = 26) and fragments 9; the optimum
        // pairs 12-9 and 15-11 (9 + 16 = 25) and lets 20 found its own track. No pair swap or
        // unary transfer reaches it - the improvement is an alternating path THROUGH the
        // unmatched detection - so the assignment must be solved exactly. With squared
        // distances as costs, the exact solution is also the maximum-likelihood identity
        // assignment under Gaussian noise.
        const perFrame = [];
        for (let f = 0; f < 5; f++) {
            perFrame.push([{x: 12, y: 300, flux: 100}, {x: 15, y: 300, flux: 100}]);
        }
        perFrame.push([{x: 9, y: 300, flux: 100}, {x: 11, y: 300, flux: 100}, {x: 20, y: 300, flux: 100}]);
        const identity = perFrame.map(() => ({A: [1, 0], B: [0, 0]}));
        const tracks = buildTracklets(perFrame, identity, {});
        const t12 = tracks.find((t) => t.obs[0].x === 12);
        const t15 = tracks.find((t) => t.obs[0].x === 15);
        expect(t12.obs[t12.obs.length - 1].x).toBe(9);
        expect(t15.obs[t15.obs.length - 1].x).toBe(11);
        expect(tracks.filter((t) => t.obs[0].x === 20).length).toBe(1);
    });

    test("a gap of exactly trackMaxGap missing frames keeps the track together", () => {
        // Off by one: with an allowance of N missing frames the index difference is N+1, so
        // comparing the difference against N fragments a track that was within its own budget.
        const gap = 4;
        const perFrame = [];
        for (let f = 0; f < 12; f++) {
            const missing = f > 3 && f <= 3 + gap;      // exactly `gap` frames with no detection
            perFrame.push(missing ? [] : [{x: 100, y: 100, flux: 500}]);
        }
        const tracks = buildTracklets(perFrame, identity(12), {trackMaxGap: gap});
        expect(tracks.length).toBe(1);
        expect(tracks[0].obs.length).toBe(12 - gap);
    });
});

describe("StarSolve noise estimation", () => {
    test("transient tracks cannot collapse the noise estimate", () => {
        // A short track's map position is the centre of its own observations, so its residual is
        // zero by construction rather than by measurement - a track seen once sits exactly on
        // itself. Real footage produces these in bulk (508 of 582 tracklets on the target clip),
        // and including them drives sigma to the floor along with every threshold scaled by it.
        const transforms = Array.from({length: 20}, () => ({A: [1, 0], B: [0, 0]}));
        const rnd = mulberry32(4);
        const real = [], stars = [];
        for (let i = 0; i < 12; i++) {
            const sx = rnd() * 300, sy = rnd() * 180;
            stars.push([sx, sy]);
            const obs = [];
            for (let f = 0; f < 20; f++) {
                obs.push({f, x: sx + (rnd() - 0.5) * 4, y: sy + (rnd() - 0.5) * 4});
            }
            real.push({obs, first: 0, last: 19});
        }
        const clean = estimateNoise(real, transforms, stars, {noiseFloor: 1e-6});

        // Now swamp them with singletons, which sit exactly on their own positions.
        const withJunk = real.slice(), junkStars = stars.slice();
        for (let i = 0; i < 400; i++) {
            const jx = rnd() * 300, jy = rnd() * 180;
            junkStars.push([jx, jy]);
            withJunk.push({obs: [{f: i % 20, x: jx, y: jy}], first: i % 20, last: i % 20});
        }
        const swamped = estimateNoise(withJunk, transforms, junkStars, {noiseFloor: 1e-6});
        expect(swamped).toBeCloseTo(clean, 6);
    });

    test("one long mover cannot inflate sigma and thereby hide itself", () => {
        // Pooling every observation weights tracks by how often they were detected. The mover on
        // the target clip appears in all 179 frames while a typical star manages 8-20, so its
        // enormous residuals would form a large share of the pool and raise sigma - and since a
        // mover has to clear a multiple of sigma, it would be hiding behind its own contribution.
        // Weighting each track equally makes it one value among many.
        const nF = 60;
        const transforms = Array.from({length: nF}, () => ({A: [1, 0], B: [0, 0]}));
        const rnd = mulberry32(23);
        const tracks = [], stars = [];
        // Twelve ordinary stars, briefly seen.
        for (let i = 0; i < 12; i++) {
            const sx = rnd() * 300, sy = rnd() * 180;
            stars.push([sx, sy]);
            const obs = [];
            for (let f = 0; f < 12; f++) obs.push({f, x: sx + (rnd() - 0.5), y: sy + (rnd() - 0.5)});
            tracks.push({obs, first: 0, last: 11});
        }
        const withoutMover = estimateNoise(tracks, transforms, stars, {noiseFloor: 1e-6});

        // One mover, detected in every frame, sweeping far across the map.
        const mx = 150, my = 90;
        stars.push([mx, my]);
        const mObs = [];
        for (let f = 0; f < nF; f++) mObs.push({f, x: mx + 3 * (f - nF / 2), y: my + 2 * (f - nF / 2)});
        tracks.push({obs: mObs, first: 0, last: nF - 1});

        const withMover = estimateNoise(tracks, transforms, stars, {noiseFloor: 1e-6});
        // The mover contributes one value among thirteen, so the median barely notices it.
        expect(withMover).toBeLessThan(withoutMover * 1.5);
    });

    test("incoherent tracks cannot inflate sigma and thereby hide a mover", () => {
        // The mirror of the previous case. Weighting tracks equally stops one long track
        // dominating, but it lets a sizeable minority of incoherent tracks - blends, noise chains,
        // anything that scraped past minObservations - each contribute a large scatter and drag
        // the median up. Twenty of them took sigma from 0.60 to 4.25 px, and since a mover has to
        // clear a multiple of sigma, a 40 px mover then reads as a star.
        //
        // Neither weighting fixes it alone, because "which tracks are real sources?" is the
        // classification itself. classifyTracks resolves the circularity by running twice.
        const nF = 40;
        const transforms = Array.from({length: nF}, () => ({A: [1, 0], B: [0, 0]}));
        const rnd = mulberry32(1234);
        const perFrame = Array.from({length: nF}, () => []);

        // Twenty well-behaved stars.
        for (let i = 0; i < 20; i++) {
            const sx = 20 + rnd() * 400, sy = 20 + rnd() * 300;
            for (let f = 0; f < nF; f++) {
                perFrame[f].push({x: sx + (rnd() - 0.5) * 1.0, y: sy + (rnd() - 0.5) * 1.0,
                    apertureFlux: 900, apertureComplete: true, apertureContaminated: false});
            }
        }
        // Twenty incoherent ones: long enough to qualify, scattered by ~10 px.
        for (let i = 0; i < 20; i++) {
            const jx = 20 + rnd() * 400, jy = 340 + rnd() * 60;
            for (let f = 0; f < nF; f++) {
                perFrame[f].push({x: jx + (rnd() - 0.5) * 20, y: jy + (rnd() - 0.5) * 20,
                    apertureFlux: 300, apertureComplete: true, apertureContaminated: false});
            }
        }
        // One genuine mover, crossing 40 px over the clip.
        const ox = 250, oy = 200;
        for (let f = 0; f < nF; f++) {
            perFrame[f].push({x: ox + f, y: oy, apertureFlux: 2000,
                apertureComplete: true, apertureContaminated: false});
        }

        const tracks = buildTracklets(perFrame, transforms, {trackRadius: 12});
        const stars = tracks.map((t) => {
            const xs = t.obs.map((o) => o.rx).sort((a, b) => a - b);
            const ys = t.obs.map((o) => o.ry).sort((a, b) => a - b);
            return [xs[xs.length >> 1], ys[ys.length >> 1]];
        });
        const cls = classifyTracks(tracks, transforms, stars, {trackRadius: 12});

        // The mover must be found despite twenty incoherent tracks in the same frame.
        const movers = cls.filter((c) => c.klass === "moving");
        expect(movers.length).toBeGreaterThanOrEqual(1);
        const found = movers.some((m) => {
            const o = tracks[m.index].obs[0];
            return Math.abs(o.x - ox) < 6 && Math.abs(o.y - oy) < 6;
        });
        expect(found).toBe(true);
    });

    test("a majority of random-walking tracks cannot hide a mover", () => {
        // The hardest version, and the one that defeats classify-then-re-estimate. These tracks
        // random-walk in steps small enough to stay inside the association gate, so they form long
        // continuous tracklets with large scatter - they are not obviously junk, they are junk that
        // looks like a source. With sigma inflated to ~6 px by them, the scatter cut that would
        // have marked them incoherent is inflated in exactly the same proportion, so they are
        // admitted as stars and hold sigma up: re-estimating from the survivors changes nothing,
        // however many passes it runs. The circularity is in asking the classification to identify
        // the junk.
        //
        // Reading the LOW TAIL of the scatter distribution needs no such help: the well-measured
        // sources are the low tail by definition, so they are found even when outnumbered.
        const nF = 40;
        const transforms = Array.from({length: nF}, () => ({A: [1, 0], B: [0, 0]}));
        const rnd = mulberry32(606);
        const perFrame = Array.from({length: nF}, () => []);

        // Ten well-behaved stars - deliberately a MINORITY.
        for (let i = 0; i < 10; i++) {
            const sx = 30 + rnd() * 200, sy = 30 + rnd() * 120;
            for (let f = 0; f < nF; f++) {
                perFrame[f].push({x: sx + (rnd() - 0.5) * 0.6, y: sy + (rnd() - 0.5) * 0.6,
                    apertureFlux: 900, apertureComplete: true, apertureContaminated: false});
            }
        }
        // Twenty-five random walkers, stepping 5 px inside a 6 px gate.
        for (let i = 0; i < 25; i++) {
            let wx = 30 + rnd() * 400, wy = 200 + rnd() * 160;
            for (let f = 0; f < nF; f++) {
                wx += (rnd() - 0.5) * 10; wy += (rnd() - 0.5) * 10;
                perFrame[f].push({x: wx, y: wy,
                    apertureFlux: 300, apertureComplete: true, apertureContaminated: false});
            }
        }
        // One genuine mover, travelling 39 px over the clip on a clean straight line.
        const ox = 260, oy = 100;
        for (let f = 0; f < nF; f++) {
            perFrame[f].push({x: ox + f, y: oy, apertureFlux: 2000,
                apertureComplete: true, apertureContaminated: false});
        }

        const tracks = buildTracklets(perFrame, transforms, {trackRadius: 6});
        const stars = tracks.map((t) => {
            const xs = t.obs.map((o) => o.rx).sort((a, b) => a - b);
            const ys = t.obs.map((o) => o.ry).sort((a, b) => a - b);
            return [xs[xs.length >> 1], ys[ys.length >> 1]];
        });
        const cls = classifyTracks(tracks, transforms, stars, {trackRadius: 6});

        // Sigma must reflect the well-measured minority, not the noisy majority.
        expect(cls[0].sigma).toBeLessThan(2.0);

        const found = cls.filter((c) => c.klass === "moving").some((m) => {
            const o = tracks[m.index].obs[0];
            return Math.abs(o.x - ox) < 6 && Math.abs(o.y - oy) < 6;
        });
        expect(found).toBe(true);
    });

    test("the estimate accounts for residuals being 2D distances", () => {
        // Residuals here are distances, so with Gaussian per-axis error they are Rayleigh
        // distributed and their median is 1.1774 sigma. Treating them as a one-dimensional spread
        // and applying the usual 1.4826 MAD factor overstates sigma by 1.75x, which raises every
        // drift threshold by the same factor and hides moderate movers.
        const transforms = Array.from({length: 40}, () => ({A: [1, 0], B: [0, 0]}));
        const rnd = mulberry32(11);
        const gauss = () => {
            const u = Math.max(1e-12, rnd());
            return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
        };
        const trueSigma = 0.8;
        const tracks = [], stars = [];
        for (let i = 0; i < 40; i++) {
            const sx = rnd() * 300, sy = rnd() * 180;
            stars.push([sx, sy]);
            const obs = [];
            for (let f = 0; f < 40; f++) {
                obs.push({f, x: sx + gauss() * trueSigma, y: sy + gauss() * trueSigma});
            }
            tracks.push({obs, first: 0, last: 39});
        }
        const est = estimateNoise(tracks, transforms, stars, {noiseFloor: 1e-6});
        expect(est).toBeGreaterThan(trueSigma * 0.85);
        expect(est).toBeLessThan(trueSigma * 1.15);
    });
});

describe("StarSolve end to end", () => {
    test("magnitudes come from the detector's own photometry", () => {
        // Read from a `mag` field the detector does not produce, this returned null for every real
        // result while aperture photometry sat unused in the same object.
        const {solved} = solvedClip();
        const stars = solved.classified.filter((c) => c.klass === "star");
        expect(stars.length).toBeGreaterThan(8);
        for (const s of stars) {
            expect(Number.isFinite(s.magnitude)).toBe(true);
            // Which measurement it came from is reported, not left implicit.
            expect(["aperture", "isophotal", "contaminated"]).toContain(s.magnitudeSource);
        }
        // Brighter stars must come out numerically smaller, as magnitudes do.
        const mags = stars.map((s) => s.magnitude);
        expect(Math.max(...mags) - Math.min(...mags)).toBeGreaterThan(1.0);
    });

    test("isophotal flux is preferred over a contaminated aperture", () => {
        // Both are wrong, but differently. Isophotal flux carries a known uniform scale error, so
        // a field measured that way stays internally consistent and is merely stretched. A
        // contaminated aperture has swallowed an arbitrary amount of some neighbour's light, so
        // its error depends on which neighbour and how close - it corrupts the ORDERING, which is
        // the one property a magnitude must preserve. Ranking the aperture first because it is
        // "the better measurement" gets this exactly backwards.
        const idT = Array.from({length: 10}, () => ({A: [1, 0], B: [0, 0]}));
        const mk = (src) => {
            const obs = [];
            for (let f = 0; f < 10; f++) obs.push({f, x: 50, y: 50, src});
            return [{obs, first: 0, last: 9}];
        };
        const stars = [[50, 50]];

        // Aperture present but contaminated, alongside a usable isophotal flux: take the isophotal.
        const contaminated = classifyTracks(
            mk({apertureFlux: 5000, apertureComplete: true, apertureContaminated: true, flux: 100}),
            idT, stars);
        expect(contaminated[0].magnitudeSource).toBe("isophotal");
        expect(contaminated[0].magnitude).toBeCloseTo(-2.5 * Math.log10(100), 6);

        // Clean aperture available: that wins.
        const clean = classifyTracks(
            mk({apertureFlux: 5000, apertureComplete: true, apertureContaminated: false, flux: 100}),
            idT, stars);
        expect(clean[0].magnitudeSource).toBe("aperture");
        expect(clean[0].magnitude).toBeCloseTo(-2.5 * Math.log10(5000), 6);

        // Contaminated aperture and nothing else: used, but labelled so consumers can discount it.
        const lastResort = classifyTracks(
            mk({apertureFlux: 5000, apertureComplete: true, apertureContaminated: true, flux: 0}),
            idT, stars);
        expect(lastResort[0].magnitudeSource).toBe("contaminated");
    });

    test("the recovered star map matches the true sky geometry", () => {
        // Positions are only defined up to a global rigid motion, so absolute coordinates mean
        // nothing. The invariant that IS meaningful is the geometry: the distances between stars.
        const {scene, truth, solved} = solvedClip();

        // Pair recovered stars to truth using the first frame they were seen in.
        const pairs = [];
        for (const c of solved.classified) {
            if (c.klass !== "star" || !c.position) continue;
            const t = solved.tracks[c.index];
            const o = t.obs[0];
            const known = truth[o.f].stars.find((s) => Math.hypot(s.x - o.x, s.y - o.y) < 3);
            if (known) pairs.push({map: c.position, id: known.id});
        }
        expect(pairs.length).toBeGreaterThanOrEqual(8);

        const byId = new Map(scene.stars.map((s) => [s.id, s]));
        const errs = [];
        for (let i = 0; i < pairs.length; i++) {
            for (let j = i + 1; j < pairs.length; j++) {
                const a = pairs[i], b = pairs[j];
                const ta = byId.get(a.id), tb = byId.get(b.id);
                const dMap = Math.hypot(a.map[0] - b.map[0], a.map[1] - b.map[1]);
                const dTrue = Math.hypot(ta.x - tb.x, ta.y - tb.y);
                errs.push(Math.abs(dMap - dTrue));
            }
        }
        errs.sort((x, y) => x - y);

        // Typical agreement is a few hundredths of a pixel over separations of hundreds of pixels.
        expect(errs[errs.length >> 1]).toBeLessThan(0.1);
        expect(errs[(errs.length * 0.9) | 0]).toBeLessThan(1.2);

        // The distribution has a tail, and asserting on the maximum would be asserting the wrong
        // thing. A 160-star field at this scale contains marginal blends: two stars close enough
        // that the detector reports one source between them. Its map position is then genuinely a
        // couple of pixels from either true star, which is a limit of the DETECTION, not an error
        // in the map - the same blend would displace any solver identically.
        expect(errs[errs.length - 1]).toBeLessThan(4.0);
    });

    test("an empty clip solves to nothing rather than throwing", () => {
        const solved = solveStarField([], []);
        expect(solved.classified).toEqual([]);
        expect(solved.tracks).toEqual([]);
    });

    test("a single frame solves to stars when single observations are allowed to count", () => {
        // A still image gives the pipeline one frame: no motion to solve, nothing to
        // classify against - every detected point is presumed a star, which is what a
        // single exposure of the night sky can honestly claim. The app layer requests this
        // with minObservations 1 (and merging off - two detections in one frame are two
        // stars by definition).
        const dets = [
            {x: 100, y: 100, flux: 4000}, {x: 300, y: 220, flux: 900},
            {x: 520, y: 80, flux: 2000}, {x: 240, y: 400, flux: 300},
            {x: 610, y: 330, flux: 1200},
        ];
        const solved = solveStarField([dets], [{A: [1, 0], B: [0, 0]}],
            {minObservations: 1, starMergeRadius: 0});
        const stars = solved.classified.filter((c) => c.klass === "star");
        expect(stars.length).toBe(5);
        for (const s of stars) {
            expect(Number.isFinite(s.magnitude)).toBe(true);
            expect(s.position).not.toBeNull();
        }
        // Brighter flux, smaller (more negative) magnitude.
        const byFlux = [...solved.classified].sort((a, b) => a.magnitude - b.magnitude);
        expect(solved.tracks[byFlux[0].index].obs[0].src.flux).toBe(4000);
    });
});

describe("StarSolve temporal regularisation", () => {
    // A camera's rotation is continuous: it cannot swing a degree one way and back between
    // consecutive frames. An INDEPENDENT per-frame fit can, and on the target clip it did -
    // sparse frames flip-flopped between rotation solutions 1.2 deg apart, which duplicated
    // every star in the map and cut the moving object's track at each transition. These tests
    // pit consistent wrong-rotation evidence in some frames against the smoothness of the whole,
    // and each one first verifies that the INDEPENDENT solve (refineSmoothness: 0) really does
    // follow the bad evidence - without that half, a test like this can pass vacuously.
    const trueTheta = (f) => 0.002 * f;
    const trueT = (f) => ({
        A: [Math.cos(trueTheta(f)), Math.sin(trueTheta(f))],
        B: [0.5 * f, -0.3 * f],
    });
    // Spread wide, as real stars are: the rotation-vs-translation distinction lives in the lever
    // arms, and a compact cluster would make the two nearly indistinguishable.
    const STARS = [
        [100, 100], [900, 150], [500, 600], [150, 500], [800, 500],
        [400, 120], [250, 300], [700, 300], [600, 450],
    ];
    const N = 41;

    /** Exact tracks under the true camera, except frames where `badTheta` overrides the rotation. */
    function buildTracks(badTheta = () => null) {
        const tracks = STARS.map(() => ({obs: [], first: 0, last: N - 1}));
        for (let f = 0; f < N; f++) {
            const T = trueT(f);
            const over = badTheta(f);
            const A = over === null ? T.A : [Math.cos(over), Math.sin(over)];
            for (let i = 0; i < STARS.length; i++) {
                const [x, y] = applyTransform({A, B: T.B}, STARS[i][0], STARS[i][1]);
                tracks[i].obs.push({f, x, y, rx: STARS[i][0], ry: STARS[i][1], src: null});
            }
        }
        return tracks;
    }

    const rotationOf = (T) => Math.atan2(T.A[1], T.A[0]);
    const init = () => Array.from({length: N}, (_, f) => trueT(f));

    test("one frame's consistent wrong-rotation evidence cannot swing the solve", () => {
        // Every observation in frame 20 is rotated an extra 0.02 rad - a coherent, perfectly
        // self-consistent lie, the hardest kind to reject frame-locally because the frame's own
        // least-squares fit is exact.
        const BAD = 20, DELTA = 0.02;
        const tracks = buildTracks((f) => (f === BAD ? trueTheta(f) + DELTA : null));

        const independent = refineGlobal(tracks, init(), {refineSmoothness: 0});
        const errInd = Math.abs(rotationOf(independent.transforms[BAD]) - trueTheta(BAD));
        expect(errInd).toBeGreaterThan(0.015);

        const smoothed = refineGlobal(tracks, init(), {});
        const errSm = Math.abs(rotationOf(smoothed.transforms[BAD]) - trueTheta(BAD));
        expect(errSm).toBeLessThan(0.012);
        // ...and the neighbours are not dragged toward the bad frame in exchange.
        for (const f of [BAD - 2, BAD + 2]) {
            expect(Math.abs(rotationOf(smoothed.transforms[f]) - trueTheta(f))).toBeLessThan(0.006);
        }
    });

    test("an alternating rotation flip-flop is crushed; the steady pan around it is untouched", () => {
        // The pattern actually observed on the target clip: rotation alternating about the trend
        // on consecutive frames. That zigzag is the highest-frequency mode there is, which is
        // exactly where a second-difference penalty bites hardest - while the constant-rate pan
        // carrying it lies in the penalty's null space and passes through unchanged.
        const DELTA = 0.01;
        const zig = (f) => (f >= 15 && f <= 25 ? trueTheta(f) + (f % 2 ? -DELTA : DELTA) : null);
        const tracks = buildTracks(zig);

        const independent = refineGlobal(tracks, init(), {refineSmoothness: 0});
        let worstInd = 0;
        for (let f = 15; f <= 25; f++) {
            worstInd = Math.max(worstInd, Math.abs(rotationOf(independent.transforms[f]) - trueTheta(f)));
        }
        expect(worstInd).toBeGreaterThan(0.008);

        const smoothed = refineGlobal(tracks, init(), {});
        let worstSm = 0;
        for (let f = 15; f <= 25; f++) {
            worstSm = Math.max(worstSm, Math.abs(rotationOf(smoothed.transforms[f]) - trueTheta(f)));
        }
        expect(worstSm).toBeLessThan(0.004);

        // Far from the disturbance, the pan is recovered essentially exactly: the penalty is on
        // rotation ACCELERATION, so a steady pan pays nothing and is not biased.
        for (const f of [5, 35]) {
            expect(Math.abs(rotationOf(smoothed.transforms[f]) - trueTheta(f))).toBeLessThan(0.002);
        }
    });

    test("a frame with no observations gets an interpolated transform, not a stale held one", () => {
        // The real clip had exactly this: one dropout frame with zero anchor observations, whose
        // transform therefore kept the chained initialisation - which sat 2 deg off the refined
        // trend, a single-frame spike that broke track association straight through it.
        const GAP = 20;
        const tracks = buildTracks();
        for (const t of tracks) t.obs = t.obs.filter((o) => o.f !== GAP);

        // The initialisation holds a WRONG transform at the empty frame, as a stale chain would.
        const bad = init();
        const wrong = trueTheta(GAP) + 0.03;
        bad[GAP] = {A: [Math.cos(wrong), Math.sin(wrong)], B: bad[GAP].B};

        const independent = refineGlobal(tracks, bad.map((T) => ({A: T.A.slice(), B: T.B.slice()})),
            {refineSmoothness: 0});
        const errInd = Math.abs(rotationOf(independent.transforms[GAP]) - trueTheta(GAP));
        expect(errInd).toBeGreaterThan(0.02);   // nothing ever overwrites the stale copy

        const smoothed = refineGlobal(tracks, bad.map((T) => ({A: T.A.slice(), B: T.B.slice()})), {});
        const errSm = Math.abs(rotationOf(smoothed.transforms[GAP]) - trueTheta(GAP));
        expect(errSm).toBeLessThan(0.003);
        // The translation is interpolated too, not held: the true B moves ~0.6 px per frame, so
        // a held copy would be exact here only by luck - check it lands between the neighbours.
        const B = smoothed.transforms[GAP].B;
        expect(Math.abs(B[0] - 0.5 * GAP)).toBeLessThan(1.0);
        expect(Math.abs(B[1] - (-0.3 * GAP))).toBeLessThan(1.0);
    });
});

describe("StarSolve split-star merging", () => {
    // A star can vanish below the detection threshold for longer than trackMaxGap, and sequential
    // gap-limited association then cannot rejoin the pieces - by design. The pieces are still one
    // star, and the discriminator is physical: one star yields one detection per frame, so pieces
    // of the same star have complementary spans, while two genuinely close stars coexist in
    // nearly every frame both are visible.
    const N = 60, GONE_FROM = 20, GONE_TO = 39;   // a 20-frame hole, twice trackMaxGap
    const SPLIT = [100, 100];
    const STEADY = [[300, 200], [500, 400], [200, 350], [400, 120]];
    const CLOSE = [[700, 300], [703, 300]];       // 3 px apart, both always present

    function clip(splitVisible) {
        const perFrame = [];
        for (let f = 0; f < N; f++) {
            const T = {A: [Math.cos(0.001 * f), Math.sin(0.001 * f)], B: [0.3 * f, 0.1 * f]};
            const det = [];
            const add = ([px, py]) => {
                const [x, y] = applyTransform(T, px, py);
                det.push({x, y, flux: 1000});
            };
            for (const s of STEADY) add(s);
            for (const s of CLOSE) add(s);
            if (splitVisible(f)) add(SPLIT);
            perFrame.push(det);
        }
        return perFrame;
    }

    const nearCount = (solved, [px, py], within) =>
        solved.classified.filter((c) => c.klass === "star" && c.position
            && Math.hypot(c.position[0] - px, c.position[1] - py) < within).length;

    test("a star split by a long dropout is one star in the map, not two", () => {
        const perFrame = clip((f) => f < GONE_FROM || f > GONE_TO);
        const chain = solveFrameChain(perFrame);

        // The discriminating half: with merging disabled, the pieces really do survive as two.
        const unmerged = solveStarField(perFrame, chain.cumulative, {starMergeRadius: 0});
        expect(nearCount(unmerged, SPLIT, 5)).toBe(2);

        const solved = solveStarField(perFrame, chain.cumulative);
        expect(nearCount(solved, SPLIT, 5)).toBe(1);
        // ...and the merged track spans the whole clip, holding every observation both pieces had.
        const c = solved.classified.find((x) => x.klass === "star"
            && Math.hypot(x.position[0] - SPLIT[0], x.position[1] - SPLIT[1]) < 5);
        expect(c.first).toBe(0);
        expect(c.last).toBe(N - 1);
        expect(c.n).toBe(N - (GONE_TO - GONE_FROM + 1));
    });

    test("two genuinely close stars are never merged, because they coexist", () => {
        const perFrame = clip((f) => f < GONE_FROM || f > GONE_TO);
        const chain = solveFrameChain(perFrame);
        const solved = solveStarField(perFrame, chain.cumulative);
        // Both members of the 3 px pair - inside starMergeRadius - keep their identities.
        expect(nearCount(solved, [701.5, 300], 6)).toBe(2);
    });

    test("long coexistence is disqualifying however long the tracks are", () => {
        // Two stationary stars 3 px apart, 40 observations each, sharing 10 frames. A
        // fractional overlap allowance (a quarter of the shorter track) reads 10 shared frames
        // as acceptable at this length, merges them, and the chimera - 700 for thirty frames,
        // then 703 for thirty - carries a statistically immaculate 3 px drift: a manufactured
        // mover. Genuine pieces of one star can only "coexist" through a blend's transient
        // double-detection, which is an ABSOLUTE few frames, never a fraction of track length.
        const FRAMES = 70;
        const A = [700, 300], B = [703, 300];
        const perFrame = [];
        for (let f = 0; f < FRAMES; f++) {
            const T = {A: [Math.cos(0.001 * f), Math.sin(0.001 * f)], B: [0.3 * f, 0.1 * f]};
            const det = [];
            const add = ([px, py]) => {
                const [x, y] = applyTransform(T, px, py);
                det.push({x, y, flux: 1000});
            };
            for (const s of STEADY) add(s);
            if (f <= 39) add(A);
            if (f >= 30) add(B);
            perFrame.push(det);
        }
        const chain = solveFrameChain(perFrame);
        const solved = solveStarField(perFrame, chain.cumulative);
        expect(nearCount(solved, [701.5, 300], 8)).toBe(2);
        expect(solved.classified.filter((c) => c.klass === "moving").length).toBe(0);
    });

    test("a merge whose result moves is falsified and undone", () => {
        // Two distinct stationary stars 3 px apart whose visibilities hand over with only two
        // shared frames. Every threshold-shaped gate passes this - the positions are within the
        // merge radius and the overlap is within the blend allowance - because thresholds can
        // only narrow the chimera class, never close it. What closes it is the merge's own
        // meaning: it asserts the pieces are ONE STATIONARY star, so a merged track that then
        // classifies as MOVING has falsified the assertion and must be taken apart again.
        const FRAMES = 80;
        const A = [700, 300], B = [703, 300];
        const perFrame = [];
        for (let f = 0; f < FRAMES; f++) {
            const T = {A: [Math.cos(0.001 * f), Math.sin(0.001 * f)], B: [0.3 * f, 0.1 * f]};
            const det = [];
            const add = ([px, py]) => {
                const [x, y] = applyTransform(T, px, py);
                det.push({x, y, flux: 1000});
            };
            for (const s of STEADY) add(s);
            if (f <= 39) add(A);
            if (f >= 38) add(B);
            perFrame.push(det);
        }
        const chain = solveFrameChain(perFrame);
        const solved = solveStarField(perFrame, chain.cumulative);
        expect(nearCount(solved, [701.5, 300], 8)).toBe(2);
        expect(solved.classified.filter((c) => c.klass === "moving").length).toBe(0);
    });

    test("a star seen in two distant windows is one star, not a visibility reject", () => {
        // A faint star above threshold for ten frames early and twenty late, invisible for the
        // hundred frames between. Its pieces merge on position - 1 px apart, zero shared
        // frames - but the combined track is then "visible" in a fifth of its own span, and
        // the blip-chain rule calls it incoherent, which the verifier reads as a refuted
        // merge. Duty cycle across the merge gap is meaningless: the merge exists BECAUSE the
        // star was invisible for that stretch. Visibility of a merged track is judged over the
        // union of its pieces' spans.
        const FRAMES = 140;
        const S = [700, 300];
        const perFrame = [];
        for (let f = 0; f < FRAMES; f++) {
            const T = {A: [Math.cos(0.001 * f), Math.sin(0.001 * f)], B: [0.3 * f, 0.1 * f]};
            const det = [];
            const add = ([px, py]) => {
                const [x, y] = applyTransform(T, px, py);
                det.push({x, y, flux: 1000});
            };
            for (const s of STEADY) add(s);
            if (f <= 9 || f >= 120) add(S);
            perFrame.push(det);
        }
        const chain = solveFrameChain(perFrame);
        const solved = solveStarField(perFrame, chain.cumulative);
        expect(nearCount(solved, S, 6)).toBe(1);
        const one = solved.classified.find((c) => c.klass === "star"
            && Math.hypot(c.position[0] - S[0], c.position[1] - S[1]) < 6);
        expect(one.n).toBe(30);
    });

    test("a merged track's span is the union of its pieces, not their sum", () => {
        // Two sparse pieces of one star whose SPANS overlap while their observed frames barely
        // do. Summing the spans double-counts the overlap, deflating the visible fraction below
        // the blip-chain bar - 14 observations over "36" frames instead of the true 27 - and
        // the verifier then refutes a legitimate merge. The span of a merged track is the
        // interval UNION of its pieces' spans.
        const N30 = 30;
        const IDENT = Array.from({length: N30}, () => ({A: [1, 0], B: [0, 0]}));
        const steadyTracks = [[100, 100], [300, 200], [500, 400], [200, 350]].map(([x, y]) => ({
            obs: Array.from({length: 27}, (_, f) => ({f, x, y, src: null})),
            first: 0, last: 26,
        }));
        const obsFrames = [0, 2, 4, 6, 8, 9, 11, 13, 15, 17, 19, 21, 23, 26];
        const mergedTrack = {
            obs: obsFrames.map((f) => ({f, x: 700, y: 300, src: null})),
            first: 0, last: 26,
            mergedFrom: [{first: 0, last: 17}, {first: 9, last: 26}],
        };
        const tracks = [...steadyTracks, mergedTrack];
        const stars = [[100, 100], [300, 200], [500, 400], [200, 350], [700, 300]];
        const classified = classifyTracks(tracks, IDENT, stars, {});
        expect(classified[4].klass).toBe("star");
    });

    test("a falsified merge is retried without the refuted combination", () => {
        // An A-B-A handover: star A visible early and late, star B filling the middle, each
        // boundary sharing only two frames. All three pieces are pairwise mergeable, and the
        // full merge produces a chimera that classifies INCOHERENT - which refutes the
        // one-stationary-star hypothesis just as surely as "moving" does, and must not stand
        // as "two valid stars replaced by one rejected track". Nor is wholesale reversion the
        // right answer: A's own two pieces really are one star. The falsified COMBINATION is
        // forbidden and the merge re-runs, keeping A whole and B separate.
        const FRAMES = 80;
        const A = [700, 300], B = [703, 300];
        const perFrame = [];
        for (let f = 0; f < FRAMES; f++) {
            const T = {A: [Math.cos(0.001 * f), Math.sin(0.001 * f)], B: [0.3 * f, 0.1 * f]};
            const det = [];
            const add = ([px, py]) => {
                const [x, y] = applyTransform(T, px, py);
                det.push({x, y, flux: 1000});
            };
            for (const s of STEADY) add(s);
            if (f <= 29 || f >= 60) add(A);
            if (f >= 28 && f <= 61) add(B);
            perFrame.push(det);
        }
        const chain = solveFrameChain(perFrame);
        const solved = solveStarField(perFrame, chain.cumulative);
        // Exactly two: A rejoined across its dropout, B intact - not three unmerged pieces,
        // not one chimera, and nothing moving or incoherent in the area.
        expect(nearCount(solved, [701.5, 300], 8)).toBe(2);
        expect(solved.classified.filter((c) => c.klass === "moving").length).toBe(0);
        const nearRejected = solved.classified.filter((c) => c.klass === "incoherent"
            && c.position && Math.hypot(c.position[0] - 701.5, c.position[1] - 300) < 8);
        expect(nearRejected.length).toBe(0);
    });

    test("a bridging fragment cannot chain two coexisting stars into one", () => {
        // Two real stars 3.5 px apart, both dropping below threshold for the same long stretch -
        // which is what a blend does to a close pair - and a fragment between them detected only
        // in the middle of that stretch, isolated from every other piece by more than trackMaxGap
        // so association cannot join it to anything. The fragment is pairwise mergeable with
        // EITHER star's pieces - complementary span, close position - so following pairwise links
        // transitively unions the two real stars, and the chimera track alternates between two
        // positions: a manufactured mover-or-worse built out of stationary stars. Merging must
        // demand that EVERY cross-pair of the final group satisfies the same-star conditions,
        // which the coexisting star pair never does.
        const FRAMES = 80;
        // The bridge sits nearer A but within merge radius of BOTH stars, which is what makes it
        // a bridge: pairwise it may join either.
        const A = [700, 300], B = [703.5, 300], BRIDGE = [700.8, 300];
        const perFrame = [];
        for (let f = 0; f < FRAMES; f++) {
            const T = {A: [Math.cos(0.001 * f), Math.sin(0.001 * f)], B: [0.3 * f, 0.1 * f]};
            const det = [];
            const add = ([px, py]) => {
                const [x, y] = applyTransform(T, px, py);
                det.push({x, y, flux: 1000});
            };
            for (const s of STEADY) add(s);
            const inGap = f >= 20 && f <= 52;
            if (!inGap) { add(A); add(B); }
            if (f >= 32 && f <= 40) add(BRIDGE);
            perFrame.push(det);
        }
        const chain = solveFrameChain(perFrame);
        const solved = solveStarField(perFrame, chain.cumulative);
        // The two coexisting stars survive as two; the fragment may join one of them, but no
        // amount of bridging may fuse the pair - and nothing here is allowed to read as moving.
        expect(nearCount(solved, [701.7, 300], 8)).toBe(2);
        expect(solved.classified.filter((c) => c.klass === "moving").length).toBe(0);
    });
});
