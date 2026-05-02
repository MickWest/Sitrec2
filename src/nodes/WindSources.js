// Single source of truth for wind field data sources.
//
// Three places consumed this list before:
//   - CustomSupport.js — dropdown label → internal key
//   - CNodeDisplayWindField.js — branches inside fetchWindForAltitude
//   - CNodeCompassUI.js — internal key → compass-label string
//
// Keeping them in sync was error-prone. Anyone adding a built-in source now
// only updates this array.
//
// Fields:
//   key      — internal identifier used in this.source and save files
//   label    — full dropdown label in the Wind Data folder
//   short    — compact label for the compass widget ("Wind: <short>")
//   autoLoad — 'uwyo' / 'igra2' / null — which sounding source, if any,
//              auto-fetches when this source is selected and no profiles
//              of that kind are already loaded

import {Globals} from "../Globals";

export const WIND_SOURCES = [
    { key: "gfs",              label: "GFS (NOAA)",       short: "GFS",              autoLoad: null },
    { key: "uwyo",             label: "UWYO Soundings",   short: "UWYO",             autoLoad: "uwyo" },
    { key: "igra2",            label: "IGRA2 Soundings",  short: "IGRA2",            autoLoad: "igra2" },
    { key: "manual-soundings", label: "Manual Soundings", short: "Manual Soundings", autoLoad: null },
    { key: "openmeteo",        label: "open-meteo",       short: "open-meteo",       autoLoad: null },
    { key: "manual",           label: "Manual",           short: "Manual",           autoLoad: null },
];

// Reserved key for the env-var-defined custom source (CUSTOM_WIND_URL,
// served via customWindProxy.php). Resolved at call time because Globals.env
// is populated after this module's top-level code runs.
export const CUSTOM_WIND_KEY = "custom";

function getCustomWindSource() {
    if (!Globals.env?.SITREC_USE_CUSTOM_WIND) return null;
    const label = Globals.env.SITREC_CUSTOM_WIND_MENU_NAME || "Custom Wind";
    return {
        key: CUSTOM_WIND_KEY,
        label,
        short: label,
        autoLoad: null,
    };
}

// Built-ins + the optional env-defined custom source. Use this rather than
// iterating WIND_SOURCES directly when building dropdowns or doing key lookups.
export function getWindSources() {
    const custom = getCustomWindSource();
    return custom ? [...WIND_SOURCES, custom] : WIND_SOURCES;
}

export const DEFAULT_WIND_SOURCE_KEY = "manual";

export function windSourceByKey(key) {
    return getWindSources().find(s => s.key === key) ?? null;
}

export function windSourceByLabel(label) {
    return getWindSources().find(s => s.label === label) ?? null;
}

// { label: key, ... } — convenient for lil-gui's dropdown that takes an
// object whose keys are displayed and values are stored.
export function windSourceLabelsToKeys() {
    const out = {};
    for (const s of getWindSources()) out[s.label] = s.key;
    return out;
}

// { key: short, ... } — used by the compass widget.
export function windSourceShortLabels() {
    const out = {};
    for (const s of getWindSources()) out[s.key] = s.short;
    return out;
}

// Track-source key encoding. MISB tracks with embedded WindDirection /
// WindSpeed columns are exposed as additional options on the source
// dropdowns; their internal key is `track:<TrackData_*>` so the wind
// node can resolve them by NodeMan lookup. Two helpers keep the encoding
// in one place (parser + builder).
export const TRACK_SOURCE_PREFIX = "track:";

export function isTrackSourceKey(key) {
    return typeof key === "string" && key.startsWith(TRACK_SOURCE_PREFIX);
}

export function trackSourceKey(trackDataId) {
    return TRACK_SOURCE_PREFIX + trackDataId;
}

export function trackDataIdFromSourceKey(key) {
    return isTrackSourceKey(key)
        ? key.slice(TRACK_SOURCE_PREFIX.length)
        : null;
}

// Build the labels→keys map for both source dropdowns, including any
// MISB tracks that carry per-frame wind columns. Each track entry is
// rendered as "Track: <shortName>" in the dropdown, mapping to the
// "track:TrackData_<shortName>" internal key.
export function windSourceLabelsToKeysWithTracks(trackEntries = []) {
    const out = {};
    for (const s of getWindSources()) out[s.label] = s.key;
    for (const entry of trackEntries) {
        out[`Track: ${entry.shortName}`] = trackSourceKey(entry.trackDataId);
    }
    return out;
}
