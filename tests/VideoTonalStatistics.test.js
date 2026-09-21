import {exclusionMask, histogramStatistics, measureTonalFrame} from '../src/videoTonal/TonalStatistics';

test('percentiles use nearest ranks and retain a useful span despite isolated extremes', () => {
    const h = new Uint32Array(256);
    h[0] = 1; h[100] = 49; h[150] = 49; h[255] = 1;
    expect(histogramStatistics(h)).toEqual({count: 100, min: 0, p05: 100, p25: 100,
        median: 100, p75: 150, p95: 150, max: 255, mean: 125.05});
});

test('empty and fully masked samples are missing, not black measurements', () => {
    expect(histogramStatistics(new Uint32Array(256)).median).toBeNaN();
    const result = measureTonalFrame(new Uint8Array([10, 20, 30, 40]), 2, 2, new Uint8Array([1, 1, 1, 1]));
    expect(result.count).toBe(0);
    expect(result.mean).toBeNaN();
    expect(result.p95).toBeNaN();
});

test('mask polarity and the exact alpha threshold match the shared video mask', () => {
    const mask = exclusionMask(4, 1, {width: 4, height: 1, alpha: new Uint8Array([0, 128, 129, 255])});
    expect(Array.from(mask)).toEqual([0, 0, 1, 1]);
    expect(measureTonalFrame(new Uint8Array([20, 40, 200, 255]), 4, 1, mask)).toMatchObject({count: 2, mean: 30, max: 40});
});

test('a reduced-resolution mask maps to native pixels and follows video rotation', () => {
    const mask = {width: 2, height: 1, alpha: new Uint8Array([255, 0])};
    expect(Array.from(exclusionMask(4, 2, mask))).toEqual([1, 1, 0, 0, 1, 1, 0, 0]);
    expect(Array.from(exclusionMask(2, 2, mask, 90))).toEqual([0, 0, 1, 1]);
    expect(Array.from(exclusionMask(2, 2, mask, 180))).toEqual([0, 1, 0, 1]);
    expect(Array.from(exclusionMask(2, 2, mask, 270))).toEqual([1, 1, 0, 0]);
});

test('target and local ring separate target contrast from a shared gain and offset', () => {
    const pixels = new Uint8Array(41 * 41);
    for (let y = 0; y < 41; y++) for (let x = 0; x < 41; x++) pixels[y * 41 + x] = (x < 20 ? 50 : 70);
    for (let y = 18; y < 23; y++) for (let x = 18; x < 23; x++) pixels[y * 41 + x] = 20;
    const target = {u: .5, v: .5, rx: 2 / 41, ry: 2 / 41};
    const original = measureTonalFrame(pixels, 41, 41, null, target);
    const mapped = measureTonalFrame(pixels.map(v => 2 * v + 10), 41, 41, null, target);
    expect(original.target).toBe(20);
    expect(original.localCount).toBeGreaterThan(original.targetCount);
    expect(original.count).toBeLessThan(pixels.length);
    expect(mapped.contrast).toBe(2 * original.contrast);
    expect(mapped.relativeContrast).toBe(original.relativeContrast);
    pixels[20 * 41 + 20] = 0;
    expect(measureTonalFrame(pixels, 41, 41, null, target).contrast).toBeLessThan(original.contrast);
});

test('a flat background has no relative-contrast estimate; a masked target is not measured', () => {
    const pixels = new Uint8Array(41 * 41).fill(100);
    const target = {u: .5, v: .5, rx: 2 / 41, ry: 2 / 41};
    expect(measureTonalFrame(pixels, 41, 41, null, target).relativeContrast).toBeNaN();
    const excluded = new Uint8Array(pixels.length);
    for (let y = 17; y < 24; y++) for (let x = 17; x < 24; x++) excluded[y * 41 + x] = 1;
    const result = measureTonalFrame(pixels, 41, 41, excluded, target);
    expect(result.targetCount).toBe(0);
    expect(result.target).toBeNaN();
    expect(result.local).toBe(100);
    expect(result.contrast).toBeNaN();
});
