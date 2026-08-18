import {
    angleBetween,
    angularSizeFromRange,
    endpointRangeFromAngularSize,
    focalLengthPixels,
    midpointRangeFromAngularSize,
    pinholeRay,
    speedBetween,
} from "../src/AngularSizeMath";

// Camera frame matching CNodeLOSFromCamera's convention: heading forward,
// right to the right, up up. Orthonormal.
const HEADING = [0, 0, -1];
const RIGHT = [1, 0, 0];
const UP = [0, 1, 0];

// The Malvern Hills case: 1920x1080 at the 22.76 degree vertical FOV of the
// test sitch.
const OW = 1920;
const OH = 1080;
const VFOV = 22.76125;

describe("focalLengthPixels", () => {
    test("matches the vertical FOV it was built from", () => {
        const fpx = focalLengthPixels(VFOV, OH);
        expect(fpx).toBeCloseTo(2682.78, 1);
        // half the frame height subtends half the FOV
        expect(Math.atan((OH / 2) / fpx) * 2 * 180 / Math.PI).toBeCloseTo(VFOV, 9);
    });

    test("90 degrees gives a focal length of half the height", () => {
        expect(focalLengthPixels(90, 1080)).toBeCloseTo(540, 9);
    });
});

describe("angleBetween", () => {
    test("is zero for identical directions", () => {
        expect(angleBetween([0, 0, -1], [0, 0, -1])).toBe(0);
    });

    test("handles perpendicular and opposite directions", () => {
        expect(angleBetween([1, 0, 0], [0, 1, 0])).toBeCloseTo(Math.PI / 2, 12);
        expect(angleBetween([1, 0, 0], [-1, 0, 0])).toBeCloseTo(Math.PI, 12);
    });

    test("does not require unit length inputs", () => {
        expect(angleBetween([5, 0, 0], [0, 0.001, 0])).toBeCloseTo(Math.PI / 2, 12);
    });

    test("stays accurate at the milliradian angles this is used at", () => {
        // A 20 pixel separation at a 2683 pixel focal length.
        const fpx = focalLengthPixels(VFOV, OH);
        const a = pinholeRay(HEADING, RIGHT, UP, fpx, 0, 0);
        const b = pinholeRay(HEADING, RIGHT, UP, fpx, 20, 0);
        expect(angleBetween(a, b)).toBeCloseTo(Math.atan(20 / fpx), 12);
    });

    test("returns NaN for a zero-length vector", () => {
        expect(angleBetween([0, 0, 0], [0, 0, -1])).toBeNaN();
    });
});

describe("pinholeRay", () => {
    test("the centre pixel looks straight down the heading", () => {
        const fpx = focalLengthPixels(VFOV, OH);
        expect(pinholeRay(HEADING, RIGHT, UP, fpx, 0, 0)).toEqual([0, 0, -1]);
    });

    test("a pixel right of centre yields a ray to the right, and below centre yields down", () => {
        const fpx = focalLengthPixels(VFOV, OH);
        const right = pinholeRay(HEADING, RIGHT, UP, fpx, 100, 0);
        expect(right[0]).toBeGreaterThan(0);

        // dy is measured downward in image coordinates
        const below = pinholeRay(HEADING, RIGHT, UP, fpx, 0, 100);
        expect(below[1]).toBeLessThan(0);
    });

    test("horizontal angle is exactly atan(dx/fpx)", () => {
        const fpx = focalLengthPixels(VFOV, OH);
        const centre = pinholeRay(HEADING, RIGHT, UP, fpx, 0, 0);
        const off = pinholeRay(HEADING, RIGHT, UP, fpx, 300, 0);
        expect(angleBetween(centre, off)).toBeCloseTo(Math.atan(300 / fpx), 12);
    });

    // The bug this module was written to avoid. A yaw-then-pitch construction gives
    // a vertical step the same angle everywhere; a real pinhole compresses it away
    // from the vertical centre line, because the ray to an off-axis pixel is longer.
    test("a vertical pixel step subtends LESS angle away from the centre line", () => {
        const fpx = focalLengthPixels(VFOV, OH);
        const step = 80;

        const angleAt = (dx) => angleBetween(
            pinholeRay(HEADING, RIGHT, UP, fpx, dx, 0),
            pinholeRay(HEADING, RIGHT, UP, fpx, dx, -step));

        const onAxis = angleAt(0);
        const atEdge = angleAt(OW / 2);

        expect(atEdge).toBeLessThan(onAxis);

        // The effective focal length in that plane is hypot(fpx, dx), not fpx
        expect(atEdge).toBeCloseTo(Math.atan(step / Math.hypot(fpx, OW / 2)), 12);

        // and the equirectangular mapping overstates it by 6.2% at the frame edge
        expect((onAxis / atEdge - 1) * 100).toBeCloseTo(6.21, 1);
    });
});

describe("range from angular size", () => {
    test("endpoint and midpoint ranges differ by cos(theta/2)", () => {
        const theta = 0.03;
        const S = 0.1;
        expect(midpointRangeFromAngularSize(theta, S))
            .toBeCloseTo(endpointRangeFromAngularSize(theta, S) * Math.cos(theta / 2), 12);
    });

    test("round-trips against angularSizeFromRange", () => {
        const S = 0.1;      // a 10cm blade of grass
        const R = 13.4;
        expect(endpointRangeFromAngularSize(angularSizeFromRange(R, S), S)).toBeCloseTo(R, 9);
    });

    test("range scales linearly with assumed size", () => {
        // The Metabunk analysis ran 10cm and 15cm; the 50% larger object has to be
        // 50% further away to look the same.
        const theta = 0.0075;
        const r10 = endpointRangeFromAngularSize(theta, 0.10);
        const r15 = endpointRangeFromAngularSize(theta, 0.15);
        expect(r15 / r10).toBeCloseTo(1.5, 12);
    });

    test("a 10cm object 20 pixels wide at the test sitch FOV is about 13.4m away", () => {
        const fpx = focalLengthPixels(VFOV, OH);
        const theta = angleBetween(
            pinholeRay(HEADING, RIGHT, UP, fpx, 0, 0),
            pinholeRay(HEADING, RIGHT, UP, fpx, 20, 0));
        expect(endpointRangeFromAngularSize(theta, 0.1)).toBeCloseTo(13.41, 2);
    });

    test("a zero or negative angle gives an infinite range rather than a bogus number", () => {
        expect(endpointRangeFromAngularSize(0, 0.1)).toBe(Infinity);
        expect(endpointRangeFromAngularSize(-1, 0.1)).toBe(Infinity);
        expect(endpointRangeFromAngularSize(NaN, 0.1)).toBe(Infinity);
    });

    test("a zero size gives an infinite range rather than zero", () => {
        expect(endpointRangeFromAngularSize(0.01, 0)).toBe(Infinity);
    });

    test("angularSizeFromRange rejects a segment longer than it could span", () => {
        expect(angularSizeFromRange(1, 10)).toBeNaN();
        expect(angularSizeFromRange(0, 0.1)).toBeNaN();
    });
});

describe("speedBetween", () => {
    test("distance over time", () => {
        expect(speedBetween([0, 0, 0], [3, 4, 0], 2)).toBeCloseTo(2.5, 12);
    });

    test("matches the Metabunk figure for a 10cm object", () => {
        // ~42.5 km/h over 10 frames at 240fps is a displacement of about 0.49m
        const dt = 10 / 240;
        const speed = speedBetween([0, 0, 0], [0.4919, 0, 0], dt);
        expect(speed * 3.6).toBeCloseTo(42.5, 1);
    });

    test("is direction agnostic and rejects a zero interval", () => {
        expect(speedBetween([1, 0, 0], [0, 0, 0], -2)).toBeCloseTo(0.5, 12);
        expect(speedBetween([0, 0, 0], [1, 0, 0], 0)).toBeNaN();
    });
});
