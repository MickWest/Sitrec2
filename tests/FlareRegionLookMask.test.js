/** @jest-environment jsdom */
// A sitch saved with "Flare Region in Look View" ticked must show the flare region in the
// look view when it is loaded, without the user toggling the checkbox off and on again.
// The full night-sky node needs the GUI, star catalogs and satellites, so these tests run
// the real prototype methods on a minimal instance.
import {Group, Object3D, Sphere, Vector3} from "three";
import {CNodeDisplayNightSky} from "../src/nodes/CNodeDisplayNightSky";
import {Globals, setNodeMan} from "../src/Globals";
import {disposeDebugArrows, disposeDebugSpheres} from "../src/threeExt";
import * as LAYER from "../src/LayerMasks";
import {wgs84} from "../src/LLA-ECEF-ENU";
import {par} from "../src/par";

function makeNightSky(showFlareRegionLook = false) {
    const node = Object.create(CNodeDisplayNightSky.prototype);
    node.flareRegionGroup = new Group();
    node.showFlareRegionLook = showFlareRegionLook;
    node.showFlareRegion = true;
    node.simpleSerials = ["showFlareRegion", "showFlareRegionLook"];
    node.satellites = {
        filterSatellites: jest.fn(),
        getSatelliteNormal: (X, O) => X.clone().sub(O).normalize(),
    };
    node.updateVis = jest.fn();
    return node;
}

function allMasks(group) {
    const masks = [];
    group.traverse(child => masks.push(child.layers.mask));
    return masks;
}

afterEach(() => {
    disposeDebugArrows();
    disposeDebugSpheres();
});

test("loading a save with the look flag set applies the look mask to the flare region", () => {
    const node = makeNightSky(false);
    const child = new Object3D();
    child.layers.mask = LAYER.MASK_HELPERS;
    node.flareRegionGroup.add(child);

    node.modDeserialize({showFlareRegion: true, showFlareRegionLook: true});

    expect(node.showFlareRegionLook).toBe(true);
    expect(allMasks(node.flareRegionGroup).every(mask => mask === LAYER.MASK_LOOKRENDER)).toBe(true);
});

test("loading a save without the look flag keeps the flare region in the main view only", () => {
    const node = makeNightSky(false);
    node.modDeserialize({showFlareRegion: true});
    expect(node.flareRegionGroup.layers.mask).toBe(LAYER.MASK_HELPERS);
});

test("flare region parts created after load follow the look flag", () => {
    const node = makeNightSky(true);
    const cameraPos = new Vector3(wgs84.RADIUS + 1000, 0, 0);
    node.camera = {position: cameraPos};
    node.globe = new Sphere(new Vector3(0, 0, 0), wgs84.RADIUS);
    setNodeMan({get: () => ({camera: {position: cameraPos}})});
    Globals.toSun = new Vector3(0, 1, 0);

    // The debug arrows and sphere do not exist until the first update, and are made with MASK_HELPERS
    expect(node.flareRegionGroup.children.length).toBe(0);
    node.updateFlareRegion(0, 0, new Date("2026-06-21T03:00:00Z"));
    expect(node.flareRegionGroup.children.length).toBeGreaterThan(0);
    expect(allMasks(node.flareRegionGroup).every(mask => mask === LAYER.MASK_LOOKRENDER)).toBe(true);

    // Unticking still takes the whole region out of the look view
    node.showFlareRegionLook = false;
    node.applyFlareRegionLookMask();
    expect(allMasks(node.flareRegionGroup).every(mask => mask === LAYER.MASK_HELPERS)).toBe(true);
});

test("a later update does not change the flare region masks or request a render", () => {
    const node = makeNightSky(true);
    const cameraPos = new Vector3(wgs84.RADIUS + 1000, 0, 0);
    node.camera = {position: cameraPos};
    node.globe = new Sphere(new Vector3(0, 0, 0), wgs84.RADIUS);
    setNodeMan({get: () => ({camera: {position: cameraPos}})});
    Globals.toSun = new Vector3(0, 1, 0);
    const date = new Date("2026-06-21T03:00:00Z");

    node.updateFlareRegion(0, 0, date);

    // The arrows must be drawn with the region's mask. If they are drawn with MASK_HELPERS, every
    // update changes their masks twice and requests a render, so a paused scene never settles.
    par.renderOne = false;
    node.updateFlareRegion(0, 0, date);
    expect(par.renderOne).toBe(false);
    expect(allMasks(node.flareRegionGroup).every(mask => mask === LAYER.MASK_LOOKRENDER)).toBe(true);
});
