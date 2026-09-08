// The recorded-off-a-screen stage moves the picture, so anything holding ground truth
// against the rendered frame has to map it through the same transform. The benchmark
// recorder does exactly that for its target pixel, so the inverse has to be right.

import {
    forwardScreenUV,
    inverseScreenUV,
    mapSourceToOutputPixels,
    screenFill,
} from "../src/videoFilters/screenGeometry";
import {resolveVideoFilterSettings} from "../src/videoFilters/VideoFilterSettings";

const screenOf = (preset) => resolveVideoFilterSettings({screen: {enabled: true, preset}}).screen;

// A representative frame's worth of handheld motion: offset, rotation, crop.
const HANDHELD = [0.021, -0.014, 0.018, 1.09];
const STILL = [0, 0, 0, 1];

// A camera whose lens and framing are neutral: the screen exactly fills a frame of the
// same shape as the output, with no distortion. The map should then be the identity.
function neutralScreen(aspect) {
    const screen = {...screenOf("tripod"), barrel: 0, keystone: 0, cameraAspect: aspect};
    // Pick a distance that makes the screen exactly fill the frame width.
    screen.hfov = 2 * Math.atan(screen.screenWidthM / 2 / screen.screenDistanceM) * 180 / Math.PI;
    return screen;
}

describe("screenFill", () => {
    test("a screen exactly as wide as the frame fills it", () => {
        // 1.2 m wide at 0.9 m; a lens that just spans it is 2*atan(0.6/0.9).
        const hfov = 2 * Math.atan(0.6 / 0.9) * 180 / Math.PI;
        const fill = screenFill({hfov, cameraAspect: 16 / 9, screenWidthM: 1.2, screenDistanceM: 0.9}, 16 / 9);
        expect(fill.fillX).toBeCloseTo(1, 6);
        expect(fill.fillY).toBeCloseTo(1, 6);
    });

    test("standing further back makes the screen smaller in frame", () => {
        const near = screenFill({hfov: 65, cameraAspect: 16 / 9, screenWidthM: 1.2, screenDistanceM: 0.9}, 16 / 9);
        const far = screenFill({hfov: 65, cameraAspect: 16 / 9, screenWidthM: 1.2, screenDistanceM: 1.8}, 16 / 9);
        // Twice the distance, half the angular size.
        expect(far.fillX).toBeCloseTo(near.fillX / 2, 6);
    });

    test("a wider lens fits more in, so the screen covers less of the frame", () => {
        const narrow = screenFill({hfov: 40, cameraAspect: 16 / 9, screenWidthM: 1.2, screenDistanceM: 0.9}, 16 / 9);
        const wide = screenFill({hfov: 90, cameraAspect: 16 / 9, screenWidthM: 1.2, screenDistanceM: 0.9}, 16 / 9);
        expect(wide.fillX).toBeLessThan(narrow.fillX);
    });

    test("a wider screen than the camera's frame is taller in it, proportionally", () => {
        const fill = screenFill({hfov: 65, cameraAspect: 16 / 9, screenWidthM: 1.2, screenDistanceM: 0.9}, 4 / 3);
        // A 4:3 picture in a 16:9 frame is relatively taller than it is wide.
        expect(fill.fillY / fill.fillX).toBeCloseTo((16 / 9) / (4 / 3), 6);
    });
});

describe("forward mapping", () => {
    test("with the screen exactly filling a matching frame, the map is the identity", () => {
        const aspect = 16 / 9;
        const screen = neutralScreen(aspect);
        for (const [u, v] of [[0.5, 0.5], [0.1, 0.9], [0.73, 0.22]]) {
            const [fu, fv] = forwardScreenUV(u, v, screen, STILL, aspect, aspect);
            expect(fu).toBeCloseTo(u, 6);
            expect(fv).toBeCloseTo(v, 6);
        }
    });

    test("cropping in samples a smaller region, so the picture is magnified", () => {
        const aspect = 16 / 9;
        const screen = neutralScreen(aspect);
        const [fu] = forwardScreenUV(1, 0.5, screen, [0, 0, 0, 1.2], aspect, aspect);
        expect(fu).toBeLessThan(1);
        expect(fu).toBeCloseTo(0.5 + 0.5 / 1.2, 5);
    });

    test("standing back puts the screen edge inside the frame, exposing the room", () => {
        const aspect = 16 / 9;
        const near = neutralScreen(aspect);
        const far = {...near, screenDistanceM: near.screenDistanceM * 2};
        // At the frame edge the near camera is just on the screen; the far one is past it.
        expect(forwardScreenUV(0.999, 0.5, near, STILL, aspect, aspect)[0]).toBeLessThanOrEqual(1);
        expect(forwardScreenUV(0.999, 0.5, far, STILL, aspect, aspect)[0]).toBeGreaterThan(1);
    });

    test("barrel distortion pulls the sampled radius in", () => {
        const aspect = 16 / 9;
        const screen = {...neutralScreen(aspect), keystone: 0, barrel: 0.09};
        const withBarrel = forwardScreenUV(1, 1, screen, STILL, aspect, aspect);
        const without = forwardScreenUV(1, 1, {...screen, barrel: 0}, STILL, aspect, aspect);
        expect(Math.abs(withBarrel[0] - 0.5)).toBeLessThan(Math.abs(without[0] - 0.5));
    });
});

describe("inverse mapping", () => {
    test("inverts the forward map to well under a pixel, across the frame", () => {
        const screen = screenOf("handheldRough");
        const aspect = 16 / 9;
        for (let u = 0.05; u <= 0.95; u += 0.15) {
            for (let v = 0.05; v <= 0.95; v += 0.15) {
                const [fu, fv] = forwardScreenUV(u, v, screen, HANDHELD, aspect, aspect);
                const back = inverseScreenUV(fu, fv, screen, HANDHELD, aspect, aspect);
                expect(back).not.toBeNull();
                expect(back[0]).toBeCloseTo(u, 5);
                expect(back[1]).toBeCloseTo(v, 5);
            }
        }
    });

    test("converges for every camera preset", () => {
        for (const preset of ["handheld", "handheldRough", "tripod"]) {
            const screen = screenOf(preset);
            const solved = inverseScreenUV(0.5, 0.5, screen, HANDHELD, 16 / 9, 16 / 9);
            expect(solved).not.toBeNull();
        }
    });
});

describe("mapSourceToOutputPixels", () => {
    const WIDTH = 640;
    const HEIGHT = 480;

    test("a still, undistorted camera leaves the truth pixel where it was", () => {
        const screen = neutralScreen(WIDTH / HEIGHT);
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
            mapped.x / WIDTH, 1 - mapped.y / HEIGHT, screen, HANDHELD, WIDTH / HEIGHT, WIDTH / HEIGHT);
        expect(fu * WIDTH).toBeCloseTo(source.x, 3);
        expect((1 - fv) * HEIGHT).toBeCloseTo(source.y, 3);
    });
});
