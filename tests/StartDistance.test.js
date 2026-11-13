/** @jest-environment jsdom */

import {Vector3} from "three";
import GUI from "../src/js/lil-gui.esm";
import {CNodeStartDistance} from "../src/nodes/CNodeStartDistance";
import {Units} from "../src/Globals";
import {raycastGroundElevationFast} from "../src/raycastGround";

const mockNodes = new Map();
jest.mock("../src/Globals", () => ({
    Globals: {equatorRadius: 6378137, polarRadius: 6378137},
    Sit: {}, guiMenus: {},
    NodeMan: {
        add: (id, node) => mockNodes.set(id, node),
        get: id => mockNodes.get(id), exists: id => mockNodes.has(id),
    },
    Units: {big: {toM: 1852, abbrev: "NM"}},
    setRenderOne: () => {}, markSitchDirty: () => {},
}));
jest.mock("../src/configUtils", () => ({isLocal: false}));
jest.mock("../src/nodes/CNodeMath", () => ({}));
jest.mock("../src/utils", () => ({roundIfClose: v => v, cleanFloat: v => v}));
jest.mock("../src/i18n", () => ({t: (key, options) => options?.defaultValue ?? key}));
jest.mock("../src/EGM96Geoid", () => ({meanSeaLevelOffset: () => 0}));

let gui;
let los;
beforeEach(() => {
    window.matchMedia = () => ({matches: false});
    mockNodes.clear();
    Units.big = {toM: 1852, abbrev: "NM"};
    gui = new GUI({container: document.body, autoPlace: false});
    los = {position: new Vector3(6379137, 0, 0), heading: new Vector3(-1, 0, 0)};
    mockNodes.set("JetLOS", {v: jest.fn(() => los)});
});
afterEach(() => gui.destroy());

function makeNode(value = 345) {
    const node = new CNodeStartDistance({
        id: "startDistance", value, end: 50, unitType: "big", desc: "Start Distance",
    }, gui);
    node.update(10);
    return node;
}

test("the slider reaches 100 m underground without changing a saved long distance", () => {
    const node = makeNode();
    expect(node.guiEntry._min * 1852).toBeCloseTo(1);
    expect(node.guiEntry._max * 1852).toBeCloseTo(1100, 1);
    expect(node.guiEntry._elastic).toBeFalsy();
    expect(node.value).toBe(345);
    expect(node.guiEntry._name).toBe("Start Distance (NM)");
    expect(mockNodes.get("JetLOS").v).toHaveBeenCalledWith(0);
    // Real pointer mapping: half way across the bar is half the distance.
    node.recalculateCascade = jest.fn();
    node.guiEntry.$slider.getBoundingClientRect = () => ({left: 0, right: 100});
    node.guiEntry._minClick = node.guiEntry._min;
    node.guiEntry._maxClick = node.guiEntry._max;
    node.guiEntry._setValueFromX(50);
    expect(node.v(0)).toBeCloseTo(550, -1);
});

test("underground means vertical depth, not 100 m farther along a sloping LOS", () => {
    los.heading.set(-0.5, Math.sqrt(0.75), 0);
    const ground = raycastGroundElevationFast(los.position, los.heading);
    const node = makeNode();
    const end = los.position.clone().addScaledVector(los.heading, node.guiEntry._max * 1852);
    expect(end.length() - 6378137).toBeCloseTo(-100, 1);
    expect(end.distanceTo(ground)).toBeGreaterThan(199);
});

test("terrain arrivals and first-LOS changes update the range without moving the target", () => {
    const node = makeNode(0.3);
    const terrain = {
        in: {}, elevationRevision: 1,
        elevationMap: {
            getElevationWithTileInfo: () => ({elevation: 400, tileZ: 0, tileX: 0, tileY: 0}),
            subtreeSlopeBound: () => ({bound: 0, rect: null, descRects: null}),
        },
    };
    mockNodes.set("TerrainModel", terrain);
    node.update(20);
    expect(node.guiEntry._max * 1852).toBeCloseTo(700, 1);
    terrain.elevationMap.getElevationWithTileInfo = () => ({elevation: 600, tileZ: 0, tileX: 0, tileY: 0});
    terrain.elevationRevision++;
    node.update(20);
    expect(node.guiEntry._max * 1852).toBeCloseTo(500, 1);
    los.position.x += 200;
    node.update(20);
    expect(node.guiEntry._max * 1852).toBeCloseTo(700, 1);
    expect(node.value).toBe(0.3);
});

test("a sky-facing LOS has a fixed fallback, and unit changes preserve metres", () => {
    const node = makeNode(0.3);
    los.heading.set(1, 0, 0);
    node.update(0);
    expect(node.guiEntry._max).toBe(50);
    Units.big = {toM: 1000, abbrev: "km"};
    node.changeUnits("metric", {big: 1.852});
    node.update(0);
    expect(node.guiEntry._max).toBe(92.6);
    expect(node.v(0)).toBeCloseTo(0.3 * 1852);
    los.heading.set(-1, 0, 0);
    node.update(0);
    expect(node.guiEntry._max).toBeCloseTo(1.1, 4);
    expect(node.guiEntry._step * 1000).toBeCloseTo(2.2, 3);
});

test("typed larger distances extend the range without elastic dragging", () => {
    const node = makeNode(0.3);
    node.recalculateCascade = jest.fn();
    node.guiEntry.$input.value = "5";
    node.guiEntry.$input.dispatchEvent(new Event("input"));
    node.update(0);
    expect(node.value).toBe(5);
    expect(node.guiEntry._max).toBe(5);
    expect(node.guiEntry._elastic).toBeFalsy();
});
