/**
 * @jest-environment jsdom
 */
import fs from 'fs';
import path from 'path';
import {CTrackFileSTANAG} from '../src/TrackFiles/CTrackFileSTANAG';
import {CTrackFileSTANAGCSV, isSTANAGCSV} from '../src/TrackFiles/CTrackFileSTANAGCSV';
import {isCustom1} from '../src/ParseCustom1CSV';
import {parseXml} from '../src/parseXml';
import {MISB} from '../src/MISBFields';
import csv from '../src/utils/CSVParser';

// elevated_track.csv is the CSV export of exactly the same track as elevated_track.xml,
// so the two must load identically — that equivalence is the point of the shared
// CTrackFileSTANAGBase and is asserted directly below.
const testCSVPath = path.join(__dirname, '../data/test/elevated_track.csv');
const testXMLPath = path.join(__dirname, '../data/test/elevated_track.xml');

const HEADER = ['UTC0', 'FRM', 'UTC', 't', 'GLAT', 'GLON', 'HAE', 'SLAT', 'SLON', 'SHAE', 'TPLAT', 'TPLON', 'TPHAE'];
const SAMPLE_ROW = ['1467215856006', '42', '1467215856006', '0',
    '40.4536', '-104.8801', '1430.7', '40.4213', '-104.8666', '3305.4', '40.4482', '-104.8779', '1744.3'];

describe('CTrackFileSTANAGCSV', () => {
    let csvRows;
    let trackFile;
    let xmlTrackFile;

    beforeAll(() => {
        csvRows = csv.toArrays(fs.readFileSync(testCSVPath, 'utf-8'));
        trackFile = new CTrackFileSTANAGCSV(csvRows);
        xmlTrackFile = new CTrackFileSTANAG(parseXml(fs.readFileSync(testXMLPath, 'utf-8')));
    });

    describe('isSTANAGCSV / canHandle', () => {
        test('accepts the STANAG CSV fixture', () => {
            expect(isSTANAGCSV(csvRows)).toBe(true);
            expect(CTrackFileSTANAGCSV.canHandle('elevated_track.csv', csvRows)).toBe(true);
        });

        test('header matching is case-insensitive and tolerates whitespace and extra columns', () => {
            const messy = [
                [...HEADER.map(h => `  ${h.toLowerCase()} `), 'OperatorNotes'],
                [...SAMPLE_ROW, 'anything'],
            ];
            expect(isSTANAGCSV(messy)).toBe(true);
        });

        test('column order does not matter', () => {
            const order = HEADER.map((_, i) => i).reverse();
            const shuffled = [order.map(i => HEADER[i]), order.map(i => SAMPLE_ROW[i])];
            expect(isSTANAGCSV(shuffled)).toBe(true);
        });

        // The detection is deliberately narrow so that existing generic CSVs keep taking
        // the Custom1 path. Requires the target family AND one line-of-sight family.
        test('rejects a target-only CSV (stays a Custom1 file)', () => {
            const targetOnly = [['UTC', 'TPLAT', 'TPLON', 'TPHAE'], ['1467215856006', '40.4', '-104.8', '1744']];
            expect(isSTANAGCSV(targetOnly)).toBe(false);
            expect(isCustom1(targetOnly)).toBe(true);
        });

        test('rejects an ordinary lat/lon CSV', () => {
            const plain = [['Time', 'Lat', 'Lon', 'Alt'], ['2016-06-29T15:57:36Z', '40.4', '-104.8', '1744']];
            expect(isSTANAGCSV(plain)).toBe(false);
        });

        test('rejects a header-only file and non-array input', () => {
            expect(isSTANAGCSV([HEADER])).toBe(false);
            expect(isSTANAGCSV(null)).toBe(false);
            expect(isSTANAGCSV('not a csv')).toBe(false);
            expect(CTrackFileSTANAGCSV.canHandle('x.csv', undefined)).toBe(false);
        });

        // detectCSVType() must test isSTANAGCSV BEFORE isCustom1, because a STANAG CSV
        // also satisfies the generic Custom1 header lists (UTC + TPLAT/TPLON). If the
        // order were reversed the Platform and Ground tracks would be silently dropped.
        test('a STANAG CSV also matches isCustom1, so detection order matters', () => {
            expect(isCustom1(csvRows)).toBe(true);
        });
    });

    describe('track enumeration', () => {
        test('yields three distinct tracks', () => {
            expect(trackFile.getTrackCount()).toBe(3);
        });

        test('counts as one logical track for the import picker', () => {
            expect(trackFile.getImportTrackCount()).toBe(1);
        });

        test('names the sub-tracks Target / Platform / Ground', () => {
            expect(trackFile.getShortName(0, 'elevated_track.csv')).toBe('elevated_track (Target)');
            expect(trackFile.getShortName(1, 'elevated_track.csv')).toBe('elevated_track (Platform)');
            expect(trackFile.getShortName(2, 'elevated_track.csv')).toBe('elevated_track (Ground)');
        });

        test('assigns camera/target roles: Target = target, Platform = camera, Ground = none', () => {
            expect(trackFile.trackRoleHint(0)).toBe('target');
            expect(trackFile.trackRoleHint(1)).toBe('camera');
            expect(trackFile.trackRoleHint(2)).toBe(null);
        });

        test('only the Target track is primary', () => {
            expect(trackFile.isSupplementaryTrack(0)).toBe(false);
            expect(trackFile.isSupplementaryTrack(1)).toBe(true);
            expect(trackFile.isSupplementaryTrack(2)).toBe(true);
        });

        test('hasMoreTracks walks the three tracks', () => {
            expect(trackFile.hasMoreTracks(0)).toBe(true);
            expect(trackFile.hasMoreTracks(1)).toBe(true);
            expect(trackFile.hasMoreTracks(2)).toBe(false);
        });
    });

    describe('toMISB', () => {
        test('returns 11 points per track', () => {
            expect(trackFile.toMISB(0).length).toBe(11);
            expect(trackFile.toMISB(1).length).toBe(11);
            expect(trackFile.toMISB(2).length).toBe(11);
        });

        test('track 0 is the tracked object (TPLAT/TPLON/TPHAE)', () => {
            const misb = trackFile.toMISB(0);
            expect(misb[0][MISB.SensorLatitude]).toBeCloseTo(40.448281922640632, 6);
            expect(misb[0][MISB.SensorLongitude]).toBeCloseTo(-104.877919707133, 6);
            expect(misb[0][MISB.SensorTrueAltitude]).toBeCloseTo(1744.3974248617887, 2);
        });

        test('track 1 is the sensor platform (SLAT/SLON/SHAE)', () => {
            const misb = trackFile.toMISB(1);
            expect(misb[0][MISB.SensorLatitude]).toBeCloseTo(40.421348598599124, 6);
            expect(misb[0][MISB.SensorLongitude]).toBeCloseTo(-104.86668420008492, 6);
            expect(misb[0][MISB.SensorTrueAltitude]).toBeCloseTo(3305.4438118077815, 2);
        });

        test('track 2 is the ground intersection (GLAT/GLON/HAE)', () => {
            const misb = trackFile.toMISB(2);
            expect(misb[0][MISB.SensorLatitude]).toBeCloseTo(40.45369795658096, 6);
            expect(misb[0][MISB.SensorLongitude]).toBeCloseTo(-104.88018020218584, 6);
            expect(misb[0][MISB.SensorTrueAltitude]).toBeCloseTo(1430.7568446667865, 2);
        });

        test('timestamps come from the UTC column and increase', () => {
            const misb = trackFile.toMISB(0);
            expect(misb[0][MISB.UnixTimeStamp]).toBe(1467215856006);
            for (let i = 1; i < misb.length; i++) {
                expect(misb[i][MISB.UnixTimeStamp]).toBeGreaterThan(misb[i - 1][MISB.UnixTimeStamp]);
            }
        });

        test('falls back to UTC0 + t seconds when there is no UTC column', () => {
            const noUTC = csvRows.map(row => row.filter((_, i) => i !== 2));
            const misb = new CTrackFileSTANAGCSV(noUTC).toMISB(0);
            expect(misb[0][MISB.UnixTimeStamp]).toBe(1467215856006);
            expect(misb[1][MISB.UnixTimeStamp]).toBeCloseTo(1467215860535.028, 1);
        });

        test('returns false for an out-of-range track index', () => {
            const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
            expect(trackFile.toMISB(3)).toBe(false);
            warnSpy.mockRestore();
        });

        test('returns false for data that is not a STANAG CSV', () => {
            const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
            expect(new CTrackFileSTANAGCSV([]).toMISB()).toBe(false);
            expect(new CTrackFileSTANAGCSV(null).toMISB()).toBe(false);
            warnSpy.mockRestore();
        });

        // Rows whose position columns are blank or non-numeric contribute no point to that
        // track, but must not shift the other tracks' points.
        test('skips blank positions per-track without disturbing the others', () => {
            const holed = csvRows.map(r => r.slice());
            holed[3][10] = '';      // TPLAT
            holed[3][11] = '';      // TPLON
            const holedFile = new CTrackFileSTANAGCSV(holed);
            expect(holedFile.toMISB(0).length).toBe(10);
            expect(holedFile.toMISB(1).length).toBe(11);
            expect(holedFile.toMISB(2).length).toBe(11);
        });
    });

    // STANAG heights are WGS-84 ellipsoidal, and the CSV column names say so outright
    // (HAE / SHAE / TPHAE). Reporting HAE makes the MISB pipeline skip the MSL->HAE geoid
    // add that would otherwise sink the track ~N metres (N ≈ -19 m in Colorado).
    describe('isAltitudeHAE', () => {
        test('reports HAE for every track', () => {
            expect(trackFile.isAltitudeHAE(0)).toBe(true);
            expect(trackFile.isAltitudeHAE(1)).toBe(true);
            expect(trackFile.isAltitudeHAE(2)).toBe(true);
        });
    });

    // Ground-locked: the tracker's estimate coincides with the ground end of the ray, so
    // the duplicate collapses to two tracks and the target role transfers to the survivor —
    // the same behaviour the XML parser has.
    describe('de-duplication when the target is ground-locked', () => {
        let groundLocked;

        beforeAll(() => {
            const rows = csvRows.map(r => r.slice());
            for (let i = 1; i < rows.length; i++) {
                rows[i][10] = rows[i][4];  // TPLAT  <- GLAT
                rows[i][11] = rows[i][5];  // TPLON  <- GLON
                rows[i][12] = rows[i][6];  // TPHAE  <- HAE
            }
            groundLocked = new CTrackFileSTANAGCSV(rows);
        });

        test('collapses three positions to two distinct tracks', () => {
            expect(groundLocked.getTrackCount()).toBe(2);
        });

        test('the surviving tracks are Target (primary) and Platform', () => {
            expect(groundLocked.getShortName(0, 'gl.csv')).toBe('gl (Target)');
            expect(groundLocked.getShortName(1, 'gl.csv')).toBe('gl (Platform)');
            expect(groundLocked.trackRoleHint(0)).toBe('target');
            expect(groundLocked.trackRoleHint(1)).toBe('camera');
        });
    });

    // The whole point of the shared base class: the CSV export of a STANAG file must load
    // exactly like the XML it came from.
    describe('equivalence with the XML flavour', () => {
        test('same track count, names, roles and datum', () => {
            expect(trackFile.getTrackCount()).toBe(xmlTrackFile.getTrackCount());
            expect(trackFile.getImportTrackCount()).toBe(xmlTrackFile.getImportTrackCount());
            for (let i = 0; i < xmlTrackFile.getTrackCount(); i++) {
                expect(trackFile.getShortName(i, 'x.csv')).toBe(xmlTrackFile.getShortName(i, 'x.xml'));
                expect(trackFile.trackRoleHint(i)).toBe(xmlTrackFile.trackRoleHint(i));
                expect(trackFile.isAltitudeHAE(i)).toBe(xmlTrackFile.isAltitudeHAE(i));
                expect(trackFile.isSupplementaryTrack(i)).toBe(xmlTrackFile.isSupplementaryTrack(i));
            }
        });

        test('same MISB positions and timestamps for every track', () => {
            for (let i = 0; i < xmlTrackFile.getTrackCount(); i++) {
                const fromCSV = trackFile.toMISB(i);
                const fromXML = xmlTrackFile.toMISB(i);
                expect(fromCSV.length).toBe(fromXML.length);
                for (let r = 0; r < fromXML.length; r++) {
                    // The CSV carries UTC as whole milliseconds while the XML derives it
                    // from relTime * relTimeIncrement, so allow sub-millisecond drift.
                    expect(fromCSV[r][MISB.UnixTimeStamp]).toBeCloseTo(fromXML[r][MISB.UnixTimeStamp], 0);
                    expect(fromCSV[r][MISB.SensorLatitude]).toBeCloseTo(fromXML[r][MISB.SensorLatitude], 9);
                    expect(fromCSV[r][MISB.SensorLongitude]).toBeCloseTo(fromXML[r][MISB.SensorLongitude], 9);
                    expect(fromCSV[r][MISB.SensorTrueAltitude]).toBeCloseTo(fromXML[r][MISB.SensorTrueAltitude], 6);
                }
            }
        });
    });
});
