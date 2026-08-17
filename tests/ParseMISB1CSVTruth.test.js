/**
 * @jest-environment jsdom
 *
 * Tests the client-specific truth_lat / truth_long / truth_alt (and
 * truth_heading / truth_speed) CSV columns: parseMISB1CSV maps them via
 * header aliases into the MISB local-extension fields, and CTrackFileMISB
 * derives a supplementary "Truth" track from them, like FrameCenter.
 */

// showError pulls in Globals (and its UI import chain); mock it so
// parseMISB1CSV can be imported directly. The misb.js-main .mjs imports
// are stubbed globally via moduleNameMapper (three-addons-stub.js).
jest.mock("../src/showError", () => ({showError: jest.fn()}));

import {parseMISB1CSV} from "../src/MISBUtils";
import {MISB} from "../src/MISBFields";
import {CTrackFileMISB} from "../src/TrackFiles/CTrackFileMISB";

// A MISB-style CSV (Sensor + Frame Center columns) with the client-specific
// truth columns appended. All values are strings, as csv.toArrays delivers.
function makeTruthCSV(rows = 5, truthHeaderCase = "truth_lat") {
    const header = [
        "UNIX Time Stamp", "Sensor Latitude", "Sensor Longitude", "Sensor True Altitude",
        "Frame Center Latitude", "Frame Center Longitude", "Frame Center Elevation",
        truthHeaderCase, "truth_long", "truth_alt", "truth_heading", "truth_speed",
    ];
    const csv = [header];
    for (let i = 0; i < rows; i++) {
        csv.push([
            String(1609459200000000 + i * 1000000),
            String(40.0 + i * 0.001), String(-104.0 + i * 0.001), String(1000 + i),
            String(40.1 + i * 0.001), String(-104.1 + i * 0.001), String(500 + i),
            String(40.2 + i * 0.001), String(-104.2 + i * 0.001), String(600 + i),
            "45", "100",
        ]);
    }
    return csv;
}

describe('parseMISB1CSV truth column aliases', () => {
    test('truth_* headers map to the Truth MISB fields as numbers', () => {
        const misb = parseMISB1CSV(makeTruthCSV());
        expect(misb.length).toBe(5);
        expect(misb[0][MISB.TruthLatitude]).toBeCloseTo(40.2, 6);
        expect(misb[0][MISB.TruthLongitude]).toBeCloseTo(-104.2, 6);
        expect(misb[0][MISB.TruthAltitude]).toBe(600);
        expect(misb[0][MISB.TruthHeading]).toBe(45);
        expect(misb[0][MISB.TruthSpeed]).toBe(100);
    });

    test('alias match is case-insensitive', () => {
        const misb = parseMISB1CSV(makeTruthCSV(3, "TRUTH_LAT"));
        expect(misb[0][MISB.TruthLatitude]).toBeCloseTo(40.2, 6);
    });

    test('regular MISB columns are unaffected', () => {
        const misb = parseMISB1CSV(makeTruthCSV());
        expect(misb[0][MISB.SensorLatitude]).toBeCloseTo(40.0, 6);
        expect(misb[0][MISB.FrameCenterLatitude]).toBeCloseTo(40.1, 6);
        expect(misb[0][MISB.UnixTimeStamp]).toBe(1609459200000000);
    });

    test('missing truth values become null', () => {
        const csv = makeTruthCSV(3);
        csv[1][7] = "";      // truth_lat row 0
        csv[2][8] = "NaN";   // truth_long row 1
        const misb = parseMISB1CSV(csv);
        expect(misb[0][MISB.TruthLatitude]).toBe(null);
        expect(misb[1][MISB.TruthLongitude]).toBe(null);
        expect(misb[2][MISB.TruthLatitude]).toBeCloseTo(40.202, 6);
    });
});

describe('CSV → CTrackFileMISB truth track end-to-end', () => {
    test('a MISB CSV with truth columns yields sensor, center, and truth tracks', () => {
        const misb = parseMISB1CSV(makeTruthCSV());
        const trackFile = new CTrackFileMISB(misb);
        expect(trackFile.getTrackCount()).toBe(3);

        // Center at index 1, Truth at index 2
        const centerMisb = trackFile.toMISB(1);
        expect(centerMisb[0][MISB.SensorLatitude]).toBeCloseTo(40.1, 6);
        expect(centerMisb[0][MISB.SensorTrueAltitude]).toBe(500);

        const truthMisb = trackFile.toMISB(2);
        expect(truthMisb.length).toBe(5);
        expect(truthMisb[0][MISB.SensorLatitude]).toBeCloseTo(40.2, 6);
        expect(truthMisb[0][MISB.SensorLongitude]).toBeCloseTo(-104.2, 6);
        // truth_alt defaults to feet: 600 ft → 182.88 m
        expect(truthMisb[0][MISB.SensorTrueAltitude]).toBeCloseTo(600 * 0.3048, 6);
        expect(truthMisb[0][MISB.UnixTimeStamp]).toBe(1609459200000000);

        // "Source Altitude is Meters" ON re-derives with raw values
        trackFile.setSourceAltitudeMeters(2, true);
        expect(trackFile.toMISB(2)[0][MISB.SensorTrueAltitude]).toBe(600);
        trackFile.setSourceAltitudeMeters(2, false);

        expect(trackFile.getShortName(2, "flight.csv")).toBe("Truth_flight");
        // Loads as one unit — no multi-track picker for the 3 sub-tracks
        expect(trackFile.getImportTrackCount()).toBe(1);
    });

    test('a CSV without center columns puts truth at index 1', () => {
        const csv = makeTruthCSV();
        // Blank out the Frame Center columns (4, 5, 6)
        for (let r = 1; r < csv.length; r++) {
            csv[r][4] = ""; csv[r][5] = ""; csv[r][6] = "";
        }
        const misb = parseMISB1CSV(csv);
        const trackFile = new CTrackFileMISB(misb);
        expect(trackFile.getTrackCount()).toBe(2);
        const truthMisb = trackFile.toMISB(1);
        expect(truthMisb[0][MISB.SensorLatitude]).toBeCloseTo(40.2, 6);
        expect(trackFile.getShortName(1, "flight.csv")).toBe("Truth_flight");
    });

    // THE TRUTH TRACK MUST DECLARE ITSELF STRUCTURALLY.
    //
    // TrackManager.isTruthTrack tests a whole name of "truth" or a trailing
    // "(Truth)" — the shapes CTrackFileBOT and the traverse handoff produce —
    // then falls back to the file's own trackIsTruth(). This file names its
    // derived tracks with a PREFIX ("Truth_flight"), which matches neither
    // pattern, so without trackIsTruth() the truth track fell through to the
    // supplementary branch and got the INVISIBLE reference sphere meant for a
    // FrameCenter track: imported, listed in the menus, drawn as nothing.
    test('the derived Truth track reports itself as ground truth', () => {
        const trackFile = new CTrackFileMISB(parseMISB1CSV(makeTruthCSV()));
        // The name alone cannot carry this — pinned so a future rename of the
        // derived tracks does not quietly make the structural test redundant
        // OR make it the only thing holding the marker up without anyone
        // noticing which.
        expect(trackFile.getShortName(2, "flight.csv")).not.toMatch(/^truth$|\(truth\)$/i);

        expect(trackFile.trackIsTruth(2)).toBe(true);
        expect(trackFile.trackIsTruth(1)).toBe(false);   // Center
        expect(trackFile.trackIsTruth(0)).toBe(false);   // the sensor platform
    });

    test('truth is still SUPPLEMENTARY — it shares a flight with track 0', () => {
        // Two different questions with the same-looking answer. Supplementary
        // keeps it out of closest-point-of-approach re-timing (it is the same
        // observation, not a second flight); trackIsTruth earns it the marker.
        const trackFile = new CTrackFileMISB(parseMISB1CSV(makeTruthCSV()));
        expect(trackFile.isSupplementaryTrack(2)).toBe(true);
        expect(trackFile.trackIsTruth(2)).toBe(true);
    });

    test('a file with no truth columns claims no truth track', () => {
        const csv = makeTruthCSV();
        // Blank the truth columns (7, 8, 9) — center columns stay.
        for (let r = 1; r < csv.length; r++) {
            csv[r][7] = ""; csv[r][8] = ""; csv[r][9] = "";
        }
        const trackFile = new CTrackFileMISB(parseMISB1CSV(csv));
        expect(trackFile.getTrackCount()).toBe(2);       // sensor + center only
        expect(trackFile.trackIsTruth(1)).toBe(false);   // that index is Center
        expect(trackFile.trackIsTruth(2)).toBe(false);   // and nothing is there
    });
});
