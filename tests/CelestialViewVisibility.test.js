/** @jest-environment jsdom */
import {Group} from "three";
import {CNodeDisplayNightSky} from "../src/nodes/CNodeDisplayNightSky";
import {CNodeDisplaySkyOverlay} from "../src/nodes/CNodeDisplaySkyOverlay";
import {MASK_MAINRENDER, MASK_LOOKRENDER} from "../src/LayerMasks";
import GUI from "../src/js/lil-gui.esm";
import "../src/lil-gui-extras";
import {clearMenuMirrors} from "../src/MenuMirror";
import {viewMenuKey} from "../src/ViewUIBarMenus";

const keys = ["showConstellations", "showConstellationNames", "showHorizonCompassRibbon"];

test("celestial pairs publish independent view-header controls with working callbacks", () => {
    const source = new GUI();
    const target = new GUI();
    const n = sky();
    n.showConstellationsMain = true;
    n.showConstellationsLook = false;
    const changed = jest.fn();
    n.addCelestialViewPair(source, "showConstellations", "Lines", "constellationLines", "Lines in this view", changed);
    for (const [view, property] of [["mainView", "showConstellationsMain"], ["lookView", "showConstellationsLook"]]) {
        target.addMirror(viewMenuKey(view, "constellationLines"));
        const twin = target.controllers.find(c => c.property === property);
        expect(twin).toBeDefined();
        twin.setValue(!n[property]);
    }
    expect(n.showConstellationsMain).toBe(false);
    expect(n.showConstellationsLook).toBe(true);
    expect(changed).toHaveBeenCalledTimes(2);
    target.destroy();
    source.destroy();
    clearMenuMirrors();
});
function sky() {
    const n = Object.create(CNodeDisplayNightSky.prototype);
    n.simpleSerials = keys.flatMap(key => [`${key}Main`, `${key}Look`]);
    for (const key of ["constellationsGroup", "equatorialSphereGroup", "azimuthalSphereGroup", "sunArrowGroup", "flareRegionGroup",
        "flareBandGroup", "satelliteGroup", "satelliteTrackGroup", "satelliteFlareTracksGroup", "satelliteGroundGroup"]) n[key] = new Group();
    n.constellationsGroup.add(new Group());
    n.celestialElements = {setLineWidth() {}};
    n.satellites = {filterSatellites() {}};
    n.updateStarPlanetVisibility = () => {};
    n.updateCelestialVectorVisibility = () => {};
    return n;
}

test("old shared switches keep their display in both views and old names inherit line visibility", () => {
    const n = sky();
    n.modDeserialize({showConstellations: true, showHorizonCompassRibbon: true});
    for (const key of keys) {
        expect(n[`${key}Main`]).toBe(true);
        expect(n[`${key}Look`]).toBe(true);
    }
    n.modDeserialize({showConstellations: false, showConstellationNames: true, showHorizonCompassRibbon: false});
    expect(n.showConstellationsMain).toBe(false);
    expect(n.showConstellationNamesMain).toBe(true);
    expect(n.showConstellationNamesLook).toBe(true);
    expect(n.showHorizonCompassRibbonMain).toBe(false);
});

test.each([[false, false], [true, false], [false, true], [true, true]])(
    "lines, labels and compass independently select Main=%s Look=%s", (main, look) => {
        const n = sky();
        const values = {};
        for (const key of keys) Object.assign(values, {[`${key}Main`]: main, [`${key}Look`]: look});
        n.modDeserialize(values);
        const overlays = [MASK_MAINRENDER, MASK_LOOKRENDER].map(mask => {
            const overlay = Object.create(CNodeDisplaySkyOverlay.prototype);
            overlay.nightSky = n;
            overlay.overlayView = {camera: {layers: {mask}}};
            return overlay;
        });
        for (const [mask, expected, overlay] of [[MASK_MAINRENDER, main, overlays[0]], [MASK_LOOKRENDER, look, overlays[1]]]) {
            n.constellationsGroup.traverse(child => expect(!!(child.layers.mask & mask)).toBe(expected));
            expect(overlay.showConstellationNames).toBe(expected);
            expect(overlay.showHorizonCompassRibbon).toBe(expected);
        }
        expect(n.constellationsGroup.visible).toBe(main || look);
        expect(n.modSerialize()).toMatchObject(values);
    });

test("explicit per-view fields take priority over legacy shared flags", () => {
    const n = sky();
    n.modDeserialize({showConstellations: true, showConstellationsMain: false, showConstellationsLook: true,
        showConstellationNames: true, showConstellationNamesMain: true, showConstellationNamesLook: false,
        showHorizonCompassRibbon: true, showHorizonCompassRibbonMain: false, showHorizonCompassRibbonLook: false});
    expect(n.modSerialize()).toMatchObject({showConstellationsMain: false, showConstellationsLook: true,
        showConstellationNamesMain: true, showConstellationNamesLook: false,
        showHorizonCompassRibbonMain: false, showHorizonCompassRibbonLook: false});
});

test("ridgeline defaults off and saves independent view choices", () => {
    const n = sky();
    n.simpleSerials.push("showRidgelineMain", "showRidgelineLook");
    n.modDeserialize({});
    expect(n.showRidgelineMain).toBe(false);
    expect(n.showRidgelineLook).toBe(false);
    n.modDeserialize({showRidgelineMain: false, showRidgelineLook: true});
    expect(n.modSerialize()).toMatchObject({showRidgelineMain: false, showRidgelineLook: true});
});
