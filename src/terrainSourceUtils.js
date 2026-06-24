export function filterSourcesForServerless(sources) {
    return Object.fromEntries(
        Object.entries(sources).filter(([, sourceDef]) => sourceDef?.allowInServerless === true)
    );
}

// Keep only the user's env-defined custom sources (key matches customKeyRegex, e.g.
// /^CustomMap_/) plus the built-in sources explicitly flagged `offlineSafe: true`
// (Local, Debug, etc. — sources that don't need third-party internet access).
// Used when SITREC_ENABLE_DEFAULT_*_SOURCES=false to strip the internet providers
// (ESRI, MapBox, MapTiler, EOX, AWS, …) for restricted / offline deployments.
export function filterToCustomAndOfflineSources(sources, customKeyRegex) {
    return Object.fromEntries(
        Object.entries(sources).filter(
            ([key, sourceDef]) => customKeyRegex.test(key) || sourceDef?.offlineSafe === true
        )
    );
}

// A SITREC_ENABLE_DEFAULT_*_SOURCES flag defaults to enabled; only an explicit
// "false" (string, as env values arrive) or boolean false disables it.
export function defaultSourcesEnabled(value) {
    return !(value === false || String(value ?? "").trim().toLowerCase() === "false");
}

export function pickAvailableSourceType({
    sources,
    requestedType,
    defaultType,
    fallbackType = "Local",
}) {
    if (requestedType && sources[requestedType]) {
        return requestedType;
    }

    if (defaultType && sources[defaultType]) {
        return defaultType;
    }

    if (fallbackType && sources[fallbackType]) {
        return fallbackType;
    }

    return Object.keys(sources)[0];
}
