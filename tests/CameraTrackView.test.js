import {PerspectiveCamera, Vector3} from "three";
import {cameraTrackProjection, projectCameraPoint} from "../src/CameraTrackView";

const pose = {position: [0, 0, 0], forward: [0, 0, 1], right: [1, 0, 0], up: [0, 1, 0]};

test("perspective divides by depth and excludes points on or behind the camera", () => {
    expect(projectCameraPoint([2, 1, 10], pose)).toEqual({x: 0.2, y: 0.1, depth: 10});
    expect(projectCameraPoint([2, 1, 20], pose)).toEqual({x: 0.1, y: 0.05, depth: 20});
    expect(projectCameraPoint([2, 1, 0], pose)).toBeNull();
    expect(projectCameraPoint([2, 1, -10], pose)).toBeNull();
});

test("translated, rotated and rolled camera agrees with Three.js perspective", () => {
    const camera = new PerspectiveCamera(30, 1.6, 0.01, 10000);
    camera.position.set(100, -200, 300);
    camera.rotation.set(0.25, -0.6, 0.4);
    camera.updateMatrixWorld(true);
    const right = new Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const up = new Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    const forward = new Vector3().setFromMatrixColumn(camera.matrixWorld, 2).negate();
    const sampled = {position: camera.position.toArray(), right: right.toArray(), up: up.toArray(), forward: forward.toArray()};
    const point = camera.position.clone().addScaledVector(forward, 100).addScaledVector(right, 12).addScaledVector(up, -7);
    const projected = projectCameraPoint(point.toArray(), sampled);
    const expected = point.clone().project(camera);
    const tanHalfFov = Math.tan(15 * Math.PI / 180);
    expect(projected.x / tanHalfFov / camera.aspect).toBeCloseTo(expected.x, 10);
    expect(projected.y / tanHalfFov).toBeCloseTo(expected.y, 10);
});

test("image-plane fitting includes full-resolution extrema between drawn samples", () => {
    const points = [[0, 0, 10], [5, 3, 10], [1, 0, 10]];
    const series = [{pts: [points[0], points[2]], frameCount: 3, positionAt: f => points[f]}];
    const viewport = {left: 10, top: 20, width: 200, height: 100};
    const project = cameraTrackProjection(series, pose, viewport);
    for (const p of points) {
        const q = project(p);
        expect(q.x).toBeGreaterThan(viewport.left);
        expect(q.x).toBeLessThan(viewport.left + viewport.width);
        expect(q.y).toBeGreaterThan(viewport.top);
        expect(q.y).toBeLessThan(viewport.top + viewport.height);
    }
    expect(cameraTrackProjection([{pts: [[1, 1, -10]]}], pose, viewport)).toBeNull();
});
