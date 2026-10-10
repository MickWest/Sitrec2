// soundingLayout.js — Reader for a vertical wind profile held in an XML file
// whose layout is not fixed. The installation describes the layout with
// SITREC_CUSTOM_SOUNDING_<NAME>_* settings (see config/shared.env.example), and
// this turns a file that fits one of them into the same SondeData the IGRA2 and
// UWYO parsers in src/ParseSonde.js produce.
//
// SHARED: Sitrec imports this through src/ParseSoundingXML.js, and the XML Wind
// Profile Analyzer (tools/xml-wind/) runs it in the page to check the settings it
// proposes. A tool is served unbundled, so this file imports nothing.
//
// Input is the nested object from parseXml(), not text: each element is an object
// whose keys are its attributes (string values), its child elements (object, or
// array of objects when a tag repeats) and "#text".

export const ENV_PREFIX = "SITREC_CUSTOM_SOUNDING_";
const LAYOUT_KEY = /^SITREC_CUSTOM_SOUNDING_(.+)_LEVEL_TAG$/;

// Unit names are compared lower-case. Each table converts TO the unit SondeData
// uses: metres, metres per second, hPa.
export const LENGTH_TO_M = {m: 1, meters: 1, metres: 1, ft: 0.3048, feet: 0.3048, km: 1000};
// An altitude can also be a flight level: hundreds of feet of PRESSURE altitude. FL x
// 30.48 m is the standard-atmosphere height for the level's pressure, which is the
// height Sitrec gives a level that has only a pressure.
export const ALTITUDE_TO_M = {...LENGTH_TO_M, fl: 30.48};

// The position's elevation is in the altitude unit unless _ELEV_UNITS says otherwise.
// A flight level is not a unit for an elevation; with flight levels it is feet.
export function defaultElevationUnit(altitudeUnit) {
    return altitudeUnit.toLowerCase() === "fl" ? "ft" : altitudeUnit;
}
export const SPEED_TO_MPS = {"m/s": 1, mps: 1, kt: 0.514444, kts: 0.514444, knots: 0.514444, "km/h": 1 / 3.6, kph: 1 / 3.6, mph: 0.44704};
export const PRESSURE_TO_HPA = {hpa: 1, mb: 1, mbar: 1, pa: 0.01, kpa: 10, inhg: 33.8639};
export const TEMP_TO_C = {
    c: degrees => degrees,
    k: kelvin => kelvin - 273.15,
    f: fahrenheit => (fahrenheit - 32) * 5 / 9,
};

// "xyz:Profile/Level" -> ["profile", "level"]. A tag is matched on its local name
// (namespace prefix dropped) without regard to case; a "/" asks for a descendant
// of the element before it, for a layout where the bare name is not unique.
function tagPath(setting) {
    return setting.split("/")
        .map(segment => segment.trim().toLowerCase().replace(/^.*:/, ""))
        .filter(segment => segment !== "");
}

// "weather.example/profile, urn:wx" -> ["weather.example/profile", "urn:wx"]
function substringList(setting) {
    return setting.split(",").map(item => item.trim()).filter(item => item !== "");
}

/**
 * Read every SITREC_CUSTOM_SOUNDING_<NAME>_* layout out of an env object
 * (Globals.env). A layout exists when its _LEVEL_TAG is set. One that also lacks
 * a wind tag, lacks both altitude and pressure, or names a unit this does not
 * know is left out, and each reason is reported.
 *
 * @param {Object} env
 * @param {function(string)} [report] - called with one message for each layout
 *        that is left out (default console.warn)
 * @returns {Object[]} layouts, in env order
 */
export function soundingXMLLayoutsFromEnv(env, report = message => console.warn(message)) {
    const layouts = [];
    if (!env) return layouts;

    for (const key in env) {
        const match = key.match(LAYOUT_KEY);
        if (!match || !env[key]) continue;
        const name = match[1];
        const prefix = `${ENV_PREFIX}${name}_`;

        const setting = (suffix, fallback = "") => {
            const value = env[prefix + suffix];
            if (value === undefined || value === null || String(value).trim() === "") return fallback;
            return String(value).trim();
        };
        const problems = [];
        const unit = (suffix, table, fallback) => {
            const unitName = setting(suffix, fallback);
            const factor = table[unitName.toLowerCase()];
            if (factor === undefined) {
                problems.push(`${prefix}${suffix}="${unitName}" is not one of ${Object.keys(table).join(", ")}`);
            }
            return factor;
        };
        const choice = (suffix, allowed, fallback) => {
            const value = setting(suffix, fallback).toLowerCase();
            if (!allowed.includes(value)) {
                problems.push(`${prefix}${suffix}="${value}" is not one of ${allowed.join(", ")}`);
            }
            return value;
        };

        const altitudeUnits = setting("ALT_UNITS", "m");
        const layout = {
            name,
            label: setting("NAME", name),
            levelTag: tagPath(setting("LEVEL_TAG")),
            altTag: tagPath(setting("ALT_TAG")),
            windDirTag: tagPath(setting("WIND_DIR_TAG")),
            windSpeedTag: tagPath(setting("WIND_SPEED_TAG")),
            pressureTag: tagPath(setting("PRESSURE_TAG")),
            tempTag: tagPath(setting("TEMP_TAG")),
            latTag: tagPath(setting("LAT_TAG", "Latitude")),
            lonTag: tagPath(setting("LON_TAG", "Longitude")),
            elevTag: tagPath(setting("ELEV_TAG", "Elevation")),
            valueTag: tagPath(setting("VALUE_TAG", "Value")),
            timeTag: tagPath(setting("TIME_TAG")),
            xmlnsContains: substringList(setting("XMLNS_CONTAINS")),
            fileContains: substringList(setting("FILE_CONTAINS")),
            altToM: unit("ALT_UNITS", ALTITUDE_TO_M, "m"),
            elevToM: unit("ELEV_UNITS", LENGTH_TO_M, defaultElevationUnit(altitudeUnits)),
            windSpeedToMps: unit("WIND_SPEED_UNITS", SPEED_TO_MPS, "m/s"),
            pressureToHPa: unit("PRESSURE_UNITS", PRESSURE_TO_HPA, "hPa"),
            tempToC: unit("TEMP_UNITS", TEMP_TO_C, "C"),
            altAboveGround: choice("ALT_REFERENCE", ["msl", "agl"], "msl") === "agl",
            windDirIsTo: choice("WIND_DIR_CONVENTION", ["from", "to"], "from") === "to",
            // A weather file can be a forecast or model product, so its profile counts as
            // a model in the traverse wind evidence unless the layout says it is measured.
            measured: choice("DATA_KIND", ["model", "measured"], "model") === "measured",
        };

        if (layout.windDirTag.length === 0) problems.push(`${prefix}WIND_DIR_TAG is not set`);
        if (layout.windSpeedTag.length === 0) problems.push(`${prefix}WIND_SPEED_TAG is not set`);
        if (layout.altTag.length === 0 && layout.pressureTag.length === 0) {
            problems.push(`neither ${prefix}ALT_TAG nor ${prefix}PRESSURE_TAG is set`);
        }

        if (problems.length > 0) {
            report(`Custom sounding layout "${name}" ignored: ${problems.join("; ")}`);
            continue;
        }
        layouts.push(layout);
    }
    return layouts;
}

// ─── Walking the parseXml() object ───────────────────────────────────────

export function* childElements(element) {
    for (const tag in element) {
        const value = element[tag];
        if (Array.isArray(value)) {
            for (const item of value) {
                if (item !== null && typeof item === "object") yield [tag, item];
            }
        } else if (value !== null && typeof value === "object") {
            yield [tag, value];
        }
    }
}

// Lower-case tag name with any namespace prefix removed.
export function localName(tag) {
    const colon = tag.lastIndexOf(":");
    return (colon < 0 ? tag : tag.slice(colon + 1)).toLowerCase();
}

// Every descendant of `element` with the given local name, each with the chain of
// elements above it (outermost first, `element` itself included).
function findByName(element, wanted, ancestors, hits) {
    const chain = [...ancestors, element];
    for (const [tag, child] of childElements(element)) {
        if (localName(tag) === wanted) hits.push({element: child, ancestors: chain});
        findByName(child, wanted, chain, hits);
    }
}

// Every element reached by `path` (lower-case local names) from `element`: each
// segment is a descendant, at any depth, of the one before.
export function findAll(element, path) {
    if (path.length === 0) return [];
    let hits = [{element, ancestors: []}];
    for (const wanted of path) {
        const next = [];
        for (const hit of hits) {
            findByName(hit.element, wanted, hit.ancestors, next);
        }
        hits = next;
    }
    return hits;
}

export function textOf(element) {
    const text = element["#text"];
    return typeof text === "string" ? text.trim() : "";
}

// The value of a field element: its own text, or failing that the text of the
// <Value> (layout.valueTag) element inside it.
function valueText(element, layout) {
    const own = textOf(element);
    if (own !== "") return own;
    const hit = findAll(element, layout.valueTag)[0];
    return hit ? textOf(hit.element) : "";
}

function readNumber(parent, path, layout) {
    const hit = findAll(parent, path)[0];
    if (!hit) return null;
    const number = parseFloat(valueText(hit.element, layout));
    return Number.isFinite(number) ? number : null;
}

// A hemisphere given apart from the number, in whatever attribute or child the
// file uses for it: any string under the element that is exactly N, S, E or W
// (or the word).
const SENSE = /^(n|s|e|w|north|south|east|west)$/i;

export function findSense(element) {
    for (const key in element) {
        const value = element[key];
        if (typeof value === "string") {
            if (SENSE.test(value.trim())) return value.trim()[0].toUpperCase();
        }
    }
    for (const [, child] of childElements(element)) {
        const sense = findSense(child);
        if (sense) return sense;
    }
    return null;
}

/**
 * Decimal degrees with an optional sign and an optional hemisphere letter at
 * either end: "34.5", "-117.25", "34.5 N", "W117.25". A minus or an S/W makes it
 * negative. This is the reader the analyzer tool uses; Sitrec passes its own
 * (parseSingleCoordinate), which also reads degrees, minutes and seconds.
 *
 * @param {string} text
 * @returns {number|null}
 */
export function parseDecimalCoordinate(text) {
    const match = String(text).trim().match(/^([NSEW])?\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+))\s*°?\s*([NSEW])?$/i);
    if (!match) return null;
    const magnitude = Math.abs(Number(match[2]));
    const letter = (match[1] ?? match[3] ?? "").toUpperCase();
    const negative = match[2].startsWith("-") || letter === "S" || letter === "W";
    if (magnitude === 0) return 0;
    return negative ? -magnitude : magnitude;
}

export function readCoordinate(element, layout, parseCoordinate = parseDecimalCoordinate) {
    const text = valueText(element, layout);
    if (text === "") return null;
    const sense = /[NSEW]/i.test(text) ? null : findSense(element);
    return parseCoordinate(sense ? `${text} ${sense}` : text);
}

// The longitude or elevation that goes with a latitude. `triple` is the element
// that holds the latitude, so the first place to look is its own children: a
// sibling of the latitude, by the last name of the setting. (With a path setting,
// "Site/Longitude", the names before the last one say where that parent is, and
// the search is already inside it.) Only if no sibling has the name is anything
// deeper taken, so a <Longitude> nested in some other child never wins over the
// one beside the latitude.
function findBeside(triple, path) {
    if (path.length === 0) return null;
    const wanted = path[path.length - 1];
    for (const [tag, child] of childElements(triple)) {
        if (localName(tag) === wanted) return {element: child, ancestors: [triple]};
    }
    return findAll(triple, path)[0] ?? findAll(triple, [wanted])[0] ?? null;
}

// A longitude given as 0 to 360 (common in weather data) taken to -180 to 180, as
// every other position in Sitrec is.
export function signedLongitude(lon) {
    return lon >= 180 ? lon - 360 : lon;
}

// The position that belongs to the profile: the Latitude/Longitude pair found in
// the nearest element that encloses the levels. A file can hold other positions
// (other data objects); one further out is used only when nothing nearer exists.
function findPosition(levelHit, layout, parseCoordinate) {
    for (let i = levelHit.ancestors.length - 1; i >= 0; i--) {
        for (const latHit of findAll(levelHit.ancestors[i], layout.latTag)) {
            const triple = latHit.ancestors[latHit.ancestors.length - 1];
            const lonHit = findBeside(triple, layout.lonTag);
            if (!lonHit) continue;
            const lat = readCoordinate(latHit.element, layout, parseCoordinate);
            const lon = readCoordinate(lonHit.element, layout, parseCoordinate);
            if (lat === null || lon === null) continue;
            const elevationHit = findBeside(triple, layout.elevTag);
            const elevationNumber = elevationHit ? parseFloat(valueText(elevationHit.element, layout)) : NaN;
            const elevation = Number.isFinite(elevationNumber) ? elevationNumber : null;
            return {lat, lon: signedLongitude(lon), elev: elevation === null ? 0 : elevation * layout.elevToM};
        }
    }
    return null;
}

function readTime(xml, layout, defaultDate) {
    const hit = findAll(xml, layout.timeTag)[0];
    if (!hit) return defaultDate;
    let text = valueText(hit.element, layout);
    // A date-time with no zone is UTC, not the browser's local time.
    if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(text) && !/(Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
        text = text.replace(" ", "T") + "Z";
    }
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? defaultDate : date;
}

/**
 * Read one position and one vertical profile from a parsed XML file.
 *
 * @param {Object} xml - parseXml() output
 * @param {Object} layout - one entry from soundingXMLLayoutsFromEnv()
 * @param {Date} [defaultDate] - profile time when the layout has no time tag, or
 *        the file has no readable time
 * @param {function(string): number|null} [parseCoordinate] - reads one latitude
 *        or longitude from text
 * @returns {Object|null} SondeData (see src/ParseSonde.js); null if the file does
 *          not fit the layout: no position, or fewer than two levels, or no wind
 */
export function parseSoundingXML(xml, layout, defaultDate = new Date(), parseCoordinate = parseDecimalCoordinate) {
    const levelHits = findAll(xml, layout.levelTag);
    if (levelHits.length < 2) return null;

    // One profile: the levels that sit beside the first one.
    const profileElement = levelHits[0].ancestors[levelHits[0].ancestors.length - 1];
    const profileHits = levelHits.filter(hit => hit.ancestors[hit.ancestors.length - 1] === profileElement);

    const position = findPosition(levelHits[0], layout, parseCoordinate);
    if (!position) return null;

    const levels = [];
    for (const hit of profileHits) {
        const altitude = readNumber(hit.element, layout.altTag, layout);
        const pressure = readNumber(hit.element, layout.pressureTag, layout);
        if (altitude === null && pressure === null) continue;

        const windDir = readNumber(hit.element, layout.windDirTag, layout);
        const windSpeed = readNumber(hit.element, layout.windSpeedTag, layout);
        const temp = readNumber(hit.element, layout.tempTag, layout);

        levels.push({
            time_s: null,
            pressure: pressure === null ? null : pressure * layout.pressureToHPa,
            height: altitude === null ? null
                : altitude * layout.altToM + (layout.altAboveGround ? position.elev : 0),
            temp: temp === null ? null : layout.tempToC(temp),
            rh: null,
            dewpoint: null,
            windDir: windDir === null ? null
                : (((layout.windDirIsTo ? windDir + 180 : windDir) % 360) + 360) % 360,
            windSpeed: windSpeed === null ? null : windSpeed * layout.windSpeedToMps,
            lat: null,
            lon: null,
        });
    }

    if (levels.length < 2) return null;
    if (!levels.some(level => level.windDir !== null && level.windSpeed !== null)) return null;

    return {
        station: {lat: position.lat, lon: position.lon, elev: position.elev, id: layout.name, name: layout.label},
        datetime: readTime(xml, layout, defaultDate),
        levels,
        source: "xml",
        measured: layout.measured,
        hasGPS: false,
    };
}

// ─── Which layout a file is ──────────────────────────────────────────────

// The value of every namespace declaration (xmlns="..." or xmlns:prefix="...")
// in the file. parseXml() keeps them as ordinary attributes.
export function collectNamespaces(element, namespaces = []) {
    for (const key in element) {
        const value = element[key];
        if (typeof value === "string" && (key === "xmlns" || key.startsWith("xmlns:"))) {
            namespaces.push(value);
        }
    }
    for (const [, child] of childElements(element)) {
        collectNamespaces(child, namespaces);
    }
    return namespaces;
}

/**
 * True if the layout has identifying substrings and one of them is in the file.
 * @param {string[]} namespaces - from collectNamespaces()
 */
export function layoutIdentifiesFile(layout, namespaces, sourceText) {
    return layout.xmlnsContains.some(wanted => namespaces.some(namespace => namespace.includes(wanted)))
        || layout.fileContains.some(wanted => sourceText.includes(wanted));
}

/**
 * Find the layout for a file and read it.
 *
 * A layout that has _XMLNS_CONTAINS or _FILE_CONTAINS is chosen by those alone:
 * any one of its substrings in a namespace declaration, or anywhere in the file
 * text, says the file IS that format. The first such layout to match is used and
 * no other is tried; if the file then cannot be read with it, that is reported,
 * because the settings and the file disagree.
 *
 * A layout with neither setting has nothing to identify it, so it is tried on
 * every file that no other layout claimed, and is used if the file fits it.
 *
 * @param {Object} xml - parseXml() output
 * @param {Object[]} layouts - from soundingXMLLayoutsFromEnv()
 * @param {Date} [defaultDate]
 * @param {string} [sourceText] - the file as text, for _FILE_CONTAINS
 * @param {function(string): number|null} [parseCoordinate]
 * @param {function(string)} [report] - called when an identified file cannot be
 *        read (default console.warn)
 * @returns {Object|null} SondeData
 */
export function findSoundingXML(xml, layouts, defaultDate, sourceText = "",
                                parseCoordinate = parseDecimalCoordinate,
                                report = message => console.warn(message)) {
    let namespaces = null;
    for (const layout of layouts) {
        if (layout.xmlnsContains.length === 0 && layout.fileContains.length === 0) continue;
        namespaces ??= collectNamespaces(xml);
        if (!layoutIdentifiesFile(layout, namespaces, sourceText)) continue;

        const sonde = parseSoundingXML(xml, layout, defaultDate, parseCoordinate);
        if (!sonde) {
            report(`Custom sounding layout "${layout.name}" identified this file, but found no position `
                + `with at least two levels and a wind in it. Check the ${ENV_PREFIX}${layout.name}_*_TAG settings.`);
        }
        return sonde;
    }

    for (const layout of layouts) {
        if (layout.xmlnsContains.length > 0 || layout.fileContains.length > 0) continue;
        const sonde = parseSoundingXML(xml, layout, defaultDate, parseCoordinate);
        if (sonde) return sonde;
    }
    return null;
}
