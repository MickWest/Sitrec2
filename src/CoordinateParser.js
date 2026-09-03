import {toPoint as mgrsToPoint} from "mgrs";
import {ECEFToLLA, ECEFToLLA_radii} from "./LLA-ECEF-ENU";
import {degrees} from "./mathUtils";

// The three degree glyphs that turn up in pasted coordinates: DEGREE SIGN,
// RING ABOVE, and MASCULINE ORDINAL INDICATOR (Word/Excel like to substitute
// the latter two).
const DEGREE_CHARS = "°˚º";

// What pasted text does to a coordinate before it reaches us. Wikipedia writes
// its minus as U+2212 MINUS SIGN, Word turns ' and " into curly quotes, some
// sources use ´ or ʹ for minutes, and a line copied out of a table may end in a
// stray comma. None of these change the meaning, so they are folded to their
// ASCII form before any parsing, and every public entry point below does this
// first. Two apostrophes as a seconds mark ('') are folded too.
const DASHES = /[\u2010-\u2015\u2212]/g;                 // hyphens, dashes, MINUS SIGN
const MINUTE_MARKS = /[\u2032\u2018\u2019\u02B9\u00B4`]/g; // ′ ‘ ’ ʹ ´ `
const SECOND_MARKS = /[\u2033\u201C\u201D\u02BA]/g;       // ″ “ ” ʺ
const DEGREE_MARKS = /[˚º]/g;
const ODD_WHITESPACE = /[\u00A0\u2000-\u200B\u202F\u205F\u3000\t\r\n]/g;

export function normalizeCoordinateText(text) {
    if (typeof text !== "string") return "";
    return text
        .replace(ODD_WHITESPACE, " ")
        .replace(DASHES, "-")
        .replace(MINUTE_MARKS, "'")
        .replace(SECOND_MARKS, '"')
        .replace(/''/g, '"')
        .replace(DEGREE_MARKS, "°")
        .replace(/^[\s,;]+|[\s,;]+$/g, "");
}

// A plain decimal number, exponent notation included — ECEF metres are often
// written as 4.51e6.
// \d+(?:\.\d*)? rather than \d+\.?\d* : the two accept the same strings, but the
// looser form lets \d+ and \d* share a run of digits, so a long non-matching token
// ("000...0x") is re-split every way before it fails - quadratic, and reachable from
// pasted text (CodeQL js/polynomial-redos). Requiring the '.' before the second run
// makes each backtrack fail at once.
const NUMBER_TOKEN = /^[-+]?(\d+(?:\.\d*)?|\.\d+)([eE][-+]?\d+)?$/;

// Nothing in an x,y,z triple says "these are metres from the Earth's centre", so
// the only test available is to convert it and see where it lands: a real ECEF
// position sits near the surface, while an unrelated triple of numbers lands
// thousands of km off. Deliberately loose — a sanity check, not a filter.
const ECEF_MIN_ALT = -1000;      // metres below the ellipsoid
const ECEF_MAX_ALT = 1000000;    // metres above it (past the bottom of LEO)

/**
 * @typedef {object} ParseOptions
 * @property {boolean} [loose] - Also accept bare whitespace-separated pairs and
 *   triples ("25.299895 60.430364", "40 26 46 79 58 56", "4510000 -2300000
 *   3800000"). Only safe for a string the user has finished and submitted (the
 *   Lookup box, the Go To prompt, a paste) — never for live typing in a latitude
 *   field, where "45 30" means 45°30'.
 */

export function parseCoordinate(input, options = {}) {
    const trimmed = normalizeCoordinateText(input);
    if (!trimmed) return null;

    const mgrs = parseMGRS(trimmed);
    if (mgrs) return mgrs;

    const located = parseLatLonAlt(trimmed, options);
    if (located) return located;

    const single = parseSingleCoordinate(trimmed);
    if (single !== null) return {value: single};

    return null;
}

/**
 * A location that may carry an altitude, for the callers that can use one: an
 * ECEF x,y,z triple, a "lat, lon, alt" triple, or any of the lat/lon forms
 * parseLatLonPair() handles.
 *
 * @param {string} input
 * @param {ParseOptions} [options]
 * @returns {{lat:number, lon:number, alt:number|undefined, format:string}|null}
 *   alt is undefined when the text carried no altitude — which is not the same
 *   as an altitude of zero, and callers that fall back to ground level rely on
 *   it. format says which reading won: "lla" (a lat, lon, alt triple), "ecef",
 *   "mgrs" or "pair" — a caller that treats a bare third value as feet needs to
 *   know it was not an ECEF altitude in metres.
 */
export function parseLatLonAlt(input, options = {}) {
    const trimmed = normalizeCoordinateText(input);
    if (!trimmed) return null;

    // The same altitude window that decides whether a triple is ECEF also
    // separates the two readings, so nothing has to be preferred over anything.
    // An x,y,z triple only reaches the surface if its magnitude is ~6400 km, and
    // one whose x and y are small enough to pass for a lat and a lon can only do
    // that along z — so its altitude AS a lat/lon comes out around 6400 km,
    // outside the window, and this test declines it. Conversely a lat/lon
    // altitude inside the window leaves the triple far too short to be a
    // position on Earth. The overlap the two would otherwise fight over is real:
    // "0, 0, 6356752" is the north pole and also a lat/lon 6356 km up.
    const lla = parseLLATriple(trimmed, options.loose === true);
    if (lla && plausibleAltitude(lla.alt)) return {...lla, format: "lla"};

    const ecef = parseECEF(trimmed, options);
    if (ecef) return {...ecef, format: "ecef"};

    // Not a position on Earth either, so an out-of-window altitude is simply a
    // lat/lon with an unusual altitude — a geostationary subsatellite point at
    // 35,786 km, say. Returned rather than dropped, because the alternative is
    // parseLatLonPair below splitting it at the first comma and reading the rest
    // as degrees and minutes, which silently invents a longitude.
    if (lla) return {...lla, format: "lla"};

    // parseLatLonPair covers MGRS and every lat/lon form. It has to come after
    // the triple: it splits "45, 30, 20" at the first comma and reads the rest
    // as degrees and minutes, which would swallow a lat/lon/alt.
    const pair = parseLatLonPair(trimmed, options);
    if (!pair) return null;
    return {lat: pair.lat, lon: pair.lon, alt: pair.alt, format: parseMGRS(trimmed) ? "mgrs" : "pair"};
}

/**
 * Recognise an ECEF x,y,z triple in metres ("4510000, -2300000, 3800000") and
 * return the geodetic position it describes.
 *
 * WGS84 is the interpretation, because that is what ECEF means to everyone
 * outside Sitrec (EPSG:4978 — GPS, the 3D Tiles spec, every geodetic tool), and
 * Sitrec never displays a raw x,y,z anywhere for the user to copy back in. It
 * matters because sitches default to a spherical earth (Sit.useEllipsoid is
 * false) and the two models name the same point very differently: at 45° they
 * disagree by 0.19° of latitude (21 km on the ground) and 10.7 km of altitude.
 *
 * Sitrec's own model is then tried as a fallback, which can only ever rescue a
 * triple WGS84 rejected. That is safe in a way the reverse order was not: for
 * any given point the WGS84 altitude is always the HIGHER of the two (the
 * ellipsoid radius never exceeds the equatorial radius), so WGS84 can only fail
 * the window by reading too high, and the fallback only fires near the top of
 * it — where the alternative is rejecting the triple outright, not misplacing
 * it. Ordered the other way, a WGS84 point 10 km up reads as 730 m underground
 * on the sphere, passes the window, and lands 21 km from where it belongs.
 *
 * @param {string} input
 * @param {ParseOptions} [options]
 * @returns {{lat:number, lon:number, alt:number}|null}
 */
export function parseECEF(input, options = {}) {
    const xyz = splitNumericTriple(normalizeCoordinateText(input), options.loose === true);
    if (!xyz) return null;
    const [x, y, z] = xyz;

    return ecefToLocation(ECEFToLLA(x, y, z))
        ?? ecefToLocation(ECEFToLLA_radii(x, y, z));
}

// Written as a range test rather than two comparisons so a NaN fails it
// (converting x=y=z=0 produces one).
function plausibleAltitude(alt) {
    return alt >= ECEF_MIN_ALT && alt <= ECEF_MAX_ALT;
}

// [lat, lon, alt] in radians/metres -> a location in degrees/metres, or null if
// the altitude says this triple was never a position on the Earth.
function ecefToLocation(lla) {
    if (!plausibleAltitude(lla[2])) return null;
    return {lat: degrees(lla[0]), lon: degrees(lla[1]), alt: lla[2]};
}

// "38.73, -120.56, 100000" - a lat/lon pair with an altitude in metres.
function parseLLATriple(input, loose) {
    const values = splitNumericTriple(input, loose);
    if (!values) return null;
    const [lat, lon, alt] = values;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 360) return null;
    return {lat, lon, alt};
}

// "x, y, z" / "x; y; z" -> [x, y, z]. Bare whitespace only separates for callers
// that opt in, for the same reason a pair needs {loose}: "45 30 30" read as three
// values is also degrees-minutes-seconds. That form is not a usable location on
// its own, so nothing that works today changes meaning — but a live-typing field
// must not start reinterpreting a half-typed DMS coordinate.
function splitNumericTriple(input, loose = false) {
    const trimmed = input.trim();
    if (!loose && !/[,;]/.test(trimmed)) return null;

    const tokens = trimmed.split(/[\s,;]+/).filter(t => t !== "");
    if (tokens.length !== 3) return null;
    if (!tokens.every(t => NUMBER_TOKEN.test(t))) return null;

    const values = tokens.map(Number);
    return values.every(Number.isFinite) ? values : null;
}

export function parseMGRS(input) {
    if (typeof input !== "string") return null;
    const normalized = input.replace(/\s+/g, "").toUpperCase();
    const mgrsPattern = /^\d{1,2}[A-Z]{3}(\d{2}|\d{4}|\d{6}|\d{8}|\d{10})$/;
    if (!mgrsPattern.test(normalized)) return null;
    try {
        const [lon, lat] = mgrsToPoint(normalized);
        return {lat, lon};
    } catch {
        return null;
    }
}

/**
 * Combine degrees, minutes and seconds into decimal degrees.
 *
 * The sign belongs to the WHOLE coordinate, not to the degrees alone: -40° 26'
 * 46" is 40°26'46" South, i.e. -(40 + 26/60 + 46/3600), never -40 + 26/60 +
 * 46/3600. That is the convention every DMS notation shares — the minus sign,
 * like a hemisphere letter, says which side of the equator or meridian the
 * whole angle lies on. So `min` and `sec` are magnitudes, and the sign comes
 * from `negative`, or from `deg` when `deg` is signed (a -0 counts: "-0° 13'"
 * is 0°13' South, and Number("-0") keeps that sign).
 *
 * @param {number} deg
 * @param {number} [min]
 * @param {number} [sec]
 * @param {boolean} [negative] - the whole coordinate is south/west
 * @returns {number} decimal degrees
 */
export function dmsToDegrees(deg, min = 0, sec = 0, negative = false) {
    const isNegative = negative || deg < 0 || Object.is(deg, -0);
    const magnitude = Math.abs(deg) + Math.abs(min) / 60 + Math.abs(sec) / 3600;
    if (magnitude === 0) return 0;
    return isNegative ? -magnitude : magnitude;
}

/**
 * One coordinate — a latitude or a longitude on its own — in any written form:
 * decimal degrees, degrees and decimal minutes, degrees minutes seconds, with
 * or without ° ' " marks, colons ("33:53:05N") or dashes ("40-26-46N") between
 * the parts, and an optional hemisphere letter at either end.
 *
 * The result is null for anything that is not a well-formed coordinate — a
 * stray letter in a number, minutes or seconds of 60 or more, a fraction on
 * anything but the last part ("45.5 30"), a minus sign on the minutes alone.
 * Silently reading "45 30 3o" as 45°30'03" was worse than reading nothing.
 *
 * @param {string} input
 * @returns {number|null} decimal degrees
 */
export function parseSingleCoordinate(input) {
    const text = normalizeCoordinateText(input);
    if (!text) return null;
    const {value, direction} = extractDirection(text);
    const parsed = parseDMSText(value);
    if (parsed === null) return null;
    // A hemisphere letter is the most explicit statement of the sign there is,
    // so it wins over a minus sign when both are present ("S -45.5" is south).
    const negative = direction !== null
        ? (direction === "S" || direction === "W")
        : parsed.negative;
    if (parsed.magnitude === 0) return 0;
    return negative ? -parsed.magnitude : parsed.magnitude;
}

function extractDirection(input) {
    const upper = input.toUpperCase();
    const leadingMatch = upper.match(/^([NSEW])\s*/);
    if (leadingMatch) {
        return {
            value: input.slice(leadingMatch[0].length).trim(),
            direction: leadingMatch[1]
        };
    }
    // Checked character-wise, not with /\s*([NSEW])$/: that regex is unanchored, so a
    // long run of trailing spaces is rescanned from every index before it fails -
    // quadratic (CodeQL js/polynomial-redos). Dropping the letter and trimming what
    // precedes it consumes exactly what the regex match did.
    const trailing = upper.slice(-1);
    if (upper.length > 0 && "NSEW".includes(trailing)) {
        return {
            value: input.slice(0, -1).trim(),
            direction: trailing
        };
    }
    return {value: input, direction: null};
}

// A degrees, minutes or seconds part: digits with an optional fraction and sign,
// nothing else. No exponent — 4.5e1 is not a way anyone writes minutes.
const DMS_PART = /^[-+]?(\d+(?:\.\d*)?|\.\d+)$/;

/**
 * The magnitude and sign of a coordinate written as D, D M or D M S, after any
 * hemisphere letter has been taken off.
 *
 * The sign is read from the TEXT of the degrees part, not from its numeric
 * value: Number("-0") is -0, and -0 < 0 is false, which is how "-0° 13'" once
 * came out north of the equator. Quito is at 0°13'S.
 *
 * @returns {{magnitude:number, negative:boolean}|null}
 */
function parseDMSText(text) {
    const str = text
        .replace(/[°'"]/g, " ")          // the marks say which part is which, whitespace does too
        .replace(/[:,]/g, " ")           // 33:53:05 and 40, 26, 46
        .replace(/(\d)-(?=\d)/g, "$1 ")  // 40-26-46: a dash between digits is a separator, not a sign
        .trim();
    const parts = str.split(/\s+/).filter(part => part !== "");
    if (parts.length === 0 || parts.length > 3) return null;

    if (parts.length === 1) {
        // Plain decimal degrees. Exponent notation is allowed here because it is
        // a valid way to write a number, if not a likely one.
        if (!NUMBER_TOKEN.test(parts[0])) return null;
        const value = Number(parts[0]);
        if (!Number.isFinite(value)) return null;
        return {magnitude: Math.abs(value), negative: parts[0].startsWith("-")};
    }

    if (!parts.every(part => DMS_PART.test(part))) return null;

    // The sign is carried by the degrees. A minus on the minutes or seconds is
    // accepted only in the all-negative form some tools emit ("-45 -30 -30"),
    // where it restates the sign of the whole; "45 -30" has no meaning.
    const negative = parts[0].startsWith("-");
    if (!negative && parts.slice(1).some(part => part.startsWith("-"))) return null;

    const values = parts.map(part => Math.abs(Number(part)));
    // Only the last part may carry a fraction: 45.5° 30' does not exist.
    for (let i = 0; i < values.length - 1; i++) {
        if (!Number.isInteger(values[i])) return null;
    }
    // Minutes and seconds run from 0 up to (not including) 60.
    if (values.slice(1).some(value => value >= 60)) return null;

    return {magnitude: dmsToDegrees(values[0], values[1], values[2] ?? 0), negative};
}

// A plain decimal number, no exponent, no sign: the fast path of a CSV cell.
const PLAIN_DECIMAL = /^[-+]?(\d+(?:\.\d*)?|\.\d+)$/;

/**
 * A latitude or longitude read from a spreadsheet cell or a CSV field. Numbers
 * pass straight through; a plain decimal string is converted directly (the
 * common case, kept cheap because track files have thousands of rows); anything
 * else goes through the full coordinate parser, so a column of 40°26'46"N
 * imports as readily as one of 40.446111. Blank or unreadable cells are NaN, the
 * value every importer already treats as "no position on this row".
 *
 * @param {number|string|null|undefined} value
 * @returns {number} decimal degrees, or NaN
 */
export function parseCoordinateCell(value) {
    if (typeof value === "number") return value;
    if (value === null || value === undefined) return NaN;
    const text = String(value).trim();
    if (text === "") return NaN;
    if (PLAIN_DECIMAL.test(text)) return Number(text);
    return parseSingleCoordinate(text) ?? NaN;
}

/**
 * The location a map site's URL points at, for a link dropped onto Sitrec.
 *
 * Google Maps carries it in the path ("/maps/place/…/@33.9948,-118.4616,67a,…"),
 * ADS-B Exchange in ?lat=&lon=&zoom=, Flightradar24 in the path
 * ("/38.73,-120.56/9"). Where the URL also says how much ground the view
 * covers, that comes back as verticalSpanM — the height of the visible map in
 * metres — so the caller can pick a camera altitude that shows the same area.
 * A Google "67m"/"67a" segment is that span directly; a zoom level is turned
 * into the span of one tile column at that latitude, which is what the map
 * sites themselves show at that zoom. A zoom that is missing or unreadable
 * leaves verticalSpanM undefined rather than NaN.
 *
 * @param {string} urlString
 * @returns {{lat:number, lon:number, verticalSpanM:number|undefined}|null}
 */
export function parseMapURL(urlString) {
    let url;
    try {
        url = new URL(urlString);
    } catch {
        return null;
    }
    const host = url.hostname.toLowerCase();

    if (/^(www|maps)\.google\./.test(host) && url.pathname.startsWith("/maps")) {
        const at = url.pathname.match(/@([^/]+)/);
        if (!at) return null;
        const parts = at[1].split(",");
        if (parts.length < 2) return null;
        const pair = parseLatLonPair(`${parts[0]}, ${parts[1]}`);
        if (!pair) return null;
        let verticalSpanM;
        if (parts[2] && /^[\d.]+[ma]$/.test(parts[2])) {
            const span = Number(parts[2].slice(0, -1));
            if (Number.isFinite(span) && span > 0) verticalSpanM = span;
        }
        return {lat: pair.lat, lon: pair.lon, verticalSpanM};
    }

    if (host === "globe.adsbexchange.com") {
        const lat = parseSingleCoordinate(url.searchParams.get("lat") ?? "");
        const lon = parseSingleCoordinate(url.searchParams.get("lon") ?? "");
        if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 360) return null;
        return {lat, lon, verticalSpanM: spanForZoom(lat, url.searchParams.get("zoom"))};
    }

    if (host === "www.flightradar24.com") {
        const [, latlon, zoom] = url.pathname.split("/");
        const pair = parseLatLonPair(latlon ?? "");
        if (!pair) return null;
        return {lat: pair.lat, lon: pair.lon, verticalSpanM: spanForZoom(pair.lat, zoom)};
    }

    return null;
}

// Web-Mercator zoom level -> ground height of the view in metres. At zoom z the
// world is 2^z tiles across; one tile at this latitude spans the Earth's
// circumference there divided by 2^z, and the view is taken as two tiles high.
function spanForZoom(lat, zoomText) {
    const zoom = Number(zoomText);
    if (zoomText === null || zoomText === undefined || zoomText === "" || !Number.isFinite(zoom)) return undefined;
    const circumference = 40075000 * Math.cos(lat * Math.PI / 180);
    return circumference / Math.pow(2, zoom - 1);
}

/**
 * @param {string} input
 * @param {ParseOptions} [options]
 * @returns {{lat:number, lon:number, alt:number|undefined}|null} alt is set only
 *   for the forms that carry one (currently ECEF).
 */
export function parseLatLonPair(input, options = {}) {
    const trimmed = normalizeCoordinateText(input);
    if (!trimmed) return null;

    const mgrs = parseMGRS(trimmed);
    if (mgrs) return mgrs;

    // Before the pair splitters: an ECEF paste splits at its first comma into
    // lat="4510000", which is then thrown out for being past the poles.
    const ecef = parseECEF(trimmed, options);
    if (ecef) return ecef;

    const parts = splitLatLon(trimmed, options.loose === true);
    if (!parts) return null;

    const lat = parseSingleCoordinate(parts.lat);
    const lon = parseSingleCoordinate(parts.lon);

    if (lat === null || lon === null) return null;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 360) return null;

    return {lat, lon};
}

function splitLatLon(input, loose = false) {
    const upper = input.toUpperCase();

    const nsMatch = upper.match(/([NS])/g);
    const ewMatch = upper.match(/([EW])/g);
    if (nsMatch && ewMatch && nsMatch.length === 1 && ewMatch.length === 1) {
        const nsIdx = upper.search(/[NS]/);
        const ewIdx = upper.search(/[EW]/);
        const nsIsTrailing = nsIdx > 0 && (upper[nsIdx - 1].match(/[\d\s°′″'".]/) || nsIdx === upper.length - 1);
        const ewIsTrailing = ewIdx > 0 && (upper[ewIdx - 1].match(/[\d\s°′″'".]/) || ewIdx === upper.length - 1);

        if (nsIsTrailing && ewIsTrailing) {
            const firstDir = nsIdx < ewIdx ? "NS" : "EW";
            const splitIdx = firstDir === "NS" ? nsIdx + 1 : ewIdx + 1;
            const part1 = input.slice(0, splitIdx).trim();
            const part2 = input.slice(splitIdx).trim().replace(/^[,\s]+/, "");
            const lat = firstDir === "NS" ? part1 : part2;
            const lon = firstDir === "NS" ? part2 : part1;
            return {lat, lon};
        }

        const nsIsLeading = nsIdx === 0 || (nsIdx > 0 && upper[nsIdx - 1].match(/[\s,;]/));
        const ewIsLeading = ewIdx === 0 || (ewIdx > 0 && upper[ewIdx - 1].match(/[\s,;]/));
        if (nsIsLeading && ewIsLeading) {
            const firstDir = nsIdx < ewIdx ? "NS" : "EW";
            const secondIdx = firstDir === "NS" ? ewIdx : nsIdx;
            const part1 = input.slice(0, secondIdx).trim();
            const part2 = input.slice(secondIdx).trim().replace(/^[,\s]+/, "");
            const lat = firstDir === "NS" ? part1 : part2;
            const lon = firstDir === "NS" ? part2 : part1;
            return {lat, lon};
        }
    }

    const commaIdx = findSplitPoint(input, ",");
    if (commaIdx !== -1) {
        return {
            lat: input.slice(0, commaIdx).trim(),
            lon: input.slice(commaIdx + 1).trim()
        };
    }

    const semicolonIdx = findSplitPoint(input, ";");
    if (semicolonIdx !== -1) {
        return {
            lat: input.slice(0, semicolonIdx).trim(),
            lon: input.slice(semicolonIdx + 1).trim()
        };
    }

    // Two degree symbols means two coordinates: a single coordinate can only
    // carry one (its minutes and seconds use ′ and ″). So "25.299895°
    // 60.430364°" and "40° 26' 46\" 79° 58' 56\"" split at the last whitespace
    // before the SECOND degree symbol — everything before that, minutes and
    // seconds included, belongs to the latitude.
    const degreeSplit = splitAtSecondDegreeSymbol(input);
    if (degreeSplit) return degreeSplit;

    // Bare whitespace is NOT a pair separator by default: "32 55" is ambiguous
    // with degrees-minutes notation (32°55'), and greedy pair-matching breaks
    // live typing in the LLA Lat input. Callers that get a complete, submitted
    // string (the Lookup box, the Go To prompt) opt in with {loose: true}.
    if (loose) return splitWhitespaceHalves(input);

    return null;
}

// "25.299895° 60.430364°" -> {lat: "25.299895°", lon: "60.430364°"}
function splitAtSecondDegreeSymbol(input) {
    const degrees = [];
    for (let i = 0; i < input.length; i++) {
        if (DEGREE_CHARS.includes(input[i])) degrees.push(i);
    }
    if (degrees.length !== 2) return null;

    // Walk back from the second degree symbol to the token boundary that starts
    // its coordinate. Without whitespace between them ("25°60°") we can't tell
    // where one ends, so we decline rather than guess.
    for (let i = degrees[1] - 1; i > degrees[0]; i--) {
        if (/\s/.test(input[i])) {
            return {
                lat: input.slice(0, i).trim(),
                lon: input.slice(i + 1).trim()
            };
        }
    }
    return null;
}

// "25.299895 60.430364" -> D/D, "40 26 46 79 58 56" -> DMS/DMS. An even number
// of purely numeric tokens splits down the middle; anything else (odd counts, a
// word like "Area 51") is not a coordinate pair.
function splitWhitespaceHalves(input) {
    const tokens = input.split(/\s+/).filter(p => p !== "");
    if (tokens.length < 2 || tokens.length > 6 || tokens.length % 2 !== 0) return null;
    if (!tokens.every(isNumericToken)) return null;
    const half = tokens.length / 2;
    return {
        lat: tokens.slice(0, half).join(" "),
        lon: tokens.slice(half).join(" ")
    };
}

// A token that could be (part of) a coordinate: a number, with any of the marks
// and separators parseDMSText accepts stripped out. A shape test only — the
// real parse follows, and rejects what this lets through.
function isNumericToken(token) {
    const bare = token
        .replace(/[°'"]/g, "")
        .replace(/(\d)[-:](?=\d)/g, "$1");
    return DMS_PART.test(bare);
}

function findSplitPoint(input, delimiter) {
    return input.indexOf(delimiter);
}
