jest.mock("three/addons/lines/LineMaterial.js", () => require("./__mocks__/three-addons-stub.js"));
jest.mock("three/addons/lines/LineGeometry.js", () => require("./__mocks__/three-addons-stub.js"));
jest.mock("three/addons/lines/Line2.js", () => require("./__mocks__/three-addons-stub.js"));
jest.mock("../src/FastComputeVertexNormalsAsync", () => ({}));
jest.mock("../src/js/get-pixels-mick", () => ({}));
jest.mock("../src/EGM96Geoid", () => ({geoidCorrectionForTile: () => ({}),
    interpolateGeoidOffset: () => 50, meanSeaLevelOffset: () => 50}));
import {QuadTreeTile} from "../src/QuadTreeTile";

test("Terrarium no-data uses an ancestor instead of a deep hole and records decoded bounds apart", () => {
    const tile = Object.create(QuadTreeTile.prototype);
    Object.assign(tile, {z: 4, x: 2, y: 3, map: {options: {zScale: 1}},
        parent: {elevation: new Float32Array(4)},
        buildElevationFromAncestor: () => ({elevation: new Float32Array([900, 910, 920, 930])})});
    // 100 m, no-data sentinel, transparent no-data, and valid -10 m MSL.
    const pixels = {shape: [2, 2, 4], data: new Uint8Array([
        128, 100, 0, 255, 0, 0, 0, 255,
        128, 0, 0, 0, 127, 246, 0, 255,
    ])};
    tile.computeElevationFromRGBA(pixels);
    expect(Array.from(tile.elevation)).toEqual([150, 910, 920, 40]);
    expect(tile.elevationNoDataCount).toBe(2);
    expect(tile.elevationDataBounds).toEqual({min: 50, max: 920});
    // Standard rendering takes heights from the built mesh, as before. Only
    // ray-traced geometry adopts the decoded bounds (QuadTreeMap).
    expect(tile.highestAltitude).toBeUndefined();
    expect(tile.altitudeBounds).toBeUndefined();
    tile.parent = null;
    tile.computeElevationFromRGBA(pixels);
    expect(Array.from(tile.elevation)).toEqual([150, 50, 50, 40]);
    tile.map.options.zScale = 2;
    tile.computeElevationFromRGBA(pixels);
    expect(tile.elevationDataBounds).toEqual({min: 80, max: 300});
});
