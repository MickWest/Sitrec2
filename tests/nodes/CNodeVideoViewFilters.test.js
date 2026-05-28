import {
    applyTonalAdjustmentToPixel,
    applyTonalAdjustmentsToImage,
    areLevelsDefault,
    buildLevelsLUT,
    getClipComparisonValue,
    hasActiveTonalAdjustments,
    tonalRegionWeight,
} from "../../src/nodes/CNodeVideoViewFilters";
import {normalizeGUIFlagValue} from "../../src/nodes/CNodeGUIValue";

describe("video levels LUT", () => {
    test("identity levels preserve black, midpoint, and white", () => {
        const lut = buildLevelsLUT();

        expect(lut[0]).toBe(0);
        expect(lut[128]).toBe(128);
        expect(lut[255]).toBe(255);
        expect(areLevelsDefault()).toBe(true);
    });

    test("input points clamp the source range like Photoshop Levels", () => {
        const lut = buildLevelsLUT({
            inputBlack: 64,
            inputWhite: 192,
            midpoint: 1,
            outputBlack: 0,
            outputWhite: 255,
        });

        expect(lut[63]).toBe(0);
        expect(lut[64]).toBe(0);
        expect(lut[128]).toBe(128);
        expect(lut[192]).toBe(255);
        expect(lut[193]).toBe(255);
    });

    test("output points remap the adjusted range", () => {
        const lut = buildLevelsLUT({
            outputBlack: 20,
            outputWhite: 220,
        });

        expect(lut[0]).toBe(20);
        expect(lut[255]).toBe(220);
    });

    test("midpoint greater than one brightens midtones", () => {
        const lut = buildLevelsLUT({midpoint: 2});

        expect(lut[128]).toBeGreaterThan(128);
    });
});

describe("video clipping comparison", () => {
    test("uses the original value without invert", () => {
        expect(getClipComparisonValue(0, false)).toBe(0);
        expect(getClipComparisonValue(255, false)).toBe(255);
        expect(getClipComparisonValue(64, false)).toBe(64);
    });

    test("uses the expected inverted endpoint when invert is active", () => {
        expect(getClipComparisonValue(0, true)).toBe(255);
        expect(getClipComparisonValue(255, true)).toBe(0);
        expect(getClipComparisonValue(64, true)).toBe(191);
    });
});

describe("GUI flag values", () => {
    test("normalizes restored numeric and string flag values to booleans", () => {
        expect(normalizeGUIFlagValue(true)).toBe(true);
        expect(normalizeGUIFlagValue(1)).toBe(true);
        expect(normalizeGUIFlagValue("1")).toBe(true);
        expect(normalizeGUIFlagValue("true")).toBe(true);
        expect(normalizeGUIFlagValue(false)).toBe(false);
        expect(normalizeGUIFlagValue(0)).toBe(false);
        expect(normalizeGUIFlagValue("0")).toBe(false);
        expect(normalizeGUIFlagValue("false")).toBe(false);
    });
});

describe("video tonal adjustments", () => {
    test("default Shadows, Highlights, and Dehaze settings are no-ops", () => {
        expect(hasActiveTonalAdjustments()).toBe(false);
        expect(hasActiveTonalAdjustments({shadows: 0, highlights: 0, dehaze: 0})).toBe(false);
        expect(applyTonalAdjustmentToPixel(32, 96, 160)).toEqual([32, 96, 160]);
        expect(applyTonalAdjustmentToPixel(32, 96, 160, {shadows: 0, highlights: 0, dehaze: 0})).toEqual([32, 96, 160]);
    });

    test("Shadows mainly affects darker pixels", () => {
        const dark = applyTonalAdjustmentToPixel(26, 26, 26, {shadows: 50});
        const bright = applyTonalAdjustmentToPixel(224, 224, 224, {shadows: 50});

        expect(dark[0] - 26).toBeGreaterThan(bright[0] - 224);
    });

    test("Highlights mainly affects brighter pixels", () => {
        const dark = applyTonalAdjustmentToPixel(32, 32, 32, {highlights: -50});
        const bright = applyTonalAdjustmentToPixel(230, 230, 230, {highlights: -50});

        expect(32 - dark[0]).toBeLessThan(230 - bright[0]);
    });

    test("shadow and highlight masks are zero at black and white and peak near their regions", () => {
        expect(tonalRegionWeight(0, 0.1)).toBeCloseTo(0);
        expect(tonalRegionWeight(1, 0.1)).toBeCloseTo(0);
        expect(tonalRegionWeight(0, 0.9)).toBeCloseTo(0);
        expect(tonalRegionWeight(1, 0.9)).toBeCloseTo(0);
        expect(tonalRegionWeight(0.1, 0.1)).toBeGreaterThan(tonalRegionWeight(0.35, 0.1));
        expect(tonalRegionWeight(0.9, 0.9)).toBeGreaterThan(tonalRegionWeight(0.65, 0.9));
    });

    test("Shadows and Highlights preserve pure black and pure white", () => {
        expect(applyTonalAdjustmentToPixel(0, 0, 0, {shadows: 100, highlights: 100})).toEqual([0, 0, 0]);
        expect(applyTonalAdjustmentToPixel(255, 255, 255, {shadows: -100, highlights: -100})).toEqual([255, 255, 255]);
    });

    test("Dehaze changes pixels only when non-zero", () => {
        expect(hasActiveTonalAdjustments({dehaze: 1})).toBe(true);
        expect(applyTonalAdjustmentToPixel(128, 144, 160, {dehaze: 50})).not.toEqual([128, 144, 160]);
    });
});

describe("applyTonalAdjustmentsToImage matches per-pixel reference", () => {
    // 2x2 fixture covering shadows, low/high midtones, and bright pixels, plus
    // varied alpha values so we can confirm alpha passes through untouched.
    function makeFixturePixels() {
        return [
            [20, 25, 30, 255],
            [60, 75, 90, 200],
            [170, 185, 200, 128],
            [220, 230, 240, 255],
        ];
    }

    function fixtureBytes(pixels) {
        const bytes = new Uint8ClampedArray(pixels.length * 4);
        for (let i = 0; i < pixels.length; i++) {
            bytes[i * 4 + 0] = pixels[i][0];
            bytes[i * 4 + 1] = pixels[i][1];
            bytes[i * 4 + 2] = pixels[i][2];
            bytes[i * 4 + 3] = pixels[i][3];
        }
        return bytes;
    }

    // Run the image-level dispatch by stubbing the canvas/ctx pair so no DOM
    // is required. drawImage is a no-op because we pre-populate the buffer
    // that getImageData hands back.
    function runImageDispatch(pixels, settings) {
        const width = 2, height = 2;
        const data = fixtureBytes(pixels);
        const imageData = {data, width, height};
        const videoView = {
            _tonalAdjustCanvas: {width, height},
            _tonalAdjustCtx: {
                drawImage() {},
                getImageData() { return imageData; },
                putImageData() {},
            },
        };
        applyTonalAdjustmentsToImage({width, height}, settings, videoView);
        return data;
    }

    function runPerPixelReference(pixels, settings) {
        const out = fixtureBytes(pixels);
        for (let i = 0; i < out.length; i += 4) {
            const [r, g, b] = applyTonalAdjustmentToPixel(out[i], out[i + 1], out[i + 2], settings);
            out[i] = r;
            out[i + 1] = g;
            out[i + 2] = b;
        }
        return out;
    }

    // Tolerance of 1 byte: Uint8ClampedArray rounds .5 values using IEEE
    // round-half-to-even while the per-pixel reference uses Math.round
    // (half-away-from-zero). The two agree on every non-half value, and the
    // optimized loops are not allowed to diverge by more than that.
    function expectChannelsClose(actual, expected) {
        expect(actual.length).toBe(expected.length);
        for (let i = 0; i < actual.length; i++) {
            if (i % 4 === 3) continue; // alpha handled separately
            const diff = Math.abs(actual[i] - expected[i]);
            if (diff > 1) {
                throw new Error(`byte ${i}: got ${actual[i]}, expected ${expected[i]} (diff ${diff})`);
            }
        }
    }

    const scenarios = [
        ["shadows positive only",                {shadows: 50}],
        ["shadows negative only",                {shadows: -50}],
        ["highlights positive only",             {highlights: 50}],
        ["highlights negative only",             {highlights: -50}],
        ["shadows + highlights, both positive",  {shadows: 40, highlights: 30}],
        ["shadows + highlights, mixed signs",    {shadows: 60, highlights: -40}],
        ["dehaze positive only",                 {dehaze: 50}],
        ["dehaze negative only",                 {dehaze: -50}],
        ["all three, float-buffer path",         {shadows: 30, highlights: -25, dehaze: 40}],
        ["all three, opposite sign combo",       {shadows: -40, highlights: 50, dehaze: -30}],
    ];

    test.each(scenarios)("%s matches per-pixel within 1 byte", (_label, settings) => {
        const pixels = makeFixturePixels();
        const dispatched = runImageDispatch(pixels, settings);
        const reference = runPerPixelReference(pixels, settings);
        expectChannelsClose(dispatched, reference);
    });

    test("alpha channel is preserved across every dispatch branch", () => {
        const pixels = makeFixturePixels();
        const alphas = pixels.map(p => p[3]);
        for (const [, settings] of scenarios) {
            const dispatched = runImageDispatch(pixels, settings);
            for (let p = 0; p < alphas.length; p++) {
                expect(dispatched[p * 4 + 3]).toBe(alphas[p]);
            }
        }
    });

    test("no active adjustments leaves bytes untouched", () => {
        const pixels = makeFixturePixels();
        const original = fixtureBytes(pixels);
        const dispatched = runImageDispatch(pixels, {shadows: 0, highlights: 0, dehaze: 0});
        for (let i = 0; i < dispatched.length; i++) {
            expect(dispatched[i]).toBe(original[i]);
        }
    });
});
