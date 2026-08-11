// Camera fit by plane homography.
//
// Same testing philosophy as CameraPointFit.test.js: build a KNOWN camera, project known world
// points through it, and ask the solver to recover the camera it started from. A low residual
// proves the optimiser found a minimum, not that the minimum is the truth.
//
// The rejection tests are the important ones here. This method's failure mode is not a bad
// residual — it is a CONFIDENT wrong answer, because the DLT always returns something and the
// focal scan always has a lowest sample. Every test below marked "must reject" is a case that
// previously returned ok:true with a plausible-looking observability string.

import {fitCameraByPlaneHomography} from "../src/CameraPlaneHomography";
import {fitCameraToPoints, basisFromAzElRoll, projectWorldPoint} from "../src/CameraPointFit";
import {lensFromVFOV} from "../src/CameraLens";

const SIZE = [1920, 1080];
const R_EARTH = 6378137;
const DEG = Math.PI / 180;

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const nrm = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const n = nrm(a); return [a[0] / n, a[1] / n, a[2] / n]; };

/** Smallest angle between two bearings. azElRollFromBasis returns atan2 range, so an azimuth
 *  of 273.285 comes back as -86.715 — the same direction, a different representative. */
const angDiff = (a, b) => Math.abs(((a - b) % 360 + 540) % 360 - 180);

function llaToEcef(latDeg, lonDeg, alt) {
    const lat = latDeg * DEG, lon = lonDeg * DEG;
    const r = R_EARTH + alt;
    return [r * Math.cos(lat) * Math.cos(lon), r * Math.cos(lat) * Math.sin(lon), r * Math.sin(lat)];
}

function localFrame(pos) {
    const up = unit(pos);
    const pole = [0, 0, 1];
    return {
        up,
        north: unit(sub(pole, [up[0] * dot(pole, up), up[1] * dot(pole, up), up[2] * dot(pole, up)])),
    };
}

function makeCamera(position, azDeg, elDeg, rollDeg, vfovDeg) {
    const fr = localFrame(position);
    return {
        position,
        basis: basisFromAzElRoll(fr.up, fr.north, azDeg, elDeg, rollDeg),
        focalScale: 1,
        vfovDeg,
    };
}

function synthesise(camera, worldPoints) {
    const lens = lensFromVFOV(camera.vfovDeg, SIZE);
    return worldPoints.map((w) => {
        const px = projectWorldPoint(camera, w, lens, SIZE);
        expect(px).not.toBeNull();
        return {px, world: w};
    });
}

/** A coplanar spread of landmarks in front of a camera looking west and down. */
const CAM_POS = llaToEcef(43.130, 11.390, 1600);
const CAM = makeCamera(CAM_POS, 273.285, -8.025, 0, 30.5);
const INITIAL = {position: CAM_POS, azDeg: 270, elDeg: -7, rollDeg: 0, vfovDeg: 35};

function spreadWorld(n = 8) {
    const out = [];
    for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        out.push(llaToEcef(43.128 + t * 0.030, 11.30 - t * 0.070 + (i % 2) * 0.004, 125));
    }
    return out;
}

const fit = (points, initial = INITIAL) =>
    fitCameraByPlaneHomography({points, imageSize: SIZE, localFrame, initial});

/**
 * Like synthesise, but returns null instead of asserting when a point will not project.
 *
 * Deliberately does NOT require the pixel to land inside the frame. The solver works from
 * correspondences, not from a rendered image, and a point projecting to x = 2400 is a perfectly
 * usable constraint — the same is true of the boundary test above. Only a point behind the
 * camera, or one the lens cannot represent, is unusable.
 */
function worldPointsVisible(camera, worldPoints) {
    const lens = lensFromVFOV(camera.vfovDeg, SIZE);
    const out = [];
    for (const w of worldPoints) {
        const px = projectWorldPoint(camera, w, lens, SIZE);
        if (px === null || !Number.isFinite(px[0]) || !Number.isFinite(px[1])) return null;
        out.push({px, world: w});
    }
    return out;
}

describe("plane homography — recovery", () => {

    test("recovers the camera it was built from", () => {
        const res = fit(synthesise(CAM, spreadWorld()));
        expect(res.ok).toBe(true);
        expect(res.rms).toBeLessThan(1.0);
        expect(res.vfovDeg).toBeCloseTo(30.5, 0);
        expect(nrm(sub(res.position, CAM_POS))).toBeLessThan(60);
        expect(angDiff(res.azDeg, 273.285)).toBeLessThan(0.5);
        expect(Math.abs(res.elDeg - (-8.025))).toBeLessThan(0.5);
    });

    test("agrees with the direct 3D solver on the same points", () => {
        const points = synthesise(CAM, spreadWorld());
        const hom = fit(points);
        const direct = fitCameraToPoints({
            points, imageSize: SIZE, localFrame, initial: INITIAL,
            free: {position: true, az: true, el: true, roll: false, fov: true},
        });
        expect(hom.ok).toBe(true);
        expect(direct.ok).toBe(true);
        // Both are solving the same problem, so they should land in the same place.
        expect(nrm(sub(hom.position, direct.position))).toBeLessThan(80);
        expect(Math.abs(hom.vfovDeg - direct.vfovDeg)).toBeLessThan(0.5);
    });

    test("works at the four-point minimum, where the DLT matrix is 8x9", () => {
        const world = [
            llaToEcef(43.129, 11.330, 125), llaToEcef(43.152, 11.318, 125),
            llaToEcef(43.133, 11.271, 125), llaToEcef(43.156, 11.258, 125),
        ];
        const res = fit(synthesise(CAM, world));
        expect(res.ok).toBe(true);
        expect(res.rms).toBeLessThan(2.0);
        expect(res.vfovDeg).toBeCloseTo(30.5, 0);
    });

    test("accepts a camera sitting exactly on the supported FOV boundary", () => {
        // HFOV 1.0 degrees is the narrow end of the focal scan and is a supported value, so it
        // must fit rather than be mistaken for the score running off the end of the search.
        const vfovAt1 = 2 * Math.atan((SIZE[1] / 2) / ((SIZE[0] / 2) / Math.tan(0.5 * DEG))) / DEG;
        const far = llaToEcef(43.130, 11.390, 12000);
        const narrow = makeCamera(far, 273.285, -8.025, 0, vfovAt1);
        const world = [];
        for (let i = 0; i < 8; i++) {
            const t = i / 7;
            world.push(llaToEcef(43.1285 + t * 0.0032, 11.30 - t * 0.0068 + (i % 2) * 0.0007, 125));
        }
        const pts = synthesise(narrow, world);
        const res = fit(pts, {position: far, azDeg: 273, elDeg: -8, rollDeg: 0, vfovDeg: vfovAt1});
        expect(res.ok).toBe(true);
        expect(res.rms).toBeLessThan(5.0);
        // Recovered HFOV should be at the boundary, not pushed off it.
        const hfov = 2 * Math.atan(Math.tan(res.vfovDeg * DEG / 2) * SIZE[0] / SIZE[1]) / DEG;
        expect(hfov).toBeGreaterThan(0.9);
        expect(hfov).toBeLessThan(1.3);
    });

    test("never reports a field of view outside the supported 1-170 degree range", () => {
        // Sweep cameras across and past both boundaries. A minimum lying just outside the range
        // can still make the boundary sample the lowest one, so the solve is accepted — and the
        // refinement must then land ON the boundary rather than stepping past it.
        const hfovToVfov = (h) =>
            2 * Math.atan((SIZE[1] / 2) / ((SIZE[0] / 2) / Math.tan(h * DEG / 2))) / DEG;
        // The band that reaches this path is narrow, and stepping over it makes the test
        // worthless. The coarse scan samples focal length at a ratio of (HI/LO)^(1/900) = 1.008
        // per step, so the winning index is the boundary one only while the true minimum lies
        // within half a step of it — HFOV roughly 0.996 to 1.000 degrees. Further out than that
        // the minimum wins an index beyond N and is rejected instead. Verified by mutation: with
        // the clamp removed, the 0.997-0.9995 cases return HFOV below 1 degree as ok.
        let accepted = 0;
        for (const hfov of [0.9955, 0.996, 0.9965, 0.997, 0.9975, 0.998, 0.9985, 0.999,
                            0.9995, 1.0, 1.0005, 1.001, 1.05, 1.4]) {
            const far = llaToEcef(43.130, 11.390, 12000);
            const cam = makeCamera(far, 273.285, -8.025, 0, hfovToVfov(hfov));
            const world = [];
            for (let i = 0; i < 8; i++) {
                const t = i / 7;
                world.push(llaToEcef(43.1285 + t * 0.0032 * hfov,
                    11.30 - t * 0.0068 * hfov + (i % 2) * 0.0007 * hfov, 125));
            }
            const pts = worldPointsVisible(cam, world);
            if (!pts) continue;
            const res = fit(pts, {position: far, azDeg: 273, elDeg: -8, rollDeg: 0,
                vfovDeg: hfovToVfov(hfov)});
            if (!res.ok) continue;
            accepted++;
            const got = 2 * Math.atan(Math.tan(res.vfovDeg * DEG / 2) * SIZE[0] / SIZE[1]) / DEG;
            expect(got).toBeGreaterThanOrEqual(1.0 - 1e-9);
            expect(got).toBeLessThanOrEqual(170.0 + 1e-9);
        }
        expect(accepted).toBeGreaterThan(0);   // the sweep must actually exercise the path
    });

    test("reports range spread, and calls a clustered set out", () => {
        const wide = fit(synthesise(CAM, spreadWorld()));
        expect(wide.diagnostics.rangeSpread).toBeGreaterThan(1.0);
        expect(wide.diagnostics.dltRankRatio).toBeGreaterThan(1e-3);

        const tight = [];
        for (let i = 0; i < 8; i++) {
            tight.push(llaToEcef(43.1288 + (i % 4) * 0.0016, 11.3495 + Math.floor(i / 4) * 0.0021, 126));
        }
        const near = fit(synthesise(CAM, tight));
        expect(near.ok).toBe(true);
        expect(near.diagnostics.rangeSpread).toBeLessThan(wide.diagnostics.rangeSpread);
        expect(near.observability).toMatch(/Unobservable|Weak/);
    });
});

describe("plane homography — must reject", () => {

    test("fewer than four points", () => {
        const res = fit(synthesise(CAM, spreadWorld(8)).slice(0, 3));
        expect(res.ok).toBe(false);
        expect(res.reason).toMatch(/at least 4/);
    });

    test("mismatched correspondences", () => {
        // Two pixels swapped — the commonest real mistake, and previously accepted with
        // ok:true, "Good (range spread 5.3x)" and a 46,700 px reprojection error.
        const points = synthesise(CAM, spreadWorld()).map((p) => ({...p}));
        const t = points[0].px; points[0].px = points[6].px; points[6].px = t;
        const res = fit(points);
        expect(res.ok).toBe(false);
        expect(res.reason).toMatch(/focal length|matched/);
    });

    test("control points collinear in the image", () => {
        const world = [];
        for (let i = 0; i < 6; i++) world.push(llaToEcef(43.130 + i * 0.006, 11.30 - i * 0.012, 125));
        const res = fit(synthesise(CAM, world));
        expect(res.ok).toBe(false);
        expect(res.reason).toMatch(/degenerate|collinear|line/);
    });

    test("control points collinear seen from above", () => {
        const world = [];
        for (let i = 0; i < 6; i++) world.push(llaToEcef(43.130 + i * 0.005, 11.32 - i * 0.010, 120 + i * 30));
        const res = fit(synthesise(CAM, world));
        expect(res.ok).toBe(false);
        expect(res.reason).toMatch(/line|degenerate|collinear/);
    });

    test("a field of view outside the searched range", () => {
        const far = llaToEcef(43.130, 11.390, 30000);
        const narrow = makeCamera(far, 273.285, -8.025, 0, 0.28);
        const world = [];
        for (let i = 0; i < 8; i++) {
            const t = i / 7;
            world.push(llaToEcef(43.128 + t * 0.0016, 11.30 - t * 0.0032 + (i % 2) * 0.0002, 125));
        }
        const res = fit(synthesise(narrow, world),
            {position: far, azDeg: 273, elDeg: -8, rollDeg: 0, vfovDeg: 0.28});
        expect(res.ok).toBe(false);
        // Must name the real cause, and point at the solver that can handle it.
        expect(res.reason).toMatch(/3D points method/);
    });

    test("missing image size", () => {
        const res = fitCameraByPlaneHomography({
            points: synthesise(CAM, spreadWorld()), imageSize: null, localFrame, initial: INITIAL,
        });
        expect(res.ok).toBe(false);
    });

    test("never returns ok with control points behind the camera", () => {
        // Sweep a range of layouts; any accepted result must have every point in front, which
        // is what a finite per-point distance means.
        for (let k = 0; k < 12; k++) {
            const world = [];
            for (let i = 0; i < 7; i++) {
                const t = i / 6;
                world.push(llaToEcef(43.126 + t * (0.01 + k * 0.006),
                    11.30 - t * (0.02 + k * 0.009) + (i % 2) * 0.003, 120 + (i % 3) * 5));
            }
            const pts = synthesise(CAM, world);
            const res = fit(pts);
            if (res.ok) {
                for (const p of res.perPoint) expect(Number.isFinite(p.distance)).toBe(true);
                expect(res.rms).toBeLessThan(1e4);
            }
        }
    });
});
