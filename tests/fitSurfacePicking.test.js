import {OrthographicCamera, PerspectiveCamera, Vector3} from "three";
import {groundUnderCanvasPoint, projectToCanvas} from "../src/FitSurfacePick";
import {currentTerrestrialLiftContext} from "../src/atmosphere/refractionSettings";
import {terrestrialLiftContext} from "../src/atmosphere/terrestrialRefraction";

jest.mock("../src/Globals", () => ({NodeMan: {exists: () => false}}));
jest.mock("../src/CViewManager", () => ({ViewMan: {}}));
jest.mock("../src/atmosphere/refractionSettings", () => ({currentTerrestrialLiftContext: jest.fn()}));
jest.mock("../src/raycastGround", () => ({
    raycastGroundElevationFast: (origin, direction) => {
        // An elevation surface tangent to the equator, facing the observer.
        const t = (6378137 - origin.x) / direction.x;
        return t >= 0 ? origin.clone().addScaledVector(direction, t) : null;
    },
}));

test.each([[false, false], [false, true], [true, false], [true, true]])(
    "surface projection and picking agree (orthographic %s, refraction %s)", (orthographic, refraction) => {
        const world = new Vector3(6378137, 50000, 0);
        const camera = orthographic ? new OrthographicCamera(-10000, 10000, 5625, -5625, 1, 1e6)
            : new PerspectiveCamera(25, 16 / 9, 1, 1e6);
        camera.position.set(6379637, 0, 0);
        camera.up.set(1, 0, 0);
        camera.lookAt(world);
        camera.zoom = 1.8;
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld(true);
        currentTerrestrialLiftContext.mockImplementation(eye =>
            terrestrialLiftContext(eye, {enabled: refraction, k: 0.2}));
        const view = {
            camera, widthPx: 800, heightPx: 600,
            div: {getBoundingClientRect: () => ({left: 200, top: 40, width: 800, height: 600})},
            canvas: {getBoundingClientRect: () => ({left: 200, top: 115, width: 800, height: 450})},
        };
        for (const point of [world, world.clone().add(new Vector3(0, 4000, 1500))]) {
            const targetPixel = projectToCanvas(view, point);
            const picked = groundUnderCanvasPoint(view, ...targetPixel);
            expect(picked).not.toBeNull();
            const pickedPixel = projectToCanvas(view, picked);
            expect(Math.hypot(pickedPixel[0] - targetPixel[0], pickedPixel[1] - targetPixel[1])).toBeLessThan(0.25);
            // Sub-millimetre tolerance at Earth-sized coordinates and a grazing ray.
            if (!refraction) expect(picked.distanceTo(point)).toBeLessThan(1e-3);
        }
    });
