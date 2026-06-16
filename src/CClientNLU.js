import {sitrecAPI} from "./CSitrecAPI";
import {FileManager, guiMenus} from "./Globals";
import GUI from "./js/lil-gui.esm";
import {ModelFiles} from "./nodes/CNode3DObject";
import * as math from 'mathjs';

const GEOMETRY_TYPES = ["sphere", "ellipsoid", "box", "capsule", "circle", "cone", "cylinder",
    "dodecahedron", "icosahedron", "octahedron", "ring", "tictac",
    "tetrahedron", "torus", "torusknot", "superegg"];

// Solar system bodies handled by pointCameraAtNamedObject / lockCameraOnObject
const SOLAR_SYSTEM_BODIES = new Set([
    "sun", "moon", "mercury", "venus", "mars", "jupiter", "saturn", "uranus", "neptune"
]);

// Colloquial aliases that map to solar system body names
const SOLAR_SYSTEM_ALIASES = {
    "evening star": "Venus", "morning star": "Venus",
    "the sun": "Sun", "the moon": "Moon",
};

// Catalog of deep-sky objects, constellations, and aliases not in IAU-CSN.
// Stars are loaded lazily from the IAU-CSN data file (via FileManager).
// RA in decimal hours, Dec in decimal degrees (J2000 epoch)
const SKY_CATALOG = {
    // ── Popular aliases for IAU star names ─────────────────────
    // These colloquial / historical names don't appear in the IAU-CSN file
    "north star":       [2.530,   89.264], // Polaris
    "pole star":        [2.530,   89.264], // Polaris
    "dog star":         [6.752,  -16.716], // Sirius
    "rigil kentaurus":  [14.660, -60.835], // Alpha Centauri (not in IAU-CSN as this name)
    "rigil kent":       [14.660, -60.835], // Alpha Centauri abbreviation
    "alpha centauri":   [14.660, -60.835], // Toliman in IAU-CSN
    "proxima centauri": [14.495, -62.680], // Proxima Centauri
    "proxima":          [14.495, -62.680],
    "barnard's star":   [17.964,   4.693], // Barnard's Star
    "barnards star":    [17.964,   4.693],
    "summer triangle":  [19.846,   8.868], // center approx (Altair)
    "winter triangle":  [6.752,  -16.716], // center approx (Sirius)
    "orion's belt":     [5.604,   -1.202], // Alnilam (center belt star)
    "belt of orion":    [5.604,   -1.202],
    "guardians":        [14.845,  74.156], // Kochab + Pherkad (Little Dipper guards)
    "pointer stars":    [11.047,  59.067], // Merak–Dubhe midpoint
    "gemma":            [15.578,  26.715], // Alphecca alias (Corona Borealis)

    // ── Messier objects ───────────────────────────────────────
    "m1":   [5.576,   22.015], "crab nebula":           [5.576,   22.015],
    "m3":   [13.703,  28.377],
    "m4":   [16.393, -26.526],
    "m5":   [15.310,   2.081],
    "m6":   [17.668, -32.216], "butterfly cluster":     [17.668, -32.216],
    "m7":   [17.898, -34.793], "ptolemy cluster":       [17.898, -34.793],
    "m8":   [18.063, -24.384], "lagoon nebula":         [18.063, -24.384],
    "m10":  [16.952,  -4.100],
    "m11":  [18.851,  -6.267], "wild duck cluster":     [18.851,  -6.267],
    "m13":  [16.695,  36.462], "hercules cluster":      [16.695,  36.462],
    "m15":  [21.500,  12.167],
    "m16":  [18.314, -13.787], "eagle nebula":          [18.314, -13.787],
    "m17":  [18.346, -16.171], "omega nebula":          [18.346, -16.171], "swan nebula": [18.346, -16.171],
    "m20":  [18.043, -23.029], "trifid nebula":         [18.043, -23.029],
    "m22":  [18.607, -23.905],
    "m27":  [19.994,  22.721], "dumbbell nebula":       [19.994,  22.721],
    "m31":  [0.712,   41.269], "andromeda galaxy":      [0.712,   41.269], "andromeda": [0.712, 41.269],
    "m32":  [0.714,   40.866],
    "m33":  [1.564,   30.660], "triangulum galaxy":     [1.564,   30.660],
    "m35":  [6.149,   24.333],
    "m36":  [5.601,   34.133],
    "m37":  [5.873,   32.553],
    "m38":  [5.478,   35.833],
    "m41":  [6.767,  -20.733],
    "m42":  [5.588,   -5.390], "orion nebula":          [5.588,   -5.390], "great nebula": [5.588, -5.390],
    "m43":  [5.593,   -5.267],
    "m44":  [8.672,   19.667], "beehive cluster":       [8.672,   19.667], "praesepe": [8.672, 19.667],
    "m45":  [3.787,   24.117], "pleiades":              [3.787,   24.117], "seven sisters": [3.787, 24.117],
    "m46":  [7.696,  -14.817],
    "m47":  [7.612,  -14.500],
    "m48":  [8.228,   -5.750],
    "m49":  [12.497,   7.999],
    "m50":  [7.053,   -8.333],
    "m51":  [13.498,  47.195], "whirlpool galaxy":      [13.498,  47.195],
    "m52":  [23.407,  61.600],
    "m53":  [13.215,  18.168],
    "m54":  [18.917, -30.476],
    "m55":  [19.666, -30.964],
    "m56":  [19.277,  30.184],
    "m57":  [18.893,  33.029], "ring nebula":           [18.893,  33.029],
    "m58":  [12.627,  11.818],
    "m59":  [12.700,  11.647],
    "m60":  [12.728,  11.553],
    "m61":  [12.365,   4.474],
    "m62":  [17.020, -30.114],
    "m63":  [13.264,  42.029], "sunflower galaxy":      [13.264,  42.029],
    "m64":  [12.944,  21.683], "black eye galaxy":      [12.944,  21.683],
    "m65":  [11.318,  13.092],
    "m66":  [11.338,  12.992],
    "m67":  [8.854,   11.817],
    "m74":  [1.611,   15.783],
    "m78":  [5.779,    0.050],
    "m79":  [5.407,  -24.524],
    "m80":  [16.283, -22.976],
    "m81":  [9.926,   69.065], "bode's galaxy":         [9.926,   69.065],
    "m82":  [9.932,   69.680], "cigar galaxy":          [9.932,   69.680],
    "m83":  [13.617, -29.866], "southern pinwheel":     [13.617, -29.866],
    "m84":  [12.418,  12.886],
    "m86":  [12.443,  12.947],
    "m87":  [12.514,  12.391], "virgo a":               [12.514,  12.391],
    "m92":  [17.286,  43.136],
    "m97":  [11.248,  55.019], "owl nebula":            [11.248,  55.019],
    "m101": [14.054,  54.349], "pinwheel galaxy":       [14.054,  54.349],
    "m104": [12.666, -11.623], "sombrero galaxy":       [12.666, -11.623],
    "m106": [12.316,  47.304],
    "m110": [0.673,   41.685],

    // ── Other notable objects ─────────────────────────────────
    "ngc 869":  [2.324,  57.133], "double cluster h":     [2.324,  57.133],
    "ngc 884":  [2.374,  57.150], "double cluster chi":   [2.374,  57.150],
    "double cluster": [2.349, 57.142],
    "ngc 3372": [10.745,-59.867], "carina nebula":        [10.745,-59.867], "eta carinae nebula": [10.745,-59.867],
    "ngc 7000": [20.974, 44.333], "north america nebula": [20.974, 44.333],
    "ngc 6992": [20.937, 31.717], "veil nebula":          [20.937, 31.717],
    "ngc 253":  [0.793, -25.288], "sculptor galaxy":      [0.793, -25.288],
    "ngc 2237": [6.535,   4.950], "rosette nebula":       [6.535,   4.950],
    "47 tucanae":[0.402, -72.081], "ngc 104":             [0.402, -72.081],
    "omega centauri": [13.447, -47.480], "ngc 5139":      [13.447, -47.480],
    "large magellanic cloud": [5.392, -69.756], "lmc":    [5.392, -69.756],
    "small magellanic cloud": [0.877, -72.800], "smc":    [0.877, -72.800],

    // ── Constellation reference stars (brightest or central) ──
    "orion":        [5.588,  -5.390], // centered on M42 / belt region
    "big dipper":   [12.257, 57.032], // Megrez — center of asterism
    "little dipper":[15.734, 77.795], // Pherkad — mid handle
    "cassiopeia":   [1.107,  59.150], // Gamma Cas — center of W
    "cygnus":       [20.691, 45.280], // Deneb
    "lyra":         [18.616, 38.784], // Vega
    "scorpius":     [16.490,-26.432], // Antares
    "leo":          [10.140, 11.967], // Regulus
    "gemini":       [7.755,  28.026], // Pollux
    "taurus":       [4.599,  16.509], // Aldebaran
    "virgo":        [13.420,-11.161], // Spica
    "aquila":       [19.846,  8.868], // Altair
    "sagittarius":  [18.403,-34.384], // Kaus Australis
    "corona borealis": [15.578, 26.715], // Alphecca
    "southern cross": [12.443,-63.099], "crux": [12.443,-63.099], // Gacrux
};

// Build a normalized lookup map from the hardcoded catalog (Messier, NGC, constellations)
const _skyLookup = new Map();
for (const [name, coords] of Object.entries(SKY_CATALOG)) {
    _skyLookup.set(name, coords);
}

// Lazily parsed IAU-CSN star names (loaded from data file on first use)
let _iauLoaded = false;

function _loadIAUStarNames() {
    if (_iauLoaded) return;
    _iauLoaded = true;
    try {
        const data = FileManager.get("IAUCSN");
        if (!data) return;
        for (const line of data.split("\n")) {
            if (line[0] === "#" || line[0] === "$" || line.trim() === "") continue;
            const name = line.substring(0, 18).trim();
            const raDeg = parseFloat(line.substring(104, 115));
            const decDeg = parseFloat(line.substring(115, 126));
            if (!name || isNaN(raDeg) || isNaN(decDeg)) continue;
            const key = name.toLowerCase();
            // Don't overwrite hardcoded entries (Messier, NGC, constellations)
            if (!_skyLookup.has(key)) {
                _skyLookup.set(key, [raDeg / 15, decDeg]); // RA degrees → hours
            }
        }
    } catch {
        // IAUCSN not loaded (nightSky disabled) — hardcoded catalog still works
    }
}

/**
 * Look up a sky object by name. Returns {ra, dec} in hours/degrees, or null.
 * Checks hardcoded catalog (Messier, NGC, constellations) and IAU star names.
 */
function lookupSkyObject(name) {
    _loadIAUStarNames();
    const key = name.toLowerCase().replace(/^the\s+/, "").trim();
    const coords = _skyLookup.get(key);
    if (coords) return { ra: coords[0], dec: coords[1] };
    // Try without "star", "cluster", "nebula", "galaxy" suffix
    const stripped = key.replace(/\s+(star|cluster|nebula|galaxy)$/, "").trim();
    if (stripped !== key) {
        const c2 = _skyLookup.get(stripped);
        if (c2) return { ra: c2[0], dec: c2[1] };
    }
    return null;
}

// Fallback for alias keys that don't appear in any ModelFiles key name
const ALIAS_MODELS = {
    jet: "F/A-18F",
};

const ALIASES = {
    fov: ["fov", "vfov", "hfov", "field of view", "fieldofview"],
    satellites: ["sats", "satellites", "satellite", "sat"],
    starlink: ["starlink", "starlinks"],
    helicopter: ["helicopter", "heli", "chopper"],
    jet: ["jet", "fighter", "f-15", "f15", "f-18", "f18"],
    drone: ["drone", "uav", "mq-9", "mq9", "predator", "reaper"],
    ambient: ["ambient", "ambient only", "ambientonly"],
    stars: ["stars", "star"],
    grid: ["grid", "grids"],
    labels: ["labels", "label", "names"],
    terrain: ["terrain", "ground", "earth"],
    play: ["play", "start", "unpause", "resume"],
    pause: ["pause", "stop"],
};

const BOOLEAN_TRUE = ["on", "true", "yes", "show", "enable", "enabled", "visible", "1"];
const BOOLEAN_FALSE = ["off", "false", "no", "hide", "disable", "disabled", "invisible", "hidden", "0"];

const COMMAND_KEYWORDS = ["set", "show", "hide", "enable", "disable", "turn", "load", "get", "fetch",
    "zoom", "play", "pause", "stop", "start", "resume", "go", "move", "point", "look", "frame",
    "make", "change", "calculate", "evaluate", "what", "ambient"];

// Question / function words that must NEVER be "corrected" into a command keyword.
// Without this, fuzzy matching maps "how" -> "show" (kw.slice(1) === "how", one edit),
// turning every "how do I ..." question into a bogus "show ..." toggle command.
const NEVER_CORRECT = new Set([
    "how", "why", "who", "whom", "whose", "what", "which", "when", "where",
    "is", "are", "am", "was", "were", "be", "do", "does", "did",
    "can", "could", "should", "would", "will", "may", "might",
]);

// Calculator-style math instance: trig functions take DEGREES by default, so
// "cos(30)" means cos(30°) (like Google's calculator). Explicit angle units still
// win — "cos(1 rad)" and "cos(30 deg)" are honoured — and inverse trig (asin/acos/
// atan...) returns degrees. This is a LOCAL mathjs instance so the global mathjs used
// elsewhere (e.g. CNodeMath) keeps standard radians behaviour.
const mathDeg = math.create(math.all);
(function configureDegreesTrig() {
    const replacements = {};
    const argToRad = (x) => (typeof x === "number" ? x / 180 * Math.PI : x);
    ["sin", "cos", "tan", "sec", "cot", "csc"].forEach((name) => {
        const fn = mathDeg[name];
        replacements[name] = (x) => fn(argToRad(x));
    });
    ["asin", "acos", "atan", "acot", "acsc", "asec"].forEach((name) => {
        const fn = mathDeg[name];
        replacements[name] = (x) => {
            const r = fn(x);
            return typeof r === "number" ? r / Math.PI * 180 : r;
        };
    });
    mathDeg.import(replacements, { override: true });
})();

function levenshtein(a, b) {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    const matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            matrix[i][j] = b[i-1] === a[j-1]
                ? matrix[i-1][j-1]
                : Math.min(matrix[i-1][j-1] + 1, matrix[i][j-1] + 1, matrix[i-1][j] + 1);
        }
    }
    return matrix[b.length][a.length];
}

function isTransposition(a, b) {
    if (a.length !== b.length) return false;
    let diffs = [];
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) diffs.push(i);
    }
    if (diffs.length === 2 && diffs[1] === diffs[0] + 1) {
        return a[diffs[0]] === b[diffs[1]] && a[diffs[1]] === b[diffs[0]];
    }
    return false;
}

function fuzzyMatchKeyword(word) {
    const lower = word.toLowerCase();
    if (COMMAND_KEYWORDS.includes(lower)) return null;
    if (NEVER_CORRECT.has(lower)) return null;
    for (const kw of COMMAND_KEYWORDS) {
        if (lower.length >= 3 && kw.length >= 3) {
            if (isTransposition(lower, kw)) {
                return kw;
            }
            const dist = levenshtein(lower, kw);
            const sameFirstChar = lower[0] === kw[0];
            if (sameFirstChar && dist === 1) {
                return kw;
            }
            if (lower === kw.slice(1) && dist === 1) {
                return kw;
            }
        }
    }
    return null;
}

class CClientNLU {
    constructor() {
        this.patterns = this._buildPatterns();
    }

    _buildPatterns() {
        return [
            {
                name: "set_fov_variants",
                regex: /^(?:set\s+)?(?:v?fov|h?fov|field\s*of\s*view)\s*(?:to\s+)?(\d+(?:\.\d+)?)$/i,
                extract: (match) => ({intent: "SET_VALUE", slots: {path: "vFOV", value: parseFloat(match[1])}}),
                confidence: 0.95
            },
            {
                name: "set_value_equals",
                regex: /^(?:set\s+)?(\S+)=(\S+)$/i,
                extract: (match) => ({intent: "SET_VALUE", slots: {path: match[1], value: this._parseValue(match[2])}}),
                confidence: 0.95
            },
            {
                name: "set_frame",
                regex: /^(?:go\s+to\s+)?frame\s+(\d+)$/i,
                extract: (match) => ({intent: "SET_FRAME", slots: {frame: parseInt(match[1])}}),
                confidence: 0.95
            },
            {
                name: "set_datetime_iso",
                regex: /^(?:set\s+)?(?:date\s*(?:time)?|time)\s+(?:to\s+)?(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?(?:[+-]\d{2}:?\d{2}|Z)?)?)$/i,
                extract: (match) => ({intent: "SET_DATETIME", slots: {dateTime: match[1]}}),
                confidence: 0.95
            },
            {
                name: "set_value_explicit",
                regex: /^set\s+(\S+)\s+(?:to\s+)?(\S+)$/i,
                extract: (match) => ({intent: "SET_VALUE", slots: {path: match[1], value: this._parseValue(match[2])}}),
                confidence: 0.95
            },
            {
                name: "set_value_implicit",
                regex: /^(\S+)\s+(\d+(?:\.\d+)?)$/i,
                extract: (match) => ({intent: "SET_VALUE", slots: {path: match[1], value: parseFloat(match[2])}}),
                confidence: 0.9
            },
            {
                name: "zoom_in",
                regex: /^zoom\s+in(?:\s+(?:the\s+)?(\w+)(?:\s+camera)?)?$/i,
                extract: (match) => {
                    const camera = match[1] ? this._resolveCameraName(match[1]) : "lookCamera";
                    return {intent: "ZOOM_IN", slots: {camera}};
                },
                confidence: 0.9
            },
            {
                name: "zoom_out",
                regex: /^zoom\s+out(?:\s+(?:the\s+)?(\w+)(?:\s+camera)?)?$/i,
                extract: (match) => {
                    const camera = match[1] ? this._resolveCameraName(match[1]) : "lookCamera";
                    return {intent: "ZOOM_OUT", slots: {camera}};
                },
                confidence: 0.9
            },
            {
                name: "toggle_on",
                regex: /^(?:show|enable|turn\s+on)\s+(.+)$/i,
                extract: (match) => ({intent: "TOGGLE_ON", slots: {target: match[1].trim()}}),
                confidence: 0.85
            },
            {
                name: "toggle_off",
                regex: /^(?:hide|disable|turn\s+off)\s+(.+)$/i,
                extract: (match) => ({intent: "TOGGLE_OFF", slots: {target: match[1].trim()}}),
                confidence: 0.85
            },
            {
                name: "toggle_suffix_on",
                regex: /^(.+)\s+(?:on|visible|enabled)$/i,
                extract: (match) => ({intent: "TOGGLE_ON", slots: {target: match[1].trim()}}),
                confidence: 0.8
            },
            {
                name: "toggle_suffix_off",
                regex: /^(.+)\s+(?:off|hidden|disabled)$/i,
                extract: (match) => ({intent: "TOGGLE_OFF", slots: {target: match[1].trim()}}),
                confidence: 0.8
            },
            {
                name: "load_satellites",
                regex: /^(?:load|get|fetch)\s+(?:the\s+)?(?:leo\s+)?(?:satellites?|sats?)$/i,
                extract: () => ({intent: "LOAD_SATELLITES", slots: {type: "leo"}}),
                confidence: 0.95
            },
            {
                name: "load_starlink",
                regex: /^(?:load|get|fetch)\s+(?:current\s+)?starlinks?$/i,
                extract: () => ({intent: "LOAD_SATELLITES", slots: {type: "starlink"}}),
                confidence: 0.95
            },
            {
                name: "ambient_only",
                regex: /^ambient\s*(?:only)?$/i,
                extract: () => ({intent: "AMBIENT_ONLY", slots: {}}),
                confidence: 0.95
            },
            {
                name: "set_all_geometry",
                regex: /^(?:make|set|change)\s+(?:it|them|all(?:\s+objects)?)\s+(?:to\s+)?(?:a\s+)?(\w+)s?$/i,
                extract: (match) => {
                    const geoName = this._resolveGeometryName(match[1]);
                    if (geoName) {
                        return {intent: "SET_ALL_GEOMETRY", slots: {geometry: geoName}};
                    }
                    return null;
                },
                confidence: 0.85
            },
            {
                name: "set_model",
                regex: /^(?:set|use|change(?:\s+to)?|make\s+(?:it|the\s+\w+)\s+(?:a\s+)?)\s*(\w+)$/i,
                extract: (match) => {
                    const modelName = this._resolveModelName(match[1]);
                    if (modelName) {
                        return {intent: "SET_MODEL", slots: {model: modelName}};
                    }
                    return null;
                },
                confidence: 0.7
            },
            {
                name: "set_object_model",
                regex: /^(?:set|make|change)\s+(?:the\s+)?(\w+)\s+(?:object\s+)?(?:to\s+)?(?:a\s+)?(\w+)$/i,
                extract: (match) => {
                    const modelName = this._resolveModelName(match[2]);
                    if (modelName) {
                        return {intent: "SET_OBJECT_MODEL", slots: {object: match[1], model: modelName}};
                    }
                    const geoName = this._resolveGeometryName(match[2]);
                    if (geoName) {
                        return {intent: "SET_OBJECT_GEOMETRY", slots: {object: match[1], geometry: geoName}};
                    }
                    return null;
                },
                confidence: 0.8
            },
            {
                name: "math_expression",
                test: (text) => {
                    const cleaned = text.replace(/^(?:what(?:'s|\s+is)\s+|calculate\s+|eval(?:uate)?\s+)/i, '').replace(/[?!]$/, '').trim();
                    if (!cleaned || /^[a-z]+$/i.test(cleaned)) return null;
                    try {
                        const result = mathDeg.evaluate(cleaned);
                        if (typeof result === 'number' && isFinite(result)) {
                            return {expression: cleaned, result};
                        }
                    } catch (e) {}
                    return null;
                },
                extract: (match, testResult) => ({
                    intent: "MATH",
                    slots: {expression: testResult.expression, result: testResult.result}
                }),
                confidence: 0.95
            },
            {
                name: "play",
                regex: /^(?:play|start|unpause|resume)$/i,
                extract: () => ({intent: "PLAY", slots: {}}),
                confidence: 0.95
            },
            {
                name: "pause",
                regex: /^(?:pause|stop)$/i,
                extract: () => ({intent: "PAUSE", slots: {}}),
                confidence: 0.95
            },
            {
                name: "set_time_simple",
                regex: /^(?:set\s+)?(?:time\s+(?:to\s+)?)?(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(am|pm)?$/i,
                extract: (match) => {
                    let hours = parseInt(match[1]);
                    const minutes = match[2] ? parseInt(match[2]) : 0;
                    const seconds = match[3] ? parseInt(match[3]) : 0;
                    const ampm = match[4]?.toLowerCase();
                    if (ampm === "pm" && hours < 12) hours += 12;
                    if (ampm === "am" && hours === 12) hours = 0;
                    return {intent: "SET_TIME_RELATIVE", slots: {hours, minutes, seconds}};
                },
                confidence: 0.85
            },
            {
                name: "goto_location_simple",
                regex: /^(?:go\s+to|move\s+to|set\s+location(?:\s+to)?)\s+(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)(?:\s*[,\s]\s*(-?\d+(?:\.\d+)?))?$/i,
                extract: (match) => ({
                    intent: "GOTO_LLA",
                    slots: {
                        lat: parseFloat(match[1]),
                        lon: parseFloat(match[2]),
                        alt: match[3] ? parseFloat(match[3]) : 0
                    }
                }),
                confidence: 0.95
            },
            {
                name: "goto_location_named",
                regex: /^(?:go\s+to|move\s+to|set\s+location(?:\s+to)?)\s+(.+)$/i,
                extract: (match) => ({intent: "GOTO_NAMED_LOCATION", slots: {location: match[1].trim()}}),
                confidence: 0.6
            },
            {
                name: "point_at_object",
                regex: /^(?:point|look)\s+(?:at|towards?)\s+(?:the\s+)?(.+)$/i,
                extract: (match) => ({intent: "POINT_AT", slots: {target: match[1].trim()}}),
                confidence: 0.8
            },
            {
                name: "lock_on_object",
                regex: /^(?:lock(?:\s+(?:on(?:\s+to)?|to))?|follow|track)\s+(?:the\s+)?(.+)$/i,
                extract: (match) => ({intent: "LOCK_ON", slots: {target: match[1].trim()}}),
                confidence: 0.85
            },
            {
                name: "unlock_camera",
                regex: /^(?:unlock|stop\s+(?:tracking|following|locking)|release\s+lock)$/i,
                extract: () => ({intent: "UNLOCK"}),
                confidence: 0.9
            },
        ];
    }

    _parseValue(str) {
        const num = parseFloat(str);
        if (!isNaN(num) && String(num) === str) return num;
        const lower = str.toLowerCase();
        if (BOOLEAN_TRUE.includes(lower)) return true;
        if (BOOLEAN_FALSE.includes(lower)) return false;
        if (!isNaN(num)) return num;
        return str;
    }

    _resolveCameraName(name) {
        const lower = name.toLowerCase();
        if (lower === "look" || lower === "lookview") return "lookCamera";
        if (lower === "main" || lower === "mainview") return "mainCamera";
        return lower + "Camera";
    }

    _resolveModelName(name) {
        const lower = name.toLowerCase();
        const modelKeys = Object.keys(ModelFiles);
        let modelName = modelKeys.find(m => m.toLowerCase() === lower);
        if (!modelName) {
            modelName = modelKeys.find(m => m.toLowerCase().includes(lower));
        }
        if (!modelName) {
            modelName = modelKeys.find(m => lower.includes(m.toLowerCase()));
        }
        for (const [alias, variants] of Object.entries(ALIASES)) {
            if (variants.includes(lower)) {
                const aliasModel = modelKeys.find(m => m.toLowerCase().includes(alias));
                if (aliasModel) return aliasModel;
                if (ALIAS_MODELS[alias]) return ALIAS_MODELS[alias];
            }
        }
        return modelName || null;
    }

    _resolveGeometryName(name) {
        const lower = name.toLowerCase();
        let geoName = GEOMETRY_TYPES.find(g => g.toLowerCase() === lower);
        if (!geoName) {
            geoName = GEOMETRY_TYPES.find(g => g.toLowerCase().includes(lower));
        }
        if (!geoName) {
            geoName = GEOMETRY_TYPES.find(g => lower.includes(g.toLowerCase()));
        }
        return geoName || null;
    }

    _resolveMenuPath(target) {
        const lower = target.toLowerCase();
        for (const [menuId, gui] of Object.entries(guiMenus)) {
            const result = this._searchControllers(gui, lower, "");
            if (result) {
                return {menu: menuId, path: result.path, controller: result.controller};
            }
        }
        return null;
    }

    _searchControllers(gui, searchTerm, prefix) {
        for (const child of gui.children) {
            if (child instanceof GUI) {
                const result = this._searchControllers(child, searchTerm, prefix + child._title + "/");
                if (result) return result;
            } else {
                const nameLower = child._name.toLowerCase();
                const propLower = child.property?.toLowerCase() || "";
                if (nameLower === searchTerm || propLower === searchTerm ||
                    nameLower.includes(searchTerm) || propLower.includes(searchTerm) ||
                    searchTerm.includes(nameLower) || searchTerm.includes(propLower)) {
                    return {path: prefix + child._name, controller: child};
                }
            }
        }
        return null;
    }

    _correctTypos(text) {
        const words = text.split(/\s+/);
        if (words.length === 0) return text;
        const correctedFirst = fuzzyMatchKeyword(words[0]);
        if (correctedFirst) {
            words[0] = correctedFirst;
        }
        if (words.length > 1 && words[0].toLowerCase() === "turn") {
            const correctedSecond = fuzzyMatchKeyword(words[1]);
            if (correctedSecond) {
                words[1] = correctedSecond;
            }
        }
        return words.join(' ');
    }

    _tryMatch(text) {
        for (const pattern of this.patterns) {
            let match = null;
            let testResult = null;
            if (pattern.regex) {
                match = text.match(pattern.regex);
            } else if (pattern.test) {
                testResult = pattern.test(text);
                match = testResult ? true : null;
            }
            if (match) {
                const extracted = pattern.extract(match, testResult);
                if (extracted) {
                    return {...extracted, confidence: pattern.confidence, patternName: pattern.name};
                }
            }
        }
        return null;
    }

    parse(text) {
        const trimmed = text.trim();
        const result = this._tryMatch(trimmed);
        if (result) {
            return {...result, originalText: trimmed};
        }
        const corrected = this._correctTypos(trimmed);
        if (corrected !== trimmed) {
            const correctedResult = this._tryMatch(corrected);
            if (correctedResult) {
                return {
                    ...correctedResult,
                    confidence: correctedResult.confidence * 0.9,
                    originalText: trimmed,
                    correctedText: corrected
                };
            }
        }
        return {intent: null, slots: {}, confidence: 0, originalText: trimmed};
    }

    async execute(parseResult) {
        const {intent, slots} = parseResult;

        switch (intent) {
            case "SET_VALUE": {
                const resolved = this._resolveMenuPath(slots.path);
                if (resolved) {
                    return sitrecAPI.call("setMenuValue", {
                        menu: resolved.menu,
                        path: resolved.path,
                        value: slots.value
                    });
                }
                return {success: false, error: `Could not find control: ${slots.path}`};
            }

            case "TOGGLE_ON":
            case "TOGGLE_OFF": {
                const resolved = this._resolveMenuPath(slots.target);
                if (resolved) {
                    return sitrecAPI.call("setMenuValue", {
                        menu: resolved.menu,
                        path: resolved.path,
                        value: intent === "TOGGLE_ON"
                    });
                }
                return {success: false, error: `Could not find control: ${slots.target}`};
            }

            case "ZOOM_IN": {
                const fovPath = this._resolveMenuPath("vfov");
                if (fovPath) {
                    const current = sitrecAPI.call("getMenuValue", {menu: fovPath.menu, path: fovPath.path});
                    if (current.result?.value) {
                        const newFov = Math.max(1, current.result.value * 0.7);
                        return sitrecAPI.call("setMenuValue", {menu: fovPath.menu, path: fovPath.path, value: newFov});
                    }
                }
                return {success: false, error: "Could not find FOV control"};
            }

            case "ZOOM_OUT": {
                const fovPath = this._resolveMenuPath("vfov");
                if (fovPath) {
                    const current = sitrecAPI.call("getMenuValue", {menu: fovPath.menu, path: fovPath.path});
                    if (current.result?.value) {
                        const newFov = Math.min(120, current.result.value * 1.4);
                        return sitrecAPI.call("setMenuValue", {menu: fovPath.menu, path: fovPath.path, value: newFov});
                    }
                }
                return {success: false, error: "Could not find FOV control"};
            }

            case "LOAD_SATELLITES":
                if (slots.type === "starlink") {
                    return sitrecAPI.call("satellitesLoadCurrentStarlink", {});
                }
                return sitrecAPI.call("satellitesLoadLEO", {});

            case "AMBIENT_ONLY": {
                const resolved = this._resolveMenuPath("ambient only");
                if (resolved) {
                    return sitrecAPI.call("setMenuValue", {menu: resolved.menu, path: resolved.path, value: true});
                }
                return {success: false, error: "Could not find ambient only control"};
            }

            case "SET_MODEL":
                return sitrecAPI.call("setObjectModel", {object: "camera", model: slots.model});

            case "SET_OBJECT_MODEL":
                return sitrecAPI.call("setObjectModel", {object: slots.object, model: slots.model});

            case "SET_OBJECT_GEOMETRY":
                return sitrecAPI.call("setObjectGeometry", {object: slots.object, geometry: slots.geometry});

            case "SET_ALL_GEOMETRY":
                return sitrecAPI.call("setAllObjectsGeometry", {geometry: slots.geometry});

            case "MATH": {
                return {success: true, result: {answer: slots.result, expression: slots.expression}};
            }

            case "PLAY":
                return sitrecAPI.call("play", {});

            case "PAUSE":
                return sitrecAPI.call("pause", {});

            case "SET_FRAME":
                return sitrecAPI.call("setFrame", {frame: slots.frame});

            case "SET_TIME_RELATIVE": {
                const now = new Date();
                now.setHours(slots.hours, slots.minutes, slots.seconds, 0);
                return sitrecAPI.call("setDateTime", {dateTime: now.toISOString()});
            }

            case "SET_DATETIME":
                return sitrecAPI.call("setDateTime", {dateTime: slots.dateTime});

            case "GOTO_LLA":
                return sitrecAPI.call("gotoLLA", {lat: slots.lat, lon: slots.lon, alt: slots.alt});

            case "GOTO_NAMED_LOCATION":
                return this._geocodeAndGoto(slots.location);

            case "POINT_AT": {
                const target = slots.target;
                // Check colloquial aliases for solar system bodies first
                const pointAlias = SOLAR_SYSTEM_ALIASES[target.toLowerCase()];
                if (pointAlias) {
                    return sitrecAPI.call("pointCameraAtNamedObject", {object: pointAlias});
                }
                // Solar system bodies use the named-object function
                if (SOLAR_SYSTEM_BODIES.has(target.toLowerCase())) {
                    return sitrecAPI.call("pointCameraAtNamedObject", {object: target});
                }
                // Check the sky catalog + IAU star names
                const pointCoords = lookupSkyObject(target);
                if (pointCoords) {
                    return sitrecAPI.call("pointCameraAtRaDec", pointCoords);
                }
                // Unknown to local handlers — let the LLM resolve it (e.g. asterisms,
                // constellation features, free-form sky objects) and call pointCameraAtRaDec.
                return {success: false, error: `Unknown object '${target}'`, needsLLM: true};
            }

            case "LOCK_ON": {
                const target = slots.target;
                const lockAlias = SOLAR_SYSTEM_ALIASES[target.toLowerCase()];
                if (lockAlias) {
                    return sitrecAPI.call("lockCameraOnObject", {object: lockAlias});
                }
                if (SOLAR_SYSTEM_BODIES.has(target.toLowerCase())) {
                    return sitrecAPI.call("lockCameraOnObject", {object: target});
                }
                const lockCoords = lookupSkyObject(target);
                if (lockCoords) {
                    return sitrecAPI.call("lockCameraOnRaDec", lockCoords);
                }
                // Unknown to local handlers — let the LLM resolve it and call lockCameraOnRaDec.
                return {success: false, error: `Unknown object '${target}'`, needsLLM: true};
            }

            case "UNLOCK":
                return sitrecAPI.call("unlockCamera");

            default:
                return {success: false, error: `Unknown intent: ${intent}`};
        }
    }

    async _geocodeAndGoto(locationName) {
        try {
            const response = await fetch(
                `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(locationName)}&limit=1`,
                {headers: {"User-Agent": "Sitrec/1.0"}}
            );
            const data = await response.json();
            if (data && data.length > 0) {
                const {lat, lon} = data[0];
                return sitrecAPI.call("gotoLLA", {lat: parseFloat(lat), lon: parseFloat(lon), alt: 0});
            }
            return {success: false, error: `Location not found: ${locationName}`, needsLLM: true};
        } catch (e) {
            return {success: false, error: `Geocoding failed: ${e.message}`, needsLLM: true};
        }
    }

    generateResponse(parseResult, executeResult) {
        const {intent, slots} = parseResult;

        if (!executeResult.success) {
            return executeResult.error || "Command failed";
        }

        switch (intent) {
            case "SET_VALUE":
                return `Set ${slots.path} to ${slots.value}`;
            case "TOGGLE_ON":
                return `Enabled ${slots.target}`;
            case "TOGGLE_OFF":
                return `Disabled ${slots.target}`;
            case "ZOOM_IN":
                return "Zoomed in";
            case "ZOOM_OUT":
                return "Zoomed out";
            case "LOAD_SATELLITES":
                return slots.type === "starlink" ? "Loading Starlink satellites..." : "Loading LEO satellites...";
            case "AMBIENT_ONLY":
                return "Switched to ambient only lighting";
            case "SET_MODEL":
            case "SET_OBJECT_MODEL":
                return `Set model to ${slots.model}`;
            case "SET_OBJECT_GEOMETRY":
            case "SET_ALL_GEOMETRY":
                return `Set geometry to ${slots.geometry}`;
            case "MATH":
                return `${executeResult.result.expression} = ${executeResult.result.answer}`;
            case "PLAY":
                return "Playing";
            case "PAUSE":
                return "Paused";
            case "SET_FRAME":
                return `Jumped to frame ${slots.frame}`;
            case "SET_TIME_RELATIVE":
            case "SET_DATETIME":
                return "Time updated";
            case "GOTO_LLA":
                return `Moved to ${slots.lat}, ${slots.lon}`;
            case "GOTO_NAMED_LOCATION":
                return `Moved to ${slots.location}`;
            case "POINT_AT":
                return `Pointing at ${slots.target}`;
            case "LOCK_ON":
                return `Locked on to ${slots.target}`;
            case "UNLOCK":
                return "Camera unlocked";
            default:
                return "Done";
        }
    }
}

export const clientNLU = new CClientNLU();
