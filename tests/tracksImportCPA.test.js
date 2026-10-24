// Closest-approach (CPA) re-timing when a track is imported into a sitch that already
// has tracks. The partner must be an imported, timestamped track: a synthetic or
// balloon track at index 0 has no MISB data and used to throw out of addTracks,
// and a sonde is wind reference data, not a flight to meet. Tracks that never
// overlap in time have no closest approach, so the sitch is not re-timed.
// TrackManager.centerOnTrack is taken from its class (the module imports the whole
// scene) and run against the real trackUtils and SphericalMath.

import fs from "fs";
import vm from "vm";
import {transformSync} from "@babel/core";
import {PerspectiveCamera} from "three";
import {CManager} from "../src/CManager";
import {setNodeMan, setSit} from "../src/Globals";
import {LLAToECEF} from "../src/LLA-ECEF-ENU";
import {getLocalSouthVector, getLocalUpVector, pointOnSphereBelow} from "../src/SphericalMath";
import {closestIntersectionTime, trackBoundingBox} from "../src/trackUtils";

// The named methods of one class in a source file, as a prototype object.
function classMethods(file, className, methodNames, context) {
    const source = fs.readFileSync(require.resolve(file), "utf8");
    const code = transformSync(source, {configFile: false, plugins: [() => ({visitor: {Program(path) {
        const statement = path.node.body.find(node => (node.declaration ?? node).id?.name === className);
        const declaration = statement.declaration ?? statement;
        declaration.body.body = declaration.body.body.filter(member => methodNames.includes(member.key?.name));
        path.node.body = [declaration];
    }}})]}).code;
    vm.createContext(context);
    vm.runInContext(`${code};globalThis.extracted=${className}.prototype;`, context);
    return context.extracted;
}

const T0 = Date.UTC(2025, 5, 1, 12, 0, 0);

// A stand-in for CNodeMISBDataTrack: one row per second, moving lonRate degrees a second.
// null positions are invalid rows (stored as {} by makeArrayForTrackDisplay).
function misbTrack(startMs, lat, lon0, seconds, {lonRate = 0.001, invalid = []} = {}) {
    const times = Array.from({length: seconds}, (_, i) => startMs + i * 1000);
    const positions = times.map((t, i) => invalid.includes(i) ? null : LLAToECEF(lat, lon0 + i * lonRate, 3000));
    const indexAt = time => Math.max(0, times.findIndex(t => t >= time));
    return {
        misb: times.map(() => []),
        frames: seconds,
        getTime: i => times[i],
        getPositionAtTime: time => (positions[indexAt(time)] ?? positions.find(p => p)).clone(),
        validPoint: f => !!positions[f],
        p: f => positions[f] ? positions[f].clone() : {},
    };
}

// Synthetic and balloon tracks compute a position per frame and have no .misb.
function computedTrack(lat, lon) {
    const position = LLAToECEF(lat, lon, 1000);
    return {frames: 10, validPoint: () => true, p: () => position.clone(),
        getPositionAtTime: () => position.clone()};
}

let trackManager, GlobalDateTimeNode, Globals;

beforeEach(() => {
    jest.spyOn(console, "log").mockImplementation(() => {});
    setNodeMan({get: node => node});
    setSit({lat: 40, lon: -100});
    GlobalDateTimeNode = {setStartDateTime: jest.fn(), recalculateCascade: jest.fn()};
    Globals = {dontAutoZoom: false, sitchEstablished: false};
    const mainCameraNode = {camera: new PerspectiveCamera(), snapshotCamera: jest.fn()};
    const mainView = {getHFOV: () => 1};
    const context = {
        CManager,
        console,
        Globals,
        GlobalDateTimeNode,
        Sit: {centerOnLoadedTracks: true},
        // A KML: every track is a distinct flight, so every one is a CPA candidate.
        FileManager: {get: () => ({cpaCandidate: () => true})},
        NodeMan: {
            get: id => ({mainCamera: mainCameraNode, mainView})[id],
            exists: () => false,
        },
        setRenderOne: () => {},
        trackBoundingBox,
        closestIntersectionTime,
        pointOnSphereBelow,
        getLocalUpVector,
        getLocalSouthVector,
    };
    const methods = classMethods("../src/TrackManager.js", "CTrackManager", ["centerOnTrack"], context);
    trackManager = Object.assign(Object.create(methods), new CManager());
    trackManager.pendingFramingTracks = [];
    context.TrackManager = trackManager;
});

afterEach(() => jest.restoreAllMocks());

// What addTracks does for each imported track: register it, then center on it.
function importTrack(id, trackDataNode, extra = {}) {
    const trackOb = trackManager.add(id, {trackFileName: id + ".kml", trackDataNode, trackNode: {}, ...extra});
    trackManager.centerOnTrack(id, trackManager.size(), trackOb, false, 0);
    return trackOb;
}

test.each([
    ["synthetic", {isSynthetic: true}],
    ["balloon", {isBalloon: true}],
])("a %s track made before the import is not used as the closest-approach partner", (_, flags) => {
    trackManager.add("Synthetic_1", {trackDataNode: computedTrack(40, -100), ...flags});

    expect(() => importTrack("A", misbTrack(T0, 40, -100, 60))).not.toThrow();
    expect(GlobalDateTimeNode.setStartDateTime).not.toHaveBeenCalled();

    // The second import re-times against the first IMPORTED track. B flies west to meet A.
    importTrack("B", misbTrack(T0, 40, -99.97, 60, {lonRate: -0.001}));
    expect(GlobalDateTimeNode.setStartDateTime).toHaveBeenCalledTimes(1);
    expect(GlobalDateTimeNode.setStartDateTime.mock.calls[0][0]).toBe(T0 + 15000);
});

test("a sonde loaded first is not used as the closest-approach partner", () => {
    trackManager.add("Sonde", {trackDataNode: misbTrack(T0 - 3600000, 40, -100, 7200), isSondeTrack: true});

    importTrack("A", misbTrack(T0, 40, -100, 60));
    expect(GlobalDateTimeNode.setStartDateTime).not.toHaveBeenCalled();

    importTrack("B", misbTrack(T0, 40, -99.97, 60, {lonRate: -0.001}));
    expect(GlobalDateTimeNode.setStartDateTime.mock.calls).toEqual([[T0 + 15000]]);
});

test("tracks that never overlap in time do not re-time the sitch", () => {
    importTrack("A", misbTrack(T0, 40, -100, 60));
    importTrack("B", misbTrack(T0 + 3600000, 40, -100, 60));
    expect(GlobalDateTimeNode.setStartDateTime).not.toHaveBeenCalled();
});

test("a first row with no valid position does not abort centering", () => {
    const track = misbTrack(T0, 40, -100, 60, {invalid: [0]});
    expect(() => importTrack("A", track)).not.toThrow();
});

describe("trackBoundingBox", () => {
    test("is seeded from the first valid frame", () => {
        const bbox = trackBoundingBox(misbTrack(T0, 40, -100, 10, {invalid: [0, 1]}));
        // the same flight without its first two rows
        const expected = trackBoundingBox(misbTrack(T0 + 2000, 40, -99.998, 8));
        for (const corner of ["min", "max"]) {
            bbox[corner].toArray().forEach((v, i) => expect(v).toBeCloseTo(expected[corner].getComponent(i), 3));
        }
    });

    test("is null when no frame has a valid position", () => {
        const track = misbTrack(T0, 40, -100, 3, {invalid: [0, 1, 2]});
        expect(trackBoundingBox(track)).toBeNull();
    });
});

describe("closestIntersectionTime", () => {
    test("finds the time of closest approach within the overlap", () => {
        expect(closestIntersectionTime(misbTrack(T0, 40, -100, 60), misbTrack(T0, 40, -99.97, 60, {lonRate: -0.001})))
            .toBe(T0 + 15000);
    });

    test("is null for a track without MISB data", () => {
        expect(closestIntersectionTime(computedTrack(40, -100), misbTrack(T0, 40, -100, 60))).toBeNull();
    });

    test("is null when the tracks do not overlap in time", () => {
        expect(closestIntersectionTime(misbTrack(T0, 40, -100, 60), misbTrack(T0 + 120000, 40, -100, 60)))
            .toBeNull();
    });
});
