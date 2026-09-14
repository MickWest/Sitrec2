/**
 * @jest-environment jsdom
 *
 * In the camera KMZ the look camera's roll goes into the PhotoOverlay's <rotation>, NEGATED
 * (checked in Google Earth Pro), and the PhotoOverlay's <Camera><roll> is 0. The camera-only Placemark
 * has no <rotation>, so it keeps the roll on its <Camera>.
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

import {cameraPlacemarkKML, photoOverlayKML} from "../src/ExportCameraKML";

const pose = (roll) => ({lat: 34, lon: -118, altMSL: 1000, heading: 90, tilt: 95, roll});

function parse(kml) {
    const doc = new DOMParser().parseFromString(kml, "application/xml");
    expect(doc.getElementsByTagName("parsererror").length).toBe(0);
    return doc;
}

describe.each([12.5, -7.25])("roll %s", (roll) => {
    test("PhotoOverlay: negated roll in <rotation>, <Camera><roll> is 0", () => {
        const doc = parse(photoOverlayKML({
            name: "test", description: "", pose: pose(roll), imageHref: "files/frame.jpg",
            viewVolume: {leftFov: -10, rightFov: 10, bottomFov: -5, topFov: 5}, near: 28,
        }));
        const overlay = doc.getElementsByTagName("PhotoOverlay")[0];
        const rotation = [...overlay.children].find(e => e.tagName === "rotation");
        expect(Number(rotation.textContent)).toBe(-roll);
        const camera = overlay.getElementsByTagName("Camera")[0];
        expect(Number(camera.getElementsByTagName("roll")[0].textContent)).toBe(0);
    });

    test("camera-only Placemark keeps the roll on its <Camera>", () => {
        const doc = parse(cameraPlacemarkKML({name: "test", description: "", pose: pose(roll)}));
        expect(doc.getElementsByTagName("rotation").length).toBe(0);
        const camera = doc.getElementsByTagName("Camera")[0];
        expect(Number(camera.getElementsByTagName("roll")[0].textContent)).toBe(roll);
    });
});
