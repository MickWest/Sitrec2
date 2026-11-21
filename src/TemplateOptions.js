// Template actions are a small allowlist of built-in behavior, never executable
// code from a saved scene. Editing is admin-only; consuming a template is not.
const DEFAULTS = Object.freeze({
    analyzeImages: false,
    analyzeVideos: false,
    findNightView: false,
    frameStars: false,
    keepLocation: false,
    keepTime: false,
    satellites: 'inherit',
});

export const TEMPLATE_PRESETS = Object.freeze({
    'No automatic actions': {...DEFAULTS},
    'Star Tracker': {...DEFAULTS, analyzeImages: true, analyzeVideos: true,
        findNightView: true, frameStars: true, satellites: 'manual'},
    'Satellite viewing': {...DEFAULTS, satellites: 'manual'},
});

export function templatePresetName(name = '') {
    return name.trim().toLowerCase() === 'star tracker' ? 'Star Tracker' : 'No automatic actions';
}

// A template with no saved options takes its actions from its name, but keeps its
// saved satellite setting. Only a preset applied from the menu sets 'manual'.
export function normalizeTemplateOptions(value, name = '') {
    const result = {...TEMPLATE_PRESETS[templatePresetName(name)], satellites: 'inherit'};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
    for (const key of Object.keys(DEFAULTS)) {
        if (typeof DEFAULTS[key] === 'boolean' && typeof value[key] === 'boolean') result[key] = value[key];
    }
    if (['inherit', 'manual', 'automatic'].includes(value.satellites)) result.satellites = value.satellites;
    return result;
}

export function templateOptions(sitch) {
    return normalizeTemplateOptions(sitch?.templateOptions, sitch?.templateSource?.name);
}

// Called before constructing the graph. Older templates gain a named preset,
// while saved options take precedence. A normal saved scene is not rewritten.
// Satellite settings and catalogs change only for a saved 'manual' or 'automatic'.
export function prepareTemplateSitch(sitch, name) {
    const options = normalizeTemplateOptions(sitch.templateOptions ?? sitch.Sit?.templateOptions, name);
    sitch.templateOptions = options;
    if (sitch.Sit) delete sitch.Sit.templateOptions;
    if (options.satellites !== 'inherit') {
        const automatic = options.satellites === 'automatic';
        for (const container of [sitch, sitch.mods]) {
            if (container?.NightSkyNode) container.NightSkyNode.autoloadSatellites = automatic;
        }
        if (!automatic) {
            // Catalogs saved into a template otherwise load even with Autoload off.
            for (const [id, metadata] of Object.entries(sitch.loadedFilesMetadata ?? {})) {
                if (metadata.dataType !== 'tle') continue;
                if (sitch.loadedFiles) delete sitch.loadedFiles[id];
                delete sitch.loadedFilesMetadata[id];
            }
            if (sitch.mods?.NightSkyNode) delete sitch.mods.NightSkyNode.satelliteCatalogRequest;
        }
    }
    return options;
}

// The restored template's time and position are starting values, not evidence.
// Keep this baseline outside Sit so it can never leak into a saved template.
const sessions = new WeakMap();
export function beginTemplateSession(sitch, snapshot) {
    if (!sitch?.templateSource) return;
    const options = templateOptions(sitch);
    sessions.set(sitch, {...snapshot, location: snapshot.location?.slice(),
        locationKnown: options.keepLocation, timeKnown: options.keepTime, applying: false});
}

export function noteTemplateLocationChange(sitch) {
    const state = sessions.get(sitch);
    if (state && !state.applying) state.locationKnown = true;
}

export function templateConstraints(sitch, snapshot) {
    const state = sessions.get(sitch);
    // Existing saved work, or a setup whose baseline is not ready, is preserved.
    if (!state) return {locationKnown: true, timeKnown: true};
    if (!state.applying) {
        state.timeKnown ||= snapshot.timeSerial !== state.timeSerial;
        state.locationKnown ||= snapshot.cameraChoice !== state.cameraChoice
            || snapshot.location?.slice(0, 2).some((n, i) => Math.abs(n - state.location?.[i]) > 1e-8);
    }
    return {locationKnown: !!state.locationKnown, timeKnown: !!state.timeKnown};
}

export function applyTemplateInference(sitch, apply, readSnapshot) {
    const state = sessions.get(sitch);
    if (state) state.applying = true;
    try { return apply(); }
    finally {
        if (state) {
            const snapshot = readSnapshot();
            Object.assign(state, snapshot, {location: snapshot.location?.slice(), applying: false});
        }
    }
}

export function shouldAnalyzeTemplateMedia(sitch, {primary, restoring, image, audio = false}) {
    if (!primary || restoring || audio || !sitch?.templateSource) return false;
    const options = templateOptions(sitch);
    return image ? options.analyzeImages : options.analyzeVideos;
}
