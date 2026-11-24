import {connectedInundation} from "../src/water/InundationGrid";
import {inundationFlowRoutes} from "../src/water/InundationFlow";

function inlet() {
    const size = 30, heights = new Float32Array(size * size).fill(20), ocean = new Uint8Array(size * size);
    ocean[15 * size] = 1;
    for (let x = 1; x < 22; x++) heights[15 * size + x] = 5 - x * 0.1;
    for (let y = 5; y < 26; y++) for (let x = 20; x < 30; x++) heights[y * size + x] = 0;
    return {size, heights, ocean};
}
function calculate({size, heights, ocean}, barriers = null, level = 6) {
    const trace = {};
    const wet = connectedInundation(heights, ocean, size, size, level, undefined, barriers, trace);
    return {wet, routes: inundationFlowRoutes(trace, heights, ocean, size, 10)};
}

test("arrows identify the ocean entrance to a significant basin and follow the valid route inland", () => {
    const input = inlet(), {wet, routes} = calculate(input);
    const entrance = routes.find(r => r.coastal);
    expect(entrance).toBeDefined();
    expect(entrance.cells.slice(0, 2)).toEqual([15 * input.size, 15 * input.size + 1]);
    expect(entrance.areaMeters2).toBeGreaterThan(20000);
    for (const route of routes) for (let k = 0; k < route.cells.length; k++) {
        expect(wet[route.cells[k]]).toBe(255);
        if (k) expect([1, input.size]).toContain(Math.abs(route.cells[k] - route.cells[k - 1]));
    }
});

test("closed seawalls, unloaded geometry, and a lowered sea remove inlet arrows", () => {
    const input = inlet(), {size} = input;
    const barriers = {east: new Uint8Array(size * size), south: new Uint8Array(size * size)};
    barriers.east[15 * size + 7] = 1;
    expect(calculate(input, barriers).routes).toEqual([]);
    barriers.east.fill(0);
    barriers.coverage = new Uint8Array(size * size).fill(1);
    barriers.coverage[15 * size + 7] = 0;
    expect(calculate(input, barriers).routes).toEqual([]);
    expect(calculate(input, null, 1).routes).toEqual([]);
});

test("isolated puddles and small flooded areas do not get inlet arrows", () => {
    const input = inlet();
    for (let y = 5; y < 26; y++) for (let x = 20; x < 30; x++) input.heights[y * input.size + x] = 20;
    expect(calculate(input).routes).toEqual([]);
});

test("downhill links between substantial areas point toward lower ground", () => {
    const input = inlet();
    // Separate the inlet from a second descent by more than arrow spacing.
    for (let x = 1; x < 21; x++) input.heights[15 * input.size + x] = 5;
    input.heights[15 * input.size + 20] = 3;
    const {routes} = calculate(input);
    const downhill = routes.filter(r => !r.coastal);
    expect(downhill.length).toBeGreaterThan(0);
    for (const route of downhill) {
        expect(input.heights[route.cells[0]]).toBeGreaterThan(input.heights[route.cells.at(-1)]);
    }
});
