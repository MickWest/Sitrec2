// Stage 5 of Star Track: blind identification against the real star catalog.
//
// These tests run against the ACTUAL catalog files the app ships (data/nightsky/), not
// synthetic stand-ins: the parser is checked against known J2000 positions of real stars, and
// the blind solver is given fields projected from the real sky - with noise, dropped stars and
// spurious detections - and must name the stars back.

import fs from "fs";
import path from "path";
import {
    STAR_IDENTIFY_DEFAULTS,
    parseStarCatalog,
    parseStarNames,
    scalePriorFromFov,
    raDecToVec,
    vecToRaDec,
    tangentBasis,
    gnomonic,
    quadCode,
    buildQuadIndex,
    solveField,
} from "../src/starTrack/StarIdentify";
import {mulberry32} from "../src/starTrack/StarSynthetic";

const D2R = Math.PI / 180;

function loadArrayBuffer(rel) {
    const buf = fs.readFileSync(path.join(__dirname, "..", rel));
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

const catalog = parseStarCatalog(loadArrayBuffer("data/nightsky/sitrec_bsc_lite.bin"));
const names = parseStarNames(
    fs.readFileSync(path.join(__dirname, "..", "data", "nightsky", "IAU-CSN.txt"), "utf8"));

// One tier-1 index shared by every solve test; building it is the expensive part.
const index = buildQuadIndex(catalog, STAR_IDENTIFY_DEFAULTS.tiers[0]);

/**
 * Project the real sky onto a synthetic camera: centre, roll and plate scale known, so every
 * detected "star" carries its true catalog identity for scoring. The y axis grows downward
 * with north up at zero roll - the ordinary sky-camera parity.
 */
function projectField(opts) {
    const {raDeg, decDeg, rollDeg, pxPerDeg, W, H, magLimit} = opts;
    const c = raDecToVec(raDeg * D2R, decDeg * D2R);
    const b = tangentBasis(c);
    const roll = rollDeg * D2R;
    const k = pxPerDeg * 180 / Math.PI;      // px per radian
    const out = [];
    for (let i = 0; i < catalog.n; i++) {
        if (catalog.mag[i] > magLimit) continue;
        const g = gnomonic(raDecToVec(catalog.ra[i], catalog.dec[i]), c, b);
        if (!g) continue;
        const xr = g[0] * Math.cos(roll) + g[1] * Math.sin(roll);
        const yr = -g[0] * Math.sin(roll) + g[1] * Math.cos(roll);
        const x = W / 2 + k * xr;
        const y = H / 2 - k * yr;
        if (x < 10 || x > W - 10 || y < 10 || y > H - 10) continue;
        out.push({x, y, mag: catalog.mag[i], hip: catalog.hip[i]});
    }
    return out;
}

/** Noise, dropouts and spurious detections, deterministically. */
function degrade(stars, {seed, noise = 0.8, dropFraction = 0.2, spurious = 5, W, H}) {
    const rng = mulberry32(seed);
    const out = [];
    for (const s of stars) {
        if (rng() < dropFraction) continue;
        out.push({
            x: s.x + (rng() - 0.5) * 2 * noise,
            y: s.y + (rng() - 0.5) * 2 * noise,
            mag: s.mag + (rng() - 0.5) * 0.4,
            hip: s.hip,
        });
    }
    for (let i = 0; i < spurious; i++) {
        out.push({x: 10 + rng() * (W - 20), y: 10 + rng() * (H - 20), mag: 4 + rng() * 3, hip: -1});
    }
    return out;
}

function scoreSolve(result, stars) {
    let right = 0, wrong = 0;
    for (const m of result.matches) {
        const truth = stars[m.image].hip;
        if (truth === -1) { wrong++; continue; }
        if (truth === m.hip) right++;
        else wrong++;
    }
    return {right, wrong};
}

describe("StarIdentify catalog parsing", () => {
    test("the shipped catalog parses to real stars at their J2000 places", () => {
        // Every record, including the two the night-sky loader's off-by-28 bound drops.
        expect(catalog.n).toBeGreaterThan(100000);

        const find = (hip) => {
            for (let i = 0; i < catalog.n; i++) if (catalog.hip[i] === hip) return i;
            return -1;
        };
        const sirius = find(32349);
        expect(sirius).toBeGreaterThanOrEqual(0);
        expect(catalog.ra[sirius] / D2R).toBeCloseTo(101.2885, 2);
        expect(catalog.dec[sirius] / D2R).toBeCloseTo(-16.7131, 2);
        expect(catalog.mag[sirius]).toBeCloseTo(-1.44, 2);

        const polaris = find(11767);
        expect(catalog.dec[polaris] / D2R).toBeGreaterThan(89);

        // Placeholder rows (RA and Dec both zero) are dropped, not kept as fake mag-15 stars.
        for (let i = 0; i < catalog.n; i++) {
            expect(catalog.ra[i] !== 0 || catalog.dec[i] !== 0).toBe(true);
        }
    });

    test("the IAU names file yields proper names, Bayer letters and constellations", () => {
        expect(names.size).toBeGreaterThan(400);
        const sirius = names.get(32349);
        expect(sirius.name).toBe("Sirius");
        expect(sirius.constellation).toBe("CMa");
        expect(sirius.hr).toBe(2491);
        const betelgeuse = names.get(27989);
        expect(betelgeuse.name).toBe("Betelgeuse");
        expect(betelgeuse.constellation).toBe("Ori");

        // Six-digit Hipparcos numbers fill their column: a slice starting late truncates
        // "102098" to 2098, hiding Deneb and hanging its name on an unrelated star.
        expect(names.get(102098)?.name).toBe("Deneb");
        expect(names.get(2098)?.name).not.toBe("Deneb");
        expect(names.get(107556)?.name).toBe("Deneb Algedi");
    });
});

describe("StarIdentify quad codes", () => {
    // Inner stars sit inside the circle whose diameter is the outer pair, as valid quads must.
    const PTS = [[0, 0], [10, 2], [4, 4], [6, 1]];

    test("the code is invariant to translation, rotation and scale", () => {
        const base = quadCode(PTS);
        expect(base).not.toBeNull();
        const moved = quadCode(PTS.map(([x, y]) => [x + 55, y - 12]));
        const th = 0.7, s = 3.2;
        const rotated = quadCode(PTS.map(([x, y]) => [
            s * (x * Math.cos(th) - y * Math.sin(th)) + 4,
            s * (x * Math.sin(th) + y * Math.cos(th)) - 9,
        ]));
        for (let i = 0; i < 4; i++) {
            expect(moved[i]).toBeCloseTo(base[i], 9);
            expect(rotated[i]).toBeCloseTo(base[i], 9);
        }
    });

    test("a mirrored quad codes differently, which is why both parities are searched", () => {
        const base = quadCode(PTS);
        const mirrored = quadCode(PTS.map(([x, y]) => [x, -y]));
        const same = base.every((v, i) => Math.abs(v - mirrored[i]) < 1e-6);
        expect(same).toBe(false);
    });

    test("a quad whose inner stars fall outside the AB circle is rejected as unstable", () => {
        expect(quadCode([[0, 0], [10, 0], [5, 4.99], [5, -4.99]])).not.toBeNull();
        expect(quadCode([[0, 0], [10, 0], [5, 6], [5, -1]])).toBeNull();
    });
});

describe("StarIdentify blind solve", () => {
    test("a wide field around Orion is identified, with the right pointing and scale", () => {
        const field = {raDeg: 84, decDeg: 2, rollDeg: 25, pxPerDeg: 51, W: 1276, H: 720,
            magLimit: 5.5};
        const truth = projectField(field);
        expect(truth.length).toBeGreaterThan(12);
        const stars = degrade(truth, {seed: 7, W: field.W, H: field.H});

        const result = solveField(stars, catalog, [index], {center: [field.W / 2, field.H / 2]});
        expect(result.ok).toBe(true);
        // Pointing within half a degree, plate scale within two percent.
        const dRa = Math.abs(result.centerRaDeg - field.raDeg)
            * Math.cos(field.decDeg * D2R);
        expect(dRa).toBeLessThan(0.5);
        expect(Math.abs(result.centerDecDeg - field.decDeg)).toBeLessThan(0.5);
        expect(Math.abs(result.pxPerDeg - field.pxPerDeg) / field.pxPerDeg).toBeLessThan(0.02);

        const {right, wrong} = scoreSolve(result, stars);
        expect(right).toBeGreaterThanOrEqual(0.8 * result.matches.length);
        expect(wrong).toBeLessThanOrEqual(0.2 * result.matches.length);

        // Every shipped pairing sits within the verification tolerance of the FINAL model -
        // refinement rematches with the same gate it verified with, so no early pairing can
        // survive on stale credit.
        const tol = Math.max(4, 0.005 * field.W);
        for (const m of result.matches) expect(m.dPx).toBeLessThanOrEqual(tol);

        // The exported calibration function agrees with the identifications it shipped: a
        // matched star's image position maps to its catalog place on the sky.
        for (const m of result.matches.slice(0, 10)) {
            const sky = result.refToSky(stars[m.image].x, stars[m.image].y);
            const dRaDeg = Math.abs(sky.raDeg - m.raDeg) * Math.cos(m.decDeg * D2R);
            const dDecDeg = Math.abs(sky.decDeg - m.decDeg);
            expect(Math.hypot(dRaDeg, dDecDeg)).toBeLessThan(0.2);
        }
    });

    test("a narrower southern field around Crux is identified too", () => {
        const field = {raDeg: 190, decDeg: -60, rollDeg: -40, pxPerDeg: 100, W: 1276, H: 720,
            magLimit: 6.3};
        const truth = projectField(field);
        expect(truth.length).toBeGreaterThan(10);
        const stars = degrade(truth, {seed: 11, W: field.W, H: field.H});

        const result = solveField(stars, catalog, [index], {center: [field.W / 2, field.H / 2]});
        expect(result.ok).toBe(true);
        expect(Math.abs(result.centerDecDeg - field.decDeg)).toBeLessThan(0.5);
        const {right} = scoreSolve(result, stars);
        expect(right).toBeGreaterThanOrEqual(0.7 * result.matches.length);
    });

    test("an image far deeper than the verification catalog still identifies", () => {
        // A 12-megapixel astrophoto detects hundreds of stars, most fainter than the mag-7
        // verification pool can show. A consensus fraction measured against the RAW image
        // count is then unreachable by any correct solve - the evidence is matching most of
        // what the catalog CAN show in the field, and the refinement then names the fainter
        // stars from a depth-adaptive pool.
        const field = {raDeg: 84, decDeg: 2, rollDeg: 10, pxPerDeg: 51, W: 1276, H: 720,
            magLimit: 9.0};
        const truth = projectField(field);
        expect(truth.length).toBeGreaterThan(120);
        const stars = degrade(truth, {seed: 21, W: field.W, H: field.H});

        const result = solveField(stars, catalog, [index], {center: [field.W / 2, field.H / 2]});
        expect(result.ok).toBe(true);
        expect(Math.abs(result.centerDecDeg - field.decDeg)).toBeLessThan(0.5);
        // The deep rematch reaches well past the verification pool's depth.
        expect(result.matches.length).toBeGreaterThan(100);
        const {right, wrong} = scoreSolve(result, stars);
        expect(right).toBeGreaterThanOrEqual(0.8 * result.matches.length);
    });

    test("a letterboxed strip identifies: off-frame catalog stars do not count against it", () => {
        // The in-field gate is a circle around the centre; a 1276x400 strip sees only a slice
        // of that circle, and stars projecting OFF the frame can match nothing - counted, they
        // inflate the consensus denominator and consume the brightest-N pool until a valid
        // deep field fails. Projection is confined to the image rectangle.
        const field = {raDeg: 84, decDeg: 2, rollDeg: 10, pxPerDeg: 51, W: 1276, H: 400,
            magLimit: 9.0};
        const truth = projectField(field);
        expect(truth.length).toBeGreaterThan(60);
        const stars = degrade(truth, {seed: 23, W: field.W, H: field.H});

        const result = solveField(stars, catalog, [index], {
            center: [field.W / 2, field.H / 2],
            bounds: [0, 0, field.W, field.H],
        });
        expect(result.ok).toBe(true);
        const {right} = scoreSolve(result, stars);
        expect(right).toBeGreaterThanOrEqual(0.8 * result.matches.length);
    });

    test("the scale prior converts field of view in tangent units on the short axis", () => {
        // Portrait and landscape frames of the same camera share the same prior - the
        // metadata's vertical FOV describes the sensor's SHORT axis - and the conversion uses
        // gnomonic tangent units, where half the frame spans tan(fov/2).
        const landscape = scalePriorFromFov(53.13, 4032, 3024);
        const portrait = scalePriorFromFov(53.13, 3024, 4032);
        expect(portrait).toBeCloseTo(landscape, 12);
        expect(landscape).toBeCloseTo(2 * Math.tan(53.13 * Math.PI / 360) / 3024, 9);
        expect(scalePriorFromFov(0, 100, 100)).toBeUndefined();
    });

    test("bright terrestrial clutter cannot hijack the quad stars", () => {
        // The real failure this encodes: a lit tree in the corner of a twilight photo detects
        // as dozens of blobs BRIGHTER than any star, so the brightest-N quad set was all
        // foliage and no hypothesis could be right. Clutter is texture - many detections
        // packed together - and sky is sparse; anchors are drawn from the sparse population.
        // Enough sky stars that the clutter is a minority of detections, as on a real photo -
        // the density bar is a median, and a majority-clutter frame would move the median.
        const field = {raDeg: 84, decDeg: 2, rollDeg: 25, pxPerDeg: 51, W: 1276, H: 720,
            magLimit: 6.5};
        const truth = projectField(field);
        const stars = degrade(truth, {seed: 7, W: field.W, H: field.H});
        // Forty very bright blobs crammed into a corner square, like foliage.
        const rng = mulberry32(41);
        for (let i = 0; i < 40; i++) {
            stars.push({x: 30 + rng() * 150, y: 560 + rng() * 130,
                mag: -13 + rng() * 3, hip: -1});
        }
        const result = solveField(stars, catalog, [index], {center: [field.W / 2, field.H / 2]});
        expect(result.ok).toBe(true);
        const {right} = scoreSolve(result, stars);
        expect(right).toBeGreaterThanOrEqual(0.8 * result.matches.length);
    });

    test("a phone-lens wide field solves - verification is exact at any field of view", () => {
        // A 24mm-equivalent phone frame spans ~67 degrees. A pinhole camera is exactly
        // "gnomonic about the optical axis plus a similarity", so once verification re-centres
        // its tangent point on the image centre the model has NO field-size error - and even
        // the narrow tier's locally-small quads then verify correctly from anywhere in the
        // frame. Both the ordinary and the wide tier must solve this field; the wide tier
        // remains for skies where only the naked-eye-bright stars are visible at all.
        const field = {raDeg: 40, decDeg: 25, rollDeg: 15, pxPerDeg: 19, W: 1276, H: 957,
            magLimit: 5.5};
        const truth = projectField(field);
        expect(truth.length).toBeGreaterThan(60);
        const stars = degrade(truth, {seed: 31, W: field.W, H: field.H});
        const scalePrior = (Math.PI / 180) / field.pxPerDeg;

        for (const idx of [index, buildQuadIndex(catalog, STAR_IDENTIFY_DEFAULTS.tiers[2])]) {
            const result = solveField(stars, catalog, [idx],
                {center: [field.W / 2, field.H / 2], scalePrior});
            expect(result.ok).toBe(true);
            expect(Math.abs(result.centerDecDeg - field.decDeg)).toBeLessThan(1.5);
            const {right} = scoreSolve(result, stars);
            expect(right).toBeGreaterThanOrEqual(0.6 * result.matches.length);
        }
    });

    test("points that are not a sky refuse to solve rather than inventing a field", () => {
        const rng = mulberry32(99);
        const stars = Array.from({length: 30}, () => ({
            x: 10 + rng() * 1256, y: 10 + rng() * 700, mag: 3 + rng() * 4,
        }));
        const result = solveField(stars, catalog, [index]);
        expect(result.ok).toBe(false);
    });

    test("too few stars refuses honestly", () => {
        const result = solveField([{x: 1, y: 1}, {x: 2, y: 2}], catalog, [index]);
        expect(result.ok).toBe(false);
    });
});

describe("StarIdentify wide-mosaic acceptance", () => {
    // The REAL star map that motivated the strong-count acceptance path: a 379-frame panning
    // clip's map, mosaicked by per-frame similarities across a ~21-degree span. The mosaic
    // carries intrinsic warp (a similarity cannot express the gnomonic scale change across the
    // pan) plus a few duplicate entries from tracks broken at a mid-clip camera jerk - so only
    // ~47% of its 66 entries can land within tolerance HOWEVER correct the solve is, and the
    // 0.5-fraction rule refused a solve backed by 31 simultaneous matches at 3.6 px rms.
    // Positions are reference-frame pixels from the actual clip (video 1276x720, head of Draco).
    const MOSAIC = [
        [341.52, 688.05, -10.775], [148.61, 398.38, -10.418], [826.99, 514.38, -9.526],
        [1027.56, 610.35, -9.207], [681.37, 297.64, -9.403], [830.53, 562.71, -8.925],
        [1130.51, 590.7, -8.015], [468.87, 346.11, -8.657], [1229.79, 307.82, -8.779],
        [758.2, 414.64, -8.353], [362.52, 574.09, -8.312], [436.87, 208.27, -8.059],
        [1275.82, 696.49, -7.666], [1063.95, 868.01, -8.411], [631.95, 947.49, -9.35],
        [174.73, 933.34, -7.955], [462.09, 1154.71, -8.653], [413.1, 1160.24, -8.34],
        [329.47, 675.31, -10.757], [1057.67, 830.93, -7.827], [346.03, 560.39, -8.293],
        [1411.19, 725.5, -8.205], [1393.97, 1209.24, -8.905], [1157.09, 1290.02, -10.726],
        [616.04, 922.9, -9.376], [1441.81, 1314.08, -8.785], [1349.63, 1243.9, -8.386],
        [1045.6, 827.91, -8.017], [450.7, 1153.53, -8.415], [1447.21, 945.32, -9.643],
        [1473.62, 1043.58, -9.587], [1515.72, 909.24, -10.848], [595.75, 1374.05, -8.9],
        [403.58, 1392.65, -8.433], [1564.1, 1017.5, -8.138], [1313.88, 1262.35, -7.865],
        [1588.34, 1233.64, -7.704], [1468.91, 1229.39, -7.81], [601.97, 1451.32, -7.462],
        [1500.16, 1364.6, -7.63], [1500.81, 807.65, -7.711], [1334.05, 1103.17, -7.902],
        [627.97, 1463.85, -7.838], [1635.5, 1239.57, -7.747], [1642.47, 1011.04, -9.124],
        [1641.06, 795.2, -8.007], [1734.99, 1157.36, -10.422], [1241.21, 175.17, -7.525],
        [852.33, 285.2, -8.026], [1171.31, 704.87, -8.032], [1224.95, 288.82, -7.715],
        [924.61, 775.56, -6.919], [629.01, 925.52, -9.475], [1013.17, 574.35, -9.151],
        [1238.04, 1244.22, -8.027], [846.37, 1262.47, -8.393], [402.35, 1159.42, -8.246],
        [1400.96, 988.61, -7.952], [1398.58, 722.6, -8.309], [1272.04, 1253.99, -7.941],
        [1498.06, 1019.71, -7.998], [821.85, 1192.3, -7.597], [928.66, 1426.39, -8.189],
        [905.24, 1003.25, -7.571], [916.6, 1277.45, -7.546], [752.63, 1363.55, -7.787],
    ].map(([x, y, mag]) => ({x, y, mag}));

    const opts = (() => {
        let bx0 = 0, by0 = 0, bx1 = 1276, by1 = 720;
        for (const s of MOSAIC) {
            bx0 = Math.min(bx0, s.x); bx1 = Math.max(bx1, s.x);
            by0 = Math.min(by0, s.y); by1 = Math.max(by1, s.y);
        }
        return {
            center: [(bx0 + bx1) / 2, (by0 + by1) / 2],
            width: Math.max(bx1 - bx0, by1 - by0),
            bounds: [bx0 - 12, by0 - 12, bx1 + 12, by1 + 12],
        };
    })();

    test("a warped wide mosaic is accepted on the strong absolute count", () => {
        const result = solveField(MOSAIC, catalog, [index], opts);
        expect(result.ok).toBe(true);
        // Head of Draco, as every solve of this clip has agreed.
        expect(Math.abs(result.centerRaDeg / 15 - 18.23)).toBeLessThan(0.4);
        expect(Math.abs(result.centerDecDeg - 45.6)).toBeLessThan(2);
        expect(result.matches.length).toBeGreaterThanOrEqual(25);
        // The premise of the strong-count path: the reachable fraction here really is below
        // the narrow-field rule. If this ever rises above it, the fixture no longer tests
        // the alternative gate and should be replaced.
        expect(result.matches.length).toBeLessThan(0.5 * result.nImage);
    });

    test("without the strong-count path this map is refused (the old behavior)", () => {
        // maxHypotheses trimmed to keep the deliberate failure cheap; the live failure ran the
        // full 3000 and failed identically.
        const result = solveField(MOSAIC, catalog, [index],
            {...opts, strongMatchCount: Infinity, maxHypotheses: 600});
        expect(result.ok).toBe(false);
    });
});
