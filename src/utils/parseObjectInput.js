import {parseLatLonAlt, parseLatLonPair} from "../CoordinateParser";

// A trailing altitude: "100", "100m", "300ft", "-5.5m", ".5m".
const TRAILING_ALTITUDE = /^(.*?)[\s,]+([-+]?(?:\d+(?:\.\d*)?|\.\d+))\s*(m|ft)?$/i;

/**
 * Parses a string input representing a geographic object with optional name, latitude, longitude, and altitude.
 * The input format can be:
 * - "Name lat lon alt"
 * - "lat lon alt"
 * - "Name lat,lon,alt"
 * - "lat,lon,alt"
 * The coordinates take any form CoordinateParser accepts - decimal degrees, D M S,
 * hemisphere letters ("Home N40 26.767 W074 00.36"), MGRS - and the name is
 * everything before the first number.
 * Altitude can be specified in meters (default) or feet (e.g., "100ft").
 *
 * @param {string} inputString - The input string to parse.
 * @returns {Object|null} An object with properties: name (string|null), lat (number), lon (number), alt (number), hasExplicitAlt (boolean), or null if parsing fails.
 */
export function parseObjectInput(inputString) {
    if (!inputString || typeof inputString !== 'string') {
        return null;
    }

    const input = inputString.trim();
    if (input.length === 0) {
        return null;
    }

    // The coordinates start at the first number - optionally led by a
    // hemisphere letter - that begins a token.
    const match = input.match(/(?:^|[\s,])((?:[NSEW]\s*)?[-+]?\d)/i);
    if (!match) {
        return null;
    }

    const coordStartIndex = match.index + (match[0].startsWith(' ') || match[0].startsWith(',') ? 1 : 0);

    let name = null;
    if (coordStartIndex > 0) {
        const namePart = input.substring(0, coordStartIndex).trim();
        if (namePart.length > 0) {
            name = namePart;
        }
    }

    const coordString = input.substring(coordStartIndex);

    // "lat lon", "lat, lon, alt", MGRS, an ECEF triple: the shared parser reads
    // these outright, and a bare third number is an altitude in metres.
    const located = parseLatLonAlt(coordString, {loose: true});
    if (located) {
        return {
            name,
            lat: located.lat,
            lon: located.lon,
            alt: located.alt ?? 0,
            hasExplicitAlt: located.alt !== undefined
        };
    }

    // Otherwise the altitude may carry a unit ("100m", "300ft"), or follow a
    // D M S pair that the triple reading cannot take: peel it off and parse
    // what is left as a pair.
    const altMatch = coordString.match(TRAILING_ALTITUDE);
    if (!altMatch) {
        return null;
    }
    const pair = parseLatLonPair(altMatch[1], {loose: true});
    if (!pair) {
        return null;
    }
    const altValue = parseFloat(altMatch[2]);
    const unit = altMatch[3] ? altMatch[3].toLowerCase() : 'm';
    return {
        name,
        lat: pair.lat,
        lon: pair.lon,
        alt: unit === 'ft' ? altValue * 0.3048 : altValue,
        hasExplicitAlt: true
    };
}

/**
 * The highest N among names of the form "<prefix> N", or 0 when there are none.
 *
 * Split out from CCustomManager.getNextObjectName and TrackManager.nextTrackName so the
 * numbering rule can be tested without a live node graph; the managers supply the names.
 *
 * @param {Iterable<string>} existingNames - names already in use. Non-string and empty
 *        entries are ignored.
 * @param {string} [prefix="Object"] - "Object" for 3D objects, "Track" for tracks
 * @returns {number}
 */
export function highestSequentialNumber(existingNames, prefix = "Object") {
    const pattern = new RegExp(`^${prefix} (\\d+)$`);
    let maxNumber = 0;

    for (const name of existingNames ?? []) {
        if (typeof name !== "string") continue;
        const match = name.match(pattern);
        if (match) {
            const number = parseInt(match[1], 10);
            if (number > maxNumber) {
                maxNumber = number;
            }
        }
    }

    return maxNumber;
}

/**
 * Pick the next free "<prefix> N" name given every name already in use: one more than the
 * highest N in use, so a name freed by a delete is not handed out again.
 * @param {Iterable<string>} existingNames - see highestSequentialNumber
 * @param {string} [prefix="Object"]
 * @returns {string} "<prefix> <highest+1>", or "<prefix> 1" when none are in use.
 */
export function nextSequentialName(existingNames, prefix = "Object") {
    return `${prefix} ${highestSequentialNumber(existingNames, prefix) + 1}`;
}

/**
 * The number for a track and the object made with it, so that they are "Track N" and
 * "Object N" with the same N: one past the highest number that any track or object has. A
 * number is skipped when one sequence is ahead (Track 1, Object 1, Track 2 → 3).
 * @param {Iterable<string>} objectNames - names the objects carry
 * @param {Iterable<string>} trackNames - names the tracks carry
 * @returns {number}
 */
export function nextPairNumber(objectNames, trackNames) {
    return Math.max(highestSequentialNumber(objectNames, "Object"),
        highestSequentialNumber(trackNames, "Track")) + 1;
}

/**
 * Pick the next free "Object N" name given every name already in use.
 * @param {Iterable<string>} existingNames - see nextSequentialName
 * @returns {string} "Object <highest+1>", or "Object 1" when none are in use.
 */
export function nextSequentialObjectName(existingNames) {
    return nextSequentialName(existingNames, "Object");
}
