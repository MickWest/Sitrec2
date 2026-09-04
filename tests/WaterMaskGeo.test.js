// The projection arithmetic behind the geographic water mask.
//
// Worth testing on its own for the same reason OSMWaterTileMapping is: an error
// here does not throw, it silently offsets the whole coastline, and a shoreline
// in slightly the wrong place looks entirely plausible.

import {CGeoWaterMask, clampLatitude, maskZoomForSpan, mercatorX, mercatorY} from "../src/WaterMaskGeo";

describe("normalised Web Mercator", () => {

    test("longitude maps 180W..180E onto 0..1", () => {
        expect(mercatorX(-180)).toBeCloseTo(0, 12);
        expect(mercatorX(0)).toBeCloseTo(0.5, 12);
        expect(mercatorX(180)).toBeCloseTo(1, 12);
    });

    test("the equator is halfway down and north is up", () => {
        expect(mercatorY(0)).toBeCloseTo(0.5, 12);
        expect(mercatorY(45)).toBeLessThan(0.5);
        expect(mercatorY(-45)).toBeGreaterThan(0.5);
    });

    test("agrees with the standard slippy-tile formula", () => {
        // Checked against the OSM tile-numbering formula written out
        // independently, not against this module's own output: the mask has to
        // land on the SAME grid the vector tiles are cut on, and a projection
        // that is merely self-consistent would offset every coastline.
        const slippy = (lat, lon, z) => {
            const r = lat * Math.PI / 180;
            const n = 2 ** z;
            return [
                Math.floor((lon + 180) / 360 * n),
                Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n),
            ];
        };
        for (const [lat, lon, z] of [[34.01, -118.50, 12], [51.5, -0.13, 14], [-33.87, 151.21, 9]]) {
            const n = 2 ** z;
            const [sx, sy] = slippy(lat, lon, z);
            expect(Math.floor(mercatorX(lon) * n)).toBe(sx);
            expect(Math.floor(mercatorY(lat) * n)).toBe(sy);
        }
    });

    test("round-trips through the inverse the shader uses", () => {
        // The shader goes the other way: lat -> my. Check the pair agree, since
        // one is JavaScript and the other GLSL and only this test sees both.
        for (const lat of [-60, -34, 0, 12.5, 34.01, 71]) {
            const my = mercatorY(lat);
            const back = (2 * Math.atan(Math.exp((0.5 - my) * 2 * Math.PI)) - Math.PI / 2) * 180 / Math.PI;
            expect(back).toBeCloseTo(lat, 9);
        }
    });

    test("clamps past the poles rather than returning infinity", () => {
        expect(Number.isFinite(mercatorY(90))).toBe(true);
        expect(Number.isFinite(mercatorY(-90))).toBe(true);
    });
});

describe("mask zoom", () => {

    test("a wider region drops to a coarser zoom", () => {
        const near = maskZoomForSpan(3000, 34);
        const far = maskZoomForSpan(30000, 34);
        expect(far).toBeLessThan(near);
    });

    test("never asks for a zoom the vector source does not serve", () => {
        expect(maskZoomForSpan(10, 34)).toBeLessThanOrEqual(14);
    });

    test("the chosen zoom covers the span in a handful of tiles", () => {
        // The whole point of choosing a zoom rather than using the deepest one:
        // a 12 km mask must not cost fifty tile fetches against a metered key.
        for (const span of [2000, 6000, 12000, 24000, 40000]) {
            const z = maskZoomForSpan(span, 34);
            const tileMetres = 40075016.686 * Math.cos(34 * Math.PI / 180) / (1 << z);
            const across = span / tileMetres;
            // Two across by design, plus one because the square is not aligned
            // to the tile grid, and squared because it is a square.
            expect(Math.ceil(across) + 1).toBeLessThanOrEqual(4);
        }
    });

    test("a tile still resolves a coastline at the coarsest zoom it picks", () => {
        const z = maskZoomForSpan(40000, 34);
        expect(z).toBeGreaterThanOrEqual(6);
    });
});

describe("guards", () => {

    test("latitude is held inside mercator's range", () => {
        expect(clampLatitude(90)).toBeLessThan(90);
        expect(clampLatitude(-90)).toBeGreaterThan(-90);
        expect(clampLatitude(34.01)).toBe(34.01);
    });

    test("a pole does not blow the region up to the whole planet", () => {
        // The region's width in mercator is span / (world * cos(lat)), so an
        // unclamped pole divides by zero and asks a metered source for every
        // tile on Earth. Both the zoom and the width come off the same clamp.
        const lat = clampLatitude(90);
        const z = maskZoomForSpan(12000, 90);
        const n = 2 ** z;
        const du = 12000 / (40075016.686 * Math.cos(lat * Math.PI / 180));
        expect(Math.ceil(du * n) + 1).toBeLessThanOrEqual(4);
    });
});

describe("the antimeridian", () => {

    // The shader's own coordinate, written out here because only this test sees
    // both ends of it: uv.x = fract(mx - u0) / du.
    const shaderU = (lonDeg, u0, du) => {
        const d = mercatorX(lonDeg) - u0;
        return (d - Math.floor(d)) / du;
    };

    test("a mask centred on 180 covers both sides of it", () => {
        const du = 12000 / (40075016.686 * Math.cos(50 * Math.PI / 180));
        const u0 = mercatorX(179.99) - du / 2;   // straddles the wrap
        // Just west of the line (179.999E) and just east of it (179.999W) are a
        // few hundred metres apart, so both must land inside the same mask.
        expect(shaderU(179.999, u0, du)).toBeGreaterThan(0);
        expect(shaderU(179.999, u0, du)).toBeLessThan(1);
        expect(shaderU(-179.999, u0, du)).toBeGreaterThan(0);
        expect(shaderU(-179.999, u0, du)).toBeLessThan(1);
        // And they are on opposite sides of the centre, not folded together.
        expect(shaderU(179.999, u0, du)).toBeLessThan(shaderU(-179.999, u0, du));
    });

    test("somewhere else on Earth is still outside the mask", () => {
        const du = 12000 / (40075016.686 * Math.cos(50 * Math.PI / 180));
        const u0 = mercatorX(179.99) - du / 2;
        for (const lon of [0, -118.5, 90, -90, 170, -170]) {
            expect(shaderU(lon, u0, du)).toBeGreaterThan(1);
        }
    });

    test("agrees with a plain subtraction away from the wrap", () => {
        const du = 12000 / (40075016.686 * Math.cos(34 * Math.PI / 180));
        const u0 = mercatorX(-118.5) - du / 2;
        for (const lon of [-118.52, -118.5, -118.48]) {
            expect(shaderU(lon, u0, du)).toBeCloseTo((mercatorX(lon) - u0) / du, 6);
        }
    });
});

describe("retry after a failed tile", () => {

    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test("asks for a frame once the deadline passes", () => {
        // The deadline alone is not enough: _needsRebuild is only polled from
        // the render path, and a settled scene (Wave Speed 0) draws no frames.
        // Something has to request the frame that will notice the deadline.
        const onReady = jest.fn();
        const mask = new CGeoWaterMask(onReady);
        mask._scheduleRetry();
        expect(onReady).not.toHaveBeenCalled();
        jest.advanceTimersByTime(5000);
        expect(onReady).toHaveBeenCalledTimes(1);
    });

    test("one timer at a time", () => {
        const onReady = jest.fn();
        const mask = new CGeoWaterMask(onReady);
        mask._scheduleRetry();
        mask._scheduleRetry();
        mask._scheduleRetry();
        jest.advanceTimersByTime(5000);
        expect(onReady).toHaveBeenCalledTimes(1);
    });

    test("a disposed mask does not wake the renderer", () => {
        const onReady = jest.fn();
        const mask = new CGeoWaterMask(onReady);
        mask._scheduleRetry();
        mask.dispose();
        jest.advanceTimersByTime(5000);
        expect(onReady).not.toHaveBeenCalled();
    });
});
