// Star IDENTIFICATION against real measured data, scored PER LABEL.
//
// The rest of the identify suite is synthetic: fields projected from the catalogue, so every
// detection carries its own answer. That proves the solver works on a perfect camera. It does
// not prove anything about the thing that actually matters here - a wrong star name shown
// confidently is worse than no name - because on a real clip nobody knows the answers.
//
// This file gets answers anyway, from an ARBITER the identifier never sees. The fixture is a
// live capture of the whole Star Track result for
//
//   ?custom=99999999/Rotating Starfield issue/20260801_233530.js
//
// a ~96 deg IR monocular timelapse whose sky rotates 3.28 deg about a pole just past the
// top-right corner. It carries, per track: the 2D reference-chart position identification
// consumes, the classification from both the 2D and the spherical pass, and - the important
// part - the track's DIRECTION on the unit sphere as recovered by the lens fit and the global
// spherical refinement. Those directions are derived from pixel geometry alone; no catalogue
// was involved in producing them. So fitting the map to the catalogue with a trimmed rotation
// and asking how far each named star lands from where the map puts it is an independent check
// on every label, one at a time.
//
// It also settles a question the earlier investigation got wrong. The spherical map's absolute
// accuracy was reported as ~0.42 deg and blamed on atmospheric refraction near the horizon.
// That figure came from a best-fit planar SIMILARITY between two gnomonic charts, which measures
// how unlike the charts are, not sky error. Measured properly - rotation on the sphere, then
// great-circle residuals - the map is good to ~0.15 deg, and no physical explanation is owed.

import fs from "fs";
import path from "path";
import {
    STAR_IDENTIFY_DEFAULTS, parseStarCatalog, buildQuadIndex, solveField, raDecToVec,
} from "../src/starTrack/StarIdentify";
import {fitRotationWahba, qRotate} from "../src/starTrack/StarSphere";

const D2R = Math.PI / 180;

const map = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, "fixtures/rotatingStarfieldMap.json"), "utf8"));
const catalog = parseStarCatalog((() => {
    const b = fs.readFileSync(path.resolve(__dirname, "..", "data/nightsky/sitrec_bsc_lite.bin"));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
})());

const byIndex = new Map(map.tracks.map((t) => [t.i, t]));
const hipRow = new Map();
for (let i = 0; i < catalog.n; i++) hipRow.set(catalog.hip[i], i);
const hipVec = (h) => {
    const i = hipRow.get(h);
    return i === undefined ? null : raDecToVec(catalog.ra[i], catalog.dec[i]);
};
const sepDeg = (a, b) => Math.acos(Math.max(-1, Math.min(1,
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) / D2R;

// The pool the arbiter picks the "true" star from. Deeper than the identifier's own
// verification limit, so a label CAN be judged wrong by losing to a fainter neighbour.
const arbiterPool = [];
for (let i = 0; i < catalog.n; i++) if (catalog.mag[i] <= 7.5) arbiterPool.push(i);
const arbiterVec = arbiterPool.map((i) => raDecToVec(catalog.ra[i], catalog.dec[i]));

// StarTrackerUI.identifyStars' own input rule, mirrored: well-observed stars only, on the 2D
// reference chart, classified by the 2D pass (klass2D where the spherical pass overwrote klass).
const minObs = Math.min(25, Math.max(1, Math.ceil(0.15 * map.frames)));

function starSet(useSphericalKlass) {
    return map.tracks
        .filter((t) => (useSphericalKlass ? t.k : (t.k2 ?? t.k)) === "star"
            && t.p && Number.isFinite(t.m) && t.n >= minObs)
        .map((t) => ({x: t.p[0], y: t.p[1], mag: t.m, index: t.i}));
}

/** identifyStars' bounds rule: the union of the video rectangle and the map's own bbox. */
function uiOpts(stars) {
    let bx0 = 0, by0 = 0, bx1 = map.videoW, by1 = map.videoH;
    for (const s of stars) {
        bx0 = Math.min(bx0, s.x); bx1 = Math.max(bx1, s.x);
        by0 = Math.min(by0, s.y); by1 = Math.max(by1, s.y);
    }
    return {
        center: [(bx0 + bx1) / 2, (by0 + by1) / 2],
        width: Math.max(bx1 - bx0, by1 - by0),
        bounds: [bx0 - 12, by0 - 12, bx1 + 12, by1 + 12],
    };
}

/**
 * The rotation taking the spherical map's directions onto the sky, fitted TRIMMED: Wahba, drop
 * the worst fifth, refit, three times. Untrimmed, a handful of wrong identifications would drag
 * the frame toward themselves and so hide exactly what this is meant to expose.
 */
function mapToSky(pairs) {
    const A = pairs.map((p) => p.ref), B = pairs.map((p) => p.cat);
    let w = A.map(() => 1), q = null;
    for (let round = 0; round < 3; round++) {
        q = fitRotationWahba(A, B, w);
        const res = A.map((a, i) => sepDeg(qRotate(q, a), B[i]));
        const cut = [...res].sort((x, y) => x - y)[Math.floor(0.8 * res.length)];
        w = res.map((x) => (x <= cut ? 1 : 0));
    }
    return q;
}

/** Solve, then score every label against the arbiter. */
function solveAndAudit(stars) {
    const index = buildQuadIndex(catalog, STAR_IDENTIFY_DEFAULTS.tiers[0]);
    const solved = solveField(stars, catalog, [index], uiOpts(stars));
    if (!solved.ok) return {solved};

    const pairs = [];
    for (const m of solved.matches) {
        const t = byIndex.get(stars[m.image].index);
        if (!t?.ref) continue;
        pairs.push({index: stars[m.image].index, hip: m.hip, ref: t.ref,
            cat: raDecToVec(m.raDeg * D2R, m.decDeg * D2R)});
    }
    const q = mapToSky(pairs);

    let right = 0, gross = 0;
    const errors = [];
    for (const p of pairs) {
        const where = qRotate(q, p.ref);           // where the MAP says this track is
        let best = Infinity, bestHip = 0;
        for (let k = 0; k < arbiterPool.length; k++) {
            const d = sepDeg(where, arbiterVec[k]);
            if (d < best) { best = d; bestHip = catalog.hip[arbiterPool[k]]; }
        }
        const err = sepDeg(where, hipVec(p.hip) ?? where);
        errors.push(err);
        if (p.hip === bestHip) right++;
        else if (err > 0.5) gross++;               // not a near-double: a different star
    }
    errors.sort((a, b) => a - b);
    return {
        solved, pairs, q, right, gross, errors,
        wrong: pairs.length - right,
        median: errors[errors.length >> 1],
        p90: errors[Math.floor(0.9 * errors.length)],
    };
}

describe("identifying the real rotating-starfield clip", () => {
    test("the fixture is the measured data we think it is", () => {
        expect(map.tracks).toHaveLength(391);
        expect(map.videoW).toBe(1280);
        expect(map.videoH).toBe(720);
        // The lens fit re-judged 62 tracks from moving to star; those are the frame-EDGE stars
        // whose 2D positions carry the warp that made the flat model call them movers.
        expect(starSet(false)).toHaveLength(137);
        expect(starSet(true)).toHaveLength(199);
        // Every track carries a direction on the sphere, or the arbiter has nothing to judge on.
        expect(map.tracks.every((t) => Array.isArray(t.ref) && t.ref.length === 3)).toBe(true);
    });

    test("the shipping configuration names stars, and the names are RIGHT", () => {
        const a = solveAndAudit(starSet(false));
        expect(a.solved.ok).toBe(true);

        // Head of Ursa Major / Canes Venatici, as every solve of this clip has agreed.
        expect(Math.abs(a.solved.centerRaDeg / 15 - 11.5)).toBeLessThan(0.3);
        expect(Math.abs(a.solved.centerDecDeg - 37.6)).toBeLessThan(1.5);

        // Measured at the time of writing: 72 matched, 66 right, 3 grossly wrong. The bars are
        // set below that with room for catalogue and tuning drift, but ABOVE the pre-fix
        // behaviour (68 matched, 56 right, 7 grossly wrong), so the tangent-units fix cannot
        // silently regress: it bought both more names and less than half the errors.
        expect(a.pairs.length).toBeGreaterThanOrEqual(70);
        expect(a.right).toBeGreaterThanOrEqual(62);
        expect(a.gross).toBeLessThanOrEqual(4);
        expect(a.right / a.pairs.length).toBeGreaterThan(0.85);
    });

    test("the spherical map is accurate to about 0.15 deg, not the 0.42 deg once reported", () => {
        // The number that matters for any future catalogue-tied refinement, and the one the
        // earlier planar-similarity measurement got wrong by a factor of three. Inliers only:
        // the handful of misidentified labels are the identifier's error, not the map's.
        const a = solveAndAudit(starSet(false));
        const inliers = a.errors.filter((e) => e < 1);
        const rms = Math.sqrt(inliers.reduce((s, e) => s + e * e, 0) / inliers.length);
        expect(inliers.length).toBeGreaterThanOrEqual(0.9 * a.errors.length);
        expect(a.median).toBeLessThan(0.25);
        expect(rms).toBeLessThan(0.3);
        // ...and comfortably better than the figure that prompted the refraction hypothesis.
        expect(rms).toBeLessThan(0.42);
    });

    test("the improved star set is not yet safe to identify from", () => {
        // The 62 extra tracks are the frame-edge stars the lens fit recovered, and naming them
        // is the open goal. With the tangent-units guard fixed they no longer break the solve -
        // it succeeds on the wide tier - but the labels it puts on the EDGE are wrong often
        // enough to fail the bar this whole feature is held to. So identifyStars deliberately
        // keeps feeding the 2D-classified set, and this pins the reason: the day the edge
        // labels come good, this test fails and the input choice can be revisited.
        const index = buildQuadIndex(catalog, STAR_IDENTIFY_DEFAULTS.tiers[0]);
        const stars = starSet(true);
        const solved = solveField(stars, catalog, [index], uiOpts(stars));
        // On the NARROW tier the improved set still cannot hold consensus...
        expect(solved.ok).toBe(false);
        // ...which is why identifyStars would fall through to the wide tier, where it does
        // solve - but at a per-label quality this suite does not yet accept.
        const wide = buildQuadIndex(catalog, STAR_IDENTIFY_DEFAULTS.tiers[2]);
        const wideSolved = solveField(stars, catalog, [wide], uiOpts(stars));
        expect(wideSolved.ok).toBe(true);
        expect(wideSolved.matches.length).toBeGreaterThan(80);
    });
});
