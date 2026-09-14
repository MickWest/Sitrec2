/**
 * @jest-environment jsdom
 *
 * "Export to KMZ with Track" (Object menu) writes the track the object rides as a
 * time-stamped gx:Track sampled once per second. The sampler must pick the frame
 * nearest each whole second (also at a fractional frame rate), convert HAE to MSL,
 * and mark a frame with no finite position as a gap. The writer must keep <when> and
 * <gx:coord> paired, break the line at a gap (a MultiTrack that does not interpolate),
 * never write NaN, and escape the name — Google Earth rejects a document that fails
 * to parse.
 */

jest.mock("../src/EGM96Geoid", () => ({
    meanSeaLevelOffset: () => 10,
    ensureGeoidLoaded: () => Promise.resolve(),
}));

import {Vector3} from "three";
import {LLAToECEF} from "../src/LLA-ECEF-ENU";
import {
    colladaSafeId, describeTrackSamples, kmlColorFromHex, sampleTrackAtOneHertz, trackPlacemarkXML,
} from "../src/ExportObjectKMZ";

const T0 = Date.UTC(2025, 1, 1, 20, 0, 0);
const clock = (fps) => (frame) => T0 + Math.round(frame * 1000 / fps);

describe("sampleTrackAtOneHertz", () => {
    test("takes the frame nearest each whole second and stops before the last partial second", () => {
        const track = {v: (f) => ({position: LLAToECEF(34, -118, 1000 + f)})};
        const samples = sampleTrackAtOneHertz(track, {frames: 91, fps: 30, frameToMS: clock(30)});
        expect(samples.map(s => s.frame)).toEqual([0, 30, 60, 90]);
        expect(samples.map(s => s.timeMS - T0)).toEqual([0, 1000, 2000, 3000]);
        expect(samples[1].lat).toBeCloseTo(34, 6);
        expect(samples[1].lon).toBeCloseTo(-118, 6);
        expect(samples[1].altMSL).toBeCloseTo(1030 - 10, 2);   // HAE 1030 at frame 30, minus the geoid

        // 90 frames at 30 fps end at 2.97 s: the 3 s sample would be frame 90, past the end.
        const shorter = sampleTrackAtOneHertz(track, {frames: 90, fps: 30, frameToMS: clock(30)});
        expect(shorter.map(s => s.frame)).toEqual([0, 30, 60]);
    });

    test("rounds to the nearest frame at a fractional frame rate", () => {
        const track = {v: () => LLAToECEF(34, -118, 1000)};   // bare Vector3 form
        const samples = sampleTrackAtOneHertz(track, {frames: 300, fps: 29.97, frameToMS: clock(29.97)});
        expect(samples.map(s => s.frame)).toEqual([0, 30, 60, 90, 120, 150, 180, 210, 240, 270]);
    });

    test("marks a frame with no finite position as a gap", () => {
        const good = LLAToECEF(34, -118, 1000);
        const values = [{position: good}, null, {position: new Vector3(NaN, 0, 0)}, good];
        const track = {v: (f) => values[f]};
        const samples = sampleTrackAtOneHertz(track, {frames: 4, fps: 1, frameToMS: clock(1)});
        expect(samples.map(s => s && s.frame)).toEqual([0, null, null, 3]);
    });

    test("is empty for a track with no frames or no frame rate", () => {
        const track = {v: () => LLAToECEF(34, -118, 1000)};
        expect(sampleTrackAtOneHertz(track, {frames: 0, fps: 30, frameToMS: clock(30)})).toEqual([]);
        expect(sampleTrackAtOneHertz(track, {frames: 30, fps: 0, frameToMS: clock(30)})).toEqual([]);
    });
});

const GX = "http://www.google.com/kml/ext/2.2";

function parseInDocument(placemark) {
    const doc = new DOMParser().parseFromString(`<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="${GX}"><Document>
${placemark}</Document></kml>`, "application/xml");
    expect(doc.getElementsByTagName("parsererror").length).toBe(0);
    return doc;
}

const sample = (second, lat = 34) =>
    ({frame: second * 30, timeMS: T0 + second * 1000, lat, lon: -118, altMSL: 500});

describe("trackPlacemarkXML", () => {
    test("writes one gx:Track with paired when and coord lines, in the given color", () => {
        const xml = trackPlacemarkXML([sample(0), sample(1, 34.1), sample(2, 34.2)],
            {name: "Search & Rescue track", color: "ff0080ff"});
        const doc = parseInDocument(xml);
        expect(doc.getElementsByTagName("name")[0].textContent).toBe("Search & Rescue track");
        expect(doc.getElementsByTagNameNS(GX, "MultiTrack").length).toBe(0);

        const tracks = doc.getElementsByTagNameNS(GX, "Track");
        expect(tracks.length).toBe(1);
        const whens = [...tracks[0].getElementsByTagName("when")].map(e => e.textContent);
        const coords = [...tracks[0].getElementsByTagNameNS(GX, "coord")].map(e => e.textContent);
        expect(whens).toEqual([
            "2025-02-01T20:00:00.000Z", "2025-02-01T20:00:01.000Z", "2025-02-01T20:00:02.000Z"]);
        expect(coords).toEqual([
            "-118.00000000 34.00000000 500.000",
            "-118.00000000 34.10000000 500.000",
            "-118.00000000 34.20000000 500.000"]);
        expect(tracks[0].getElementsByTagName("altitudeMode")[0].textContent).toBe("absolute");
        expect(doc.getElementsByTagName("color")[0].textContent).toBe("ff0080ff");
    });

    test("breaks the line at a gap with a MultiTrack that does not interpolate", () => {
        const xml = trackPlacemarkXML(
            [sample(0), sample(1), null, null, sample(4), sample(5), sample(6)], {name: "x"});
        const doc = parseInDocument(xml);
        const multi = doc.getElementsByTagNameNS(GX, "MultiTrack");
        expect(multi.length).toBe(1);
        expect(multi[0].getElementsByTagNameNS(GX, "interpolate")[0].textContent).toBe("0");
        const tracks = multi[0].getElementsByTagNameNS(GX, "Track");
        expect(tracks.length).toBe(2);
        expect(tracks[0].getElementsByTagName("when").length).toBe(2);
        expect(tracks[0].getElementsByTagNameNS(GX, "coord").length).toBe(2);
        expect(tracks[1].getElementsByTagName("when").length).toBe(3);
        expect(tracks[1].getElementsByTagNameNS(GX, "coord").length).toBe(3);
        expect(xml).not.toMatch(/NaN/);
    });

    test("writes nothing when no sample has a position", () => {
        expect(trackPlacemarkXML([], {name: "x"})).toBe("");
        expect(trackPlacemarkXML([null, null], {name: "x"})).toBe("");
    });
});

describe("kmlColorFromHex", () => {
    test("reorders a CSS color to KML's aabbggrr", () => {
        expect(kmlColorFromHex("#ff8000")).toBe("ff0080ff");
        expect(kmlColorFromHex("00FF00", "80")).toBe("8000ff00");
        expect(kmlColorFromHex("red")).toBe("ffffffff");
        expect(kmlColorFromHex(undefined)).toBe("ffffffff");
    });
});

describe("describeTrackSamples", () => {
    test("counts the points, the span and the gaps", () => {
        expect(describeTrackSamples([sample(0), sample(1), null, sample(3)]))
            .toBe("3 points at 1 Hz over 3.0 s, 1 second with no position");
        expect(describeTrackSamples([sample(0)])).toBe("1 point at 1 Hz over 0.0 s");
        expect(describeTrackSamples([null, null]))
            .toBe("The track had no position on any sampled frame, so none was written.");
        expect(describeTrackSamples([])).toBe("");
    });
});

describe("colladaSafeId", () => {
    test("makes an NCName the COLLADA loader can resolve as a url fragment", () => {
        expect(colladaSafeId("balloon_001 (Truth)_ob")).toBe("balloon_001_Truth_ob");
        expect(colladaSafeId("traverseObject")).toBe("traverseObject");
        expect(colladaSafeId("Search & Rescue")).toBe("Search_Rescue");
        expect(colladaSafeId("3rd object")).toBe("_3rd_object");
        expect(colladaSafeId("")).toBe("_");
        expect(colladaSafeId("a.b-c_d")).toBe("a.b-c_d");
    });
});
