// Stage 4 of Star Track: grouping the lights that belong to one moving object.
//
// An aircraft's lights flash, so each produces short, gap-riddled tracks that individually fail
// classification. What identifies the ensemble is the AGREEMENT of their motion - and what these
// tests guard is both directions of that claim: lights moving together are grouped however poor
// their individual tracks, and things that merely coexist are not.

import {groupMovingClusters, STAR_CLUSTER_DEFAULTS} from "../src/starTrack/StarCluster";
import {mulberry32} from "../src/starTrack/StarSynthetic";

const N = 60;
const IDENTITY_TRANSFORMS = Array.from({length: N}, () => ({A: [1, 0], B: [0, 0]}));

/** A track whose light sits at offset (ox, oy) from a body moving at (vx, vy), seen on `frames`. */
function lightTrack(frames, vx, vy, ox, oy, jitter = 0, rng = null) {
    const obs = frames.map((f) => ({
        f,
        x: 100 + vx * f + ox + (rng ? (rng() - 0.5) * 2 * jitter : 0),
        y: 300 + vy * f + oy + (rng ? (rng() - 0.5) * 2 * jitter : 0),
        src: null,
    }));
    return {obs, first: frames[0], last: frames[frames.length - 1]};
}

const range = (a, b, step = 1) => {
    const out = [];
    for (let f = a; f <= b; f += step) out.push(f);
    return out;
};

describe("StarCluster grouping", () => {
    const SIGMA = 0.3;

    test("flashing lights in formation become one object, whatever their individual class", () => {
        // Three lights on one airframe at 2.0/0.5 px per frame: a steady one, one visible only in
        // bursts, and a strobe seen four times - too briefly to carry a velocity, so it can only
        // join by lying on the ensemble's path.
        const tracks = [
            lightTrack(range(0, N - 1), 2.0, 0.5, 0, 0),
            lightTrack([...range(4, 9), ...range(20, 25), ...range(40, 45)], 2.0, 0.5, 25, 8),
            lightTrack([7, 21, 35, 49], 2.0, 0.5, -18, 12),
            // Two stars: fixed, far away. Must never join a moving cluster.
            lightTrack(range(0, N - 1), 0, 0, 400, -100),
            lightTrack(range(0, N - 1), 0, 0, 450, -140),
        ];
        const classified = [
            {index: 0, klass: "moving", magnitude: -8.0},
            {index: 1, klass: "incoherent", magnitude: -6.5},
            {index: 2, klass: "short", magnitude: -7.2},
            {index: 3, klass: "star", magnitude: -9.0},
            {index: 4, klass: "star", magnitude: -8.5},
        ];
        const clusters = groupMovingClusters(tracks, classified, IDENTITY_TRANSFORMS, SIGMA);

        expect(clusters.length).toBe(1);
        expect(clusters[0].members).toEqual([0, 1, 2]);
        // Three tracklets at three distinct formation positions really are three lights.
        expect(clusters[0].lights).toBe(3);
        // The ensemble's motion is the shared truth: speed ~2.06 px/frame over ~59 frames.
        expect(clusters[0].speed).toBeCloseTo(Math.hypot(2.0, 0.5), 1);
        expect(clusters[0].totalDrift).toBeGreaterThan(100);
        // The formation extent reaches the outlying lights, not just the body.
        expect(clusters[0].extent).toBeGreaterThan(10);
        // The brightest light speaks for the ensemble.
        expect(clusters[0].magnitude).toBe(-8.0);
    });

    test("two movers on different headings are not one object", () => {
        const tracks = [
            lightTrack(range(0, N - 1), 2.0, 0.5, 0, 0),
            lightTrack(range(0, N - 1), -1.5, 1.0, 10, 5),
        ];
        const classified = [
            {index: 0, klass: "moving"},
            {index: 1, klass: "moving"},
        ];
        const clusters = groupMovingClusters(tracks, classified, IDENTITY_TRANSFORMS, SIGMA);
        expect(clusters.length).toBe(0);
    });

    test("stationary noise tracks that happen to sit together are not promoted to an object", () => {
        // Two jittering, drift-free tracks agree on a velocity of zero and sit within the
        // formation radius - the pairing gates pass. The ensemble drift gate is what must
        // refuse them: their combined motion is as insignificant as their separate ones.
        const rng = mulberry32(99);
        const tracks = [
            lightTrack(range(0, N - 1), 0, 0, 0, 0, 0.4, rng),
            lightTrack(range(0, N - 1), 0, 0, 12, -8, 0.4, rng),
        ];
        const classified = [
            {index: 0, klass: "incoherent"},
            {index: 1, klass: "incoherent"},
        ];
        const clusters = groupMovingClusters(tracks, classified, IDENTITY_TRANSFORMS, SIGMA);
        expect(clusters.length).toBe(0);
    });

    test("a lone mover with no companions forms no cluster", () => {
        const tracks = [lightTrack(range(0, N - 1), 2.0, 0.5, 0, 0)];
        const classified = [{index: 0, klass: "moving"}];
        const clusters = groupMovingClusters(tracks, classified, IDENTITY_TRANSFORMS, SIGMA);
        expect(clusters.length).toBe(0);
    });

    test("two bursts of ONE flashing light are one light, reported as such", () => {
        // A single flashing light fragments into tracklets separated by more than trackMaxGap.
        // Both pieces share one velocity and one path, so the union happily pairs them - but
        // they occupy the SAME place in the formation and never coexist, which is precisely
        // what "the same light seen twice" looks like. It is still a real moving object, and
        // with ample combined evidence it is reported - as ONE light, never as a formation of
        // two.
        const tracks = [
            lightTrack(range(0, 24), 2.0, 0.5, 0, 0),
            lightTrack(range(38, 59), 2.0, 0.5, 0, 0),
        ];
        const classified = [
            {index: 0, klass: "moving"},
            {index: 1, klass: "moving"},
        ];
        const clusters = groupMovingClusters(tracks, classified, IDENTITY_TRANSFORMS, SIGMA);
        expect(clusters.length).toBe(1);
        expect(clusters[0].lights).toBe(1);
    });

    test("a one-light group without enough combined evidence is not reported", () => {
        // The same fragmented light with only a handful of observations across its pieces:
        // below the evidence a classifiable track would need, a lone light stays unreported -
        // this is the gate that keeps velocity-matched noise blips from becoming objects.
        const tracks = [
            lightTrack(range(0, 3), 2.0, 0.5, 0, 0),
            lightTrack(range(20, 22), 2.0, 0.5, 0, 0),
        ];
        const classified = [
            {index: 0, klass: "short"},
            {index: 1, klass: "short"},
        ];
        const clusters = groupMovingClusters(tracks, classified, IDENTITY_TRANSFORMS, SIGMA,
            {clusterMinTrackObs: 3});
        expect(clusters.length).toBe(0);
    });

    test("one light on a gently curving path is one light, not a formation", () => {
        // A light following y = 0.0016 f^2 - the gentle arc a real aircraft flies - seen in
        // three bursts. Against a STRAIGHT shared path the end bursts sit offset one way and
        // the middle burst the other, so the mean-offset test counts one light as several and
        // the UI confidently labels a lone aircraft "2 lights moving together". The shared
        // model carries a curvature term, identified from the velocity differences between the
        // bursts' epochs, which a formation of straight-moving lights does not produce.
        const mk = (frames) => ({
            obs: frames.map((f) => ({f, x: 100 + 2 * f, y: 300 + 0.0016 * f * f, src: null})),
            first: frames[0], last: frames[frames.length - 1],
        });
        const tracks = [mk(range(0, 14)), mk(range(38, 52)), mk(range(75, 89))];
        const classified = tracks.map((_, i) => ({index: i, klass: "moving"}));
        const T90 = Array.from({length: 90}, () => ({A: [1, 0], B: [0, 0]}));
        const clusters = groupMovingClusters(tracks, classified, T90, 0.3);
        expect(clusters.length).toBe(1);
        expect(clusters[0].lights).toBe(1);
    });

    test("curvature does not depend on where frame numbering starts", () => {
        // The same curved flight, filmed a million frames into the recording. Building the
        // quadratic on raw f^2 puts ~1e12-scale regressors through double-precision sums whose
        // cancellation destroys the fit, so the identical physical path silently loses its
        // curvature term and one light becomes several. Time is centred before anything is
        // squared, so frame numbering is not physics.
        const OFF = 1000000;
        const mk = (frames) => ({
            obs: frames.map((f) => ({f: f + OFF, x: 100 + 2 * f, y: 300 + 0.0016 * f * f, src: null})),
            first: frames[0] + OFF, last: frames[frames.length - 1] + OFF,
        });
        const bursts = [range(0, 14), range(38, 52), range(75, 89)];
        const tracks = bursts.map(mk);
        const classified = tracks.map((_, i) => ({index: i, klass: "moving"}));
        // Transforms as a sparse map - an array a million entries long is not the point here.
        const T = {};
        for (const fr of bursts) for (const f of fr) T[f + OFF] = {A: [1, 0], B: [0, 0]};
        const clusters = groupMovingClusters(tracks, classified, T, 0.3);
        expect(clusters.length).toBe(1);
        expect(clusters[0].lights).toBe(1);
    });

    test("two nearby lights that coexist even briefly are two lights", () => {
        // Two lights 5 px apart whose duty cycles mostly alternate, overlapping for just two
        // frames. Coexistence is POSITIVE evidence of two lights - one light cannot be detected
        // twice in a frame - and 5 px is many sigma of separation besides; treating "close and
        // barely-overlapping" as one light discarded this pair entirely and reported no object.
        const tracks = [
            lightTrack(range(0, 31), 2.0, 0.5, 0, 0),
            lightTrack(range(30, 59), 2.0, 0.5, 0, 5),
        ];
        const classified = [
            {index: 0, klass: "moving"},
            {index: 1, klass: "moving"},
        ];
        const clusters = groupMovingClusters(tracks, classified, IDENTITY_TRANSFORMS, SIGMA);
        expect(clusters.length).toBe(1);
        expect(clusters[0].lights).toBe(2);

        // The same pair on much noisier footage is still two lights: the gate follows the
        // uncertainty of the offset MEANS, which shrinks with observation count, rather than
        // raw sigma, which would grow past their separation and collapse them into one.
        const noisy = groupMovingClusters(tracks, classified, IDENTITY_TRANSFORMS, 2.0);
        expect(noisy.length).toBe(1);
        expect(noisy[0].lights).toBe(2);
    });

    test("formation width is judged across LIGHTS, not across their fragments", () => {
        // One light arrives as two bursts whose measured offsets straddle its true position;
        // a second light sits just inside the formation limit. Measured across raw tracklets
        // the widest pair exceeds the limit and a valid formation is refused - the width must
        // be measured after the fragments are recognised as one light.
        const tracks = [
            lightTrack(range(0, 24), 2.0, 0, 0, -0.45),
            lightTrack(range(30, 59), 2.0, 0, 0, 0.45),
            lightTrack(range(0, 59), 2.0, 0, 0, 59.8),
        ];
        const classified = [
            {index: 0, klass: "moving"},
            {index: 1, klass: "moving"},
            {index: 2, klass: "moving"},
        ];
        const clusters = groupMovingClusters(tracks, classified, IDENTITY_TRANSFORMS, 0.6);
        expect(clusters.length).toBe(1);
        expect(clusters[0].lights).toBe(2);
    });

    test("a formation wider than clusterRadius between its outermost lights is refused", () => {
        // A percentile of point distances from the centre lets three tracks at offsets 0 and
        // +/-58 - 116 px between the outer pair - slip under a declared 60 px formation limit.
        // The limit is stated as how far apart two lights may sit, so it must be enforced on
        // the widest MEMBER PAIR, not on a centre-relative quantile.
        const frames = range(0, N - 1);
        const tracks = [-58, 0, 58].map((oy) => lightTrack(frames, 2.0, 0, 0, oy));
        const classified = tracks.map((_, i) => ({index: i, klass: "moving"}));
        // The discriminating half: a radius that genuinely covers the spread accepts the group.
        const wide = groupMovingClusters(tracks, classified, IDENTITY_TRANSFORMS, SIGMA,
            {clusterRadius: 200});
        expect(wide.length).toBe(1);

        const clusters = groupMovingClusters(tracks, classified, IDENTITY_TRANSFORMS, SIGMA);
        expect(clusters.length).toBe(0);
    });

    test("slow common-mode solve drift is not promoted to an object", () => {
        // On a long clip an imperfect camera solution leaves the whole star field creeping
        // coherently - measured at 0.05-0.34 px/frame on a real 341-frame run. Pooling makes
        // that drift statistically significant (hundreds of observations crush the standard
        // error) and 300 frames accumulate it past any sigma-scaled distance bar, so both of
        // the single-mover gates pass. Only an absolute speed floor separates it from an
        // object, because solve drift is slow and things worth calling objects are not.
        const frames = range(0, 299);
        const tracks = [
            lightTrack(frames, 0.05, 0.02, 0, 0),
            lightTrack(frames, 0.05, 0.02, 15, -10),
        ];
        const classified = [
            {index: 0, klass: "incoherent"},
            {index: 1, klass: "incoherent"},
        ];
        // The discriminating half: without the speed floor these really would become an object.
        const IDENT = Array.from({length: 300}, () => ({A: [1, 0], B: [0, 0]}));
        const loose = groupMovingClusters(tracks, classified, IDENT, SIGMA, {clusterMinSpeed: 0});
        expect(loose.length).toBe(1);

        const clusters = groupMovingClusters(tracks, classified, IDENT, SIGMA);
        expect(clusters.length).toBe(0);
    });

    test("a chain of pairwise-near tracks wider than the formation radius is refused", () => {
        // Union-find chains A-B-C-D when each is within clusterRadius of its neighbour, so a
        // line of tracks spanning three times the radius still unions into one group. The
        // fitted ensemble must then actually fit: member spread beyond the radius means this
        // is not one formation, however agreeable the pairwise links looked.
        const frames = range(0, N - 1);
        const tracks = [0, 58, 116, 174].map((oy) => lightTrack(frames, 2.0, 0, 0, oy));
        const classified = tracks.map((_, i) => ({index: i, klass: "moving"}));

        // The discriminating half: with a radius wide enough to cover the sprawl, the same
        // data does cluster - so at the default radius it is the extent gate that refuses it.
        const wide = groupMovingClusters(tracks, classified, IDENTITY_TRANSFORMS, SIGMA,
            {clusterRadius: 200});
        expect(wide.length).toBe(1);

        const clusters = groupMovingClusters(tracks, classified, IDENTITY_TRANSFORMS, SIGMA);
        expect(clusters.length).toBe(0);
    });

    test("an unrelated transient far from the path is not attached", () => {
        const tracks = [
            lightTrack(range(0, N - 1), 2.0, 0.5, 0, 0),
            lightTrack(range(10, 20), 2.0, 0.5, 30, -5),
            // A brief flash 300 px off the ensemble path.
            lightTrack([28, 29, 30], 2.0, 0.5, 300, 200),
        ];
        const classified = [
            {index: 0, klass: "moving"},
            {index: 1, klass: "incoherent"},
            {index: 2, klass: "short"},
        ];
        const clusters = groupMovingClusters(tracks, classified, IDENTITY_TRANSFORMS, SIGMA);
        expect(clusters.length).toBe(1);
        expect(clusters[0].members).toEqual([0, 1]);
    });
});
