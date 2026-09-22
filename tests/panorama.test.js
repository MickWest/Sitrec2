import {PerspectiveCamera, Sphere, Vector3} from "three";
import {
    panoramaDirection, panoramaFaceCamera, panoramaFaces, panoramaFrame, panoramaFrusta,
    panoramaIntersectsSphere, panoramaPixelsPerRadian, panoramaProject,
} from "../src/rendering/PanoramaMath";

const camera = new PerspectiveCamera(30, 2, 0.1, 1e6);
camera.updateMatrixWorld(true);

test.each([[180, 1600, 900, 101.25, 900], [360, 1600, 900, 180, 800],
    [360, 800, 1200, 180, 400], [360, 2400, 600, 90, 600], [90, 600, 1200, 180, 1200],
    [1, 1600, 900, 0.5625, 900]])(
    "%s degrees in a %s × %s pane keeps equal pixels per degree", (hfov, width, height, vfov, fittedHeight) => {
        const frame = panoramaFrame(hfov, width, height);
        expect(frame.width).toBe(width);
        expect(frame.vfov).toBeCloseTo(vfov);
        expect(frame.height).toBeCloseTo(fittedHeight);
        expect(frame.width / hfov).toBeCloseTo(frame.height / frame.vfov);
        expect(frame.height).toBeLessThanOrEqual(height);
    });

test.each([[1, 1], [90, 60], [180, 90], [280, 120], [360, 180]])(
    "%s × %s angular projection round trips through the rear seam and poles", (h, v) => {
        for (const x of [-0.999, -0.6, 0, 0.7, 0.999]) for (const y of [-0.999, -0.5, 0, 0.8, 0.999]) {
            const point = panoramaDirection(x, y, h, v).multiplyScalar(500);
            panoramaProject(point, h, v);
            expect(point.x).toBeCloseTo(x, 10);
            expect(point.y).toBeCloseTo(y, 10);
            expect(point.z).toBeCloseTo(500, 10);
        }
    });

test.each([[1, 1], [1, 180], [360, 1], [89, 70], [91, 72], [180, 90], [280, 120], [360, 180]])(
    "%s × %s capture rectangles cover every output ray", (h, v) => {
        const faces = panoramaFaces(h, v).map(face => ({...face, camera: panoramaFaceCamera(face, camera)}));
        expect(faces.length).toBeLessThanOrEqual(6);
        for (let ix = 0; ix <= 40; ix++) for (let iy = 0; iy <= 40; iy++) {
            const ray = panoramaDirection(ix / 20 - 1, iy / 20 - 1, h, v);
            const max = Math.max(Math.abs(ray.x), Math.abs(ray.y), Math.abs(ray.z));
            const owner = faces.find(face => ray.dot(face.forward) >= max - 1e-10);
            expect(owner).toBeDefined();
            const p = ray.clone().multiplyScalar(100).project(owner.camera);
            expect(Math.abs(p.x)).toBeLessThanOrEqual(1.000001);
            expect(Math.abs(p.y)).toBeLessThanOrEqual(1.000001);
            // Sky/reflection code can rebuild this camera's projection.
            owner.camera.updateProjectionMatrix();
            expect(ray.clone().multiplyScalar(100).project(owner.camera).distanceTo(p)).toBeLessThan(1e-8);
        }
    });

test("a narrow vertical window captures a strip, not six full cube faces", () => {
    const faces = panoramaFaces(360, 10);
    expect(faces).toHaveLength(4);
    for (const {bounds: [l, r, b, t]} of faces) {
        expect(r - l).toBeCloseTo(2);
        expect(t - b).toBeLessThan(0.25);
    }
    expect(panoramaFaces(10, 10)).toHaveLength(1);
});

function sphere(lon, lat, radius = 1) {
    return new Sphere(panoramaDirection(lon / 180, lat / 90, 360, 180).multiplyScalar(1000), radius);
}

test("tile visibility includes side/rear tiles only when the selected angles cover them", () => {
    expect(panoramaIntersectsSphere(sphere(85, 0), camera, 180, 30)).toBe(true);
    expect(panoramaIntersectsSphere(sphere(100, 0), camera, 180, 30)).toBe(false);
    expect(panoramaIntersectsSphere(sphere(0, 20), camera, 360, 30)).toBe(false);
    expect(panoramaIntersectsSphere(sphere(179, 0), camera, 360, 30)).toBe(true);
    expect(panoramaIntersectsSphere(sphere(-179, 0), camera, 360, 30)).toBe(true);
    expect(panoramaIntersectsSphere(sphere(179, 0), camera, 280, 30)).toBe(false);
    expect(panoramaIntersectsSphere(sphere(0, 89), camera, 360, 180)).toBe(true);
    // Volumes straddling an edge must still load.
    expect(panoramaIntersectsSphere(sphere(91, 0, 30), camera, 180, 30)).toBe(true);
});

test("widening the panorama reduces tile detail at fixed output dimensions", () => {
    const tile = sphere(0, 0);
    const narrow = panoramaPixelsPerRadian(tile, camera, 1600, 800, 90, 45);
    const wide = panoramaPixelsPerRadian(tile, camera, 1600, 800, 360, 180);
    expect(wide).toBeCloseTo(narrow / 4);
    expect(panoramaPixelsPerRadian(tile, camera, 3200, 1600, 360, 180)).toBeCloseTo(wide * 2);
});

test("extra letterbox height does not request finer tiles", () => {
    const tile = sphere(0, 0);
    const frames = [400, 800, 1600].map(height => panoramaFrame(360, 800, height));
    const errors = frames.map(f => panoramaPixelsPerRadian(tile, camera, f.width, f.height, 360, f.vfov));
    expect(errors[0]).toBeCloseTo(errors[1]);
    expect(errors[0]).toBeCloseTo(errors[2]);
});

test("visibility and capture frusta follow the camera pose", () => {
    const rotated = camera.clone();
    rotated.position.set(100, 200, 300);
    rotated.rotation.set(0.3, 1.2, 0.2);
    rotated.updateMatrixWorld(true);
    const s = sphere(80, 10).applyMatrix4(rotated.matrixWorld);
    expect(panoramaIntersectsSphere(s, rotated, 180, 60)).toBe(true);
    expect(panoramaFrusta(rotated, 180, 60).some(f => f.intersectsSphere(s))).toBe(true);
    expect(panoramaIntersectsSphere(s, rotated, 90, 60)).toBe(false);
});
