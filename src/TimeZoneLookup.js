// Time zone from a position on the Earth.
//
// lookupTimeZone(lat, lon) gives the IANA zone ("Europe/Berlin") that covers a point. It uses
// the time zone map of Show Time Zones (TimeZoneMapData.js: the zones of timezone-boundary-
// builder's "1970" set, about 250 KB, loaded on first use), which has every small zone with its
// own clock: the Hopi reservation inside the Navajo Nation, Atikokan, Blanc-Sablon. Where two
// zones overlap (Xinjiang, the West Bank), and when the map does not load, the table of
// @photostructure/tz-lookup (28 KB gzipped, loaded on first use) chooses. tz-lookup alone is
// coarse near borders (its README says so): it puts the Hopi reservation in MDT in summer.
// Both come from timezone-boundary-builder, which builds them from OpenStreetMap, so the data is
// under the ODbL: credit "© OpenStreetMap contributors" (see DATA_FILES in
// scripts/generateThirdPartyNotices.js). Nothing loads at startup.
//
// A zone is not an offset. The offset is read for a given instant from the browser's
// own IANA rules (Intl), so daylight saving time and historic changes come out right:
// Europe/Berlin is UTC+1 in January and UTC+2 in July, and America/Los_Angeles is
// local mean time, UTC-7:52:58, in 1850. The browser's rules merge some zones before
// 1970 (Amsterdam takes Brussels's history), so a pre-1970 offset can differ from the
// historic local time.
//
// Everything except lookupTimeZone() is synchronous and does not touch the app graph,
// so Jest can test it directly.

import {loadTimeZoneMap, zonesAtPoint} from "./TimeZoneMapData";

let tzLookupPromise = null;

function loadTzLookup() {
    if (!tzLookupPromise) {
        tzLookupPromise = import(/* webpackChunkName: "tz-lookup" */ "@photostructure/tz-lookup")
            .then(module => (typeof module === "function" ? module : module.default))
            .catch(error => {
                tzLookupPromise = null; // let a failed chunk load try again next time
                throw error;
            });
    }
    return tzLookupPromise;
}

// The IANA zone at a latitude and longitude in degrees, or null for an invalid position. The
// map's zone; where the map has two (an overlap), the one tz-lookup gives, if it is one of them;
// tz-lookup's zone when the map has none or does not load.
export async function lookupTimeZone(latDeg, lonDeg) {
    if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg) || Math.abs(latDeg) > 90) {
        return null;
    }
    const lon = ((lonDeg + 540) % 360) - 180; // tz-lookup refuses longitudes outside -180..180
    let zones = [];
    try {
        zones = zonesAtPoint(await loadTimeZoneMap(), latDeg, lon);
    } catch (error) {
        console.warn("Time zone map did not load, so the time zone comes from tz-lookup:", error);
    }
    if (zones.length === 1) return zones[0];
    const tzlookup = await loadTzLookup();
    const zone = tzlookup(latDeg, lon);
    return zones.length === 0 || zones.includes(zone) ? zone : zones[0];
}

// "UTC+8", "UTC-9.5", "UTC+5.75": an offset in hours, in the style of the Time Zone menu.
export function formatUtcOffset(hours) {
    return `UTC${hours >= 0 ? "+" : "-"}${Number(Math.abs(hours).toFixed(2))}`;
}

// The standard offset of a zone in a year: the smaller of its mid-January and mid-July
// offsets (daylight saving time adds to the offset). null when the browser does not know it.
export function standardOffsetHoursInZone(zone, year) {
    const january = utcOffsetHoursInZone(zone, new Date(Date.UTC(year, 0, 15, 12)));
    const july = utcOffsetHoursInZone(zone, new Date(Date.UTC(year, 6, 15, 12)));
    return january === null || july === null ? null : Math.min(january, july);
}

// One formatter per zone (null for a zone the browser does not know): making an
// Intl.DateTimeFormat costs far more than using one, and Show Time Zones asks for every zone
// each time the sitch time crosses a quarter hour.
const offsetFormatters = new Map();

// The UTC offset of a zone at an instant, in hours (east positive), or null when the
// browser does not know the zone. tz-lookup can be newer than the browser's zone list.
export function utcOffsetHoursInZone(zone, date) {
    let formatter = offsetFormatters.get(zone);
    if (formatter === undefined) {
        try {
            formatter = new Intl.DateTimeFormat("en-US", {timeZone: zone, timeZoneName: "longOffset"});
        } catch {
            formatter = null;
        }
        offsetFormatters.set(zone, formatter);
    }
    if (!formatter) return null;
    let text;
    try {
        text = formatter.formatToParts(date).find(part => part.type === "timeZoneName")?.value;
    } catch {
        return null;        // an invalid date
    }
    // "GMT" (no offset), "GMT-07:00", or "GMT-07:52:58" for local mean time.
    const match = /^GMT(?:([+-])(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(text ?? "");
    if (!match) return null;
    if (!match[1]) return 0;
    const hours = Number(match[2]) + Number(match[3]) / 60 + Number(match[4] ?? 0) / 3600;
    return match[1] === "-" ? -hours : hours;
}

// The instant at which the clocks in a zone show a wall-clock time. wallAsUTCms is that
// time written as if it were UTC: Date.UTC(year, month, day, hour, minute, second, ms).
// Two passes, because the offset depends on the instant we are looking for. A time in
// the hour that daylight saving time skips comes out on one side of the gap.
export function zoneWallClockToInstant(wallAsUTCms, zone) {
    const first = utcOffsetHoursInZone(zone, new Date(wallAsUTCms));
    if (first === null) return null;
    const guess = wallAsUTCms - Math.round(first * 3600000);
    const second = utcOffsetHoursInZone(zone, new Date(guess));
    if (second === null) return null;
    return new Date(wallAsUTCms - Math.round(second * 3600000));
}

// Abbreviations for zones that the browser's English locales show only as "GMT+9".
// Only abbreviations that are in the Time Zone menu (timeZoneOffsets in
// CNodeDateTime.js) are useful here; a zone with no entry gets a "UTC+9.00" name.
const ZONE_ABBREVIATIONS = {
    "Asia/Tokyo": ["JST"],
    "Asia/Seoul": ["KST"],
    "Asia/Shanghai": ["BJT"],
    "Europe/Moscow": ["MSK"],
    "Europe/Simferopol": ["MSK"],
    "Europe/Kirov": ["MSK"],
    "Europe/Volgograd": ["MSK"],
    "Europe/Samara": ["SAMT"],
    "Asia/Yekaterinburg": ["YEKT"],
    "Asia/Omsk": ["OMST"],
    "Asia/Yangon": ["MMT"],
    "Asia/Krasnoyarsk": ["KRAT"],
    "Asia/Irkutsk": ["IRKT"],
    "Asia/Yakutsk": ["YAKT"],
    "Asia/Vladivostok": ["VLAT"],
    "Asia/Magadan": ["MAGT"],
    "Asia/Kamchatka": ["PETT"],
    "America/Santiago": ["CLT", "CLST"],
    "America/Sao_Paulo": ["BRT"],
    "America/Fortaleza": ["BRT"],
    "America/Recife": ["BRT"],
    "America/Bahia": ["BRT"],
    "America/Belem": ["BRT"],
    "America/Maceio": ["BRT"],
    "Atlantic/Stanley": ["FKST"],
    "Atlantic/Azores": ["AZOT", "AZOST"],
    "Atlantic/South_Georgia": ["GST"],
};

// English locales whose short zone names, between them, cover North America, Europe,
// India, Australia and New Zealand ("PST", "CEST", "IST", "AEDT", "NZST").
const ABBREVIATION_LOCALES = ["en-US", "en-GB", "en-IN", "en-AU", "en-NZ"];

// Every abbreviation that names a zone at an instant. The caller also matches the
// offset, so an abbreviation that means two things ("BST" is British Summer Time at
// UTC+1 and Bangladesh Standard Time at UTC+6) cannot pick the wrong entry.
export function zoneAbbreviations(zone, date) {
    const names = new Set(ZONE_ABBREVIATIONS[zone] ?? []);
    if (zone.startsWith("America/Argentina/")) names.add("ART");
    for (const locale of ABBREVIATION_LOCALES) {
        try {
            const name = new Intl.DateTimeFormat(locale, {timeZone: zone, timeZoneName: "short"})
                .formatToParts(date)
                .find(part => part.type === "timeZoneName")?.value;
            if (name) names.add(name);
        } catch {
            return names; // the browser does not know the zone
        }
    }
    return names;
}
