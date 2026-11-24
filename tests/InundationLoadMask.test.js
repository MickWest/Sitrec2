import {inundationLoadMask, inundationMaskIntersects} from "../src/water/InundationLoadMask";

test("detail loading includes low coastal land and its seawall margin but excludes open ocean and high ground", () => {
    const size = 32, heights = new Float32Array(size * size).fill(100), ocean = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) for (let x = 0; x < 12; x++) {
        ocean[y * size + x] = 1; heights[y * size + x] = 0;
    }
    heights[16 * size + 12] = 3;
    heights[16 * size + 25] = Infinity;
    const mask = inundationLoadMask(heights, ocean, size, 2);
    expect(inundationMaskIntersects(mask, size, 12, 16, 12, 16)).toBe(true);
    expect(inundationMaskIntersects(mask, size, 10, 16, 10, 16)).toBe(true);
    expect(inundationMaskIntersects(mask, size, 0, 10, 4, 20)).toBe(false);
    expect(inundationMaskIntersects(mask, size, 24, 10, 28, 20)).toBe(false);
    expect(inundationMaskIntersects(mask, size, -100, -100, -50, -50)).toBe(false);
    expect(inundationMaskIntersects(mask, size, -100, -100, 100, 100)).toBe(true);
});

test("rising water expands the required land detail", () => {
    const size = 8, heights = new Float32Array(64).fill(12), ocean = new Uint8Array(64);
    expect(inundationMaskIntersects(inundationLoadMask(heights, ocean, size, 2), size, 0, 0, 7, 7)).toBe(false);
    expect(inundationMaskIntersects(inundationLoadMask(heights, ocean, size, 12), size, 0, 0, 7, 7)).toBe(true);
});

test("resolved cells stop requesting tiles while uncertain samples request finer geometry", () => {
    const size = 8, heights = new Float32Array(64), ocean = new Uint8Array(64);
    const resolved = new Uint8Array(64).fill(1), known = new Uint8Array(64).fill(1);
    expect(inundationMaskIntersects(inundationLoadMask(heights,ocean,size,2,resolved),size,0,0,7,7)).toBe(false);
    resolved[12] = 0;
    expect(inundationMaskIntersects(inundationLoadMask(heights,ocean,size,2,resolved,known),size,0,0,7,7)).toBe(true);
    known[12] = 0;
    expect(inundationMaskIntersects(inundationLoadMask(heights,ocean,size,2,resolved,known),size,0,0,7,7)).toBe(false);
});
