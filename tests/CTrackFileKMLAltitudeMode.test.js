/**
 * @jest-environment jsdom
 *
 * KML <altitudeMode> on time-animated tracks.
 *
 * A <gx:Track> (or a timed <Placemark><Point>) can give its altitudes relative to the
 * ground instead of to mean sea level. Such a track must go in the MISB AltitudeAGL
 * column, with SensorTrueAltitude left empty, so that CNodeMISBDataTrack reads it as
 * height above the terrain. Before this, the altitude was always read as MSL, and a
 * "5 ft above the road" track near Salt Lake City was drawn 1.3 km underground.
 */

// The production geoid loader fetches its grid over the network, which Jest cannot do.
jest.mock("../src/EGM96Geoid", () => {
    const {meanSeaLevel} = require("egm96-universal");
    return {
        meanSeaLevelOffset: (lat, lon) => meanSeaLevel(Math.max(-90, Math.min(90, lat)), lon),
        ensureGeoidLoaded: () => Promise.resolve(),
    };
});

// A flat terrain 1300 m above the ellipsoid, so an AGL track has a known height.
const TERRAIN_HAE = 1300;
jest.mock("../src/threeExt", () => ({
    ...jest.requireActual("../src/threeExt"),
    elevationAtLL: () => 1300,
}));

import {CTrackFileKML} from "../src/TrackFiles/CTrackFileKML";
import {parseXml} from "../src/parseXml";
import {MISB} from "../src/MISBFields";
import {CNodeManager} from "../src/nodes/CNodeManager";
import {CNodeMISBDataTrack} from "../src/nodes/CNodeMISBData";
import {Globals, setNodeMan, setSit} from "../src/Globals";
import {extractTrackPreviewInfo, filterByAltitude} from "../src/TrackFilterDialog";
import {summarizeTrackFile} from "../src/TrackFiles/TrackFileProbe";
import {meanSeaLevelOffset} from "../src/EGM96Geoid";
import {ECEFToLLAVD_radii} from "../src/LLA-ECEF-ENU";
import {m2f} from "../src/utils";

const KML_HEAD = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
<Document><name>Test track</name>`;
const KML_TAIL = `</Document></kml>`;

// A <gx:Track> in the shape of the forum file: every <when> first, then every <gx:coord>.
function gxTrack(altitudeModeXml, alts, firstSecond = 0) {
    const whens = alts.map((_, i) => `<when>2026-11-03T02:06:${String(firstSecond + i).padStart(2, "0")}Z</when>`);
    const coords = alts.map((alt, i) => `<gx:coord>-111.9527 ${(40.72 - i * 0.0003).toFixed(4)} ${alt}</gx:coord>`);
    return `<gx:Track>${altitudeModeXml}${whens.join("")}${coords.join("")}</gx:Track>`;
}

function placemark(inner) {
    return `<Placemark><name>Test track</name>${inner}</Placemark>`;
}

function trackFile(body) {
    return new CTrackFileKML(parseXml(KML_HEAD + body + KML_TAIL));
}

const msl = misb => misb.map(row => row[MISB.SensorTrueAltitude]);
const agl = misb => misb.map(row => row[MISB.AltitudeAGL]);

describe("KML altitudeMode on time-animated tracks", () => {
    beforeAll(() => {
        ["log", "warn"].forEach(m => jest.spyOn(console, m).mockImplementation(() => {}));
    });
    afterAll(() => jest.restoreAllMocks());

    test("relativeToGround puts the altitude in the AGL column and leaves MSL empty", () => {
        const tf = trackFile(placemark(gxTrack("<altitudeMode>relativeToGround</altitudeMode>", [1.524, 1.524, 1.524])));
        expect(tf.isTrackGroundRelative(0)).toBe(true);
        const misb = tf.toMISB(0);
        expect(agl(misb)).toEqual([1.524, 1.524, 1.524]);
        expect(msl(misb)).toEqual([undefined, undefined, undefined]);
        expect(misb[2][MISB.SensorLatitude]).toBeCloseTo(40.7194, 4);
    });

    test("clampToGround puts the track on the ground whatever the altitude says", () => {
        const misb = trackFile(placemark(gxTrack("<altitudeMode>clampToGround</altitudeMode>", [250, 300]))).toMISB(0);
        expect(agl(misb)).toEqual([0, 0]);
        expect(msl(misb)).toEqual([undefined, undefined]);
    });

    test("the gx: sea-floor modes are read as relative to the terrain", () => {
        const relative = trackFile(placemark(gxTrack("<gx:altitudeMode>relativeToSeaFloor</gx:altitudeMode>", [10, 20]))).toMISB(0);
        expect(agl(relative)).toEqual([10, 20]);
        const clamped = trackFile(placemark(gxTrack("<gx:altitudeMode>clampToSeaFloor</gx:altitudeMode>", [10, 20]))).toMISB(0);
        expect(agl(clamped)).toEqual([0, 0]);
    });

    test("absolute stays in the MSL column", () => {
        const tf = trackFile(placemark(gxTrack("<altitudeMode>absolute</altitudeMode>", [1000, 1100])));
        expect(tf.isTrackGroundRelative(0)).toBe(false);
        const misb = tf.toMISB(0);
        expect(msl(misb)).toEqual([1000, 1100]);
        expect(agl(misb)).toEqual([undefined, undefined]);
    });

    test("a track with no altitudeMode keeps the historical MSL reading", () => {
        const misb = trackFile(placemark(gxTrack("", [1000, 1100]))).toMISB(0);
        expect(msl(misb)).toEqual([1000, 1100]);
        expect(agl(misb)).toEqual([undefined, undefined]);
    });

    test("a <gx:Track> without its own mode uses the mode of its <gx:MultiTrack>", () => {
        const body = placemark(`<gx:MultiTrack><altitudeMode>relativeToGround</altitudeMode>
            ${gxTrack("", [5, 6], 0)}${gxTrack("", [7, 8], 10)}</gx:MultiTrack>`);
        expect(agl(trackFile(body).toMISB(0))).toEqual([5, 6, 7, 8]);
    });

    test("a track that mixes modes keeps the MSL reading and its file altitudes", () => {
        // The track node reads one altitude column for the whole track.
        const body = placemark(`<gx:MultiTrack>
            ${gxTrack("<altitudeMode>clampToGround</altitudeMode>", [3, 3], 0)}
            ${gxTrack("<altitudeMode>absolute</altitudeMode>", [900, 1000], 10)}</gx:MultiTrack>`);
        const tf = trackFile(body);
        expect(tf.isTrackGroundRelative(0)).toBe(false);
        expect(msl(tf.toMISB(0))).toEqual([3, 3, 900, 1000]);
    });

    test("timed Placemarks use the altitudeMode of their <Point>", () => {
        const timedPoint = (second, alt) => `<Placemark><TimeStamp><when>2026-11-03T02:06:0${second}Z</when></TimeStamp>
            <Point><altitudeMode>relativeToGround</altitudeMode><coordinates>-111.95,40.7${second},${alt}</coordinates></Point></Placemark>`;
        const misb = trackFile(`<Folder><name>Route</name>${timedPoint(1, 2)}${timedPoint(2, 3)}</Folder>`).toMISB(0);
        expect(agl(misb)).toEqual([2, 3]);
        expect(msl(misb)).toEqual([undefined, undefined]);
    });
});

describe("sitches saved before the altitude mode was read", () => {
    const relativeTrack = placemark(gxTrack("<altitudeMode>relativeToGround</altitudeMode>", [1.524, 1.524]));
    afterEach(() => {
        Globals.deserializing = false;
        Globals.exportTagNumber = 0;
    });

    test("a sitch saved by 2.190.0 keeps reading the track altitude as MSL", () => {
        Globals.deserializing = true;
        Globals.exportTagNumber = 2190000;
        const tf = trackFile(relativeTrack);
        Globals.deserializing = false;  // a later toMISB() (e.g. a filter rebuild) must not flip it
        const misb = tf.toMISB(0);
        expect(msl(misb)).toEqual([1.524, 1.524]);
        expect(agl(misb)).toEqual([undefined, undefined]);
    });

    test("a sitch saved by a later version reads the altitude mode", () => {
        Globals.deserializing = true;
        Globals.exportTagNumber = 2190001;
        expect(agl(trackFile(relativeTrack).toMISB(0))).toEqual([1.524, 1.524]);
    });
});

describe("a ground-relative KML track in the MISB track node", () => {
    beforeEach(() => {
        setNodeMan(new CNodeManager());
        setSit({frames: 4, fps: 1, simSpeed: 1, lat: 40.7, lon: -111.95, isCustom: true, name: "custom"});
    });

    test("the node reads the AGL column and adds the terrain elevation", () => {
        const misb = trackFile(placemark(gxTrack("<altitudeMode>relativeToGround</altitudeMode>", [1.524, 1.524]))).toMISB(0);
        const node = new CNodeMISBDataTrack({id: "kmlAGL", misb});
        expect(node.useAGL).toBe(true);
        expect(node.isTerrainDependent()).toBe(true);
        expect(node.getAltHAE(0)).toBeCloseTo(TERRAIN_HAE + 1.524, 6);
    });

    test("the track filter puts a ground-relative track on the terrain", () => {
        const tf = trackFile(placemark(gxTrack("<altitudeMode>relativeToGround</altitudeMode>", [1.524, 1.524, 1.524])));
        const info = extractTrackPreviewInfo(tf, 0, "track.kml");
        const mslFt = m2f(TERRAIN_HAE + 1.524 - meanSeaLevelOffset(40.72, -111.9527));
        expect(Math.abs(info.altMinFt - mslFt)).toBeLessThan(2);
        expect(Math.abs(info.altMaxFt - mslFt)).toBeLessThan(2);
        // the frustum samples are at the terrain height, not at the ellipsoid
        expect(ECEFToLLAVD_radii(info.ecefSamples[0]).z).toBeCloseTo(TERRAIN_HAE + 1.524, 2);
        expect(filterByAltitude(info, mslFt - 100, mslFt + 100)).toBe(true);
        expect(filterByAltitude(info, 0, 1000)).toBe(false);
    });

    test("the track browser shows a ground-relative track's height above ground, not an MSL altitude", () => {
        const tf = trackFile(placemark(gxTrack("<altitudeMode>relativeToGround</altitudeMode>", [1.5, 2.5])));
        const [track] = summarizeTrackFile(tf, "track.kml").tracks;
        expect(track.aglMinM).toBe(1.5);
        expect(track.aglMaxM).toBe(2.5);
        expect(track.altMinM).toBeNull();
        expect(track.altMeanM).toBeNull();
    });

    test("the track browser keeps the MSL altitude of an absolute track", () => {
        const tf = trackFile(placemark(gxTrack("<altitudeMode>absolute</altitudeMode>", [1000, 1100])));
        const [track] = summarizeTrackFile(tf, "track.kml").tracks;
        expect(track.altMinM).toBe(1000);
        expect(track.altMaxM).toBe(1100);
        expect(track.aglMinM).toBeNull();
    });

    test("an absolute track is not terrain dependent", () => {
        const misb = trackFile(placemark(gxTrack("<altitudeMode>absolute</altitudeMode>", [1500, 1500]))).toMISB(0);
        const node = new CNodeMISBDataTrack({id: "kmlMSL", misb});
        expect(node.useAGL).toBe(false);
        expect(node.isTerrainDependent()).toBe(false);
    });
});
