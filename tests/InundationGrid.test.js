import {connectedInundation} from "../src/water/InundationGrid";
import {sampleElevationTile} from "../src/ElevationSampling";

test("an enclosed basin floods only when its connecting pass is overtopped, and dries when the level falls", () => {
    const heights = new Float32Array([
        0, 9, 9, 9, 9,
        0, 3, 1, 1, 9,
        0, 9, 1, 1, 9,
        0, 9, 9, 9, 9,
    ]);
    const ocean = new Uint8Array(20);
    ocean[0] = 1;
    const low = connectedInundation(heights, ocean, 5, 4, 2);
    expect([...low.keys()].filter(i => low[i])).toEqual([0, 5, 10, 15]);
    const high = connectedInundation(heights, ocean, 5, 4, 3);
    expect([...high.keys()].filter(i => high[i])).toEqual([0, 5, 6, 7, 8, 10, 12, 13, 15]);
    expect(connectedInundation(heights, ocean, 5, 4, 2, high)).toEqual(low);
});

test("low map edges, diagonal corners and lakes are not independent flood sources", () => {
    const heights = new Float32Array([0, 5, 0, 5, 0, 0, 0, 0, 0]);
    const ocean = new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(Array.from(connectedInundation(heights, ocean, 3, 3, 1))).toEqual([255, 0, 0, 0, 0, 0, 0, 0, 0]);
    ocean.fill(0);
    expect(connectedInundation(heights, ocean, 3, 3, 100).some(Boolean)).toBe(false);
});

test("unknown terrain blocks propagation and row ends cannot wrap", () => {
    const ocean = new Uint8Array([1, 0, 0, 0, 0, 0]);
    const heights = new Float32Array([0, 0, 0, 0, Infinity, NaN]);
    heights[3] = 4;
    expect(Array.from(connectedInundation(heights, ocean, 3, 2, 2))).toEqual([255, 255, 255, 0, 0, 0]);
});

test("a channel admits water at negative and zero datum levels", () => {
    const heights = new Float32Array([0, -2, -1, 0, 1]);
    const ocean = new Uint8Array([1, 0, 0, 0, 0]);
    expect(Array.from(connectedInundation(heights, ocean, 5, 1, -1))).toEqual([255, 255, 255, 0, 0]);
    expect(Array.from(connectedInundation(heights, ocean, 5, 1, 0))).toEqual([255, 255, 255, 255, 0]);
});

test("height-grid sampling shares the terrain interpolation but can reject filled no-data pixels", () => {
    const tile = {shape: [2, 2], elevation: new Float32Array([0, 10, 20, 30])};
    expect(sampleElevationTile(tile, 0.25, 0.25)).toBe(15);
    expect(sampleElevationTile(tile, 0.99, 0.99)).toBe(30);
    tile.elevationNoData = new Uint8Array([0, 1, 0, 0]);
    expect(sampleElevationTile(tile, 0.25, 0.25)).toBe(15);
    expect(sampleElevationTile(tile, 0.25, 0.25, true)).toBeNull();
    expect(sampleElevationTile(null, 0.25, 0.25, true)).toBeNull();
});
