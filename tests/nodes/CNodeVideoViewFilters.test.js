import {areLevelsDefault, buildLevelsLUT} from "../../src/nodes/CNodeVideoViewFilters";

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
