
// Given an ISO 8601 date-time string, this function returns the offset in hours.
// The offset is positive for time zones east of UTC and negative for those west of UTC.
// It supports various formats including 'Z', '+HH:MM', '-HH:MM',
// '+HHMM', '-HHMM', and '+HH' or '-HH'.
// If the input is not a valid string or does not contain time zone information, it returns null.
export function getOffsetFromDateTimeString(dateTime) {
    if (typeof dateTime !== 'string') return null;

    if (dateTime.endsWith('Z')) return 0;

    // Match ±HH:MM, ±HHMM, or ±HH at end of string
    const match = dateTime.match(/([+-])(\d{2})(?::?(\d{2}))?$/);
    if (!match) return null;

    const sign = match[1] === '+' ? 1 : -1;
    const hours = parseInt(match[2], 10);
    const minutes = match[3] ? parseInt(match[3], 10) : 0;

    return sign * (hours + minutes / 60);
}
