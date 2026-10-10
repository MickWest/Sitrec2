// Tests for the diffraction PSF engine behind tools/psf and the camera glare pass.
//
// These modules live in tools/ because the Diffraction PSF Studio is served as raw ES
// modules with no bundler, but src/CameraPSF.js imports the format definition from the same
// place so the encoder and the decoder cannot drift. The engine is pure; the file-loading
// check supplies image and renderer doubles to exercise the camera's existing import path.
//
// The assertions are deliberately physical rather than golden-value: an Airy pattern has a
// first zero at a known radius, N spider vanes throw a known NUMBER of spikes in known
// DIRECTIONS, and a convolution kernel conserves flux. A snapshot would pass just as happily
// with the transform subtly wrong. One test keeps summary values of the visible presets, compared
// with a tolerance, as a guard against unintended engine changes.

import { inflateSync } from "node:zlib";
import { FFT2D, fftshift } from "../tools/psf/fft.js";
import { buildSpectralSamples, wavelengthToRGB } from "../tools/psf/cie.js";
import { rasterStop, DEFAULT_STOP } from "../tools/psf/aperture.js";
import { computePSF, DEFAULT_SPEC, describeSampling } from "../tools/psf/psf.js";
import { presetById, PRESETS } from "../tools/psf/presets.js";
import { buildPSFFile, rgbeEncode, rgbeDecode, validatePSFFile } from "../tools/psf/psfFile.js";
import { loadPSFFromFile, disposePSF } from "../src/CameraPSF.js";

// Summary values of the visible engine for the presets and a defocused blackbody case: peak, the three channel
// sums, the RMS radius in pixels, and the mean channel at six offsets from the center. They are compared with a
// relative tolerance, so a change in the last bits of Math.sin/cos/exp cannot fail the test, while a change to
// the engine does.
const VISIBLE_OFFSETS = [[0, 0], [1, 0], [3, 2], [10, 0], [25, 25], [60, 7]];
const VISIBLE_SUMMARIES = {
    default: [0.414514551091, 0.934342410343, 0.993911391091, 1.07174620177, 9.68316140082, 0.41451455156, 0.0570293652515, 0.00104546391716, 0.0000627511083925, 0.00000180264635219, 8.10588251928e-7],
    airy: [0.0861054639772, 0.999227529258, 0.995943492804, 1.00482895873, 10.1332716411, 0.0861054634055, 0.0631686697404, 0.00122561276658, 0.000118782880842, 0.00000223053624874, 4.0871760613e-7],
    newtonian: [0.299497926204, 0.996001876656, 1.02493781165, 0.979060280234, 10.2188424076, 0.299497927229, 0.087865854303, 0.000981336411011, 0.0000456066942813, 0.0000304359018628, 2.09252561945e-7],
    cass3: [0.28695549851, 0.993410473804, 1.02852284866, 0.97806665623, 9.70310379368, 0.286955500642, 0.0802316019932, 0.00124733604025, 0.0000756516504528, 0.00000131379348052, 3.24441619644e-7],
    iris6: [0.305125487077, 1.00634106711, 1.01705197112, 0.976606961444, 7.74649507357, 0.305125484864, 0.0966277271509, 0.000620788632659, 0.000190148915863, 7.07386534534e-8, 3.69079108016e-8],
    squareIris: [0.319879854763, 1.00731905129, 1.02810342772, 0.964577535526, 8.90734987919, 0.319879854719, 0.0922090932727, 0.000177910723626, 0.000425427861046, 2.11672895508e-8, 3.67890062118e-8],
    segmented: [0.292133574477, 1.00481685535, 1.01945420234, 0.975728942449, 10.8986203377, 0.292133574684, 0.0896872530381, 0.000888989001396, 0.000299194599696, 2.73237830584e-7, 1.38713977786e-7],
    apodised: [0.369420471147, 0.950606436025, 1.00515425244, 1.04423929031, 9.34057422545, 0.369420458873, 0.0685412424306, 0.000779347234735, 0.0000765133081586, 0.0000192083152797, 2.1855094919e-7],
    chandelier: [0.496438378735, 0.912331310539, 0.986504685748, 1.10116401394, 7.351664162, 0.496438384056, 0.0630806759, 0.000487096093517, 0.000209309820396, 0.00000879687604538, 1.11541249718e-7],
    defocusedBlackbody: [0.05384549225, 1.0148662553, 0.996472974459, 0.988660768615, 5.89951710993, 0.0538454918812, 0.0352757461369, 0.00795061420649, 0.000102773745311, 0.00000179543464659, 1.67421227345e-12],
};

test("visible presets keep their summary values within a relative 1e-9", () => {
    const extra = JSON.parse(JSON.stringify(DEFAULT_SPEC));
    extra.n = 128;
    extra.defocusUm = 200;
    extra.combine = "intersect";
    extra.stops[1].enabled = true;
    Object.assign(extra.spectrum, { kind: "blackbody", steps: 8, kelvin: 3200 });
    for (const [id, expected] of Object.entries(VISIBLE_SUMMARIES)) {
        const spec = id === "default" ? DEFAULT_SPEC
                   : id === "defocusedBlackbody" ? extra : presetById(id).spec;
        const r = computePSF(spec), n = r.n, c = n / 2;
        const channels = [0, 0, 0];
        let moment = 0;
        for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
            const i = (y * n + x) * 3, mean = (r.rgb[i] + r.rgb[i + 1] + r.rgb[i + 2]) / 3;
            for (let k = 0; k < 3; k++) channels[k] += r.rgb[i + k];
            moment += mean * ((x - c) ** 2 + (y - c) ** 2);
        }
        const samples = VISIBLE_OFFSETS.map(([dx, dy]) => {
            const i = ((c + dy) * n + c + dx) * 3;
            return (r.rgb[i] + r.rgb[i + 1] + r.rgb[i + 2]) / 3;
        });
        [r.peak, ...channels, Math.sqrt(moment), ...samples].forEach((value, index) =>
            expect({ id, index, error: Math.abs(value - expected[index]) <= 1e-9 * Math.abs(expected[index]) })
                .toEqual({ id, index, error: true }));
    }
});

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

/** Average a thin radial band around a full circle, using the same bilinear sampler as rays. */
function ring(result, radius) {
    let sum = 0, count = 0;
    for (let a = 0; a < 360; a += 10) {
        for (const dr of [-0.15, 0, 0.15]) { sum += sampleAt(result, a, radius + dr); count++; }
    }
    return sum / count;
}

function firstBandZero(result, fill) {
    const expected = 1.22 / fill;
    let best = Infinity, radius = 0;
    for (let r = expected * 0.7; r <= expected * 1.3; r += 0.025) {
        const v = ring(result, r);
        if (v < best) { best = v; radius = r; }
    }
    return radius * result.sampling.anglePerPixelRad;
}

describe("band detection", () => {
    test("band PSFs have equal channels and unit flux, including defocus and long-wave infrared", () => {
        for (const quantity of [undefined, "photon", "energy"]) {
            for (const defocusUm of [0, 200]) {
                const spec = presetById("chandelierIR").spec;
                spec.n = 128;
                spec.defocusUm = defocusUm;
                Object.assign(spec.spectrum, { steps: 8, kind: "blackbody", kelvin: 300, quantity });
                const r = computePSF(spec);
                let sum = 0, mismatch = 0;
                for (let i = 0; i < r.rgb.length; i += 3) {
                    sum += r.rgb[i];
                    if (r.rgb[i] !== r.rgb[i + 1] || r.rgb[i] !== r.rgb[i + 2]) mismatch++;
                }
                expect(sum).toBeCloseTo(1, 6);
                expect(mismatch).toBe(0);
            }
        }
        const spec = presetById("mwirAiry").spec;
        spec.n = 128;
        Object.assign(spec.spectrum, { nm0: 8000, nm1: 14000, steps: 8, kind: "blackbody", kelvin: 300 });
        const r = computePSF(spec);
        expect(r.rgb.filter((_, i) => i % 3 === 0).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
        expect(r.sampling.anglePerPixelRad).toBeCloseTo(14000e-9 * spec.fill / spec.optics.apertureM, 12);
    });

    test("a 4000 nm Airy first zero is at 1.22 lambda/D on the sky", () => {
        const spec = presetById("mwirAiry").spec;
        spec.fill = 0.12;
        Object.assign(spec.spectrum, { nm0: 4000, nm1: 4000, steps: 1 });
        const r = computePSF(spec);
        const predicted = 1.22 * 4000e-9 / spec.optics.apertureM;
        expect(Math.abs(firstBandZero(r, spec.fill) / predicted - 1)).toBeLessThan(0.04);
        expect(ring(r, 1.22 / spec.fill)).toBeLessThan(0.002);
        expect(ring(r, 1.6 / spec.fill)).toBeGreaterThan(0.01);
    });

    test("the first dark ring scales in angle from 3000 nm to 5000 nm", () => {
        const spec = presetById("mwirAiry").spec;
        spec.fill = 0.12;
        const zeros = [3000, 5000].map((nm) => {
            Object.assign(spec.spectrum, { nm0: nm, nm1: nm, steps: 1 });
            return firstBandZero(computePSF(spec), spec.fill);
        });
        expect(zeros[1] / zeros[0]).toBeCloseTo(5 / 3, 5);
        expect(Math.abs(zeros[0] / (1.22 * 3000e-9 / spec.optics.apertureM) - 1)).toBeLessThan(0.04);
    });

    test("cooler blackbodies and photon detection weight the long end more strongly", () => {
        const samples = (kelvin, quantity) =>
            buildSpectralSamples(3000, 5000, 32, "blackbody", kelvin, "band", quantity);
        const longFraction = (s) => {
            let total = 0, long = 0;
            for (let i = 0; i < s.nm.length; i++) {
                const w = s.rgb[i * 3];
                total += w;
                if (s.nm[i] >= 4000) long += w;
            }
            return long / total;
        };
        for (const quantity of ["photon", "energy"]) {
            expect(longFraction(samples(300, quantity))).toBeGreaterThan(longFraction(samples(800, quantity)));
        }
        for (const kelvin of [300, 800]) {
            const energy = samples(kelvin, "energy"), photon = samples(kelvin, "photon");
            expect(longFraction(photon)).toBeGreaterThan(longFraction(energy));
            // Photon radiance is energy radiance times wavelength, up to a common constant.
            const last = energy.nm.length - 1;
            const energyRatio = energy.rgb[last * 3] / energy.rgb[0];
            const photonRatio = photon.rgb[last * 3] / photon.rgb[0];
            expect(photonRatio / energyRatio).toBeCloseTo(energy.nm[last] / energy.nm[0], 12);
            expect(samples(kelvin).rgb).toEqual(photon.rgb);
        }
        const flat = buildSpectralSamples(3000, 5000, 8, "flat", 300, "band", "energy");
        expect(new Set(flat.rgb)).toEqual(new Set([1]));
    });

    test("band focus uses the center wavelength; visible focus retains 550 nm", () => {
        const spec = presetById("mwirAiry").spec;
        expect(describeSampling(spec).criticalFocusUm).toBeCloseTo(2 * 4 * 25, 10);
        spec.spectrum.detector = "visible";
        expect(describeSampling(spec).criticalFocusUm).toBeCloseTo(2 * 0.55 * 25, 10);
        delete spec.spectrum.detector;
        expect(describeSampling(spec).criticalFocusUm).toBeCloseTo(2 * 0.55 * 25, 10);
    });

    test("a spectrum with no weight for the detector is refused; a closed pupil gives an empty PSF", () => {
        // The visible color matching functions have no weight in the mid-wave infrared.
        const spec = presetById("mwirAiry").spec;
        spec.n = 64;
        spec.spectrum.detector = "visible";
        expect(() => computePSF(spec)).toThrow(/no weight/);
        spec.spectrum.detector = "band";
        expect(computePSF(spec).peak).toBeGreaterThan(0);
        spec.stops.forEach((s) => { s.enabled = false; });
        const empty = computePSF(spec);
        expect(empty.peak).toBe(0);
        expect(empty.empty).toBe(true);
    });

    test("an explicit visible detector is identical to the default", () => {
        const spec = presetById("airy").spec;
        spec.n = 128;
        const a = computePSF(spec);
        spec.spectrum.detector = "visible";
        spec.spectrum.quantity = "photon";
        const b = computePSF(spec);
        expect(Buffer.from(a.rgb.buffer).equals(Buffer.from(b.rgb.buffer))).toBe(true);
        expect(a.sampling).toEqual(b.sampling);
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

/** Decode the writer's unfiltered RGBA8 PNG, independently of the RGBE encoder. */
function readPSFPNG(url) {
    const bytes = Buffer.from(url.split(",")[1], "base64");
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    const data = [];
    for (let p = 8; p < bytes.length;) {
        const length = bytes.readUInt32BE(p);
        if (bytes.toString("ascii", p + 4, p + 8) === "IDAT") data.push(bytes.subarray(p + 8, p + 8 + length));
        p += length + 12;
    }
    const raw = inflateSync(Buffer.concat(data));
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        const start = y * (1 + width * 4);
        expect(raw[start]).toBe(0);
        rgba.set(raw.subarray(start + 1, start + 1 + width * 4), y * width * 4);
    }
    return { width, height, rgba };
}

describe("RGBE transport", () => {
    test("visible and band version-1 files use the same camera load and decode path", async () => {
        const oldReader = globalThis.FileReader, oldImage = globalThis.Image;
        globalThis.FileReader = class {
            readAsDataURL(blob) {
                blob.arrayBuffer().then((data) => {
                    this.result = `data:${blob.type};base64,${Buffer.from(data).toString("base64")}`;
                    this.onload();
                }, (error) => this.onerror(error));
            }
        };
        globalThis.Image = class {
            set src(url) { Object.assign(this, readPSFPNG(url)); queueMicrotask(() => this.onload()); }
        };
        try {
            const files = [];
            for (const id of ["chandelier", "chandelierIR"]) {
                const spec = presetById(id).spec;
                spec.n = 128;
                spec.spectrum.steps = 8;
                const result = computePSF(spec);
                const file = await buildPSFFile(result, spec, { name: id, floorFraction: 0 });
                const json = JSON.stringify(file);
                expect(file.version).toBe(1);
                expect(validatePSFFile(JSON.parse(json))).toBe(null);
                expect(JSON.parse(json).spec).toEqual(spec);
                const previousTarget = {};
                let target = previousTarget, decoded, renders = 0;
                const renderer = {
                    getRenderTarget: () => target,
                    setRenderTarget: (t) => { target = t; },
                    render: (scene) => {
                        renders++;
                        const uniforms = scene.children[0].material.uniforms;
                        const texture = uniforms.tRGBE.value;
                        expect(texture.premultiplyAlpha).toBe(false);
                        expect(texture.flipY).toBe(false);
                        expect(uniforms.invPeak.value).toBe(1 / result.peak);
                        decoded = rgbeDecode(texture.image.rgba, file.size, file.size);
                    },
                };
                const loaded = await loadPSFFromFile({ text: async () => json }, renderer);
                expect(renders).toBe(1);
                expect(target).toBe(previousTarget);
                expect(loaded.anglePerPixelRad).toBe(result.sampling.anglePerPixelRad);
                expect(loaded.fieldRad).toBe(file.size * file.anglePerPixelRad);
                let flux = 0, mismatch = 0;
                for (let i = 0; i < decoded.length; i += 3) {
                    flux += (decoded[i] + decoded[i + 1] + decoded[i + 2]) / 3;
                    if (decoded[i] !== decoded[i + 1] || decoded[i] !== decoded[i + 2]) mismatch++;
                }
                expect(flux).toBeCloseTo(1, 2);  // RGBE quantization
                if (id === "chandelierIR") expect(mismatch).toBe(0);
                disposePSF(loaded);
                files.push(file);
            }
            expect(files[1].spec.stops).toEqual(files[0].spec.stops);
            expect(files[1].anglePerPixelRad / files[0].anglePerPixelRad)
                .toBeCloseTo(files[1].spec.spectrum.nm1 / files[0].spec.spectrum.nm1, 12);
        } finally {
            if (oldReader === undefined) delete globalThis.FileReader; else globalThis.FileReader = oldReader;
            if (oldImage === undefined) delete globalThis.Image; else globalThis.Image = oldImage;
        }
    });

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
