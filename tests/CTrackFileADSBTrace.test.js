// Unit tests for CTrackFileADSBTrace — readsb/tar1090 trace_full JSON
// (adsb.lol). Guards the canHandle discrimination (detectTrackFile ASSERTS
// when two handlers claim a file), the seconds→ms time conversion, the
// geometric-vs-barometric altitude datum decision (isAltitudeHAE), and the
// carry-forward altitude fill for "ground" rows.

import {CTrackFileADSBTrace} from "../src/TrackFiles/CTrackFileADSBTrace";
import {MISB} from "../src/MISBFields";

const F2M = 0.3048;

// Synthetic trace rows: [secondsAfter, lat, lon, alt_baro_ft|"ground"|null,
// gs_kt, track_deg, flags, vert_rate, aircraftObj|null, source, alt_geom_ft]
function traceFile({withGeom = true, callsign = null, registration = "N123AB"} = {}) {
    const ac = callsign ? {flight: callsign + "  "} : null;
    return {
        icao: "a1b2c3",
        r: registration,
        t: "B738",
        desc: "BOEING 737-800",
        timestamp: 1724650000,
        trace: [
            [0, 34.00, -118.00, 10000, 250, 90, 0, 0, ac, "adsb_icao", withGeom ? 10200 : null],
            [10, 34.01, -118.01, 10500, 251, 91, 0, 0, null, "adsb_icao", withGeom ? 10700 : null],
            [20, 34.02, -118.02, "ground", 15, 92, 0, 0, null, "adsb_icao", null],
        ],
    };
}

describe("CTrackFileADSBTrace.canHandle", () => {
    test("accepts a readsb trace object", () => {
        expect(CTrackFileADSBTrace.canHandle("trace_full_a1b2c3.json", traceFile())).toBe(true);
    });

    test("rejects everything the other JSON handlers own", () => {
        // GeoJSON (CTrackFileJSON)
        expect(CTrackFileADSBTrace.canHandle("x.json", {type: "FeatureCollection", features: []})).toBe(false);
        // MISB-style array (CTrackFileMISB)
        expect(CTrackFileADSBTrace.canHandle("x.json", [[0, 0, 0]])).toBe(false);
        // Saved sitch
        expect(CTrackFileADSBTrace.canHandle("x.json", {isASitchFile: true})).toBe(false);
        // Degenerate inputs
        expect(CTrackFileADSBTrace.canHandle("x.json", null)).toBe(false);
        expect(CTrackFileADSBTrace.canHandle("x.json", {icao: "a1b2c3"})).toBe(false);
        expect(CTrackFileADSBTrace.canHandle("x.json", {icao: "a1b2c3", trace: []})).toBe(false);
        expect(CTrackFileADSBTrace.canHandle("x.json", {timestamp: 1, trace: []})).toBe(false);
    });
});

describe("CTrackFileADSBTrace.toMISB", () => {
    test("converts time to ms and lat/lon/altitude, preferring geometric (HAE)", () => {
        const file = new CTrackFileADSBTrace(traceFile({withGeom: true}));
        expect(file.doesContainTrack()).toBe(true);
        const misb = file.toMISB();
        expect(misb.length).toBe(3);
        expect(misb[0][MISB.UnixTimeStamp]).toBe(1724650000000);
        expect(misb[1][MISB.UnixTimeStamp]).toBe(1724650010000);
        expect(misb[0][MISB.SensorLatitude]).toBe(34.00);
        expect(misb[0][MISB.SensorLongitude]).toBe(-118.00);
        // geometric altitude used (10200 ft), converted to meters
        expect(misb[0][MISB.SensorTrueAltitude]).toBeCloseTo(10200 * F2M, 6);
        expect(file.isAltitudeHAE(0)).toBe(true);
    });

    test("falls back to barometric (MSL) when there is no geometric altitude", () => {
        const file = new CTrackFileADSBTrace(traceFile({withGeom: false}));
        const misb = file.toMISB();
        expect(misb[0][MISB.SensorTrueAltitude]).toBeCloseTo(10000 * F2M, 6);
        expect(file.isAltitudeHAE(0)).toBe(false);
    });

    test("a 'ground' row carries the previous altitude forward, never a made-up value", () => {
        const file = new CTrackFileADSBTrace(traceFile({withGeom: true}));
        const misb = file.toMISB();
        // last row is "ground" with no geometric altitude — carries row 1's 10700 ft
        expect(misb[2][MISB.SensorTrueAltitude]).toBeCloseTo(10700 * F2M, 6);
    });

    test("flags bit 8 marks field 3 as geometric", () => {
        const data = traceFile({withGeom: false});
        // one row whose altitude field is geometric per the flag, no field 10
        data.trace.push([30, 34.03, -118.03, 10300, 252, 93, 8, 0, null, "adsb_icao", null]);
        const file = new CTrackFileADSBTrace(data);
        // 1 geometric vs 2 barometric points — barometric wins the datum vote
        expect(file.isAltitudeHAE(0)).toBe(false);
        const misb = file.toMISB();
        // the flagged row has no barometric value, so it carries forward
        expect(misb[3][MISB.SensorTrueAltitude]).toBeCloseTo(10500 * F2M, 6);
    });

    test("skips malformed rows and rejects a track with fewer than two points", () => {
        const data = {
            icao: "a1b2c3", timestamp: 1724650000,
            trace: [[0, 34.0, -118.0, 1000, 0, 0, 0], "junk", [10, NaN, -118.0, 1000, 0, 0, 0]],
        };
        const file = new CTrackFileADSBTrace(data);
        expect(file.doesContainTrack()).toBe(false);
        expect(file.toMISB()).toBe(false);
    });
});

describe("CTrackFileADSBTrace naming and shape", () => {
    test("short name prefers callsign, then registration, then hex", () => {
        expect(new CTrackFileADSBTrace(traceFile({callsign: "UAL123"})).getShortName()).toBe("UAL123");
        expect(new CTrackFileADSBTrace(traceFile()).getShortName()).toBe("N123AB");
        expect(new CTrackFileADSBTrace(traceFile({registration: ""})).getShortName()).toBe("A1B2C3");
    });

    test("single-track, non-supplementary", () => {
        const file = new CTrackFileADSBTrace(traceFile());
        expect(file.getTrackCount()).toBe(1);
        expect(file.hasMoreTracks(0)).toBe(false);
        expect(file.isSupplementaryTrack(0)).toBe(false);
    });
});
