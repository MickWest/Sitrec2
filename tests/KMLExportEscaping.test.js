/**
 * @jest-environment jsdom
 *
 * Regression test: exportTrackKML builds its <name> elements from the track's
 * human-readable name (a spline track exports as "Aguadilla Ground Spline",
 * not as its node id). A name as ordinary as "Search & Rescue" contains
 * characters XML reserves, and pasting one in raw makes the whole document
 * unparseable — Google Earth rejects the file outright. The name must be
 * escaped in the XML but left alone in the download filename.
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
        GlobalDateTimeNode: {frameToMS: (f) => 1700000000000 + f * 33},
        NodeMan: {get: () => null, exists: () => false},
        Sit: {fps: 30, name: "custom"},
    };
});

import {Vector3} from "three";
import {CNodeArray} from "../src/nodes/CNodeArray";
import {escapeXML} from "../src/utils";
import {saveAs} from "file-saver";

const FRAMES = 3;

// Duck-typed stand-in for a track node: exportTrackKML needs only the frame
// count, per-frame positions, and the filename stem.
function makeTrack(exportName) {
    return {
        id: "kmlEscapeTest",
        exportName,
        frames: FRAMES,
        exportFileStem: CNodeArray.prototype.exportFileStem,
        v: (f) => ({position: new Vector3(6378137 + f, 0, 0)}),
    };
}

async function blobText(blob) {
    // jsdom's Blob has no .text(); go through FileReader
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsText(blob);
    });
}

async function exportKML(exportName) {
    saveAs.mockClear();
    CNodeArray.prototype.exportTrackKML.call(makeTrack(exportName), false);
    expect(saveAs).toHaveBeenCalledTimes(1);
    return {
        xml: await blobText(saveAs.mock.calls[0][0]),
        filename: saveAs.mock.calls[0][1],
    };
}

describe("escapeXML", () => {
    test("escapes the five characters that break XML text and attributes", () => {
        expect(escapeXML(`Search & Rescue`)).toBe("Search &amp; Rescue");
        expect(escapeXML(`<tag>`)).toBe("&lt;tag&gt;");
        expect(escapeXML(`say "hi"`)).toBe("say &quot;hi&quot;");
        // & must be replaced first, or the escapes get double-escaped
        expect(escapeXML(`A & <B>`)).toBe("A &amp; &lt;B&gt;");
    });

    test("leaves an ordinary name untouched", () => {
        expect(escapeXML("Aguadilla Ground Spline")).toBe("Aguadilla Ground Spline");
    });
});

describe("exportTrackKML name escaping", () => {
    test("a name with XML metacharacters still parses as XML", async () => {
        const {xml} = await exportKML(`Search & Rescue <1> "north"`);

        const doc = new DOMParser().parseFromString(xml, "application/xml");
        expect(doc.querySelector("parsererror")).toBeNull();

        // Both <name> elements carry the name, and the parser gives back the
        // original text — so a re-import reads the track's real name.
        const names = [...doc.getElementsByTagName("name")].map(n => n.textContent);
        expect(names.length).toBe(2);
        for (const name of names) {
            expect(name).toBe(`custom-Search & Rescue <1> "north"`);
        }

        // The raw ampersand must not have survived into the markup.
        expect(xml).not.toMatch(/Search & Rescue/);
        expect(xml).toContain("Search &amp; Rescue");
    });

    test("the download filename keeps the unescaped name", async () => {
        const {filename} = await exportKML("Search & Rescue");
        expect(filename).toBe("custom-Search & Rescue.kml");
    });

    test("an ordinary track name is unaffected, and the track data survives", async () => {
        const {xml, filename} = await exportKML("Aguadilla Ground Spline");

        expect(filename).toBe("custom-Aguadilla Ground Spline.kml");
        const doc = new DOMParser().parseFromString(xml, "application/xml");
        expect(doc.querySelector("parsererror")).toBeNull();
        expect(doc.getElementsByTagName("name")[0].textContent)
            .toBe("custom-Aguadilla Ground Spline");
        // one <when> and one <gx:coord> per frame
        expect(doc.getElementsByTagName("when").length).toBe(FRAMES);
        expect(doc.getElementsByTagName("gx:coord").length).toBe(FRAMES);
    });
});
