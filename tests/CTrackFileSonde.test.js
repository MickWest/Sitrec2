import {sondeRowFrame} from "../src/SondeTrajectory";
import {CTrackFileSonde} from '../src/TrackFiles/CTrackFileSonde';
import {MISB} from '../src/MISBFields';

// ─── Sample Data ─────────────────────────────────────────────────────────

const sampleIGRA2 = `#USM00072451 2024  1  1 12 1156    5 ncdc-gts ncdc-gts  377626  -999695
10 -9999 101320    79   -53   960   259   200    36
20   120  85000  1546   -93 -9999 -9999   270    82
20   240  70000  3170  -169 -9999 -9999   285   154
20   420  50000  5780  -276 -9999 -9999   295   206
20   660  30000  9520  -430 -9999 -9999   275   185
`;

const sampleUWYOCSV = `time,longitude,latitude,pressure_hPa,geopotential height_m,temperature_C,relative humidity_%,wind direction_degree,wind speed_m/s
2024-01-01 12:02:03,-99.9695,37.7626,1013.2,79,-5.3,96,200,3.6
2024-01-01 12:05:00,-99.9680,37.7600,993.0,297,-5.5,96,205,4.1
2024-01-01 12:12:00,-99.9500,37.7400,850.0,1546,-9.3,61,270,8.2
`;

const sampleUWYOList = `<pre>
             Observation time: 12Z 01 Jan 2024
   PRES   HGHT   TEMP   DWPT   RELH   MIXR   DRCT   SPED   THTA   THTE   THTV
    hPa      m      C      C      %   g/kg    deg    m/s      K      K      K
------   -----  -----  -----  -----  -----  -----  -----  -----  -----  -----
 1013.2     79   -5.3   -6.1     96   2.59    200    3.6  268.3  275.8  268.8
  993.0    297   -5.5   -6.3     96   2.56    205    4.1  268.5  275.9  269.0
  850.0   1546   -9.3  -14.5     61   1.48    270    8.2  274.2  278.4  274.5
  700.0   3170  -16.9  -22.1     53   0.84    285   15.4  278.3  280.6  278.5
  500.0   5780  -27.6  -35.2     38   0.33    295   20.6  284.5  285.5  284.5
</pre>
<pre>
                    Station latitude: 37.7626
                   Station longitude: -99.9695
                     Station elevation: 79.0
                     Station number: 72451
</pre>`;

// Non-sonde data (should NOT match)
const sampleTLE = `ISS (ZARYA)
1 25544U 98067A   24001.50000000  .00016717  00000-0  10270-3 0  9993
2 25544  51.6412 218.4910 0005690  23.4567 336.5678 15.49556478432568`;

const sampleJSON = '{"type":"FeatureCollection","features":[]}';

// ─── canHandle Tests ─────────────────────────────────────────────────────

describe('CTrackFileSonde.canHandle', () => {
    test('returns true for IGRA2 data', () => {
        expect(CTrackFileSonde.canHandle('data.txt', sampleIGRA2)).toBe(true);
    });

    test('returns true for UWYO CSV', () => {
        expect(CTrackFileSonde.canHandle('sounding.csv', sampleUWYOCSV)).toBe(true);
    });

    test('returns true for UWYO LIST HTML', () => {
        expect(CTrackFileSonde.canHandle('sounding.html', sampleUWYOList)).toBe(true);
    });

    test('returns false for null/empty', () => {
        expect(CTrackFileSonde.canHandle('test.txt', null)).toBe(false);
        expect(CTrackFileSonde.canHandle('test.txt', '')).toBe(false);
    });

    test('returns false for object data (JSON/XML)', () => {
        expect(CTrackFileSonde.canHandle('test.json', {})).toBe(false);
        expect(CTrackFileSonde.canHandle('test.json', {kml: {}})).toBe(false);
    });

    test('returns false for TLE data', () => {
        expect(CTrackFileSonde.canHandle('tle.txt', sampleTLE)).toBe(false);
    });

    test('returns false for SRT subtitle data', () => {
        const srt = `1\n00:00:00,000 --> 00:00:01,000\nsome text\n`;
        expect(CTrackFileSonde.canHandle('video.srt', srt)).toBe(false);
    });
});

// ─── Constructor / Parsing Tests ─────────────────────────────────────────

describe('CTrackFileSonde parsing', () => {
    test('parses IGRA2 data on construction', () => {
        const tf = new CTrackFileSonde(sampleIGRA2);
        expect(tf.getFormat()).toBe('igra2');
        expect(tf.doesContainTrack()).toBe(true);
        expect(tf.getTrackCount()).toBe(1);
    });

    test('parses UWYO CSV data on construction', () => {
        const tf = new CTrackFileSonde(sampleUWYOCSV);
        expect(tf.getFormat()).toBe('uwyo-csv');
        expect(tf.doesContainTrack()).toBe(true);
    });

    test('parses UWYO LIST data on construction', () => {
        const tf = new CTrackFileSonde(sampleUWYOList);
        expect(tf.getFormat()).toBe('uwyo-list');
        expect(tf.doesContainTrack()).toBe(true);
    });

    test('isSondeTrack returns true', () => {
        const tf = new CTrackFileSonde(sampleIGRA2);
        expect(tf.isSondeTrack()).toBe(true);
    });
});

// ─── toMISB Tests ────────────────────────────────────────────────────────

describe('CTrackFileSonde.toMISB', () => {
    test('produces valid MISB array from IGRA2', () => {
        const tf = new CTrackFileSonde(sampleIGRA2);
        const misb = tf.toMISB(0);
        expect(misb).not.toBe(false);
        expect(Array.isArray(misb)).toBe(true);
        expect(misb.length).toBeGreaterThan(0);
    });

    test('MISB rows have correct timestamp', () => {
        const tf = new CTrackFileSonde(sampleIGRA2);
        const misb = tf.toMISB(0);
        for (const row of misb) {
            expect(row[MISB.UnixTimeStamp]).toBeDefined();
            expect(row[MISB.UnixTimeStamp]).not.toBeNull();
            // Should be a reasonable epoch ms value
            expect(row[MISB.UnixTimeStamp]).toBeGreaterThan(1704067200000); // 2024-01-01
        }
    });

    test('MISB rows have lat/lon/alt', () => {
        const tf = new CTrackFileSonde(sampleIGRA2);
        const misb = tf.toMISB(0);
        for (const row of misb) {
            expect(row[MISB.SensorLatitude]).not.toBeNull();
            expect(row[MISB.SensorLongitude]).not.toBeNull();
            expect(row[MISB.SensorTrueAltitude]).not.toBeNull();
            // Reasonable ranges
            expect(row[MISB.SensorLatitude]).toBeGreaterThan(-90);
            expect(row[MISB.SensorLatitude]).toBeLessThan(90);
            expect(row[MISB.SensorLongitude]).toBeGreaterThan(-180);
            expect(row[MISB.SensorLongitude]).toBeLessThan(180);
        }
    });

    test('MISB rows include atmospheric data', () => {
        const tf = new CTrackFileSonde(sampleIGRA2);
        const misb = tf.toMISB(0);
        // First row should have pressure and temperature
        const firstWithPressure = misb.find(r => r[MISB.StaticPressure] != null);
        expect(firstWithPressure).toBeDefined();
        expect(firstWithPressure[MISB.StaticPressure]).toBeGreaterThan(0);
    });

    test('altitude increases through the trajectory', () => {
        const tf = new CTrackFileSonde(sampleIGRA2);
        const misb = tf.toMISB(0);
        const alts = misb.map(r => r[MISB.SensorTrueAltitude]);
        for (let i = 1; i < alts.length; i++) {
            expect(alts[i]).toBeGreaterThanOrEqual(alts[i-1]);
        }
    });

    test('UWYO CSV MISB uses GPS positions', () => {
        const tf = new CTrackFileSonde(sampleUWYOCSV);
        const misb = tf.toMISB(0);
        // First point should be at station
        expect(misb[0][MISB.SensorLatitude]).toBeCloseTo(37.7626, 2);
        expect(misb[0][MISB.SensorLongitude]).toBeCloseTo(-99.9695, 2);
    });

    test('returns false for invalid trackIndex', () => {
        const tf = new CTrackFileSonde(sampleIGRA2);
        expect(tf.toMISB(99)).toBe(false);
    });
});

// ─── getShortName Tests ──────────────────────────────────────────────────

describe('CTrackFileSonde.getShortName', () => {
    test('generates descriptive name from IGRA2', () => {
        const tf = new CTrackFileSonde(sampleIGRA2);
        const name = tf.getShortName(0);
        expect(name).toContain('USM00072451');
        expect(name).toContain('2024-01-01');
        expect(name).toContain('12Z');
    });

    test('falls back to filename', () => {
        const tf = new CTrackFileSonde(sampleIGRA2);
        const name = tf.getShortName(99, 'my_sounding.txt');
        expect(name).toBe('my_sounding');
    });

    test('default fallback', () => {
        const tf = new CTrackFileSonde(sampleIGRA2);
        const name = tf.getShortName(99);
        expect(name).toBe('Sonde_Track');
    });
});

// ─── Multi-track Tests ───────────────────────────────────────────────────

describe('CTrackFileSonde multi-track', () => {
    const multiIGRA2 = `#USM00072451 2024  1  1  0 2345    3 ncdc-gts ncdc-gts  377626  -999695
10 -9999 101320    79   -23   960   180   190    21
20   120  85000  1546   -53 -9999 -9999   200    36
20   240  70000  3170  -120 -9999 -9999   220    51
#USM00072451 2024  1  1 12 1156    3 ncdc-gts ncdc-gts  377626  -999695
10 -9999 101320    79   -53   960   259   200    36
20   120  85000  1546   -93 -9999 -9999   270    82
20   240  70000  3170  -169 -9999 -9999   285   154
`;

    test('detects multiple tracks', () => {
        const tf = new CTrackFileSonde(multiIGRA2);
        expect(tf.getTrackCount()).toBe(2);
    });

    test('hasMoreTracks works correctly', () => {
        const tf = new CTrackFileSonde(multiIGRA2);
        expect(tf.hasMoreTracks(0)).toBe(true);
        expect(tf.hasMoreTracks(1)).toBe(false);
    });

    test('different tracks have different names', () => {
        const tf = new CTrackFileSonde(multiIGRA2);
        const name0 = tf.getShortName(0);
        const name1 = tf.getShortName(1);
        expect(name0).not.toBe(name1);
        expect(name0).toContain('00Z');
        expect(name1).toContain('12Z');
    });

    test('each track produces separate MISB data', () => {
        const tf = new CTrackFileSonde(multiIGRA2);
        const misb0 = tf.toMISB(0);
        const misb1 = tf.toMISB(1);
        expect(misb0).not.toBe(false);
        expect(misb1).not.toBe(false);
        // Different timestamps (different hours)
        expect(misb0[0][MISB.UnixTimeStamp]).not.toBe(misb1[0][MISB.UnixTimeStamp]);
    });
});

// ─── getSondeData / getTrajectory Tests ──────────────────────────────────

describe('CTrackFileSonde data access', () => {
    test('getSondeData returns parsed sounding', () => {
        const tf = new CTrackFileSonde(sampleIGRA2);
        const data = tf.getSondeData(0);
        expect(data).not.toBeNull();
        expect(data.station.id).toBe('USM00072451');
        expect(data.levels.length).toBeGreaterThan(0);
    });

    test('getTrajectory returns reconstructed positions', () => {
        const tf = new CTrackFileSonde(sampleIGRA2);
        const traj = tf.getTrajectory(0);
        expect(traj).not.toBeNull();
        expect(traj.length).toBeGreaterThan(0);
        expect(traj[0]).toHaveProperty('lat');
        expect(traj[0]).toHaveProperty('lon');
        expect(traj[0]).toHaveProperty('alt');
        expect(traj[0]).toHaveProperty('time');
    });

    test('returns null for invalid index', () => {
        const tf = new CTrackFileSonde(sampleIGRA2);
        expect(tf.getSondeData(99)).toBeNull();
        expect(tf.getTrajectory(99)).toBeNull();
    });
});

// ─── Balloon sphere integration: MISB pressure data ─────────────────────

describe('CTrackFileSonde MISB pressure for balloon scaling', () => {
    test('MISB rows contain pressure data for balloon expansion', () => {
        const tf = new CTrackFileSonde(sampleIGRA2);
        const misb = tf.toMISB(0);
        // Every IGRA2 row has pressure data which CNodeDisplayBalloonSphere uses
        const pressures = misb.map(r => r[MISB.StaticPressure]).filter(p => p != null);
        expect(pressures.length).toBeGreaterThan(0);
        // Pressure should decrease with altitude (ascending balloon)
        for (let i = 1; i < pressures.length; i++) {
            expect(pressures[i]).toBeLessThanOrEqual(pressures[i - 1]);
        }
    });

    test('MISB pressure spans surface to stratosphere range', () => {
        const tf = new CTrackFileSonde(sampleIGRA2);
        const misb = tf.toMISB(0);
        const pressures = misb.map(r => r[MISB.StaticPressure]).filter(p => p != null);
        const maxP = Math.max(...pressures);
        const minP = Math.min(...pressures);
        // Surface should be near 1013 hPa
        expect(maxP).toBeGreaterThan(900);
        // Top should be well below 100 hPa (stratosphere)
        expect(minP).toBeLessThan(400);
    });

    test('UWYO CSV MISB also contains pressure for balloon scaling', () => {
        const tf = new CTrackFileSonde(sampleUWYOCSV);
        const misb = tf.toMISB(0);
        const pressures = misb.map(r => r[MISB.StaticPressure]).filter(p => p != null);
        expect(pressures.length).toBeGreaterThan(0);
        expect(pressures[0]).toBeGreaterThan(900); // near surface
    });
});

describe("sondeRowFrame", () => {
    test("a fractional or late playback frame reads a valid whole row", () => {
        expect(sondeRowFrame(2743.4595, 3000)).toBe(2743);
        expect(sondeRowFrame(2743.4595, 2000)).toBe(1999);
        expect(sondeRowFrame(-3, 10)).toBe(0);
        expect(sondeRowFrame(NaN, 10)).toBe(0);
        expect(sondeRowFrame(5, 0)).toBe(-1);
    });
});

