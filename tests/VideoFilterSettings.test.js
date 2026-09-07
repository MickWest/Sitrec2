// The video export filter's settings model. These are the functions callers reach for
// when they describe a filter as data rather than through the dialog - notably the
// benchmark recorder, which takes a filter spec straight out of a scenario plan.

import {
    defaultVideoFilterSettings,
    describeVideoFilter,
    filterOutputSize,
    isVideoFilterActive,
    resolveVideoFilterSettings,
    SIGNAL_FORMATS,
    videoFilterFilenameSuffix,
} from "../src/videoFilters/VideoFilterSettings";

describe("default settings", () => {
    test("default is a pure digital export that changes nothing", () => {
        const settings = defaultVideoFilterSettings();
        expect(settings.signal.format).toBe("digital");
        expect(settings.screen.enabled).toBe(false);
        expect(isVideoFilterActive(settings)).toBe(false);
        expect(videoFilterFilenameSuffix(settings)).toBe("");
    });

    test("every format has the physical constants its shaders need", () => {
        for (const [key, format] of Object.entries(SIGNAL_FORMATS)) {
            if (key === "digital") continue;
            expect(format.lines).toBeGreaterThan(400);
            expect(format.subcarrierMHz).toBeGreaterThan(3);
            expect(format.activeLineUs).toBeGreaterThan(50);
            expect(format.native.width).toBeGreaterThan(0);
        }
    });
});

describe("resolveVideoFilterSettings", () => {
    test("a bare format name expands to that format's full preset", () => {
        const settings = resolveVideoFilterSettings("vhs");
        expect(settings.signal.format).toBe("vhs");
        // Colour under, so chroma is recorded on a far narrower band than luma.
        expect(settings.signal.chromaMHz).toBeLessThan(settings.signal.lumaMHz / 4);
        expect(settings.signal.headSwitch).toBeGreaterThan(0);
        expect(isVideoFilterActive(settings)).toBe(true);
    });

    test("overrides sit on top of the preset rather than replacing it", () => {
        const settings = resolveVideoFilterSettings({signal: {format: "vhs", noise: 0.2}});
        expect(settings.signal.noise).toBe(0.2);
        expect(settings.signal.chromaMHz).toBe(resolveVideoFilterSettings("vhs").signal.chromaMHz);
    });

    test("an unknown format falls back to digital instead of producing NaN uniforms", () => {
        const settings = resolveVideoFilterSettings({signal: {format: "betamax"}});
        expect(settings.signal.format).toBe("digital");
        expect(Number.isFinite(settings.signal.lumaMHz)).toBe(true);
    });

    test("an unknown camera preset falls back to a real one", () => {
        const settings = resolveVideoFilterSettings({screen: {enabled: true, preset: "drone"}});
        expect(settings.screen.preset).toBe("handheld");
        expect(Number.isFinite(settings.screen.zoom)).toBe(true);
    });

    test("no spec at all gives the inert defaults", () => {
        expect(isVideoFilterActive(resolveVideoFilterSettings(null))).toBe(false);
    });

    test("every resolved parameter is a finite number or a boolean", () => {
        for (const format of Object.keys(SIGNAL_FORMATS)) {
            const settings = resolveVideoFilterSettings({signal: {format}, screen: {enabled: true}});
            for (const section of ["signal", "screen"]) {
                for (const [key, value] of Object.entries(settings[section])) {
                    if (typeof value === "string" || typeof value === "boolean") continue;
                    // Reported as an object so a failure names the offending parameter:
                    // a NaN reaching a uniform silently blanks the whole frame.
                    expect({parameter: `${format}.${section}.${key}`, finite: Number.isFinite(value)})
                        .toEqual({parameter: `${format}.${section}.${key}`, finite: true});
                }
            }
        }
    });
});

describe("colour expectations", () => {
    // The benchmark recorder's round-trip check rejects any colour in a frame, because
    // those scenes render grayscale and colour means the wrong render path produced the
    // clip. A colour signal format makes chroma expected; a monochrome one does not, and
    // must still come back grayscale. That distinction is drawn from these two fields.
    test("RS-170 is the only monochrome format", () => {
        expect(SIGNAL_FORMATS.rs170.mono).toBe(true);
        for (const key of ["ntsc", "pal", "vhs", "vhsWorn"]) {
            expect(SIGNAL_FORMATS[key].mono).toBeUndefined();
        }
    });

    test("tape noise starts at 5% of maximum on every analog format", () => {
        for (const key of ["ntsc", "rs170", "pal", "vhs", "vhsWorn"]) {
            expect(resolveVideoFilterSettings(key).signal.noiseLevel).toBe(0.05);
        }
        // Digital skips the analog stage entirely, so it carries no noise at all.
        expect(resolveVideoFilterSettings("digital").signal.noiseLevel).toBe(0);
    });

    test("noise character comes from the channel bandwidths, not the level", () => {
        // Same level everywhere, but VHS records colour on a far narrower band than
        // NTSC, so its colour-noise smears are far wider. That difference is what keeps
        // the formats distinguishable at one shared default.
        const vhs = resolveVideoFilterSettings("vhs").signal;
        const ntsc = resolveVideoFilterSettings("ntsc").signal;
        expect(vhs.noiseLevel).toBe(ntsc.noiseLevel);
        expect(ntsc.chromaMHz / vhs.chromaMHz).toBeGreaterThan(1.4);
    });

    test("a monochrome format carries no chroma gain, a colour one does", () => {
        expect(resolveVideoFilterSettings("rs170").signal.chromaGain).toBe(0);
        for (const key of ["ntsc", "pal", "vhs", "vhsWorn"]) {
            expect(resolveVideoFilterSettings(key).signal.chromaGain).toBeGreaterThan(0);
        }
    });
});

describe("isVideoFilterActive", () => {
    test("the off-a-screen stage alone is enough to need the filter", () => {
        const settings = resolveVideoFilterSettings({screen: {enabled: true}});
        expect(settings.signal.format).toBe("digital");
        expect(isVideoFilterActive(settings)).toBe(true);
    });
});

describe("filterOutputSize", () => {
    test("viewport resolution keeps the caller's raster", () => {
        const settings = resolveVideoFilterSettings("vhs");
        expect(filterOutputSize(settings, 1920, 1080)).toEqual({width: 1920, height: 1080});
    });

    test("native resolution snaps to the format's square-pixel active picture", () => {
        const ntsc = resolveVideoFilterSettings({signal: {format: "ntsc", resolution: "native"}});
        expect(filterOutputSize(ntsc, 1920, 1080)).toEqual({width: 640, height: 480});

        const pal = resolveVideoFilterSettings({signal: {format: "pal", resolution: "native"}});
        expect(filterOutputSize(pal, 1920, 1080)).toEqual({width: 768, height: 576});
    });

    test("digital has no native raster to snap to, so the request is ignored", () => {
        const settings = resolveVideoFilterSettings({signal: {format: "digital", resolution: "native"}});
        expect(filterOutputSize(settings, 1280, 720)).toEqual({width: 1280, height: 720});
    });
});

describe("filename suffix", () => {
    test("names both stages so a filtered export is not mistaken for a clean one", () => {
        const settings = resolveVideoFilterSettings({signal: {format: "vhs"}, screen: {enabled: true}});
        expect(videoFilterFilenameSuffix(settings)).toBe("_vhs-offscreen");
    });

    test("a null filter adds nothing to the filename", () => {
        expect(videoFilterFilenameSuffix(null)).toBe("");
    });

    test("the description names the format and the generation count", () => {
        const settings = resolveVideoFilterSettings("vhsWorn");
        expect(describeVideoFilter(settings)).toContain("VHS");
        expect(describeVideoFilter(settings)).toContain("3 generations");
    });
});
