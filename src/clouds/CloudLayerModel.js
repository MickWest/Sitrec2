// CloudLayerModel.js - the data model of the volumetric cloud layers.
//
// Pure JavaScript, no Three.js: the layer objects are plain data that the
// node (CNodeCloudLayers) edits through its GUI, serializes with the sitch,
// and packs into shader uniforms. Everything here is unit-tested.
//
// A layer is either a VOLUME (marched through its whole thickness: cumulus,
// stratocumulus, stratus, cumulonimbus) or a SHEET (one optically thin
// surface at the middle of the layer: altocumulus and the cirrus family).

export const MAX_CLOUD_LAYERS = 4;
export const CLOUD_STATE_VERSION = 1;

export const CLOUD_QUALITIES = ["Low", "Medium", "High", "Ultra"];

// What each quality level costs and buys:
//   resolution   fraction of the view's pixels per axis that the march renders
//                (a depth-aware upsample fills in the rest; 1 = every pixel)
//   steps        density samples per pixel (searching and inside clouds)
//   skipSteps    cheap clear-air samples per pixel (one texture read each)
//   lightSteps   samples toward the sun from each density sample
//   fineStep     step inside a cloudy column, in march pixels at that distance
//   opticalStep  the most optical depth one step inside a cloud may cross
//   detailLevel  0: no fine detail texture; 1: fine detail near cloud surfaces;
//                2: also in the first light sample (sharper self-shadowing)
export const CLOUD_QUALITY_SETTINGS = {
    Low: {resolution: 0.25, steps: 32, skipSteps: 48, lightSteps: 3, fineStep: 4, opticalStep: 1.5, detailLevel: 0},
    Medium: {resolution: 0.375, steps: 48, skipSteps: 96, lightSteps: 3, fineStep: 4, opticalStep: 1.2, detailLevel: 1},
    High: {resolution: 0.5, steps: 96, skipSteps: 160, lightSteps: 4, fineStep: 3, opticalStep: 0.8, detailLevel: 2},
    Ultra: {resolution: 1, steps: 128, skipSteps: 256, lightSteps: 6, fineStep: 2, opticalStep: 0.5, detailLevel: 2},
};

export function cloudQualitySettings(quality) {
    return CLOUD_QUALITY_SETTINGS[quality] ?? CLOUD_QUALITY_SETTINGS.Medium;
}

// The size of the march target for a view of width x height pixels: at least
// one pixel, never more than the view.
export function marchTargetSize(width, height, resolution) {
    const scale = Math.min(1, Math.max(0.0625, resolution || 1));
    return {
        width: Math.max(1, Math.min(width, Math.ceil(width * scale))),
        height: Math.max(1, Math.min(height, Math.ceil(height * scale))),
    };
}

export const CLOUD_WIND_MODES = ["profile", "local", "target", "custom", "none"];
export const CLOUD_EXTENT_MODES = ["global", "disc"];

// Type table. The GUI applies these defaults when the type changes; every value
// can still be edited afterwards. Shader-only parameters (gradient, extinction,
// pattern, ...) are not user fields and always come from the table.
//
// gradient: density against the height fraction hf (0 at the base, 1 at the top),
//   as four points (a, b, c, d): zero below a, rising to full at b, full to c,
//   falling to zero at d.
// extinction: extinction coefficient in 1/m at density 1 (cloud droplets).
// opticalDepth (sheets): vertical optical depth at density 1 and full pattern.
// pattern (sheets): 0 cellular (Worley), 1 fibrous (streaks along the wind),
//   2 veil (near uniform).
export const CLOUD_TYPES = {
    cumulus: {
        render: "volume", baseAltitude: 1500, thickness: 1500, coverage: 0.45, scale: 4000,
        detail: 0.5, windSkew: 0.15, gradient: [0.0, 0.15, 0.55, 1.0], extinction: 0.05, domed: 1, anvil: 0,
    },
    stratocumulus: {
        render: "volume", baseAltitude: 1200, thickness: 800, coverage: 0.75, scale: 3000,
        detail: 0.6, windSkew: 0.05, gradient: [0.0, 0.2, 0.5, 0.9], extinction: 0.04, domed: 0.5, anvil: 0,
    },
    stratus: {
        render: "volume", baseAltitude: 300, thickness: 400, coverage: 1.0, scale: 6000,
        detail: 0.3, windSkew: 0, gradient: [0.0, 0.05, 0.8, 1.0], extinction: 0.02, domed: 0, anvil: 0,
    },
    cumulonimbus: {
        render: "volume", baseAltitude: 1000, thickness: 9000, coverage: 0.7, scale: 9000,
        detail: 0.45, windSkew: 0.25, gradient: [0.0, 0.05, 0.9, 1.0], extinction: 0.06, domed: 1, anvil: 1,
    },
    altocumulus: {
        render: "sheet", baseAltitude: 4000, thickness: 400, coverage: 0.6, scale: 1500,
        detail: 0.5, windSkew: 0, opticalDepth: 6, pattern: 0, extinction: 0.03,
    },
    cirrus: {
        render: "sheet", baseAltitude: 9000, thickness: 800, coverage: 0.5, scale: 8000,
        detail: 0.5, windSkew: 0, opticalDepth: 0.9, pattern: 1, extinction: 0.002,
    },
    cirrostratus: {
        render: "sheet", baseAltitude: 8000, thickness: 600, coverage: 1.0, scale: 20000,
        detail: 0.3, windSkew: 0, opticalDepth: 0.35, pattern: 2, extinction: 0.001,
    },
    cirrocumulus: {
        render: "sheet", baseAltitude: 7000, thickness: 300, coverage: 0.6, scale: 700,
        detail: 0.5, windSkew: 0, opticalDepth: 1.2, pattern: 0, extinction: 0.004,
    },
};

export const CLOUD_TYPE_NAMES = Object.keys(CLOUD_TYPES);
export const CLOUD_TYPE_INDEX = Object.fromEntries(CLOUD_TYPE_NAMES.map((name, index) => [name, index]));

export function cloudTypeInfo(type) {
    return CLOUD_TYPES[type] ?? CLOUD_TYPES.cumulus;
}

export function isSheetType(type) {
    return cloudTypeInfo(type).render === "sheet";
}

// User-editable ranges. Altitudes and lengths in meters.
export const CLOUD_LIMITS = {
    baseAltitude: [-500, 20000],
    thickness: [20, 15000],
    coverage: [0, 1],
    density: [0, 5],
    scale: [100, 50000],
    detail: [0, 1],
    seed: [0, 9999],
    windSkew: [0, 1],
    radius: [100, 500000],
    feather: [0, 200000],
    from: [0, 360],
    knots: [0, 300],
};

function clamp(value, [low, high]) {
    return Math.min(high, Math.max(low, value));
}

function finiteOr(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

// Defaults for a layer of a given type: the type table plus the shared fields.
export function layerDefaultsFor(type = "cumulus") {
    const info = cloudTypeInfo(type);
    const name = CLOUD_TYPES[type] ? type : "cumulus";
    return {
        id: "layer1",
        name: "",
        visible: true,
        type: name,
        baseAltitude: info.baseAltitude,
        thickness: info.thickness,
        coverage: info.coverage,
        density: 1.0,
        scale: info.scale,
        detail: info.detail,
        extent: {mode: "global", lat: null, lon: null, radius: 20000, feather: 5000},
        seed: 0,
        wind: {mode: "local", from: 270, knots: 20},
        windSkew: info.windSkew,
    };
}

// Validate a (possibly partial or stale) layer object and fill every field.
// Unknown types fall back to cumulus; numbers are clamped to CLOUD_LIMITS.
export function normalizeLayer(obj = {}, {id} = {}) {
    const type = CLOUD_TYPES[obj.type] ? obj.type : "cumulus";
    const base = layerDefaultsFor(type);
    const extentIn = obj.extent ?? {};
    const windIn = obj.wind ?? {};
    const lat = extentIn.lat === null || extentIn.lat === undefined ? null : finiteOr(extentIn.lat, null);
    const lon = extentIn.lon === null || extentIn.lon === undefined ? null : finiteOr(extentIn.lon, null);
    const layer = {
        id: typeof (id ?? obj.id) === "string" && (id ?? obj.id) !== "" ? (id ?? obj.id) : base.id,
        name: typeof obj.name === "string" ? obj.name : "",
        visible: obj.visible === undefined ? true : !!obj.visible,
        type,
        baseAltitude: clamp(finiteOr(obj.baseAltitude, base.baseAltitude), CLOUD_LIMITS.baseAltitude),
        thickness: clamp(finiteOr(obj.thickness, base.thickness), CLOUD_LIMITS.thickness),
        coverage: clamp(finiteOr(obj.coverage, base.coverage), CLOUD_LIMITS.coverage),
        density: clamp(finiteOr(obj.density, base.density), CLOUD_LIMITS.density),
        scale: clamp(finiteOr(obj.scale, base.scale), CLOUD_LIMITS.scale),
        detail: clamp(finiteOr(obj.detail, base.detail), CLOUD_LIMITS.detail),
        extent: {
            mode: CLOUD_EXTENT_MODES.includes(extentIn.mode) ? extentIn.mode : "global",
            lat: lat === null ? null : clamp(lat, [-90, 90]),
            lon: lon === null ? null : ((lon + 540) % 360) - 180,
            radius: clamp(finiteOr(extentIn.radius, base.extent.radius), CLOUD_LIMITS.radius),
            feather: clamp(finiteOr(extentIn.feather, base.extent.feather), CLOUD_LIMITS.feather),
        },
        seed: Math.round(clamp(finiteOr(obj.seed, base.seed), CLOUD_LIMITS.seed)),
        wind: {
            mode: CLOUD_WIND_MODES.includes(windIn.mode) ? windIn.mode : base.wind.mode,
            from: ((finiteOr(windIn.from, base.wind.from) % 360) + 360) % 360,
            knots: clamp(finiteOr(windIn.knots, base.wind.knots), CLOUD_LIMITS.knots),
        },
        windSkew: clamp(finiteOr(obj.windSkew, base.windSkew), CLOUD_LIMITS.windSkew),
    };
    // A disc needs a center; without one it is drawn as a global layer until set.
    if (layer.extent.mode === "disc" && (layer.extent.lat === null || layer.extent.lon === null)) {
        layer.extent.lat = null;
        layer.extent.lon = null;
    }
    return layer;
}

// Change the type of a layer and apply that type's defaults to the fields the
// type controls (altitude, thickness, coverage, scale, detail, wind skew).
// Extent, wind, seed, density, name and visibility are kept.
export function applyTypeDefaults(layer, type) {
    const info = cloudTypeInfo(type);
    return normalizeLayer({
        ...layer,
        type,
        baseAltitude: info.baseAltitude,
        thickness: info.thickness,
        coverage: info.coverage,
        scale: info.scale,
        detail: info.detail,
        windSkew: info.windSkew,
    });
}

// The first free id "layerN" for a new layer.
export function nextLayerId(layers) {
    const used = new Set(layers.map(layer => layer.id));
    for (let index = 1; index <= MAX_CLOUD_LAYERS + used.size; index++) {
        if (!used.has(`layer${index}`)) return `layer${index}`;
    }
    return `layer${used.size + 1}`;
}

// Named one-click skies. Each entry is a list of partial layers; a disc layer's
// center (lat/lon null) is filled in by the node from the current view.
export const CLOUD_PRESETS = {
    "Clear": [],
    "Few Cumulus": [
        {type: "cumulus", coverage: 0.25},
    ],
    "Scattered Cumulus": [
        {type: "cumulus", coverage: 0.45},
    ],
    "Broken Stratocumulus": [
        {type: "stratocumulus", coverage: 0.78},
    ],
    "Overcast Stratus": [
        {type: "stratus", coverage: 1.0, baseAltitude: 400, thickness: 500},
    ],
    "Fog": [
        {type: "stratus", coverage: 1.0, baseAltitude: -100, thickness: 350, density: 0.6, scale: 3000},
    ],
    "Cirrus Veil": [
        {type: "cirrus", coverage: 0.6},
        {type: "cirrostratus", coverage: 1.0, density: 0.6},
    ],
    "Towering Storm": [
        {type: "cumulonimbus", extent: {mode: "disc", lat: null, lon: null, radius: 7000, feather: 3000}},
        {type: "cumulus", coverage: 0.25},
    ],
    "Cumulus Under Cirrus": [
        {type: "cumulus", coverage: 0.4},
        {type: "cirrus", coverage: 0.55},
    ],
    "Altocumulus": [
        {type: "altocumulus", coverage: 0.65},
    ],
};

export const CLOUD_PRESET_NAMES = Object.keys(CLOUD_PRESETS);

// The full layer list of a preset, normalized, with ids and type defaults.
export function presetLayers(name) {
    const preset = CLOUD_PRESETS[name];
    if (!preset) return null;
    const layers = [];
    for (const partial of preset.slice(0, MAX_CLOUD_LAYERS)) {
        const defaults = layerDefaultsFor(partial.type);
        layers.push(normalizeLayer({
            ...defaults,
            ...partial,
            extent: {...defaults.extent, ...(partial.extent ?? {})},
            wind: {...defaults.wind, ...(partial.wind ?? {})},
            seed: layers.length * 17,
        }, {id: nextLayerId(layers)}));
    }
    return layers;
}

// The node state as saved in the sitch. Layers are copied (no shared objects).
// showMain / showLook say which 3D views draw the clouds (default: the look view only).
export function serializeCloudState({showMain = false, showLook = true, quality = "Medium", layers = []} = {}) {
    return {
        version: CLOUD_STATE_VERSION,
        showMain: !!showMain,
        showLook: !!showLook,
        quality: CLOUD_QUALITIES.includes(quality) ? quality : "Medium",
        layers: layers.slice(0, MAX_CLOUD_LAYERS).map(layer => {
            const normal = normalizeLayer(layer);
            return {...normal, extent: {...normal.extent}, wind: {...normal.wind}};
        }),
    };
}

// The inverse of serializeCloudState, tolerant of missing or bad fields.
// Duplicate layer ids are renumbered so every layer keeps its own GUI folder.
export function deserializeCloudState(saved) {
    const input = saved && typeof saved === "object" ? saved : {};
    const layers = [];
    const valid = Array.isArray(input.layers) ? input.layers.filter(raw => raw && typeof raw === "object") : [];
    for (const raw of valid.slice(0, MAX_CLOUD_LAYERS)) {
        const duplicate = layers.some(layer => layer.id === raw.id);
        layers.push(normalizeLayer(raw, duplicate || !raw.id ? {id: nextLayerId(layers)} : {}));
    }
    // A single "enabled" flag (an early draft of this state) maps to the look view.
    const legacyOff = input.enabled === false;
    return {
        showMain: input.showMain === undefined ? false : !!input.showMain,
        showLook: input.showLook === undefined ? !legacyOff : !!input.showLook,
        quality: CLOUD_QUALITIES.includes(input.quality) ? input.quality : "Medium",
        layers,
    };
}

// A short label for the layer's GUI folder: "Layer 1: Cumulus".
export function layerTitle(layer, index) {
    const type = layer.type.charAt(0).toUpperCase() + layer.type.slice(1);
    const name = layer.name ? ` (${layer.name})` : "";
    return `Layer ${index + 1}: ${type}${name}`;
}
