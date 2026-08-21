// Parsing for dates and times typed by the user (the "G" / Go To box).
//
// Only what the user actually typed is changed: a time with no date keeps the
// current date, a date with no time keeps the current time of day. Anything
// left over after the date/time tokens are removed means this ISN'T a date —
// that guard is what stops place names like "Mayfield" or "5 Jackson Street"
// being swallowed here instead of reaching the geocoder.
//
// Pure module: applyDateTimeString() takes the date/time node as an argument
// rather than importing it, so it can be unit tested against a plain object.

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
// be known at parse time; applyDateTimeString() re-checks against the actual
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
 *            utc: boolean} | null}
 */
export function parseDateTimeString(input) {
    if (typeof input !== "string" || !input.trim()) return null;

    // Lowercased, so ISO's "T" and "Z" arrive as "t" and "z". Split the date from
    // the time so the two halves parse independently ("2024-01-06t15:20:00z").
    let rest = input.trim().toLowerCase().replace(/(?<=\d)t(?=\d)/, " ");
    let utc = false;
    let time = null;
    let date = null;

    const take = (re, handler) => {
        const m = rest.match(re);
        if (!m) return false;
        if (handler(m) === false) return false;
        rest = rest.slice(0, m.index) + " " + rest.slice(m.index + m[0].length);
        return true;
    };

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

    take(/\bnoon\b/, () => { time = {hour: 12, minute: 0, second: 0, millisecond: 0}; });
    take(/\bmidnight\b/, () => { time = {hour: 0, minute: 0, second: 0, millisecond: 0}; });

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
    // be pasted straight back. (A numeric offset such as "+05:00" is not read;
    // it will be left over and the whole string declined.)
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

    if (!date && !time) return null;
    // Every character has to be accounted for, or this was never a date/time.
    if (rest.replace(/[\s,]/g, "") !== "") return null;

    return {date, time, utc};
}

/**
 * Apply a typed date/time to the Time menu, exactly as if the user had edited
 * its year/month/day/hour/minute/second fields: same time-zone handling, same
 * live-mode reset, same recalculate.
 *
 * @param {string} text
 * @param {object} node - the CNodeDateTime (GlobalDateTimeNode)
 * @returns {boolean} true if the text was a date/time and has been applied
 */
export function applyDateTimeString(text, node) {
    const parsed = parseDateTimeString(text);
    if (!parsed || !node) return false;

    const hours = (h) => h * 60 * 60000;
    // The Time menu shows the selected time zone (or UTC when the override is
    // off). An explicitly-UTC input is read in UTC regardless of that.
    const displayOffset = node.useTimeZone ? hours(node.getTimeZoneOffset()) : 0;
    const readOffset = parsed.utc ? 0 : displayOffset;

    // The current instant, expressed in the frame the typed fields are in, so
    // unspecified fields carry over unchanged.
    const base = new Date(node.dateNow.getTime() + readOffset);

    const year = parsed.date?.year ?? base.getUTCFullYear();
    const month = parsed.date?.month ?? (base.getUTCMonth() + 1);
    const day = parsed.date?.day ?? base.getUTCDate();
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
        return false;
    }

    const absolute = Date.UTC(year, month - 1, day, hour, minute, second, ms) - readOffset;

    // Write the fields the way populate() does, then take the same path a slider
    // edit takes.
    const shown = new Date(absolute + displayOffset);
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
