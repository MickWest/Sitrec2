// Live video-format effects: the same analog signal and off-a-screen simulation the
// export dialog offers, running on screen over the look view.
//
// WHY THIS IS A LAYER AND NOT A ShaderPass. Sitrec's other effects (FLIR, night vision,
// the diffraction glare) are ShaderPasses inside CNodeView3D's own render, which is the
// cheap place to put them - no copies, same GL context. But they only ever see the 3D
// scene, because the on-screen display is not part of it: the HUD, the compass and the
// annotation layer are separate canvases composited afterwards. An effect that has to
// include the OSD therefore cannot live in that chain at all. It has to run after every
// view has drawn, on the composite, which is what this does.
//
// The cost is two full-frame copies a frame (composite, then upload into the filter's
// own GL context) that the ShaderPass route would not pay. Measure before assuming it is
// affordable at a given resolution; see the notes in private/notes.

import {guiMenus, NodeMan, Sit, setRenderOne} from "../Globals";
import {getCanvasDisplayRect} from "../VideoExporter";
import {
    applyScreenPreset,
    applySignalPreset,
    defaultVideoFilterSettings,
    isVideoFilterActive,
    SCREEN_PRESETS,
    SIGNAL_FORMATS,
} from "./VideoFilterSettings";

const STORAGE_KEY = "sitrec-video-format-layer";
const HOST_VIEW_ID = "lookView";

// The layer's stacking is DERIVED from the views it stands in for, not fixed. It has to
// sit above the host and every OSD view it composites (their divs are siblings under
// #Content with their own z-indices), and no higher - a fixed high value put it above the
// sitch browser and every other full-screen panel, leaving a frozen filtered rectangle
// floating over the interface.
function layerZIndex(host, osdViews) {
    let z = parseInt(getComputedStyle(host.div).zIndex, 10) || 0;
    for (const view of osdViews) {
        if (!view.div) continue;
        z = Math.max(z, parseInt(getComputedStyle(view.div).zIndex, 10) || 0);
    }
    return z + 1;
}

// The chain advances one step per animation frame, so its notion of frame rate is the
// display's, not the sitch's. A 60 Hz display is the assumption; on a 120 Hz one the
// wobble and the auto-exposure hunt run at double speed.
const ASSUMED_DISPLAY_FPS = 60;

let settings = null;
let layer = null;              // {filter, composite, compositeCtx, width, height}
let filterModule = null;       // the lazily imported chunk
let loadingModule = false;
let controllers = [];

function loadSettings() {
    const loaded = defaultVideoFilterSettings();
    loaded.enabled = false;
    try {
        const raw = window.localStorage?.getItem(STORAGE_KEY);
        if (raw) {
            const saved = JSON.parse(raw);
            // Lay the saved format's preset down before merging, so a parameter added
            // after these settings were written falls back to that format's value rather
            // than to the inert digital one.
            if (SIGNAL_FORMATS[saved.signal?.format]) applySignalPreset(loaded, saved.signal.format);
            if (SCREEN_PRESETS[saved.screen?.preset]?.values) applyScreenPreset(loaded, saved.screen.preset);
            for (const section of ["signal", "screen"]) {
                if (saved[section]) Object.assign(loaded[section], saved[section]);
            }
            // Deliberately NOT restored: the effect always starts off. It covers the look
            // view with a degraded picture, and coming back to a session already filtered
            // reads as the renderer being broken rather than as an effect being on. The
            // format and its tuning are kept, so ticking it back on resumes where it was.
        }
    } catch (e) {
        // Unreadable storage is not worth failing the menu over.
    }
    return loaded;
}

function saveSettings() {
    try {
        window.localStorage?.setItem(STORAGE_KEY, JSON.stringify({
            signal: settings.signal,
            screen: settings.screen,
        }));
    } catch (e) {
        // Private browsing or a full quota; the effect still works for this session.
    }
}

export function getVideoFormatLayerSettings() {
    if (!settings) settings = loadSettings();
    return settings;
}

// ─── The layer itself ────────────────────────────────────────────────────────

function hostView() {
    const view = NodeMan.get(HOST_VIEW_ID, false);
    if (!view || !view.canvas || !view._effectivelyVisible) return null;
    if (!(view.widthPx > 0) || !(view.heightPx > 0)) return null;
    // _effectivelyVisible is the view manager's own bookkeeping; this also asks the DOM,
    // which catches a div hidden by an ancestor. A view that is not on screen must not be
    // filtered, and its layer must not be left showing the last frame it managed.
    if (!view.div || view.div.offsetParent === null) return null;
    const box = view.div.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return null;
    return view;
}

// Every canvas that makes up this view on screen, in the order it is stacked. The OSD -
// the HUD, the compass, annotations - are separate views that either overlay the host or
// are positioned relative to it, which is the same pair of tests the single-view export
// uses to decide what belongs to a view.
function osdViewsFor(host) {
    const overlays = [];
    for (const entry of Object.values(NodeMan.list)) {
        const view = entry.data;
        if (view === host || !view.canvas) continue;
        if (view.overlayView !== host && view.in?.relativeTo !== host) continue;
        if (!view._effectivelyVisible) continue;
        if (view.canvas.width === 0 || view.canvas.height === 0) continue;
        // A hidden overlay canvas can hold stale pixels; on screen it is not shown, so
        // it must not be composited either.
        const style = view.canvas.style;
        if (style.display === "none" || style.visibility === "hidden") continue;
        overlays.push(view);
    }
    overlays.sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));
    return overlays;
}

function releaseLayer() {
    if (!layer) return;
    // Take the canvas reference BEFORE disposing: the filter hands it out through a
    // getter backed by the GL context that dispose() tears down. Reading it afterwards
    // used to throw, which left the dead canvas on screen and `layer` still pointing at
    // a disposed filter that every later frame then tried to draw with.
    const {filter, canvas} = layer;
    layer = null;
    try {
        if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
        if (filter) filter.dispose();
    } catch (e) {
        console.error("Video format layer did not release cleanly:", e);
    }
}

function buildLayer(width, height) {
    releaseLayer();
    if (!filterModule) return;

    const filter = new filterModule.AnalogVideoFilter({
        width, height, settings, fps: ASSUMED_DISPLAY_FPS,
    });

    const canvas = filter.canvas;
    canvas.style.cssText = "position: fixed; pointer-events: none; image-rendering: auto;";
    // Into the same container as the view divs, so it shares their stacking context and
    // anything layered over the views is layered over this too.
    (document.getElementById("Content") ?? document.body).appendChild(canvas);

    const composite = document.createElement("canvas");
    composite.width = width;
    composite.height = height;
    // The canvas is held here rather than fetched from the filter later, so releasing
    // never depends on the filter still being alive.
    layer = {filter, canvas, composite, compositeCtx: composite.getContext("2d"), width, height, osdViews: []};
}

// Draw the host view and its OSD into one canvas, laid out exactly as they sit on screen.
function compositeHost(host) {
    const ctx = layer.compositeCtx;
    layer.osdViews = osdViewsFor(host);
    const scaleX = layer.width / host.widthPx;
    const scaleY = layer.height / host.heightPx;

    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, layer.width, layer.height);

    // The 3D canvas is letterboxed inside its div when the view matches a video's aspect,
    // so it goes into that sub-rect rather than filling the frame.
    const rect = getCanvasDisplayRect(host);
    ctx.drawImage(host.canvas, rect.x * scaleX, rect.y * scaleY,
        rect.width * scaleX, rect.height * scaleY);

    for (const view of layer.osdViews) {
        const alpha = view.transparency !== undefined ? view.transparency : 1;
        if (alpha <= 0) continue;
        ctx.globalAlpha = alpha;
        ctx.drawImage(view.canvas,
            (view.leftPx - host.leftPx) * scaleX, (view.topPx - host.topPx) * scaleY,
            view.widthPx * scaleX, view.heightPx * scaleY);
        ctx.globalAlpha = 1;
    }
}

/**
 * Draw one frame of the layer. Called at the very end of the per-frame view loop, once
 * every view - including the OSD - has drawn into its own canvas. A no-op when the
 * effect is off, which is the usual case, so it costs nothing to leave wired in.
 *
 * The source canvases have no preserveDrawingBuffer, so their pixels are only readable
 * inside the animation frame that drew them. That holds here for the same reason it
 * holds for CNodeViewCanvas.applyColorKeyFromUnderlyingView: this runs in that frame.
 */
export function updateVideoFormatLayer() {
    if (!settings || !settings.enabled || !isVideoFilterActive(settings)) {
        if (layer) releaseLayer();
        return;
    }

    const host = hostView();
    if (!host) {
        if (layer) releaseLayer();
        return;
    }

    if (!filterModule) {
        loadFilterModule();
        return;
    }

    // Follow the host's on-screen size, in device pixels so the effect is not softer
    // than the view it covers.
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(2, Math.ceil(host.widthPx * ratio / 2) * 2);
    const height = Math.max(2, Math.ceil(host.heightPx * ratio / 2) * 2);
    if (!layer || layer.width !== width || layer.height !== height) {
        buildLayer(width, height);
        if (!layer) return;
    }

    try {
        compositeHost(host);
        layer.filter.filterFrame(layer.composite);
    } catch (e) {
        console.error("Video format layer failed, switching it off:", e);
        settings.enabled = false;
        releaseLayer();
        // The checkbox has to follow, or it reads as on while nothing is happening.
        refreshControllers();
        return;
    }

    // Position over the host's rect, read from the DOM rather than assumed, so it tracks
    // a dragged or resized view and any letterboxing the div carries.
    const box = host.div.getBoundingClientRect();
    const style = layer.canvas.style;
    style.left = `${box.left}px`;
    style.top = `${box.top}px`;
    style.width = `${box.width}px`;
    style.height = `${box.height}px`;
    style.zIndex = `${layerZIndex(host, layer.osdViews)}`;
}

async function loadFilterModule() {
    if (loadingModule) return;
    loadingModule = true;
    try {
        filterModule = await import("./AnalogVideoFilter");
        setRenderOne();
    } catch (e) {
        console.error("Video format effects could not load:", e);
        if (settings) settings.enabled = false;
    } finally {
        loadingModule = false;
    }
}

// ─── Menu ────────────────────────────────────────────────────────────────────

function changed({rebuild = false} = {}) {
    saveSettings();
    // The settings object is read fresh each frame, but the filter caches nothing that
    // changes here except its own size - so only a format or camera change needs the
    // GPU resources rebuilding. A paused sitch renders nothing on its own, so ask for a
    // frame or the change would not appear until something else moved.
    if (rebuild) releaseLayer();
    setRenderOne();
}

function refreshControllers() {
    for (const controller of controllers) controller.updateDisplay();
}

/**
 * Populate the permanent "Video Format Effects" folder under Effects. Called once at
 * app init, like the other permanent folders - not per sitch.
 */
export function setupVideoFormatEffectsMenu() {
    const folder = guiMenus.videoFormat;
    if (!folder) return;

    settings = loadSettings();
    controllers = [];

    // Every controller here is PERMANENT. addGUIFolder makes the folder permanent, but
    // menuBar.destroy(false) still destroys its non-permanent children on a sitch change -
    // which left the folder present but empty for every sitch loaded after the first.
    const add = (...args) => folder.add(...args).perm();

    add(settings, "enabled")
        .name("Video Format Effects")
        .tooltip("Simulate an analog video format, and optionally a phone filming a screen, live over the look view. Includes the on-screen display.")
        .onChange(() => changed({rebuild: true}));

    const formatNames = {};
    for (const [key, format] of Object.entries(SIGNAL_FORMATS)) formatNames[format.name] = key;
    add(settings.signal, "format", formatNames)
        .name("Format")
        .tooltip("The analog signal path the picture is put through. 'Pure digital' leaves it alone.")
        .onChange((value) => {
            applySignalPreset(settings, value);
            refreshControllers();
            changed({rebuild: true});
        });

    const sig = settings.signal;
    controllers.push(add(sig, "noiseLevel", 0, 1, 0.01).name("Tape noise")
        .tooltip("Tape grain and colour noise. The character comes from the format's own channel bandwidths; this is how much of it.")
        .onChange(() => changed()));
    controllers.push(add(sig, "jitter", 0, 1.5, 0.01).name("Time-base error")
        .tooltip("Line-to-line horizontal instability, worst just below the top of the frame.")
        .onChange(() => changed()));
    controllers.push(add(sig, "headSwitch", 0, 1.5, 0.01).name("Head switching")
        .tooltip("The torn band across the bottom of the frame where the tape heads swap over.")
        .onChange(() => changed()));
    controllers.push(add(sig, "dropouts", 0, 1, 0.01).name("Dropouts")
        .tooltip("Bright horizontal dashes where the tape has lost its oxide.")
        .onChange(() => changed()));
    controllers.push(add(sig, "interlace", 0, 1, 0.01).name("Interlace combing")
        .tooltip("Comb-toothed edges on anything moving, from alternate lines being a field older.")
        .onChange(() => changed()));
    controllers.push(add(sig, "scanlines", 0, 1, 0.01).name("Scan lines")
        .onChange(() => changed()));
    controllers.push(add(sig, "chromaVBlur", 0, 1, 0.01).name("Colour smear")
        .tooltip("Vertical colour softness, from the delay line on PAL and from colour-under on tape.")
        .onChange(() => changed()));

    add(settings.screen, "enabled")
        .name("Recorded off a screen")
        .tooltip("Simulate the result being filmed off a monitor with a phone: handheld wobble, auto exposure, moire and lens distortion.")
        .onChange(() => changed({rebuild: true}));

    const screenPresetNames = {};
    for (const [key, preset] of Object.entries(SCREEN_PRESETS)) {
        if (preset.values) screenPresetNames[preset.name] = key;
    }
    add(settings.screen, "preset", screenPresetNames)
        .name("Camera")
        .onChange((value) => {
            applyScreenPreset(settings, value);
            refreshControllers();
            changed();
        });

    // Everything about the camera and the screen it is pointed at, in one place.
    const scr = settings.screen;
    const tweaks = folder.addFolder("Camera Tweaks").close().perm();
    const tweak = (...args) => tweaks.add(...args).perm();

    // The physical setup. These four decide how much of the frame the screen fills -
    // stand further back and the dark room comes into view around it.
    controllers.push(tweak(scr, "hfov", 10, 140, 1).name("Camera HFOV (deg)")
        .tooltip("Horizontal field of view of the lens filming the screen. A phone's main camera is around 65 degrees.")
        .onChange(() => changed()));
    controllers.push(tweak(scr, "cameraAspect", 0.5, 3, 0.01).name("Aspect ratio")
        .tooltip("Shape of the camera's own frame, width over height. 1.78 is 16:9. Letterboxed into the view when it differs.")
        .onChange(() => changed()));
    controllers.push(tweak(scr, "screenWidthM", 0.1, 5, 0.01).name("Screen width (m)")
        .tooltip("Physical width of the screen being filmed.")
        .onChange(() => changed()));
    controllers.push(tweak(scr, "screenDistanceM", 0.1, 10, 0.01).name("Distance (m)")
        .tooltip("How far the camera is from the screen. Together with the width and the field of view this sets how much of the frame the screen fills.")
        .onChange(() => changed()));

    controllers.push(tweak(scr, "zoom", 0.5, 2, 0.01).name("Extra crop")
        .tooltip("A manual crop on top of the framing the physical setup gives. 1 leaves it alone.")
        .onChange(() => changed()));

    controllers.push(tweak(scr, "handheld", 0, 2, 0.01).name("Wobble")
        .onChange(() => changed()));
    controllers.push(tweak(scr, "handheldSpeed", 0.1, 3, 0.05).name("Wobble speed")
        .onChange(() => changed()));
    controllers.push(tweak(scr, "handheldVariation", 0, 1, 0.01).name("Wobble variation")
        .tooltip("How much the wobble amount itself drifts, so the shot has steady stretches and unsteady ones.")
        .onChange(() => changed()));
    controllers.push(tweak(scr, "handheldDrift", 0, 2, 0.01).name("Slow drift")
        .onChange(() => changed()));
    controllers.push(tweak(scr, "handheldRotation", 0, 2, 0.01).name("Rotation")
        .onChange(() => changed()));

    controllers.push(tweak(scr, "autoExposure").name("Auto exposure")
        .onChange(() => changed()));
    controllers.push(tweak(scr, "exposureBias", -0.5, 1.5, 0.01).name("Exposure bias")
        .onChange(() => changed()));
    controllers.push(tweak(scr, "exposureSpeed", 0, 1, 0.01).name("Adaptation speed")
        .onChange(() => changed()));
    controllers.push(tweak(scr, "knee", 0.1, 1, 0.01).name("Highlight knee")
        .onChange(() => changed()));
    controllers.push(tweak(scr, "clip", 0, 1, 0.01).name("Highlight clipping")
        .onChange(() => changed()));
    controllers.push(tweak(scr, "blackCrush", 0, 0.4, 0.005).name("Black crush")
        .onChange(() => changed()));
    controllers.push(tweak(scr, "blackLift", 0, 0.15, 0.002).name("Black lift")
        .onChange(() => changed()));
    controllers.push(tweak(scr, "bloom", 0, 2, 0.01).name("Bloom")
        .onChange(() => changed()));

    controllers.push(tweak(scr, "keystone", -0.4, 0.4, 0.005).name("Keystone")
        .tooltip("The camera is never quite square-on to the screen.")
        .onChange(() => changed()));
    controllers.push(tweak(scr, "barrel", 0, 0.3, 0.005).name("Barrel distortion")
        .onChange(() => changed()));
    controllers.push(tweak(scr, "aberration", 0, 0.01, 0.0002).name("Chromatic aberration")
        .onChange(() => changed()));
    controllers.push(tweak(scr, "edgeSoftness", 0, 4, 0.05).name("Edge softness")
        .onChange(() => changed()));
    controllers.push(tweak(scr, "gridDepth", 0, 0.6, 0.005).name("Screen grid / moire")
        .tooltip("The screen's own pixel structure. The moire is the real beat between that and the output raster.")
        .onChange(() => changed()));
    controllers.push(tweak(scr, "gridPitch", 0.15, 0.7, 0.005).name("Grid pitch")
        .onChange(() => changed()));
    controllers.push(tweak(scr, "beat", 0, 0.4, 0.005).name("Refresh beat")
        .onChange(() => changed()));
    controllers.push(tweak(scr, "beatBars", 0.5, 5, 0.1).name("Beat bars")
        .onChange(() => changed()));
    controllers.push(tweak(scr, "beatSpeed", 0, 0.5, 0.005).name("Beat speed")
        .onChange(() => changed()));
    controllers.push(tweak(scr, "glare", 0, 0.5, 0.005).name("Glass reflection")
        .tooltip("A reflection on the screen's glass. Confined to the screen, as a reflection in it would be.")
        .onChange(() => changed()));
    controllers.push(tweak(scr, "bezelWidth", 0, 0.15, 0.002).name("Bezel width")
        .tooltip("The monitor's frame around the screen, as a fraction of the screen's width.")
        .onChange(() => changed()));
    controllers.push(tweak(scr, "bezelLevel", 0, 0.5, 0.005).name("Bezel brightness")
        .tooltip("How light the bezel is. 0.1 is a 90% black grey; 0 is a bezel that vanishes into the dark room.")
        .onChange(() => changed()));
    controllers.push(tweak(scr, "vignette", 0, 1, 0.01).name("Vignette")
        .onChange(() => changed()));
    controllers.push(tweak(scr, "noise", 0, 0.15, 0.002).name("Sensor noise")
        .onChange(() => changed()));

    // Enabled from a previous session: pull the chunk in now rather than on the first
    // frame, so the effect appears with the scene instead of a moment after it.
    if (settings.enabled) loadFilterModule();
}

// Drop the GPU resources when a sitch is torn down; the settings survive.
export function disposeVideoFormatLayer() {
    releaseLayer();
}
