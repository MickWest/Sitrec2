/**
 * @jest-environment jsdom
 */
import fs from 'fs';
import path from 'path';
import {CTrackFileSTANAG} from '../src/TrackFiles/CTrackFileSTANAG';
import {parseXml} from '../src/parseXml';
import {MISB} from '../src/MISBFields';

const testXMLPath = path.join(__dirname, '../data/test/elevated_track.xml');

describe('CTrackFileSTANAG', () => {
    let xmlData;
    let parsedXml;
    let trackFile;

    beforeAll(() => {
        xmlData = fs.readFileSync(testXMLPath, 'utf-8');
        parsedXml = parseXml(xmlData);
        trackFile = new CTrackFileSTANAG(parsedXml);
    });

    describe('canHandle', () => {
        test('returns true for valid STANAG XML data', () => {
            expect(CTrackFileSTANAG.canHandle('test.xml', parsedXml)).toBe(true);
        });

        test('returns false for empty object', () => {
            expect(CTrackFileSTANAG.canHandle('test.xml', {})).toBe(false);
        });

        test('returns false for null data', () => {
            expect(CTrackFileSTANAG.canHandle('test.xml', null)).toBe(false);
        });

        test('returns false for string data', () => {
            expect(CTrackFileSTANAG.canHandle('test.xml', 'not an object')).toBe(false);
        });

        test('returns false for KML data', () => {
            expect(CTrackFileSTANAG.canHandle('test.kml', {kml: {}})).toBe(false);
        });
    });

    describe('doesContainTrack', () => {
        test('returns true for valid XML data', () => {
            expect(trackFile.doesContainTrack()).toBe(true);
        });

        test('returns false for empty object', () => {
            const emptyTrack = new CTrackFileSTANAG({});
            expect(emptyTrack.doesContainTrack()).toBe(false);
        });

        test('returns false for invalid data', () => {
            const invalidTrack = new CTrackFileSTANAG({nitsRoot: {}});
            expect(invalidTrack.doesContainTrack()).toBe(false);
        });

        test('returns false for null data', () => {
            const nullTrack = new CTrackFileSTANAG(null);
            expect(nullTrack.doesContainTrack()).toBe(false);
        });

        test('returns false for string data', () => {
            const stringTrack = new CTrackFileSTANAG('not an object');
            expect(stringTrack.doesContainTrack()).toBe(false);
        });
    });

    describe('toMISB', () => {
        test('returns MISB array for valid XML data', () => {
            const misb = trackFile.toMISB();
            expect(Array.isArray(misb)).toBe(true);
            expect(misb.length).toBeGreaterThan(0);
        });

        test('returns 11 track points from test file for track 0', () => {
            const misb = trackFile.toMISB(0);
            expect(misb.length).toBe(11);
        });

        test('first entry has correct latitude from test file (authoritative dynamics/pos)', () => {
            const misb = trackFile.toMISB();
            expect(misb[0][MISB.SensorLatitude]).toBeCloseTo(40.448281922640632, 6);
        });

        test('first entry has correct longitude from test file (authoritative dynamics/pos)', () => {
            const misb = trackFile.toMISB();
            expect(misb[0][MISB.SensorLongitude]).toBeCloseTo(-104.877919707133, 6);
        });

        test('first entry has correct altitude from test file (authoritative dynamics/pos)', () => {
            const misb = trackFile.toMISB();
            expect(misb[0][MISB.SensorTrueAltitude]).toBeCloseTo(1744.3974248617887, 2);
        });

        test('first entry has timestamp', () => {
            const misb = trackFile.toMISB();
            expect(misb[0][MISB.UnixTimeStamp]).toBeDefined();
            expect(typeof misb[0][MISB.UnixTimeStamp]).toBe('number');
        });

        test('timestamps increase through track points', () => {
            const misb = trackFile.toMISB();
            for (let i = 1; i < misb.length; i++) {
                expect(misb[i][MISB.UnixTimeStamp]).toBeGreaterThan(misb[i-1][MISB.UnixTimeStamp]);
            }
        });

        test('returns false for invalid track index', () => {
            const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
            const result = trackFile.toMISB(3);
            expect(result).toBe(false);
            warnSpy.mockRestore();
        });

        test('returns false for invalid data', () => {
            const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
            const invalidTrack = new CTrackFileSTANAG({});
            expect(invalidTrack.toMISB()).toBe(false);
            warnSpy.mockRestore();
        });

        describe('Platform track (index 1)', () => {
            test('returns 11 track points for Platform track', () => {
                const misb = trackFile.toMISB(1);
                expect(Array.isArray(misb)).toBe(true);
                expect(misb.length).toBe(11);
            });

            test('first Platform entry has correct latitude (posHigh)', () => {
                const misb = trackFile.toMISB(1);
                expect(misb[0][MISB.SensorLatitude]).toBeCloseTo(40.421348598599124, 6);
            });

            test('first Platform entry has correct longitude', () => {
                const misb = trackFile.toMISB(1);
                expect(misb[0][MISB.SensorLongitude]).toBeCloseTo(-104.86668420008492, 6);
            });

            test('first Platform entry has correct altitude (higher than target)', () => {
                const misb = trackFile.toMISB(1);
                expect(misb[0][MISB.SensorTrueAltitude]).toBeCloseTo(3305.4438118077815, 2);
            });
        });

        describe('ground track (index 2)', () => {
            test('returns 11 track points for ground track', () => {
                const misb = trackFile.toMISB(2);
                expect(Array.isArray(misb)).toBe(true);
                expect(misb.length).toBe(11);
            });

            test('first ground entry has correct latitude (ground intersection)', () => {
                const misb = trackFile.toMISB(2);
                expect(misb[0][MISB.SensorLatitude]).toBeCloseTo(40.45369795658096, 6);
            });

            test('first ground entry has correct longitude', () => {
                const misb = trackFile.toMISB(2);
                expect(misb[0][MISB.SensorLongitude]).toBeCloseTo(-104.88018020218584, 6);
            });

            test('first ground entry has correct altitude (lower than other tracks)', () => {
                const misb = trackFile.toMISB(2);
                expect(misb[0][MISB.SensorTrueAltitude]).toBeCloseTo(1430.7568446667865, 2);
            });
        });
    });

    describe('getShortName', () => {
        test('returns (Target) suffix for track 0 (authoritative dynamics/pos)', () => {
            expect(trackFile.getShortName(0, 'elevated_track.xml')).toBe('elevated_track (Target)');
        });

        test('returns filename with (Platform) suffix for track 1 (posHigh)', () => {
            expect(trackFile.getShortName(1, 'elevated_track.xml')).toBe('elevated_track (Platform)');
        });

        test('returns filename with (Ground) suffix for track 2', () => {
            expect(trackFile.getShortName(2, 'elevated_track.xml')).toBe('elevated_track (Ground)');
        });

        test('returns (Target) default name for track 0 when no filename provided', () => {
            expect(trackFile.getShortName()).toBe('STANAG Track (Target)');
        });

        test('returns default name with (Platform) suffix for track 1 when no filename', () => {
            expect(trackFile.getShortName(1)).toBe('STANAG Track (Platform)');
        });

        test('returns default name with (Ground) suffix for track 2 when no filename', () => {
            expect(trackFile.getShortName(2)).toBe('STANAG Track (Ground)');
        });
    });

    describe('hasMoreTracks', () => {
        test('returns true for track 0 (file has posLow/posHigh)', () => {
            expect(trackFile.hasMoreTracks(0)).toBe(true);
        });

        test('returns true for track 1 (file has posHigh)', () => {
            expect(trackFile.hasMoreTracks(1)).toBe(true);
        });

        test('returns false for track 2 (last track)', () => {
            expect(trackFile.hasMoreTracks(2)).toBe(false);
        });
    });

    describe('getTrackCount', () => {
        test('returns 3 (file has posLow/posHigh tracks)', () => {
            expect(trackFile.getTrackCount()).toBe(3);
        });

    });

    // The import picker gates on getImportTrackCount() (independent NATO tracks =
    // numTracks), not getTrackCount()'s 2-3 derived sub-tracks, so a lone STANAG track
    // never triggers the multi-track dialog even though it yields 3 sub-tracks.
    describe('getImportTrackCount', () => {
        test('returns numTracks (1) even though getTrackCount() is 3', () => {
            expect(trackFile.getTrackCount()).toBe(3);
            expect(trackFile.getImportTrackCount()).toBe(1);
        });

        test('reads the message numTracks attribute when present', () => {
            const multi = parseXml(`<?xml version="1.0"?>
                <nitsRoot xmlns="urn:nato:niia:stanag:4676:isrtrackingstandard:b:1">
                    <message numTracks="4"><baseTime>2016-06-29T15:57:36.006Z</baseTime><track><segment>
                        <tp><relTime>0</relTime><dynamics cs="WGS_84"><pos>40.0 -104.0 1000.0</pos></dynamics></tp>
                    </segment></track></message>
                </nitsRoot>`);
            expect(new CTrackFileSTANAG(multi).getImportTrackCount()).toBe(4);
        });

        test('defaults to 1 when numTracks is absent', () => {
            const noAttr = parseXml(`<?xml version="1.0"?>
                <nitsRoot xmlns="urn:nato:niia:stanag:4676:isrtrackingstandard:b:1">
                    <message><baseTime>2016-06-29T15:57:36.006Z</baseTime><track><segment>
                        <tp><relTime>0</relTime><dynamics cs="WGS_84"><pos>40.0 -104.0 1000.0</pos></dynamics></tp>
                    </segment></track></message>
                </nitsRoot>`);
            expect(new CTrackFileSTANAG(noAttr).getImportTrackCount()).toBe(1);
        });
    });

    describe('getTrackCount', () => {
        test('returns 1 for file without posLow/posHigh', () => {
            const minimalXml = parseXml(`<?xml version="1.0"?>
                <nitsRoot xmlns="urn:nato:niia:stanag:4676:isrtrackingstandard:b:1">
                    <message>
                        <baseTime>2016-06-29T15:57:36.006Z</baseTime>
                        <track>
                            <segment>
                                <tp>
                                    <relTime>0</relTime>
                                    <dynamics cs="WGS_84">
                                        <pos>40.0 -104.0 1000.0</pos>
                                    </dynamics>
                                </tp>
                            </segment>
                        </track>
                    </message>
                </nitsRoot>`);
            const minimalTrack = new CTrackFileSTANAG(minimalXml);
            expect(minimalTrack.getTrackCount()).toBe(1);
        });
    });

    describe('extractObjects', () => {
        test('does not throw', () => {
            expect(() => trackFile.extractObjects()).not.toThrow();
        });
    });

    // STANAG heights are WGS-84 ellipsoidal (HAE). isAltitudeHAE() reports this so the
    // MISB pipeline does not re-add the geoid offset (which would sink the track ~N metres).
    describe('isAltitudeHAE (WGS-84 datum)', () => {
        test('returns true for the test file (cs="WGS_84")', () => {
            expect(trackFile.isAltitudeHAE()).toBe(true);
        });

        test('returns true when no cs attribute is present (4676 default is ellipsoidal)', () => {
            const noCs = parseXml(`<?xml version="1.0"?>
                <nitsRoot xmlns="urn:nato:niia:stanag:4676:isrtrackingstandard:b:1">
                    <message><baseTime>2016-06-29T15:57:36.006Z</baseTime><track><segment>
                        <tp><relTime>0</relTime><dynamics><pos>40.0 -104.0 1000.0</pos></dynamics></tp>
                    </segment></track></message>
                </nitsRoot>`);
            expect(new CTrackFileSTANAG(noCs).isAltitudeHAE()).toBe(true);
        });

        test('returns false for an orthometric cs (e.g. EGM96 = MSL)', () => {
            const egm = parseXml(`<?xml version="1.0"?>
                <nitsRoot xmlns="urn:nato:niia:stanag:4676:isrtrackingstandard:b:1">
                    <message><baseTime>2016-06-29T15:57:36.006Z</baseTime><track><segment>
                        <tp><relTime>0</relTime><dynamics cs="EGM96"><pos>40.0 -104.0 1000.0</pos></dynamics></tp>
                    </segment></track></message>
                </nitsRoot>`);
            expect(new CTrackFileSTANAG(egm).isAltitudeHAE()).toBe(false);
        });

        const withCs = (cs) => parseXml(`<?xml version="1.0"?>
            <nitsRoot xmlns="urn:nato:niia:stanag:4676:isrtrackingstandard:b:1">
                <message><baseTime>2016-06-29T15:57:36.006Z</baseTime><track><segment>
                    <tp><relTime>0</relTime><dynamics cs="${cs}"><pos>40.0 -104.0 1000.0</pos></dynamics></tp>
                </segment></track></message>
            </nitsRoot>`);

        test('tolerates producer variants of the WGS-84 label', () => {
            expect(new CTrackFileSTANAG(withCs("WGS84")).isAltitudeHAE()).toBe(true);
            expect(new CTrackFileSTANAG(withCs("WGS-84")).isAltitudeHAE()).toBe(true);
            expect(new CTrackFileSTANAG(withCs("wgs 84")).isAltitudeHAE()).toBe(true);
        });

        test('orthometric indicator wins over an ellipsoidal one in hybrid labels', () => {
            expect(new CTrackFileSTANAG(withCs("WGS84_EGM96")).isAltitudeHAE()).toBe(false);
        });

        test('unknown cs falls back to the 4676 ellipsoidal default', () => {
            expect(new CTrackFileSTANAG(withCs("SOME_FUTURE_CRS")).isAltitudeHAE()).toBe(true);
        });
    });

    // A ground-locked target: the tracker's estimate (dynamics/pos) is IDENTICAL to the
    // low / ground end of the line of sight (posLow). Emitting posHigh, dynamics/pos AND
    // posLow would produce a duplicate track, so the parser collapses to two distinct
    // tracks: the authoritative dynamics/pos (Target, primary), and (Platform) = posHigh.
    describe('de-duplication when dynamics/pos == posLow', () => {
        const groundLockedXml = parseXml(`<?xml version="1.0"?>
            <nitsRoot xmlns="urn:nato:niia:stanag:4676:isrtrackingstandard:b:1">
                <message>
                    <baseTime>2016-06-29T15:57:36.006Z</baseTime>
                    <relTimeIncrement>0.000001</relTimeIncrement>
                    <track>
                        <segment>
                            <tp posLow="40.100 -104.100 1400.0" posHigh="40.200 -104.200 3300.0">
                                <relTime>0</relTime>
                                <dynamics cs="WGS_84">
                                    <pos>40.100 -104.100 1400.0</pos>
                                </dynamics>
                            </tp>
                            <tp posLow="40.110 -104.110 1401.0" posHigh="40.210 -104.210 3301.0">
                                <relTime>1000000</relTime>
                                <dynamics cs="WGS_84">
                                    <pos>40.110 -104.110 1401.0</pos>
                                </dynamics>
                            </tp>
                        </segment>
                    </track>
                </message>
            </nitsRoot>`);
        const groundLocked = new CTrackFileSTANAG(groundLockedXml);

        test('collapses three positions to two distinct tracks', () => {
            expect(groundLocked.getTrackCount()).toBe(2);
        });

        test('track 0 is the authoritative dynamics/pos, named (Target) (primary)', () => {
            expect(groundLocked.getShortName(0, 'gl.xml')).toBe('gl (Target)');
            const misb = groundLocked.toMISB(0);
            expect(misb[0][MISB.SensorLatitude]).toBeCloseTo(40.100, 6);
        });

        test('track 1 is the Platform endpoint (posHigh)', () => {
            expect(groundLocked.getShortName(1, 'gl.xml')).toBe('gl (Platform)');
            const misb = groundLocked.toMISB(1);
            expect(misb[0][MISB.SensorLatitude]).toBeCloseTo(40.200, 6);
        });

        test('the redundant posLow (Ground) track is dropped', () => {
            const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
            expect(groundLocked.toMISB(2)).toBe(false);
            warnSpy.mockRestore();
        });

        test('hasMoreTracks reflects the two-track count', () => {
            expect(groundLocked.hasMoreTracks(0)).toBe(true);
            expect(groundLocked.hasMoreTracks(1)).toBe(false);
        });
    });

    // Camera/target auto-selection roles: dynamics/pos (Target) is the tracked object ->
    // target; posHigh (Platform) approximates the sensor position -> camera; posLow
    // (Ground) is an unroled reference point.
    describe('trackRoleHint', () => {
        test('elevated file: dynamics/pos is target, Platform is camera, Ground has no role', () => {
            expect(trackFile.trackRoleHint(0)).toBe('target');  // dynamics/pos (Target, primary)
            expect(trackFile.trackRoleHint(1)).toBe('camera');  // posHigh (Platform)
            expect(trackFile.trackRoleHint(2)).toBe(null);      // posLow (Ground)
        });

        test('ground-locked file: dynamics/pos is the target (== posLow), Platform is camera', () => {
            const groundLockedXml = parseXml(`<?xml version="1.0"?>
                <nitsRoot xmlns="urn:nato:niia:stanag:4676:isrtrackingstandard:b:1">
                    <message>
                        <baseTime>2016-06-29T15:57:36.006Z</baseTime>
                        <relTimeIncrement>0.000001</relTimeIncrement>
                        <track><segment>
                            <tp posLow="40.100 -104.100 1400.0" posHigh="40.200 -104.200 3300.0">
                                <relTime>0</relTime>
                                <dynamics cs="WGS_84"><pos>40.100 -104.100 1400.0</pos></dynamics>
                            </tp>
                        </segment></track>
                    </message>
                </nitsRoot>`);
            const gl = new CTrackFileSTANAG(groundLockedXml);
            expect(gl.trackRoleHint(0)).toBe('target');   // dynamics/pos == posLow
            expect(gl.trackRoleHint(1)).toBe('camera');   // posHigh (Platform)
        });

        test('file without posLow/posHigh has no roles', () => {
            const minimalXml = parseXml(`<?xml version="1.0"?>
                <nitsRoot xmlns="urn:nato:niia:stanag:4676:isrtrackingstandard:b:1">
                    <message><baseTime>2016-06-29T15:57:36.006Z</baseTime><track><segment>
                        <tp><relTime>0</relTime><dynamics cs="WGS_84"><pos>40.0 -104.0 1000.0</pos></dynamics></tp>
                    </segment></track></message>
                </nitsRoot>`);
            expect(new CTrackFileSTANAG(minimalXml).trackRoleHint(0)).toBe(null);
        });
    });
});
