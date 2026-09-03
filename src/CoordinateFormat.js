// Latitude and longitude as text: decimal degrees, degrees and decimal minutes,
// or degrees minutes seconds, with a hemisphere letter or a sign. The one place
// Sitrec turns a coordinate into something a person reads — the MQ-9 and
// Wescam overlays, the live-traffic status line — so they all round, pad and
// sign the same way, and so the text round-trips through CoordinateParser.
//
// The splitting is done in integers. The obvious float version — take the
// whole degrees, multiply the remainder by 60, take the whole minutes, multiply
// the remainder by 60 — rounds each part on its own, so 26' 59.97" prints as
// 26'60.0" instead of carrying to 27'00.0", and 33°53'05" arrives as
// 121984.99999999 seconds and truncates to 04". Rounding the whole angle to
// the smallest unit that will be shown, and only then dividing it up, gives
// every part its carry for free.

const HEMISPHERE = {lat: ["N", "S"], lon: ["E", "W"]};

// |value| degrees in whole units of 1/unitsPerDegree, rounded — or truncated,
// after rounding away float noise a million times finer than the unit, so an
// exact 05" never truncates to 04".
function toUnits(value, unitsPerDegree, truncate) {
    const raw = Math.abs(value) * unitsPerDegree;
    if (!truncate) return Math.round(raw);
    return Math.floor(Math.round(raw * 1e6) / 1e6);
}

/**
 * Degrees, minutes and seconds of |value|, with the seconds rounded to
 * `secondsDecimals` places and the carry taken into the minutes and degrees.
 *
 * @param {number} value - decimal degrees
 * @param {object} [options]
 * @param {number} [options.secondsDecimals=1]
 * @param {boolean} [options.truncate=false] - cut off rather than round
 * @returns {{negative:boolean, deg:number, min:number, sec:number}} negative is
 *   false for a value that rounds to zero, whatever its sign
 */
export function splitDMS(value, {secondsDecimals = 1, truncate = false} = {}) {
    const scale = 10 ** secondsDecimals;
    let units = toUnits(value, 3600 * scale, truncate);
    const negative = value < 0 && units > 0;
    const secUnits = units % (60 * scale);
    units = (units - secUnits) / (60 * scale);
    const min = units % 60;
    const deg = (units - min) / 60;
    return {negative, deg, min, sec: secUnits / scale};
}

/**
 * Degrees and decimal minutes of |value|, minutes rounded to
 * `minutesDecimals` places, carry taken into the degrees.
 *
 * @param {number} value - decimal degrees
 * @param {object} [options]
 * @param {number} [options.minutesDecimals=3]
 * @param {boolean} [options.truncate=false]
 * @returns {{negative:boolean, deg:number, min:number}}
 */
export function splitDM(value, {minutesDecimals = 3, truncate = false} = {}) {
    const scale = 10 ** minutesDecimals;
    const units = toUnits(value, 60 * scale, truncate);
    const negative = value < 0 && units > 0;
    const minUnits = units % (60 * scale);
    const deg = (units - minUnits) / (60 * scale);
    return {negative, deg, min: minUnits / scale};
}

// "40°26'46.0\"" + N/S, E/W, or a leading minus when there is no axis to name
// a hemisphere for.
function withSign(body, negative, axis) {
    const letters = HEMISPHERE[axis];
    if (letters) return body + (negative ? letters[1] : letters[0]);
    return negative ? "-" + body : body;
}

// Fixed-point text zero-padded to two digits before the point.
function fixed2(value, decimals) {
    const width = decimals > 0 ? 3 + decimals : 2;
    return value.toFixed(decimals).padStart(width, "0");
}

/**
 * Degrees minutes seconds: 40°26'46.0"N, or 33:53:05N in the colon style.
 *
 * @param {number} value - decimal degrees
 * @param {object} [options]
 * @param {"lat"|"lon"|null} [options.axis=null] - N/S or E/W suffix; null for a sign
 * @param {number} [options.secondsDecimals=1]
 * @param {number} [options.padDegrees=0] - zero-pad the degrees to this many digits
 * @param {"symbols"|"colons"} [options.style="symbols"]
 * @param {boolean} [options.truncate=false] - cut off rather than round
 * @returns {string}
 */
export function formatDMS(value, {axis = null, secondsDecimals = 1, padDegrees = 0, style = "symbols", truncate = false} = {}) {
    const {negative, deg, min, sec} = splitDMS(value, {secondsDecimals, truncate});
    const degText = String(deg).padStart(padDegrees, "0");
    const minText = String(min).padStart(2, "0");
    const secText = fixed2(sec, secondsDecimals);
    const body = style === "colons"
        ? `${degText}:${minText}:${secText}`
        : `${degText}°${minText}'${secText}"`;
    return withSign(body, negative, axis);
}

/**
 * Degrees and decimal minutes: 40°26.767'N — the marine and aviation form.
 *
 * @param {number} value - decimal degrees
 * @param {object} [options]
 * @param {"lat"|"lon"|null} [options.axis=null]
 * @param {number} [options.minutesDecimals=3]
 * @param {number} [options.padDegrees=0]
 * @param {boolean} [options.truncate=false]
 * @returns {string}
 */
export function formatDM(value, {axis = null, minutesDecimals = 3, padDegrees = 0, truncate = false} = {}) {
    const {negative, deg, min} = splitDM(value, {minutesDecimals, truncate});
    const degText = String(deg).padStart(padDegrees, "0");
    return withSign(`${degText}°${fixed2(min, minutesDecimals)}'`, negative, axis);
}

/**
 * Decimal degrees: 31.7°N with an axis, -118.0° without one.
 *
 * @param {number} value - decimal degrees
 * @param {object} [options]
 * @param {"lat"|"lon"|null} [options.axis=null]
 * @param {number} [options.decimals=6]
 * @param {string} [options.unit="°"] - pass "" for a bare number
 * @returns {string}
 */
export function formatDecimalDegrees(value, {axis = null, decimals = 6, unit = "°"} = {}) {
    const text = Math.abs(value).toFixed(decimals);
    const negative = value < 0 && Number(text) > 0;
    return withSign(text + unit, negative, axis);
}

/**
 * A latitude and a longitude together, each with its hemisphere letter:
 * "31.7°N 118.0°W", or the DMS/DM forms above.
 *
 * @param {number} lat
 * @param {number} lon
 * @param {object} [options]
 * @param {"decimal"|"dms"|"dm"} [options.style="decimal"]
 * @param {string} [options.separator=" "]
 * @returns {string} the remaining options go to the per-coordinate formatter
 */
export function formatLatLon(lat, lon, {style = "decimal", separator = " ", ...rest} = {}) {
    const format = style === "dms" ? formatDMS : style === "dm" ? formatDM : formatDecimalDegrees;
    return format(lat, {...rest, axis: "lat"}) + separator + format(lon, {...rest, axis: "lon"});
}
