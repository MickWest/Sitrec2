jest.mock("three/addons/lines/LineMaterial.js", () => require("./__mocks__/three-addons-stub.js"));
jest.mock("three/addons/lines/LineGeometry.js", () => require("./__mocks__/three-addons-stub.js"));
jest.mock("three/addons/lines/Line2.js", () => require("./__mocks__/three-addons-stub.js"));
jest.mock("../src/FastComputeVertexNormalsAsync", () => ({}));
jest.mock("../src/js/get-pixels-mick", () => ({}));
jest.mock("../src/TerrainGeometryError", () => ({terrainMeshHeightError: jest.fn(() => 300)}));
import {QuadTreeTile} from "../src/QuadTreeTile";
import {terrainMeshHeightError} from "../src/TerrainGeometryError";

// Only the ray-traced Terrain Geometry LOD error reads a tile's mesh height
// error, and measuring it costs up to about 1 ms a tile, so a mesh build only
// stores what the measurement needs.
test("a tile measures its mesh height error when it is first read, once", () => {
    const tile = Object.create(QuadTreeTile.prototype);
    const elevation = new Float32Array(65 * 65);
    tile.deferGeometryError(elevation, 65, 64, 0, 0, 1, 1, 0);
    expect(terrainMeshHeightError).not.toHaveBeenCalled();
    expect(tile.geometryErrorM).toBe(300);
    expect(tile.geometryErrorM).toBe(300);
    expect(terrainMeshHeightError).toHaveBeenCalledTimes(1);
    expect(terrainMeshHeightError).toHaveBeenCalledWith(elevation, 65, 64, 0, 0, 1, 1, 0);
    // A rebuild replaces the inputs, and a tile with no mesh yet has no error.
    tile.deferGeometryError(elevation, 65, 32, 0, 0, 1, 1, 0);
    expect(tile.geometryErrorM).toBe(300);
    expect(terrainMeshHeightError).toHaveBeenCalledTimes(2);
    expect(Object.create(QuadTreeTile.prototype).geometryErrorM).toBeUndefined();
});
