/**
 * @jest-environment jsdom
 */
import {CTrackFileMISB} from '../src/TrackFiles/CTrackFileMISB';
import {MISB, MISBFields, misbTagInfo} from '../src/MISBFields';
import fs from 'fs';
import path from 'path';
import csv from '../src/utils/CSVParser';

function parseMISBCSVForTest(csvData) {
    const rows = csvData.length;
    let MISBArray = new Array(rows - 1);
    for (let i = 1; i < rows; i++) {
        MISBArray[i - 1] = new Array(MISBFields).fill(null);
    }
    for (let col = 0; col < csvData[0].length; col++) {
        const header = csvData[0][col].replace(/\s/g, "").toLowerCase();
        const field = Object.keys(MISB).find(key => key.toLowerCase() === header);
        if (field !== undefined && MISB[field] !== undefined) {
            const fieldIndex = MISB[field];
            const tagInfo = misbTagInfo && misbTagInfo[fieldIndex];
            const isNumber = tagInfo ? tagInfo.isNumber : false;
            for (let row = 1; row < rows; row++) {
                let value = csvData[row][col];
                if (value === "null" || value === null || value === "") {
                    value = null;
                } else if (isNumber) {
                    value = Number(value);
                }
                MISBArray[row - 1][fieldIndex] = value;
            }
        }
    }
    return MISBArray;
}

function createTestMISBArray(withCenter = false, withAngles = false) {
    const rows = [];
    for (let i = 0; i < 10; i++) {
        const row = new Array(MISBFields).fill(null);
        row[MISB.UnixTimeStamp] = 1609459200000 + i * 1000;
        row[MISB.SensorLatitude] = 40.0 + i * 0.001;
        row[MISB.SensorLongitude] = -104.0 + i * 0.001;
        row[MISB.SensorTrueAltitude] = 1000 + i * 10;
        if (withCenter) {
            row[MISB.FrameCenterLatitude] = 40.1 + i * 0.001;
            row[MISB.FrameCenterLongitude] = -104.1 + i * 0.001;
            row[MISB.FrameCenterElevation] = 500 + i * 5;
        }
        if (withAngles) {
            row[MISB.PlatformHeadingAngle] = 90 + i;
            row[MISB.PlatformPitchAngle] = 5 + i * 0.1;
            row[MISB.PlatformRollAngle] = i * 0.5;
            row[MISB.SensorRelativeAzimuthAngle] = 180;
            row[MISB.SensorRelativeElevationAngle] = -30;
            row[MISB.SensorRelativeRollAngle] = 0;
            row[MISB.SensorVerticalFieldofView] = 30;
        }
        row[MISB.PlatformTailNumber] = "N12345";
        rows.push(row);
    }
    return rows;
}

describe('CTrackFileMISB', () => {
    let misbArray;
    let trackFile;
    let misbWithCenter;
    let trackFileWithCenter;

    beforeAll(() => {
        misbArray = createTestMISBArray(false, true);
        trackFile = new CTrackFileMISB(misbArray);
        misbWithCenter = createTestMISBArray(true, true);
        trackFileWithCenter = new CTrackFileMISB(misbWithCenter);
    });

    describe('canHandle', () => {
        test('returns true for valid MISB array data', () => {
            expect(CTrackFileMISB.canHandle('test.klv', misbArray)).toBe(true);
        });

        test('returns false for empty array', () => {
            expect(CTrackFileMISB.canHandle('test.klv', [])).toBe(false);
        });

        test('returns false for null data', () => {
            expect(CTrackFileMISB.canHandle('test.klv', null)).toBe(false);
        });

        test('returns false for string data', () => {
            expect(CTrackFileMISB.canHandle('test.klv', 'not an array')).toBe(false);
        });

        test('returns false for object data', () => {
            expect(CTrackFileMISB.canHandle('test.klv', {kml: {}})).toBe(false);
        });
    });

    describe('doesContainTrack', () => {
        test('returns true for valid MISB data', () => {
            expect(trackFile.doesContainTrack()).toBe(true);
        });

        test('returns false for empty array', () => {
            const emptyTrack = new CTrackFileMISB([]);
            expect(emptyTrack.doesContainTrack()).toBe(false);
        });

        test('returns false for null data', () => {
            const nullTrack = new CTrackFileMISB(null);
            expect(nullTrack.doesContainTrack()).toBe(false);
        });
    });

    describe('toMISB', () => {
        test('returns MISB array for track index 0', () => {
            const misb = trackFile.toMISB(0);
            expect(Array.isArray(misb)).toBe(true);
            expect(misb.length).toBeGreaterThan(0);
        });

        test('track index 0 returns the original data', () => {
            const misb = trackFile.toMISB(0);
            expect(misb).toBe(misbArray);
        });

        test('first entry has sensor latitude', () => {
            const misb = trackFile.toMISB(0);
            expect(misb[0][MISB.SensorLatitude]).toBeDefined();
            expect(typeof misb[0][MISB.SensorLatitude]).toBe('number');
        });

        test('first entry has sensor longitude', () => {
            const misb = trackFile.toMISB(0);
            expect(misb[0][MISB.SensorLongitude]).toBeDefined();
            expect(typeof misb[0][MISB.SensorLongitude]).toBe('number');
        });

        test('first entry has timestamp', () => {
            const misb = trackFile.toMISB(0);
            expect(misb[0][MISB.UnixTimeStamp]).toBeDefined();
        });

        test('returns false for invalid track index', () => {
            const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
            const result = trackFile.toMISB(99);
            expect(result).toBe(false);
            warnSpy.mockRestore();
        });

        test('returns false for negative track index', () => {
            const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
            const result = trackFile.toMISB(-1);
            expect(result).toBe(false);
            warnSpy.mockRestore();
        });
    });

    describe('center track (index 1)', () => {
        test('trackFile without center has 1 track', () => {
            expect(trackFile._hasCenter()).toBe(false);
            expect(trackFile.getTrackCount()).toBe(1);
        });

        test('trackFileWithCenter has 2 tracks', () => {
            expect(trackFileWithCenter._hasCenter()).toBe(true);
            expect(trackFileWithCenter.getTrackCount()).toBe(2);
        });

        test('toMISB(1) returns center data with correct values', () => {
            const centerMisb = trackFileWithCenter.toMISB(1);
            expect(Array.isArray(centerMisb)).toBe(true);
            expect(centerMisb.length).toBe(10);
            expect(centerMisb[0][MISB.SensorLatitude]).toBeCloseTo(40.1, 3);
            expect(centerMisb[0][MISB.SensorLongitude]).toBeCloseTo(-104.1, 3);
            expect(centerMisb[0][MISB.SensorTrueAltitude]).toBe(500);
        });

        test('toMISB(1) returns false for track without center', () => {
            const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
            const result = trackFile.toMISB(1);
            expect(result).toBe(false);
            warnSpy.mockRestore();
        });

        test('toMISB(1) preserves FrameCenter tag 78 (HAE) when tag 25 is absent', () => {
            // Frame center has ONLY FrameCenterHeightAboveEllipsoid (tag 78, HAE), no
            // FrameCenterElevation (tag 25). The HAE value must be kept in the
            // ellipsoid-height column (not lost as SensorTrueAltitude = 0).
            const rows = [];
            for (let i = 0; i < 3; i++) {
                const row = new Array(MISBFields).fill(null);
                row[MISB.UnixTimeStamp] = 1609459200000 + i * 1000;
                row[MISB.SensorLatitude] = 40.0 + i * 0.001;
                row[MISB.SensorLongitude] = -104.0 + i * 0.001;
                row[MISB.SensorTrueAltitude] = 1000 + i * 10;
                row[MISB.FrameCenterLatitude] = 40.1 + i * 0.001;
                row[MISB.FrameCenterLongitude] = -104.1 + i * 0.001;
                row[MISB.FrameCenterHeightAboveEllipsoid] = 480 + i * 5; // tag 78, no tag 25
                rows.push(row);
            }
            const tf = new CTrackFileMISB(rows);
            const centerMisb = tf.toMISB(1);
            expect(centerMisb[0][MISB.SensorEllipsoidHeight]).toBe(480);   // HAE preserved
            expect(centerMisb[0][MISB.SensorTrueAltitude]).toBe(null);     // not a bogus 0
        });
    });

    describe('getShortName', () => {
        test('prioritizes tail number over filename for track 0', () => {
            const name = trackFile.getShortName(0, 'Truck.klv');
            expect(name).toBe('N12345');
        });

        test('returns Center_ prefix with tail number for track 1', () => {
            const name = trackFileWithCenter.getShortName(1, 'Truck.klv');
            expect(name).toBe('Center_N12345');
        });

        test('uses tail number if available and no filename', () => {
            const name = trackFile.getShortName(0, '');
            expect(name).toBe('N12345');
        });

        test('falls back to filename if no tail number', () => {
            const noTailMisb = createTestMISBArray(false, false);
            noTailMisb[0][MISB.PlatformTailNumber] = null;
            const noTailFile = new CTrackFileMISB(noTailMisb);
            const name = noTailFile.getShortName(0, 'Truck.klv');
            expect(name).toBe('Truck');
        });

        test('returns default name if no tail number and no filename', () => {
            const noTailMisb = createTestMISBArray(false, false);
            noTailMisb[0][MISB.PlatformTailNumber] = null;
            const noTailFile = new CTrackFileMISB(noTailMisb);
            const name = noTailFile.getShortName(0, '');
            expect(name).toBe('MISB Track');
        });
    });

    describe('hasMoreTracks', () => {
        test('returns false for track 0 if no center track', () => {
            expect(trackFile.hasMoreTracks(0)).toBe(false);
        });

        test('returns true for track 0 if has center track', () => {
            expect(trackFileWithCenter.hasMoreTracks(0)).toBe(true);
        });

        test('returns false for last track', () => {
            expect(trackFileWithCenter.hasMoreTracks(1)).toBe(false);
        });
    });

    describe('getTrackCount', () => {
        test('returns 1 without center track', () => {
            expect(trackFile.getTrackCount()).toBe(1);
        });

        test('returns 2 with center track', () => {
            expect(trackFileWithCenter.getTrackCount()).toBe(2);
        });
    });

    describe('angle data detection', () => {
        test('_hasAngles returns true for data with angles', () => {
            expect(trackFile._hasAngles()).toBe(true);
        });

        test('_hasAngles returns false for data without angles', () => {
            const noAnglesMisb = createTestMISBArray(false, false);
            const noAnglesFile = new CTrackFileMISB(noAnglesMisb);
            expect(noAnglesFile._hasAngles()).toBe(false);
        });

        test('_hasFOV returns true for data with FOV', () => {
            expect(trackFile._hasFOV()).toBe(true);
        });

        test('_hasFOV returns false for data without FOV', () => {
            const noFOVMisb = createTestMISBArray(false, false);
            const noFOVFile = new CTrackFileMISB(noFOVMisb);
            expect(noFOVFile._hasFOV()).toBe(false);
        });
    });

    describe('extractObjects', () => {
        test('does not throw', () => {
            expect(() => trackFile.extractObjects()).not.toThrow();
        });
    });
});

describe('CTrackFileMISB exported CSV comparison', () => {
    const csvPath = path.join(__dirname, '../data/test/MISB-DATATrackData_N97826.csv');

    let csvMisb;
    let csvTrackFile;

    beforeAll(() => {
        const csvText = fs.readFileSync(csvPath, 'utf-8');
        const csvParsed = csv.toArrays(csvText);
        csvMisb = parseMISBCSVForTest(csvParsed);
        csvTrackFile = new CTrackFileMISB(csvMisb);
    });

    test('CSV file loads successfully', () => {
        expect(csvMisb).toBeDefined();
        expect(csvMisb.length).toBeGreaterThan(0);
    });

    test('CSV has expected number of rows (711 from the exported KLV)', () => {
        expect(csvMisb.length).toBe(711);
    });

    test('CSV has valid timestamps', () => {
        expect(Number(csvMisb[0][MISB.UnixTimeStamp])).toBe(1348087826484970);
    });

    test('CSV has valid sensor positions', () => {
        expect(Number(csvMisb[0][MISB.SensorLatitude])).toBeCloseTo(41.09574003196121, 10);
        expect(Number(csvMisb[0][MISB.SensorLongitude])).toBeCloseTo(-104.87021569389394, 10);
        expect(Number(csvMisb[0][MISB.SensorTrueAltitude])).toBeCloseTo(2933.0312046997788, 6);
    });

    test('CSV has valid center positions', () => {
        expect(Number(csvMisb[0][MISB.FrameCenterLatitude])).toBeCloseTo(41.10680242586267, 10);
        expect(Number(csvMisb[0][MISB.FrameCenterLongitude])).toBeCloseTo(-104.85100629965356, 10);
    });

    test('CSV has valid platform angles', () => {
        expect(Number(csvMisb[0][MISB.PlatformHeadingAngle])).toBeCloseTo(157.60128175783933, 10);
        expect(Number(csvMisb[0][MISB.PlatformPitchAngle])).toBeCloseTo(3.390606402783291, 10);
        expect(Number(csvMisb[0][MISB.PlatformRollAngle])).toBeCloseTo(-6.491286965544603, 10);
    });

    test('CSV has valid sensor angles', () => {
        expect(Number(csvMisb[0][MISB.SensorRelativeAzimuthAngle])).toBeCloseTo(254.25000015978006, 10);
        expect(Number(csvMisb[0][MISB.SensorRelativeElevationAngle])).toBeCloseTo(-20.38281248900239, 10);
    });

    test('CSV has valid FOV', () => {
        expect(Number(csvMisb[0][MISB.SensorVerticalFieldofView])).toBeCloseTo(1.7221332112611583, 10);
    });

    test('CSV has tail number N97826', () => {
        expect(csvMisb[0][MISB.PlatformTailNumber]).toBe('N97826');
    });

    test('CTrackFileMISB detects center track', () => {
        expect(csvTrackFile.getTrackCount()).toBe(2);
        expect(csvTrackFile.hasMoreTracks(0)).toBe(true);
        expect(csvTrackFile.hasMoreTracks(1)).toBe(false);
    });

    test('CTrackFileMISB detects angles', () => {
        expect(csvTrackFile._hasAngles()).toBe(true);
    });

    test('CTrackFileMISB detects FOV', () => {
        expect(csvTrackFile._hasFOV()).toBe(true);
    });

    test('toMISB(0) returns original data', () => {
        const track0 = csvTrackFile.toMISB(0);
        expect(track0.length).toBe(711);
        expect(track0).toBe(csvMisb);
    });

    test('toMISB(1) returns center track with promoted lat/lon', () => {
        const centerTrack = csvTrackFile.toMISB(1);
        expect(centerTrack.length).toBeGreaterThan(0);
        expect(Number(centerTrack[0][MISB.SensorLatitude])).toBeCloseTo(41.10680242586267, 10);
        expect(Number(centerTrack[0][MISB.SensorLongitude])).toBeCloseTo(-104.85100629965356, 10);
    });

    test('getShortName returns tail number N97826', () => {
        expect(csvTrackFile.getShortName(0)).toBe('N97826');
    });

    test('getShortName returns Center_N97826 for track 1', () => {
        expect(csvTrackFile.getShortName(1)).toBe('Center_N97826');
    });
});
