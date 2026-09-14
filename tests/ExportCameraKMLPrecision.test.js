/**
 * @jest-environment jsdom
 *
 * Every number inside the camera KMZ's <PhotoOverlay> is written at full double precision:
 * each one reads back as exactly the double that was exported, in plain decimal notation
 * (no exponent). The camera-only Placemark stays trimmed.
 */

jest.mock("../src/showError", () => ({showError: jest.fn()}));
jest.mock("../src/EGM96Geoid", () => ({
    meanSeaLevelOffset: () => 0,
    ensureGeoidLoaded: () => Promise.resolve(),
}));
jest.mock("file-saver", () => ({saveAs: jest.fn()}));
jest.mock("../src/Globals", () => {
    const actual = jest.requireActual("../src/Globals");
    return {
        ...actual,
        NodeMan: {get: () => null, exists: () => false},
        Sit: {fps: 30, name: "custom"},
    };
});

import {cameraPlacemarkKML, fullPrecision, photoOverlayKML} from "../src/ExportCameraKML";

describe("fullPrecision", () => {
    test.each([
        0, -0, 1, -1, 0.1, 1 / 3, 37.24512996123456, -120.73818701987654, 4495.167123456789,
        1.916492832574254e-15, -1.916492832574254e-15, 1e-7, 2.5e-300, 1.5e21, -1.2345e25,
        Number.MIN_VALUE, Number.MAX_VALUE,
    ])("%s reads back exactly, without an exponent", (v) => {
        const s = fullPrecision(v);
        expect(s).not.toMatch(/e/i);
        expect(Number(s)).toBe(v === 0 ? 0 : v);   // -0 is written as "0"
    });

    test("expands exponents correctly", () => {
        expect(fullPrecision(1.916492832574254e-15)).toBe("0.000000000000001916492832574254");
        expect(fullPrecision(-1e-7)).toBe("-0.0000001");
        expect(fullPrecision(1.5e21)).toBe("1500000000000000000000");
    });
});

describe("PhotoOverlay numbers", () => {
    const pose = {
        lat: 37.24512996123456, lon: -120.73818701987654, altMSL: 4495.167123456789,
        heading: -1e-14, tilt: 99.00000000000001, roll: 1.916492832574254e-15,
    };
    const viewVolume = {
        leftFov: -10.123456789012345, rightFov: 10.123456789012345,
        bottomFov: -5.678901234567891, topFov: 5.678901234567891,
    };
    const near = 27.123456789012344;

    const kml = photoOverlayKML({
        name: "test", description: "", pose, imageHref: "files/frame.jpg", viewVolume, near,
    });
    const doc = new DOMParser().parseFromString(kml, "application/xml");
    const overlay = doc.getElementsByTagName("PhotoOverlay")[0];
    const value = (tag) => overlay.getElementsByTagName(tag)[0].textContent;

    test("parses, with no exponents anywhere in the overlay", () => {
        expect(doc.getElementsByTagName("parsererror").length).toBe(0);
        expect(new XMLSerializer().serializeToString(overlay)).not.toMatch(/\d[eE][-+]?\d/);
    });

    test("every value reads back as the exported double", () => {
        expect(Number(value("longitude"))).toBe(pose.lon);
        expect(Number(value("latitude"))).toBe(pose.lat);
        expect(Number(value("altitude"))).toBe(pose.altMSL);
        expect(Number(value("tilt"))).toBe(pose.tilt);
        expect(Number(value("roll"))).toBe(0);
        expect(Number(value("rotation"))).toBe(-pose.roll);
        for (const k of ["leftFov", "rightFov", "bottomFov", "topFov"]) {
            expect(Number(value(k))).toBe(viewVolume[k]);
        }
        expect(Number(value("near"))).toBe(near);
        expect(value("coordinates").split(",").map(Number)).toEqual([pose.lon, pose.lat, pose.altMSL]);
    });

    test("a tiny negative heading wraps to 0, not 360", () => {
        expect(value("heading")).toBe("0");
    });

    test("the camera-only Placemark stays trimmed", () => {
        const placemark = cameraPlacemarkKML({name: "test", description: "", pose});
        expect(placemark).toContain("<latitude>37.24512996</latitude>");
        expect(placemark).toContain("<altitude>4495.167</altitude>");
    });
});
