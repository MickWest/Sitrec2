import {PerspectiveCamera, Vector3} from "three";
import {computeTrackFraming} from "../src/CameraFraming";

// A patch of Earth to lay test scenes out on. Points are built in a local
// East/North/Up frame around it and converted to the ECEF-like world coordinates the
// framing works in, because "up" being a different direction at every point is the
// whole reason the framing takes an up vector rather than assuming +Y.
const EARTH_RADIUS = 6371000;
const SITE_LAT = 37 * Math.PI / 180;
const SITE_LON = -121 * Math.PI / 180;

const SITE_UP = new Vector3(
    Math.cos(SITE_LAT) * Math.cos(SITE_LON),
    Math.cos(SITE_LAT) * Math.sin(SITE_LON),
    Math.sin(SITE_LAT));
const SITE_EAST = new Vector3(-Math.sin(SITE_LON), Math.cos(SITE_LON), 0);
const SITE_NORTH = new Vector3().crossVectors(SITE_UP, SITE_EAST).negate();
const SITE_ORIGIN = SITE_UP.clone().multiplyScalar(EARTH_RADIUS);

// east/north/up metres -> world position
function at(east, north, up) {
    return SITE_ORIGIN.clone()
        .add(SITE_EAST.clone().multiplyScalar(east))
        .add(SITE_NORTH.clone().multiplyScalar(north))
        .add(SITE_UP.clone().multiplyScalar(up));
}

// A 16:9-ish view, the shape the main view actually has.
const FOV_DEG = 30;
const ASPECT = 1.1;
const TAN_V = Math.tan(FOV_DEG * Math.PI / 360);
const TAN_H = TAN_V * ASPECT;
const OPTIONS = {tanH: TAN_H, tanV: TAN_V, near: 1};

// Build the same camera three.js would from the returned pose, and project through
// it. This is the check that matters: not "the numbers look right" but "the points
// land on screen when a real camera is pointed this way".
function project(framing, points) {
    const camera = new PerspectiveCamera(FOV_DEG, ASPECT, 1, 1e9);
    camera.position.copy(framing.position);
    camera.up.copy(framing.up);
    camera.lookAt(framing.position.clone().add(framing.forward));
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();
    return points.map(p => p.clone().project(camera));
}

function meanX(ndc) {
    return ndc.reduce((sum, p) => sum + p.x, 0) / ndc.length;
}

// Look-down angle at the camera itself, which is what the view reads out.
function depressionDeg(framing) {
    const upAtCamera = framing.position.clone().normalize();
    return -Math.asin(framing.forward.dot(upAtCamera)) * 180 / Math.PI;
}

describe("computeTrackFraming", () => {

    // A sensor flying a straight line with its target off to one side, which is the
    // shape the left/right rule was written for.
    const platform = [];
    for (let i = 0; i <= 20; i++) platform.push(at(-6000, -3000 + i * 300, 3000));
    const target = [];
    for (let i = 0; i <= 20; i++) target.push(at(6000 + i * 50, i * 100, 1200));

    test("puts the platform left of the target and both on screen", () => {
        const framing = computeTrackFraming(platform, target, SITE_UP, OPTIONS);
        expect(framing).not.toBeNull();

        const left = project(framing, platform);
        const right = project(framing, target);
        expect(meanX(left)).toBeLessThan(meanX(right));

        for (const p of left.concat(right)) {
            expect(Math.abs(p.x)).toBeLessThanOrEqual(1);
            expect(Math.abs(p.y)).toBeLessThanOrEqual(1);
            expect(p.z).toBeLessThan(1);          // in front of the camera
        }
    });

    test("keeps the ordering when the target is on the other side", () => {
        const mirrored = target.map(p => {
            const offset = p.clone().sub(SITE_ORIGIN);
            const east = offset.dot(SITE_EAST);
            return at(-12000 - east, offset.dot(SITE_NORTH), offset.dot(SITE_UP));
        });
        const framing = computeTrackFraming(platform, mirrored, SITE_UP, OPTIONS);
        expect(meanX(project(framing, platform)))
            .toBeLessThan(meanX(project(framing, mirrored)));
    });

    // The separation being small is not a reason to substitute a compass direction
    // for it: whatever it is, it is the only thing that says which track is which.
    test("respects a separation far smaller than the tracks themselves", () => {
        const orbit = [];
        for (let i = 0; i < 60; i++) {
            const a = i * Math.PI / 30;
            orbit.push(at(2000 * Math.cos(a), 2000 * Math.sin(a), 6000));
        }
        const nearlyBelow = [at(30, 0, 1000), at(35, 5, 1010)];
        const framing = computeTrackFraming(orbit, nearlyBelow, SITE_UP, OPTIONS);
        expect(meanX(project(framing, orbit)))
            .toBeLessThan(meanX(project(framing, nearlyBelow)));
    });

    test("looks down, within the stated band", () => {
        for (const scene of [
            [platform, target],
            [platform, []],
            [[at(0, 0, 3000)], [at(0, 0, 500)]],           // straight above
            [[at(-20000, 0, 9000)], [at(20000, 0, 900)]],  // 40 km apart
        ]) {
            const framing = computeTrackFraming(scene[0], scene[1], SITE_UP, OPTIONS);
            expect(framing).not.toBeNull();
            expect(framing.tiltDeg).toBeGreaterThanOrEqual(15);
            expect(framing.tiltDeg).toBeLessThanOrEqual(30);
            // The pose is built against up at the SCENE, so the angle at the camera
            // drifts with distance. It must still be a downward look.
            expect(depressionDeg(framing)).toBeGreaterThan(10);
        }
    });

    test("a single track reads start-left to end-right", () => {
        const framing = computeTrackFraming(platform, [], SITE_UP, OPTIONS);
        const ndc = project(framing, platform);
        expect(ndc[0].x).toBeLessThan(ndc[ndc.length - 1].x);
        for (const p of ndc) expect(Math.abs(p.x)).toBeLessThanOrEqual(1);
    });

    // Degenerate inputs must produce a usable pose, not NaN. A stationary sensor
    // watching a hovering target really is a single pair of points.
    test("survives a scene with no extent", () => {
        const one = [at(0, 0, 2000)];
        const framing = computeTrackFraming(one, one, SITE_UP, OPTIONS);
        expect(framing).not.toBeNull();
        for (const v of [framing.position, framing.forward, framing.up]) {
            expect(Number.isFinite(v.x)).toBe(true);
            expect(Number.isFinite(v.y)).toBe(true);
            expect(Number.isFinite(v.z)).toBe(true);
        }
        // Backed off far enough to see something, not parked on top of the point.
        expect(framing.distance).toBeGreaterThan(500);
        const ndc = project(framing, one);
        expect(Math.abs(ndc[0].x)).toBeLessThanOrEqual(1);
    });

    // A fit that samples the track cannot promise to contain it. The outlier below
    // sits at index 401 of 1500, which a 400-sample budget stepping by 4 walks
    // straight past — and it is exactly the point that decides the framing.
    test("contains an outlier no sampling scheme would have picked", () => {
        const long = [];
        for (let i = 0; i < 1500; i++) long.push(at(-8000 + i * 8, 0, 3000));
        long[401] = at(-4800, 30000, 7000);

        // Fitting the sample instead of the track really does lose it — this is the
        // failure the test is guarding against, shown rather than assumed.
        const sampled = long.filter((point, i) => i % 4 === 0);
        const fromSample = project(computeTrackFraming(sampled, target, SITE_UP, OPTIONS), long);
        expect(fromSample.some(p => Math.abs(p.x) > 1 || Math.abs(p.y) > 1)).toBe(true);

        for (const p of project(computeTrackFraming(long, target, SITE_UP, OPTIONS), long)) {
            expect(Math.abs(p.x)).toBeLessThanOrEqual(1);
            expect(Math.abs(p.y)).toBeLessThanOrEqual(1);
        }
    });

    // The fit has to be snug: at least one point should be right up against the
    // margin, or the camera has simply backed off further than it needed to.
    test("is tight against the margin, not merely far enough away", () => {
        const ndc = project(computeTrackFraming(platform, target, SITE_UP, OPTIONS),
            platform.concat(target));
        const widest = Math.max(...ndc.map(p => Math.max(Math.abs(p.x), Math.abs(p.y))));
        expect(widest).toBeGreaterThan(0.75);
        expect(widest).toBeLessThanOrEqual(1);
    });

    test("returns null when there is nothing to frame", () => {
        expect(computeTrackFraming([], [], SITE_UP, OPTIONS)).toBeNull();
        expect(computeTrackFraming(platform, [], SITE_UP, {tanH: 0, tanV: 0})).toBeNull();
    });
});
