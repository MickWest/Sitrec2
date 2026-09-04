jest.mock("../src/EGM96Geoid", () => ({
    meanSeaLevelOffset: jest.fn(() => -31.25),
}));

import {osdAltitudeToHAE} from "../src/nodes/CNodeOSDDataSeriesTrack";

describe("OSD altitude reference conversion", () => {
    test("converts a genuine zero-metre MSL altitude to HAE", () => {
        expect(osdAltitudeToHAE(0, true, "MSL", 40, -105)).toBe(-31.25);
    });

    test("does not invent an altitude for a missing altitude sample", () => {
        expect(osdAltitudeToHAE(0, false, "MSL", 40, -105)).toBe(0);
    });

    test("leaves an HAE altitude unchanged", () => {
        expect(osdAltitudeToHAE(0, true, "HAE", 40, -105)).toBe(0);
    });
});
