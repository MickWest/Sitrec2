import {Matrix4, PerspectiveCamera, Vector3} from "three";
import {CelestialGridMaterial} from "../src/CelestialGridMaterial";
import {setLineViewHeight} from "../src/SceneLineMaterial";

test.each([[30, 1], [100, 1], [100, 2], [120, 0.75]])(
    "pole fade stays 10–100 display pixels at FOV=%s and render scale=%s", (fov, scale) => {
        const camera = new PerspectiveCamera(fov, 2, 0.1, 1000);
        camera.lookAt(0, 0, 1);
        camera.updateMatrixWorld(true);
        const renderer = {getCurrentViewport: v => v.set(17, 23, 800 * scale, 400 * scale),
            getSize: v => v.set(800, 400)};
        setLineViewHeight(renderer, 400);
        const material = new CelestialGridMaterial();
        const object = {matrixWorld: new Matrix4()};
        material.onBeforeRender(renderer, null, camera, null, object);
        expect(material.uniforms.gridPoleFadeRange.value.toArray()).toEqual([10 * scale, 100 * scale]);
        expect(material.uniforms.gridPoleNorth.value.toArray()).toEqual([17 + 400 * scale, 23 + 200 * scale, 1]);
        expect(material.uniforms.gridPoleSouth.value.z).toBe(0);
        // Reorienting a shared grid for another observer moves the fade with it.
        object.matrixWorld.makeRotationY(0.1);
        material.onBeforeRender(renderer, null, camera, null, object);
        const expected = new Vector3(0, 0, 100).applyMatrix4(object.matrixWorld).project(camera);
        expect(material.uniforms.gridPoleNorth.value.x).toBeCloseTo(17 + (expected.x + 1) * 400 * scale);
        expect(material.fragmentShader).toContain("alpha *= smoothstep(gridPoleFadeRange.x, gridPoleFadeRange.y, poleDistance)");
        material.dispose();
    });

test("a pole behind the view cannot fade an unrelated visible region", () => {
    const camera = new PerspectiveCamera(60, 2, 0.1, 1000);
    camera.updateMatrixWorld(true);
    const renderer = {getCurrentViewport: v => v.set(0, 0, 800, 400), getSize: v => v.set(800, 400)};
    const material = new CelestialGridMaterial();
    material.onBeforeRender(renderer, null, camera, null, {matrixWorld: new Matrix4()});
    expect(material.uniforms.gridPoleNorth.value.toArray()).toEqual([0, 0, 0]);
    expect(material.uniforms.gridPoleSouth.value.toArray()).toEqual([400, 200, 1]);
    material.dispose();
});
