// When was the photograph actually taken?
//
// EXIF DateTimeOriginal ("2026:04:01 19:49:28") carries no timezone, so exifr
// builds a Date by reading those numbers as local wall-clock on whatever machine
// happens to be running. Sitrec then used that Date as the simulation time —
// which is right only when the photograph was taken in the same timezone as the
// computer looking at it. A Berlin moonrise opened on a US Pacific machine came
// out NINE HOURS late, putting the Moon on the other side of the sky.
//
// EXIF does record the zone, in OffsetTimeOriginal ("+02:00"), whenever the
// camera writes it — modern phones do. That makes the instant unambiguous, and
// this module is what recovers it.
//
// The recovery works because exifr's misreading is exactly invertible: it took
// the wall-clock numbers as local, so the LOCAL getters hand those same numbers
// straight back, whatever the machine timezone. Reinterpreting them at the
// offset EXIF actually recorded gives the true instant.
//
// With no OffsetTime but a GPS position, the zone of that position is the next
// best guess (applyExifTimeZone): a camera clock is normally set to local time.
//
// Free of the app graph so it can be unit-tested (EXIFUtils pulls in threeExt,
// which Jest cannot load). TimeZoneLookup.js imports nothing from the app.

import {zoneWallClockToInstant} from "./TimeZoneLookup";

// The EXIF wall-clock numbers of a naive capture Date, written as if they were UTC.
// Local getters return the original EXIF numbers by construction (see above).
function wallClockAsUTC(naiveDate) {
    return Date.UTC(
        naiveDate.getFullYear(), naiveDate.getMonth(), naiveDate.getDate(),
        naiveDate.getHours(), naiveDate.getMinutes(), naiveDate.getSeconds(),
        naiveDate.getMilliseconds(),
    );
}

// "+02:00", "-07:00", "+0200", "Z" -> minutes east of UTC. null when absent or
// unparseable, which means "no zone information" rather than "UTC".
export function parseExifUtcOffset(offset) {
    if (typeof offset !== "string") return null;
    const s = offset.trim();
    if (s === "") return null;
    if (/^Z$/i.test(s)) return 0;
    const m = /^([+-])(\d{2}):?(\d{2})$/.exec(s);
    if (!m) return null;
    const hh = Number(m[2]), mm = Number(m[3]);
    // EXIF offsets run to +14:00 (Kiritimati); anything past that is corrupt.
    if (hh > 14 || mm > 59) return null;
    return (m[1] === "-" ? -1 : 1) * (hh * 60 + mm);
}

// Reinterpret a timezone-naive capture Date at the offset EXIF recorded.
// Returns the input unchanged when there is no usable offset — a guess based on
// the viewer's timezone is still the best available, and is what Sitrec did
// before; the difference is that now it is only the FALLBACK.
export function applyExifUtcOffset(naiveDate, offset) {
    if (!(naiveDate instanceof Date) || Number.isNaN(naiveDate.getTime())) return naiveDate;
    const minutes = parseExifUtcOffset(offset);
    if (minutes === null) return naiveDate;

    return new Date(wallClockAsUTC(naiveDate) - minutes * 60000);
}

// Reinterpret a timezone-naive capture Date as wall-clock time in an IANA zone
// ("Europe/Berlin"), with that zone's offset on the capture date. For a photo with
// a GPS position and no OffsetTime tag. null when it cannot be done.
export function applyExifTimeZone(naiveDate, zone) {
    if (!(naiveDate instanceof Date) || Number.isNaN(naiveDate.getTime())) return null;
    return zoneWallClockToInstant(wallClockAsUTC(naiveDate), zone);
}

// The offset tag to believe, in order of authority: the one written for the
// original exposure, then the generic one, then the digitised one.
export function pickExifUtcOffset(raw) {
    for (const key of ["OffsetTimeOriginal", "OffsetTime", "OffsetTimeDigitized"]) {
        if (parseExifUtcOffset(raw?.[key]) !== null) return raw[key];
    }
    return undefined;
}
