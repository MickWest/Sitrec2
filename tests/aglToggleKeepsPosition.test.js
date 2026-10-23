// Toggling "Above Ground Level" on a position keeps the position where it is and
// rewrites the Altitude number in the new reference (Metabunk bug report: camera
// elevation and 3D buildings). The node is built from its prototype with the real
// recalculate() and coordinate maths; only the terrain, the 3D tiles and the
// Altitude GUI control are stubbed.
import {beforeEach, expect, jest, test} from "@jest/globals";
import {CNodePositionLLA} from "../src/nodes/CNodePositionLLA";
import {NodeMan} from "../src/Globals";
import {getTilesPointBelow} from "../src/threeExt";
import {ECEFToLLAVD_radii, LLAToECEF} from "../src/LLA-ECEF-ENU";
import {getLocalUpVector} from "../src/SphericalMath";

jest.mock("../src/Globals", () => ({
    Globals: {equatorRadius: 6378137, polarRadius: 6356752.314245},
    Sit: {frames: 1, simSpeed: 1, lat: 0, lon: 0},
    guiMenus: {}, NodeMan: {get: jest.fn(), exists: jest.fn(() => false)},
    markSitchDirty: () => {}, setSitchEstablished: () => {}, UndoManager: null,
    GlobalDateTimeNode: {},
}));
jest.mock("../src/EGM96Geoid", () => ({meanSeaLevelOffset: () => -30}));   // = GEOID
jest.mock("../src/threeExt", () => ({
    adjustHeightAboveGround: () => { throw new Error("not used"); },
    elevationAtLL: () => { throw new Error("not used"); },
    getTilesPointBelow: jest.fn(() => null),
}));
jest.mock("../src/KeyBoardHandler", () => ({}));
jest.mock("../src/mouseMoveView", () => ({}));
jest.mock("../src/FreeLookGuard", () => ({}));
jest.mock("../src/GeoLocation", () => ({}));
jest.mock("../src/runtimeConfig", () => ({}));
jest.mock("../src/showError", () => ({showError: () => {}}));
jest.mock("../src/CoordinateInput", () => ({}));
jest.mock("../src/i18n", () => ({t: (k) => k}));
jest.mock("../src/nodes/CNodeGUIValue", () => ({CNodeGUIValue: class {}}));

// Geoid height N (HAE = MSL + N): non-zero, so a mix-up of HAE and MSL shows.
const GEOID = -30;
const LAT = 37.8, LON = -122.4;

const FT = 0.3048;
let groundHAE, groundTileZ, node;

const terrain = {
    getPointBelowWithTileInfo(A, agl = 0) {
        const lla = ECEFToLLAVD_radii(A);
        return {point: LLAToECEF(lla.x, lla.y, groundHAE + agl), elevation: groundHAE,
            tileZ: groundTileZ, tileX: 0, tileY: 0};
    },
    elevationTileHasHigherZoom: () => false,
};

// The Altitude control shows FEET, as it does with imperial units selected: the value
// it holds is in feet, getValue() returns metres, and setValueWithUnits takes metres.
function makeGuiAlt(metres) {
    return {
        value: metres / FT,
        getValue() { return this.value * FT; },
        setValueWithUnits(v, fromUnits, unitType, ignoreOnChange) {
            expect([fromUnits, unitType, ignoreOnChange]).toEqual(["metric", "small", true]);
            this.value = v / FT;
            return this.value;
        },
    };
}

function makeNode(altMetres, agl) {
    const n = Object.create(CNodePositionLLA.prototype);
    Object.assign(n, {
        _LLA: [LAT, LON, altMetres], agl, frames: 1, inputs: {},
        simpleSerials: ["visible", "agl"], guiAlt: makeGuiAlt(altMetres),
    });
    n.recalculate();
    return n;
}

// What the checkbox handler does: lil-gui has already written the new value.
function toggle(n, agl) {
    n.agl = agl;
    n.keepPositionOnAGLToggle(agl);
    n.recalculate();
}

function mslOf(ecef) {
    return ECEFToLLAVD_radii(ecef).z - GEOID;
}

beforeEach(() => {
    groundHAE = 10;          // ground at 40 m MSL
    groundTileZ = 12;
    getTilesPointBelow.mockImplementation(() => null);
    NodeMan.get.mockImplementation((id) => id === "TerrainModel" ? terrain : undefined);
});

test("turning AGL on keeps the position and gives the height above the ground", () => {
    node = makeNode(120, false);                 // 120 m MSL, 80 m above the ground
    const before = node.ecef.clone();
    toggle(node, true);
    expect(node.ecef.distanceTo(before)).toBeLessThan(1e-4);
    expect(node._LLA[2]).toBeCloseTo(80, 6);
    expect(node.guiAlt.getValue()).toBeCloseTo(80, 6);
});

test("turning AGL off keeps the position and gives the altitude above sea level", () => {
    node = makeNode(80, true);                   // 80 m above ground at 40 m MSL
    const before = node.ecef.clone();
    expect(mslOf(before)).toBeCloseTo(120, 6);
    toggle(node, false);
    expect(node.ecef.distanceTo(before)).toBeLessThan(1e-4);
    expect(node._LLA[2]).toBeCloseTo(120, 6);
    expect(node.guiAlt.getValue()).toBeCloseTo(120, 6);
});

test("with 3D tiles the AGL height is measured from the tile surface, as recalculate does", () => {
    // A roof 15 m above the elevation-map ground.
    getTilesPointBelow.mockImplementation((p) => p.clone().add(getLocalUpVector(p).multiplyScalar(15)));
    node = makeNode(120, false);
    const before = node.ecef.clone();
    toggle(node, true);
    expect(node._LLA[2]).toBeCloseTo(65, 4);
    expect(node.ecef.distanceTo(before)).toBeLessThan(1e-4);

    toggle(node, false);
    expect(node._LLA[2]).toBeCloseTo(120, 4);
    expect(node.ecef.distanceTo(before)).toBeLessThan(1e-4);
});

test("a camera below the ground stays there (a negative AGL height)", () => {
    node = makeNode(25, false);                  // 15 m below ground at 40 m MSL
    const before = node.ecef.clone();
    toggle(node, true);
    expect(node._LLA[2]).toBeCloseTo(-15, 6);
    expect(node.ecef.distanceTo(before)).toBeLessThan(1e-4);
});

test("an unknown ground (no elevation tile yet) leaves the number alone, as before", () => {
    groundTileZ = -1;
    node = makeNode(120, false);
    toggle(node, true);
    expect(node._LLA[2]).toBe(120);
    expect(node.guiAlt.getValue()).toBeCloseTo(120, 9);
});

test("no terrain node leaves the number alone when turning AGL on", () => {
    node = makeNode(120, false);
    NodeMan.get.mockImplementation(() => undefined);
    node.keepPositionOnAGLToggle(true);
    expect(node._LLA[2]).toBe(120);
});

test("a redundant set to the current state does not change the number", () => {
    node = makeNode(80, true);
    toggle(node, true);
    expect(node._LLA[2]).toBeCloseTo(80, 6);
    node = makeNode(120, false);
    toggle(node, false);
    expect(node._LLA[2]).toBeCloseTo(120, 6);
});

test("loading a saved AGL flag does not convert the altitude", () => {
    node = makeNode(80, false);
    const spy = jest.spyOn(node, "keepPositionOnAGLToggle");
    node.modDeserialize({agl: true});
    expect(node.agl).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    expect(node._LLA[2]).toBe(80);
    expect(node.guiAlt.getValue()).toBeCloseTo(80, 9);
});
