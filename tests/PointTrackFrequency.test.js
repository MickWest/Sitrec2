import {
    amplitudeSpectrum, captureFrequencyTargets, frequencyDecodeRange, frequencySampling, measurePointFlux,
} from '../src/pointFrequency/PointFrequencyStatistics';
import {rotatedUV} from '../src/videoTonal/TonalStatistics';

const target = {u: .5, v: .5, rx: 4 / 40, ry: 4 / 40};
const positions = n => new Map(Array.from({length: n}, (_, i) => [i, {x: 20, y: 20}]));
const capture = (extra = {}) => captureFrequencyTargets({frame0: 0, frame1: 31, positions: positions(32),
    width: 40, height: 40, radius: 4, displayIndex: f => f, ...extra});
const source = (order = Array.from({length: 32}, (_, i) => i), fps = 30) => {
    const chunks = order.map((i, n) => ({timestamp: Math.round(i * 1e6 / fps), type: n % 16 === 0 ? 'key' : 'delta'}));
    return {chunks, timestampToChunkIndex: new Map(chunks.map((chunk, n) => [chunk.timestamp, order[n]]))};
};

test('signed aperture flux removes a changing background without rectifying dark targets', () => {
    const flux = [], local = [];
    for (let i = 0; i < 240; i++) {
        const background = 100 + Math.round(10 * Math.sin(2 * Math.PI * 2 * i / 30));
        const pixels = new Uint8Array(1600).fill(background);
        for (const j of [19 * 40 + 19, 19 * 40 + 20, 20 * 40 + 19, 20 * 40 + 20]) {
            pixels[j] -= 40 + Math.round(10 * Math.sin(2 * Math.PI * 7.5 * i / 30));
        }
        const measured = measurePointFlux(pixels, 40, 40, null, target);
        expect(measured.area).toBeCloseTo(Math.PI * 16, 0);
        expect(measured.flux).toBeLessThan(0);
        flux.push(measured.flux); local.push(measured.background);
    }
    const spectrum = amplitudeSpectrum(flux, 30);
    expect(spectrum.mean).toBeCloseTo(-160, 5);
    expect(spectrum.peak.frequency).toBeCloseTo(7.5, 5);
    expect(spectrum.peak.amplitude).toBeCloseTo(40, 1);
    expect(amplitudeSpectrum(local, 30).peak.frequency).toBeCloseTo(2, 1);
});

test('a sinusoid retains its semi-amplitude after linear detrending and Hann windowing', () => {
    const values = Array.from({length: 300}, (_, i) => -100 + .3 * i + 12 * Math.sin(2 * Math.PI * 6 * i / 30));
    const s = amplitudeSpectrum(values, 30);
    expect(Math.abs(s.peak.frequency - 6)).toBeLessThan(s.frequencies[1] / 2);
    expect(s.peak.amplitude).toBeCloseTo(12, 1);
    expect(s.duration).toBe(10);
    expect(s.binSpacing).toBe(.1);
    expect(s.nyquist).toBe(15);
    expect(s.frequencies[1]).toBeLessThan(s.binSpacing);
});

test('a constant or linear signal has no reported oscillation', () => {
    expect(amplitudeSpectrum(new Array(64).fill(-20), 30).peak).toBeNull();
    expect(amplitudeSpectrum(Array.from({length: 64}, (_, i) => 10 + i / 8), 30).peak).toBeNull();
});

test('short windows and missing samples are rejected instead of zero-filled', () => {
    expect(() => amplitudeSpectrum([1, 2, 3], 30)).toThrow(/16/);
    const values = new Array(64).fill(100); values[30] = NaN;
    expect(() => amplitudeSpectrum(values, 30)).toThrow(/missing/);
});

test('Nyquist amplitude is not doubled; above-Nyquist modulation aliases below it', () => {
    const atLimit = amplitudeSpectrum(Array.from({length: 240}, (_, i) => 50 + 3 * (-1) ** i), 30);
    expect(atLimit.amplitude.at(-1)).toBeCloseTo(3, 4);
    const aliased = amplitudeSpectrum(Array.from({length: 240}, (_, i) => Math.sin(2 * Math.PI * 22.5 * i / 30)), 30);
    expect(aliased.peak.frequency).toBe(7.5);
});

test('masked or off-image apertures are missing, and excluded background pixels are ignored', () => {
    const pixels = new Uint8Array(1600).fill(100), mask = new Uint8Array(1600);
    mask[20 * 40 + 20] = 1;
    expect(measurePointFlux(pixels, 40, 40, mask, target).flux).toBeNaN();
    expect(measurePointFlux(pixels, 40, 40, null, {...target, u: .01}).flux).toBeNaN();
    mask.fill(0); mask[20 * 40 + 28] = 1; pixels[20 * 40 + 28] = 255;
    expect(measurePointFlux(pixels, 40, 40, mask, target).flux).toBe(0);
});

test.each([0, 90, 180, 270])('the aperture maps correctly through %i degree video rotation', rotation => {
    const width = 60, height = 40, pixels = new Uint8Array(width * height).fill(100);
    pixels[15 * width + 22] = 140;
    const [u, v] = rotatedUV(22.5 / width, 15.5 / height, rotation);
    const swap = rotation === 90 || rotation === 270;
    const t = {u, v, rx: 3 / (swap ? height : width), ry: 3 / (swap ? width : height)};
    expect(measurePointFlux(pixels, width, height, null, t, rotation).flux).toBeCloseTo(40, 5);
});

test('clipping in the aperture is recorded for the graph warning', () => {
    const pixels = new Uint8Array(1600).fill(100); pixels[20 * 40 + 20] = 255;
    expect(measurePointFlux(pixels, 40, 40, null, target).clippedFraction).toBeGreaterThan(0);
    pixels[20 * 40 + 20] = 235;
    expect(measurePointFlux(pixels, 40, 40, null, target, 0, [16, 235]).clippedFraction).toBeGreaterThan(0);
});

test('capture respects inclusive In/Out and does not extrapolate a partial track', () => {
    const p = positions(32);
    expect(capture({frame0: 4, frame1: 20, positions: p}).indices).toEqual(Array.from({length: 17}, (_, i) => i + 4));
    p.delete(15);
    expect(() => capture({positions: p})).toThrow(/1 source frame/);
});

test('estimated and explicitly unmeasured positions cannot supply brightness samples', () => {
    const p = positions(32);
    p.set(10, {x: 20, y: 20, estimated: true});
    expect(() => capture({positions: p})).toThrow(/1 source frame/);
    p.set(10, {x: 20, y: 20}); p.unmeasuredFrames = new Set([12]);
    expect(() => capture({positions: p})).toThrow(/1 source frame/);
});

test('held playback slots are counted once and source timing determines Hz', () => {
    const plan = capture({displayIndex: f => Math.floor(f / 2)});
    expect(plan.indices.length).toBe(16);
    expect(frequencySampling(source(), plan.indices).fps).toBeCloseTo(30, 3);
});

test('source presentation order handles B frames and fractional frame rates', () => {
    const order = [0, 3, 1, 2, ...Array.from({length: 28}, (_, i) => i + 4)];
    const sampling = frequencySampling(source(order, 30000 / 1001), Array.from({length: 32}, (_, i) => i));
    expect(sampling.fps).toBeCloseTo(30000 / 1001, 4);
});

test('missing source frames and irregular source timing are rejected', () => {
    expect(() => frequencySampling(source(), [0, ...Array.from({length: 16}, (_, i) => i + 2)])).toThrow(/skips/);
    const s = source(); s.chunks[10].timestamp += 20000;
    s.timestampToChunkIndex = new Map(s.chunks.map((c, i) => [c.timestamp, i]));
    expect(() => frequencySampling(s, Array.from({length: 32}, (_, i) => i))).toThrow(/irregular/);
});

test('selected decoding includes a preceding keyframe and B-frame references', () => {
    const s = source([0, 3, 1, 2, ...Array.from({length: 28}, (_, i) => i + 4)]);
    expect(frequencyDecodeRange(s, 1, 2)).toEqual({start: 0, end: 4});
    expect(frequencyDecodeRange(s, 18, 20)).toEqual({start: 16, end: 21});
});
