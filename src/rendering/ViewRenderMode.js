// The render route a view draws for the current frame. renderMode is the saved menu choice. A view can also give a
// transient frameRenderMode, which is never saved: CNodeView3D derives it for the look view from per-frame camera
// data. Every reader that chooses a render route, a color policy or a reflection update uses effectiveRenderMode, so
// within one frame they cannot disagree.
export function effectiveRenderMode(view) {
    return view.frameRenderMode ?? view.renderMode;
}

// A frame the camera data marks as visible light (EO) shows the visible render, also when the saved mode is physical
// thermal. An infrared frame, or a frame without camera data, keeps the saved mode (null).
export function frameRenderModeFor(renderMode, band) {
    return band === "EO" && renderMode === "physicalThermal" ? "visible" : null;
}

// Effects that draw an infrared look over the visible render. A visible-light frame skips them; the other effects
// (blur, noise, levels, compression, pixel zoom) apply as set.
const INFRARED_LOOK_EFFECTS = new Set(["FLIRShader", "Thermal"]);

export function frameEffectPasses(view) {
    if (view.frameBand !== "EO") return view.effectPasses;
    return Object.values(view.effectPasses).filter(effect => !INFRARED_LOOK_EFFECTS.has(effect.effectName));
}

// Effects that enlarge the center of the rendered image by their magnifyFactor (percent).
const MAGNIFYING_EFFECTS = new Set(["pixelZoom", "digitalZoom"]);

// How many times larger than camera.fov alone gives the view draws the scene: camera.zoom
// narrows the projection, and an enabled pixel zoom or digital zoom pass enlarges the
// center of the image. With Video Zoom synced, the two together are the Video Zoom. The
// physical thermal route and disabled effects (renderEffects false: the debug switch)
// draw no effect passes.
export function viewMagnification(view, frame, renderEffects = true) {
    let magnification = view.camera.zoom ?? 1;
    if (!renderEffects || !view.effectsEnabled || effectiveRenderMode(view) === "physicalThermal") return magnification;
    for (const effect of Object.values(frameEffectPasses(view) ?? {})) {
        if (effect.enabled && MAGNIFYING_EFFECTS.has(effect.effectName)) {
            magnification *= effect.in.magnifyFactor.v(frame) / 100;
        }
    }
    return magnification;
}
