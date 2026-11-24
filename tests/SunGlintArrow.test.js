import {Group, PerspectiveCamera, Vector3} from "three";
import {Globals} from "../src/Globals";
import {getCelestialDirection} from "../src/CelestialMath";
import {SunGlintArrow} from "../src/SunGlintArrow";

jest.mock("../src/CelestialMath", () => ({getCelestialDirection: jest.fn()}));
jest.mock("../src/LocalFrame", () => ({GlobalScene: {add() {}, remove() {}}}));

const date = new Date("2026-11-24T18:00:00Z");
const view = {pixelsToMeters: () => 2};
let marker;

beforeEach(() => {
    Globals.equatorRadius = 6378137;
    Globals.polarRadius = 6356752.314245;
    getCelestialDirection.mockReset().mockReturnValue(new Vector3(1, 1, 1).normalize());
    marker = new SunGlintArrow("test");
});

afterEach(() => marker.dispose());

function cameraAt(position, target = new Vector3()) {
    const camera = new PerspectiveCamera();
    camera.position.copy(position);
    camera.lookAt(target);
    return camera;
}

test("anchors the arrow on the ellipsoid and points it toward the Sun during the view render", () => {
    const camera = cameraAt(new Vector3(7000000, 0, 0));
    const scene = new Group();
    const result = marker.render(view, camera, scene, date, () => {
        const arrow = marker.arrow;
        expect(arrow.visible).toBe(true);
        expect(arrow.parent).toBe(scene);
        expect(arrow.position.x).toBeCloseTo(Globals.equatorRadius, 5);
        expect(arrow.position.y).toBeCloseTo(0, 5);
        expect(arrow.position.z).toBeCloseTo(0, 5);
        expect(arrow.direction.distanceTo(new Vector3(1, 1, 1).normalize())).toBeLessThan(1e-10);
        expect(arrow.length).toBe(240);
        expect(arrow.line.material.depthTest).toBe(false);
        expect(arrow.cone.material.depthWrite).toBe(false);
        return "drawn";
    });
    expect(result).toBe("drawn");
    expect(getCelestialDirection).toHaveBeenCalledWith("Sun", date, marker.arrow.position);
    expect(marker.arrow.visible).toBe(false);
    marker.dispose();
    expect(scene.children).toHaveLength(0);
});

test("uses the camera world transform and the polar radius", () => {
    const parent = new Group();
    parent.position.z = 7000000;
    parent.rotation.y = Math.PI;
    const camera = new PerspectiveCamera();
    camera.rotation.y = Math.PI;
    parent.add(camera);
    marker.render(view, camera, new Group(), date, () => {
        expect(marker.arrow.position.x).toBeCloseTo(0, 5);
        expect(marker.arrow.position.z).toBeCloseTo(Globals.polarRadius, 5);
    });
});

test("a ray pointing away from Earth hides the previous arrow", () => {
    const camera = cameraAt(new Vector3(7000000, 0, 0));
    const scene = new Group();
    marker.render(view, camera, scene, date, () => {});
    camera.lookAt(8000000, 0, 0);
    getCelestialDirection.mockClear();
    const draw = jest.fn(() => expect(marker.arrow.visible).toBe(false));
    marker.render(view, camera, scene, date, draw);
    expect(draw).toHaveBeenCalledTimes(1);
    expect(getCelestialDirection).not.toHaveBeenCalled();
});

test("the arrow is hidden even when the draw fails", () => {
    const camera = cameraAt(new Vector3(7000000, 0, 0));
    expect(() => marker.render(view, camera, new Group(), date, () => {
        throw new Error("render failed");
    })).toThrow("render failed");
    expect(marker.arrow.visible).toBe(false);
});
