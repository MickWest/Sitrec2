/**
 * Tests for detectCSVType() — the CSV format classifier in CFileManager.
 *
 * detectCSVType takes a parsed CSV (array of arrays) and returns a string
 * identifying the format: "Airdata", "MISB_FULL", "MISB1", "STANAG_CSV",
 * "CUSTOM1", "CUSTOM_FLL", "FR24CSV", "CAMERA_STATE", "AZIMUTH", "ELEVATION",
 * "HEADING", "FOV", "FEATURES", or "Unknown".
 *
 * Since CFileManager has a deep dependency chain (Three.js, DOM, etc.),
 * we re-implement the detection logic from source and test it directly.
 * This is intentional — it tests the SPECIFICATION (header patterns),
 * not the import chain. If someone changes detectCSVType and this test
 * breaks, they'll know to update both. The camera-state checks at the end
 * also run the real function, with the real predicates of the formats it
 * must not take files from.
 */

import fs from 'fs';
import path from 'path';
import {isSTANAGCSV} from '../src/TrackFiles/CTrackFileSTANAGCSV';
import {isCameraStateCSV} from '../src/CameraStateTable';
import {detectCSVType as realDetectCSVType} from '../src/TrackFiles/TrackCSV';
import {isCustom1} from '../src/ParseCustom1CSV';
import {setSit} from '../src/Globals';
import csvParser from '../src/utils/CSVParser';
import {legacyCameraDataFiles} from './fixtures/legacyCameraDataFiles';

// Extract detectCSVType source and re-implement it for testing
// This avoids the deep CFileManager import chain
const source = fs.readFileSync(
    path.resolve(__dirname, '../src/TrackFiles/TrackCSV.js'), 'utf-8'
);

// Verify the function exists and hasn't been moved. detectCSVType moved
// from CFileManager.js to CFileManagerParse.js during the refactor2 module
// split (commit 36bcc1d7), then to TrackFiles/TrackCSV.js — beside the
// type→parser dispatch it feeds — in the CSV single-source-of-truth
// refactor (CFileManagerParse re-exports it for its existing importers).
describe('detectCSVType source presence', () => {
    test('detectCSVType is exported from TrackCSV.js', () => {
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
    // Uses the real predicate (dependency-free) — its position ahead of isCustom1 is
    // load-bearing: a STANAG CSV also matches the generic Custom1 header lists.
    if (isSTANAGCSV(csv)) return "STANAG_CSV";
    if (isCustom1(csv)) return "CUSTOM1";
    if (isFR24CSV(csv)) return "FR24CSV";
    // Real predicate (dependency-free). After the track formats, before Az/El/FOV.
    if (isCameraStateCSV(csv)) return "CAMERA_STATE";
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

    // The STANAG 4676 CSV export carries the tracked object plus both line-of-sight
    // endpoints. It must be classified before CUSTOM1, which would otherwise claim it on
    // its UTC/TPLAT/TPLON headers and import only the target position.
    describe('STANAG 4676 CSV', () => {
        const stanagCSV = [
            ["UTC0", "FRM", "UTC", "t", "GLAT", "GLON", "HAE", "SLAT", "SLON", "SHAE", "TPLAT", "TPLON", "TPHAE"],
            ["1467215856006", "42", "1467215856006", "0",
                "40.4536", "-104.8801", "1430.7", "40.4213", "-104.8666", "3305.4", "40.4482", "-104.8779", "1744.3"],
        ];

        test('detects STANAG_CSV by its column families', () => {
            expect(detectCSVType(stanagCSV)).toBe("STANAG_CSV");
        });

        test('wins over CUSTOM1, which also matches these headers', () => {
            expect(detectCSVType(stanagCSV, {isCustom1: () => true})).toBe("STANAG_CSV");
        });

        test('a target-only CSV still classifies as CUSTOM1', () => {
            const targetOnly = [["UTC", "TPLAT", "TPLON", "TPHAE"], ["1467215856006", "40.4", "-104.8", "1744"]];
            expect(detectCSVType(targetOnly, {isCustom1: () => true})).toBe("CUSTOM1");
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

        test('CAMERA_STATE is checked after the track formats and before FOV', () => {
            const camera = [["Frame", "Zoom", "Mode", "FL"]];
            expect(detectCSVType(camera)).toBe("CAMERA_STATE");
            expect(detectCSVType(camera, {isCustom1: () => true})).toBe("CUSTOM1");
            expect(detectCSVType(camera, {isFR24CSV: () => true})).toBe("FR24CSV");
        });
    });
});

// The real function, with the real predicates. Sit is set so that the
// "Unknown" path (which reads Sit.isCustom) can run.
describe('camera state detection (real detectCSVType)', () => {
    beforeAll(() => setSit({isCustom: false}));

    const header = ["Frame", "Mode", "FL", "Zoom", "", ""];

    test('a camera data header is CAMERA_STATE, Zoom and Polarity optional', () => {
        expect(realDetectCSVType([header, ["0", "IR", "675", "1", "", ""]])).toBe("CAMERA_STATE");
        expect(realDetectCSVType([["frame", "mode", "fl"], ["0", "IR", "675"]])).toBe("CAMERA_STATE");
        expect(realDetectCSVType([["Frame", "Mode", "FL", "Zoom", "Polarity"]])).toBe("CAMERA_STATE");
    });

    test('Frame,Zoom stays a FOV file; a Zoom column beside Mode and FL does not', () => {
        expect(realDetectCSVType([["Frame", "Zoom"], ["0", "1.5"]])).toBe("FOV");
        expect(realDetectCSVType([["Frame", "FOV"], ["0", "1.5"]])).toBe("FOV");
        expect(realDetectCSVType([["Frame", "Zoom", "Mode", "FL"], ["0", "1", "IR", "675"]])).toBe("CAMERA_STATE");
        expect(realDetectCSVType([["Time", "Az"], ["0", "10"]])).toBe("AZIMUTH");
    });

    test('camera data with angle columns is CAMERA_STATE; the import also feeds the angles (CameraStateImport.test.js)', () => {
        expect(realDetectCSVType([["Frame", "Az", "El", "Mode", "FL"], ["0", "10", "1", "IR", "675"]])).toBe("CAMERA_STATE");
        expect(realDetectCSVType([["Frame", "FOV", "Mode", "FL"], ["0", "0.9", "IR", "675"]])).toBe("CAMERA_STATE");
    });

    test('Custom1 does not claim the camera data header', () => {
        expect(isCustom1([header])).toBe(false);
    });

    test('a track file that also carries Mode and FL columns stays a track', () => {
        const track = [["time", "lat", "lon", "alt", "Frame", "Mode", "FL"],
            ["2020-01-01T00:00:00Z", "34", "-118", "1000", "0", "IR", "675"]];
        expect(isCustom1(track)).toBe(true);
        expect(realDetectCSVType(track)).toBe("CUSTOM1");
    });

    test.each(legacyCameraDataFiles())('the built-in camera data file of $name is CAMERA_STATE', ({csvPath}) => {
        // Decoded as the app decodes it: TextDecoder removes the byte-order mark.
        const text = new TextDecoder('utf-8').decode(fs.readFileSync(csvPath));
        expect(realDetectCSVType(csvParser.toArrays(text))).toBe("CAMERA_STATE");
    });
});
