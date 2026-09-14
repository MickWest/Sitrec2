/**
 * @jest-environment jsdom
 *
 * Round trip for "Export to KMZ with Track": the doc.kml the Objects menu writes — the
 * object's <Model> Placemark plus its track sampled at 1 Hz — must read back into Sitrec
 * as one track holding the sampled points, with the model Placemark left alone (it has
 * no time and no point, so it is a scene object, not a track). The KML template comes
 * from CNode3DObject's own generateKMLContent, lifted from the source the way
 * ObjectViewScale.test.js does, so the importer sees the real document without the
 * node's browser-only dependencies.
 */
import fs from "node:fs";
import path from "node:path";
import {parse} from "@babel/parser";
import {SphereGeometry} from "three";
import {CTrackFileKML} from "../src/TrackFiles/CTrackFileKML";
import {parseXml} from "../src/parseXml";
import {escapeXML} from "../src/utils";
import {colladaSafeId, trackPlacemarkXML} from "../src/ExportObjectKMZ";

jest.mock("../src/nodes/CNodeTrack", () => ({
    CNodeTrackFromLLAArray: jest.fn(() => ({setArray: jest.fn(), recalculateCascade: jest.fn()})),
}));
jest.mock("../src/nodes/CNodeDisplayTrack", () => ({CNodeDisplayTrack: jest.fn()}));
jest.mock("../src/LayerMasks", () => ({MASK_WORLD: 1}));
jest.mock("../src/Globals", () => ({
    CustomManager: {shouldIgnore: () => false, ignore: () => {}},
    NodeMan: {getUniqueID: (name) => name},
    Sit: {allowDashInFlightNumber: false},
}));
jest.mock("../src/CFeatureManager", () => ({FeatureManager: {addFeature: jest.fn()}}));
jest.mock("../src/EGM96Geoid", () => ({
    meanSeaLevelOffset: () => 0,
    ensureGeoidLoaded: () => Promise.resolve(),
}));

const WANTED = ["generateKMLContent", "getObjectDimensions", "getMaterialInfo", "getObjectScale"];

function kmlWriterFromSource() {
    const source = fs.readFileSync(path.join(__dirname, "../src/nodes/CNode3DObject.js"), "utf8");
    const declaration = parse(source, {sourceType: "module"}).program.body
        .find(node => node.type === "ExportNamedDeclaration" && node.declaration?.id?.name === "CNode3DObject")
        .declaration;
    const methods = declaration.body.body.filter(node => WANTED.includes(node.key?.name));
    expect(methods.map(node => node.key.name).sort()).toEqual([...WANTED].sort());
    const Writer = new Function("escapeXML",
        `return class {${methods.map(node => source.slice(node.start, node.end)).join("\n")}}`)(escapeXML);
    return Object.assign(new Writer(), {
        geometryParams: {radius: 5},
        common: {geometry: "sphere", material: "basic"},
        material: {color: {getHexString: () => "ff8000"}, opacity: 1, transparent: false},
        geometry: null,
    });
}

const T0 = Date.UTC(2025, 1, 1, 20, 0, 0);
const sample = (second) =>
    ({frame: second * 30, timeMS: T0 + second * 1000, lat: 34 + second * 0.01, lon: -118, altMSL: 500 + second});

describe("Export to KMZ with Track", () => {
    let kml;
    beforeAll(() => {
        jest.spyOn(console, "log").mockImplementation(() => {});
        jest.spyOn(console, "warn").mockImplementation(() => {});
        const trackPlacemark = trackPlacemarkXML(
            [sample(0), sample(1), sample(2), null, sample(4), sample(5)],
            {name: "Search & Rescue track", color: "ff0080ff"});
        kml = kmlWriterFromSource().generateKMLContent("Search & Rescue", 34, -118, 500, "sphere",
            "files/Search & Rescue_sphere.dae",
            {trackPlacemark, trackNote: "5 points at 1 Hz over 5.0 s, 1 second with no position"});
    });
    afterAll(() => jest.restoreAllMocks());

    test("writes a document that parses, with the object's name escaped and the track noted", () => {
        const doc = new DOMParser().parseFromString(kml, "application/xml");
        expect(doc.getElementsByTagName("parsererror")[0]?.textContent ?? "").toBe("");
        const names = [...doc.getElementsByTagName("name")].map(e => e.textContent);
        expect(names).toEqual(["Search & Rescue - sphere", "Search & Rescue", "Search & Rescue track"]);
        expect(doc.getElementsByTagName("Model").length).toBe(1);
        expect(doc.getElementsByTagName("description")[1].textContent).toContain("Track:</strong> 5 points at 1 Hz");
    });

    test("reads back into Sitrec as one track of the sampled points, the model placemark ignored", () => {
        const parsed = parseXml(kml);
        expect(CTrackFileKML.canHandle("Search & Rescue_sphere.kml", parsed)).toBe(true);
        const groups = new CTrackFileKML(parsed).extractTrackGroups();
        expect(groups.length).toBe(1);
        const samples = groups[0].samples;
        expect(samples.map(s => s.t - T0)).toEqual([0, 1000, 2000, 4000, 5000]);
        expect(samples.map(s => s.lat)).toEqual([34, 34.01, 34.02, 34.04, 34.05]);
        expect(samples.every(s => s.lon === -118)).toBe(true);
        expect(samples.map(s => s.alt)).toEqual([500, 501, 502, 504, 505]);
    });
});

// The COLLADA side. Google Earth Pro drew nothing for an object named
// "balloon_001 (Truth)_ob": every id inside the model was built from the name, and a
// url="#balloon_001 (Truth)_ob-geometry" is not a URI fragment its loader resolves. The
// same file with the ids cleaned showed the sphere (2026-09-14).
const COLLADA_METHODS = ["generateColladaContent", "getVerticesFromGeometry", "getNormalsFromGeometry",
    "getIndicesFromGeometry", "getMaterialInfo", "colorToRGBA"];

function colladaWriterFromSource() {
    const source = fs.readFileSync(path.join(__dirname, "../src/nodes/CNode3DObject.js"), "utf8");
    const declaration = parse(source, {sourceType: "module"}).program.body
        .find(node => node.type === "ExportNamedDeclaration" && node.declaration?.id?.name === "CNode3DObject")
        .declaration;
    const methods = declaration.body.body.filter(node => COLLADA_METHODS.includes(node.key?.name));
    expect(methods.map(node => node.key.name).sort()).toEqual([...COLLADA_METHODS].sort());
    const Writer = new Function("colladaSafeId",
        `return class {${methods.map(node => source.slice(node.start, node.end)).join("\n")}}`)(colladaSafeId);
    return Object.assign(new Writer(), {
        modelOrGeometry: "geometry",
        geometry: new SphereGeometry(204, 16, 12),
        common: {geometry: "sphere", material: "phong", wireframe: false, edges: false},
        material: {color: {getHexString: () => "32cd32"}, opacity: 1, transparent: false},
    });
}

describe("the COLLADA model", () => {
    const NCNAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

    test("uses ids Google Earth can resolve whatever the object is called", () => {
        const {content, vertexCount, triangleCount} = colladaWriterFromSource()
            .generateColladaContent("balloon_001 (Truth)_ob", "sphere");

        const doc = new DOMParser().parseFromString(content, "application/xml");
        expect(doc.getElementsByTagName("parsererror")[0]?.textContent ?? "").toBe("");

        const ids = [...content.matchAll(/\sid="([^"]*)"/g)].map(m => m[1]);
        expect(ids).toContain("balloon_001_Truth_ob-geometry");
        expect(ids.length).toBeGreaterThan(5);
        for (const id of ids) expect(id).toMatch(NCNAME);

        const refs = [...content.matchAll(/\s(?:url|source|target)="#([^"]*)"/g)].map(m => m[1]);
        expect(refs.length).toBeGreaterThan(5);
        for (const ref of refs) expect(ids).toContain(ref);

        expect(vertexCount).toBe(17 * 13);
        expect(triangleCount).toBe(16 * 12 * 2 - 16 * 2);
        expect(content).toContain("<diffuse>");
        expect(content).toContain("0.196078 0.803922 0.196078 1.000000");
    });
});
