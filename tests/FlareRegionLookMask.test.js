/** @jest-environment jsdom */
// A sitch saved with "Flare Region in Look View" ticked must show the flare region in the
// look view when it is loaded, without the user toggling the checkbox off and on again.
// The full night-sky node needs the GUI, star catalogs and satellites, so these tests run
// the real prototype methods on a minimal instance.
import {Group, Object3D, Sphere, Vector3} from "three";
import {CNodeDisplayNightSky} from "../src/nodes/CNodeDisplayNightSky";
import {Globals, setGlobalDateTimeNode, setNodeMan, setSit} from "../src/Globals";
import {getGeocentricBodyPositionECEF} from "../src/CelestialMath";
import {getAzElFromPositionAndForward} from "../src/SphericalMath";
import {disposeDebugArrows, disposeDebugSpheres} from "../src/threeExt";
import * as LAYER from "../src/LayerMasks";
import {wgs84} from "../src/LLA-ECEF-ENU";
import {par} from "../src/par";

function makeNightSky(showFlareRegionLook = false) {
    const node = Object.create(CNodeDisplayNightSky.prototype);
    node.flareRegionGroup = new Group();
    node.showFlareRegionLook = showFlareRegionLook;
    node.showFlareRegion = true;
    node.simpleSerials = ["showFlareRegionMain", "showFlareRegionLook"];
    node.satellites = {
        filterSatellites: jest.fn(),
        getSatelliteNormal: (X, O) => X.clone().sub(O).normalize(),
    };
    node.updateVis = jest.fn();
    node.celestialElements = {setLineWidth: jest.fn()};
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

test("aim uses the calculated sky region while both region markers are hidden", () => {
    setSit({lat: 0, lon: 0});
    const node = makeNightSky();
    node.showFlareRegionMain = false;
    node.showFlareRegionLook = false;
    node.camera = {position: new Vector3(wgs84.RADIUS + 100, 0, 0)};
    node.globe = new Sphere(new Vector3(), wgs84.POLAR_RADIUS);
    const date = new Date("2026-03-20T22:00:00Z");
    const sun = getGeocentricBodyPositionECEF("Sun", date, true).normalize();
    const target = node.getFlareRegionPosition(sun);
    const [az, el] = getAzElFromPositionAndForward(node.camera.position, target.clone().sub(node.camera.position).normalize());
    const ptz = {relativeController: {setValue: jest.fn()}, satelliteController: {setValue: jest.fn()}, refresh: jest.fn()};
    const heading = {selectOption: jest.fn()};
    setGlobalDateTimeNode({dateNow: date});
    setNodeMan({get: id => id === "ptzAngles" ? ptz : heading});
    // Deliberately stale global Sun: a click must use the current viewing date.
    Globals.toSun = new Vector3(0, 0, 1);
    node.lookTowardsFlareRegion();
    expect(heading.selectOption).toHaveBeenCalledWith("Manual");
    expect(ptz.relativeController.setValue).toHaveBeenCalledWith(false);
    expect(ptz.satelliteController.setValue).toHaveBeenCalledWith(false);
    expect(ptz.az).toBeCloseTo(az, 6);
    expect(ptz.el).toBeCloseTo(el, 6);
    expect(Math.abs(ptz.el - 10)).toBeGreaterThan(1);
    expect(ptz.refresh).toHaveBeenCalled();
    expect(node.showFlareRegionMain).toBe(false);
    expect(node.showFlareRegionLook).toBe(false);
    expect(node.flareRegionGroup.children).toHaveLength(0);
});

test("loading a save with the look flag set applies the look mask to the flare region", () => {
    const node = makeNightSky(false);
    const child = new Object3D();
    child.layers.mask = LAYER.MASK_HELPERS;
    node.flareRegionGroup.add(child);

    node.modDeserialize({showFlareRegion: true, showFlareRegionLook: true});

    expect(node.showFlareRegionLook).toBe(true);
    expect(allMasks(node.flareRegionGroup).every(mask => mask === LAYER.perViewLayerMask(true, true))).toBe(true);
});

test("loading a save without the look flag keeps the flare region in the main view only", () => {
    const node = makeNightSky(false);
    node.modDeserialize({showFlareRegion: true});
    expect(node.flareRegionGroup.layers.mask).toBe(LAYER.MASK_HELPERS);
});

test.each([[false, false], [true, false], [false, true], [true, true]])(
    "flare region Main=%s and Look=%s control their own view", (main, look) => {
        const node = makeNightSky();
        node.flareRegionGroup.add(new Object3D());
        node.modDeserialize({showFlareRegionMain: main, showFlareRegionLook: look});
        expect(node.flareRegionGroup.visible).toBe(main || look);
        for (const mask of allMasks(node.flareRegionGroup)) {
            expect(Boolean(mask & LAYER.MASK_MAINRENDER)).toBe(main);
            expect(Boolean(mask & LAYER.MASK_LOOKRENDER)).toBe(look);
        }
        expect(node.modSerialize()).toMatchObject({showFlareRegionMain: main, showFlareRegionLook: look});
    });

test("a legacy master-off save stays hidden even if its Look flag was on", () => {
    const node = makeNightSky(true);
    node.modDeserialize({showFlareRegion: false, showFlareRegionLook: true});
    expect(node.showFlareRegionMain).toBe(false);
    expect(node.showFlareRegionLook).toBe(false);
    expect(node.flareRegionGroup.visible).toBe(false);
});

test("Look-only flare regions still build their geometry", () => {
    const node = makeNightSky(true);
    node.showFlareRegionMain = false;
    node.applyFlareRegionLookMask();
    const cameraPos = new Vector3(wgs84.RADIUS + 1000, 0, 0);
    node.camera = {position: cameraPos};
    node.globe = new Sphere(new Vector3(0, 0, 0), wgs84.RADIUS);
    setNodeMan({get: () => ({camera: {position: cameraPos}})});
    Globals.toSun = new Vector3(0, 1, 0);
    node.updateFlareRegion(0, 0, new Date("2026-06-21T03:00:00Z"));
    expect(node.flareRegionGroup.children.length).toBeGreaterThan(0);
    expect(allMasks(node.flareRegionGroup).every(mask => mask === LAYER.MASK_LOOK)).toBe(true);
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
    expect(allMasks(node.flareRegionGroup).every(mask => mask === LAYER.perViewLayerMask(true, true))).toBe(true);

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
    expect(allMasks(node.flareRegionGroup).every(mask => mask === LAYER.perViewLayerMask(true, true))).toBe(true);
});
