import {detectSources, rejectReason, gaussianBlur} from "../src/starTrack/StarDetect";
import {detectionMaskFromAlpha, starIsMasked, visibleStarArea} from "../src/starTrack/StarMask";

test("masked foreground cannot affect background, centroids or photometry", () => {
    const W = 128, H = 96, mask = new Uint8Array(W * H);
    const dark = new Uint8ClampedArray(W * H * 4), bright = new Uint8ClampedArray(dark.length);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x;
        mask[i] = x < 40 ? 1 : 0;
        const star = 120 * Math.exp(-((x - 50) ** 2 + (y - 48) ** 2) / 5);
        for (let c = 0; c < 3; c++) {
            const sky = 25 + .06 * x + ((x * 37 + y * 17) % 5) + star;
            dark[4 * i + c] = mask[i] ? 0 : sky;
            bright[4 * i + c] = mask[i] ? (c === 0 ? 255 : 180) : sky;
        }
        dark[4 * i + 3] = bright[4 * i + 3] = 255;
    }
    const options = {excludeMask: mask};
    const a = detectSources(dark, W, H, options), b = detectSources(bright, W, H, options);
    expect(a).toEqual(b);
    const star = a.sources.filter(s => !rejectReason(s)).find(s => Math.hypot(s.x - 50, s.y - 48) < 1);
    expect(star).toBeDefined();
    const all = detectSources(bright, W, H, {excludeMask: new Uint8Array(W * H).fill(1)});
    expect(all.sources).toEqual([]);
    expect(() => detectSources(bright, W, H, {excludeMask: new Uint8Array(2)})).toThrow(/dimensions/);
});

test("smoothing a flat sky beside an excluded wall creates no dark edge", () => {
    const W = 32, H = 24, values = new Float32Array(W * H).fill(40), mask = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < 10; x++) { mask[y * W + x] = 1; values[y * W + x] = 255; }
    const blurred = gaussianBlur(values, W, H, 1, mask);
    for (let y = 0; y < H; y++) for (let x = 10; x < W; x++) expect(blurred[y * W + x]).toBeCloseTo(40, 4);
});

test("alpha sampling and catalog area agree across differing mask and image resolutions", () => {
    const image = {width: 2, height: 2, data: new Uint8ClampedArray(16)};
    image.data[3] = image.data[11] = 255;
    const data = detectionMaskFromAlpha(image, 4, 4);
    expect(Array.from(data)).toEqual([1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0]);
    const mask = {data, width: 4, height: 4, bounds: [10, 20, 110, 220]};
    expect(starIsMasked(mask, 30, 50)).toBe(true);
    expect(starIsMasked(mask, 100, 50)).toBe(false);
    expect(starIsMasked(mask, 120, 50)).toBe(true);
    expect(visibleStarArea(mask, [0, 0, 200, 300])).toBe(10000);
    expect(visibleStarArea(mask, [75, 30, 100, 80])).toBe(1250);
    expect(visibleStarArea(mask, [0, 0, 20, 30])).toBe(0);
});
