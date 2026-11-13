// Manual identification: the plate model fitted to circles the user has named.
//
// The fixtures are projected through a known pinhole camera, so the fit must hand back that
// camera's pointing, plate scale and roll - from three points, including three that lie nearly in
// a line (planets near the ecliptic do) and three bunched in one corner of the frame.

import fs from "fs";
import path from "path";
import {parseStarCatalog, parseStarNames, gnomonic, raDecToVec, tangentBasis, vecToRaDec}
    from "../src/starTrack/StarIdentify";
import {fitManualPlate, resolveSkyLabel, brightNamedStars, PLANET_LABELS}
    from "../src/starTrack/StarManualFit";

const D2R = Math.PI / 180;
const W = 1280, H = 720;

/** Project J2000 positions through a pinhole camera: axis (deg), roll (deg), focal length (px). */
function project(stars, {raDeg, decDeg, rollDeg, focalPx, mirrored = false}) {
    const c = raDecToVec(raDeg * D2R, decDeg * D2R);
    const b = tangentBasis(c);
    const cr = Math.cos(rollDeg * D2R), sr = Math.sin(rollDeg * D2R);
    return stars.map((s) => {
        const [xi, eta] = gnomonic(raDecToVec(s.raDeg * D2R, s.decDeg * D2R), c, b);
        // Image right/down is sky west/south for an unrolled camera: (-xi, -eta), then rolled.
        let dx = focalPx * (cr * -xi - sr * -eta);
        const dy = focalPx * (sr * -xi + cr * -eta);
        if (mirrored) dx = -dx;
        return {...s, x: W / 2 + dx, y: H / 2 + dy};
    });
}

function angleDeg(a, b) {
    const va = raDecToVec(a.raDeg * D2R, a.decDeg * D2R);
    const vb = raDecToVec(b.raDeg * D2R, b.decDeg * D2R);
    const dot = va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2];
    return Math.acos(Math.min(1, dot)) / D2R;
}

// Regulus and two places along the ecliptic near it: nearly in a line, as Jupiter and Mars were.
const NEAR_LINE = [
    {raDeg: 152.093, decDeg: 11.967},
    {raDeg: 140.2, decDeg: 17.4},
    {raDeg: 128.9, decDeg: 21.0},
];

describe("fitManualPlate", () => {
    test("recovers pointing, scale and roll from three nearly collinear points", () => {
        const cam = {raDeg: 141, decDeg: 16, rollDeg: 25, focalPx: 900};
        const pts = project(NEAR_LINE, cam);
        const fit = fitManualPlate(pts, [W / 2, H / 2], W);
        expect(fit.ok).toBe(true);
        expect(fit.manual).toBe(true);
        expect(fit.mirrored).toBe(false);
        expect(angleDeg({raDeg: fit.centerRaDeg, decDeg: fit.centerDecDeg}, cam)).toBeLessThan(1e-6);
        expect(fit.pxPerDeg).toBeCloseTo(cam.focalPx * D2R, 6);
        expect(fit.rmsPx).toBeLessThan(1e-6);
        // refToSky inverts the projection: every named point maps back onto its own star.
        for (const p of pts) {
            expect(angleDeg(fit.refToSky(p.x, p.y), p)).toBeLessThan(1e-6);
        }
    });

    test("the optical axis is found even when the named stars are all in one corner", () => {
        const cam = {raDeg: 160, decDeg: 5, rollDeg: -40, focalPx: 600};
        const pts = project(NEAR_LINE.concat([{raDeg: 146, decDeg: 23.8}]), cam);
        const fit = fitManualPlate(pts, [W / 2, H / 2], W);
        expect(fit.ok).toBe(true);
        expect(angleDeg({raDeg: fit.centerRaDeg, decDeg: fit.centerDecDeg}, cam)).toBeLessThan(1e-6);
        expect(fit.rmsPx).toBeLessThan(1e-6);
    });

    test("click noise shows up as residual, and the pointing stays close", () => {
        const cam = {raDeg: 141, decDeg: 16, rollDeg: 10, focalPx: 900};
        const pts = project(NEAR_LINE, cam).map((p, k) => ({...p, x: p.x + [0.8, -0.6, 0.3][k],
            y: p.y + [-0.5, 0.7, -0.4][k]}));
        const fit = fitManualPlate(pts, [W / 2, H / 2], W);
        expect(fit.ok).toBe(true);
        expect(fit.mirrored).toBe(false);
        expect(fit.rmsPx).toBeGreaterThan(0.01);
        expect(fit.maxPx).toBeLessThan(2);
        expect(angleDeg({raDeg: fit.centerRaDeg, decDeg: fit.centerDecDeg}, cam)).toBeLessThan(0.1);
    });

    test("a mirror-image video is fitted as one", () => {
        const stars = [{raDeg: 152.093, decDeg: 11.967}, {raDeg: 146, decDeg: 23.8}, {raDeg: 135, decDeg: 8}];
        const pts = project(stars, {raDeg: 145, decDeg: 15, rollDeg: 0, focalPx: 700, mirrored: true});
        const fit = fitManualPlate(pts, [W / 2, H / 2], W);
        expect(fit.ok).toBe(true);
        expect(fit.mirrored).toBe(true);
        expect(fit.rmsPx).toBeLessThan(1e-6);
    });

    test("refuses fewer than three points", () => {
        const pts = project(NEAR_LINE.slice(0, 2), {raDeg: 141, decDeg: 16, rollDeg: 0, focalPx: 900});
        const fit = fitManualPlate(pts, [W / 2, H / 2], W);
        expect(fit.ok).toBe(false);
    });
});

describe("resolveSkyLabel", () => {
    const load = (rel) => {
        const buf = fs.readFileSync(path.join(__dirname, "..", rel));
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    };
    const catalog = parseStarCatalog(load("data/nightsky/sitrec_bsc_lite.bin"));
    const names = parseStarNames(fs.readFileSync(
        path.join(__dirname, "..", "data/nightsky/IAU-CSN.txt"), "utf8"));

    test("a proper name, any case, gives the catalog position", () => {
        const r = resolveSkyLabel("regulus", catalog, names);
        expect(r.hip).toBe(49669);
        expect(r.label).toBe("Regulus");
        expect(r.raDeg).toBeCloseTo(152.093, 2);
        expect(r.decDeg).toBeCloseTo(11.967, 2);
    });

    test("a unique start of a name is enough; an ambiguous one says so", () => {
        expect(resolveSkyLabel("Regul", catalog, names).hip).toBe(49669);
        expect(resolveSkyLabel("Al", catalog, names).error).toMatch(/type more/);
    });

    test("a Hipparcos number", () => {
        expect(resolveSkyLabel("HIP 49669", catalog, names).label).toBe("Regulus");
        expect(resolveSkyLabel("hip49669", catalog, names).hip).toBe(49669);
    });

    test("planets are named, not looked up in the catalog", () => {
        for (const p of PLANET_LABELS) {
            expect(resolveSkyLabel(p.toUpperCase(), catalog, names)).toEqual({planet: p, label: p});
        }
    });

    test("an unknown name is an error", () => {
        expect(resolveSkyLabel("Krypton", catalog, names).error).toMatch(/no star or planet/);
    });

    test("the bright named stars are sorted by name and include Regulus", () => {
        const list = brightNamedStars(catalog, names, 3.5);
        expect(list.find((s) => s.name === "Regulus")).toBeTruthy();
        const sorted = [...list].sort((a, b) => a.name.localeCompare(b.name));
        expect(list.map((s) => s.name)).toEqual(sorted.map((s) => s.name));
        expect(list.every((s) => s.mag <= 3.5)).toBe(true);
    });
});
