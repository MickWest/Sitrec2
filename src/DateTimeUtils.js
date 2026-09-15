
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



/**
 * Converts a time string to an epoch timestamp in milliseconds.
 *
 * This function handles both numeric strings (interpreted as either milliseconds or seconds since the epoch)
 * and ISO 8601 date-time strings. If the input is purely numeric, it determines whether the number is in
 * milliseconds or seconds based on its value. If the input is an ISO 8601 string, it parses it to get the
 * corresponding epoch timestamp.
 *
 * See: https://github.com/MickWest/Sitrec2/issues/6
 *
 * @param {string} str - The time string to convert. It can be a numeric string or an ISO 8601 date-time string.
 * @returns {number} - The epoch timestamp in milliseconds.
 */
export function timeStrToEpoch(str) {
    // Trim spaces
    str = str.trim();

    // Check if it's purely numeric (integer or float)
    if (/^\d+(\.\d+)?$/.test(str)) {
        const num = Number(str);
        // Milliseconds since epoch (JavaScript default)
        if (num > 1e11 && num < 1e14) {
            return num
        }
        // Seconds since epoch will be roughly in this range for 1970-01-01 to ~5138 AD
        if (num > 1e8 && num < 1e11) {
            return num * 1000
        }

        return num // numeric but unlikely to be an epoch time
    }

    // Check ISO 8601 format (basic pattern for YYYY-MM-DDTHH:MM:SSZ or with offset)
    const ms = Date.parse(str);
    return ms
}
// Quantize a frame offset once, before combining it with an epoch timestamp.
// Rounding epoch + offset and epoch - offset separately is not invertible at
// half milliseconds (a regular occurrence with 30000/1001 video).
export function frameTimeOffsetMS(frame, fps, simSpeed = 1) {
    return Math.round(frame * 1000 * simSpeed / fps);
}
