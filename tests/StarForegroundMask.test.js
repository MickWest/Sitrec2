import {combineForegroundMask, detectFrameSources, foregroundMaskForFrame, ForegroundMaskSequence} from "../src/starTrack/StarForegroundMask";
import {detectSources, rejectReason} from "../src/starTrack/StarDetect";

const W = 256, H = 192;

test("compressed near-black open sky is declined without hiding detections", () => {
    const rgba = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const block = ((x >> 3) + (y >> 3)) % 3;
        const star = 180 * Math.exp(-((x - 100) ** 2 + (y - 80) ** 2) / 8);
        rgba.set([block + star, 2 * block + star, block + star, 255], 4 * (y * W + x));
    }
    const masked = detectFrameSources(rgba, W, H, {autoMaskForeground: true});
    expect(masked.foregroundMask.reliable).toBe(false);
    expect(masked.foregroundMask.data.some(Boolean)).toBe(false);
    expect(masked.sources).toEqual(detectSources(rgba, W, H).sources);
    const fixed = new Uint8Array(W * H); fixed[0] = 1;
    expect(combineForegroundMask(masked.foregroundMask, fixed, W, H)).toBe(fixed);
});

test("portrait masking bounds the long edge and a busy exposure cannot abort detection", () => {
    const w = 540, h = 960, rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const v = ((x >> 2) + (y >> 2)) % 2 ? 240 : 20;
        rgba.set([v, v, v, 255], 4 * (y * w + x));
    }
    const mask = foregroundMaskForFrame(rgba, w, h);
    expect(mask.width).toBe(288);
    expect(mask.height).toBe(512);
    expect(mask.reliable).toBe(false);
});
function exposure(pan = 0, zoom = 1) {
    const rgba = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const wx = (x - W / 2) / zoom + W / 2 + pan;
        const wy = (y - H / 2) / zoom + H / 2;
        const wall = wx >= 192 && wy >= 64;
        const rgb = wall ? [90, 25, 10] : [20, 35, 65];
        const star = !wall ? 160 * Math.exp(-((wx - 100) ** 2 + (wy - 80) ** 2) / 4) : 0;
        for (let c = 0; c < 3; c++) rgba[4 * (y * W + x) + c] = rgb[c] + y / 20 + star;
        rgba[4 * (y * W + x) + 3] = 255;
    }
    return rgba;
}

test("resegments entering and departing foreground through pans and zooms", () => {
    const a = foregroundMaskForFrame(exposure(), W, H);
    const b = foregroundMaskForFrame(exposure(-100), W, H);
    const c = foregroundMaskForFrame(exposure(50, 2), W, H);
    expect(a.data[140 * W + 220]).toBe(1);
    expect(b.data[140 * W + 220]).toBe(0); // same pixel is now open sky
    expect(a.data[140 * W + 180]).toBe(0);
    expect(c.data[140 * W + 180]).toBe(1); // zoomed foreground entered here
    // Processing out of order or retrying a frame must give the same answer.
    expect(foregroundMaskForFrame(exposure(), W, H)).toEqual(a);
});

test("the moving mask reaches extraction and composes with fixed user exclusions", () => {
    const rgba = exposure(), fixed = new Uint8Array(W * H);
    for (let y = 70; y < 90; y++) fixed.fill(1, y * W + 90, y * W + 110);
    const withSky = detectFrameSources(rgba, W, H, {autoMaskForeground: true});
    expect(withSky.sources.filter(s => !rejectReason(s)).some(s => Math.hypot(s.x - 100, s.y - 80) < 1)).toBe(true);
    const before = new Uint8Array(fixed);
    const masked = detectFrameSources(rgba, W, H, {autoMaskForeground: true, excludeMask: fixed});
    expect(fixed).toEqual(before);
    expect(masked.sources.filter(s => !rejectReason(s)).some(s => Math.hypot(s.x - 100, s.y - 80) < 1)).toBe(false);
    expect(detectFrameSources(rgba, W, H).sources).toEqual(detectSources(rgba, W, H).sources);
    const tiny = {width: 2, height: 1, data: new Uint8Array([1, 0])};
    expect(Array.from(combineForegroundMask(tiny, new Uint8Array([0, 0, 0, 1]), 4, 1))).toEqual([1, 1, 0, 1]);
});

test("preview cache preserves exact masks by source frame and never reuses a neighbor", () => {
    const sequence = new ForegroundMaskSequence(4);
    const a = {width: 9, height: 1, data: new Uint8Array([1, 0, 1, 0, 0, 0, 0, 0, 1])};
    const b = {width: 9, height: 1, data: new Uint8Array(9)};
    sequence.set(20, a);
    sequence.set(10, b); // workers need not finish in frame order
    expect(sequence.get(20)).toEqual(a);
    expect(sequence.get(11)).toBeNull();
    expect(sequence.get(10)).toEqual(b);
    sequence.set(20, b);
    expect(sequence.bytes).toBe(4);
    expect(sequence.get(20)).toEqual(b);
    sequence.set(30, a);
    expect(sequence.get(10)).toBeNull();
    expect(sequence.get(30)).toEqual(a);
});

test("night-vision black surround cannot invert the active sky into foreground", () => {
    const rgba = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const live = Math.hypot(x - W / 2, y - H / 2) < 85;
        rgba.set(live ? [30, 70, 35, 255] : [0, 0, 0, 255], 4 * (y * W + x));
    }
    const mask = foregroundMaskForFrame(rgba, W, H);
    expect(mask.reliable).toBe(true);
    expect(mask.data[0]).toBe(1);
    expect(mask.data[(H / 2) * W + W / 2]).toBe(0);
    let lostSky = 0;
    for (let y = 50; y < 142; y++) for (let x = 90; x < 166; x++) lostSky += mask.data[y * W + x];
    expect(lostSky).toBe(0);
});

test("an isolated bright bloom in open sky is retained for detection", () => {
    const rgba = exposure(-100);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const excess = 220 * Math.exp(-((x - 128) ** 2 + (y - 96) ** 2) / 120);
        for (let c = 0; c < 3; c++) rgba[4 * (y * W + x) + c] += excess;
    }
    const mask = foregroundMaskForFrame(rgba, W, H);
    expect(mask.data[96 * W + 128]).toBe(0);
    expect(mask.data.reduce((s, v) => s + v, 0)).toBe(0);
});
