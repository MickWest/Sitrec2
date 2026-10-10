// analyze.js — Look through an XML file of unknown layout for a position
// (latitude, longitude, elevation) and a vertical wind profile, and propose the
// SITREC_CUSTOM_SOUNDING_<NAME>_* settings that make Sitrec read it.
//
// Everything here is a heuristic over tag names and value ranges, so each finding
// carries the evidence it rests on, and the proposed settings are then run through
// the real reader (soundingLayout.js) to show what Sitrec would get.
//
// Pure: no DOM, no network. Input is the object from xmlToObject().

import {
    ALTITUDE_TO_M,
    ENV_PREFIX,
    LENGTH_TO_M,
    PRESSURE_TO_HPA,
    childElements,
    collectNamespaces,
    defaultElevationUnit,
    findAll,
    findSense,
    findSoundingXML,
    layoutIdentifiesFile,
    localName,
    parseDecimalCoordinate,
    signedLongitude,
    soundingXMLLayoutsFromEnv,
    textOf,
} from "./soundingLayout.js";
import {parseEnvText} from "../src/envText.js";

export {parseEnvText};

// Namespaces that every schema-validated file declares; they identify nothing.
const COMMON_NAMESPACE = /^http:\/\/www\.w3\.org\//;

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

// ─── Indexing the file ───────────────────────────────────────────────────

// "wx:Level" -> "Level"
function plainName(tag) {
    const colon = tag.lastIndexOf(":");
    return colon < 0 ? tag : tag.slice(colon + 1);
}

// One node for each element: {element, tag, name, local, parent, children}.
function indexElements(xml) {
    const nodes = [];
    const visit = (element, tag, parent) => {
        if (tag.startsWith("#")) return;        // a comment
        const node = {element, tag, name: plainName(tag), local: localName(tag), parent, children: []};
        nodes.push(node);
        if (parent) parent.children.push(node);
        for (const [childTag, child] of childElements(element)) visit(child, childTag, node);
    };
    for (const [tag, child] of childElements(xml)) visit(child, tag, null);
    return nodes;
}

function isNumeric(text) {
    return Number.isFinite(parseFloat(text));
}

function isInside(node, ancestor) {
    for (let at = node; at; at = at.parent) {
        if (at === ancestor) return true;
    }
    return false;
}

// "Report/DataObject/VerticalProfile"
function pathOf(node) {
    const names = [];
    for (let at = node; at; at = at.parent) names.unshift(at.name);
    return names.join("/");
}

// The element that holds a field's number when the field does not hold it itself:
// <WindSpeed><Value>25</Value></WindSpeed>. Found by structure, not by name: a leaf
// that turns up under three or more differently named parents, mostly with a
// number in it, is a wrapper rather than a field.
function findValueTag(nodes) {
    const leaves = new Map();
    for (const node of nodes) {
        if (node.children.length > 0 || !node.parent) continue;
        const text = textOf(node.element);
        if (text === "") continue;
        const entry = leaves.get(node.local) ?? {name: node.name, parents: new Set(), count: 0, numeric: 0};
        entry.parents.add(node.parent.local);
        entry.count++;
        if (isNumeric(text)) entry.numeric++;
        leaves.set(node.local, entry);
    }
    let best = null;
    for (const [local, entry] of leaves) {
        if (entry.parents.size < 3 || entry.numeric < entry.count / 2) continue;
        if (!best || entry.count > best.count) best = {local, name: entry.name, count: entry.count};
    }
    return best;
}

// The text of a field, or null if the node is not a field. A field is a leaf with
// text, or an element with the value tag directly inside it.
function fieldText(node, valueLocal) {
    if (node.local === valueLocal) return null;
    if (node.children.length === 0) {
        const text = textOf(node.element);
        return text === "" ? null : text;
    }
    const valueNode = node.children.find(child => child.local === valueLocal);
    if (!valueNode) return null;
    const text = textOf(valueNode.element);
    return text === "" ? null : text;
}

// Unit strings the file gives for a field: a uom/unit attribute on the field or
// on its value element, or a <Units>-like element inside the field.
function unitHints(node, valueLocal) {
    const hints = [];
    const fromAttributes = element => {
        for (const key in element) {
            if (typeof element[key] === "string" && /uom|unit/i.test(key)) hints.push(element[key].trim());
        }
    };
    fromAttributes(node.element);
    for (const child of node.children) {
        if (child.local === valueLocal) {
            fromAttributes(child.element);
        } else if (/uom|unit/.test(child.local) && child.children.length === 0) {
            const text = textOf(child.element);
            if (text !== "") hints.push(text);
        }
    }
    return hints;
}

// ─── Repeating groups and what their fields are ──────────────────────────

// The fields inside one record, keyed by their path from the record
// ("windspeed", "wind/speed").
function recordFields(record, valueLocal) {
    const fields = new Map();
    const visit = (node, path) => {
        for (const child of node.children) {
            const childPath = [...path, child];
            const text = fieldText(child, valueLocal);
            if (text !== null) {
                const key = childPath.map(step => step.local).join("/");
                if (!fields.has(key)) fields.set(key, {node: child, path: childPath, text});
            } else {
                visit(child, childPath);
            }
        }
    };
    visit(record, []);
    return fields;
}

function monotonic(numbers) {
    if (numbers.length < 2) return "none";
    let up = true, down = true;
    for (let i = 1; i < numbers.length; i++) {
        if (numbers[i] < numbers[i - 1]) up = false;
        if (numbers[i] > numbers[i - 1]) down = false;
    }
    if (numbers[0] === numbers[numbers.length - 1]) return "none";
    return up ? "increasing" : down ? "decreasing" : "none";
}

// Every element name that occurs two or more times under one parent, with two or
// more fields in it: a table of records, one of which may be the profile.
function findGroups(nodes, valueLocal) {
    const groups = [];
    for (const parent of nodes) {
        const byName = new Map();
        for (const child of parent.children) {
            if (!byName.has(child.local)) byName.set(child.local, []);
            byName.get(child.local).push(child);
        }
        for (const records of byName.values()) {
            if (records.length < 2) continue;
            const perRecord = records.map(record => recordFields(record, valueLocal));
            if (perRecord[0].size < 2) continue;

            const fields = [];
            for (const [key, first] of perRecord[0]) {
                const texts = perRecord.map(recordMap => recordMap.get(key)?.text ?? null);
                const numbers = texts.filter(text => text !== null && isNumeric(text)).map(parseFloat);
                const hints = new Set();
                for (const recordMap of perRecord) {
                    const field = recordMap.get(key);
                    if (field) unitHints(field.node, valueLocal).forEach(hint => hints.add(hint));
                }
                fields.push({
                    key,
                    name: first.path.map(step => step.name).join("/"),
                    node: first.node,
                    texts,
                    numbers,
                    allNumeric: numbers.length === records.length,
                    min: numbers.length ? Math.min(...numbers) : null,
                    max: numbers.length ? Math.max(...numbers) : null,
                    trend: numbers.length === records.length ? monotonic(numbers) : "none",
                    unitHints: [...hints],
                    role: null,
                    evidence: null,
                });
            }
            groups.push({parent, records, name: records[0].name, local: records[0].local, fields, roles: {}});
        }
    }
    return groups;
}

// What each role looks like: a name pattern, and a test on the values that a
// field of that kind must pass. `trend` is true for a quantity that must run one
// way up the column.
const ROLES = [
    {role: "windDir", label: "wind direction",
        name: /dir|drct|bearing|azimuth/, not: /gust|shear/,
        valid: field => mostly(field, number => number >= 0 && number <= 360)},
    {role: "windSpeed", label: "wind speed",
        name: /speed|spd|sped|sknt|veloc|knot/, not: /gust|shear|vertical|ascent/,
        valid: field => mostly(field, number => number >= 0)},
    {role: "pressure", label: "air pressure",
        name: /pres|baro|hpa|mbar/, not: /alt|height|present/,
        valid: field => field.numbers.length >= 2 && field.min > 0, trend: true},
    {role: "temperature", label: "temperature",
        name: /temp|oat/, not: /dew|virtual|potential/,
        valid: field => field.numbers.length >= 2},
    {role: "altitude", label: "altitude",
        name: /alt|height|hght|hgt|elev|geopot|flight_?level|(^|\/)fl$/, not: /dens/,
        valid: field => field.numbers.length >= 2, trend: true},
];

// A tag that holds a flight level: hundreds of feet of pressure altitude, read with
// _ALT_UNITS=fl.
const FLIGHT_LEVEL = /flight_?level|(^|\/)fl$/;

// True if the field has two or more numbers and at least four in five pass the
// test. Not all: a file can mark a missing value with a number such as -9999.
function mostly(field, test) {
    if (field.numbers.length < 2) return false;
    return field.numbers.filter(test).length >= field.numbers.length * 0.8;
}

function assignRoles(group) {
    for (const {role, name, not, valid, trend} of ROLES) {
        let best = null;
        for (const field of group.fields) {
            if (field.role || !name.test(field.key) || not.test(field.key) || !valid(field)) continue;
            const runsOneWay = trend && field.trend !== "none";
            const score = runsOneWay ? 2 : 1;
            if (!best || score > best.score) {
                best = {field, score, evidence: trend
                    ? (runsOneWay ? "tag name, and the values run one way up the column" : "tag name only: the values do not run one way")
                    : "tag name, and the values are in range"};
            }
        }
        if (best) {
            best.field.role = role;
            best.field.evidence = best.evidence;
            group.roles[role] = best.field;
        }
    }

    // No tag looks like an altitude: take the column that rises steadily over the
    // widest range, if there is one. A guess, and said to be one.
    if (!group.roles.altitude && !group.roles.pressure) {
        let best = null;
        for (const field of group.fields) {
            if (field.role || field.trend !== "increasing") continue;
            if (!best || field.max - field.min > best.max - best.min) best = field;
        }
        if (best) {
            best.role = "altitude";
            best.evidence = "GUESS from the values only: this is the column that rises steadily";
            group.roles.altitude = best;
        }
    }

    const has = role => group.roles[role] ? 1 : 0;
    group.isProfile = !!(group.roles.windDir && group.roles.windSpeed && (group.roles.altitude || group.roles.pressure));
    group.score = 3 * has("windDir") + 3 * has("windSpeed") + 2 * has("altitude") + has("pressure") + has("temperature");
}

// ─── Positions ───────────────────────────────────────────────────────────

function readCoordinateNode(node, text) {
    const sense = /[NSEW]/i.test(text) ? null : findSense(node.element);
    return {node, text, sense, value: parseDecimalCoordinate(sense ? `${text} ${sense}` : text)};
}

// Every latitude that has a longitude beside it. A tag is taken for a latitude
// if its name has "lat" in it, its value is a coordinate in range, and the same
// parent holds a tag with "lon" or "lng" in its name whose value is too. The
// elevation is a third tag in that parent with a number in it.
function findPositions(nodes, valueLocal) {
    const positions = [];

    for (const node of nodes) {
        if (!node.parent || !node.local.includes("lat")) continue;
        const latText = fieldText(node, valueLocal);
        if (latText === null) continue;
        const lat = readCoordinateNode(node, latText);
        if (lat.value === null || Math.abs(lat.value) > 90) continue;

        const beside = node.parent.children.filter(other => other !== node && fieldText(other, valueLocal) !== null);
        const lonNode = beside.find(other => /lon|lng/.test(other.local) && !other.local.includes("lat"));
        if (!lonNode) continue;
        const lon = readCoordinateNode(lonNode, fieldText(lonNode, valueLocal));
        if (lon.value === null || lon.value < -180 || lon.value > 360) continue;

        const elevNode = beside.find(other => other !== lonNode
            && /elev|alt|height|hgt|hae|msl/.test(other.local) && isNumeric(fieldText(other, valueLocal)));
        const elev = elevNode ? {
            node: elevNode,
            text: fieldText(elevNode, valueLocal),
            value: parseFloat(fieldText(elevNode, valueLocal)),
            unitHints: unitHints(elevNode, valueLocal),
        } : null;

        positions.push({parent: node.parent, lat, lon, elev});
    }
    return positions;
}

// The position Sitrec takes: the first one in the nearest element that encloses
// the levels (see findPosition in soundingLayout.js).
function positionForProfile(positions, profile) {
    for (let ancestor = profile.parent; ancestor; ancestor = ancestor.parent) {
        const found = positions.find(position => isInside(position.lat.node, ancestor));
        if (found) return found;
    }
    return positions.find(() => true) ?? null;
}

// ─── Units ───────────────────────────────────────────────────────────────

const UNIT_WORDS = {
    length: [[/^(ft|feet|foot|\[ft_i\])$/i, "ft"], [/^(m|meter|metre|meters|metres)$/i, "m"], [/^(km|kilometers?|kilometres?)$/i, "km"]],
    speed: [[/^(kt|kts|kn|knot|knots|\[kn_i\])$/i, "kt"], [/^(m\/s|mps|ms-1|m s-1)$/i, "m/s"],
        [/^(km\/h|kph|kmh)$/i, "km/h"], [/^mph$/i, "mph"]],
    pressure: [[/^(hpa|mb|mbar|millibars?)$/i, "hPa"], [/^pa$/i, "Pa"], [/^kpa$/i, "kPa"], [/^(inhg|in hg|\[in_i'hg\])$/i, "inHg"]],
    temperature: [[/^(c|°c|degc|cel|celsius)$/i, "C"], [/^(k|kelvin)$/i, "K"], [/^(f|°f|degf|fahrenheit|\[degf\])$/i, "F"]],
};

function unitFromHints(hints, kind) {
    for (const hint of hints) {
        for (const [pattern, unit] of UNIT_WORDS[kind]) {
            if (pattern.test(hint)) return unit;
        }
    }
    return null;
}

function isKnownUnit(hint) {
    return Object.values(UNIT_WORDS).some(patterns => patterns.some(([pattern]) => pattern.test(hint)));
}

function standardHeightM(pressureHPa) {
    return 44330 * (1 - Math.pow(pressureHPa / 1013.25, 0.1903));
}

function median(numbers) {
    const sorted = [...numbers].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

// The unit of each quantity: {unit, source} where source says how it is known.
// "file" = the file states it. "name" = the tag name says it (a flight level).
// "values" = inferred from the numbers, which is a guess. "default" = nothing to go on.
function findUnits(profile, position) {
    const roles = profile.roles;
    const units = {};

    if (roles.pressure) {
        const stated = unitFromHints(roles.pressure.unitHints, "pressure");
        const max = roles.pressure.max;
        const inferred = max >= 30000 ? "Pa" : max >= 250 ? "hPa" : max >= 50 ? "kPa" : max >= 8 ? "inHg" : null;
        units.pressure = stated ? {unit: stated, source: "file"}
            : inferred ? {unit: inferred, source: "values", why: "the size of the largest value"}
            : {unit: "hPa", source: "default"};
    }

    if (roles.altitude && FLIGHT_LEVEL.test(roles.altitude.key)) {
        units.altitude = {unit: "fl", source: "name", why: "the tag name says flight level"};
    } else if (roles.altitude) {
        const stated = unitFromHints(roles.altitude.unitHints, "length");
        let inferred = null;
        if (!stated && roles.pressure && roles.altitude.allNumeric && roles.pressure.allNumeric) {
            // Altitude against the standard-atmosphere height for the same pressure.
            const toHPa = PRESSURE_TO_HPA[units.pressure.unit.toLowerCase()];
            const ratios = [];
            roles.altitude.numbers.forEach((altitude, i) => {
                const standard = standardHeightM(roles.pressure.numbers[i] * toHPa);
                if (standard > 500 && altitude > 0) ratios.push(altitude / standard);
            });
            if (ratios.length > 0) {
                const ratio = median(ratios);
                if (ratio > 0.8 && ratio < 1.25) inferred = "m";
                else if (ratio > 2.6 && ratio < 4.1) inferred = "ft";
            }
        }
        units.altitude = stated ? {unit: stated, source: "file"}
            : inferred ? {unit: inferred, source: "values", why: "altitude against pressure fits the standard atmosphere in this unit"}
            : {unit: "m", source: "default"};
    }

    const speedStated = unitFromHints(roles.windSpeed.unitHints, "speed");
    units.windSpeed = speedStated ? {unit: speedStated, source: "file"} : {unit: "m/s", source: "default"};

    if (roles.temperature) {
        const stated = unitFromHints(roles.temperature.unitHints, "temperature");
        units.temperature = stated ? {unit: stated, source: "file"}
            : roles.temperature.max > 150 ? {unit: "K", source: "values", why: "the size of the largest value"}
            : {unit: "C", source: "default"};
    }

    if (position?.elev) {
        const stated = unitFromHints(position.elev.unitHints, "length");
        units.elevation = stated ? {unit: stated, source: "file"}
            : {unit: defaultElevationUnit((units.altitude ?? {unit: "m"}).unit), source: "default"};
    }
    return units;
}

// ─── Proposed settings ───────────────────────────────────────────────────

// The shortest tag setting that the reader resolves to `target` when it starts
// from `scope`: the element's own name, or with enough of the names above it
// ("Wind/Speed") to pass over another element of the same name.
function tagSetting(scope, pathNodes, target) {
    for (let length = 1; length <= pathNodes.length; length++) {
        const tail = pathNodes.slice(-length);
        const hit = findAll(scope, tail.map(node => node.local))[0];
        if (hit && hit.element === target) return tail.map(node => node.name).join("/");
    }
    return pathNodes.map(node => node.name).join("/");
}

function pathNodesTo(node, stopAt) {
    const path = [];
    for (let at = node; at && at !== stopAt; at = at.parent) path.unshift(at);
    return path;
}

// The namespace URI in scope for a tag at a node: xmlns:prefix or xmlns on the
// node or the nearest element above it.
function namespaceOf(node) {
    const colon = node.tag.lastIndexOf(":");
    const attribute = colon < 0 ? "xmlns" : `xmlns:${node.tag.slice(0, colon)}`;
    for (let at = node; at; at = at.parent) {
        if (typeof at.element[attribute] === "string") return at.element[attribute];
    }
    return null;
}

function proposeSettings(xml, nodes, analysis) {
    const {profile, position, valueTag, units, root} = analysis;
    const layoutName = root.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "WX";
    const prefix = `${ENV_PREFIX}${layoutName}_`;
    const entries = [];
    const add = (suffix, value, check = null) => entries.push({key: prefix + suffix, value, check});

    add("NAME", root.name);

    // Identification.
    const namespace = namespaceOf(profile.records[0]) ?? namespaceOf(nodes[0]);
    const others = analysis.namespaces.map(entry => entry.uri).filter(uri => !COMMON_NAMESPACE.test(uri));
    if (namespace && !COMMON_NAMESPACE.test(namespace)) {
        add("XMLNS_CONTAINS", namespace,
            "the namespace of the level elements. Shorten it (drop a version number) if other versions of the file must match too.");
    } else if (others.length > 0) {
        add("XMLNS_CONTAINS", others[0], "CHECK: the level elements have no namespace; this is the first one the file declares.");
    } else {
        add("FILE_CONTAINS", `<${nodes[0].tag}`,
            "CHECK: the file declares no namespace, so this is the opening of its root element. "
            + "Use a string that no other XML file your users load will have.");
    }

    // The levels and their fields.
    const firstRecord = profile.records[0];
    add("LEVEL_TAG", tagSetting(xml, pathNodesTo(firstRecord, null), firstRecord.element));

    const fieldTag = field => tagSetting(firstRecord.element, pathNodesTo(field.node, firstRecord), field.node.element);
    const unitCheck = (found, what) => found.source === "file" ? null
        : found.source === "values" ? `CHECK: ${what} unit is a GUESS from the values (${found.why}).`
        : found.source === "name" ? `CHECK: ${what} unit is from the tag name (${found.why}).`
        : `CHECK: the file does not state the ${what} unit. This is Sitrec's default, not a finding.`;

    if (profile.roles.altitude) {
        add("ALT_TAG", fieldTag(profile.roles.altitude),
            profile.roles.altitude.evidence.startsWith("GUESS") ? `CHECK: ${profile.roles.altitude.evidence}.` : null);
        add("ALT_UNITS", units.altitude.unit, unitCheck(units.altitude, "altitude"));
    }
    add("WIND_DIR_TAG", fieldTag(profile.roles.windDir));
    add("WIND_SPEED_TAG", fieldTag(profile.roles.windSpeed));
    add("WIND_SPEED_UNITS", units.windSpeed.unit, unitCheck(units.windSpeed, "wind speed"));
    if (profile.roles.pressure) {
        add("PRESSURE_TAG", fieldTag(profile.roles.pressure));
        add("PRESSURE_UNITS", units.pressure.unit, unitCheck(units.pressure, "pressure"));
    }
    if (profile.roles.temperature) {
        add("TEMP_TAG", fieldTag(profile.roles.temperature));
        add("TEMP_UNITS", units.temperature.unit, unitCheck(units.temperature, "temperature"));
    }

    // The position. Sitrec's defaults are Latitude, Longitude, Elevation and Value.
    if (position) {
        if (position.lat.node.local !== "latitude") add("LAT_TAG", position.lat.node.name);
        if (position.lon.node.local !== "longitude") add("LON_TAG", position.lon.node.name);
        if (position.elev) {
            if (position.elev.node.local !== "elevation") add("ELEV_TAG", position.elev.node.name);
            if (units.elevation.unit !== defaultElevationUnit(units.altitude?.unit ?? "m")) add("ELEV_UNITS", units.elevation.unit);
        }
    }
    if (valueTag && valueTag.local !== "value") add("VALUE_TAG", valueTag.name);

    return {layoutName, prefix, entries};
}

/**
 * The proposed settings as shared.env text. A "# CHECK" line above a setting
 * marks one that a person must confirm.
 */
export function settingsText(settings, fileName = "") {
    const lines = [`# Proposed by the XML Wind Profile Analyzer${fileName ? ` from ${fileName}` : ""}.`,
        "# Confirm each line marked CHECK before you use these."];
    for (const entry of settings.entries) {
        if (entry.check) lines.push(`# ${entry.check}`);
        lines.push(`${entry.key}=${/[\s#]/.test(entry.value) ? `"${entry.value}"` : entry.value}`);
    }
    return lines.join("\n") + "\n";
}

// ─── The analysis ────────────────────────────────────────────────────────

/**
 * @param {Object} xml - xmlToObject() output
 * @param {string} [sourceText] - the file as text
 * @returns {Object} analysis: root, namespaces, valueTag, positions, groups,
 *          profile (the group taken for the vertical profile, or null), position
 *          (the one that belongs to it, or null), units, times, settings, check
 *          (the file read with those settings), notes. No note quotes a value
 *          from the file.
 */
export function analyzeXML(xml, sourceText = "") {
    const nodes = indexElements(xml);
    if (nodes.length === 0) return null;

    const root = nodes[0];
    const namespaces = [];
    for (const node of nodes) {
        for (const key in node.element) {
            if (typeof node.element[key] === "string" && (key === "xmlns" || key.startsWith("xmlns:"))) {
                const prefix = key === "xmlns" ? "(default)" : key.slice(6);
                if (!namespaces.some(entry => entry.prefix === prefix && entry.uri === node.element[key])) {
                    namespaces.push({prefix, uri: node.element[key]});
                }
            }
        }
    }

    const valueTag = findValueTag(nodes);
    const valueLocal = valueTag?.local ?? null;

    const groups = findGroups(nodes, valueLocal);
    groups.forEach(assignRoles);
    groups.sort((a, b) => b.score - a.score || b.records.length - a.records.length);
    const profile = groups.find(group => group.isProfile) ?? null;

    const positions = findPositions(nodes, valueLocal);
    for (const position of positions) {
        position.path = pathOf(position.parent);
        position.insideLevel = !!profile && profile.records.some(record => isInside(position.parent, record));
    }
    const position = profile ? positionForProfile(positions, profile) : null;

    const times = [];
    for (const node of nodes) {
        const text = fieldText(node, valueLocal);
        if (text !== null && ISO_DATE_TIME.test(text) && !times.some(time => time.name === node.name)) {
            times.push({name: node.name, text, path: pathOf(node)});
        }
    }

    const analysis = {
        root: {tag: root.tag, name: root.name},
        elementCount: nodes.length,
        namespaces,
        valueTag,
        groups,
        profile,
        positions,
        position,
        times,
        units: null,
        settings: null,
        check: null,
        notes: [],
    };
    for (const group of groups) group.path = pathOf(group.parent);

    if (!profile) {
        analysis.notes.push("No vertical wind profile found: no repeating element has a wind direction, "
            + "a wind speed, and an altitude or pressure in it.");
        return analysis;
    }
    if (!position) {
        analysis.notes.push("No position found: no element has a latitude with a longitude beside it. "
            + "Sitrec needs one to place the profile.");
    }

    analysis.units = findUnits(profile, position);
    analysis.settings = proposeSettings(xml, nodes, analysis);

    // Things a person must decide, because the file cannot say.
    const notes = analysis.notes;
    notes.push("Wind direction is read as the direction the wind blows FROM, in degrees true. "
        + "If the file gives the direction the wind blows TO, add _WIND_DIR_CONVENTION=to.");
    notes.push("The traverse wind evidence counts this profile as a model or forecast. "
        + "If the file holds measurements (a sounding), add _DATA_KIND=measured.");
    const altitude = profile.roles.altitude;
    if (altitude && analysis.units.altitude.unit === "fl") {
        notes.push(`<${altitude.node.name}> is read as flight levels: hundreds of feet of pressure altitude. `
            + "Sitrec takes each as the standard-atmosphere height for its pressure (FL x 30.48 m), the height "
            + "it gives a level that has only a pressure.");
    }
    if (altitude && position?.elev && altitude.min !== null) {
        const toM = ALTITUDE_TO_M[analysis.units.altitude.unit.toLowerCase()];
        const elevToM = LENGTH_TO_M[analysis.units.elevation.unit.toLowerCase()];
        const lowestM = altitude.min * toM;
        const elevM = position.elev.value * elevToM;
        if (elevM > 100 && lowestM < elevM / 2) {
            notes.push("The lowest level is far below the elevation of the position. "
                + "The altitudes may be heights above the ground: if so, add _ALT_REFERENCE=agl. This is a guess from the values.");
        }
    }
    if (positions.length > 1) {
        notes.push(`The file has ${positions.length} positions. Sitrec takes the one nearest the levels in the XML tree `
            + `(${position ? position.path : "none"}).`);
    }
    if (times.length > 0) {
        notes.push(`The file has date-times (${times.slice(0, 4).map(time => time.name).join(", ")}). `
            + "To take the time of the profile from one of them, add _TIME_TAG=<its tag>. Without it the profile takes the start time of the sitch.");
    }
    for (const role of ["windDir", "windSpeed"]) {
        const field = profile.roles[role];
        const limit = role === "windDir" ? 360 : Infinity;
        if (field.numbers.some(number => number < 0 || number > limit)) {
            notes.push(`Some <${field.node.name}> values are out of range. The file may mark a missing value with a number `
                + "such as -9999. Sitrec reads such a marker as a real value.");
        }
    }
    if (profile.fields.some(field => field.role && !field.allNumeric)) {
        notes.push("Some levels have no number in a field. Sitrec reads such a field as absent at that level.");
    }

    // Read the file with the proposed settings, and say so if the reader does not
    // get what the analysis found.
    analysis.check = checkSettings(xml, sourceText, settingsText(analysis.settings));
    const sonde = analysis.check.sonde;
    if (!sonde) {
        notes.push("WARNING: the reader found nothing with the proposed settings. Edit them and check again.");
    } else {
        if (position && (Math.abs(sonde.station.lat - position.lat.value) > 1e-9
            || Math.abs(sonde.station.lon - signedLongitude(position.lon.value)) > 1e-9)) {
            notes.push("WARNING: with the proposed settings the reader takes a different position from the one found here. "
                + "Give _LAT_TAG and _LON_TAG as a path (for example Position/Latitude).");
        }
        if (sonde.levels.length !== profile.records.length) {
            notes.push(`With the proposed settings the reader takes ${sonde.levels.length} of the ${profile.records.length} levels. `
                + "A level with no altitude and no pressure is left out.");
        }
    }
    return analysis;
}

// ─── Checking settings against the file ──────────────────────────────────

/**
 * Read the file with a set of settings, with the reader Sitrec uses.
 *
 * @param {Object} xml - xmlToObject() output
 * @param {string} sourceText - the file as text
 * @param {string} envText - shared.env lines
 * @returns {{messages: string[], layouts: Object[], identified: (string|null), sonde: (Object|null)}}
 *          identified: the name of the layout whose _XMLNS_CONTAINS or
 *          _FILE_CONTAINS matched, or null
 */
export function checkSettings(xml, sourceText, envText) {
    const messages = [];
    const report = message => messages.push(message);
    const layouts = soundingXMLLayoutsFromEnv(parseEnvText(envText), report);
    if (layouts.length === 0 && messages.length === 0) {
        messages.push(`No layout in these settings: a layout needs a ${ENV_PREFIX}<NAME>_LEVEL_TAG line.`);
    }
    const namespaces = collectNamespaces(xml);
    const identified = layouts.find(layout => layoutIdentifiesFile(layout, namespaces, sourceText))?.name ?? null;
    const sonde = findSoundingXML(xml, layouts, new Date(), sourceText, parseDecimalCoordinate, report);
    if (!sonde && layouts.length > 0 && messages.length === 0) {
        messages.push(identified === null && layouts.every(layout => layout.xmlnsContains.length + layout.fileContains.length > 0)
            ? "No layout identifies this file: none of the _XMLNS_CONTAINS or _FILE_CONTAINS substrings is in it."
            : "The file does not fit these settings: no position with at least two levels and a wind was found.");
    }
    return {messages, layouts, identified, sonde};
}

// ─── A report to send to someone ─────────────────────────────────────────

/**
 * Plain-text account of the analysis. With includeValues false it holds the
 * structure of the file: tag names, namespace addresses, known unit names, counts
 * and kinds. It holds no measurement, position, time or other text from the file,
 * so it can be sent to someone who must not see the data. Tag names and namespace
 * addresses can themselves say where a file comes from; the page says so.
 */
export function buildReport(analysis, {includeValues = false, fileName = ""} = {}) {
    const lines = [];
    const value = text => includeValues ? ` = ${text}` : "";
    lines.push("XML Wind Profile Analyzer report");
    if (!includeValues) {
        lines.push("Structure only. This report has tag names, namespace addresses and unit names from the file.",
            "It has no measurement, position, time, file name or other text from the file.");
    }
    // A unit string is file text. Without values, only one that is a known unit
    // name is printed; anything else in a unit attribute is not.
    const unitsText = hints => {
        if (hints.length === 0) return "";
        const shown = includeValues ? hints : hints.filter(isKnownUnit);
        return shown.length > 0 ? `, unit in file: ${shown.join(", ")}` : ", unit in file: stated, not a unit name this tool knows (not shown)";
    };
    if (fileName && includeValues) lines.push(`File: ${fileName}`);
    lines.push(`Root element: <${analysis.root.tag}>, ${analysis.elementCount} elements`);
    lines.push(analysis.namespaces.length
        ? "Namespaces:\n" + analysis.namespaces.map(entry => `  ${entry.prefix}: ${entry.uri}`).join("\n")
        : "Namespaces: none declared");
    lines.push(`Value element: ${analysis.valueTag ? `<${analysis.valueTag.name}>` : "none (fields hold their own values)"}`);

    lines.push("", `Positions found: ${analysis.positions.length}`);
    for (const position of analysis.positions) {
        const chosen = position === analysis.position ? "  <- used for the profile" : "";
        lines.push(`  in ${position.path}${position.insideLevel ? " (inside a level)" : ""}${chosen}`);
        lines.push(`    latitude  <${position.lat.node.name}>${position.lat.sense ? ", sense given apart from the number" : ""}${value(position.lat.value)}`);
        lines.push(`    longitude <${position.lon.node.name}>${position.lon.sense ? ", sense given apart from the number" : ""}${value(position.lon.value)}`);
        lines.push(position.elev
            ? `    elevation <${position.elev.node.name}>${unitsText(position.elev.unitHints)}${value(position.elev.value)}`
            : "    elevation: none");
    }

    const describeGroup = group => {
        lines.push(`  <${group.name}> x ${group.records.length} in ${group.path}`);
        for (const field of group.fields) {
            const role = field.role ? ROLES.find(entry => entry.role === field.role).label.toUpperCase() : "-";
            const hints = unitsText(field.unitHints);
            const range = includeValues && field.numbers.length ? `, ${field.min} to ${field.max}` : "";
            const kind = field.numbers.length === 0 ? "text" : field.allNumeric ? `numbers, ${field.trend === "none" ? "no trend" : field.trend}` : "numbers, some missing";
            lines.push(`    ${field.name}: ${role} (${kind}${range}${hints})${field.evidence ? ` [${field.evidence}]` : ""}`);
        }
    };
    lines.push("", "Vertical profile:");
    if (analysis.profile) describeGroup(analysis.profile);
    else lines.push("  none found");

    const others = analysis.groups.filter(group => group !== analysis.profile);
    if (others.length > 0) {
        lines.push("", "Other repeating elements:");
        others.forEach(describeGroup);
    }
    if (analysis.times.length > 0) {
        lines.push("", "Date-times: " + analysis.times.map(time => `<${time.name}>${value(time.text)}`).join(", "));
    }
    if (analysis.notes.length > 0) {
        lines.push("", "Notes:");
        for (const note of analysis.notes) lines.push(`  - ${note}`);
    }
    if (analysis.settings) {
        lines.push("", "Proposed settings:", settingsText(analysis.settings).trimEnd());
    }
    return lines.join("\n") + "\n";
}

export {ROLES};
