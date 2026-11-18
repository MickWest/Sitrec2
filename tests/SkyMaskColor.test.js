import {quadTreeGroundMask} from "../src/SkyMask";

const W = 256, H = 192;
function frame(color, foreground = false) {
    const rgba = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const wall = foreground && x >= 192 && y >= 64;
        const rgb = wall ? [75, 20, 10] : color;
        for (let c = 0; c < 3; c++) rgba[4 * (y * W + x) + c] = rgb[c] + 10 * y / H;
        rgba[4 * (y * W + x) + 3] = 255;
    }
    // Red, blue and white point sources. They must not become foreground islands.
    for (const [sx, sy, rgb] of [[60, 50, [255, 70, 40]], [110, 75, [70, 110, 255]], [150, 130, [255, 255, 255]]]) {
        for (let y = sy - 4; y <= sy + 4; y++) for (let x = sx - 4; x <= sx + 4; x++) {
            const p = Math.exp(-((x - sx) ** 2 + (y - sy) ** 2) / 3);
            for (let c = 0; c < 3; c++) rgba[4 * (y * W + x) + c] += rgb[c] * p;
        }
    }
    return rgba;
}

test.each([[20, 35, 65], [80, 65, 45], [30, 80, 30], [45, 45, 45]])(
    "keeps clear sky and coloured stars for sky RGB %j", (...color) => {
        const result = quadTreeGroundMask(frame(color), W, H);
        expect(result.error).toBeUndefined();
        expect(result.ground.reduce((s, v) => s + v, 0) / (W * H)).toBeLessThan(.02);
        for (const [x, y] of [[60, 50], [110, 75], [150, 130]]) expect(result.ground[y * W + x]).toBe(0);
    });

test("rejects a smooth coloured wall that is nearly the same luminance as the sky", () => {
    const pixels = frame([20, 35, 65], true);
    const old = quadTreeGroundMask(pixels, W, H, {useColor: false});
    const result = quadTreeGroundMask(pixels, W, H);
    expect(result.diagnostics.method).toBe("color-texture");
    const fraction = (mask, x0, y0, x1, y1) => {
        let sum = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) sum += mask[y * W + x];
        return sum / ((x1 - x0) * (y1 - y0));
    };
    expect(fraction(old.ground, 208, 80, W, H)).toBeLessThan(.2);
    expect(fraction(result.ground, 208, 80, W, H)).toBeGreaterThan(.98);
    expect(fraction(result.ground, 16, 16, 175, H - 16)).toBeLessThan(.03);
    // No assumption that ground lies below sky: rotate the same picture upside down.
    const rotated = new Uint8ClampedArray(pixels.length);
    for (let i = 0; i < W * H; i++) rotated.set(pixels.subarray(4 * i, 4 * i + 4), 4 * (W * H - 1 - i));
    const upsideDown = quadTreeGroundMask(rotated, W, H);
    expect(upsideDown.ground[20 * W + 20]).toBe(1);
    expect(upsideDown.ground[100 * W + 150]).toBe(0);
});

test("a black instrument surround cannot become the sky training region", () => {
    const pixels = frame([25, 70, 30]);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (Math.hypot(x - W / 2, y - H / 2) < 80) continue;
        pixels.fill(0, 4 * (y * W + x), 4 * (y * W + x) + 3);
    }
    const out = quadTreeGroundMask(pixels, W, H);
    expect(out.error).toBeUndefined();
    expect(out.ground[0]).toBe(1);
    expect(out.ground[(H / 2) * W + W / 2]).toBe(0);
});
