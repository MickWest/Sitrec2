// CHARACTERISATION of the drift statistic that decides "star" vs "moving".
//
// These tests exist to be READ - and deliberately converted - when the solver moves from a 2D
// similarity map to a spherical one. They pin the exact meaning of `significance`,
// `driftSignificance` and `driftMinSigmas` as shipped today, because that meaning is about to
// change and nothing else in the suite would notice.
//
// Why nothing else would notice: every other classification test scores against a synthetic
// scene with a large, unambiguous mover, so it stays correct under almost any threshold
// convention. The risk is not "the mover stops being found", it is "the thresholds silently mean
// something different and every borderline call shifts". A borderline case is the only thing that
// detects that, so these tests are built at the decision boundary on purpose.
//
// TODAY'S DEFINITION, which the tests below fix in place:
//
//   bx, by      least-squares slopes of the REFERENCE-frame residual against frame index
//   drift       hypot(bx, by)                        px per frame
//   se          sigma / sqrt(Sxx)                    standard error of ONE slope component
//   significance    drift / se   ==   drift * sqrt(Sxx) / sigma
//   totalDrift  drift * (last observed frame - first observed frame)
//
//   moving  <=>  significance > driftSignificance  AND  totalDrift > driftMinSigmas * sigma
//
// Note `significance` divides the MAGNITUDE of a two-component slope vector by the standard
// error of a SINGLE component. That is not a t-statistic despite the name, and the tuned
// threshold of 5.0 carries that construction inside it. Any replacement expressed as a proper
// 2-dof quantity has to re-derive the threshold rather than inherit the number.

import {classifyTracks} from "../src/starTrack/StarSolve";
import {mulberry32} from "../src/starTrack/StarSynthetic";

const N_FRAMES = 40;
const IDENTITY = {A: [1, 0], B: [0, 0]};
const TRANSFORMS = Array.from({length: N_FRAMES}, () => IDENTITY);

/** Sum of squared deviations of the frame indices - the abscissa spread the slope error uses. */
function sxxOf(nFrames) {
    const mean = (nFrames - 1) / 2;
    let s = 0;
    for (let f = 0; f < nFrames; f++) s += (f - mean) ** 2;
    return s;
}

/** Box-Muller on a seeded uniform, so the noise population is identical run to run. */
function gaussian(rand) {
    const u = Math.max(1e-12, rand()), v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * A population of stationary tracks (which set the noise estimate) plus optional drifting ones.
 *
 * Transforms are the identity, so reference coordinates ARE frame coordinates and the drift the
 * test commands is exactly the drift the classifier should measure. That also keeps the
 * camera-fixed path out of the way: with identity transforms rawSpan === refSpan, and the
 * artifact test needs rawSpan < 0.25 * refSpan, so it can never fire.
 */
function buildTracks({noise = 0.5, nStars = 40, drifts = [], seed = 99}) {
    const rand = mulberry32(seed);
    const tracks = [];
    for (let i = 0; i < nStars; i++) {
        const x0 = 40 + rand() * 240, y0 = 40 + rand() * 120;
        const obs = [];
        for (let f = 0; f < N_FRAMES; f++) {
            obs.push({f, x: x0 + gaussian(rand) * noise, y: y0 + gaussian(rand) * noise});
        }
        tracks.push({obs, first: 0, last: N_FRAMES - 1});
    }
    for (const d of drifts) {
        const x0 = 160, y0 = 96;
        const obs = [];
        for (let f = 0; f < N_FRAMES; f++) {
            obs.push({
                f,
                x: x0 + d.bx * f + gaussian(rand) * noise,
                y: y0 + d.by * f + gaussian(rand) * noise,
            });
        }
        tracks.push({obs, first: 0, last: N_FRAMES - 1});
    }
    // starPosition() takes the component-wise median of the back-projected observations; with
    // identity transforms that is just the median of the raw positions.
    const stars = tracks.map((t) => {
        const xs = t.obs.map((o) => o.x).sort((a, b) => a - b);
        const ys = t.obs.map((o) => o.y).sort((a, b) => a - b);
        return [xs[xs.length >> 1], ys[ys.length >> 1]];
    });
    return {tracks, stars};
}

describe("the drift statistic, as shipped", () => {
    test("significance is the drift magnitude over a ONE-component standard error", () => {
        const {tracks, stars} = buildTracks({drifts: [{bx: 0.08, by: 0.06}]});
        const out = classifyTracks(tracks, TRANSFORMS, stars);
        const rec = out[out.length - 1];
        // The identity that defines the statistic. If a rewrite changes the denominator - to a
        // proper 2-dof covariance form, say - this is the assertion that will fail, and it should.
        const expected = rec.drift * Math.sqrt(sxxOf(N_FRAMES)) / rec.sigma;
        expect(rec.significance).toBeCloseTo(expected, 9);
    });

    test("drift is the magnitude of the two per-axis least-squares slopes", () => {
        const {tracks, stars} = buildTracks({noise: 0.001, drifts: [{bx: 0.30, by: -0.40}]});
        const out = classifyTracks(tracks, TRANSFORMS, stars);
        const rec = out[out.length - 1];
        expect(rec.drift).toBeCloseTo(0.5, 3);       // hypot(0.30, 0.40)
    });

    test("totalDrift is drift times the observed frame span, not the clip length", () => {
        const {tracks, stars} = buildTracks({noise: 0.001, drifts: [{bx: 0.25, by: 0}]});
        const out = classifyTracks(tracks, TRANSFORMS, stars);
        const rec = out[out.length - 1];
        expect(rec.totalDrift).toBeCloseTo(rec.drift * (N_FRAMES - 1), 9);
    });
});

describe("the decision boundary", () => {
    // Each threshold is isolated by disabling the other, because with the shipped defaults
    // (driftSignificance 5, driftMinSigmas 12) the totalDrift condition binds far harder over a
    // 40-frame track and the significance threshold would never be the deciding one.

    test("driftSignificance is the deciding threshold when totalDrift is not binding", () => {
        const sxx = sxxOf(N_FRAMES);
        const noise = 0.5;
        // Pick slopes that straddle significance = 5 for a sigma near the noise we injected.
        const critical = 5.0 * noise / Math.sqrt(sxx);
        const below = buildTracks({noise, drifts: [{bx: critical * 0.4, by: 0}], seed: 7});
        const above = buildTracks({noise, drifts: [{bx: critical * 3.0, by: 0}], seed: 7});
        const opts = {driftMinSigmas: 0};
        const lo = classifyTracks(below.tracks, TRANSFORMS, below.stars, opts).slice(-1)[0];
        const hi = classifyTracks(above.tracks, TRANSFORMS, above.stars, opts).slice(-1)[0];

        expect(lo.significance).toBeLessThan(5.0);
        expect(lo.klass).not.toBe("moving");
        expect(hi.significance).toBeGreaterThan(5.0);
        expect(hi.klass).toBe("moving");
    });

    test("driftMinSigmas is the deciding threshold when significance is not binding", () => {
        const noise = 0.5;
        const opts = {driftSignificance: 0};
        // totalDrift = drift * 39, and the bar is 12 * sigma with sigma ~= noise.
        const perFrameAtBar = 12 * noise / (N_FRAMES - 1);
        const below = buildTracks({noise, drifts: [{bx: perFrameAtBar * 0.4, by: 0}], seed: 11});
        const above = buildTracks({noise, drifts: [{bx: perFrameAtBar * 2.5, by: 0}], seed: 11});
        const lo = classifyTracks(below.tracks, TRANSFORMS, below.stars, opts).slice(-1)[0];
        const hi = classifyTracks(above.tracks, TRANSFORMS, above.stars, opts).slice(-1)[0];

        expect(lo.totalDrift).toBeLessThan(12 * lo.sigma);
        expect(lo.klass).not.toBe("moving");
        expect(hi.totalDrift).toBeGreaterThan(12 * hi.sigma);
        expect(hi.klass).toBe("moving");
    });

    test("BOTH conditions are required - either one alone leaves the track a star", () => {
        const sxx = sxxOf(N_FRAMES);
        const noise = 0.5;
        // A drift that is highly significant but tiny in absolute terms: many frames of a very
        // consistent, very small motion. This is the case driftMinSigmas exists to veto.
        const tiny = 8.0 * noise / Math.sqrt(sxx);
        const {tracks, stars} = buildTracks({noise, drifts: [{bx: tiny, by: 0}], seed: 23});
        const rec = classifyTracks(tracks, TRANSFORMS, stars).slice(-1)[0];
        expect(rec.significance).toBeGreaterThan(5.0);
        expect(rec.totalDrift).toBeLessThan(12 * rec.sigma);
        expect(rec.klass).not.toBe("moving");
    });
});

describe("the noise floor these thresholds rest on", () => {
    test("sigma is pooled across tracks, so one track cannot set its own bar", () => {
        const {tracks, stars} = buildTracks({noise: 0.5, drifts: [{bx: 0.4, by: 0}]});
        const out = classifyTracks(tracks, TRANSFORMS, stars);
        const sigmas = new Set(out.filter((r) => r.sigma !== undefined).map((r) => r.sigma));
        expect(sigmas.size).toBe(1);
    });

    test("sigma never falls below the floor, however clean the clip", () => {
        const {tracks, stars} = buildTracks({noise: 1e-6});
        const out = classifyTracks(tracks, TRANSFORMS, stars);
        expect(out[0].sigma).toBeCloseTo(0.15, 9);
    });

    test("a stationary population produces no movers at all", () => {
        const {tracks, stars} = buildTracks({noise: 0.5});
        const out = classifyTracks(tracks, TRANSFORMS, stars);
        expect(out.filter((r) => r.klass === "moving")).toHaveLength(0);
    });
});
