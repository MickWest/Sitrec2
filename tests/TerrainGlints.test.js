import {Object3D, OrthographicCamera, PerspectiveCamera, Vector3} from "three";
import {glintUniforms, updateGlintCamera} from "../src/js/map33/material/TerrainGlints";

function cameraAt(x, y, z) {
    const camera = new PerspectiveCamera();
    camera.position.set(x, y, z);
    return camera;
}

test("each view uses its own observer unless Look Camera is selected", () => {
    const main = cameraAt(6378137, 100, 40);
    const look = cameraAt(6378137.25, 102, 45);
    main.rotation.y = Math.PI / 2;

    updateGlintCamera(main, look, false);
    expect(glintUniforms.glintCameraPosition.value.length()).toBeLessThan(1e-8);

    updateGlintCamera(main, look, true);
    expect(glintUniforms.glintCameraPosition.value.x).toBeCloseTo(-5, 7);
    expect(glintUniforms.glintCameraPosition.value.y).toBeCloseTo(2, 7);
    expect(glintUniforms.glintCameraPosition.value.z).toBeCloseTo(0.25, 7);

    updateGlintCamera(look, look, true);
    expect(glintUniforms.glintCameraPosition.value.length()).toBeLessThan(1e-8);
});

test("Look Camera produces the same observer ray in differently rotated views", () => {
    const main = cameraAt(6378137, 500, 400);
    const look = cameraAt(6378137, 10, 20);
    main.rotation.set(0.7, -0.8, 0.3);
    look.rotation.set(-0.4, 0.2, 0.1);
    const surface = new Vector3(6378137.5, 0, 0);
    const expected = look.position.clone().sub(surface).normalize();
    for (const view of [main, look]) {
        updateGlintCamera(view, look, true);
        const surfaceView = surface.clone().applyMatrix4(view.matrixWorldInverse);
        const ray = glintUniforms.glintCameraPosition.value.clone().sub(surfaceView)
            .transformDirection(view.matrixWorld);
        expect(ray.distanceTo(expected)).toBeLessThan(1e-8);
    }
});

test("missing Look Camera falls back to the current view", () => {
    updateGlintCamera(cameraAt(1, 2, 3), undefined, true);
    expect(glintUniforms.glintCameraPosition.value.toArray()).toEqual([0, 0, 0]);
    expect(glintUniforms.glintOrthoDirection.value.w).toBe(0);
});

test("orthographic observers use their world direction, including a parent transform", () => {
    const parent = new Object3D();
    parent.rotation.y = Math.PI / 2;
    const look = new OrthographicCamera(-1, 1, 1, -1);
    parent.add(look);
    const main = cameraAt(0, 0, 0);
    updateGlintCamera(main, look, true);
    const ortho = glintUniforms.glintOrthoDirection.value;
    expect(ortho.x).toBeCloseTo(1, 10);
    expect(ortho.y).toBeCloseTo(0, 10);
    expect(ortho.z).toBeCloseTo(0, 10);
    expect(ortho.w).toBe(1);
});
