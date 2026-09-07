// Tests for the diffraction PSF engine behind tools/psf and the camera glare pass.
//
// These modules live in tools/ because the Diffraction PSF Studio is served as raw ES
// modules with no bundler, but src/CameraPSF.js imports the format definition from the same
// place so the encoder and the decoder cannot drift. They are pure - no THREE, no DOM, no
// Sitrec globals - which is what makes them testable here at all.
//
// The assertions are deliberately physical rather than golden-value: an Airy pattern has a
// first zero at a known radius, N spider vanes throw a known NUMBER of spikes in known
// DIRECTIONS, and a convolution kernel conserves flux. A snapshot would pass just as happily
// with the transform subtly wrong.

import { FFT2D, fftshift } from "../tools/psf/fft.js";
import { buildSpectralSamples, wavelengthToRGB } from "../tools/psf/cie.js";
import { rasterStop, DEFAULT_STOP } from "../tools/psf/aperture.js";
import { computePSF, DEFAULT_SPEC, describeSampling } from "../tools/psf/psf.js";
import { presetById, PRESETS } from "../tools/psf/presets.js";
import { rgbeEncode, rgbeDecode, validatePSFFile } from "../tools/psf/psfFile.js";

/** A small, monochromatic spec - fast enough to run many of them. */
function specFor(stopOverrides, over = {}) {
    const spec = JSON.parse(JSON.stringify(DEFAULT_SPEC));
    Object.assign(spec, { n: 256, fill: 0.5, supersample: 2 }, over);
    spec.spectrum = { nm0: 550, nm1: 550, steps: 1, kind: "flat", kelvin: 5500 };
    spec.stops = [{ ...JSON.parse(JSON.stringify(DEFAULT_STOP)), ...stopOverrides, weight: 1 }];
    spec.stops[1] = { ...JSON.parse(JSON.stringify(DEFAULT_STOP)), enabled: false };
    if (stopOverrides.vanes) spec.stops[0].vanes = { ...DEFAULT_STOP.vanes, ...stopOverrides.vanes };
    return spec;
}

/** Peak-normalised mean-channel value at a polar offset from the PSF centre.
 *
 *  Bilinear, not nearest. Rounding the offset to whole pixels quantises the sampling RADIUS
 *  by up to half a pixel, and on the steep flank of an Airy ring that is a large change in
 *  value - enough to invent local maxima in a perfectly circular pattern. */
function sampleAt(result, angleDeg, radiusPx) {
    const n = result.n;
    const a = (angleDeg * Math.PI) / 180;
    const fx = n / 2 + radiusPx * Math.cos(a);
    const fy = n / 2 + radiusPx * Math.sin(a);
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    if (x0 < 0 || y0 < 0 || x0 + 1 >= n || y0 + 1 >= n) return 0;
    const tx = fx - x0, ty = fy - y0;
    const at = (x, y) => {
        const i = (y * n + x) * 3;
        return (result.rgb[i] + result.rgb[i + 1] + result.rgb[i + 2]) / 3;
    };
    const v = (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty)
            + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty;
    return v / result.peak;
}

/** Mean value over a RADIAL BAND at one angle. Averaging across radii washes out the ring
 *  structure, which is a function of radius alone and so says nothing about direction -
 *  leaving only the angular variation that spikes actually produce. */
function ray(result, angleDeg, r0 = 30, r1 = 50) {
    let sum = 0, count = 0;
    for (let r = r0; r <= r1; r += 1) { sum += sampleAt(result, angleDeg, r); count++; }
    return sum / count;
}

/** Directions, every 5 degrees over 180, where the PSF is a local maximum well above the
 *  25th-percentile background. The percentile matters: three vanes put six spikes in a
 *  180-degree sweep, so a MEDIAN-based background is itself a spike. */
function spikeDirections(result, r0 = 30, r1 = 50, factor = 4) {
    const samples = [];
    for (let a = 0; a < 180; a += 5) samples.push([a, ray(result, a, r0, r1)]);
    const sorted = samples.map(([, v]) => v).sort((p, q) => p - q);
    const background = sorted[Math.floor(sorted.length * 0.25)] || 1e-30;
    return samples
        .filter(([, v], i) =>
            v > background * factor &&
            v >= samples[(i - 1 + samples.length) % samples.length][1] &&
            v >= samples[(i + 1) % samples.length][1])
        .map(([a]) => a);
}

describe("FFT", () => {
    test("a delta at the origin transforms to a flat unit field", () => {
        const n = 8;
        const re = new Float64Array(n * n), im = new Float64Array(n * n);
        re[0] = 1;
        new FFT2D(n).transform(re, im);
        for (let i = 0; i < n * n; i++) {
            expect(re[i]).toBeCloseTo(1, 12);
            expect(im[i]).toBeCloseTo(0, 12);
        }
    });

    test("forward then inverse round-trips", () => {
        const n = 16;
        const re = new Float64Array(n * n), im = new Float64Array(n * n);
        for (let i = 0; i < n * n; i++) { re[i] = Math.sin(i * 1.7); im[i] = Math.cos(i * 0.3); }
        const re0 = re.slice(), im0 = im.slice();
        const fft = new FFT2D(n);
        fft.transform(re, im, false);
        fft.transform(re, im, true);
        for (let i = 0; i < n * n; i++) {
            expect(re[i]).toBeCloseTo(re0[i], 10);
            expect(im[i]).toBeCloseTo(im0[i], 10);
        }
    });

    test("fftshift is its own inverse for even n", () => {
        const n = 8, a = new Float64Array(n * n).map((_, i) => i);
        const a0 = a.slice();
        fftshift(a, n);
        expect(Array.from(a)).not.toEqual(Array.from(a0));
        fftshift(a, n);
        expect(Array.from(a)).toEqual(Array.from(a0));
    });

    test("rejects a non-power-of-two length", () => {
        expect(() => new FFT2D(12)).toThrow(/power of two/);
    });
});

describe("colour", () => {
    test("named wavelengths land in the expected channel", () => {
        const [, , b450] = wavelengthToRGB(450);
        const [, g550] = wavelengthToRGB(550);
        const [r620] = wavelengthToRGB(620);
        expect(b450).toBeGreaterThan(wavelengthToRGB(450)[0]);   // 450 nm is blue-dominant
        expect(g550).toBeGreaterThan(wavelengthToRGB(550)[2]);   // 550 nm is green-dominant
        expect(r620).toBeGreaterThan(wavelengthToRGB(620)[1]);   // 620 nm is red-dominant
    });

    test("the full band integrates to neutral white", () => {
        const s = buildSpectralSamples(350, 780, 32);
        const total = [0, 0, 0];
        for (let i = 0; i < 32; i++) for (let c = 0; c < 3; c++) total[c] += s.rgb[i * 3 + c];
        expect(total[1] / total[0]).toBeCloseTo(1, 6);
        expect(total[2] / total[0]).toBeCloseTo(1, 6);
    });
});

describe("pupil rasterisation", () => {
    test("a circular stop transmits about the area of its circle", () => {
        const n = 256, fill = 0.5;
        const mask = rasterStop({ shape: "circle", obstruction: 0, vanes: { count: 0 } }, n, fill, 3);
        let sum = 0;
        for (let i = 0; i < mask.length; i++) sum += mask[i];
        const expected = Math.PI * Math.pow((fill * n) / 2, 2);
        expect(sum / expected).toBeCloseTo(1, 1);
    });

    test("a central obstruction removes its own area", () => {
        const n = 256, fill = 0.5, obstruction = 0.3;   // fraction of DIAMETER
        const base = { shape: "circle", vanes: { count: 0 } };
        const open = rasterStop({ ...base, obstruction: 0 }, n, fill, 3);
        const blocked = rasterStop({ ...base, obstruction }, n, fill, 3);
        const area = (m) => m.reduce((a, b) => a + b, 0);
        // The obstruction radius is `obstruction` in units where the pupil RADIUS is 1.
        // Blocked AREA fraction is the square of the diameter fraction.
        expect(1 - area(blocked) / area(open)).toBeCloseTo(obstruction * obstruction, 2);
    });

    test("a disabled stop rasterises to nothing", () => {
        const mask = rasterStop({ enabled: false }, 64, 0.5, 1);
        expect(mask.reduce((a, b) => a + b, 0)).toBe(0);
    });
});

describe("point spread function", () => {
    test("an unobstructed circle gives an Airy pattern with the right first zero", () => {
        const fill = 0.25;
        const result = computePSF(specFor(
            { shape: "circle", obstruction: 0, vanes: { count: 0 } }, { fill }));

        // 1.22 lambda/D in output pixels is 1.22 * n / pupilPx, independent of wavelength.
        const predicted = (1.22 * result.n) / (fill * result.n);

        const profile = [];
        for (let x = 0; x < 12; x++) profile.push(sampleAt(result, 0, x));

        // Monotonically decreasing out to the first zero...
        for (let x = 1; x < Math.floor(predicted); x++) {
            expect(profile[x]).toBeLessThan(profile[x - 1]);
        }
        // ...and the minimum lands within a pixel of where it should.
        let minAt = 1;
        for (let x = 2; x < 9; x++) if (profile[x] < profile[minAt]) minAt = x;
        expect(Math.abs(minAt - predicted)).toBeLessThanOrEqual(1);
    });

    test("the PSF is an energy-preserving kernel whatever it is made of", () => {
        for (const id of ["airy", "newtonian", "chandelier"]) {
            const spec = presetById(id).spec;
            spec.n = 128;
            spec.spectrum.steps = 4;
            const result = computePSF(spec);
            let total = 0;
            for (let i = 0; i < result.n * result.n; i++) {
                total += (result.rgb[i * 3] + result.rgb[i * 3 + 1] + result.rgb[i * 3 + 2]) / 3;
            }
            expect(total).toBeCloseTo(1, 5);
        }
    });

    test("N vanes give 2N spikes for odd N and N for even N", () => {
        // Four vanes 90 degrees apart are two COLLINEAR pairs, so they share spikes: 4, not 8.
        const four = computePSF(specFor({
            shape: "circle", obstruction: 0.25,
            vanes: { count: 4, rotationDeg: 0, apodize: "none", width: 0.02 },
        }));
        expect(spikeDirections(four)).toEqual([0, 90]);          // plus their 180 deg twins

        // Three vanes are not collinear, so each throws its own pair: 6 spikes.
        const three = computePSF(specFor({
            shape: "circle", obstruction: 0.25,
            vanes: { count: 3, rotationDeg: 90, apodize: "none", width: 0.02 },
        }));
        expect(spikeDirections(three)).toEqual([0, 60, 120]);
    });

    test("rotating the vanes rotates the spikes with them", () => {
        const rotated = computePSF(specFor({
            shape: "circle", obstruction: 0.25,
            vanes: { count: 4, rotationDeg: 45, apodize: "none", width: 0.02 },
        }));
        expect(spikeDirections(rotated)).toEqual([45, 135]);
    });

    test("an unobstructed circle throws no spikes at all", () => {
        const airy = computePSF(specFor({ shape: "circle", obstruction: 0, vanes: { count: 0 } }));
        expect(spikeDirections(airy)).toEqual([]);
    });

    test("a square stop throws exactly the vertical and horizontal cross", () => {
        const square = computePSF(specFor(
            { shape: "square", obstruction: 0, vanes: { count: 0 } }, { fill: 0.4 }));
        expect(spikeDirections(square)).toEqual([0, 90]);
    });

    test("heavy apodisation fans a spike until it drops below the background", () => {
        // The measured behaviour that set the presets: wave depth is a fraction of the vane
        // half-width, and past about 0.4 the edge slope spreads the spike so widely that it
        // no longer stands above the light between the spikes.
        const vanes = { count: 4, rotationDeg: 45, width: 0.045, apodize: "sawtooth", apodPeriod: 0.15 };
        const contrast = (apodAmplitude) => {
            const r = computePSF(specFor({
                shape: "circle", obstruction: 0.28,
                vanes: { ...vanes, apodAmplitude, apodize: apodAmplitude ? "sawtooth" : "none" },
            }, { fill: 0.55 }));
            const background = (ray(r, 70) + ray(r, 75) + ray(r, 80)) / 3;
            return ray(r, 45) / background;
        };
        // Measured: 7.3, 5.0 and 1.4 respectively.
        expect(contrast(0)).toBeGreaterThan(4);       // a straight vane: a clear hairline spike
        expect(contrast(0.2)).toBeGreaterThan(2);     // gently serrated: still clearly a spike
        expect(contrast(0.7)).toBeLessThan(2);        // over-serrated: lost in the background
    });

    test("the Airy zero lands at the radius each wavelength predicts", () => {
        // This is the whole reason a diffraction spike is coloured: the pattern SCALES with
        // wavelength, so blue structure sits inside red structure. Checked on the sharpest
        // feature there is - the first zero of the Airy pattern, whose radius is
        // 1.22*lambda/D exactly - rather than on any integrated statistic, which would be
        // dominated by the far tail and say nothing about scale.
        const fill = 0.25;
        const spec = specFor({ shape: "circle", obstruction: 0, vanes: { count: 0 } },
                             { fill, n: 512, supersample: 3 });
        spec.spectrum = { nm0: 420, nm1: 680, steps: 2, kind: "flat", kelvin: 5500 };
        const r = computePSF(spec);
        const n = r.n;

        // Two samples at bin centres: 485 nm (blue) and 615 nm (red). The output grid is
        // pitched for the LONGEST wavelength in the band, so both zeros scale against 680.
        const firstZeroRadius = (channel) => {
            const profile = [];
            for (let x = 0; x < 24; x++) profile.push(r.rgb[((n / 2) * n + (n / 2 + x)) * 3 + channel]);
            for (let i = 2; i < profile.length - 1; i++) {
                if (profile[i] < profile[i - 1] && profile[i] <= profile[i + 1]) return i;
            }
            return -1;
        };

        const predicted = (nm) => (1.22 / fill) * (nm / 680);
        const redZero = firstZeroRadius(0);
        const blueZero = firstZeroRadius(2);

        expect(blueZero).toBeLessThan(redZero);                          // blue inside red
        expect(Math.abs(redZero - predicted(615))).toBeLessThanOrEqual(1);
        expect(Math.abs(blueZero - predicted(485))).toBeLessThanOrEqual(1);
    });

    test("describeSampling flags an under-sampled core", () => {
        expect(describeSampling({ ...DEFAULT_SPEC, n: 512, fill: 0.9 }).undersampledCore).toBe(true);
        expect(describeSampling({ ...DEFAULT_SPEC, n: 512, fill: 0.2 }).undersampledCore).toBe(false);
    });
});

describe("presets", () => {
    test("every preset computes and produces a finite, normalised PSF", () => {
        for (const preset of PRESETS) {
            const spec = presetById(preset.id).spec;
            spec.n = 128;
            spec.spectrum.steps = 4;
            const result = computePSF(spec);
            expect(result.peak).toBeGreaterThan(0);
            expect(Number.isFinite(result.peak)).toBe(true);
            for (let i = 0; i < result.rgb.length; i += 997) {
                expect(Number.isFinite(result.rgb[i])).toBe(true);
                expect(result.rgb[i]).toBeGreaterThanOrEqual(0);
            }
        }
    });

    test("presetById returns a copy, so editing it cannot corrupt the preset", () => {
        const first = presetById("chandelier").spec;
        first.stops[0].obstruction = 0.99;
        expect(presetById("chandelier").spec.stops[0].obstruction).not.toBe(0.99);
    });
});

describe("RGBE transport", () => {
    test("round-trips a real PSF to better than 1% per pixel across its whole range", () => {
        const spec = presetById("chandelier").spec;
        spec.n = 128;
        spec.spectrum.steps = 8;
        const result = computePSF(spec);
        const back = rgbeDecode(rgbeEncode(result.rgb, result.n, result.n), result.n, result.n);

        let worst = 0, before = 0, after = 0;
        for (let i = 0; i < result.n * result.n; i++) {
            const a = (result.rgb[i * 3] + result.rgb[i * 3 + 1] + result.rgb[i * 3 + 2]) / 3;
            const b = (back[i * 3] + back[i * 3 + 1] + back[i * 3 + 2]) / 3;
            before += a; after += b;
            if (a > 1e-30) worst = Math.max(worst, Math.abs(a - b) / a);
        }
        expect(worst).toBeLessThan(0.01);
        expect(after / before).toBeCloseTo(1, 2);
    });

    test("the range floor discards depth without materially losing flux", () => {
        const spec = presetById("chandelier").spec;
        spec.n = 128;
        spec.spectrum.steps = 8;
        const result = computePSF(spec);
        const full = rgbeEncode(result.rgb, result.n, result.n, 0);
        const floored = rgbeEncode(result.rgb, result.n, result.n, result.peak * 1e-7);

        const nonZero = (b) => { let c = 0; for (let i = 3; i < b.length; i += 4) if (b[i] !== 0) c++; return c; };
        expect(nonZero(floored)).toBeLessThan(nonZero(full));

        const flux = (b) => { const d = rgbeDecode(b, result.n, result.n); let s = 0;
            for (let i = 0; i < result.n * result.n; i++) s += (d[i * 3] + d[i * 3 + 1] + d[i * 3 + 2]) / 3; return s; };
        expect(flux(floored) / flux(full)).toBeGreaterThan(0.99);
    });

    test("a zero pixel encodes to a zero alpha, which decodes back to zero", () => {
        const rgb = new Float32Array([0, 0, 0, 1, 1, 1]);
        const bytes = rgbeEncode(rgb, 2, 1);
        expect(bytes[3]).toBe(0);
        const back = rgbeDecode(bytes, 2, 1);
        expect(back[0]).toBe(0);
        expect(back[3]).toBeCloseTo(1, 2);
    });

    test("validatePSFFile rejects what it should and accepts what it should", () => {
        expect(validatePSFFile(null)).toMatch(/not an object/);
        expect(validatePSFFile({ format: "something-else" })).toMatch(/not a sitrec-psf/);
        expect(validatePSFFile({ format: "sitrec-psf", version: 99 })).toMatch(/newer/);
        expect(validatePSFFile({ format: "sitrec-psf", version: 1, encoding: "raw" })).toMatch(/encoding/);
        expect(validatePSFFile({ format: "sitrec-psf", version: 1, encoding: "rgbe", size: 2 })).toMatch(/size/);
        expect(validatePSFFile({
            format: "sitrec-psf", version: 1, encoding: "rgbe", size: 64, image: "data:image/png;base64,AA",
        })).toBe(null);
    });
});
