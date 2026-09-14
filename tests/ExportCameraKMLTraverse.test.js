/**
 * @jest-environment jsdom
 *
 * The camera KML/KMZ export carries the traverse's whole path as a line. A frame with no
 * traverse position must break the line, not join across the gap or write NaN into the
 * coordinates (which makes Google Earth reject the document), and a run of one point is
 * not a line at all.
 */

jest.mock("../src/showError", () => ({showError: jest.fn()}));
jest.mock("../src/EGM96Geoid", () => ({
    meanSeaLevelOffset: () => 10,
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

import {Vector3} from "three";
import {LLAToECEF} from "../src/LLA-ECEF-ENU";
import {sampleTraversePath, traversePathPlacemarkXML} from "../src/ExportCameraKML";

function wrap(placemark) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
${placemark}</Document></kml>`;
}

describe("sampleTraversePath", () => {
    test("converts ECEF to lat/lon and HAE to MSL, and marks invalid frames null", () => {
        const good = LLAToECEF(34, -118, 1000);
        const values = [
            {position: good},                       // {position} form
            good,                                   // bare Vector3 form
            null,                                   // no solution
            {position: new Vector3(NaN, 0, 0)},     // NaN solution
        ];
        const track = {v: (f) => values[f]};
        const points = sampleTraversePath(track, values.length);

        expect(points[0].lat).toBeCloseTo(34, 6);
        expect(points[0].lon).toBeCloseTo(-118, 6);
        expect(points[0].altMSL).toBeCloseTo(990, 2);   // 1000 HAE - 10 geoid
        expect(points[1].lat).toBeCloseTo(34, 6);
        expect(points[2]).toBeNull();
        expect(points[3]).toBeNull();
    });
});

describe("traversePathPlacemarkXML", () => {
    const p = (lat) => ({lat, lon: -118, altMSL: 500});

    test("splits at gaps, drops single-point runs, and parses as XML", () => {
        const xml = traversePathPlacemarkXML(
            [p(34.0), p(34.1), null, p(34.2), null, p(34.3), p(34.4), p(34.5)],
            "Search & Rescue traverse path");

        const doc = new DOMParser().parseFromString(wrap(xml), "application/xml");
        expect(doc.getElementsByTagName("parsererror").length).toBe(0);

        expect(doc.getElementsByTagName("name")[0].textContent).toBe("Search & Rescue traverse path");
        const lines = doc.getElementsByTagName("LineString");
        expect(lines.length).toBe(2);
        const coords = (i) => lines[i].getElementsByTagName("coordinates")[0].textContent.trim().split(/\s+/);
        expect(coords(0)).toEqual(["-118.00000000,34.00000000,500.000", "-118.00000000,34.10000000,500.000"]);
        expect(coords(1).length).toBe(3);
        expect(xml).not.toMatch(/NaN/);
    });

    test("returns empty when there is no line to draw", () => {
        expect(traversePathPlacemarkXML([], "x")).toBe("");
        expect(traversePathPlacemarkXML([null, p(34), null], "x")).toBe("");
    });
});
