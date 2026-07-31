// Stage 2 of Star Track: frame-to-frame matching and camera-motion recovery, scored against the
// synthetic generator's known camera path.
//
// The scoring question is not "did it produce a transform" but "does that transform agree with
// the one the scene was rendered with". Every test below compares against truth.
//
// Scenes are kept small deliberately: detection dominates the runtime, and these tests exercise
// the MATCHING, which does not care about frame size.

import {
    STAR_MATCH_DEFAULTS,
    IDENTITY,
    applyTransform,
    composeTransform,
    findCameraFixed,
    fitSimilarity,
    invertTransform,
    matchByInvariants,
    matchByOffsetVote,
    matchByPrediction,
    solveFrameChain,
    transformParams,
    triangleMatch,
} from "../src/starTrack/StarMatch";

import {detectSources, rejectReason} from "../src/starTrack/StarDetect";
import {buildScene, mulberry32, renderFrame} from "../src/starTrack/StarSynthetic";

const W = 320, H = 192;

// Star density matched to the real target clip, which yields 28-38 usable detections per frame.
// This matters: at the generator's defaults a 320x192 frame holds only ~10 detections, and after
// camera-fixed artifacts are removed 4-6 stars remain. The chain still tracks, but drift over
// twenty frames grows to ~8 px instead of ~0.2 px, so a sparse scene would be measuring the star
// count rather than the algorithm.
const DENSE = {starCount: 160, fieldMargin: 120};

/** Detections per frame, filtered by the Stage 1 rejection policy. */
function detectClip(scene) {
    const out = [];
    for (let f = 0; f < scene.params.frames; f++) {
        const {rgba} = renderFrame(scene, f);
        out.push(detectSources(rgba, scene.params.width, scene.params.height)
            .sources.filter((s) => !rejectReason(s)));
    }
    return out;
}

/**
 * How far a recovered transform disagrees with truth, in pixels, measured at the frame corners.
 *
 * A single number capturing translation, rotation AND scale error together - comparing the raw
 * parameters separately would let a rotation error hide behind a compensating translation.
 */
function cornerDisagreement(Ta, Tb, w = W, h = H) {
    let worst = 0;
    for (const [x, y] of [[0, 0], [w, 0], [0, h], [w, h]]) {
        const a = applyTransform(Ta, x, y);
        const b = applyTransform(Tb, x, y);
        worst = Math.max(worst, Math.hypot(a[0] - b[0], a[1] - b[1]));
    }
    return worst;
}

/** A pure rotation + translation, which is the only mapping a fixed-zoom camera can produce. */
function rigid(angle, tx, ty) {
    return {A: [Math.cos(angle), Math.sin(angle)], B: [tx, ty]};
}

describe("StarMatch transform algebra", () => {
    const T = {A: [0.9, 0.3], B: [12, -7]};

    test("inverse undoes the transform", () => {
        const inv = invertTransform(T);
        for (const [x, y] of [[0, 0], [100, 50], [-30, 200]]) {
            const [px, py] = applyTransform(T, x, y);
            const [bx, by] = applyTransform(inv, px, py);
            expect(bx).toBeCloseTo(x, 9);
            expect(by).toBeCloseTo(y, 9);
        }
    });

    test("composition applies the right transform first", () => {
        const S = {A: [1.1, -0.2], B: [-5, 3]};
        const both = composeTransform(S, T);
        for (const [x, y] of [[0, 0], [64, 32]]) {
            const step = applyTransform(T, x, y);
            const expected = applyTransform(S, step[0], step[1]);
            const got = applyTransform(both, x, y);
            expect(got[0]).toBeCloseTo(expected[0], 9);
            expect(got[1]).toBeCloseTo(expected[1], 9);
        }
    });

    test("a degenerate transform inverts to null rather than infinities", () => {
        expect(invertTransform({A: [0, 0], B: [1, 2]})).toBeNull();
    });
});

describe("StarMatch robust fit", () => {
    const cleanPairs = (truth, n, seed) => {
        const P = [], Q = [];
        const rnd = mulberry32(seed);
        for (let i = 0; i < n; i++) {
            const p = [rnd() * 400, rnd() * 300];
            P.push(p);
            Q.push(applyTransform(truth, p[0], p[1]));
        }
        return {P, Q};
    };

    test("recovers a known rotation and translation exactly", () => {
        const truth = rigid(0.05, 7, -4);
        const {P, Q} = cleanPairs(truth, 20, 3);
        const fit = fitSimilarity(P, Q);
        expect(fit.A[0]).toBeCloseTo(truth.A[0], 6);
        expect(fit.A[1]).toBeCloseTo(truth.A[1], 6);
        expect(fit.B[0]).toBeCloseTo(truth.B[0], 4);
        expect(fit.B[1]).toBeCloseTo(truth.B[1], 4);
        expect(fit.inliers).toBe(20);
    });

    test("no scale degree of freedom exists, and the fit says so rather than faking it", () => {
        // Stars are at infinity, so only camera ROTATION moves them; a fixed-zoom camera cannot
        // change their spacing. Given data that genuinely IS scaled, the constrained model has no
        // way to represent it - and the right answer is to report no consensus, not to hand back
        // a confident-looking transform that fits nothing.
        const scaled = {A: [1.08, 0], B: [0, 0]};
        const {P, Q} = cleanPairs(scaled, 20, 5);
        expect(fitSimilarity(P, Q)).toBeNull();

        // On rigid data the returned modulus is exactly 1, to machine precision - the constraint
        // is applied in the solve, not trimmed afterwards.
        const r = cleanPairs(rigid(0.03, 5, -2), 20, 5);
        expect(Math.hypot(...fitSimilarity(r.P, r.Q).A)).toBeCloseTo(1.0, 12);
    });

    test("allowScale opts back into the four-parameter similarity", () => {
        const scaled = {A: [1.02, 0.05], B: [7, -4]};
        const {P, Q} = cleanPairs(scaled, 20, 3);
        const fit = fitSimilarity(P, Q, {allowScale: true});
        expect(fit.A[0]).toBeCloseTo(scaled.A[0], 6);
        expect(fit.A[1]).toBeCloseTo(scaled.A[1], 6);
    });

    test("rejects gross outliers instead of averaging them in", () => {
        // A third of the pairs are wrong - what a mis-association burst looks like. Plain least
        // squares would be dragged well off; trimming must ignore them entirely.
        const truth = rigid(0, 10, 5);
        const P = [], Q = [];
        const rnd = mulberry32(9);
        for (let i = 0; i < 30; i++) {
            const p = [rnd() * 400, rnd() * 300];
            P.push(p);
            Q.push(i % 3 === 0
                ? [rnd() * 400, rnd() * 300]                     // garbage pair
                : applyTransform(truth, p[0], p[1]));
        }
        const fit = fitSimilarity(P, Q);
        expect(fit.B[0]).toBeCloseTo(10, 3);
        expect(fit.B[1]).toBeCloseTo(5, 3);
        expect(fit.n).toBe(30);
        expect(fit.inliers).toBe(20);
    });

    test("a coherent stationary cluster does not drag the fit toward zero motion", () => {
        // The contaminant robust fitting handles worst: outliers that AGREE with each other.
        // Camera-fixed artifacts all sit at zero displacement, so unlike random outliers they
        // pull consistently in one direction, and an unweighted first pass lands part-way
        // between the two populations. The median-displacement seed picks the larger population
        // outright, so the trimming starts on the moving stars rather than between them.
        const truth = rigid(0, 3.0, -2.0);
        const P = [], Q = [];
        const rnd = mulberry32(17);
        for (let i = 0; i < 24; i++) {
            const p = [rnd() * 300, rnd() * 200];
            P.push(p);
            Q.push(applyTransform(truth, p[0], p[1]));
        }
        for (let i = 0; i < 7; i++) {                            // 7 of 31 stand still
            const p = [rnd() * 300, rnd() * 200];
            P.push(p); Q.push([p[0], p[1]]);
        }
        const fit = fitSimilarity(P, Q);
        expect(fit.B[0]).toBeCloseTo(3.0, 1);
        expect(fit.B[1]).toBeCloseTo(-2.0, 1);
    });

    test("reported inliers are honest, and unbiased once the trimming settles", () => {
        // Trimming leaves a transform and an inlier set that must agree with each other. Fitting
        // once and then counting the mask is not enough: refitting moves the model, which can move
        // the mask, and counting the moved mask without refitting again leaves the same
        // inconsistency one step further on - measured at 0.36 px between the returned transform
        // and the true optimum for the inliers it reports. Composed across hundreds of frames,
        // that is exactly the systematic error the whole trimming exercise is meant to remove.
        //
        // Seeds deliberately include pairs scattered near the inlier boundary, since that is when
        // a refit changes its own membership.
        for (let seed = 1; seed <= 60; seed++) {
            const rnd = mulberry32(seed);
            const truth = rigid(0.02, 6, -3);
            const P = [], Q = [];
            for (let i = 0; i < 18; i++) {
                const p = [rnd() * 400, rnd() * 300];
                P.push(p);
                const e = applyTransform(truth, p[0], p[1]);
                const k = (i % 5 === 0) ? 2.2 : 0.35;         // some pairs near the boundary
                Q.push([e[0] + (rnd() - 0.5) * k * 2, e[1] + (rnd() - 0.5) * k * 2]);
            }
            // Deliberately starve the iteration as well as running it normally. A capped loop
            // cannot promise a fixed point - a 37-pair sample needs eight passes where six were
            // allowed - so the guarantee has to hold whether or not the mask settled.
            // Includes the starved paths - finalRefits 0 skips the settling loop entirely - so
            // the reported semantics have to hold there too, not only after a full run.
            for (const finalRefits of [0, 1, 2, STAR_MATCH_DEFAULTS.finalRefits]) {
                const fit = fitSimilarity(P, Q, {finalRefits});
                if (!fit) continue;
                const T = {A: fit.A, B: fit.B};

                // (b) HONEST MEMBERSHIP, required unconditionally: every pair reported as an
                // inlier really is within the threshold of the returned transform, and every pair
                // excluded really is outside it. Downstream strength checks gate on this count,
                // so an inflated one overstates how well a frame is supported.
                let counted = 0;
                for (let i = 0; i < P.length; i++) {
                    const e = applyTransform(T, P[i][0], P[i][1]);
                    const inside = (e[0] - Q[i][0]) ** 2 + (e[1] - Q[i][1]) ** 2 < 1.2 * 1.2;
                    expect(inside).toBe(!!fit.inlierMask[i]);
                    if (inside) counted++;
                }
                expect(counted).toBe(fit.inliers);

                // (a) NO BIAS FROM REJECTED PAIRS: at a fixed point the transform is also the
                // least-squares fit of exactly that set. Only claimed when converged, because
                // outside a fixed point the two properties cannot both hold.
                if (fit.converged) {
                    const sel = [];
                    for (let i = 0; i < P.length; i++) if (fit.inlierMask[i]) sel.push(i);
                    const again = fitSimilarity(sel.map((i) => P[i]), sel.map((i) => Q[i]));
                    expect(cornerDisagreement(T, {A: again.A, B: again.B}, 400, 300)).toBeLessThan(1e-6);
                }
            }
        }
    });

    test("returns null rather than a meaningless fit when given too few points", () => {
        expect(fitSimilarity([[0, 0], [1, 1]], [[0, 0], [1, 1]])).toBeNull();
    });
});

describe("StarMatch camera-fixed artifacts", () => {
    test("finds sources that hold their pixel position while the field moves", () => {
        const frames = 12;
        const perFrame = [];
        const rnd = mulberry32(31);
        const stars = [];
        for (let i = 0; i < 10; i++) stars.push([rnd() * 300, rnd() * 180]);
        const hot = [[40, 40], [200, 100], [120, 160]];
        for (let f = 0; f < frames; f++) {
            const list = stars.map(([x, y]) => ({x: x + 2.5 * f, y: y - 1.5 * f, flux: 500}));
            for (const [x, y] of hot) list.push({x, y, flux: 500});
            perFrame.push(list);
        }
        const {fixed, applied} = findCameraFixed(perFrame);
        expect(applied).toBe(true);
        // Exactly the three hot pixels, which were appended last in every frame.
        for (let f = 0; f < frames; f++) {
            expect([...fixed[f]].sort((a, b) => a - b)).toEqual([10, 11, 12]);
        }
    });

    test("a stationary camera does not have its entire star field stripped", () => {
        // Every star holds its pixel position when the camera is still. Treating them all as
        // artifacts would delete the field we are trying to track.
        const perFrame = [];
        const rnd = mulberry32(41);
        const stars = [];
        for (let i = 0; i < 12; i++) stars.push([rnd() * 300, rnd() * 180]);
        for (let f = 0; f < 12; f++) perFrame.push(stars.map(([x, y]) => ({x, y, flux: 500})));

        const {fixed, applied} = findCameraFixed(perFrame);
        expect(applied).toBe(false);
        for (const s of fixed) expect(s.size).toBe(0);
    });
});

describe("StarMatch prediction", () => {
    test("each source is matched at most once", () => {
        // Assigning every source its own nearest partner independently lets several claim the
        // same one, quietly feeding duplicate pairs into the fit.
        const scene = buildScene({width: W, height: H, frames: 2, seed: 77});
        const det = detectClip(scene);
        const m = matchByPrediction(det[0], det[1], null, {});
        const froms = m.pairs.map((p) => p[0]);
        const tos = m.pairs.map((p) => p[1]);
        expect(new Set(froms).size).toBe(froms.length);
        expect(new Set(tos).size).toBe(tos.length);
    });

    test("refining beats a single wide-gated pass", () => {
        // The measured failure on the real clip: a wide gate with no refinement pairs stars with
        // the wrong neighbours and pulls the estimate toward no motion at all.
        const truth = rigid(0.01, 6.0, -4.0);
        const rnd = mulberry32(63);
        const prev = [], cur = [];
        for (let i = 0; i < 25; i++) {
            const p = {x: rnd() * 300, y: rnd() * 180, flux: 200 + rnd() * 800};
            prev.push(p);
            const [x, y] = applyTransform(truth, p.x, p.y);
            cur.push({x, y, flux: p.flux});
        }
        const refined = matchByPrediction(prev, cur, null, {});
        const single = matchByPrediction(prev, cur, IDENTITY, {matchRounds: 1, gateInitial: 25});
        expect(cornerDisagreement(refined.transform, truth)).toBeLessThan(0.05);
        expect(cornerDisagreement(refined.transform, truth))
            .toBeLessThanOrEqual(cornerDisagreement(single.transform, truth));
    });
});

describe("StarMatch triangle invariants", () => {
    test("matches a rotated, scaled and translated field with no prior estimate", () => {
        // The property that makes this usable for bootstrap and re-acquisition: it needs no
        // prediction, however large the motion. Scale is included here because the DESCRIPTORS
        // are scale-invariant even though the camera itself cannot zoom.
        const rnd = mulberry32(2024);
        const a = [];
        for (let i = 0; i < 18; i++) a.push({x: rnd() * 500, y: rnd() * 400, flux: 100 + rnd() * 900});

        const truth = {A: [0.82 * Math.cos(0.6), 0.82 * Math.sin(0.6)], B: [180, -95]};
        const b = a.map((s) => {
            const [x, y] = applyTransform(truth, s.x, s.y);
            return {x, y, flux: s.flux};
        });
        for (let i = b.length - 1; i > 0; i--) {          // shuffle: index order carries nothing
            const j = Math.floor(rnd() * (i + 1));
            [b[i], b[j]] = [b[j], b[i]];
        }

        const pairs = triangleMatch(a, b);
        expect(pairs.length).toBeGreaterThanOrEqual(6);
        for (const [i, j] of pairs) {
            const [ex, ey] = applyTransform(truth, a[i].x, a[i].y);
            expect(Math.hypot(b[j].x - ex, b[j].y - ey)).toBeLessThan(1e-6);
        }
    });

    test("recovers a large motion that would defeat a gated match", () => {
        const rnd = mulberry32(1234);
        const a = [];
        for (let i = 0; i < 20; i++) a.push({x: rnd() * 600, y: rnd() * 400, flux: 100 + rnd() * 900});
        const truth = rigid(0.35, 220, 140);
        const b = a.map((s) => {
            const [x, y] = applyTransform(truth, s.x, s.y);
            return {x, y, flux: s.flux};
        });

        const m = matchByInvariants(a, b);
        expect(m).not.toBeNull();
        expect(cornerDisagreement(m.transform, truth, 600, 400)).toBeLessThan(0.01);

        // A gated predicted match cannot do this - the motion is far outside any sane gate.
        const gated = matchByPrediction(a, b, IDENTITY, {});
        const gatedErr = gated ? cornerDisagreement(gated.transform, truth, 600, 400) : Infinity;
        expect(gatedErr).toBeGreaterThan(10);
    });
});

describe("StarMatch guards against inventing motion", () => {
    test("unrelated fields do not produce an invariant match", () => {
        // Triangle descriptors are only two numbers, so two independent star fields still throw up
        // a dozen coincidental correspondences. Fitting them yields a confident-looking transform
        // describing a large camera motion that never happened - which is how a scene cut or a
        // dropout turns into invented motion. The fit must be corroborated before it is believed.
        const rnd = mulberry32(555);
        const a = [], b = [];
        for (let i = 0; i < 20; i++) {
            a.push({x: rnd() * 300, y: rnd() * 200, flux: 100 + rnd() * 900});
            b.push({x: rnd() * 300, y: rnd() * 200, flux: 100 + rnd() * 900});
        }
        // There ARE coincidental correspondences - this is not a case of finding nothing.
        expect(triangleMatch(a, b).length).toBeGreaterThan(3);
        expect(matchByInvariants(a, b)).toBeNull();
    });

    test("a stationary camera keeps its stars even when transients are present", () => {
        // The ambiguity that no fraction-of-detections rule can resolve: with a still camera a
        // star and a hot pixel look identical. Eight persistent stars among eleven detections is
        // 73%, which slips under a "nearly everything is fixed, so the camera must be still"
        // threshold - and the real field would be deleted. solveFrameChain therefore establishes
        // whether the camera moves BEFORE asking what is camera-fixed.
        const rnd = mulberry32(88);
        const stars = [];
        for (let i = 0; i < 8; i++) stars.push([rnd() * 300, rnd() * 180]);
        const perFrame = [];
        for (let f = 0; f < 12; f++) {
            const list = stars.map(([x, y]) => ({x, y, flux: 500}));
            for (let t = 0; t < 3; t++) {                 // transient noise detections
                list.push({x: rnd() * 300, y: rnd() * 180, flux: 120});
            }
            perFrame.push(list);
        }
        const {cameraFixed} = solveFrameChain(perFrame);
        expect(cameraFixed.applied).toBe(false);
    });

    test("one blank frame does not switch artifact removal off for the whole clip", () => {
        // Judging on the worst frame rather than the typical one let a single empty frame disable
        // removal everywhere, leaving hot pixels to corrupt all the others.
        const rnd = mulberry32(99);
        const stars = [];
        for (let i = 0; i < 12; i++) stars.push([rnd() * 300, rnd() * 180]);
        const hot = [[40, 40], [200, 100], [120, 160]];
        const perFrame = [];
        for (let f = 0; f < 14; f++) {
            if (f === 7) { perFrame.push([]); continue; }        // blank frame
            const list = stars.map(([x, y]) => ({x: x + 3 * f, y: y - 2 * f, flux: 500}));
            for (const [x, y] of hot) list.push({x, y, flux: 500});
            perFrame.push(list);
        }
        const {cameraFixed} = solveFrameChain(perFrame);
        expect(cameraFixed.applied).toBe(true);
        expect(cameraFixed.clusters.length).toBe(3);
    });

    test("motion across a failed frame is recovered, not silently lost", () => {
        // The subtle version of a dropout. Frame 5 is too sparse to solve, so cumulative[5] is a
        // HELD copy of frame 4's transform - it asserts the camera stood still. Frame 6 can then
        // usually still be matched against frame 5's few detections well enough to produce a
        // small step, and composing that onto the stale base bakes the lost motion in for good.
        // Every later frame inherits the error while each individual adjacent fit looks fine.
        //
        // Frame 5 holds four stars at frame SIX's positions - a stale or mis-decoded frame. The
        // exact geometry matters, and a simpler "empty frame" would prove nothing:
        //   - 4 -> 5 cannot match (the points sit a frame's motion away from where predicted),
        //     so frame 5 fails and cumulative[5] becomes a held copy of frame 4's transform.
        //   - 5 -> 6 matches those four points PERFECTLY, at zero displacement.
        // So the step into frame 6 is non-null, and a bridge that only fires when the adjacent
        // match returns null never runs. Composing that zero-motion step onto the stale base
        // silently swallows both frames of motion across the gap, permanently.
        //
        // Verified to discriminate: with the bridge as a fallback rather than a preference, this
        // scenario recovers tx = 108 instead of 132 - exactly the 24 px the gap contained.
        const rnd = mulberry32(4321);
        const stars = [];
        for (let i = 0; i < 22; i++) stars.push([rnd() * 260, rnd() * 150]);
        const step = 12;
        const at = (f) => stars.map(([x, y]) => ({x: x + step * f, y: y + 0.5 * step * f, flux: 500}));

        const perFrame = [];
        for (let f = 0; f < 12; f++) perFrame.push(f === 5 ? at(6).slice(0, 4) : at(f));

        const r = solveFrameChain(perFrame, {excludeCameraFixed: false});

        // Frame 6 must be measured against frame 4 - the last frame whose position is trusted -
        // rather than against the corrupt frame 5.
        expect(r.steps[6]).not.toBeNull();
        expect(r.steps[6].base).toBe(4);

        // And the motion across the gap survives: eleven frames of it, not nine.
        const p = transformParams(r.cumulative[11]);
        expect(p.tx).toBeCloseTo(step * 11, 0);
        expect(p.ty).toBeCloseTo(0.5 * step * 11, 0);
    });

    test("a step after a failed frame is never anchored to it, however well it fits", () => {
        // The other half of the anchoring rule: what happens when NO bridge can be formed.
        //
        // cumulative[f-1] after a failure is a held copy, so any step measured against frame f-1
        // gives a wrong absolute position however tightly it fits - inlier count is simply the
        // wrong question to ask. Keeping the adjacent match "because there was no alternative"
        // hides the gap inside a chain that reports no failures. Refusing to anchor leaves it
        // visible in `failed` instead.
        //
        // Getting this scenario right is fiddly, and the obvious constructions do NOT exercise it:
        //   - a frame with too few points produces no adjacent match either, so even a
        //     last-resort bridge fires and the preference is never tested;
        //   - a frame carrying the whole field just looks like a camera jump, and invariant
        //     re-acquisition legitimately rescues it, so nothing fails at all;
        //   - simply disabling invariants makes EVERY frame fail once the motion exceeds the
        //     initial gate, and the assertions then pass without a surviving step existing.
        //
        // What is needed is a frame that fails BACKWARD while still matching FORWARD. Two disjoint
        // star groups do it: group A is visible except at frame 5, group B only at frames 5 and 6.
        //   - 4 -> 5 sees entirely different stars, so it fails and cumulative[5] is held.
        //   - 5 -> 6 sees group B one frame apart, so it matches and survives.
        //   - 4 -> 6 is two frames of motion with no prediction, outside the initial gate, and
        //     with invariants off there is no bridge.
        // The adjacent step therefore exists and is well supported, and must still be refused.
        const rnd = mulberry32(2718);
        const groupA = [], groupB = [];
        for (let i = 0; i < 18; i++) groupA.push([rnd() * 260, rnd() * 150]);
        for (let i = 0; i < 8; i++) groupB.push([rnd() * 260 + 400, rnd() * 150 + 300]);
        const step = 8;      // adjacent motion inside the gate, two frames of it outside
        const move = (list, f) => list.map(([x, y]) =>
            ({x: x + step * f, y: y + 0.5 * step * f, flux: 500}));

        const perFrame = [];
        for (let f = 0; f < 10; f++) {
            if (f === 5) perFrame.push(move(groupB, f));
            else if (f === 6) perFrame.push([...move(groupA, f), ...move(groupB, f)]);
            else perFrame.push(move(groupA, f));
        }

        const r = solveFrameChain(perFrame, {
            excludeCameraFixed: false,
            invariantMinInliers: 1e9,     // no invariant re-acquisition, so no bridge can form
        });

        // The scenario must really be the one described, or the assertions below prove nothing.
        expect(r.failed).toContain(5);
        expect(matchByPrediction(perFrame[5], perFrame[6], null, {})).not.toBeNull();

        // ...and the well-supported adjacent step into frame 6 must nonetheless be refused,
        // because frame 5's own position was never established.
        expect(r.failed).toContain(6);

        // The invariant that must hold whatever the data.
        const failedSet = new Set(r.failed);
        for (let f = 1; f < perFrame.length; f++) {
            if (r.steps[f]) expect(failedSet.has(r.steps[f].base)).toBe(false);
        }
    });

    test("a re-acquisition that is then discarded is not reported as one", () => {
        // The bookkeeping hole: the adjacent match is rescued by invariants (so the frame gets
        // recorded as re-acquired), then discarded for resting on a stale anchor - leaving the
        // frame listed as BOTH failed and reacquired.
        //
        // Reaching it needs the invariant rescue to succeed and the bridge to be impossible.
        // Frame 0 carries only two detections, so it can never serve as a bridge anchor, and it
        // stays `lastGood` because frame 1 cannot be solved against it. Motion of 40 px/frame then
        // puts every adjacent pair outside the prediction gate, so from frame 2 on the adjacent
        // match exists ONLY via invariants - which is exactly the branch that records the
        // re-acquisition before the anchor check throws the step away.
        const rnd = mulberry32(31337);
        const stars = [];
        for (let i = 0; i < 20; i++) stars.push([rnd() * 400, rnd() * 260]);
        const at = (f) => stars.map(([x, y]) => ({x: x + 40 * f, y: y + 18 * f, flux: 500}));

        const perFrame = [];
        for (let f = 0; f < 8; f++) perFrame.push(f === 0 ? at(0).slice(0, 2) : at(f));

        const r = solveFrameChain(perFrame, {excludeCameraFixed: false});

        // The scenario must genuinely produce failures, or there is nothing to check.
        expect(r.failed.length).toBeGreaterThan(0);
        // ...and no frame may appear in both lists.
        for (const f of r.failed) expect(r.reacquired).not.toContain(f);
    });

    test("an unconverged fit is never trusted, however many inliers it reports", () => {
        // Outside a fixed point only the HONESTY of the inlier set survives - the transform is
        // fitted to a neighbouring mask, so pairs the trimming rejected still pull on it. Inlier
        // count cannot see that, so an unconverged fit can look strongly supported and still be
        // biased. Composing it as trusted motion accumulates exactly the drift trimming exists to
        // remove.
        //
        // Forced here by starving the settling loop to a single pass on a field scattered around
        // the inlier boundary, which is when the mask really does keep moving.
        const rnd = mulberry32(1);
        const stars = [];
        for (let i = 0; i < 34; i++) stars.push([rnd() * 300, rnd() * 180]);
        const perFrame = [];
        for (let f = 0; f < 10; f++) {
            perFrame.push(stars.map(([x, y], i) => {
                const k = (i % 3 === 0) ? 1.15 : 0.4;     // a third of the field on the boundary
                return {
                    x: x + 3 * f + (rnd() - 0.5) * k * 2,
                    y: y - 2 * f + (rnd() - 0.5) * k * 2,
                    flux: 500,
                };
            }));
        }
        const starved = solveFrameChain(perFrame, {excludeCameraFixed: false, finalRefits: 1});

        // The scenario must actually produce unconverged fits, or this proves nothing.
        const unconverged = starved.steps.filter((s) => s && !s.fit.converged);
        expect(unconverged.length).toBeGreaterThan(0);

        // Every unconverged step is recorded as weak rather than passing as sound...
        for (let f = 1; f < perFrame.length; f++) {
            const s = starved.steps[f];
            if (s && !s.fit.converged) expect(starved.weakFrames).toContain(f);
        }
        // ...despite reporting plenty of inliers, which is the point: the count cannot see the
        // bias, so it cannot be the thing that decides whether a step is trustworthy.
        expect(Math.max(...unconverged.map((s) => s.fit.inliers))).toBeGreaterThan(20);

        // Given the real settling budget the same clip converges throughout, so the guard costs
        // nothing in practice - it only refuses to trust fits that genuinely did not settle.
        const full = solveFrameChain(perFrame, {excludeCameraFixed: false});
        expect(full.steps.filter((s) => s && !s.fit.converged).length).toBe(0);
    });

    test("an empty clip returns empty frame-aligned arrays", () => {
        const r = solveFrameChain([]);
        expect(r.cumulative).toEqual([]);
        expect(r.steps).toEqual([]);
        expect(r.failed).toEqual([]);
    });

    test("a weak fit is reported rather than blended silently into the chain", () => {
        // A fit can be accepted while still being poorly supported, when re-acquisition is
        // unavailable or no better. Accumulating it beats holding still, but a chain that reports
        // no problems while resting on three inliers is worse than one that says so.
        // A COHERENT field - the same stars each frame, moving with the camera - with one frame
        // where all but a handful are missing. That step still solves, but on too little
        // evidence to be called reliable.
        const rnd = mulberry32(123);
        const stars = [];
        for (let i = 0; i < 20; i++) stars.push([rnd() * 300, rnd() * 180]);
        const perFrame = [];
        for (let f = 0; f < 10; f++) {
            const visible = f === 5 ? stars.slice(0, 4) : stars;  // one badly starved frame
            perFrame.push(visible.map(([x, y]) => ({x: x + 2 * f, y: y - 1.5 * f, flux: 500})));
        }
        const r = solveFrameChain(perFrame, {excludeCameraFixed: false});
        expect(r.failed.length).toBe(0);
        expect(r.weakFrames).toContain(5);
    });
});

describe("StarMatch whole-clip solve", () => {
    test("recovers the camera path over a clip, against the rendered truth", () => {
        const scene = buildScene({width: W, height: H, frames: 20, seed: 808, ...DENSE});
        const det = detectClip(scene);
        const {cumulative, failed} = solveFrameChain(det);
        expect(failed.length).toBe(0);

        const inv0 = invertTransform(scene.transforms[0]);
        let worst = 0;
        for (let f = 1; f < scene.params.frames; f++) {
            const truth = composeTransform(scene.transforms[f], inv0);
            worst = Math.max(worst, cornerDisagreement(cumulative[f], truth));
        }
        // At this density the chain tracks to a fraction of a pixel over twenty frames. It
        // still drifts over longer runs - measured at 3.3% cumulative scale error across the
        // real clip's 179-frame window - which is why Stage 3 refines globally rather than
        // trusting the chain.
        expect(worst).toBeLessThan(1.0);
    });

    test("the recovered motion matches the commanded motion, through hot pixels and a mover", () => {
        // Both confounders present. Hot pixels are the dangerous one: they are a coherent
        // zero-displacement cluster, and with a free scale parameter the fit reconciles them
        // against the moving stars by scaling, losing up to 41% of the true motion.
        const scene = buildScene({
            width: W, height: H, frames: 20, seed: 404,
            panX: -1.5, panY: 2.0, rollDegPerFrame: 0, jitterSigma: 0,
            laser: false, hotPixels: 6, movingObject: true, ...DENSE,
        });
        const det = detectClip(scene);
        const {cumulative, cameraFixed} = solveFrameChain(det);
        const p = transformParams(cumulative[19]);

        expect(cameraFixed.applied).toBe(true);
        expect(p.tx).toBeCloseTo(-1.5 * 19, 0);
        expect(p.ty).toBeCloseTo(2.0 * 19, 0);
        // Fixed zoom, and the model has no scale freedom to misuse.
        expect(p.scale).toBeCloseTo(1.0, 6);
    });

    test("recovers roll as well as translation", () => {
        // Translation-only would sail through a pan test while being wrong about the real clip,
        // which rolls ~2 degrees across the analysed window.
        const scene = buildScene({
            width: W, height: H, frames: 20, seed: 606,
            panX: 0.4, panY: -0.6, rollDegPerFrame: 0.08, jitterSigma: 0,
            laser: false, hotPixels: 0, ...DENSE,
        });
        const det = detectClip(scene);
        const {cumulative} = solveFrameChain(det);
        const p = transformParams(cumulative[19]);
        expect(p.rotation * 180 / Math.PI).toBeCloseTo(0.08 * 19, 1);
    });

    test("a frame with no usable detections does not corrupt the rest of the chain", () => {
        // A dropout must hold the last transform rather than invent motion, and the chain must
        // recover afterwards instead of staying broken.
        const scene = buildScene({width: W, height: H, frames: 16, seed: 909, laser: false, ...DENSE});
        const det = detectClip(scene);
        det[8] = [];                                    // simulate a blank/undecoded frame

        const {cumulative, failed} = solveFrameChain(det);
        expect(failed).toContain(8);

        const inv0 = invertTransform(scene.transforms[0]);
        const truthLast = composeTransform(scene.transforms[15], inv0);
        // One dropped frame costs roughly one frame of motion, not the whole path.
        expect(cornerDisagreement(cumulative[15], truthLast)).toBeLessThan(10);
    });
});

// Modelled on the real failure that motivated offset voting: a camera jerk blurs a couple of
// frames, the blur scrambles which sources are brightest (bright stars smear and fragment, faint
// ones vanish, new artifacts flare), and on the far side the field sits tens of pixels from where
// prediction can reach. Triangle invariants pick vertices by brightness rank, so the scramble
// starves them; the old chain then retried its one bridge anchor forever and stayed broken for
// the remaining 197 frames of a real clip. Each test pins one link of the repaired behavior, and
// the "control" runs (mechanism disabled via options) re-create the old code's outcome so the
// failure these tests guard against stays machine-checked.
describe("StarMatch offset-vote re-acquisition", () => {
    test("re-acquires a large offset through a scrambled brightness ranking", () => {
        const rnd = mulberry32(42);
        const field = Array.from({length: 30}, () => ({
            x: 40 + rnd() * 1180, y: 40 + rnd() * 620, flux: 200 + rnd() * 5000, area: 6,
        }));
        const prev = field.map((s) => ({...s}));
        // After the "blur": shifted (-5, -44); the 8 brightest sources gone, 8 new bright
        // impostors elsewhere, and every surviving flux re-drawn (ranking destroyed).
        const byFlux = [...field].sort((a, b) => b.flux - a.flux);
        const gone = new Set(byFlux.slice(0, 8));
        const rnd2 = mulberry32(77);
        const cur = field.filter((s) => !gone.has(s)).map((s) => ({
            x: s.x - 5, y: s.y - 44, flux: 200 + rnd2() * 800, area: 6,
        })).filter((s) => s.x > 0 && s.y > 0);
        for (let i = 0; i < 8; i++) {
            cur.push({x: 30 + rnd2() * 1200, y: 30 + rnd2() * 650, flux: 4000 + rnd2() * 4000, area: 9});
        }

        // The premise: neither existing matcher can register this pair. If either ever starts
        // succeeding here, offset voting's role has changed and this file should say so.
        expect(matchByInvariants(prev, cur)).toBeNull();
        expect(matchByPrediction(prev, cur, null)).toBeNull();

        const m = matchByOffsetVote(prev, cur);
        expect(m).not.toBeNull();
        expect(m.transform.B[0]).toBeCloseTo(-5, 1);
        expect(m.transform.B[1]).toBeCloseTo(-44, 1);
        expect(m.fit.inliers).toBeGreaterThanOrEqual(15);
    });

    test("refuses two unrelated star fields", () => {
        // The corroboration gate is what separates a histogram peak from evidence. Unrelated
        // dense fields still produce a best bin; composing it would invent camera motion.
        const ra = mulberry32(1), rb = mulberry32(2);
        const A = Array.from({length: 28}, () => ({x: 20 + ra() * 1200, y: 20 + ra() * 680, flux: 100 + ra() * 3000, area: 6}));
        const B = Array.from({length: 28}, () => ({x: 20 + rb() * 1200, y: 20 + rb() * 680, flux: 100 + rb() * 3000, area: 6}));
        expect(matchByOffsetVote(A, B)).toBeNull();
    });

    test("bridges a blur outage with a jerk that the old chain never recovered from", () => {
        const rnd = mulberry32(9);
        const stars = Array.from({length: 26}, () => ({
            x: 60 + rnd() * 1140, y: 60 + rnd() * 600, flux: 200 + rnd() * 4000,
        }));
        const rnd2 = mulberry32(31);
        const postFlux = stars.map(() => 150 + rnd2() * 900);
        const offsetAt = (f) => (f <= 9
            ? [1.5 * f, -0.8 * f]
            : [1.5 * f + 4, -0.8 * f - 40]);       // (+4, -40) jerk accumulated in the blur
        const bright = new Set([...stars.keys()].sort((a, b) => stars[b].flux - stars[a].flux).slice(0, 7));
        const frames = [];
        for (let f = 0; f < 20; f++) {
            if (f === 10 || f === 11) {
                frames.push(Array.from({length: 6}, () => ({x: rnd2() * 1276, y: rnd2() * 720, flux: 500, area: 20})));
                continue;
            }
            const [ox, oy] = offsetAt(f);
            let dets = stars.map((s, i) => ({x: s.x + ox, y: s.y + oy, flux: f <= 9 ? s.flux : postFlux[i], area: 6, i}));
            if (f >= 10) {
                dets = dets.filter((d) => !bright.has(d.i));
                for (let k = 0; k < 7; k++) {
                    dets.push({x: 50 + rnd2() * 1150, y: 50 + rnd2() * 620, flux: 5000 + rnd2() * 3000, area: 9, i: -1});
                }
            }
            frames.push(dets
                .filter((d) => d.x > 0 && d.x < 1276 && d.y > 0 && d.y < 720)
                .map(({i, ...d}) => d));
        }

        // Control: offset voting disabled reproduces the old behavior - the outage is permanent.
        const control = solveFrameChain(frames, {excludeCameraFixed: false, offsetVoteMinVotes: Infinity});
        expect(control.failed).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);

        // Fixed: only the genuinely unmatchable blur frames fail, and the registration on the
        // far side of the gap carries the full jerk.
        const {cumulative, failed} = solveFrameChain(frames, {excludeCameraFixed: false});
        expect(failed).toEqual([10, 11]);
        const [ex, ey] = offsetAt(19);
        const got = applyTransform(cumulative[19], 100, 100);
        expect(got[0]).toBeCloseTo(100 + ex, 0);
        expect(got[1]).toBeCloseTo(100 + ey, 0);
    });

    test("bridging tries a pool of recent strong anchors, not only the last accepted frame", () => {
        // The frame at the edge of an outage is the tail of the blur that caused it: here six
        // smeared centroids that fit weakly enough to be ACCEPTED (becoming lastGood) while
        // making a hopeless re-acquisition pattern. Anchoring every bridge retry there is what
        // turned a 2-frame gap into a permanent outage on the real clip.
        const rnd = mulberry32(5);
        const stars = Array.from({length: 24}, () => ({x: 80 + rnd() * 1100, y: 80 + rnd() * 560, flux: 200 + rnd() * 4000}));
        const rnd2 = mulberry32(105);
        const frames = [];
        for (let f = 0; f < 18; f++) {
            const jerked = f >= 12;
            const ox = 2 * f + (jerked ? 3 : 0);
            const oy = jerked ? -42 : 0;
            if (f === 9) {
                frames.push(stars.slice(0, 6).map((s) => ({
                    x: s.x + ox + (rnd2() - 0.5) * 4, y: s.y + (rnd2() - 0.5) * 4, flux: s.flux, area: 12,
                })));
                continue;
            }
            if (f === 10 || f === 11) {
                frames.push(Array.from({length: 6}, () => ({x: rnd2() * 1276, y: rnd2() * 720, flux: 400, area: 18})));
                continue;
            }
            frames.push(stars.map((s) => ({x: s.x + ox, y: s.y + oy, flux: s.flux, area: 6})));
        }

        // Control: with only lastGood tried, the weak frame 9 anchors every retry and the chain
        // dies for the rest of the clip.
        const control = solveFrameChain(frames, {excludeCameraFixed: false, bridgeAnchorTries: 1});
        expect(control.failed).toEqual([10, 11, 12, 13, 14, 15, 16, 17]);

        // With the pool, a strong pre-blur frame re-anchors the far side immediately.
        const {failed, weakFrames} = solveFrameChain(frames, {excludeCameraFixed: false});
        expect(failed).toEqual([10, 11]);
        expect(weakFrames).toContain(9);
    });

    test("a weak coincidental prediction match cannot shadow a strong re-acquisition", () => {
        // A dropout followed by a shift beyond the prediction gate, plus three faint decoys
        // standing where stars stood BEFORE the shift. The gate-limited prediction match locks
        // those decoys - non-null, convergent, three inliers, wrong by the whole shift - and a
        // matcher chain that short-circuits on any non-null match composes it into the chain
        // SILENTLY (no failure recorded), which is worse than failing. The re-acquisition
        // matchers from the very same anchor see the true field at 26 inliers.
        const rnd = mulberry32(7);
        const stars = Array.from({length: 26}, () => ({
            x: 100 + rnd() * 1050, y: 100 + rnd() * 520, flux: 300 + rnd() * 4000,
        }));
        const frames = [];
        for (let f = 0; f < 12; f++) {
            const jumped = f >= 6;
            const ox = 2 * f + (jumped ? 40 : 0);
            const oy = jumped ? 18 : 0;
            if (f === 5) { frames.push([]); continue; }        // one-frame dropout
            const dets = stars.map((s) => ({x: s.x + ox, y: s.y + oy, flux: s.flux, area: 6}));
            if (jumped) {
                for (let k = 0; k < 3; k++) {
                    const s = stars[k * 7];
                    dets.push({x: s.x + 9, y: s.y + 0.5, flux: 220, area: 5});
                }
            }
            frames.push(dets);
        }

        // Control: with the re-acquisition matchers disabled, the coincidental 3-inlier match
        // is all the bridge has, and it accepts it - the chain lands ~43 px wrong with NO
        // failure recorded. This is the corruption mode the alternatives-not-chain rule stops.
        const control = solveFrameChain(frames,
            {excludeCameraFixed: false, offsetVoteMinVotes: Infinity, triangleMinVotes: Infinity});
        expect(control.failed).toEqual([5]);
        const gotC = applyTransform(control.cumulative[11], 200, 200);
        expect(Math.hypot(gotC[0] - 262, gotC[1] - 218)).toBeGreaterThan(25);

        const {cumulative, failed, steps} = solveFrameChain(frames, {excludeCameraFixed: false});
        expect(failed).toEqual([5]);
        expect(steps[6].fit.inliers).toBeGreaterThanOrEqual(20);
        const got = applyTransform(cumulative[11], 200, 200);
        expect(got[0]).toBeCloseTo(262, 0);
        expect(got[1]).toBeCloseTo(218, 0);
    });

    test("a STRONG decoy lock cannot out-vote the fuller re-acquisition", () => {
        // The harder version: the decoy cluster is big enough that the prediction match's lock
        // on it passes the strength gates outright - six stationary glints among fourteen
        // detections is 43%, clearing minInliers and minInlierFraction - so any rule of the
        // form "consult the re-acquisition matchers only when the prediction match is weak"
        // registers the frame wrong with no failure and no weak flag. All matchers always run;
        // the corroborated fit explaining MORE sources (the eight real stars, shifted) wins.
        const rnd = mulberry32(3);
        const stars = Array.from({length: 8}, () => ({
            x: 120 + rnd() * 1000, y: 120 + rnd() * 480, flux: 500 + rnd() * 4000,
        }));
        const decoys = Array.from({length: 6}, () => ({
            x: 100 + rnd() * 1050, y: 100 + rnd() * 520, flux: 300 + rnd() * 800,
        }));
        const frames = [];
        for (let f = 0; f < 12; f++) {
            const jumped = f >= 6;
            const ox = 2 * f + (jumped ? 30 : 0);
            const oy = jumped ? 12 : 0;
            const dets = stars.map((s) => ({x: s.x + ox, y: s.y + oy, flux: s.flux, area: 6}));
            // Transient glints, present only around the jump - too brief for the camera-fixed
            // stripper's persistence rule, exactly the contaminant that reaches the matcher.
            if (f >= 4 && f <= 8) {
                for (const d of decoys) dets.push({x: d.x, y: d.y, flux: d.flux, area: 5});
            }
            frames.push(dets);
        }

        // Control: re-acquisition matchers disabled. The strong decoy lock is accepted and the
        // chain lands ~37 px wrong - silently: nothing failed, nothing flagged weak.
        const control = solveFrameChain(frames,
            {excludeCameraFixed: false, offsetVoteMinVotes: Infinity, triangleMinVotes: Infinity});
        expect(control.failed).toEqual([]);
        const gotC = applyTransform(control.cumulative[11], 200, 200);
        expect(Math.hypot(gotC[0] - 252, gotC[1] - 212)).toBeGreaterThan(25);

        // Fixed: the jump step is carried by the eight-star recovery (small residual error is
        // the mixed-fit bias while the transient decoys are on screen, not a registration miss).
        const {cumulative, failed, steps, weakFrames} = solveFrameChain(frames, {excludeCameraFixed: false});
        expect(failed).toEqual([]);
        expect(steps[6].fit.inliers).toBeGreaterThanOrEqual(8);
        const got = applyTransform(cumulative[11], 200, 200);
        expect(Math.hypot(got[0] - 252, got[1] - 212)).toBeLessThan(6);
        // Two corroborated interpretations disagreed at the jump - the arbitration must be
        // VISIBLE: a frame whose strong prediction fit was displaced is reported weak
        // (contested), never passed off as uncontested registration.
        expect(weakFrames).toContain(6);
    });
});
