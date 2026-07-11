/**
 * Tests for the stationary-point and ground-vehicle fits
 * (src/TraverseAnalysis.js: fitFixedPoint, fitGroundVehicle).
 *
 * These are the SHARED cores behind both the analysis gallery's
 * "Stationary Point in Space" / "Ground Object" / "Ground Vehicle" tiles and
 * the live traverse methods "Global Fit: Stationary Point" /
 * "Global Fit: Ground Object" / "Ground Vehicle" — one implementation, so
 * "Use This" reproduces the tile exactly. Pure math, no three.js/node graph.
 *
 * Regression context: applying a stationary tile used to select the Constant
 * Ground Speed traverse at 0 kt, which CANNOT hold a fixed point (walking the
 * rays at speed 0 still moves by the rays' closest-approach distance every
 * frame → drift + white over-speed flags). The dedicated fixed-point track
 * must be exactly constant.
 */

import {fitFixedPoint, fitGroundPoint, fitGroundVehicle, EARTH_RADIUS_M} from "../src/TraverseAnalysis";

// height of the curved ground surface (tangent-plane height gz) at ENU (x, y)
const curvedZ = (gz, x, y) => gz - (x * x + y * y) / (2 * EARTH_RADIUS_M);

// Rays from a moving sensor, all passing exactly through point P (ENU metres).
function raysThroughPoint(P, {n = 300} = {}) {
    const S = new Float64Array(n * 3);
    const D = new Float64Array(n * 3);
    for (let f = 0; f < n; f++) {
        // curving, climbing sensor path — enough geometry to pin the point
        const sx = Math.sin(f * 0.01) * 1500;
        const sy = f * 4;
        const sz = 900 + f * 0.2;
        S[f * 3] = sx; S[f * 3 + 1] = sy; S[f * 3 + 2] = sz;
        let dx = P[0] - sx, dy = P[1] - sy, dz = P[2] - sz;
        const l = Math.hypot(dx, dy, dz);
        D[f * 3] = dx / l; D[f * 3 + 1] = dy / l; D[f * 3 + 2] = dz / l;
    }
    return {n, fps: 30, S, D, W: new Float64Array(n * 3)};
}

describe("fitFixedPoint (stationary point)", () => {

    test("recovers a known fixed point from converging sightlines", () => {
        const P = [500, 2500, 300];
        const ds = raysThroughPoint(P);
        const fit = fitFixedPoint(ds, {});
        expect(fit.point[0]).toBeCloseTo(P[0], 4);
        expect(fit.point[1]).toBeCloseTo(P[1], 4);
        expect(fit.point[2]).toBeCloseTo(P[2], 4);
        expect(fit.errDeg).toBeLessThan(1e-6);
    });

    test("track is EXACTLY constant — the property speed-0 ray-walking lacks", () => {
        const ds = raysThroughPoint([500, 2500, 300]);
        const {track} = fitFixedPoint(ds, {});
        for (let f = 1; f < ds.n; f++) {
            expect(track[f * 3]).toBe(track[0]);
            expect(track[f * 3 + 1]).toBe(track[1]);
            expect(track[f * 3 + 2]).toBe(track[2]);
        }
    });

    test("distance is the mean sensor-to-point range", () => {
        const P = [500, 2500, 300];
        const ds = raysThroughPoint(P);
        const fit = fitFixedPoint(ds, {});
        let sum = 0;
        for (let f = 0; f < ds.n; f++) {
            sum += Math.hypot(P[0] - ds.S[f * 3], P[1] - ds.S[f * 3 + 1], P[2] - ds.S[f * 3 + 2]);
        }
        expect(fit.distance).toBeCloseTo(sum / ds.n, 3);
    });

    test("z pin recovers a sea-level point (the Ground Object fit)", () => {
        const P = [800, 1800, 0];
        const ds = raysThroughPoint(P);
        const fit = fitFixedPoint(ds, {z: 0});
        expect(fit.point[0]).toBeCloseTo(P[0], 3);
        expect(fit.point[1]).toBeCloseTo(P[1], 3);
        expect(fit.point[2]).toBe(0);
        expect(fit.errDeg).toBeLessThan(1e-6);
    });

    test("z pin on an elevated object stays pinned and reports honest error", () => {
        const ds = raysThroughPoint([800, 1800, 400]);   // truth well above z=0
        const fit = fitFixedPoint(ds, {z: 0});
        expect(fit.point[2]).toBe(0);
        expect(fit.errDeg).toBeGreaterThan(0.5);         // rays don't meet the plane point
    });

    test("degenerate parallel rays fall back without NaNs", () => {
        const n = 100;
        const S = new Float64Array(n * 3), D = new Float64Array(n * 3);
        for (let f = 0; f < n; f++) {
            S[f * 3] = f; S[f * 3 + 1] = 0; S[f * 3 + 2] = 100;
            D[f * 3] = 0; D[f * 3 + 1] = 1; D[f * 3 + 2] = 0;   // all due north
        }
        const fit = fitFixedPoint({n, fps: 30, S, D, W: new Float64Array(n * 3)}, {});
        for (const v of fit.point) expect(Number.isFinite(v)).toBe(true);
        for (let i = 0; i < fit.track.length; i++) expect(Number.isFinite(fit.track[i])).toBe(true);
    });
});

describe("fitGroundVehicle (sightline meets the curved ground surface)", () => {

    // Sensor at altitude looks at a target moving ON the curved surface
    // z(x,y) = gz - rho^2/2R (the real ground falls away from the tangent
    // plane; the fit intersects that curved surface, not a flat plane).
    function groundScenario(gz, {n = 240} = {}) {
        const S = new Float64Array(n * 3);
        const D = new Float64Array(n * 3);
        const T = [];
        for (let f = 0; f < n; f++) {
            const sx = -500 + f, sy = -2000, sz = 1200;
            const tx = 100 + f * 2, ty = 500 + f;
            const t = [tx, ty, curvedZ(gz, tx, ty)];   // vehicle ON the surface
            T.push(t);
            S[f * 3] = sx; S[f * 3 + 1] = sy; S[f * 3 + 2] = sz;
            let dx = t[0] - sx, dy = t[1] - sy, dz = t[2] - sz;
            const l = Math.hypot(dx, dy, dz);
            D[f * 3] = dx / l; D[f * 3 + 1] = dy / l; D[f * 3 + 2] = dz / l;
        }
        return {ds: {n, fps: 30, S, D, W: new Float64Array(n * 3)}, T};
    }

    test("recovers the moving ground target, fracValid = 1", () => {
        const gz = 50;
        const {ds, T} = groundScenario(gz);
        const fit = fitGroundVehicle(ds, gz);
        expect(fit.fracValid).toBe(1);
        for (let f = 0; f < ds.n; f++) {
            expect(fit.track[f * 3]).toBeCloseTo(T[f][0], 4);
            expect(fit.track[f * 3 + 1]).toBeCloseTo(T[f][1], 4);
            expect(fit.track[f * 3 + 2]).toBeCloseTo(T[f][2], 4);
        }
    });

    test("sightlines above the horizon never reach the ground: fracValid = 0", () => {
        const n = 100;
        const S = new Float64Array(n * 3), D = new Float64Array(n * 3);
        for (let f = 0; f < n; f++) {
            S[f * 3] = f; S[f * 3 + 1] = 0; S[f * 3 + 2] = 500;
            D[f * 3] = 0; D[f * 3 + 1] = 0.8; D[f * 3 + 2] = 0.6;   // pointing UP
        }
        const fit = fitGroundVehicle({n, fps: 30, S, D, W: new Float64Array(n * 3)}, 0);
        expect(fit.fracValid).toBe(0);
    });

    test("frames past the horizon hold the last valid ground position", () => {
        const gz = 0;
        const n = 100;
        const S = new Float64Array(n * 3), D = new Float64Array(n * 3);
        for (let f = 0; f < n; f++) {
            S[f * 3] = 0; S[f * 3 + 1] = 0; S[f * 3 + 2] = 1000;
            if (f < 50) {   // looking down at a point ON the curved surface
                const tx = f, ty = 2000;
                let dx = tx, dy = ty, dz = curvedZ(gz, tx, ty) - 1000;
                const l = Math.hypot(dx, dy, dz);
                D[f * 3] = dx / l; D[f * 3 + 1] = dy / l; D[f * 3 + 2] = dz / l;
            } else {        // then panning up above the horizon
                D[f * 3] = 0; D[f * 3 + 1] = 1; D[f * 3 + 2] = 0.1;
            }
        }
        const fit = fitGroundVehicle({n, fps: 30, S, D, W: new Float64Array(n * 3)}, gz);
        expect(fit.fracValid).toBeCloseTo(0.5, 5);
        // held at the frame-49 intersection for every subsequent frame
        for (let f = 50; f < n; f++) {
            expect(fit.track[f * 3]).toBeCloseTo(49, 4);
            expect(fit.track[f * 3 + 1]).toBeCloseTo(2000, 4);
        }
    });
});

describe("fitGroundPoint (stationary light on the curved surface)", () => {

    test("recovers a stationary point ON the curved surface at range", () => {
        const gz = 20;
        const px = 12000, py = 9000;                  // ~15 km out: ~17.6 m drop
        const P = [px, py, curvedZ(gz, px, py)];
        const ds = (() => {   // rays through P from a moving elevated sensor
            const n = 300;
            const S = new Float64Array(n * 3), D = new Float64Array(n * 3);
            for (let f = 0; f < n; f++) {
                const sx = Math.sin(f * 0.01) * 1500, sy = f * 4, sz = 900;
                S[f * 3] = sx; S[f * 3 + 1] = sy; S[f * 3 + 2] = sz;
                let dx = P[0] - sx, dy = P[1] - sy, dz = P[2] - sz;
                const l = Math.hypot(dx, dy, dz);
                D[f * 3] = dx / l; D[f * 3 + 1] = dy / l; D[f * 3 + 2] = dz / l;
            }
            return {n, fps: 30, S, D, W: new Float64Array(n * 3)};
        })();
        const fit = fitGroundPoint(ds, gz);
        expect(fit.point[0]).toBeCloseTo(P[0], 0);
        expect(fit.point[1]).toBeCloseTo(P[1], 0);
        expect(fit.point[2]).toBeCloseTo(P[2], 1);
        expect(fit.errDeg).toBeLessThan(1e-4);
        // the flat z-pin would sit ~17.6 m off the surface and miss by far more
        const flat = fitFixedPoint(ds, {z: gz});
        expect(Math.abs(flat.point[2] - P[2])).toBeGreaterThan(10);
    });
});
