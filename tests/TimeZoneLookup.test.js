// Time zone from a position: the IANA zone at a lat/lon (the time zone map, with tz-lookup
// for overlaps and as the fallback), its offset on a date (Intl), the Time Zone menu entry
// that names it, and the EXIF capture time read in that zone.
jest.mock("../src/nodes/CNodeViewUI", () => ({forceUpdateUIText: () => {}}));
jest.mock("../src/JetGUI", () => ({updateGUIFrames: () => {}}));
jest.mock("../src/nodes/CNodeFrameSlider", () => ({updateFrameSlider: () => {}}));
jest.mock("../src/showTimingAnalysis", () => ({showTimingAnalysis: () => {}}));
// CNodeDateTime -> TimeZoneBorders -> the overlay that draws its labels, which extends the mocked CNodeViewUI.
jest.mock("../src/nodes/CNodeDisplaySkyOverlay", () => ({registerLabel3D: () => {}, unregisterLabel3D: () => {}}));
// The map file is fetched in the browser; here it is read from the repository.
jest.mock("../src/TimeZoneMapData", () => {
    const actual = jest.requireActual("../src/TimeZoneMapData");
    const fs = require("fs"), path = require("path"), zlib = require("zlib");
    let decoded = null;
    return {
        ...actual,
        loadTimeZoneMap: jest.fn(async () => {
            decoded ??= actual.decodeTimeZoneBorders(new Uint8Array(zlib.gunzipSync(
                fs.readFileSync(path.resolve(__dirname, "../data/timezones/timezone-borders.bin.gz")))));
            return decoded;
        }),
    };
});

import {lookupTimeZone, utcOffsetHoursInZone, zoneAbbreviations, zoneWallClockToInstant} from "../src/TimeZoneLookup";
import {loadTimeZoneMap} from "../src/TimeZoneMapData";
import {applyExifTimeZone} from "../src/exifCaptureTime";
import {
    CNodeDateTime, genericTimeZoneName, offsetFromTimeZoneName, timeZoneKeyForZone,
} from "../src/nodes/CNodeDateTime";
import {setSit} from "../src/Globals";

const JANUARY = new Date("2024-01-15T12:00:00Z");
const JULY = new Date("2024-07-15T12:00:00Z");

test("lookupTimeZone gives the IANA zone at a position", async () => {
    const places = [
        [52.52, 13.40, "Europe/Berlin"],
        [35.68, 139.69, "Asia/Tokyo"],
        [-33.87, 151.21, "Australia/Sydney"],
        [34.05, -118.24, "America/Los_Angeles"],
        [33.45, -112.07, "America/Phoenix"],
        [27.70, 85.30, "Asia/Kathmandu"],
        [47.56, -52.71, "America/St_Johns"],
    ];
    for (const [lat, lon, zone] of places) {
        expect([lat, lon, await lookupTimeZone(lat, lon)]).toEqual([lat, lon, zone]);
    }
    // A longitude outside -180..180 is wrapped, not refused.
    expect(await lookupTimeZone(52.52, 13.40 + 360)).toBe("Europe/Berlin");
    expect(await lookupTimeZone(52.52, 13.40 - 360)).toBe("Europe/Berlin");
});

test("lookupTimeZone gets small areas with their own clock right (tz-lookup alone did not)", async () => {
    const places = [
        [35.875, -110.620, "America/Phoenix"],      // Hopi, inside the Navajo Nation: no DST
        [36.135, -111.240, "America/Denver"],       // Navajo Nation: DST
        [48.757, -91.621, "America/Panama"],        // Atikokan: EST all year
        [51.427, -57.131, "America/Puerto_Rico"],   // Blanc-Sablon: AST all year
        [76.767, -18.667, "America/Danmarkshavn"],  // UTC all year
    ];
    for (const [lat, lon, zone] of places) {
        expect([lat, lon, await lookupTimeZone(lat, lon)]).toEqual([lat, lon, zone]);
    }
});

test("where two zones overlap, tz-lookup chooses between them", async () => {
    expect(await lookupTimeZone(43.825, 87.617)).toBe("Asia/Urumqi");     // Shanghai and Urumqi overlap
});

test("when the map does not load, the zone comes from tz-lookup", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    loadTimeZoneMap.mockRejectedValueOnce(new Error("offline"));
    expect(await lookupTimeZone(52.52, 13.40)).toBe("Europe/Berlin");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
});

test("lookupTimeZone gives null for an invalid position", async () => {
    expect(await lookupTimeZone(91, 0)).toBeNull();
    expect(await lookupTimeZone(NaN, 0)).toBeNull();
    expect(await lookupTimeZone(undefined, undefined)).toBeNull();
});

test("the offset is the one on the date, with daylight saving time and history", () => {
    expect(utcOffsetHoursInZone("Europe/Berlin", JANUARY)).toBe(1);
    expect(utcOffsetHoursInZone("Europe/Berlin", JULY)).toBe(2);
    expect(utcOffsetHoursInZone("America/Phoenix", JULY)).toBe(-7);
    expect(utcOffsetHoursInZone("Asia/Kathmandu", JULY)).toBe(5.75);
    expect(utcOffsetHoursInZone("America/St_Johns", JANUARY)).toBe(-3.5);
    expect(utcOffsetHoursInZone("Etc/GMT", JULY)).toBe(0);
    // Local mean time before standard zones: UTC-7:52:58.
    expect(utcOffsetHoursInZone("America/Los_Angeles", new Date("1850-06-01T12:00:00Z")))
        .toBeCloseTo(-(7 + 52 / 60 + 58 / 3600), 10);
    // US daylight saving time began on 31 March 1918.
    expect(utcOffsetHoursInZone("America/Chicago", new Date("1918-04-15T12:00:00Z"))).toBe(-5);
    expect(utcOffsetHoursInZone("America/Chicago", new Date("1917-04-15T12:00:00Z"))).toBe(-6);
});

test("a zone the browser does not know gives null, not an exception", () => {
    expect(utcOffsetHoursInZone("Mars/Olympus_Mons", JULY)).toBeNull();
    expect(zoneWallClockToInstant(Date.UTC(2024, 6, 15, 12), "Mars/Olympus_Mons")).toBeNull();
});

test("a wall-clock time in a zone becomes the right instant, across daylight saving changes", () => {
    const berlin = (y, mo, d, h, mi) => zoneWallClockToInstant(Date.UTC(y, mo - 1, d, h, mi), "Europe/Berlin").toISOString();
    expect(berlin(2024, 7, 15, 14, 0)).toBe("2024-07-15T12:00:00.000Z");
    expect(berlin(2024, 1, 15, 14, 0)).toBe("2024-01-15T13:00:00.000Z");
    // Either side of the spring change at 02:00 CET (01:00Z).
    expect(berlin(2024, 3, 31, 1, 30)).toBe("2024-03-31T00:30:00.000Z");
    expect(berlin(2024, 3, 31, 3, 30)).toBe("2024-03-31T01:30:00.000Z");
    // 02:30 does not exist that day; it comes out on one side of the gap.
    expect(["2024-03-31T00:30:00.000Z", "2024-03-31T01:30:00.000Z"]).toContain(berlin(2024, 3, 31, 2, 30));
    // 02:30 happens twice in the autumn; either is a correct reading.
    expect(["2024-10-27T00:30:00.000Z", "2024-10-27T01:30:00.000Z"]).toContain(berlin(2024, 10, 27, 2, 30));
});

test("the Time Zone menu entry matches the zone's abbreviation, not only its offset", () => {
    const key = (zone, date) => timeZoneKeyForZone(zone, date, utcOffsetHoursInZone(zone, date));
    expect(key("America/Los_Angeles", JANUARY)).toBe("PST UTC-8");
    expect(key("America/Los_Angeles", JULY)).toBe("PDT UTC-7");
    expect(key("America/Phoenix", JULY)).toBe("MST UTC-7");
    expect(key("America/Mexico_City", JULY)).toBe("CST UTC-6");
    expect(key("Europe/London", JANUARY)).toBe("GMT UTC+0");
    expect(key("Europe/London", JULY)).toBe("BST UTC+1");
    expect(key("Europe/Berlin", JULY)).toBe("CEST UTC+2");
    expect(key("Europe/Helsinki", JANUARY)).toBe("EET UTC+2");
    expect(key("Europe/Moscow", JULY)).toBe("MSK UTC+3");
    expect(key("Asia/Kolkata", JULY)).toBe("IST UTC+5.5");
    expect(key("Asia/Shanghai", JULY)).toBe("BJT UTC+8");
    expect(key("Asia/Tokyo", JULY)).toBe("JST UTC+9");
    expect(key("Asia/Seoul", JULY)).toBe("KST UTC+9");
    expect(key("Australia/Sydney", JULY)).toBe("AEST UTC+10");
    expect(key("Australia/Sydney", JANUARY)).toBe("AEDT UTC+11");
    expect(key("Pacific/Auckland", JANUARY)).toBe("NZDT UTC+13");
    expect(key("America/Santiago", JULY)).toBe("CLT UTC-4");
    expect(key("America/Santiago", JANUARY)).toBe("CLST UTC-3");
    expect(key("America/Argentina/Buenos_Aires", JULY)).toBe("ART UTC-3");
    expect(key("America/Sao_Paulo", JULY)).toBe("BRT UTC-3");
    // No entry has both the abbreviation and the offset: the caller uses "UTC+1.00".
    expect(key("Africa/Lagos", JULY)).toBeUndefined();
    expect(key("Asia/Hong_Kong", JULY)).toBeUndefined();
    // Some locales call Bangladesh Standard Time (UTC+6) "BST"; it must not become British Summer Time.
    expect(key("Asia/Dhaka", JULY)).toBeUndefined();
    expect(zoneAbbreviations("Asia/Tokyo", JULY).has("JST")).toBe(true);
});

test("a generic zone name gives back its offset", () => {
    for (const offset of [8, -3.5, 5.75, 0, -10]) {
        expect(offsetFromTimeZoneName(genericTimeZoneName(offset))).toBe(offset);
    }
    expect(genericTimeZoneName(-3.5)).toBe("UTC-3.50");
    expect(offsetFromTimeZoneName("JST UTC+9")).toBe(9);
    expect(offsetFromTimeZoneName("???")).toBeUndefined();
    expect(offsetFromTimeZoneName(undefined)).toBeUndefined();
});

function makeNode(dateStart) {
    const node = Object.create(CNodeDateTime.prototype);
    node.dateStart = dateStart;
    node.simpleSerials = [];
    node.establishDateTimeDefaults = () => {};
    node.getStartTimeString = () => dateStart.toISOString();
    node.populateStartTimeFromUTCString = () => {};
    node.populate = () => {};
    node.update = () => {};
    return node;
}

test("setTimeZoneFromZone sets the name and the offset for the sitch start date", () => {
    const winter = makeNode(JANUARY);
    expect(winter.setTimeZoneFromZone("Australia/Sydney")).toBe("AEDT UTC+11");
    expect(winter.getTimeZoneOffset()).toBe(11);

    const summer = makeNode(JULY);
    expect(summer.setTimeZoneFromZone("Australia/Sydney")).toBe("AEST UTC+10");
    expect(summer.getTimeZoneOffset()).toBe(10);

    const hongKong = makeNode(JULY);
    expect(hongKong.setTimeZoneFromZone("Asia/Hong_Kong")).toBe("UTC+8.00");
    expect(hongKong.getTimeZoneOffset()).toBe(8);

    const unknown = makeNode(JULY);
    unknown.timeZoneName = "PST UTC-8";
    jest.spyOn(console, "warn").mockImplementation(() => {});
    expect(unknown.setTimeZoneFromZone("Mars/Olympus_Mons")).toBeNull();
    expect(unknown.timeZoneName).toBe("PST UTC-8");
    console.warn.mockRestore();
});

test("setTimeZoneFromLocation looks the zone up and applies it", async () => {
    const node = makeNode(JULY);
    expect(await node.setTimeZoneFromLocation(35.68, 139.69)).toBe("Asia/Tokyo");
    expect(node.getTimeZoneName()).toBe("JST UTC+9");
    expect(await node.setTimeZoneFromLocation(NaN, NaN)).toBeNull();
    expect(node.getTimeZoneName()).toBe("JST UTC+9");
});

test("a zone set while a lookup runs wins over the lookup", async () => {
    // Set by an offset (as by a date with an offset, or the AI assistant).
    const byOffset = makeNode(JULY);
    const pending = byOffset.setTimeZoneFromLocation(35.68, 139.69);
    byOffset.setTimeZoneNameFromOffset(-5);
    expect(await pending).toBeNull();
    expect(byOffset.getTimeZoneName()).toBe("CDT UTC-5");

    // Set by a saved sitch.
    setSit({simSpeed: 1});
    const bySave = makeNode(JULY);
    const pendingSave = bySave.setTimeZoneFromLocation(35.68, 139.69);
    bySave.modDeserialize({startDateTime: JULY.toISOString(), timeZoneName: "GMT UTC+0", simSpeed: 1});
    expect(await pendingSave).toBeNull();
    expect(bySave.getTimeZoneName()).toBe("GMT UTC+0");

    // The newer of two lookups wins, whichever ends last.
    const twoLookups = makeNode(JULY);
    const tokyo = twoLookups.setTimeZoneFromLocation(35.68, 139.69);
    const berlin = twoLookups.setTimeZoneFromLocation(52.52, 13.40);
    expect(await berlin).toBe("Europe/Berlin");
    expect(await tokyo).toBeNull();
    expect(twoLookups.getTimeZoneName()).toBe("CEST UTC+2");

    // A ticket taken by hand follows the same rule.
    const manual = makeNode(JULY);
    const ticket = manual.startTimeZoneLookup();
    expect(manual.isTimeZoneLookupCurrent(ticket)).toBe(true);
    manual.setTimeZoneFromZone("Asia/Tokyo");
    expect(manual.isTimeZoneLookupCurrent(ticket)).toBe(false);
});

test("a saved generic zone name loads with its offset", () => {
    setSit({simSpeed: 1});
    const saved = makeNode(JULY);
    saved.setTimeZoneFromZone("America/St_Johns");
    expect(saved.getTimeZoneName()).toBe("UTC-2.50");
    const json = JSON.parse(JSON.stringify(saved.modSerialize()));

    const loaded = makeNode(JULY);
    loaded.timeZoneOffset = -7; // what the constructor took from the browser
    loaded.modDeserialize(json);
    expect(loaded.getTimeZoneName()).toBe("UTC-2.50");
    expect(loaded.getTimeZoneOffset()).toBe(-2.5);
});

test("an EXIF time with no offset is read in the zone of the GPS position", () => {
    // exifr builds the Date from the wall-clock numbers in THIS machine's zone.
    const naive = new Date(2024, 6, 15, 14, 0, 0);
    expect(applyExifTimeZone(naive, "Europe/Berlin").toISOString()).toBe("2024-07-15T12:00:00.000Z");
    expect(applyExifTimeZone(naive, "America/Los_Angeles").toISOString()).toBe("2024-07-15T21:00:00.000Z");
    expect(applyExifTimeZone(new Date(2024, 0, 15, 14, 0, 0), "Asia/Kathmandu").toISOString())
        .toBe("2024-01-15T08:15:00.000Z");
    expect(applyExifTimeZone(new Date(NaN), "Europe/Berlin")).toBeNull();
    expect(applyExifTimeZone("2024:07:15 14:00:00", "Europe/Berlin")).toBeNull();
});
