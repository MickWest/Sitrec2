/**
 * @jest-environment jsdom
 *
 * Altitude-datum handling for Custom1 CSV: the TPHAE header is explicitly
 * Height Above Ellipsoid, so the parsed misb array must carry altitudeIsHAE
 * for the pipeline to skip the MSL->HAE geoid add. Plain ALT/ALTITUDE headers
 * are MSL and must NOT set the flag. CTrackFileMISB exposes the flag through
 * the CTrackFile.isAltitudeHAE API, and stripDuplicateTimes must preserve it.
 */

jest.mock("../src/MISBUtils", () => {
    const MISB = {
        UnixTimeStamp: 2,
        SensorLatitude: 13,
        SensorLongitude: 14,
        SensorTrueAltitude: 15,
        FrameCenterLatitude: 23,
        FrameCenterLongitude: 24,
        FrameCenterElevation: 25,
        TrackID: 59,
        PlatformTailNumber: 4,
        PlatformDesignation: 10,
        PlatformTrueAirspeed: 8,
        SensorVerticalFieldofView: 17,
        PlatformPitchAngle: 6,
    };
    return {MISB, MISBFields: 121};
});

jest.mock("../src/Globals", () => ({
    GlobalDateTimeNode: {dateStart: new Date("2025-01-01T00:00:00.000Z")},
    Sit: {fps: 30},
}));

const {MISB} = require("../src/MISBUtils");
const {parseCustom1CSV} = require("../src/ParseCustom1CSV");
const {stripDuplicateTimes} = require("../src/ParseUtils");
const {CTrackFileMISB} = require("../src/TrackFiles/CTrackFileMISB");

describe("Custom1 CSV altitude datum (TPHAE)", () => {
    const rows = [
        ["2026-03-01T02:00:00Z", "40.1", "-104.1", "1879.45"],
        ["2026-03-01T02:01:00Z", "40.2", "-104.2", "1880.55"],
    ];

    test("TPHAE header sets altitudeIsHAE on the misb array", () => {
        const parsed = parseCustom1CSV([["DateTimeUtc", "TPLAT", "TPLON", "TPHAE"], ...rows]);
        expect(parsed.altitudeIsHAE).toBe(true);
        expect(parsed[0][MISB.SensorTrueAltitude]).toBeCloseTo(1879.45, 6);
    });

    test("plain ALT header does not set altitudeIsHAE", () => {
        const parsed = parseCustom1CSV([["DateTimeUtc", "TPLAT", "TPLON", "ALT"], ...rows]);
        expect(parsed.altitudeIsHAE).toBeUndefined();
    });

    test("TPHAE with an overriding ALT (FT) column stays MSL (feet values win)", () => {
        const csv = [
            ["DateTimeUtc", "TPLAT", "TPLON", "TPHAE", "ALT (FT)"],
            ["2026-03-01T02:00:00Z", "40.1", "-104.1", "1879.45", "6200"],
        ];
        const parsed = parseCustom1CSV(csv);
        expect(parsed.altitudeIsHAE).toBeUndefined();
    });

    test("stripDuplicateTimes preserves the altitudeIsHAE flag", () => {
        const parsed = parseCustom1CSV([["DateTimeUtc", "TPLAT", "TPLON", "TPHAE"], ...rows]);
        const stripped = stripDuplicateTimes(parsed);
        expect(stripped.altitudeIsHAE).toBe(true);
    });

    test("CTrackFileMISB.isAltitudeHAE reflects the array flag for track 0", () => {
        const parsed = parseCustom1CSV([["DateTimeUtc", "TPLAT", "TPLON", "TPHAE"], ...rows]);
        const trackFile = new CTrackFileMISB(stripDuplicateTimes(parsed));
        expect(trackFile.isAltitudeHAE(0)).toBe(true);
    });

    test("CTrackFileMISB.isAltitudeHAE is false without the flag", () => {
        const parsed = parseCustom1CSV([["DateTimeUtc", "TPLAT", "TPLON", "ALT"], ...rows]);
        const trackFile = new CTrackFileMISB(stripDuplicateTimes(parsed));
        expect(trackFile.isAltitudeHAE(0)).toBe(false);
    });
});
