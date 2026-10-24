/**
 * rehost.php stores an uploaded .html/.htm as .txt, so it is never served as a page from the
 * app's origin. Sitrec itself uploads HTML: a University of Wyoming sounding is named *.html
 * (SondeFetch.js) and is rehosted when a sitch is saved. A saved sitch reloads it from the
 * returned .txt URL, and the parse must give the same sounding track it gave the .html name.
 */
jest.mock("../src/showError", () => ({...jest.requireActual("../src/showError"), showError: jest.fn()}));

import {parseMethods} from "../src/CFileManagerParse";
import {CTrackFileSonde} from "../src/TrackFiles/CTrackFileSonde";

// A stand-in file manager carrying the real parse methods.
const fileManager = () => ({...parseMethods, list: {}});

const bufferOf = text => new TextEncoder().encode(text).buffer;

const UWYO_LIST = `<HTML>
<TITLE>University of Wyoming - Radiosonde Data</TITLE>
<BODY BGCOLOR="white">
<H2>72451 DDC Dodge City Observations at 12Z 01 Jan 2024</H2>
<PRE>
-----------------------------------------------------------------------------
   PRES   HGHT   TEMP   DWPT   RELH   MIXR   DRCT   SKNT   THTA   THTE   THTV
    hPa     m      C      C      %    g/kg    deg   knot     K      K      K
-----------------------------------------------------------------------------
 1013.2     79   -5.3   -6.1     96   2.59    200      7  268.3  275.8  268.8
  993.0    297   -5.5   -6.3     96   2.56    205      8  268.5  275.9  269.0
  850.0   1546   -9.3  -14.5     61   1.48    270     16  274.2  278.4  274.5
  700.0   3170  -16.9  -22.1     53   0.84    285     30  278.3  280.6  278.5
  500.0   5780  -27.6  -35.2     38   0.33    295     40  284.5  285.5  284.5
</PRE><H3>Station information and sounding indices</H3><PRE>
                         Station number: 72451
                       Station latitude: 37.7626
                      Station longitude: -99.9695
                      Station elevation: 79.0
</PRE>
</BODY></HTML>`;

const UWYO_CSV = `<HTML><BODY><PRE>
time,longitude,latitude,pressure_hPa,geopotential height_m,temperature_C,relative humidity_%,wind direction_degree,wind speed_m/s
2024-01-01 12:02:03,-99.9695,37.7626,1013.2,79,-5.3,96,200,3.6
2024-01-01 12:05:00,-99.9680,37.7600,993.0,297,-5.5,96,205,4.1
2024-01-01 12:12:00,-99.9500,37.7400,850.0,1546,-9.3,61,270,8.2
</PRE></BODY></HTML>`;

describe.each([
    ["a UWYO list", "sounding_72451_2024-01-01_12Z", UWYO_LIST, "uwyo-list"],
    ["a UWYO GPS CSV", "sonde_GPS_72451_2024-01-01_12Z", UWYO_CSV, "uwyo-csv"],
])("%s sounding rehosted as .txt", (_label, base, page, format) => {
    test("parses to the same sounding track as the .html it was imported as", async () => {
        const imported = await fileManager().parseAsset(`${base}.html`, base, bufferOf(page));
        const reloaded = await fileManager().parseAsset(
            `https://example.test/sitrec-upload/42/${base}-0123456789abcdef0123456789abcdef.txt`, base, bufferOf(page));

        for (const result of [imported, reloaded]) {
            expect(result.dataType).toBe("trackfile");
            expect(result.parsed).toBeInstanceOf(CTrackFileSonde);
            expect(result.parsed.format).toBe(format);
        }
        expect(reloaded.parsed.soundings).toEqual(imported.parsed.soundings);
        expect(reloaded.parsed.soundings[0].levels.length).toBeGreaterThan(0);
    });
});
