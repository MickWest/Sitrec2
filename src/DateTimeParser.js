// Shared parsing for the Go To box and the Time editor's date/time text field.
//
// Only what the user actually typed is changed: a time with no date keeps the
// current date, a date with no time keeps the current time of day. Anything
// left over after the date/time tokens are removed means this ISN'T a date —
// that guard is what stops place names like "Mayfield" or "5 Jackson Street"
// being swallowed here instead of reaching the geocoder.
//
// Resolution is separate from applying the result, so each editor can retain
// its own edit target, playback and undo behavior.
import {resolveCelestialTime} from "./CelestialTime";
import {utcOffsetHoursInZone, zoneWallClockToInstant} from "./TimeZoneLookup";
import {extractTimeOffset} from "./TimeOffsetParser";

const MONTH_NAMES = [
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december"
];

// Accepts a full name or its three-letter abbreviation (plus "sept"), but NOT a
// longer word that merely starts with one ("may" yes, "mayfield" no).
function monthFromWord(word) {
    const w = word.replace(/\.$/, "");
    if (w === "sept") return 9;
    const i = MONTH_NAMES.findIndex(m => m === w || m.slice(0, 3) === w);
    return i >= 0 ? i + 1 : null;
}

// The longest each month can be. February gets 29 here because the year may not
// be known at parse time; resolveDateTimeString() re-checks against the actual
// year, which is where "2/29 in a non-leap year" is caught.
const LONGEST_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function validDate(month, day) {
    return month >= 1 && month <= 12 && day >= 1 && day <= LONGEST_MONTH[month - 1];
}

// 12-hour clock to 24-hour. 12am is 00, 12pm is 12.
function to24Hour(hour, meridiem) {
    if (!meridiem) return hour;
    if (meridiem === "am") return hour === 12 ? 0 : hour;
    return hour === 12 ? 12 : hour + 12;
}

/**
 * @param {string} input
 * @returns {{date: {year?:number, month:number, day:number}|null,
 *            time: {hour:number, minute:number, second:number}|null,
 *            utc: boolean, offsetHours?: number, relativeDay?: number, now?: boolean, namedTime?: string,
 *            timeShiftMS?: number} | null}
 */
export function parseDateTimeString(input) {
    if (typeof input !== "string" || !input.trim()) return null;

    // Lowercased, so ISO's "T" and "Z" arrive as "t" and "z". Split the date from
    // the time so the two halves parse independently ("2024-01-06t15:20:00z").
    let rest = input.trim().toLowerCase().replace(/(?<=\d)t(?=\d)/, " ");
    const modifier = extractTimeOffset(rest);
    if (!modifier) return null;
    rest = modifier.text;
    let utc = false;
    let time = null;
    let date = null;
    let offsetHours;
    let relativeDay;
    let now = false;
    let namedTime;

    const take = (re, handler) => {
        const m = rest.match(re);
        if (!m) return false;
        if (handler(m) === false) return false;
        rest = rest.slice(0, m.index) + " " + rest.slice(m.index + m[0].length);
        return true;
    };

    // Explicit ISO offsets take precedence over the displayed zone. Consume
    // them before the clock parser can mistake the offset for the stated time.
    take(/([+-])(\d{2}):(\d{2})$/, (m) => {
        if (+m[2] > 23 || +m[3] > 59) return false;
        offsetHours = (+m[2] + +m[3] / 60) * (m[1] === "-" ? -1 : 1);
    });

    // "17:33UTC", "17:33 GMT", "15:20Z" - an explicit UTC marker means the time
    // is absolute, whatever time zone the Time menu is displaying. No leading \b:
    // in "17:33utc" there is no boundary between the digit and the "u". A word
    // that merely contains "utc" ("Dutch") still fails the trailing \b, and
    // anything that slipped through would be caught by the leftover check.
    // No leading \s* before "utc"/"gmt": an unanchored \s* is retried from every index,
    // so a long run of spaces costs quadratic time (CodeQL js/polynomial-redos). The space
    // it used to eat is left in `rest`, which changes nothing - take() writes a space back
    // in place of the match anyway, and the leftover check below ignores whitespace.
    take(/(?:utc|gmt)\b|(?<=\d)\s*z\b/, () => { utc = true; });
    if (utc && offsetHours !== undefined) return null;

    take(/\bnow\b/, () => { now = true; });
    take(/\b(yesterday|today|tomorrow)\b/, (m) => {
        relativeDay = {yesterday: -1, today: 0, tomorrow: 1}[m[1]];
    });
    take(/\b(sunrise|sunset|moonrise|moonset|morning|evening|night|dusk|dawn)\b/, m => { namedTime = m[1]; });

    take(/\bnoon\b/, () => { time = {hour: 12, minute: 0, second: 0, millisecond: 0}; });
    if (!time) take(/\bmidnight\b/, () => { time = {hour: 0, minute: 0, second: 0, millisecond: 0}; });

    // "12:33am", "15:20", "15:20:30", and ISO's "15:20:00.000"
    if (!time) {
        take(/\b(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?\s*(am|pm)?/, (m) => {
            const hour = to24Hour(+m[1], m[5]);
            const minute = +m[2];
            const second = m[3] ? +m[3] : 0;
            const millisecond = m[4] ? +m[4].padEnd(3, "0") : 0;
            if (m[5] && (+m[1] < 1 || +m[1] > 12)) return false;
            if (hour > 23 || minute > 59 || second > 59) return false;
            time = {hour, minute, second, millisecond};
        });
    }
    // "12pm", "9 am" - a bare hour needs the am/pm, or it would eat frame numbers.
    if (!time) {
        take(/\b(\d{1,2})\s*(am|pm)\b/, (m) => {
            if (+m[1] < 1 || +m[1] > 12) return false;
            time = {hour: to24Hour(+m[1], m[2]), minute: 0, second: 0, millisecond: 0};
        });
    }

    // ISO 8601 "2024-01-06" - the form Sit.startTime is displayed in, so it can
    // be pasted straight back.
    take(/\b(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/, (m) => {
        if (!validDate(+m[2], +m[3])) return false;
        date = {month: +m[2], day: +m[3], year: +m[1]};
    });

    // "12/25", "12/26/2000". Month first, and a year must be all four digits -
    // we would rather decline "12/26/00" than guess its century.
    if (!date) {
        take(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?(?!\d)/, (m) => {
            if (!validDate(+m[1], +m[2])) return false;
            date = {month: +m[1], day: +m[2], year: m[3] ? +m[3] : undefined};
        });
    }

    // "Jan 5", "Jan 6, 2020", and the day-first order "5 Jan 2020".
    if (!date) {
        // \s*(?:,\s*)? rather than \s*,?\s* : same strings, but two adjacent \s* can
        // divide a run of spaces every possible way before the year fails to match
        // (CodeQL js/polynomial-redos). Tying the second run to the comma removes the choice.
        take(/\b([a-z]{3,9}\.?)\s+(\d{1,2})(?:\s*(?:,\s*)?(\d{4}))?\b/, (m) => {
            const month = monthFromWord(m[1]);
            if (month === null || !validDate(month, +m[2])) return false;
            date = {month, day: +m[2], year: m[3] ? +m[3] : undefined};
        });
    }
    if (!date) {
        take(/\b(\d{1,2})\s+([a-z]{3,9}\.?)(?:\s*(?:,\s*)?(\d{4}))?\b/, (m) => {
            const month = monthFromWord(m[2]);
            if (month === null || !validDate(month, +m[1])) return false;
            date = {month, day: +m[1], year: m[3] ? +m[3] : undefined};
        });
    }

    // Pasted timestamps often prefix the calendar date with a weekday. Treat it
    // as a label for the explicit date, never as a request to choose another day.
    // Without a calendar date, keep rejecting "Saturday at 8pm" rather than
    // silently using today's date. Other leftover words still reach the geocoder.
    if (date) take(/^\s*(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\.?(?=[\s,])/, () => {});

    if (now && (date || time || namedTime || relativeDay !== undefined)) return null;
    if (time && namedTime) return null;
    if (date && relativeDay !== undefined) return null;
    if (!date && !time && !namedTime && !now && relativeDay === undefined) return null;
    // A connector is allowed only between a recognized date and time.
    if ((date || relativeDay !== undefined) && (time || namedTime)) take(/\bat\b/, () => {});
    // Every character has to be accounted for, or this was never a date/time.
    if (rest.replace(/[\s,]/g, "") !== "") return null;

    return {date, time, utc,
        ...(offsetHours !== undefined ? {offsetHours} : {}),
        ...(relativeDay !== undefined ? {relativeDay} : {}),
        ...(namedTime ? {namedTime} : {}),
        ...(modifier.timeShiftMS !== undefined ? {timeShiftMS: modifier.timeShiftMS} : {}),
        ...(now ? {now: true} : {})};
}

/**
 * Resolve user text to an instant without changing the scene. Missing fields
 * come from baseDate (the playhead or start being edited). Relative day names
 * use the real clock's date in the input zone; "now" is the real instant.
 */
export function resolveDateTimeString(text, {baseDate = new Date(), offsetHours = 0, now = new Date(), location, timeZone} = {}) {
    const parsed = parseDateTimeString(text);
    if (!parsed || !Number.isFinite(baseDate?.getTime()) || !Number.isFinite(offsetHours)
        || !Number.isFinite(now?.getTime())) return null;
    // Apply elapsed time after resolving the anchor, so offsets can cross
    // midnight or a daylight saving change without moving the anchor's date.
    const shifted = date => {
        if (!date) return null;
        const result = new Date(date.getTime() + (parsed.timeShiftMS ?? 0));
        return Number.isFinite(result.getTime()) ? result : null;
    };
    if (parsed.now) return shifted(now);

    const zone = !parsed.utc && parsed.offsetHours === undefined ? timeZone : null;
    const baseOffset = zone ? utcOffsetHoursInZone(zone, baseDate) : (parsed.offsetHours ?? (parsed.utc ? 0 : offsetHours));
    const nowOffset = zone ? utcOffsetHoursInZone(zone, now) : baseOffset;
    if (baseOffset === null || nowOffset === null) return null;
    const readOffset = baseOffset * 3600000;

    // The current instant, expressed in the frame the typed fields are in, so
    // unspecified fields carry over unchanged.
    const base = new Date(baseDate.getTime() + readOffset);
    const calendar = parsed.relativeDay === undefined ? base
        : new Date(now.getTime() + nowOffset * 3600000 + parsed.relativeDay * 86400000);

    const year = parsed.date?.year ?? calendar.getUTCFullYear();
    const month = parsed.date?.month ?? (calendar.getUTCMonth() + 1);
    const day = parsed.date?.day ?? calendar.getUTCDate();
    const hour = parsed.time?.hour ?? base.getUTCHours();
    const minute = parsed.time?.minute ?? base.getUTCMinutes();
    const second = parsed.time?.second ?? base.getUTCSeconds();
    // A stated time carries its own sub-second part (0 unless ISO supplied one);
    // keep the current milliseconds only when the time of day was left alone.
    const ms = parsed.time ? (parsed.time.millisecond ?? 0) : base.getUTCMilliseconds();

    // Date.UTC ROLLS OVER instead of failing: Feb 29 in a non-leap year silently
    // becomes Mar 1. Going to a date the user did not ask for is worse than
    // declining, so check the day survives the round trip. (Only reachable for
    // Feb 29, since parseDateTimeString has already rejected days that no year
    // could make valid.)
    const probe = new Date(Date.UTC(year, month - 1, day));
    if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
        return null;
    }

    const toInstant = wall => zone ? zoneWallClockToInstant(wall, zone) : new Date(wall - readOffset);
    if (parsed.namedTime) {
        return shifted(resolveCelestialTime(parsed.namedTime, location,
            toInstant(probe.getTime()), toInstant(probe.getTime() + 86400000)));
    }
    const absolute = Date.UTC(year, month - 1, day, hour, minute, second, ms);
    return Number.isFinite(absolute) ? shifted(toInstant(absolute)) : null;
}

/** Apply Go To text through the same path as editing the date/time sliders. */
export function applyDateTimeString(text, node) {
    if (!node) return false;
    const offsetHours = node.useTimeZone ? node.getTimeZoneOffset() : 0;
    const date = resolveDateTimeString(text, {baseDate: node.dateNow, offsetHours, location: node.getTimeLocation?.()});
    if (!date) return false;

    // Write the fields the way populate() does, then take the same path a slider
    // edit takes.
    const shown = new Date(date.getTime() + offsetHours * 3600000);
    node.dateTime.year = shown.getUTCFullYear();
    node.dateTime.month = shown.getUTCMonth() + 1;
    node.dateTime.day = shown.getUTCDate();
    node.dateTime.hour = shown.getUTCHours();
    node.dateTime.minute = shown.getUTCMinutes();
    node.dateTime.second = shown.getUTCSeconds();
    node.dateTime.millisecond = shown.getUTCMilliseconds();
    node.updateDateTime();

    return true;
}
