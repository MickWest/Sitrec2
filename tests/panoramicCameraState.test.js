jest.mock("../src/Globals", () => {
    const nodes = new Map();
    return {
        Globals: {}, guiMenus: {}, setRenderOne: jest.fn(),
        FileManager: {removeExportButton: jest.fn()},
        NodeMan: {add: (id, node) => nodes.set(id, node), get: id => nodes.get(id), exists: id => nodes.has(id)},
    };
});
jest.mock("../src/LocalFrame", () => ({}));

import {PerspectiveCamera, Raycaster, Vector2, Vector3} from "three";
import {Globals, NodeMan} from "../src/Globals";
import {applyFisheyeState, fisheye} from "../src/FisheyeProjection";
import {panoramic, setupPanoramicCamera, zoomPanorama, panoramicProjectVector} from "../src/PanoramicCamera";
import {setRaycasterFromCamera} from "../src/ViewUtils";

beforeEach(() => {
    Object.assign(panoramic, {enabled: false, hfov: 180, vfov: 60});
    fisheye.enabled = false;
    Globals.panoramic = panoramic;
    setupPanoramicCamera();
});

test("a state node starts disabled and saves independent panorama fields", () => {
    const node = NodeMan.get("PanoramicCamera");
    expect(panoramic.enabled).toBe(false); // CNode.enabled defaults to true.
    node.modDeserialize({panoEnabled: true, panoHFOV: 275, panoVFOV: 87});
    const saved = node.modSerialize();
    node.dispose();
    expect(panoramic).toEqual({enabled: false, hfov: 180, vfov: 60});
    node.modDeserialize(saved);
    expect(panoramic).toEqual({enabled: true, hfov: 275, vfov: 87});
});

test("fisheye and panorama are exclusive without losing either set of FOV values", () => {
    fisheye.enabled = true;
    fisheye.fov = 140;
    NodeMan.get("PanoramicCamera").modDeserialize({panoEnabled: true, panoHFOV: 270});
    expect(fisheye.enabled).toBe(false);
    fisheye.enabled = true;
    applyFisheyeState();
    expect(panoramic.enabled).toBe(false);
    expect(panoramic.hfov).toBe(270);
    expect(fisheye.fov).toBe(140);
});

test("both angular limits and zoom ratio survive clamping", () => {
    const node = NodeMan.get("PanoramicCamera");
    node.modDeserialize({panoHFOV: 800, panoVFOV: 0});
    expect(panoramic.hfov).toBe(360);
    expect(panoramic.vfov).toBe(1);
    node.modDeserialize({panoHFOV: 240, panoVFOV: 60});
    zoomPanorama(2);
    expect(panoramic.hfov).toBe(360);
    expect(panoramic.vfov).toBe(90);
    zoomPanorama(0.001);
    expect(panoramic.hfov).toBe(4);
    expect(panoramic.vfov).toBe(1);
});

test("picking round trips to panorama pixels, including directions behind the camera", () => {
    const camera = new PerspectiveCamera(30, 2, 0.1, 1e6);
    camera.position.set(1000, 2000, 3000);
    camera.rotation.set(0.3, 0.7, -0.1);
    camera.updateMatrixWorld(true);
    NodeMan.add("lookCamera", {camera});
    NodeMan.get("PanoramicCamera").modDeserialize({panoEnabled: true, panoHFOV: 360, panoVFOV: 180});
    const raycaster = new Raycaster();
    for (const ndc of [new Vector2(-0.99, -0.8), new Vector2(0, 0), new Vector2(0.9, 0.7)]) {
        setRaycasterFromCamera(raycaster, ndc, camera);
        const point = raycaster.ray.at(100, new Vector3());
        expect(panoramicProjectVector(point, camera)).toBe(true);
        expect(point.x).toBeCloseTo(ndc.x, 8);
        expect(point.y).toBeCloseTo(ndc.y, 8);
    }
});
