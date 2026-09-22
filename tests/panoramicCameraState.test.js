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
import {mouseInRenderedView, ndcToView, setRaycasterFromCamera, viewToNDC} from "../src/ViewUtils";

beforeEach(() => {
    Object.assign(panoramic, {enabled: false, hfov: 180});
    NodeMan.add("lookView", {widthPx: 1600, heightPx: 900});
    fisheye.enabled = false;
    Globals.panoramic = panoramic;
    setupPanoramicCamera();
});

test("a state node saves HFOV and ignores the old independent VFOV", () => {
    const node = NodeMan.get("PanoramicCamera");
    expect(panoramic.enabled).toBe(false); // CNode.enabled defaults to true.
    node.modDeserialize({panoEnabled: true, panoHFOV: 275, panoVFOV: 87});
    expect(panoramic.vfov).toBeCloseTo(275 * 900 / 1600);
    const saved = node.modSerialize();
    expect(saved).not.toHaveProperty("panoVFOV");
    node.dispose();
    expect(panoramic).toEqual({enabled: false, hfov: 180, vfov: 101.25});
    node.modDeserialize(saved);
    expect(panoramic).toEqual({enabled: true, hfov: 275, vfov: 154.6875});
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

test("zoom spans the full horizontal range even when VFOV is capped", () => {
    const node = NodeMan.get("PanoramicCamera");
    node.modDeserialize({panoHFOV: 800, panoVFOV: 0});
    expect(panoramic.hfov).toBe(360);
    expect(panoramic.vfov).toBe(180);
    node.modDeserialize({panoHFOV: 240, panoVFOV: 60});
    zoomPanorama(2);
    expect(panoramic.hfov).toBe(360);
    expect(panoramic.vfov).toBe(180);
    zoomPanorama(0.001);
    expect(panoramic.hfov).toBe(1);
    expect(panoramic.vfov).toBe(0.5625);
});

test("VFOV follows resizing without changing the stored HFOV", () => {
    const view = NodeMan.get("lookView");
    NodeMan.get("PanoramicCamera").modDeserialize({panoEnabled: true, panoHFOV: 360});
    view.widthPx = 800;
    view.heightPx = 1200;
    expect(panoramic.vfov).toBe(180);
    view.widthPx = 2400;
    view.heightPx = 600;
    expect(panoramic.vfov).toBe(90);
    expect(panoramic.hfov).toBe(360);
});

test("letterbox picking and overlays share the fitted image rectangle", () => {
    const camera = new PerspectiveCamera(30, 2, 0.1, 1e6);
    camera.updateMatrixWorld(true);
    NodeMan.add("lookCamera", {camera});
    const view = {
        camera, visible: true, widthPx: 800, heightPx: 1200,
        div: {getBoundingClientRect: () => ({left: 0, top: 0, width: 800, height: 1200})},
        canvas: {getBoundingClientRect: () => ({left: 0, top: 400, width: 800, height: 400})},
    };
    NodeMan.add("lookView", view);
    NodeMan.get("PanoramicCamera").modDeserialize({panoEnabled: true, panoHFOV: 360});
    const ndc = viewToNDC(view, 600, 500);
    expect(ndc.toArray()).toEqual([0.5, 0.5]);
    const raycaster = new Raycaster();
    setRaycasterFromCamera(raycaster, ndc, camera);
    const point = raycaster.ray.at(100, new Vector3());
    panoramicProjectVector(point, camera);
    const pixel = ndcToView(view, point);
    expect(pixel[0]).toBeCloseTo(600);
    expect(pixel[1]).toBeCloseTo(500);
    expect(mouseInRenderedView(view, 600, 500)).toBe(true);
    expect(mouseInRenderedView(view, 600, 100)).toBe(false);
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
