import {
    detectSondeFormat,
    parseIGRA2,
    parseUWYOList,
    parseUWYOCSV,
    countIGRA2Soundings,
    listIGRA2Soundings,
} from '../src/ParseSonde';

// ─── Sample IGRA2 Data ──────────────────────────────────────────────────
// Realistic excerpt: station USM00072451 (Sterling, VA), 2024-01-01 12Z
// Fixed-width format matching IGRA2 spec exactly (51 chars per data line):
//   Col1: LVLTYP1  Col2: LVLTYP2  Col4-8: ETIME  Col10-15: PRESS
//   Col17-21: GPH  Col23-27: TEMP  Col29-33: RH  Col35-39: DPDP
//   Col41-45: WDIR  Col47-51: WSPD
// Pressure in Pa, temp in 10ths°C, wind speed in 10ths m/s, -9999=missing
const sampleIGRA2 = `#USM00072451 2024  1  1 12 1156   11 ncdc-gts ncdc-gts  377626  -999695
10 -9999 101320    79   -53   960   259   200    36
20 -9999  99300   297   -55   960   256   205    41
20   120  85000  1546   -93 -9999 -9999   270    82
20   240  70000  3170  -169 -9999 -9999   285   154
20   420  50000  5780  -276 -9999 -9999   295   206
20   660  30000  9520  -430 -9999 -9999   275   185
20   900  20000 12150  -554 -9999 -9999   260   103
20  1140  10000 16540  -650 -9999 -9999   210    52
20  1380   5000 20760  -587 -9999 -9999   180    21
20  1620   2000 26700  -512 -9999 -9999   170    15
20  1860   1000 31400  -468 -9999 -9999   150    10
`;

// Two soundings in one file
const sampleIGRA2Multi = `#USM00072451 2024  1  1  0 2345    5 ncdc-gts ncdc-gts  377626  -999695
10 -9999 101320    79   -23   960   180   190    21
20   120  85000  1546   -53 -9999 -9999   200    36
20   240  70000  3170  -120 -9999 -9999   220    51
20   360  50000  5780  -230 -9999 -9999   240    72
20   480  30000  9520  -380 -9999 -9999   260    61
#USM00072451 2024  1  1 12 1156    6 ncdc-gts ncdc-gts  377626  -999695
10 -9999 101320    79   -53   960   259   200    36
20   120  85000  1546   -93 -9999 -9999   270    82
20   240  70000  3170  -169 -9999 -9999   285   154
20   420  50000  5780  -276 -9999 -9999   295   206
20   660  30000  9520  -430 -9999 -9999   275   185
20   900  20000 12150  -554 -9999 -9999   260   103
`;

// ─── Sample UWYO TEXT:LIST Data ──────────────────────────────────────────
const sampleUWYOList = `<html>
<head><title>University of Wyoming - Radiosonde Data</title></head>
<body>
<h2>72451 IAD Sterling, VA</h2>
<pre>
                         Station number: 72451
             Observation time: 12Z 01 Jan 2024

   PRES   HGHT   TEMP   DWPT   RELH   MIXR   DRCT   SPED   THTA   THTE   THTV
    hPa      m      C      C      %   g/kg    deg    m/s      K      K      K
------   -----  -----  -----  -----  -----  -----  -----  -----  -----  -----
 1013.2     79   -5.3   -6.1     96   2.59    200    3.6  268.3  275.8  268.8
  993.0    297   -5.5   -6.3     96   2.56    205    4.1  268.5  275.9  269.0
  850.0   1546   -9.3  -14.5     61   1.48    270    8.2  274.2  278.4  274.5
  700.0   3170  -16.9  -22.1     53   0.84    285   15.4  278.3  280.6  278.5
  500.0   5780  -27.6  -35.2     38   0.33    295   20.6  284.5  285.5  284.5
  300.0   9520  -43.0  -52.8     20   0.05    275   18.5  295.2  295.4  295.2
  200.0  12150  -55.4  -63.1     20   0.02    260   10.3  304.0  304.0  304.0
  100.0  16540  -65.0  -73.0     17   0.00    210    5.2  325.1  325.1  325.1
   50.0  20760  -58.7  -66.0     20   0.01    180    2.1  348.9  349.0  348.9
   20.0  26700  -51.2  -59.0     18   0.01    170    1.5  393.7  393.8  393.7
   10.0  31400  -46.8  -55.0     16   0.01    150    1.0  435.3  435.4  435.3
</pre>
<pre>
                    Station latitude: 37.7626
                   Station longitude: -99.9695
                     Station elevation: 79.0
</pre>
</body></html>`;

// Plain text version (no HTML wrapper)
const sampleUWYOListPlain = `
                         Station number: 72451
             Observation time: 12Z 01 Jan 2024

   PRES   HGHT   TEMP   DWPT   RELH   MIXR   DRCT   SPED   THTA   THTE   THTV
    hPa      m      C      C      %   g/kg    deg    m/s      K      K      K
------   -----  -----  -----  -----  -----  -----  -----  -----  -----  -----
 1013.2     79   -5.3   -6.1     96   2.59    200    3.6  268.3  275.8  268.8
  993.0    297   -5.5   -6.3     96   2.56    205    4.1  268.5  275.9  269.0
  850.0   1546   -9.3  -14.5     61   1.48    270    8.2  274.2  278.4  274.5

                    Station latitude: 37.7626
                   Station longitude: -99.9695
                     Station elevation: 79.0
`;

// UWYO with SKNT (knots) instead of SPED (m/s)
const sampleUWYOListKnots = `<pre>
             Observation time: 12Z 01 Jan 2024
   PRES   HGHT   TEMP   DWPT   RELH   MIXR   DRCT   SKNT   THTA   THTE   THTV
    hPa      m      C      C      %   g/kg    deg    kts      K      K      K
------   -----  -----  -----  -----  -----  -----  -----  -----  -----  -----
 1013.2     79   -5.3   -6.1     96   2.59    200      7  268.3  275.8  268.8
  850.0   1546   -9.3  -14.5     61   1.48    270     16  274.2  278.4  274.5
</pre>
<pre>
                    Station latitude: 37.7626
                   Station longitude: -99.9695
                     Station elevation: 79.0
                    Station number: 72451
</pre>`;

// ─── Sample UWYO TEXT:CSV Data ──────────────────────────────────────────
const sampleUWYOCSV = `<html><head><title>Sounding data</title></head><body><pre>
time,longitude,latitude,pressure_hPa,geopotential height_m,temperature_C,relative humidity_%,wind direction_degree,wind speed_m/s
2024-01-01 12:02:03,-99.9695,37.7626,1013.2,79,-5.3,96,200,3.6
2024-01-01 12:02:04,-99.9694,37.7625,1012.0,80,-5.2,95,201,3.7
2024-01-01 12:05:00,-99.9680,37.7600,993.0,297,-5.5,96,205,4.1
2024-01-01 12:12:00,-99.9500,37.7400,850.0,1546,-9.3,61,270,8.2
2024-01-01 12:22:00,-99.9200,37.7100,700.0,3170,-16.9,53,285,15.4
2024-01-01 12:35:00,-99.8800,37.6700,500.0,5780,-27.6,38,295,20.6
2024-01-01 12:52:00,-99.8300,37.6200,300.0,9520,-43.0,20,275,18.5
2024-01-01 13:05:00,-99.8000,37.5900,200.0,12150,-55.4,20,260,10.3
</pre></body></html>`;

// Bare CSV (no HTML)
const sampleUWYOCSVPlain = `time,longitude,latitude,pressure_hPa,geopotential height_m,temperature_C,relative humidity_%,wind direction_degree,wind speed_m/s
2024-01-01 12:02:03,-99.9695,37.7626,1013.2,79,-5.3,96,200,3.6
2024-01-01 12:05:00,-99.9680,37.7600,993.0,297,-5.5,96,205,4.1
2024-01-01 12:12:00,-99.9500,37.7400,850.0,1546,-9.3,61,270,8.2
`;

// ─── Format Detection Tests ─────────────────────────────────────────────

describe('detectSondeFormat', () => {
    test('detects IGRA2 format', () => {
        expect(detectSondeFormat(sampleIGRA2)).toBe('igra2');
    });

    test('detects UWYO LIST format (HTML)', () => {
        expect(detectSondeFormat(sampleUWYOList)).toBe('uwyo-list');
    });

    test('detects UWYO LIST format (plain text)', () => {
        expect(detectSondeFormat(sampleUWYOListPlain)).toBe('uwyo-list');
    });

    test('detects UWYO CSV format (HTML)', () => {
        expect(detectSondeFormat(sampleUWYOCSV)).toBe('uwyo-csv');
    });

    test('detects UWYO CSV format (plain)', () => {
        expect(detectSondeFormat(sampleUWYOCSVPlain)).toBe('uwyo-csv');
    });

    test('returns null for empty/invalid input', () => {
        expect(detectSondeFormat(null)).toBeNull();
        expect(detectSondeFormat('')).toBeNull();
        expect(detectSondeFormat(42)).toBeNull();
        expect(detectSondeFormat('just some random text')).toBeNull();
    });

    test('returns null for TLE data (must not false-positive)', () => {
        const tle = `ISS (ZARYA)
1 25544U 98067A   24001.50000000  .00016717  00000-0  10270-3 0  9993
2 25544  51.6412 218.4910 0005690  23.4567 336.5678 15.49556478432568`;
        expect(detectSondeFormat(tle)).toBeNull();
    });

    test('returns null for SRT data', () => {
        const srt = `1\n00:00:00,000 --> 00:00:01,000\nsome subtitle text`;
        expect(detectSondeFormat(srt)).toBeNull();
    });
});

// ─── IGRA2 Parser Tests ─────────────────────────────────────────────────

describe('parseIGRA2', () => {
    test('parses header correctly', () => {
        const result = parseIGRA2(sampleIGRA2);
        expect(result).not.toBeNull();
        expect(result.station.id).toBe('USM00072451');
        expect(result.station.lat).toBeCloseTo(37.7626, 3);
        expect(result.station.lon).toBeCloseTo(-99.9695, 3);
        expect(result.source).toBe('igra2');
        expect(result.hasGPS).toBe(false);
    });

    test('parses datetime correctly', () => {
        const result = parseIGRA2(sampleIGRA2);
        expect(result.datetime.getUTCFullYear()).toBe(2024);
        expect(result.datetime.getUTCMonth()).toBe(0); // January
        expect(result.datetime.getUTCDate()).toBe(1);
        expect(result.datetime.getUTCHours()).toBe(12);
    });

    test('parses data levels', () => {
        const result = parseIGRA2(sampleIGRA2);
        expect(result.levels.length).toBe(11);
    });

    test('converts pressure from Pa to hPa', () => {
        const result = parseIGRA2(sampleIGRA2);
        // First level: 101320 Pa → 1013.20 hPa
        expect(result.levels[0].pressure).toBeCloseTo(1013.20, 1);
        // Level with 85000: 85000 Pa → 850.0 hPa
        expect(result.levels[2].pressure).toBeCloseTo(850.0, 1);
    });

    test('converts temperature from 10ths to degrees', () => {
        const result = parseIGRA2(sampleIGRA2);
        // First level: -53 → -5.3°C
        expect(result.levels[0].temp).toBeCloseTo(-5.3, 1);
        // Level 4: -276 → -27.6°C
        expect(result.levels[4].temp).toBeCloseTo(-27.6, 1);
    });

    test('converts wind speed from 10ths to m/s', () => {
        const result = parseIGRA2(sampleIGRA2);
        // First level: 36 → 3.6 m/s
        expect(result.levels[0].windSpeed).toBeCloseTo(3.6, 1);
        // Level 3: 154 → 15.4 m/s
        expect(result.levels[3].windSpeed).toBeCloseTo(15.4, 1);
    });

    test('parses wind direction', () => {
        const result = parseIGRA2(sampleIGRA2);
        expect(result.levels[0].windDir).toBe(200);
        expect(result.levels[2].windDir).toBe(270);
    });

    test('handles missing values (-9999)', () => {
        const result = parseIGRA2(sampleIGRA2);
        // Levels 2+ have missing RH (-9999)
        expect(result.levels[2].rh).toBeNull();
        expect(result.levels[2].dewpoint).toBeNull();
    });

    test('parses elapsed time MMMSS → seconds', () => {
        const result = parseIGRA2(sampleIGRA2);
        // First data level has ETIME -9999 → null
        expect(result.levels[0].time_s).toBeNull();
        // Level with ETIME 120 → 1 min 20 sec = 80 sec
        expect(result.levels[2].time_s).toBe(80);
        // Level with ETIME 240 → 2 min 40 sec = 160 sec
        expect(result.levels[3].time_s).toBe(160);
        // Level with ETIME 420 → 4 min 20 sec = 260 sec
        expect(result.levels[4].time_s).toBe(260);
    });

    test('handles geopotential height', () => {
        const result = parseIGRA2(sampleIGRA2);
        expect(result.levels[0].height).toBe(79);
        expect(result.levels[2].height).toBe(1546);
        expect(result.levels[10].height).toBe(31400);
    });

    test('returns null for invalid sounding index', () => {
        expect(parseIGRA2(sampleIGRA2, 5)).toBeNull();
    });

    test('returns null for empty text', () => {
        expect(parseIGRA2('')).toBeNull();
    });
});

describe('IGRA2 multi-sounding', () => {
    test('counts soundings', () => {
        expect(countIGRA2Soundings(sampleIGRA2Multi)).toBe(2);
        expect(countIGRA2Soundings(sampleIGRA2)).toBe(1);
    });

    test('lists soundings', () => {
        const list = listIGRA2Soundings(sampleIGRA2Multi);
        expect(list.length).toBe(2);
        expect(list[0].date).toBe('2024-01-01');
        expect(list[0].hour).toBe(0);
        expect(list[0].numLevels).toBe(5);
        expect(list[1].hour).toBe(12);
        expect(list[1].numLevels).toBe(6);
    });

    test('parses specific sounding by index', () => {
        const first = parseIGRA2(sampleIGRA2Multi, 0);
        const second = parseIGRA2(sampleIGRA2Multi, 1);
        expect(first.datetime.getUTCHours()).toBe(0);
        expect(first.levels.length).toBe(5);
        expect(second.datetime.getUTCHours()).toBe(12);
        expect(second.levels.length).toBe(6);
    });
});

// ─── UWYO LIST Parser Tests ─────────────────────────────────────────────

describe('parseUWYOList', () => {
    test('parses HTML-wrapped data', () => {
        const result = parseUWYOList(sampleUWYOList);
        expect(result).not.toBeNull();
        expect(result.source).toBe('uwyo-list');
        expect(result.hasGPS).toBe(false);
    });

    test('parses station metadata', () => {
        const result = parseUWYOList(sampleUWYOList);
        expect(result.station.lat).toBeCloseTo(37.7626, 3);
        expect(result.station.lon).toBeCloseTo(-99.9695, 3);
        expect(result.station.elev).toBeCloseTo(79.0, 0);
        expect(result.station.id).toBe('72451');
    });

    test('parses observation time', () => {
        const result = parseUWYOList(sampleUWYOList);
        expect(result.datetime.getUTCFullYear()).toBe(2024);
        expect(result.datetime.getUTCMonth()).toBe(0);
        expect(result.datetime.getUTCDate()).toBe(1);
        expect(result.datetime.getUTCHours()).toBe(12);
    });

    test('parses data levels', () => {
        const result = parseUWYOList(sampleUWYOList);
        expect(result.levels.length).toBe(11);
    });

    test('parses pressure and height', () => {
        const result = parseUWYOList(sampleUWYOList);
        expect(result.levels[0].pressure).toBeCloseTo(1013.2, 1);
        expect(result.levels[0].height).toBe(79);
        expect(result.levels[4].pressure).toBeCloseTo(500.0, 1);
        expect(result.levels[4].height).toBe(5780);
    });

    test('parses temperature and dewpoint', () => {
        const result = parseUWYOList(sampleUWYOList);
        expect(result.levels[0].temp).toBeCloseTo(-5.3, 1);
        expect(result.levels[0].dewpoint).toBeCloseTo(-6.1, 1);
    });

    test('parses wind direction and speed (SPED)', () => {
        const result = parseUWYOList(sampleUWYOList);
        expect(result.levels[0].windDir).toBe(200);
        expect(result.levels[0].windSpeed).toBeCloseTo(3.6, 1);
    });

    test('handles SKNT (knots) wind speed column', () => {
        const result = parseUWYOList(sampleUWYOListKnots);
        expect(result).not.toBeNull();
        // 7 knots → ~3.6 m/s
        expect(result.levels[0].windSpeed).toBeCloseTo(7 * 0.514444, 1);
        // 16 knots → ~8.2 m/s
        expect(result.levels[1].windSpeed).toBeCloseTo(16 * 0.514444, 1);
    });

    // UWYO removed the legacy cgi-bin endpoint (July 2026); the WSGI page has
    // a different header block: H1 "Observations for Station NNN at HH UTC",
    // H3 station name, and an <I>Latitude: .. Longitude: ..</I> line — no
    // "Station latitude:" footer. Mis-parsing these put the station at (0,0)
    // with the observation time defaulting to "now".
    test('parses the WSGI page header (station, coords, name, time)', () => {
        const wsgi = `<!DOCTYPE html>
<HTML><BODY>
<H1>Observations for Station 72293 at 12 UTC 15 Jul 2026</H1>
<H3>SAN DIEGO/MIRAMAR,  NAS, CA., USA</H3>
<BR/><I>Latitude: 32.845 Longitude: -117.124</I>
<PRE>
-----------------------------------------------------------------------------
   PRES   HGHT   TEMP   DWPT   RELH   MIXR   DRCT   SPED   THTA   THTE   THTV
    hPa      m      C      C      %   g/kg    deg    m/s      K      K      K
-----------------------------------------------------------------------------
 1013.0    140   22.4   14.4     60   10.3    290    2.1  294.4  324.3  296.2
  850.0   1580   15.2    8.2     63    8.6    250    5.7  301.9  327.7  303.5
  500.0   5880  -10.1  -22.1     37    1.4    162    6.8  318.4  323.4  318.7
</PRE>
</BODY></HTML>`;
        const result = parseUWYOList(wsgi);
        expect(result).not.toBeNull();
        expect(result.station.id).toBe('72293');
        expect(result.station.lat).toBeCloseTo(32.845, 3);
        expect(result.station.lon).toBeCloseTo(-117.124, 3);
        expect(result.station.name).toBe('SAN DIEGO/MIRAMAR, NAS, CA., USA');
        expect(result.datetime.getUTCFullYear()).toBe(2026);
        expect(result.datetime.getUTCMonth()).toBe(6);
        expect(result.datetime.getUTCDate()).toBe(15);
        expect(result.datetime.getUTCHours()).toBe(12);
        expect(result.levels.length).toBe(3);
        expect(result.levels[2].windDir).toBe(162);
        expect(result.levels[2].windSpeed).toBeCloseTo(6.8, 1);
    });

    test('parses plain text (no HTML)', () => {
        const result = parseUWYOList(sampleUWYOListPlain);
        expect(result).not.toBeNull();
        expect(result.levels.length).toBe(3);
        expect(result.station.lat).toBeCloseTo(37.7626, 3);
    });

    test('has no elapsed time data', () => {
        const result = parseUWYOList(sampleUWYOList);
        for (const level of result.levels) {
            expect(level.time_s).toBeNull();
        }
    });

    test('returns null for non-sounding HTML', () => {
        expect(parseUWYOList('<html><body>Hello world</body></html>')).toBeNull();
    });
});

// ─── UWYO CSV Parser Tests ──────────────────────────────────────────────

describe('parseUWYOCSV', () => {
    test('parses HTML-wrapped CSV', () => {
        const result = parseUWYOCSV(sampleUWYOCSV);
        expect(result).not.toBeNull();
        expect(result.source).toBe('uwyo-csv');
        expect(result.hasGPS).toBe(true);
    });

    test('parses GPS positions per level', () => {
        const result = parseUWYOCSV(sampleUWYOCSV);
        expect(result.levels[0].lat).toBeCloseTo(37.7626, 3);
        expect(result.levels[0].lon).toBeCloseTo(-99.9695, 3);
        // Later point has different position
        expect(result.levels[3].lat).toBeCloseTo(37.7400, 3);
        expect(result.levels[3].lon).toBeCloseTo(-99.9500, 3);
    });

    test('computes elapsed time from timestamps', () => {
        const result = parseUWYOCSV(sampleUWYOCSV);
        expect(result.levels[0].time_s).toBe(0); // First point
        expect(result.levels[1].time_s).toBe(1); // 1 second later
    });

    test('parses atmospheric data', () => {
        const result = parseUWYOCSV(sampleUWYOCSV);
        expect(result.levels[0].pressure).toBeCloseTo(1013.2, 1);
        expect(result.levels[0].height).toBe(79);
        expect(result.levels[0].temp).toBeCloseTo(-5.3, 1);
        expect(result.levels[0].windDir).toBe(200);
        expect(result.levels[0].windSpeed).toBeCloseTo(3.6, 1);
    });

    test('parses station from first data point', () => {
        const result = parseUWYOCSV(sampleUWYOCSV);
        expect(result.station.lat).toBeCloseTo(37.7626, 3);
        expect(result.station.lon).toBeCloseTo(-99.9695, 3);
    });

    test('parses correct number of levels', () => {
        const result = parseUWYOCSV(sampleUWYOCSV);
        expect(result.levels.length).toBe(8);
    });

    test('parses plain CSV (no HTML)', () => {
        const result = parseUWYOCSV(sampleUWYOCSVPlain);
        expect(result).not.toBeNull();
        expect(result.levels.length).toBe(3);
        expect(result.hasGPS).toBe(true);
    });

    test('returns null for invalid CSV', () => {
        expect(parseUWYOCSV('not,valid,csv')).toBeNull();
    });

    test('returns null for empty input', () => {
        expect(parseUWYOCSV('')).toBeNull();
    });
});
