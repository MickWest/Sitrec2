// The recorded-off-a-screen stage moves the picture, so anything holding ground truth
// against the rendered frame has to map it through the same transform. The benchmark
// recorder does exactly that for its target pixel, so the inverse has to be right.

import {
    forwardScreenUV,
    inverseScreenUV,
    mapSourceToOutputPixels,
} from "../src/videoFilters/screenGeometry";
import {resolveVideoFilterSettings} from "../src/videoFilters/VideoFilterSettings";

const screenOf = (preset) => resolveVideoFilterSettings({screen: {enabled: true, preset}}).screen;

// A representative frame's worth of handheld motion: offset, rotation, crop.
const HANDHELD = [0.021, -0.014, 0.018, 1.09];
const STILL = [0, 0, 0, 1];

describe("forward mapping", () => {
    test("with no motion and no lens, the map is the identity", () => {
        const screen = {...screenOf("tripod"), barrel: 0, keystone: 0};
        for (const [u, v] of [[0.5, 0.5], [0.1, 0.9], [0.73, 0.22]]) {
            const [fu, fv] = forwardScreenUV(u, v, screen, STILL, 16 / 9);
            expect(fu).toBeCloseTo(u, 10);
            expect(fv).toBeCloseTo(v, 10);
        }
    });

    test("cropping in samples a smaller region, so the picture is magnified", () => {
        const screen = {...screenOf("tripod"), barrel: 0, keystone: 0};
        const [fu] = forwardScreenUV(1, 0.5, screen, [0, 0, 0, 1.2], 16 / 9);
        expect(fu).toBeLessThan(1);
        expect(fu).toBeCloseTo(0.5 + 0.5 / 1.2, 6);
    });

    test("barrel distortion pulls the sampled radius in, so no frame edge is exposed", () => {
        const screen = {...screenOf("handheld"), keystone: 0};
        expect(screen.barrel).toBeGreaterThan(0);
        const corner = forwardScreenUV(1, 1, screen, STILL, 16 / 9);
        expect(corner[0]).toBeLessThanOrEqual(1);
        expect(corner[1]).toBeLessThanOrEqual(1);
    });
});

describe("inverse mapping", () => {
    test("inverts the forward map to well under a pixel, across the frame", () => {
        const screen = screenOf("handheldRough");
        const aspect = 16 / 9;
        for (let u = 0.05; u <= 0.95; u += 0.15) {
            for (let v = 0.05; v <= 0.95; v += 0.15) {
                const [fu, fv] = forwardScreenUV(u, v, screen, HANDHELD, aspect);
                const back = inverseScreenUV(fu, fv, screen, HANDHELD, aspect);
                expect(back).not.toBeNull();
                expect(back[0]).toBeCloseTo(u, 5);
                expect(back[1]).toBeCloseTo(v, 5);
            }
        }
    });

    test("converges for every camera preset", () => {
        for (const preset of ["handheld", "handheldRough", "tripod"]) {
            const screen = screenOf(preset);
            const solved = inverseScreenUV(0.5, 0.5, screen, HANDHELD, 16 / 9);
            expect(solved).not.toBeNull();
        }
    });
});

describe("mapSourceToOutputPixels", () => {
    const WIDTH = 640;
    const HEIGHT = 480;

    test("a still, undistorted camera leaves the truth pixel where it was", () => {
        const screen = {...screenOf("tripod"), barrel: 0, keystone: 0};
        const mapped = mapSourceToOutputPixels(320, 240, screen, STILL, WIDTH, HEIGHT);
        expect(mapped.x).toBeCloseTo(320, 4);
        expect(mapped.y).toBeCloseTo(240, 4);
    });

    test("handheld motion moves it, and by an amount worth correcting for", () => {
        const screen = screenOf("handheldRough");
        const mapped = mapSourceToOutputPixels(320, 240, screen, HANDHELD, WIDTH, HEIGHT);
        const shift = Math.hypot(mapped.x - 320, mapped.y - 240);
        // Uncorrected this would be a labelling error of many pixels on a target that
        // may itself be only a few pixels across.
        expect(shift).toBeGreaterThan(5);
        expect(shift).toBeLessThan(WIDTH / 4);
    });

    test("the mapped point round-trips back through the forward map", () => {
        const screen = screenOf("handheld");
        const source = {x: 210, y: 155};
        const mapped = mapSourceToOutputPixels(source.x, source.y, screen, HANDHELD, WIDTH, HEIGHT);
        const [fu, fv] = forwardScreenUV(
            mapped.x / WIDTH, 1 - mapped.y / HEIGHT, screen, HANDHELD, WIDTH / HEIGHT);
        expect(fu * WIDTH).toBeCloseTo(source.x, 3);
        expect((1 - fv) * HEIGHT).toBeCloseTo(source.y, 3);
    });
});
