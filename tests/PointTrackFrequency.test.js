import {
    amplitudeSpectrum, captureFrequencyTargets, frequencyDecodeRange, frequencySampling, irregularTransform, measurePointFlux,
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

// 10 s at 30 fps: a 2 DN 10 Hz flicker on slow curved drift. The linear detrend
// removes the slope but not the curvature, which then dominates the lowest bins.
const driftAndFlicker = Array.from({length: 300}, (_, i) => 100 + 240 * (i / 300 - .5) ** 2 + 2 * Math.sin(2 * Math.PI * 10 * i / 30));
// The peak search used before the floor existed, applied to a returned spectrum.
const legacyPeak = s => {
    const size = (s.frequencies.length - 1) * 2;
    let peak = Math.ceil(size / s.count);
    for (let i = peak + 1; i < s.amplitude.length; i++) if (s.amplitude[i] > s.amplitude[peak]) peak = i;
    return s.amplitude[peak] > 1e-9 ? {frequency: s.frequencies[peak], amplitude: s.amplitude[peak]} : null;
};

test('without a floor slow drift wins the peak label; a 1.5 Hz floor finds the flicker', () => {
    const unfloored = amplitudeSpectrum(driftAndFlicker, 30, null, {minPeakHz: 0});
    expect(unfloored.peak.frequency).toBeLessThan(.5);
    expect(unfloored.peakFloor).toBe(0);
    const floored = amplitudeSpectrum(driftAndFlicker, 30, null, {minPeakHz: 1.5});
    expect(Math.abs(floored.peak.frequency - 10)).toBeLessThan(floored.binSpacing);
    expect(floored.peak.amplitude).toBeCloseTo(2, 1);
    expect(floored.peakFloor).toBe(1.5);
    expect(floored.peakFloorAboveNyquist).toBe(false);
    // The floor changes only the label, not the spectrum.
    expect(floored.frequencies).toEqual(unfloored.frequencies);
    expect(floored.amplitude).toEqual(unfloored.amplitude);
    // A floor exactly on a bin includes that bin.
    const onBin = amplitudeSpectrum(driftAndFlicker, 30, null, {minPeakHz: floored.peak.frequency});
    expect(onBin.peak).toEqual(floored.peak);
    // Irregular timing uses the same floor.
    const times = driftAndFlicker.map((_, i) => i / 30);
    expect(amplitudeSpectrum(driftAndFlicker, 30, times, {minPeakHz: 1.5}).peak.frequency).toBeCloseTo(floored.peak.frequency, 9);
});

// 20 s at 30 fps: a 50 DN, 3-frame flash 48 times a minute (0.8 Hz), like an aircraft
// anti-collision beacon (40-100 a minute). Short pulses put most of their power in
// the harmonics, so a floor above the flash rate labels a harmonic, not "no peak".
const beacon = Array.from({length: 600}, (_, i) => 100 + (i % 37.5 < 3 ? 50 : 0));

test('the default 0.5 Hz floor keeps a slow beacon and still skips the drift', () => {
    const atDefault = amplitudeSpectrum(beacon, 30, null, {minPeakHz: .5});
    expect(Math.abs(atDefault.peak.frequency - .8)).toBeLessThan(atDefault.binSpacing);
    // A 1.5 Hz floor would label the second harmonic as the flash rate.
    const high = amplitudeSpectrum(beacon, 30, null, {minPeakHz: 1.5});
    expect(Math.abs(high.peak.frequency - 1.6)).toBeLessThan(high.binSpacing);
    // The curved drift of driftAndFlicker is below 0.5 Hz too.
    const drift = amplitudeSpectrum(driftAndFlicker, 30, null, {minPeakHz: .5});
    expect(Math.abs(drift.peak.frequency - 10)).toBeLessThan(drift.binSpacing);
});

test('a peak search floor at or above Nyquist labels no peak and says why', () => {
    for (const minPeakHz of [15, 20, Infinity]) {
        const s = amplitudeSpectrum(driftAndFlicker, 30, null, {minPeakHz});
        expect(s.peak).toBeNull();
        expect(s.peakFloorAboveNyquist).toBe(true);
        expect(s.amplitude.some(value => value > 1)).toBe(true);
    }
    const below = amplitudeSpectrum(driftAndFlicker, 30, null, {minPeakHz: 14.9});
    expect(below.peakFloorAboveNyquist).toBe(false);
    expect(below.peak.frequency).toBeGreaterThanOrEqual(14.9);
});

test('omitting the peak search floor reproduces the original peak search exactly', () => {
    const signals = [driftAndFlicker,
        Array.from({length: 300}, (_, i) => -100 + .3 * i + 12 * Math.sin(2 * Math.PI * 6 * i / 30)),
        Array.from({length: 240}, (_, i) => Math.sin(2 * Math.PI * 22.5 * i / 30)),
        Array.from({length: 17}, (_, i) => 5 * Math.cos(i)),
        new Array(64).fill(-20)];
    for (const values of signals) {
        const s = amplitudeSpectrum(values, 30);
        expect(s.peak).toEqual(legacyPeak(s));
        expect(s.peakFloor).toBe(0);
        expect(s.peakFloorAboveNyquist).toBe(false);
        expect(amplitudeSpectrum(values, 30, null, {minPeakHz: 0})).toEqual(s);
        // A floor below the first searched bin, or not a valid number, changes nothing.
        expect(amplitudeSpectrum(values, 30, null, {minPeakHz: s.frequencies[1] / 2}).peak).toEqual(s.peak);
        expect(amplitudeSpectrum(values, 30, null, {minPeakHz: -3}).peak).toEqual(s.peak);
        expect(amplitudeSpectrum(values, 30, null, {minPeakHz: NaN}).peak).toEqual(s.peak);
    }
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

test('missing source frames are rejected; irregular source timing is flagged', () => {
    expect(() => frequencySampling(source(), [0, ...Array.from({length: 16}, (_, i) => i + 2)])).toThrow(/skips/);
    expect(frequencySampling(source(), Array.from({length: 32}, (_, i) => i)).irregular).toBe(false);
    const s = source(); s.chunks[10].timestamp += 20000;
    s.timestampToChunkIndex = new Map(s.chunks.map((c, i) => [c.timestamp, i]));
    const sampling = frequencySampling(s, Array.from({length: 32}, (_, i) => i));
    expect(sampling.irregular).toBe(true);
    expect(sampling.minFps).toBeCloseTo(1e6 / 53333, 0);
    expect(sampling.maxFps).toBeCloseTo(1e6 / 13333, 0);
});

test('the fast irregular transform matches the direct sum', () => {
    const count = 300, size = 2048;
    let seed = 7;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const positions = Array.from({length: count}, (_, i) => i + (random() - .5) * .8);
    const samples = positions.map(() => random() - .5);
    const re = new Float64Array(size), im = new Float64Array(size);
    irregularTransform(samples, positions, re, im);
    let largest = 0, error = 0;
    for (let k = 0; k <= size / 2; k++) {
        let directRe = 0, directIm = 0;
        for (let i = 0; i < count; i++) {
            const angle = -2 * Math.PI * k * positions[i] / size;
            directRe += samples[i] * Math.cos(angle); directIm += samples[i] * Math.sin(angle);
        }
        largest = Math.max(largest, Math.hypot(directRe, directIm));
        error = Math.max(error, Math.hypot(re[k] - directRe, im[k] - directIm));
    }
    expect(error / largest).toBeLessThan(1e-9);
});

test('a long variable-frame-rate selection is not quadratic', () => {
    // 20,000 samples: the direct sum needed 1.3 billion steps (seconds of frozen page).
    const times = Array.from({length: 20000}, (_, i) => i / 30 + (i % 7 ? 0 : .01));
    const values = times.map(time => Math.sin(2 * Math.PI * 11 * time));
    const started = performance.now();
    const spectrum = amplitudeSpectrum(values, (times.length - 1) / times.at(-1), times);
    expect(performance.now() - started).toBeLessThan(1500);
    expect(spectrum.peak.frequency).toBeCloseTo(11, 1);
});

test('a variable frame rate recovers a fast signal at each frame\'s real time', () => {
    // 30 fps, then 24 fps, then 30 fps again, as in a variable-frame-rate phone video.
    const times = [];
    for (let i = 0, time = 0; i < 400; i++) {
        times.push(time);
        time += i < 100 || i >= 300 ? 1 / 30 : 1 / 24;
    }
    const values = times.map(time => 50 + 4 * Math.sin(2 * Math.PI * 11 * time));
    const fps = (times.length - 1) / times.at(-1);
    const spectrum = amplitudeSpectrum(values, fps, times);
    expect(spectrum.peak.frequency).toBeCloseTo(11, 1);
    expect(spectrum.peak.amplitude).toBeCloseTo(4, 0);
    // With even timing the times argument changes nothing.
    const even = times.map((_, i) => i / 30);
    const evenValues = even.map(time => Math.sin(2 * Math.PI * 7 * time));
    const direct = amplitudeSpectrum(evenValues, 30, even), fast = amplitudeSpectrum(evenValues, 30);
    for (let i = 0; i < fast.amplitude.length; i += 37) expect(direct.amplitude[i]).toBeCloseTo(fast.amplitude[i], 9);
});

test('selected decoding includes a preceding keyframe and B-frame references', () => {
    const s = source([0, 3, 1, 2, ...Array.from({length: 28}, (_, i) => i + 4)]);
    expect(frequencyDecodeRange(s, 1, 2)).toEqual({start: 0, end: 4});
    expect(frequencyDecodeRange(s, 18, 20)).toEqual({start: 16, end: 21});
});
