import {inundationLoadMask} from "../src/water/InundationLoadMask";
import {InundationLoadSchedule} from "../src/water/InundationLoadSchedule";

const size = 64;
const mask = (resolved = null) => inundationLoadMask(new Float32Array(size * size), new Uint8Array(size * size), size, 2, resolved);

test("only one bounded block is active and unresolved blocks are attempted once", () => {
    const needed = mask(), schedule = new InundationLoadSchedule(needed, size, 40, 16, 4, 0);
    const visited = new Set();
    let frame = 0;
    while (schedule.current) {
        const b = schedule.current, key = JSON.stringify(b);
        expect(visited.has(key)).toBe(false);
        visited.add(key);
        expect(b.x1 - b.x0).toBeLessThanOrEqual(16);
        expect(b.y1 - b.y0).toBeLessThanOrEqual(16);
        expect(schedule.advance(needed, true, ++frame, false)).toBe(true);
    }
    expect(visited.size).toBe(16);
    expect(schedule.advance(needed, true, ++frame, false)).toBe(false);
});

test("busy work and stale traversal stats cannot skip a newly activated block", () => {
    const needed = mask(), schedule = new InundationLoadSchedule(needed, size, 40, 16, 4, 7);
    const block = schedule.current;
    expect(schedule.advance(needed, true, 7, false)).toBe(false);
    expect(schedule.advance(needed, false, 8, false)).toBe(false);
    expect(schedule.current).toBe(block);
    expect(schedule.advance(needed, true, 8, false)).toBe(true);
    expect(schedule.current).not.toBe(block);
});

test("new coverage skips queued blocks without restarting attempted work", () => {
    const needed = mask(), schedule = new InundationLoadSchedule(needed, size, 40, 16, 4, 0);
    const resolved = mask(new Uint8Array(size * size).fill(1));
    schedule.advance(resolved, true, 1, false);
    expect(schedule.current).toBeNull();
    expect(schedule.attempted).toBe(1);
});

test("unresolved cells outside the detail radius do not restart a completed pass", () => {
    const resolved = new Uint8Array(size * size);
    const radius = 20, center = size / 2;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        if ((x + .5 - center) ** 2 + (y + .5 - center) ** 2 <= radius * radius) resolved[y * size + x] = 1;
    }
    const needed = inundationLoadMask(new Float32Array(size * size), new Uint8Array(size * size), size, 2, resolved, null, null, radius);
    const schedule = new InundationLoadSchedule(needed, size, radius, 16, 4, 0);
    expect(needed[needed.length - 1]).toBe(0);
    expect(schedule.current).toBeNull();
    expect(schedule.queue).toHaveLength(0);
});

test("cache-limited blocks subdivide with a finite minimum size", () => {
    const needed = mask(), schedule = new InundationLoadSchedule(needed, size, 40, 16, 4, 0);
    schedule.advance(needed, true, 1, true);
    expect(schedule.current.x1 - schedule.current.x0).toBe(8);
    schedule.advance(needed, true, 2, true);
    expect(schedule.current.x1 - schedule.current.x0).toBe(4);
    let frame = 2;
    while (schedule.current && frame < 400) schedule.advance(needed, true, ++frame, true);
    expect(schedule.current).toBeNull();
    expect(schedule.cacheLimited).toBe(true);
    expect(frame).toBeLessThan(400);
});
