// Lens self-calibration against a real clip whose optical axis is KNOWN.
//
// Every other calibration test either builds a synthetic scene (so truth is whatever the
// generator was told to use) or measures self-consistency on real data (which a wrong lens with
// compensating rotations can satisfy). This file is the one case with an independently measured
// answer: the clip is a CROP of a larger frame, and the uncropped frame's centre - which is where
// the optical axis is - lands at a known place inside the crop.
//
//   ?custom=99999999/Cropped Starlink Timelapse/20260802_212450.js
//
// The crop rectangle was measured off the source photo from the overlay's brightness step, giving
// an axis at fraction (0.7446, 0.3324) of the video, i.e. (953, 239) in the 1280x720 decode
// against a frame centre of (640, 360). The fit never sees any of that.
//
// It arrived reporting 658 tracks "moving" against 283 "star" - most of the real stars called
// movers - because calibration refused outright: "no better than a rectilinear lens (rms 11.70 vs
// 11.97)". Both numbers are terrible; nothing fitted at all, and the flat 2D model was left to
// judge the motion. Three separate causes, each fixed and each pinned below.

import fs from "fs";
import path from "path";
import {calibrateLens, chooseBaseline, scanLens, scanPrincipal} from "../src/starTrack/StarCalibrate";
import {lensFOV, makeLens, lensToRay} from "../src/CameraLens";
import {fitRotationRobust, refToFrame} from "../src/starTrack/StarSphere";

const clip = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, "fixtures/croppedStarlinkClip.json"), "utf8"));
const SIZE = [clip.videoW, clip.videoH];
const TRUTH = clip.truePrincipal;                 // (953.1, 239.3), measured, not fitted
const CENTRE = [SIZE[0] / 2, SIZE[1] / 2];

const set = (f0, f1) => clip.baselines.find((b) => b.f0 === f0 && b.f1 === f1);

/** calibrateLens-shaped tracks from a stored baseline. */
function tracksFor(f0, f1) {
    const b = set(f0, f1);
    return b.A.map((a, i) => ({
        obs: [{f: f0, x: a[0], y: a[1]}, {f: f1, x: b.B[i][0], y: b.B[i][1]}],
        first: f0, last: f1,
    }));
}

/** Robust reprojection rms of a candidate lens over correspondences. */
function score(lens, A, B) {
    const fit = fitRotationRobust(lens, A, B, {});
    if (!fit?.q) return null;
    const errs = [];
    for (let i = 0; i < A.length; i++) {
        const ray = lensToRay(lens, A[i][0], A[i][1], SIZE);
        if (!ray) continue;
        const p = refToFrame({q: fit.q, s: 1}, lens, ray, SIZE);
        if (p) errs.push(Math.hypot(p[0] - B[i][0], p[1] - B[i][1]));
    }
    if (errs.length < 10) return null;
    errs.sort((a, b) => a - b);
    const keep = errs.slice(0, Math.max(10, Math.floor(0.8 * errs.length)));
    return {rms: Math.sqrt(keep.reduce((s, e) => s + e * e, 0) / keep.length),
        inliers: errs.filter((e) => e < 4).length, n: errs.length};
}

describe("the cropped clip's optical axis", () => {
    test("the fixture is the measured data we think it is", () => {
        expect(SIZE).toEqual([1280, 720]);
        expect(TRUTH[0]).toBeCloseTo(953.1, 1);
        expect(TRUTH[1]).toBeCloseTo(239.3, 1);
        // The axis is a long way off centre - that is the whole point of this clip.
        expect(Math.abs(TRUTH[0] - CENTRE[0]) / SIZE[0]).toBeGreaterThan(0.2);
        expect(set(0, 40).A).toHaveLength(342);
    });

    test("the data is fine: at the TRUE axis one rotation explains everything", () => {
        // The failure was never the correspondences. A plain pinhole at the true axis fits every
        // pair to well under a pixel; the same search at the frame centre finds nothing usable.
        const {A, B} = set(0, 80);
        const bestAt = (P) => {
            let best = null;
            for (const type of ["rectilinear", "orthographicFisheye"]) {
                for (let f = 600; f <= 2400; f += 50) {
                    const s = score(makeLens({type, focalPx: f, principal: P, refSize: SIZE,
                        source: "fitted"}), A, B);
                    if (s && (!best || s.rms < best.rms)) best = s;
                }
            }
            return best;
        };
        const atTruth = bestAt(TRUTH);
        const atCentre = bestAt(CENTRE);
        expect(atTruth.rms).toBeLessThan(1.0);
        expect(atTruth.inliers).toBe(atTruth.n);              // every correspondence
        // ...and the centred search is an order of magnitude worse, on the same data.
        expect(atCentre.rms).toBeGreaterThan(4 * atTruth.rms);
        expect(atCentre.inliers).toBeLessThan(0.5 * atCentre.n);
    });

    test("chooseBaseline weighs evidence, not just width", () => {
        // It used to return the FIRST baseline clearing minPairs, walking widest-inwards, which on
        // this clip meant 31 correspondences over a 127-frame span in preference to 342 over 40
        // frames - and 31 noisy pairs put the principal point 268 px from the truth.
        // chooseBaseline only probes spans of 100/80/60/45/30% of nFrames-1, so with nFrames=101
        // the candidates are (0,100), (0,80), (0,60), (0,45), (0,30). Put the DENSE set on the
        // narrow one and a thin set on the widest, which is the shape the real clip has.
        const b = set(0, 40);
        const tracks = b.A.map((a, i) => ({
            obs: [{f: 0, x: a[0], y: a[1]}, {f: 30, x: b.B[i][0], y: b.B[i][1]}],
        }));
        for (let i = 0; i < 30; i++) tracks[i].obs.push({f: 100, x: b.B[i][0], y: b.B[i][1]});

        const chosen = chooseBaseline(tracks, 101, 25);
        // pairs*span prefers the dense narrow baseline (342*30 = 10260) to the thin wide one
        // (30*100 = 3000). The old rule returned the widest that merely cleared minPairs.
        expect(chosen.f1).toBe(30);
        expect(chosen.A.length).toBeGreaterThan(300);
    });

    test("a dense but barely-rotating baseline does not beat a viable wider one", () => {
        // The trap in scoring `pairs * span`: a short dense baseline can win the score and then
        // fail the ROTATION gate, and because that gate only ever sees the one chosen baseline the
        // whole clip is refused while a wider, thinner, perfectly calibratable candidate sits
        // unexamined. Rotation is therefore screened first, with a cheap nominal-lens fit.
        //
        // Built so the narrow baseline wins on score but carries almost no rotation: its B points
        // are its A points nudged by a fraction of a pixel, while the wide baseline carries the
        // clip's real motion.
        const b = set(0, 40);
        const tracks = b.A.map((a, i) => ({
            obs: [
                {f: 0, x: a[0], y: a[1]},
                {f: 30, x: a[0] + 0.02, y: a[1] + 0.02},        // dense, essentially static
            ],
        }));
        for (let i = 0; i < 40; i++) {
            tracks[i].obs.push({f: 100, x: b.B[i][0], y: b.B[i][1]});   // thin, real rotation
        }
        // Unscreened, pairs*span would take (0,30): 342*30 = 10260 against 40*100 = 4000.
        const chosen = chooseBaseline(tracks, 101, 25, {size: SIZE});
        expect(chosen.f1).toBe(100);
        expect(chosen.A.length).toBeLessThan(100);
        // Without a size to fit against there is nothing to screen on, so the score still rules -
        // that is the documented fallback, not an accident.
        expect(chooseBaseline(tracks, 101, 25).f1).toBe(30);
    });

    test("the off-centre axis is RECOVERED, not clamped or refused", async () => {
        // chooseBaseline derives frame pairs from nFrames, so nFrames = f1+1 lands its widest
        // span exactly on the captured pair.
        const r = await calibrateLens(tracksFor(0, 40), 41, SIZE);
        expect(r.accepted).toBe(true);

        const err = Math.hypot(r.lens.principal[0] - TRUTH[0], r.lens.principal[1] - TRUTH[1]);
        expect(err).toBeLessThan(40);                         // measured 7 px at the time of writing
        // Not merely "off centre in the right direction" - much closer to truth than to centre.
        const fromCentre = Math.hypot(TRUTH[0] - CENTRE[0], TRUTH[1] - CENTRE[1]);
        expect(err).toBeLessThan(0.25 * fromCentre);
        expect(r.diagnostics.principalClamped).toBe(false);
        expect(r.diagnostics.principalSearched).toBeTruthy(); // the global search did the work
        // A ~57 deg field, not the ~41 deg a wrong axis produced.
        expect(lensFOV(r.lens, SIZE).hfov).toBeGreaterThan(50);
        expect(r.diagnostics.rms).toBeLessThan(1.5);
    });

    test("the centred scan is what tells us to look, and it is decisive", () => {
        // The trigger has to be unambiguous or it would fire on ordinary clips and cost them the
        // grid search. Here the centred scan explains under half the correspondences; on an
        // uncropped clip it explains nearly all of them.
        const {A, B} = set(0, 40);
        const centred = scanLens(A, B, SIZE, {});
        expect(centred.best.within / centred.best.n).toBeLessThan(0.6);

        // The grid NOMINATES several cells rather than committing to one, because its own ranking
        // is unreliable at its coarse focal resolution - on the 0->80 baseline its top cell is the
        // grid boundary, and re-scanning only that accepted a principal point 77 px from truth.
        // The contract is that the right neighbourhood is among the nominees; the caller re-scans
        // them at full resolution and chooses.
        const seeds = scanPrincipal(A, B, SIZE, {});
        expect(Array.isArray(seeds)).toBe(true);
        expect(seeds.length).toBeGreaterThan(1);
        const near = seeds.some((s) => Math.abs(s.principal[0] - TRUTH[0]) < 0.2 * SIZE[0]
            && Math.abs(s.principal[1] - TRUTH[1]) < 0.2 * SIZE[1]);
        expect(near).toBe(true);
    });
});
