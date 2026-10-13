import {
    confirmOffsetPatches, fft2, offsetPairs, offsetPlane, offsetSpectrum, patchCorrelation,
    planOffsetFrames, translationPeaks, patchTextureRank, gaussianImage,
} from "../src/videoNoisePattern/NoiseOffsetMath";
import {searchOffsets, verifyOffset} from "../src/videoNoisePattern/NoiseOffsetSearch";

function seeded(seed = 1) {
    let x = seed >>> 0;
    return () => {
        x = (1664525 * x + 1013904223) >>> 0;
        return x / 0x100000000;
    };
}

function blankImage(width, height, pixels = new Float32Array(width * height), valid = new Uint8Array(width * height).fill(1)) {
    return {width, height, pixels, valid};
}

function texture(rng, width, height, amplitude = 1) {
    const pixels = new Float32Array(width * height);
    for (let i = 0; i < pixels.length; i++) pixels[i] = (rng() * 2 - 1) * amplitude;
    return pixels;
}

function translatedNoisePair({width = 128, height = 96, sx = 32, sy = 30, dx = 28, dy = -16, patchW = 40, patchH = 32} = {}) {
    const rng = seeded(81), a = texture(rng, width, height, 0.025), b = texture(rng, width, height, 0.025);
    const patch = texture(rng, patchW, patchH, 1);
    for (let y = 0; y < patchH; y++) for (let x = 0; x < patchW; x++) {
        a[(sy + y) * width + sx + x] += patch[y * patchW + x];
        b[(sy + dy + y) * width + sx + dx + x] += patch[y * patchW + x];
    }
    return {a: blankImage(width, height, a), b: blankImage(width, height, b), dx, dy, sx, sy, patchW, patchH};
}

describe("2-D offset math", () => {
    test("FFT forward/inverse round-trip restores real and imaginary planes", () => {
        const re = Float32Array.from({length: 32}, (_, i) => Math.sin(i * 0.7) + i / 13);
        const original = Array.from(re); const im = new Float32Array(re.length);
        fft2(re, im, 8, 4);
        fft2(re, im, 8, 4, true);
        for (let i = 0; i < re.length; i++) {
            expect(re[i]).toBeCloseTo(original[i], 4);
            expect(im[i]).toBeCloseTo(0, 4);
        }
    });

    test("offset spectrum subsamples exact 2x2 area blocks and returns a non-wrapped translation", () => {
        const w = 128, h = 96, rng = seeded(7), a = texture(rng, w, h, 0.01), b = texture(rng, w, h, 0.01);
        // An irregular patch close to the right edge translates left across the
        // image. A circular implementation would prefer the opposite +32 shift.
        const pw = 16, ph = 24, px = 106, py = 28, dx = -96, dy = 12, patch = texture(rng, pw, ph, 1);
        for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
            a[(py + y) * w + px + x] += patch[y * pw + x];
            b[(py + dy + y) * w + px + dx + x] += patch[y * pw + x];
        }
        const source = offsetSpectrum(blankImage(w, h, a)), target = offsetSpectrum(blankImage(w, h, b));
        expect([source.width, source.height]).toEqual([w / 2, h / 2]);
        expect(source.fw).toBeGreaterThanOrEqual(2 * source.width - 1);
        expect(source.fh).toBeGreaterThanOrEqual(2 * source.height - 1);
        const peaks = translationPeaks(source, target, 4);
        expect(peaks.length).toBeGreaterThan(0);
        expect(peaks[0].dx).toBeCloseTo(dx, 0);
        expect(peaks[0].dy).toBeCloseTo(dy, 0);
        expect(peaks[0].dx).not.toBeCloseTo(dx + w, 0);
    });

    test("subsampled validity requires all four samples in a 2x2 descriptor cell", () => {
        const w = 8, h = 8, pixels = Float32Array.from({length: w * h}, (_, i) => i);
        const valid = new Uint8Array(w * h).fill(1);
        valid[1 * w + 1] = 0;
        const spectrum = offsetSpectrum(blankImage(w, h, pixels, valid));
        const re = new Float32Array(spectrum.re), im = new Float32Array(spectrum.im);
        fft2(re, im, spectrum.fw, spectrum.fh, true);
        expect(re[0]).toBeCloseTo(0, 5); // first 2x2 block contains one invalid sample
        expect(re[1]).toBeCloseTo((2 + 3 + 10 + 11) / 4, 4);
    });

    test("plane sampling honors descriptor offset, row stride, sample step, and subsampling", () => {
        const data = new Float32Array(48).fill(-999);
        const width = 4, height = 4, offset = 3, stride = 10, step = 2;
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
            data[offset + y * stride + x * step] = y * 10 + x;
        }
        const sampled = offsetPlane({
            data,
            descriptors: {shift: 0, planes: {Cb: {width, height, offset, stride, step, sx: 2, sy: 2}}},
        }, "Cb", 4);
        expect([sampled.width, sampled.height, sampled.scaleX, sampled.scaleY]).toEqual([2, 2, 4, 4]);
        expect(Array.from(sampled.pixels)).toEqual([5.5, 7.5, 25.5, 27.5]);
    });

    test("local patch correlation is one for an exact translated patch and NaN out of bounds", () => {
        const pair = translatedNoisePair();
        const score = patchCorrelation(pair.a, pair.b, pair.sx, pair.sy, pair.sx + pair.dx, pair.sy + pair.dy, pair.patchW, pair.patchH);
        expect(score).toBeCloseTo(1, 2);
        expect(Number.isNaN(patchCorrelation(pair.a, pair.b, -1, 0, 0, 0, 10, 10))).toBe(true);
    });

    test("patch confirmation finds an arbitrary non-32 offset and rejects edge-wrap-only evidence", () => {
        const pair = translatedNoisePair({width: 128, height: 96, sx: 36, sy: 30, dx: 28, dy: -16, patchW: 40, patchH: 32});
        const peaks = translationPeaks(offsetSpectrum(pair.a), offsetSpectrum(pair.b), 4);
        const found = peaks.flatMap(peak => confirmOffsetPatches(pair.a, pair.b, peak));
        expect(found.some(c => Math.abs(c.dx - pair.dx) <= 1 && Math.abs(c.dy - pair.dy) <= 1 && c.score > 0.9)).toBe(true);
        expect(found.every(c => c.x >= 0 && c.y >= 0 && c.tx >= 0 && c.ty >= 0)).toBe(true);
    });
});

describe("bounded offset search and sampling", () => {
    test("sample plan uses each sampled picture's actual preceding distinct frame and respects count", () => {
        const decoded = Array(24).fill(false), held = Array(24).fill(true);
        for (const start of [0, 4, 8, 12, 16, 20]) {
            decoded[start] = decoded[start + 1] = decoded[start + 2] = decoded[start + 3] = true;
            held[start] = false;
        }
        const plan = planOffsetFrames(decoded, held, 100, 3);
        expect(plan.pictures).toBe(6);
        expect(plan.selected).toHaveLength(3);
        expect(plan.selected[0]).toEqual({index: 1, frame: 107, previous: 103});
        expect(plan.selected[1]).toEqual({index: 2, frame: 111, previous: 107});
        expect(plan.selected[2]).toEqual({index: 4, frame: 119, previous: 115});
        expect(plan.targets).toEqual([103, 107, 111, 115, 119]);
    });

    test("pair planner uses decoded-frame lag by default and picture indices only when requested", () => {
        const frames = [{index: 0, frame: 100}, {index: 20, frame: 116}, {index: 40, frame: 140}, {index: 60, frame: 180}];
        expect(offsetPairs(frames, 40)).toEqual([[0, 1], [0, 2], [1, 2], [2, 3]]);
        expect(offsetPairs(frames, 40, true)).toEqual([[0, 1], [0, 2], [1, 2], [1, 3], [2, 3]]);
        expect(offsetPairs(frames, 24, false)).toEqual([[0, 1], [1, 2]]);
    });

    test("searchOffsets recovers a local translated noise patch over different backgrounds", () => {
        const pair = translatedNoisePair({width: 128, height: 96, sx: 32, sy: 30, dx: 28, dy: -16, patchW: 48, patchH: 36});
        const zero = new Float32Array(128 * 96);
        const frames = [
            {current: pair.a, previous: blankImage(128, 96, zero)},
            {current: pair.b, previous: blankImage(128, 96, zero)},
        ];
        const result = searchOffsets(frames, [[0, 1]]);
        expect(result.pairs).toBe(1);
        expect(result.candidates.some(c => Math.abs(c.dx - pair.dx) <= 2 && Math.abs(c.dy - pair.dy) <= 2 && c.score > 0.6)).toBe(true);
    });

    test("random and flat temporal residuals do not produce verified matches", () => {
        const width = 128, height = 96, rng = seeded(19), randomA = texture(rng, width, height, 0.5), randomB = texture(rng, width, height, 0.5);
        const flat = new Float32Array(width * height).fill(7);
        const prev = blankImage(width, height, new Float32Array(width * height));
        const cases = [
            [blankImage(width, height, flat), blankImage(width, height, flat)],
            [blankImage(width, height, randomA), blankImage(width, height, randomB)],
        ];
        for (const [a, b] of cases) {
            const result = searchOffsets([{current: a, previous: prev}, {current: b, previous: prev}], [[0, 1]]);
            expect(result.candidates).toEqual([]);
        }
        const staticResult = searchOffsets([{current: blankImage(width, height, randomA), previous: blankImage(width, height, randomA)},
            {current: blankImage(width, height, randomA), previous: blankImage(width, height, randomA)}], [[0, 1]]);
        expect(staticResult.candidates).toEqual([]);
    });

    test("same-time duplicates never enter the pair planner; fresh SBS copies do not imply temporal recurrence", () => {
        expect(offsetPairs([{index: 0, frame: 12}, {index: 0, frame: 12}], 256)).toEqual([]);
        const width = 128, height = 96, rng = seeded(29);
        const sbs = () => {
            const pixels = new Float32Array(width * height);
            for (let y = 0; y < height; y++) for (let x = 0; x < width / 2; x++) {
                pixels[y * width + x] = pixels[y * width + x + width / 2] = rng() - 0.5;
            }
            return blankImage(width, height, pixels);
        };
        const result = searchOffsets([{current: sbs(), previous: sbs()}, {current: sbs(), previous: sbs()}], [[0, 1]]);
        expect(result.candidates).toEqual([]);
    });

    test("native refinement preserves a translated patch and rejects a malformed candidate", () => {
        const width = 192, height = 128, sx = 1, sy = 1, x = 40, y = 32, dx = 26, dy = -18, pw = 40, ph = 32;
        const rng = seeded(202), patch = texture(rng, pw, ph, 1), currentA = texture(rng, width, height, 0.01), currentB = texture(rng, width, height, 0.01);
        for (let j = 0; j < ph; j++) for (let i = 0; i < pw; i++) {
            currentA[(y + j) * width + x + i] += patch[j * pw + i];
            currentB[(y + dy + j) * width + x + dx + i] += patch[j * pw + i];
        }
        const zeros = new Float32Array(width * height), crops = [
            {...blankImage(width, height, currentA), scaleX: sx, scaleY: sy, x: 0, y: 0},
            {...blankImage(width, height, zeros), scaleX: sx, scaleY: sy, x: 0, y: 0},
            {...blankImage(width, height, currentB), scaleX: sx, scaleY: sy, x: 0, y: 0},
            {...blankImage(width, height, zeros), scaleX: sx, scaleY: sy, x: 0, y: 0},
        ];
        const candidate = {x, y, tx: x + dx, ty: y + dy, width: pw, height: ph, dx, dy, step: 1};
        const verified = verifyOffset(candidate, crops);
        expect(verified).not.toBeNull();
        expect(verified.dx).toBe(dx);
        expect(verified.dy).toBe(dy);
        expect(verified.score).toBeGreaterThan(0.9);
        expect(verifyOffset({...candidate, step: 1, x: width + 10}, crops)).toBeNull();
    });

    test("a repeated complex scene remains in the audit results but fails noise screening", () => {
        const width = 96, height = 96, scene = gaussianImage(texture(seeded(963), width, height, 30), width, height, 3);
        const image = factor => ({...blankImage(width, height, Float32Array.from(scene, v => 100 + factor * v)), x: 0, y: 0, scaleX: 1, scaleY: 1});
        // A brightness change in a photograph produces a perfectly repeated
        // temporal residual, even when its texture has high participation rank.
        const crops = [image(1.2), image(1), image(1.2), image(1)];
        const result = verifyOffset({x: 24, y: 24, tx: 24, ty: 24, width: 48, height: 48, step: 0}, crops);
        expect(result.score).toBeGreaterThan(0.99);
        expect(result.screening).toMatchObject({passed: false, reason: "background"});
    });

    test.each([[3, false], [12, true]])("documents conservative screening of repeated noise with amplitude %s over different photographs", (amplitude, passed) => {
        const width = 96, height = 96, rng = seeded(1982), noise = [texture(rng, width, height, amplitude), texture(rng, width, height, amplitude)];
        const backgrounds = [0, 1].map(() => gaussianImage(texture(rng, width, height, 90), width, height, 3));
        const image = (bg, phase) => ({...blankImage(width, height, Float32Array.from(backgrounds[bg], (v, i) => 100 + v + noise[phase][i])), x: 0, y: 0, scaleX: 1, scaleY: 1});
        const result = verifyOffset({x: 24, y: 24, tx: 24, ty: 24, width: 48, height: 48, step: 0}, [image(0, 0), image(0, 1), image(1, 0), image(1, 1)]);
        expect(result.score).toBeGreaterThan(0.99);
        // The weak mixture is still measured/exported, but its original-frame
        // phase advantage is too small for the conservative default shortlist.
        expect(result.screening).toMatchObject({passed, reason: passed ? "passed" : "phase"});
    });
});


test("texture rank rejects a smooth separable edge and preserves stretched two-dimensional texture", () => {
    const width = 16, height = 64, rng = seeded(571);
    const smooth = Float32Array.from({length: width * height}, (_, i) => Math.sin((i % width) / 8));
    expect(patchTextureRank(blankImage(width, height, smooth), 0, 0, width, height)).toBeCloseTo(1, 5);
    const rich = texture(rng, width, height / 4, 1), stretched = new Float32Array(width * height);
    for (let y = 0; y < height; y++) stretched.set(rich.subarray(Math.floor(y / 4) * width, (Math.floor(y / 4) + 1) * width), y * width);
    expect(patchTextureRank(blankImage(width, height, stretched), 0, 0, width, height)).toBeGreaterThan(4);
    const transposed = new Float32Array(stretched.length);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) transposed[x * height + y] = stretched[y * width + x];
    expect(patchTextureRank(blankImage(height, width, transposed), 0, 0, height, width)).toBeCloseTo(patchTextureRank(blankImage(width, height, stretched), 0, 0, width, height), 6);
});

test("mixed sampling covers nearby phases continuously and still reaches the rest of a long clip", () => {
    const plan = planOffsetFrames(new Uint8Array(400).fill(1), new Uint8Array(400));
    expect(plan.selected).toHaveLength(128);
    expect(plan.selected.slice(0, 64).map(s => s.index)).toEqual(Array.from({length: 64}, (_, i) => i + 1));
    expect(plan.selected.at(-1).index).toBeGreaterThan(390);
    const pairs = offsetPairs(plan.selected, 64);
    for (const lag of [7, 19, 43, 61]) expect(pairs.some(([a, b]) => plan.selected[b].frame - plan.selected[a].frame === lag)).toBe(true);
});
