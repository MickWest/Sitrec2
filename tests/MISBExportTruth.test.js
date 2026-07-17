/**
 * @jest-environment jsdom
 *
 * Contract tests for the extended MISB Compliant CSV export
 * (CNodeTrack.exportMISBCompliantCSV): the FrameCenter and truth_* columns it
 * writes must round-trip through parseMISB1CSV + CTrackFileMISB into Center
 * and Truth tracks — and the pure truth heading/speed math (TrackExportMath)
 * must produce the aviation-convention values the columns document.
 */

jest.mock("../src/showError", () => ({showError: jest.fn()}));

import {parseMISB1CSV} from "../src/MISBUtils";
import {MISB} from "../src/MISBFields";
import {CTrackFileMISB} from "../src/TrackFiles/CTrackFileMISB";
import {
    ecefDisplacementToENU,
    enuBasisAt,
    headingSpeedFromENU,
    KNOTS_PER_METER_PER_SECOND,
    METERS_PER_FOOT,
} from "../src/TrackExportMath";

// EXACTLY the header strings exportMISBCompliantCSV writes — if the exporter
// changes them, this file is the contract that must be updated in both places.
const EXPORT_HEADERS = [
    "UnixTimeStamp",
    "SensorLatitude",
    "SensorLongitude",
    "SensorTrueAltitude",
    "SensorHorizontalFieldofView",
    "SensorVerticalFieldofView",
    "PlatformHeadingAngle",
    "PlatformPitchAngle",
    "PlatformRollAngle",
    "SensorRelativeAzimuthAngle",
    "SensorRelativeElevationAngle",
    "SensorRelativeRollAngle",
    "FrameCenterLatitude",
    "FrameCenterLongitude",
    "FrameCenterElevation",
    "truth_lat",
    "truth_long",
    "truth_alt",
    "truth_heading",
    "truth_speed",
];

// One exported clip: platform orbiting, frame center wobbling on the ground,
// truth track climbing. First frame's boresight "misses the ground" (empty
// FrameCenter cells) — the importer must still detect the Center track.
function makeExportedCSV(rows = 6) {
    const csv = [EXPORT_HEADERS.slice()];
    for (let i = 0; i < rows; i++) {
        const missedGround = i === 0;
        csv.push([
            String(1700000000000 + i * 33),                    // ms timestamps
            String(40.0 + i * 0.0001), String(-104.0), String(2000),
            "3.5", "2.0",
            "0", "0", "0",
            "45.0", "-10.0", "0",
            missedGround ? "" : String(40.05 + i * 0.0001),
            missedGround ? "" : String(-104.05),
            missedGround ? "" : String(1500 + i),
            String(40.06 + i * 0.0001), String(-104.06), String(3280.84 + i), // truth_alt in FEET
            "90.0", "19.4",
        ]);
    }
    return csv;
}

describe("export header contract → importer round-trip", () => {
    test("all exported headers are understood (FrameCenter + truth aliases)", () => {
        const misb = parseMISB1CSV(makeExportedCSV());
        expect(misb[1][MISB.FrameCenterLatitude]).toBeCloseTo(40.0501, 4);
        expect(misb[1][MISB.FrameCenterLongitude]).toBeCloseTo(-104.05, 6);
        expect(misb[1][MISB.FrameCenterElevation]).toBe(1501);
        expect(misb[0][MISB.TruthLatitude]).toBeCloseTo(40.06, 6);
        expect(misb[0][MISB.TruthAltitude]).toBeCloseTo(3280.84, 2);
        expect(misb[0][MISB.TruthHeading]).toBe(90);
        expect(misb[0][MISB.TruthSpeed]).toBeCloseTo(19.4, 3);
    });

    test("empty first-frame FrameCenter cells still yield a Center track", () => {
        const misb = parseMISB1CSV(makeExportedCSV());
        const trackFile = new CTrackFileMISB(misb);
        // Sensor + Center + Truth
        expect(trackFile.getTrackCount()).toBe(3);
        expect(trackFile.getShortName(1, "export.csv")).toBe("Center_export");
        expect(trackFile.getShortName(2, "export.csv")).toBe("Truth_export");

        // the empty first row is skipped, not turned into a bogus point
        const centerMisb = trackFile.toMISB(1);
        expect(centerMisb.length).toBe(5);
        expect(centerMisb[0][MISB.SensorLatitude]).toBeCloseTo(40.0501, 4);
    });

    test("truth_alt round-trips as feet by default (3280.84 ft → 1000 m MSL)", () => {
        const misb = parseMISB1CSV(makeExportedCSV());
        const trackFile = new CTrackFileMISB(misb);
        const truthMisb = trackFile.toMISB(2);
        expect(truthMisb[0][MISB.SensorTrueAltitude]).toBeCloseTo(1000, 1);
    });
});

describe("TrackExportMath (truth heading/speed math)", () => {
    test("ENU basis is orthonormal and correctly oriented at the equator", () => {
        const {east, north, up} = enuBasisAt(0, 0);
        // at lat 0, lon 0: up = +X, east = +Y, north = +Z
        expect(up.x).toBeCloseTo(1, 12);
        expect(east.y).toBeCloseTo(1, 12);
        expect(north.z).toBeCloseTo(1, 12);
    });

    test("displacement east of the start point reads as heading 090", () => {
        const a = {x: 6378137, y: 0, z: 0};        // lat 0, lon 0
        const b = {x: 6378137, y: 100, z: 0};      // 100 m east
        const enu = ecefDisplacementToENU(a, b, 0, 0);
        expect(enu.east).toBeCloseTo(100, 6);
        const hs = headingSpeedFromENU(enu.east, enu.north, 10);
        expect(hs.headingDeg).toBeCloseTo(90, 6);
        expect(hs.speedKnots).toBeCloseTo(10 * KNOTS_PER_METER_PER_SECOND, 6);
    });

    test("northward motion is heading 000; southwest lands in 180..270", () => {
        expect(headingSpeedFromENU(0, 50, 10).headingDeg).toBeCloseTo(0, 6);
        const sw = headingSpeedFromENU(-50, -50, 10).headingDeg;
        expect(sw).toBeCloseTo(225, 6);
    });

    test("hovering (below 0.05 m/s) reports speed but no heading", () => {
        const hs = headingSpeedFromENU(0.01, 0.01, 10);
        expect(hs.headingDeg).toBeNull();
        expect(hs.speedKnots).toBeGreaterThan(0);
    });

    test("degenerate dt returns null", () => {
        expect(headingSpeedFromENU(10, 10, 0)).toBeNull();
    });

    test("feet constant matches the importer's ft→m scaling", () => {
        // CTrackFileMISB._truthTrackMISB scales by 0.3048
        expect(METERS_PER_FOOT).toBe(0.3048);
    });
});
