import {toPoint as mgrsToPoint} from "mgrs";
import {ECEFToLLA, ECEFToLLA_radii} from "./LLA-ECEF-ENU";
import {degrees} from "./mathUtils";

// The three degree glyphs that turn up in pasted coordinates: DEGREE SIGN,
// RING ABOVE, and MASCULINE ORDINAL INDICATOR (Word/Excel like to substitute
// the latter two).
const DEGREE_CHARS = "°˚º";

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
    if (typeof input !== "string" || !input.trim()) return null;
    const trimmed = input.trim();

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
 * @returns {{lat:number, lon:number, alt:number|undefined}|null} alt is
 *   undefined when the text carried no altitude — which is not the same as an
 *   altitude of zero, and callers that fall back to ground level rely on it.
 */
export function parseLatLonAlt(input, options = {}) {
    if (typeof input !== "string" || !input.trim()) return null;
    const trimmed = input.trim();

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
    if (lla && plausibleAltitude(lla.alt)) return lla;

    const ecef = parseECEF(trimmed, options);
    if (ecef) return ecef;

    // Not a position on Earth either, so an out-of-window altitude is simply a
    // lat/lon with an unusual altitude — a geostationary subsatellite point at
    // 35,786 km, say. Returned rather than dropped, because the alternative is
    // parseLatLonPair below splitting it at the first comma and reading the rest
    // as degrees and minutes, which silently invents a longitude.
    if (lla) return lla;

    // parseLatLonPair covers MGRS and every lat/lon form. It has to come after
    // the triple: it splits "45, 30, 20" at the first comma and reads the rest
    // as degrees and minutes, which would swallow a lat/lon/alt.
    const pair = parseLatLonPair(trimmed, options);
    if (!pair) return null;
    return {lat: pair.lat, lon: pair.lon, alt: pair.alt};
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
    const xyz = splitNumericTriple(input, options.loose === true);
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

export function parseSingleCoordinate(input) {
    const trimmed = input.trim();
    const {value, direction} = extractDirection(trimmed);
    const degrees = parseDMSorDM(value);
    if (degrees === null) return null;
    const sign = getDirectionSign(direction, degrees);
    return sign * Math.abs(degrees);
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

function getDirectionSign(direction, originalValue) {
    if (direction === "S" || direction === "W") return -1;
    if (direction === "N" || direction === "E") return 1;
    return originalValue < 0 ? -1 : 1;
}

function parseDMSorDM(input) {
    let str = input.replace(/[°˚º]/g, " ")
        .replace(/[′']/g, " ")
        .replace(/[″"]/g, " ")
        .replace(/,/g, " ")
        .trim();

    const parts = str.split(/\s+/).filter(p => p !== "");

    if (parts.length === 0) return null;

    if (parts.length === 1) {
        const val = parseFloat(parts[0]);
        return isNaN(val) ? null : val;
    }

    if (parts.length === 2) {
        const deg = parseFloat(parts[0]);
        const min = parseFloat(parts[1]);
        if (isNaN(deg) || isNaN(min)) return null;
        const sign = deg < 0 ? -1 : 1;
        return sign * (Math.abs(deg) + min / 60);
    }

    if (parts.length >= 3) {
        const deg = parseFloat(parts[0]);
        const min = parseFloat(parts[1]);
        const sec = parseFloat(parts[2]);
        if (isNaN(deg) || isNaN(min) || isNaN(sec)) return null;
        const sign = deg < 0 ? -1 : 1;
        return sign * (Math.abs(deg) + min / 60 + sec / 3600);
    }

    return null;
}

/**
 * @param {string} input
 * @param {ParseOptions} [options]
 * @returns {{lat:number, lon:number, alt:number|undefined}|null} alt is set only
 *   for the forms that carry one (currently ECEF).
 */
export function parseLatLonPair(input, options = {}) {
    const mgrs = parseMGRS(input);
    if (mgrs) return mgrs;

    // Before the pair splitters: an ECEF paste splits at its first comma into
    // lat="4510000", which is then thrown out for being past the poles.
    const ecef = parseECEF(input, options);
    if (ecef) return ecef;

    const trimmed = input.trim();
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

function isNumericToken(token) {
    const bare = token.replace(/[°˚º′'″"]/g, "");
    return /^[-+]?(\d+\.?\d*|\.\d+)$/.test(bare);
}

function findSplitPoint(input, delimiter) {
    return input.indexOf(delimiter);
}
