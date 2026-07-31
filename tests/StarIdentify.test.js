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
