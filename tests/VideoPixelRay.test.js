import {Vector3} from "three";
import {videoPixelRay} from "../src/VideoPixelRay";

const OW = 1920;
const OH = 1080;
const VFOV = 30;
const DEG = 180 / Math.PI;

// Camera frame matching CNodeLOSFromCamera's convention: heading forward,
// right to the right, up up. Orthonormal.
function makeLOS() {
    return {heading: new Vector3(0, 0, -1), up: new Vector3(0, 1, 0), right: new Vector3(1, 0, 0)};
}

const ray = (vx, vy) => videoPixelRay(makeLOS(), VFOV, vx, vy, OW, OH);
const elevationDeg = v => Math.asin(v.y) * DEG;

// The yaw-then-pitch construction that Point Track used before it shared this
// function: rotate heading by atan(dx/fpx) about up, then by atan(dy/fpx) about
// the new right. Kept here only to measure what the change moved.
function eulerRay(vx, vy) {
    const {heading, up, right} = makeLOS();
    const fpx = OH / (2 * Math.tan(VFOV / DEG / 2));
    const xangle = -Math.atan((vx - OW / 2) / fpx);
    const yangle = -Math.atan((vy - OH / 2) / fpx);
    const newRight = right.clone().applyAxisAngle(up, xangle);
    return heading.clone().applyAxisAngle(up, xangle).applyAxisAngle(newRight, yangle);
}

test("the centre pixel is the camera heading, and the LOS is not modified", () => {
    const los = makeLOS();
    const result = videoPixelRay(los, VFOV, OW / 2, OH / 2, OW, OH);
    expect(result.distanceTo(new Vector3(0, 0, -1))).toBeLessThan(1e-15);
    expect(result).not.toBe(los.heading);
    expect(los.heading.toArray()).toEqual([0, 0, -1]);
    expect(los.up.toArray()).toEqual([0, 1, 0]);
    expect(los.right.toArray()).toEqual([1, 0, 0]);
});

test("the top and bottom centre pixels are half the vertical FOV off the heading", () => {
    expect(elevationDeg(ray(OW / 2, 0))).toBeCloseTo(VFOV / 2, 12);
    expect(elevationDeg(ray(OW / 2, OH))).toBeCloseTo(-VFOV / 2, 12);
});

test("image x is right and image y is down", () => {
    const corner = ray(OW, 0);
    expect(corner.x).toBeGreaterThan(0);
    expect(corner.y).toBeGreaterThan(0);
});

test("a straight image row maps to a plane of rays, as a pinhole does", () => {
    // Three pixels on the top row. Under a pinhole their rays are coplanar (zero
    // triple product); under the old yaw-then-pitch mapping they lie on a cone.
    const triple = (a, b, c) => a.dot(b.clone().cross(c));
    expect(triple(ray(0, 0), ray(OW / 2, 0), ray(OW, 0))).toBeCloseTo(0, 14);
    expect(Math.abs(triple(eulerRay(0, 0), eulerRay(OW / 2, 0), eulerRay(OW, 0)))).toBeGreaterThan(1e-3);
});

test("a corner pixel moved 1.40 degrees from the old yaw-then-pitch ray", () => {
    const fpx = OH / (2 * Math.tan(VFOV / DEG / 2));
    const pinhole = ray(0, 0);
    const euler = eulerRay(0, 0);

    // The old mapping put every top-row pixel at the full half-FOV elevation.
    expect(elevationDeg(euler)).toBeCloseTo(VFOV / 2, 12);
    // A pinhole puts a corner lower, as its ray is longer by hypot(fpx, dx) / fpx.
    expect(elevationDeg(pinhole)).toBeCloseTo(Math.atan((OH / 2) / Math.hypot(fpx, OW / 2)) * DEG, 12);
    expect(elevationDeg(pinhole)).toBeCloseTo(13.599, 3);

    const moved = 2 * Math.asin(pinhole.distanceTo(euler) / 2) * DEG;
    expect(moved).toBeCloseTo(1.401, 3);

    // The two mappings agree on the centre lines.
    expect(ray(0, OH / 2).distanceTo(eulerRay(0, OH / 2))).toBeLessThan(1e-15);
    expect(ray(OW / 2, 0).distanceTo(eulerRay(OW / 2, 0))).toBeLessThan(1e-15);
});

test("a video rotated 90 or 270 degrees uses the shown frame, not the coded one", () => {
    // Coded 1920x1080, shown 1080x1920 (a portrait phone clip). A tracker keeps a
    // shown pixel (xs, ys) as (xs * 1920/1080, ys * 1080/1920): the shown frame
    // stretched into the coded box (CNodeVideoView.videoToCanvasCoordsOriginal).
    const SW = OH, SH = OW;
    const fpx = SH / (2 * Math.tan(VFOV / DEG / 2));
    for (const rotation of [90, 270]) {
        for (const [xs, ys] of [[SW / 2, SH / 2], [SW, SH / 2], [810, 960], [0, 0], [SW, SH], [123.5, 1700.25]]) {
            const {heading, up, right} = makeLOS();
            const expected = heading.clone().multiplyScalar(fpx)
                .addScaledVector(right, xs - SW / 2).addScaledVector(up, -(ys - SH / 2)).normalize();
            const result = videoPixelRay(makeLOS(), VFOV, xs * OW / SW, ys * OH / SH, OW, OH, rotation);
            expect(result.distanceTo(expected)).toBeLessThan(1e-12);
        }
    }
    // The top centre of the shown frame is half the vertical FOV up.
    expect(elevationDeg(videoPixelRay(makeLOS(), VFOV, OW / 2, 0, OW, OH, 90))).toBeCloseTo(VFOV / 2, 12);
});

test("no rotation and a 180 degree rotation give exactly the unrotated result", () => {
    for (const [vx, vy] of [[0, 0], [OW, OH], [1700.5, 95.25]]) {
        const plain = ray(vx, vy).toArray();
        expect(videoPixelRay(makeLOS(), VFOV, vx, vy, OW, OH, 0).toArray()).toEqual(plain);
        expect(videoPixelRay(makeLOS(), VFOV, vx, vy, OW, OH, 180).toArray()).toEqual(plain);
    }
});
