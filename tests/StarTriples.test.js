// Bright-triple identification (src/starTrack/StarTriples.js).
//
// A synthetic sky is seen through a known pinhole camera, and the dots that land in the frame
// are the candidate stars. The triples must name them.

import {TRIPLE_DEFAULTS, canonicalTriple, catalogTriples, identifyBrightTriples, imageCodes, tripleCode}
    from "../src/starTrack/StarTriples";
import {gnomonic, raDecToVec, tangentBasis} from "../src/starTrack/StarIdentify";

const D2R = Math.PI / 180;

// A small deterministic random source, so a failure can be repeated.
function rng(seed) {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** RA/Dec (deg) of the direction at angle r (deg) from (ra0, dec0), at position angle pa. */
function offsetRaDec(ra0, dec0, rDeg, paDeg) {
    const c = raDecToVec(ra0 * D2R, dec0 * D2R);
    const b = tangentBasis(c);
    const t = Math.tan(rDeg * D2R);
    const xi = t * Math.sin(paDeg * D2R), eta = t * Math.cos(paDeg * D2R);
    const v = [c[0] + xi * b.e[0] + eta * b.n[0], c[1] + xi * b.e[1] + eta * b.n[1], c[2] + xi * b.e[2] + eta * b.n[2]];
    const len = Math.hypot(...v);
    const ra = Math.atan2(v[1], v[0]);
    return {raDeg: ((ra < 0 ? ra + 2 * Math.PI : ra) / D2R), decDeg: Math.asin(v[2] / len) / D2R};
}

/**
 * A pinhole camera at (ra0, dec0) with a roll and a vertical field: image x right, y down.
 * (x, y) -> (east, north) on the tangent plane is a rotation and a scale - a camera does not
 * mirror the sky - so the image is the plane turned by the roll and scaled by the focal length.
 */
function camera(ra0, dec0, rollDeg, vfovDeg, W, H) {
    const c = raDecToVec(ra0 * D2R, dec0 * D2R);
    const b = tangentBasis(c);
    const f = (H / 2) / Math.tan(vfovDeg * D2R / 2);
    const cr = Math.cos(rollDeg * D2R), sr = Math.sin(rollDeg * D2R);
    return (raDeg, decDeg) => {
        const q = gnomonic(raDecToVec(raDeg * D2R, decDeg * D2R), c, b);
        if (!q) return null;
        // (x - cx, y - cy) = f * R(-roll) * (xi, eta), with a 180 deg turn so north is up.
        const u = -f * (cr * q[0] + sr * q[1]), v = -f * (-sr * q[0] + cr * q[1]);
        return [W / 2 + u, H / 2 + v];
    };
}

/** Bright objects scattered over a wide area around (ra0, dec0). */
function sky(seed, n, ra0, dec0, spreadDeg) {
    const rand = rng(seed);
    return Array.from({length: n}, (_, k) => ({
        label: `S${k}`,
        mag: -1 + 3 * rand(),
        ...offsetRaDec(ra0, dec0, spreadDeg * Math.sqrt(rand()), 360 * rand()),
    }));
}

/** The objects that land in the frame, as candidate stars, with a little noise. */
function seen(objects, cam, W, H, seed, noisePx = 0.3) {
    const rand = rng(seed);
    const stars = [];
    for (const ob of objects) {
        const p = cam(ob.raDeg, ob.decDeg);
        if (!p || p[0] < 0 || p[1] < 0 || p[0] > W || p[1] > H) continue;
        stars.push({x: p[0] + noisePx * (rand() - 0.5), y: p[1] + noisePx * (rand() - 0.5),
            mag: ob.mag + 0.2 * (rand() - 0.5), index: stars.length, truth: ob.label});
    }
    return stars;
}

const W = 1280, H = 720;
const diagFov = (vfov) => 2 * Math.atan(Math.tan(vfov * D2R / 2) * Math.hypot(1, W / H)) / D2R;

describe("triple codes", () => {
    test("a shift, a rotation and a change of scale leave the code the same", () => {
        const P = [[10, 20], [300, 80], [120, 200]];
        const t0 = canonicalTriple(P);
        const ang = 37 * D2R, s = 2.7;
        const Q = P.map(([x, y]) => [s * (x * Math.cos(ang) - y * Math.sin(ang)) + 500, s * (x * Math.sin(ang) + y * Math.cos(ang)) - 40]);
        const t1 = canonicalTriple(Q);
        expect(t1.code[0]).toBeCloseTo(t0.code[0], 9);
        expect(t1.code[1]).toBeCloseTo(t0.code[1], 9);
        expect(t1.order).toEqual(t0.order);
    });

    test("the far pair goes to (0,0) and (1,1), with the third point nearer the first", () => {
        expect(tripleCode([0, 0], [1, 1], [1, 1])).toEqual([1, 1]);
        const t = canonicalTriple([[0, 0], [10, 0], [8, 3]]);
        expect(t.code[0] + t.code[1]).toBeLessThanOrEqual(1);
        expect(t.order.slice(0, 2).sort()).toEqual([0, 1]);
        expect(t.order[0]).toBe(1);                 // (8, 3) is nearer (10, 0)
    });

    test("a near-tie for the longest side gives the image both codes", () => {
        const P = [[0, 0], [100, 0], [50, 86]];     // almost equilateral
        expect(imageCodes(P, 0.15)).toHaveLength(6);
        expect(imageCodes([[0, 0], [100, 0], [50, 10]], 0.15)).toHaveLength(2);   // one long side
    });

    test("catalog triples wider than the camera's field are left out", () => {
        const objs = [{raDeg: 0, decDeg: 0}, {raDeg: 10, decDeg: 0}, {raDeg: 0, decDeg: 10}, {raDeg: 80, decDeg: 0}]
            .map((o) => ({dir: raDecToVec(o.raDeg * D2R, o.decDeg * D2R)}));
        expect(catalogTriples(objs, 20)).toHaveLength(1);
        expect(catalogTriples(objs, 90)).toHaveLength(4);
    });
});

describe("identifyBrightTriples", () => {
    test("names every dot of a sparse field", () => {
        const objects = sky(7, 40, 150, 20, 70);
        const vfov = 40;
        const cam = camera(150, 20, 12, vfov, W, H);
        const stars = seen(objects, cam, W, H, 3);
        expect(stars.length).toBeGreaterThanOrEqual(4);
        const res = identifyBrightTriples({stars, objects, width: W, height: H, maxFovDeg: diagFov(vfov)});
        expect(res.ok).toBe(true);
        for (const m of res.best.matches) expect(m.object.label).toBe(m.star.truth);
        expect(res.best.matches).toHaveLength(stars.length);
        expect(res.best.nMissing).toBe(0);
    });

    test("a small triangle in a wide field, as on the Jupiter clip", () => {
        // 61 deg vertical, 101 deg on the diagonal, and the only three dots within 10 deg of each
        // other. A pinhole lens maps angle by its tangent: a scale check that took pixels in
        // proportion to angle saw this field as about 138 deg wide and threw the triangle out.
        const trio = [[0, 0], [5.5, 30], [10, 75]].map(([r, pa], k) => ({label: `T${k}`, mag: 1, ...offsetRaDec(150, 15, r, pa)}));
        const far = sky(29, 30, 330, -15, 40);          // the other side of the sky
        const objects = [...trio, ...far];
        const vfov = 61;
        const cam = camera(152, 10, 25, vfov, W, H);
        const stars = seen(objects, cam, W, H, 5);
        expect(stars.map((s) => s.truth).sort()).toEqual(["T0", "T1", "T2"]);
        const res = identifyBrightTriples({stars, objects, width: W, height: H, maxFovDeg: diagFov(vfov)});
        expect(res.ok).toBe(true);
        for (const m of res.best.matches) expect(m.object.label).toBe(m.star.truth);
    });

    test("three dots: the objects that should be in the frame and are not decide", () => {
        // Search a few camera pointings for one that frames exactly three of the objects.
        const objects = sky(11, 40, 200, 30, 70);
        const vfov = 30;
        let stars = null;
        for (let k = 0; k < 200 && !stars; k++) {
            const r = rng(100 + k);
            const ra = 200 + 60 * (r() - 0.5), dec = 30 + 60 * (r() - 0.5);
            const s = seen(objects, camera(ra, dec, 360 * r(), vfov, W, H), W, H, k);
            if (s.length === 3) stars = s;
        }
        expect(stars).not.toBeNull();
        const res = identifyBrightTriples({stars, objects, width: W, height: H, maxFovDeg: diagFov(vfov)});
        expect(res.ok).toBe(true);
        for (const m of res.best.matches) expect(m.object.label).toBe(m.star.truth);
        expect(res.best.nMissing).toBe(0);
    });

    test("too few dots or objects is a reason, not a guess", () => {
        const objects = sky(5, 10, 0, 0, 30);
        expect(identifyBrightTriples({stars: [{x: 1, y: 1, mag: 1, index: 0}], objects, width: W, height: H, maxFovDeg: 90}).reason)
            .toMatch(/needs 3 candidate stars/);
        expect(identifyBrightTriples({stars: [{x: 1, y: 1, mag: 1, index: 0}, {x: 5, y: 9, mag: 1, index: 1}, {x: 40, y: 2, mag: 1, index: 2}],
            objects: objects.slice(0, 2), width: W, height: H, maxFovDeg: 90}).reason).toMatch(/only 2 bright objects/);
        expect(TRIPLE_DEFAULTS.maxImageStars).toBeGreaterThanOrEqual(3);
    });
});
