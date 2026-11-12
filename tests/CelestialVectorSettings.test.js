/** @jest-environment jsdom */
import {CNodeDisplayNightSky} from "../src/nodes/CNodeDisplayNightSky";
import {setNodeMan} from "../src/Globals";
import * as LAYER from "../src/LayerMasks";

function makeSky(hasTraverse = true) {
    setNodeMan({exists: id => id === "traverseObject" && hasTraverse});
    const node = Object.create(CNodeDisplayNightSky.prototype);
    node.planets = {planets: ["Mercury", "Saturn", "Neptune"]};
    node.simpleSerials = ["celestialArrowsOnTraverse", "showCelestialVectorsMain", "showCelestialVectorsLook",
        ...node.planets.planets.flatMap(name => [`show${name}ArrowMain`, `show${name}ArrowLook`])];
    node.celestialElements = {setLineWidth() {}};
    node.satellites = {filterSatellites() {}};
    node.updateVis = () => node.updateCelestialVectorVisibility();
    for (const name of node.planets.planets) {
        node[`${name}ArrowGroup`] = {show: jest.fn(), group: {layers: {mask: 0}}, propagateLayerMask: jest.fn()};
        node[`${name}ArrowOb`] = {show: jest.fn(), removeInput: jest.fn(), addInput: jest.fn()};
    }
    return node;
}

test("saved vector visibility restores Saturn and every other modeled body", () => {
    const node = makeSky();
    node.modDeserialize({showMercuryArrow: true, showSaturnArrow: true, showNeptuneArrow: false});
    for (const [name, visible] of [["Mercury", true], ["Saturn", true], ["Neptune", false]]) {
        expect(node[`${name}ArrowOb`].show).toHaveBeenLastCalledWith(visible);
        expect(node[`${name}ArrowGroup`].show).toHaveBeenLastCalledWith(visible);
    }
});

test("legacy look visibility becomes independent vector choices and round-trips", () => {
    const node = makeSky();
    const saved = {celestialArrowsOnTraverse: true, celestialArrowsInLookView: true,
        showMercuryArrow: true, showSaturnArrow: true, showNeptuneArrow: true};
    node.modDeserialize(saved);
    for (const name of node.planets.planets) {
        expect(node[`${name}ArrowOb`].addInput).toHaveBeenLastCalledWith("start", "traverseObject");
        expect(node[`${name}ArrowGroup`].group.layers.mask).toBe(LAYER.perViewLayerMask(true, true));
        expect(node[`${name}ArrowOb`].layerMask).toBe(LAYER.perViewLayerMask(true, true));
    }
    expect(node.modSerialize()).toMatchObject({celestialArrowsOnTraverse: true,
        showSaturnArrowMain: true, showSaturnArrowLook: true});
});

test("a save without a traverse object uses the camera as a valid arrow origin", () => {
    const node = makeSky(false);
    node.modDeserialize({celestialArrowsOnTraverse: true, celestialArrowsInLookView: false, showSaturnArrow: true});
    expect(node.SaturnArrowOb.addInput).toHaveBeenLastCalledWith("start", "lookCamera");
    expect(node.SaturnArrowGroup.group.layers.mask).toBe(LAYER.MASK_HELPERS);
});

test("folder gates and per-vector choices are independent for each view", () => {
    const node = makeSky();
    const saved = {showMercuryArrowMain: true, showMercuryArrowLook: false,
        showSaturnArrowMain: false, showSaturnArrowLook: true,
        showCelestialVectorsMain: true, showCelestialVectorsLook: true};
    node.modDeserialize(saved);
    expect(node.MercuryArrowOb.layerMask).toBe(LAYER.MASK_HELPERS);
    expect(node.SaturnArrowOb.layerMask).toBe(LAYER.MASK_LOOK);
    node.showCelestialVectorsMain = false;
    node.updateCelestialVectorVisibility();
    expect(node.MercuryArrowOb.layerMask).toBe(0);
    expect(node.SaturnArrowOb.layerMask).toBe(LAYER.MASK_LOOK);
    expect(node.showMercuryArrowMain).toBe(true);
    node.showCelestialVectorsLook = false;
    node.updateCelestialVectorVisibility();
    expect(node.SaturnArrowOb.layerMask).toBe(0);
    node.showCelestialVectorsMain = true;
    node.showCelestialVectorsLook = true;
    node.updateCelestialVectorVisibility();
    expect(node.modSerialize()).toMatchObject(saved);
});
