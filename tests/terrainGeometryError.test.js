import {terrainMeshHeightError} from "../src/TerrainGeometryError";

test("flat sea and planar slopes do not need pixel-spaced mesh vertices", () => {
    const sea = new Float32Array(65 * 65).fill(-50);
    expect(terrainMeshHeightError(sea, 65, 8)).toBe(0);
    const plane = Float32Array.from({length: 65 * 65}, (_, i) => 200 + i % 65 + Math.floor(i / 65));
    expect(terrainMeshHeightError(plane, 65, 8)).toBeLessThan(1e-9);
});

test("a narrow summit missed between vertices requests refinement and converges", () => {
    const data = new Float32Array(65 * 65);
    data[19 * 65 + 19] = 300;
    expect(terrainMeshHeightError(data, 65, 8)).toBe(300);
    expect(terrainMeshHeightError(data, 65, 64)).toBe(0);
});
