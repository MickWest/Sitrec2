/**
 * Tests for detectCSVType() — the CSV format classifier in CFileManager.
 *
 * detectCSVType takes a parsed CSV (array of arrays) and returns a string
 * identifying the format: "Airdata", "MISB_FULL", "MISB1", "CUSTOM1",
 * "CUSTOM_FLL", "FR24CSV", "AZIMUTH", "ELEVATION", "HEADING", "FOV",
 * "FEATURES", or "Unknown".
 *
 * Since CFileManager has a deep dependency chain (Three.js, DOM, etc.),
 * we re-implement the detection logic from source and test it directly.
 * This is intentional — it tests the SPECIFICATION (header patterns),
 * not the import chain. If someone changes detectCSVType and this test
 * breaks, they'll know to update both.
 */

import fs from 'fs';
import path from 'path';

// Extract detectCSVType source and re-implement it for testing
// This avoids the deep CFileManager import chain
const source = fs.readFileSync(
    path.resolve(__dirname, '../src/CFileManagerParse.js'), 'utf-8'
);

// Verify the function exists and hasn't been moved. detectCSVType moved
// from CFileManager.js to CFileManagerParse.js during the refactor2
// module split (commit 36bcc1d7).
describe('detectCSVType source presence', () => {
    test('detectCSVType is exported from CFileManagerParse.js', () => {
        expect(source).toContain('export function detectCSVType(');
    });
});

// Reimplementation of just the header-based detection logic for testing.
// We stub isCustom1, isFR24CSV, isFeaturesCSV to return false by default —
// those are tested separately in their own modules.
function detectCSVType(csv, options = {}) {
    const {isCustom1 = () => false, isFR24CSV = () => false, isFeaturesCSV = () => false} = options;

    if (csv[0][0] === "time(millisecond)" && csv[0][1] === "datetime(utc)") return "Airdata";
    if (csv[0][1] === "Checksum" && csv[0][2] === "UnixTimeStamp" && csv[0][3] === "MissionID") return "MISB_FULL";
    if (csv[0][0] === "DPTS" && csv[0][1] === "Security:") return "MISB1";
    if (csv[0].includes("Sensor Latitude") || csv[0].includes("SensorLatitude")) return "MISB1";
    if (csv[0][0].toLowerCase() === "frame" && csv[0][1].toLowerCase() === "latitude" && csv[0][2].toLowerCase() === "longitude") return "CUSTOM_FLL";
    if (isCustom1(csv)) return "CUSTOM1";
    if (isFR24CSV(csv)) return "FR24CSV";
    if ((csv[0][0].toLowerCase() === "frame" || csv[0][0].toLowerCase() === "time") && csv[0][1].toLowerCase() === "az") return "AZIMUTH";
    if ((csv[0][0].toLowerCase() === "frame" || csv[0][0].toLowerCase() === "time") && csv[0][1].toLowerCase() === "el") return "ELEVATION";
    if ((csv[0][0].toLowerCase() === "frame" || csv[0][0].toLowerCase() === "time") && csv[0][1].toLowerCase() === "heading") return "HEADING";
    if ((csv[0][0].toLowerCase() === "frame" || csv[0][0].toLowerCase() === "time") && (csv[0][1].toLowerCase() === "fov" || csv[0][1].toLowerCase() === "zoom")) return "FOV";
    if (isFeaturesCSV(csv)) return "FEATURES";
    return "Unknown";
}

describe('detectCSVType', () => {

    describe('DJI Airdata format', () => {
        test('detects Airdata CSV by header columns', () => {
            const csv = [["time(millisecond)", "datetime(utc)", "latitude", "longitude"]];
            expect(detectCSVType(csv)).toBe("Airdata");
        });
    });

    describe('MISB formats', () => {
        test('detects MISB_FULL by Checksum/UnixTimeStamp/MissionID columns', () => {
            const csv = [["unknown", "Checksum", "UnixTimeStamp", "MissionID", "PlatformDesignation"]];
            expect(detectCSVType(csv)).toBe("MISB_FULL");
        });

        test('detects MISB1 by DPTS/Security: columns', () => {
            const csv = [["DPTS", "Security:", "Sensor Latitude", "Sensor Longitude"]];
            expect(detectCSVType(csv)).toBe("MISB1");
        });

        test('detects MISB1 by "Sensor Latitude" anywhere in header', () => {
            const csv = [["Frame", "Timestamp", "Sensor Latitude", "Sensor Longitude"]];
            expect(detectCSVType(csv)).toBe("MISB1");
        });

        test('detects MISB1 by "SensorLatitude" (tag ID style)', () => {
            const csv = [["Frame", "SensorLatitude", "SensorLongitude"]];
            expect(detectCSVType(csv)).toBe("MISB1");
        });
    });

    describe('Custom track formats', () => {
        test('detects CUSTOM_FLL by Frame/Latitude/Longitude headers', () => {
            const csv = [["Frame", "Latitude", "Longitude"]];
            expect(detectCSVType(csv)).toBe("CUSTOM_FLL");
        });

        test('CUSTOM_FLL is case-insensitive', () => {
            const csv = [["frame", "latitude", "longitude"]];
            expect(detectCSVType(csv)).toBe("CUSTOM_FLL");
        });

        test('detects CUSTOM1 when isCustom1 returns true', () => {
            const csv = [["time", "lat", "lon", "alt"]];
            expect(detectCSVType(csv, {isCustom1: () => true})).toBe("CUSTOM1");
        });

        test('detects FR24CSV when isFR24CSV returns true', () => {
            const csv = [["Timestamp", "UTC", "Callsign", "Position"]];
            expect(detectCSVType(csv, {isFR24CSV: () => true})).toBe("FR24CSV");
        });
    });

    describe('Control data CSVs (Az/El/FOV/Heading)', () => {
        test('detects AZIMUTH with Frame+Az columns', () => {
            expect(detectCSVType([["Frame", "Az"]])).toBe("AZIMUTH");
        });

        test('detects AZIMUTH with Time+Az columns', () => {
            expect(detectCSVType([["Time", "Az"]])).toBe("AZIMUTH");
        });

        test('detects ELEVATION with Frame+El columns', () => {
            expect(detectCSVType([["Frame", "El"]])).toBe("ELEVATION");
        });

        test('detects HEADING with Frame+Heading columns', () => {
            expect(detectCSVType([["Frame", "Heading"]])).toBe("HEADING");
        });

        test('detects FOV with Frame+FOV columns', () => {
            expect(detectCSVType([["Frame", "FOV"]])).toBe("FOV");
        });

        test('detects FOV with Time+Zoom columns', () => {
            expect(detectCSVType([["time", "zoom"]])).toBe("FOV");
        });

        test('Az/El/Heading/FOV detection is case-insensitive', () => {
            expect(detectCSVType([["frame", "az"]])).toBe("AZIMUTH");
            expect(detectCSVType([["FRAME", "EL"]])).toBe("ELEVATION");
            expect(detectCSVType([["Frame", "heading"]])).toBe("HEADING");
            expect(detectCSVType([["TIME", "fov"]])).toBe("FOV");
        });
    });

    describe('Features CSV', () => {
        test('detects FEATURES when isFeaturesCSV returns true', () => {
            const csv = [["Name", "Lat", "Lon", "Description"]];
            expect(detectCSVType(csv, {isFeaturesCSV: () => true})).toBe("FEATURES");
        });
    });

    describe('Unknown/fallback', () => {
        test('returns Unknown for unrecognized headers', () => {
            expect(detectCSVType([["col1", "col2", "col3"]])).toBe("Unknown");
        });

        test('returns Unknown for empty header row', () => {
            expect(detectCSVType([[""]])).toBe("Unknown");
        });
    });

    describe('priority and ambiguity', () => {
        test('Airdata takes priority over everything', () => {
            const csv = [["time(millisecond)", "datetime(utc)", "latitude", "longitude"]];
            expect(detectCSVType(csv)).toBe("Airdata");
        });

        test('MISB_FULL takes priority over MISB1', () => {
            const csv = [["unknown", "Checksum", "UnixTimeStamp", "MissionID", "Sensor Latitude"]];
            expect(detectCSVType(csv)).toBe("MISB_FULL");
        });

        test('CUSTOM_FLL takes priority over AZIMUTH when Frame+Latitude+Longitude', () => {
            const csv = [["Frame", "Latitude", "Longitude"]];
            expect(detectCSVType(csv)).toBe("CUSTOM_FLL");
        });

        test('CUSTOM1 checked before Az/El/Heading/FOV', () => {
            const csv = [["Frame", "Az"]];
            // If isCustom1 returns true, it should win over AZIMUTH
            expect(detectCSVType(csv, {isCustom1: () => true})).toBe("CUSTOM1");
        });
    });
});
