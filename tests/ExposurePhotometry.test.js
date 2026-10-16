// Shared long-exposure photometry: sampling, point spread and trail vertex choice.
import {
    alongTrackFraction, chooseTrailVertices, exposureSampleOffsets, psfCentreFraction,
} from "../src/ExposurePhotometry";

describe("exposureSampleOffsets", () => {
    test("continuous: every step frames, ending exactly on the last frame", () => {
        expect(exposureSampleOffsets({numFrames: 95, step: 30, stackMode: false})).toEqual([0, 30, 60, 90, 95]);
        expect(exposureSampleOffsets({numFrames: 90, step: 30, stackMode: false})).toEqual([0, 30, 60, 90]);
    });

    test("stack: window boundaries are samples, so no interval crosses one", () => {
        const offsets = exposureSampleOffsets({numFrames: 100, step: 30, stackMode: true, stackFrames: 45});
        expect(offsets).toEqual([0, 30, 45, 60, 90, 100]);
    });
});

describe("point spread", () => {
    test("a static source keeps the centre fraction; a long streak spreads to about 1/length", () => {
        const sigma = 0.6;
        expect(alongTrackFraction(0, sigma)).toBeCloseTo(psfCentreFraction(sigma), 6);
        expect(alongTrackFraction(1e-6, sigma)).toBeCloseTo(psfCentreFraction(sigma), 6);
        expect(alongTrackFraction(200, sigma) * 200).toBeCloseTo(1, 3);
        // falls monotonically between the two
        let previous = Infinity;
        for (const L of [0.1, 0.5, 1, 2, 5, 20]) {
            const a = alongTrackFraction(L, sigma);
            expect(a).toBeLessThan(previous);
            previous = a;
        }
    });

    test("the centre fraction matches a numerical integral of the Gaussian over one pixel", () => {
        const sigma = 0.8;
        let sum = 0;
        const n = 20000;
        for (let i = 0; i < n; i++) {
            const x = -0.5 + (i + 0.5) / n;
            sum += Math.exp(-x * x / (2 * sigma * sigma)) / (sigma * Math.sqrt(2 * Math.PI)) / n;
        }
        expect(psfCentreFraction(sigma)).toBeCloseTo(sum, 5);
    });
});

describe("chooseTrailVertices", () => {
    const times = Array.from({length: 301}, (_, i) => i);

    test("covers only the visible span, from the last dark sample to the first dark one", () => {
        const bright = times.map(t => (t >= 100 && t <= 140) ? 0.5 : 0);
        const v = chooseTrailVertices(times, bright, 20, 0.1);
        expect(v[0]).toBe(99);
        expect(v.at(-1)).toBe(141);
        // 20 segments, all inside the span
        expect(v.length).toBe(21);
        expect(new Set(v).size).toBe(21);
    });

    test("a flare gets vertices on its rise, its peak and its fall", () => {
        // faint all the way, a sharp flare at t = 200
        const bright = times.map(t => 0.2 + 0.7 * Math.exp(-(((t - 200) / 4) ** 2)));
        const v = chooseTrailVertices(times, bright, 20, 0.1);
        expect(v[0]).toBe(0);
        expect(v.at(-1)).toBe(300);
        const inFlare = v.filter(i => i >= 190 && i <= 210).length;
        expect(inFlare).toBeGreaterThanOrEqual(6);
        expect(v.some(i => Math.abs(i - 200) <= 1)).toBe(true);
    });

    test("nothing visible gives null", () => {
        expect(chooseTrailVertices(times, times.map(() => 0), 20, 0.1)).toBeNull();
    });
});
