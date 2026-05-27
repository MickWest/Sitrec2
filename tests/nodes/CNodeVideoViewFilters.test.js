import {
    applyTonalAdjustmentToPixel,
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
