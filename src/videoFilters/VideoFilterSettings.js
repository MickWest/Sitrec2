// Settings model and format presets for the video export filter.
//
// Bandwidths are stored in MHz and line geometry in real units, so the presets are
// checkable against published figures rather than being a pile of tuned magic numbers.
// AnalogVideoFilter converts them to pixel sigmas for whatever raster it is running at.

// Colour subcarrier frequencies and active line times, from the broadcast standards.
const NTSC_SUBCARRIER_MHZ = 3.579545;
const PAL_SUBCARRIER_MHZ = 4.43361875;
const NTSC_ACTIVE_LINE_US = 52.6;
const PAL_ACTIVE_LINE_US = 51.95;

export const SIGNAL_FORMATS = {
    digital: {
        name: "Pure digital (no filter)",
        description: "The rendered frames, untouched.",
        native: null,
    },
    ntsc: {
        name: "NTSC (525/60 colour)",
        description: "US broadcast composite. Dot crawl and cross-colour rainbowing.",
        native: {width: 640, height: 480},
        system: "ntsc",
        subcarrierMHz: NTSC_SUBCARRIER_MHZ,
        activeLineUs: NTSC_ACTIVE_LINE_US,
        lines: 486,
    },
    rs170: {
        name: "EIA RS-170 (525/60 monochrome)",
        description: "The pre-colour US studio standard. Luminance only, no subcarrier.",
        native: {width: 640, height: 480},
        system: "ntsc",
        mono: true,
        subcarrierMHz: NTSC_SUBCARRIER_MHZ,
        activeLineUs: NTSC_ACTIVE_LINE_US,
        lines: 485,
    },
    pal: {
        name: "PAL (625/50 colour)",
        description: "European composite. Phase-alternating V axis, softer vertical colour.",
        native: {width: 768, height: 576},
        system: "pal",
        subcarrierMHz: PAL_SUBCARRIER_MHZ,
        activeLineUs: PAL_ACTIVE_LINE_US,
        lines: 576,
    },
    vhs: {
        name: "VHS (SP)",
        description: "Colour-under tape. Smeared colour, head-switching tear, tape noise.",
        native: {width: 640, height: 480},
        system: "ntsc",
        subcarrierMHz: NTSC_SUBCARRIER_MHZ,
        activeLineUs: NTSC_ACTIVE_LINE_US,
        lines: 486,
    },
    vhsWorn: {
        name: "VHS (worn, 3rd generation)",
        description: "A copy of a copy on a played-out tape. Dropouts, tracking error, grain.",
        native: {width: 640, height: 480},
        system: "ntsc",
        subcarrierMHz: NTSC_SUBCARRIER_MHZ,
        activeLineUs: NTSC_ACTIVE_LINE_US,
        lines: 486,
    },
};

// Per-format signal parameters. lumaMHz / chromaMHz are the -3 dB bandwidth limits;
// everything else is a 0-1 severity the shaders scale internally.
//
// noiseLevel starts at 5% of maximum for every format rather than being dialled per
// format, because the CHARACTER of the noise already differs on its own: the grain and
// smear widths are derived from each format's luma and chroma bandwidths, so VHS at 5%
// has colour smears roughly ten times the width of broadcast NTSC at 5% without either
// number saying so.
const SIGNAL_PRESETS = {
    digital: {
        lumaMHz: 6.0, chromaMHz: 2.0, chromaDelayPx: 0, sharpen: 0, hueError: 0,
        comb: 1, ycSeparation: 1, chromaGain: 1,
        jitter: 0, headSwitch: 0, noiseLevel: 0, dropouts: 0,
        interlace: 0, ghosting: 0, scanlines: 0, chromaVBlur: 0, generations: 1,
    },
    ntsc: {
        // 4.2 MHz luma is the channel limit; I/Q are decoded on equal 0.6 MHz bands,
        // as nearly every consumer receiver actually did.
        lumaMHz: 4.2, chromaMHz: 0.6, chromaDelayPx: 0.5, sharpen: 0.15, hueError: 0.15,
        comb: 0.35, ycSeparation: 0, chromaGain: 1,
        jitter: 0.05, headSwitch: 0, noiseLevel: 0.05, dropouts: 0,
        interlace: 0.35, ghosting: 0.05, scanlines: 0.12, chromaVBlur: 0.15, generations: 1,
    },
    rs170: {
        lumaMHz: 4.5, chromaMHz: 0.6, chromaDelayPx: 0, sharpen: 0.2, hueError: 0,
        comb: 1, ycSeparation: 0, chromaGain: 0,
        jitter: 0.04, headSwitch: 0, noiseLevel: 0.05, dropouts: 0,
        interlace: 0.4, ghosting: 0.06, scanlines: 0.18, chromaVBlur: 0, generations: 1,
    },
    pal: {
        lumaMHz: 5.0, chromaMHz: 1.0, chromaDelayPx: 0.5, sharpen: 0.12, hueError: 0.02,
        // PAL receivers separated chroma with a delay line rather than a line comb,
        // so the comb term stays low and the delay-line softness rides on chromaVBlur.
        comb: 0.2, ycSeparation: 0, chromaGain: 1,
        jitter: 0.04, headSwitch: 0, noiseLevel: 0.05, dropouts: 0,
        interlace: 0.35, ghosting: 0.05, scanlines: 0.12, chromaVBlur: 0.45, generations: 1,
    },
    vhs: {
        // ~240 TV lines of horizontal luma resolution, and colour recorded under the
        // luma at 629 kHz with only about 400 kHz of bandwidth left for it.
        lumaMHz: 2.6, chromaMHz: 0.4, chromaDelayPx: 2.5, sharpen: 0.55, hueError: 0.10,
        comb: 0.15, ycSeparation: 0, chromaGain: 0.95,
        jitter: 0.35, headSwitch: 0.6, noiseLevel: 0.05, dropouts: 0.15,
        interlace: 0.5, ghosting: 0.12, scanlines: 0.15, chromaVBlur: 0.6, generations: 1,
    },
    vhsWorn: {
        lumaMHz: 1.9, chromaMHz: 0.3, chromaDelayPx: 4.0, sharpen: 0.7, hueError: 0.35,
        comb: 0.05, ycSeparation: 0, chromaGain: 0.75,
        jitter: 0.8, headSwitch: 1.0, noiseLevel: 0.05, dropouts: 0.6,
        interlace: 0.6, ghosting: 0.25, scanlines: 0.2, chromaVBlur: 0.8, generations: 3,
    },
};

export const SCREEN_PRESETS = {
    off: {name: "Off"},
    handheld: {
        name: "Phone, handheld",
        values: {
            handheld: 0.5, handheldSpeed: 1.0, handheldDrift: 0.5, handheldRotation: 0.5,
            handheldVariation: 0.6, zoom: 1.06, keystone: 0.10, barrel: 0.06,
            aberration: 0.0015, edgeSoftness: 0.7,
            autoExposure: true, exposureBias: 0.25, exposureSpeed: 0.35,
            knee: 0.55, clip: 0.45, blackCrush: 0.06, blackLift: 0.02,
            bloom: 0.5, glare: 0.05, gridDepth: 0.18, gridPitch: 0.42,
            beat: 0.05, beatBars: 1.6, beatSpeed: 0.11,
            vignette: 0.35, noise: 0.02,
        },
    },
    handheldRough: {
        name: "Phone, handheld (unsteady)",
        values: {
            handheld: 1.0, handheldSpeed: 1.6, handheldDrift: 0.9, handheldRotation: 1.0,
            handheldVariation: 1.0, zoom: 1.12, keystone: 0.18, barrel: 0.09,
            aberration: 0.0025, edgeSoftness: 1.2,
            autoExposure: true, exposureBias: 0.45, exposureSpeed: 0.6,
            knee: 0.45, clip: 0.7, blackCrush: 0.10, blackLift: 0.03,
            bloom: 0.8, glare: 0.10, gridDepth: 0.26, gridPitch: 0.37,
            beat: 0.10, beatBars: 2.2, beatSpeed: 0.17,
            vignette: 0.45, noise: 0.035,
        },
    },
    tripod: {
        name: "Phone, on a tripod",
        values: {
            handheld: 0.05, handheldSpeed: 0.4, handheldDrift: 0.2, handheldRotation: 0.1,
            handheldVariation: 0.2, zoom: 1.02, keystone: 0.05, barrel: 0.04,
            aberration: 0.001, edgeSoftness: 0.4,
            autoExposure: true, exposureBias: 0.15, exposureSpeed: 0.2,
            knee: 0.6, clip: 0.35, blackCrush: 0.04, blackLift: 0.015,
            bloom: 0.4, glare: 0.03, gridDepth: 0.22, gridPitch: 0.45,
            beat: 0.04, beatBars: 1.4, beatSpeed: 0.09,
            vignette: 0.25, noise: 0.012,
        },
    },
};

export const DEFAULT_ENCODING = {
    formatId: "mp4-h264",
    bitrateMbps: 8,
    keyFrameInterval: 30,
};

export function defaultSignalSettings(format = "digital") {
    return {format, resolution: "viewport", ...SIGNAL_PRESETS[format]};
}

export function defaultScreenSettings() {
    return {enabled: false, preset: "handheld", ...SCREEN_PRESETS.handheld.values};
}

export function defaultVideoFilterSettings() {
    return {
        signal: defaultSignalSettings("digital"),
        screen: defaultScreenSettings(),
        encoding: {...DEFAULT_ENCODING},
    };
}

// Load a format's preset over the current signal parameters, keeping the chosen output
// resolution. Both of these MUTATE the section in place rather than replacing it: the
// dialog's controls each hold a reference to the object they edit, and swapping the
// object out from under them leaves every slider writing to a detached copy.
export function applySignalPreset(settings, format) {
    const preset = SIGNAL_PRESETS[format] ?? SIGNAL_PRESETS.digital;
    Object.assign(settings.signal, preset, {format});
    return settings;
}

export function applyScreenPreset(settings, presetName) {
    const preset = SCREEN_PRESETS[presetName];
    if (!preset || !preset.values) return settings;
    Object.assign(settings.screen, preset.values, {preset: presetName});
    return settings;
}

// Expand a partial specification into a complete settings object: pick the format's
// preset, then lay the caller's overrides on top. This is the entry point for callers
// that describe a filter as data rather than through the dialog - a benchmark scenario
// file saying {signal: {format: "vhs"}, screen: {enabled: true, preset: "handheld"}}
// gets the full, physically-derived preset without restating forty parameters.
export function resolveVideoFilterSettings(spec) {
    if (!spec) return defaultVideoFilterSettings();

    // A bare format name is the common case: resolveVideoFilterSettings("vhs").
    if (typeof spec === "string") spec = {signal: {format: spec}};

    const settings = defaultVideoFilterSettings();

    const signalSpec = spec.signal ?? {};
    const format = SIGNAL_PRESETS[signalSpec.format] ? signalSpec.format : "digital";
    settings.signal = {...defaultSignalSettings(format), ...signalSpec, format};

    const screenSpec = spec.screen ?? {};
    const presetName = SCREEN_PRESETS[screenSpec.preset]?.values ? screenSpec.preset : "handheld";
    settings.screen = {
        ...defaultScreenSettings(),
        ...SCREEN_PRESETS[presetName].values,
        ...screenSpec,
        preset: presetName,
    };

    settings.encoding = {...DEFAULT_ENCODING, ...(spec.encoding ?? {})};
    return settings;
}

// True when the chain would change any pixel - lets the exporter skip the whole
// GPU stage (and its lazy chunk) for a plain digital export.
export function isVideoFilterActive(settings) {
    if (!settings) return false;
    const analog = settings.signal && settings.signal.format !== "digital";
    const screen = settings.screen && settings.screen.enabled;
    return !!(analog || screen);
}

// Output raster for a set of settings. "native" snaps to the format's square-pixel
// active picture (720x480 with its 8:9 pixels becomes 640x480 square), which is what
// makes the subcarrier land at a realistic number of samples per pixel.
export function filterOutputSize(settings, viewportWidth, viewportHeight) {
    const format = SIGNAL_FORMATS[settings?.signal?.format];
    if (settings?.signal?.resolution === "native" && format && format.native) {
        return {width: format.native.width, height: format.native.height};
    }
    return {width: viewportWidth, height: viewportHeight};
}

// One-line summary for the export log and the filename suffix.
export function describeVideoFilter(settings) {
    if (!isVideoFilterActive(settings)) return "no filter";
    const parts = [];
    const format = SIGNAL_FORMATS[settings.signal.format];
    if (settings.signal.format !== "digital" && format) {
        parts.push(format.name);
        if (settings.signal.generations > 1) parts.push(`${settings.signal.generations} generations`);
    }
    if (settings.screen.enabled) {
        parts.push(`off a screen (${SCREEN_PRESETS[settings.screen.preset]?.name ?? settings.screen.preset})`);
    }
    return parts.join(" + ");
}

export function videoFilterFilenameSuffix(settings) {
    if (!isVideoFilterActive(settings)) return "";
    const parts = [];
    if (settings.signal.format !== "digital") parts.push(settings.signal.format.toLowerCase());
    if (settings.screen.enabled) parts.push("offscreen");
    return parts.length ? "_" + parts.join("-") : "";
}
