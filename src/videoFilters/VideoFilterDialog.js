// The "before you render" dialog: pick a signal format, tune the analog and
// off-a-screen simulations, set the compression, and see all of it running on a real
// frame before committing to an export that may take minutes.
//
// Lazily imported by VideoExporter, so none of this - nor the filter chain it pulls in
// with it - is in the main bundle.

import {blockViewEvents} from "../DragResizeUtils";
import {Globals} from "../Globals";
import {AnalogVideoFilter} from "./AnalogVideoFilter";
import {
    applyScreenPreset,
    applySignalPreset,
    defaultVideoFilterSettings,
    filterOutputSize,
    SCREEN_PRESETS,
    SIGNAL_FORMATS,
} from "./VideoFilterSettings";

const STORAGE_KEY = "sitrec-video-filter-settings";
const PREVIEW_WIDTH = 520;
const PREVIEW_FPS = 20;
// Below this the two columns would each be too narrow to use, so they stack instead.
const TWO_COLUMN_MIN_WIDTH = 940;

// Settings survive across exports and across sessions: nobody wants to dial in a
// third-generation tape look twice.
function loadSavedSettings() {
    const settings = defaultVideoFilterSettings();
    try {
        const raw = window.localStorage?.getItem(STORAGE_KEY);
        if (!raw) return settings;
        const saved = JSON.parse(raw);

        // Lay the SAVED format's preset down before merging, so a parameter added since
        // the settings were written falls back to that format's value and not to the
        // inert digital one. Getting this wrong is quiet rather than loud: a stored VHS
        // setup that predates the tape-noise level would have come back with no noise at
        // all, and nothing on screen would say why.
        if (SIGNAL_FORMATS[saved.signal?.format]) applySignalPreset(settings, saved.signal.format);
        if (SCREEN_PRESETS[saved.screen?.preset]?.values) applyScreenPreset(settings, saved.screen.preset);

        for (const section of ["signal", "screen", "encoding"]) {
            if (saved[section]) Object.assign(settings[section], saved[section]);
        }
        if (!SIGNAL_FORMATS[settings.signal.format]) settings.signal.format = "digital";
        if (!SCREEN_PRESETS[settings.screen.preset]) settings.screen.preset = "handheld";
    } catch (e) {
        // Corrupt or unavailable storage: fall back to defaults rather than fail to open.
    }
    return settings;
}

function saveSettings(settings) {
    try {
        window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (e) {
        // Private browsing, quota, or storage disabled - not worth interrupting an export for.
    }
}

// ─── Small DOM builders, matching the other Sitrec dialogs ───────────────────

const LABEL_STYLE = "font-size: 13px; color: #ddd; flex: 1; min-width: 0;";

function element(tag, style, parent) {
    const el = document.createElement(tag);
    if (style) el.style.cssText = style;
    if (parent) parent.appendChild(el);
    return el;
}

function section(parent, title, open = false) {
    const details = element("details", `
        margin-bottom: 8px; background: #333; border-radius: 5px; padding: 8px 10px;
    `, parent);
    details.open = open;
    const summary = element("summary", `
        cursor: pointer; font-size: 14px; font-weight: bold; color: #fff;
        user-select: none; outline: none;
    `, details);
    summary.textContent = title;
    return element("div", "padding-top: 8px;", details);
}

function row(parent) {
    return element("div", "display: flex; align-items: center; gap: 8px; margin: 5px 0;", parent);
}

function slider(parent, label, object, key, min, max, step, onChange, digits = 2) {
    const container = row(parent);
    const name = element("label", LABEL_STYLE, container);
    name.textContent = label;

    const input = element("input", "width: 130px; flex-shrink: 0;", container);
    input.type = "range";
    input.min = min;
    input.max = max;
    input.step = step;
    input.value = object[key];

    const readout = element("span", "font-size: 12px; color: #9c9; width: 46px; text-align: right; flex-shrink: 0;", container);
    readout.textContent = Number(object[key]).toFixed(digits);

    input.oninput = () => {
        object[key] = parseFloat(input.value);
        readout.textContent = object[key].toFixed(digits);
        onChange();
    };
    return {input, readout, refresh: () => {
        input.value = object[key];
        readout.textContent = Number(object[key]).toFixed(digits);
    }};
}

function checkbox(parent, label, object, key, onChange) {
    const container = row(parent);
    const input = element("input", "width: 16px; height: 16px; flex-shrink: 0;", container);
    input.type = "checkbox";
    input.checked = !!object[key];
    const name = element("label", LABEL_STYLE + " cursor: pointer;", container);
    name.textContent = label;
    name.onclick = () => { input.checked = !input.checked; input.onchange(); };
    input.onchange = () => { object[key] = input.checked; onChange(); };
    return {input, refresh: () => { input.checked = !!object[key]; }};
}

function dropdown(parent, label, options, value, onChange) {
    const container = row(parent);
    const name = element("label", LABEL_STYLE, container);
    name.textContent = label;
    const select = element("select", `
        flex: 1.4; min-width: 0; padding: 4px; background: #222; color: #eee;
        border: 1px solid #555; border-radius: 3px; font-size: 13px;
    `, container);
    for (const [key, text] of Object.entries(options)) {
        const option = element("option", null, select);
        option.value = key;
        option.textContent = text;
    }
    select.value = value;
    select.onchange = () => onChange(select.value);
    return select;
}

function button(parent, text, background) {
    const btn = element("button", `
        flex: 1; padding: 10px 16px; border: none; border-radius: 4px; cursor: pointer;
        font-size: 14px; color: white; background: ${background};
    `, parent);
    btn.textContent = text;
    return btn;
}

// ─── Preview source ──────────────────────────────────────────────────────────

// SMPTE-style colour bars. A far better test of an analog chain than a photograph:
// the saturated vertical edges are exactly what makes chroma bleed, dot crawl and
// cross-colour visible, and the ramp shows what the exposure curve is doing.
function drawColourBars(ctx, width, height) {
    const bars = ["#c0c0c0", "#c0c000", "#00c0c0", "#00c000", "#c000c0", "#c00000", "#0000c0"];
    const barHeight = height * 0.67;
    for (let i = 0; i < bars.length; i++) {
        ctx.fillStyle = bars[i];
        ctx.fillRect(Math.round(i * width / bars.length), 0, Math.ceil(width / bars.length), barHeight);
    }
    // Reverse chroma strip.
    const strip = ["#0000c0", "#131313", "#c000c0", "#131313", "#00c0c0", "#131313", "#c0c0c0"];
    for (let i = 0; i < strip.length; i++) {
        ctx.fillStyle = strip[i];
        ctx.fillRect(Math.round(i * width / strip.length), barHeight, Math.ceil(width / strip.length), height * 0.08);
    }
    // Pluge and a luminance ramp along the bottom.
    const bottom = barHeight + height * 0.08;
    const bottomHeight = height - bottom;
    for (let x = 0; x < width; x++) {
        const v = Math.round(255 * x / width);
        ctx.fillStyle = `rgb(${v},${v},${v})`;
        ctx.fillRect(x, bottom, 1, bottomHeight);
    }
    // Fine vertical grating - the frequency that rainbows on a composite decoder.
    ctx.fillStyle = "#ffffff";
    for (let x = Math.round(width * 0.72); x < width * 0.95; x += 4) {
        ctx.fillRect(x, height * 0.05, 2, barHeight * 0.35);
    }
}

// Snapshot whatever the caller offers as a preview source, once, into our own canvas.
function buildSourceCanvas(getPreviewCanvas, useBars) {
    const canvas = document.createElement("canvas");
    const source = useBars ? null : (getPreviewCanvas ? getPreviewCanvas() : null);
    if (source && source.width > 0 && source.height > 0) {
        canvas.width = source.width;
        canvas.height = source.height;
        canvas.getContext("2d").drawImage(source, 0, 0);
    } else {
        canvas.width = 640;
        canvas.height = 480;
        drawColourBars(canvas.getContext("2d"), canvas.width, canvas.height);
    }
    return canvas;
}

// ─── The dialog ──────────────────────────────────────────────────────────────

/**
 * Show the export settings dialog.
 *
 * @param {object} options
 * @param {string} [options.title]              heading, naming the export about to run
 * @param {function} [options.getPreviewCanvas] returns a canvas holding a representative
 *                                              frame, for the live preview
 * @param {object} [options.formatOptions]      {displayName: formatId} of usable containers
 * @returns {Promise<object|null>} the settings, or null if the export was cancelled
 */
export function showVideoFilterDialog({title = "Render Video", getPreviewCanvas = null, formatOptions = null} = {}) {
    const settings = loadSavedSettings();

    // No user to answer in a validation or regression run: take the saved settings and
    // let the export proceed unattended, the way the other Sitrec dialogs do.
    if (Globals.validationMode) {
        console.log("showVideoFilterDialog (suppressed dialog): using saved settings");
        return Promise.resolve(settings);
    }

    return new Promise((resolve) => {
        const overlay = element("div", `
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0,0,0,0.7); z-index: 10000;
            display: flex; align-items: center; justify-content: center;
        `);
        blockViewEvents(overlay);

        // Side by side, and as tall as the window allows: the settings list is long, and
        // reading it through a short scrolling window means never seeing the section you
        // are not currently in. The preview sits beside it rather than above it so it
        // stays visible while you work down the parameters.
        const twoColumn = window.innerWidth >= TWO_COLUMN_MIN_WIDTH;
        const dialog = element("div", `
            background: #2a2a2a; border-radius: 8px; padding: 18px;
            width: ${twoColumn ? "1080px" : "560px"}; max-width: 96vw;
            height: 94vh;
            display: flex; flex-direction: column;
            box-shadow: 0 4px 20px rgba(0,0,0,0.5);
            font-family: Arial, sans-serif; color: white;
        `, overlay);

        const heading = element("h3", "margin: 0 0 10px 0; font-size: 18px; flex-shrink: 0;", dialog);
        heading.textContent = title;

        const body = element("div", `
            display: flex; flex-direction: ${twoColumn ? "row" : "column"};
            gap: 14px; flex: 1; min-height: 0;
        `, dialog);

        // ── Settings, filling the full height of the dialog ──
        const scroll = element("div", `
            overflow-y: auto; flex: 1 1 auto; min-height: 0; min-width: 0; padding-right: 6px;
        `, body);

        // ── Preview, held at the top of its own column ──
        const previewWrap = element("div", twoColumn
            ? `flex: 0 0 ${PREVIEW_WIDTH}px; max-width: ${PREVIEW_WIDTH}px; align-self: flex-start;`
            : `flex: 0 0 auto; order: -1;`, body);
        const previewCanvas = element("canvas", `
            width: 100%; background: #000; border-radius: 4px; display: block;
            image-rendering: auto;
        `, previewWrap);
        const previewBar = element("div", "display: flex; align-items: center; gap: 10px; margin-top: 5px;", previewWrap);
        const previewNote = element("span", "font-size: 11px; color: #999; flex: 1;", previewBar);
        const barsToggle = element("label", "font-size: 11px; color: #bbb; cursor: pointer; user-select: none; white-space: nowrap;", previewBar);
        const barsInput = element("input", "vertical-align: middle; margin-right: 4px;", barsToggle);
        barsInput.type = "checkbox";
        barsToggle.appendChild(document.createTextNode("Colour bars"));

        const controls = [];
        const refreshAll = () => controls.forEach(c => c.refresh && c.refresh());

        let previewDirty = true;
        const changed = () => { previewDirty = true; };

        // ── Signal format ──
        const signalBody = section(scroll, "Signal format", true);
        const formatNames = Object.fromEntries(
            Object.entries(SIGNAL_FORMATS).map(([key, format]) => [key, format.name])
        );
        const formatDescription = element("div", "font-size: 11px; color: #999; margin: 2px 0 8px 0; min-height: 28px;", signalBody);

        const signalParams = element("div", null, signalBody);

        const updateFormatDescription = () => {
            formatDescription.textContent = SIGNAL_FORMATS[settings.signal.format]?.description ?? "";
            const native = SIGNAL_FORMATS[settings.signal.format]?.native;
            resolutionSelect.parentElement.style.display = native ? "" : "none";
            if (native) {
                resolutionSelect.options[1].textContent =
                    `Format native (${native.width}x${native.height})`;
            }
            signalParams.style.display = settings.signal.format === "digital" ? "none" : "";
        };

        dropdown(signalBody, "Format", formatNames, settings.signal.format, (value) => {
            applySignalPreset(settings, value);
            updateFormatDescription();
            refreshAll();
            changed();
        });

        const resolutionSelect = dropdown(signalBody, "Output resolution", {
            viewport: "As rendered",
            native: "Format native",
        }, settings.signal.resolution, (value) => {
            settings.signal.resolution = value;
            changed();
        });

        // Detailed signal parameters, hidden behind their own fold - the presets are
        // right for almost everyone, and there are a lot of them.
        const detail = section(signalParams, "Signal detail", false);
        const sig = settings.signal;
        controls.push(slider(detail, "Luma bandwidth (MHz)", sig, "lumaMHz", 0.5, 6, 0.05, changed));
        controls.push(slider(detail, "Chroma bandwidth (MHz)", sig, "chromaMHz", 0.1, 2, 0.02, changed));
        controls.push(slider(detail, "Chroma timing error (px)", sig, "chromaDelayPx", -8, 8, 0.1, changed, 1));
        controls.push(slider(detail, "Edge pre-emphasis", sig, "sharpen", 0, 1.5, 0.01, changed));
        controls.push(slider(detail, "Comb filter", sig, "comb", 0, 1, 0.01, changed));
        controls.push(slider(detail, "Y/C separation", sig, "ycSeparation", 0, 1, 0.01, changed));
        controls.push(slider(detail, "Chroma gain", sig, "chromaGain", 0, 2, 0.01, changed));
        controls.push(slider(detail, "Hue error", sig, "hueError", 0, 1, 0.01, changed));
        controls.push(slider(detail, "Time-base error", sig, "jitter", 0, 1.5, 0.01, changed));
        controls.push(slider(detail, "Head switching", sig, "headSwitch", 0, 1.5, 0.01, changed));
        controls.push(slider(detail, "Tape noise", sig, "noiseLevel", 0, 1, 0.01, changed));
        controls.push(slider(detail, "Dropouts", sig, "dropouts", 0, 1, 0.01, changed));
        controls.push(slider(detail, "Interlace combing", sig, "interlace", 0, 1, 0.01, changed));
        controls.push(slider(detail, "Ghosting", sig, "ghosting", 0, 1, 0.01, changed));
        controls.push(slider(detail, "Scan lines", sig, "scanlines", 0, 1, 0.01, changed));
        controls.push(slider(detail, "Vertical chroma smear", sig, "chromaVBlur", 0, 1, 0.01, changed));
        controls.push(slider(detail, "Tape generations", sig, "generations", 1, 4, 1, changed, 0));

        // ── Recorded off a screen ──
        const screenBody = section(scroll, "Recorded off a screen", false);
        const screenNote = element("div", "font-size: 11px; color: #999; margin-bottom: 6px;", screenBody);
        screenNote.textContent = "Simulates filming the video playing on a screen with a phone.";

        // The enable toggle is built before the controls it gates, so it sits above them.
        let screenControls;
        const updateScreenEnabled = () => {
            screenControls.style.opacity = settings.screen.enabled ? "1" : "0.4";
            screenControls.style.pointerEvents = settings.screen.enabled ? "" : "none";
        };
        controls.push(checkbox(screenBody, "Recorded off a screen", settings.screen, "enabled", () => {
            updateScreenEnabled();
            changed();
        }));
        screenControls = element("div", null, screenBody);

        const screenPresetNames = Object.fromEntries(
            Object.entries(SCREEN_PRESETS).filter(([, p]) => p.values).map(([key, p]) => [key, p.name])
        );
        dropdown(screenControls, "Camera", screenPresetNames, settings.screen.preset, (value) => {
            applyScreenPreset(settings, value);
            refreshAll();
            changed();
        });

        const scr = settings.screen;
        const handheldBody = section(screenControls, "Handheld", true);
        controls.push(slider(handheldBody, "Wobble", scr, "handheld", 0, 2, 0.01, changed));
        controls.push(slider(handheldBody, "Wobble speed", scr, "handheldSpeed", 0.1, 3, 0.05, changed));
        controls.push(slider(handheldBody, "Wobble variation", scr, "handheldVariation", 0, 1, 0.01, changed));
        controls.push(slider(handheldBody, "Slow drift", scr, "handheldDrift", 0, 2, 0.01, changed));
        controls.push(slider(handheldBody, "Rotation", scr, "handheldRotation", 0, 2, 0.01, changed));

        const exposureBody = section(screenControls, "Exposure", true);
        controls.push(checkbox(exposureBody, "Auto exposure", scr, "autoExposure", changed));
        controls.push(slider(exposureBody, "Exposure bias", scr, "exposureBias", -0.5, 1.5, 0.01, changed));
        controls.push(slider(exposureBody, "Adaptation speed", scr, "exposureSpeed", 0, 1, 0.01, changed));
        controls.push(slider(exposureBody, "Highlight knee", scr, "knee", 0.1, 1, 0.01, changed));
        controls.push(slider(exposureBody, "Highlight clipping", scr, "clip", 0, 1, 0.01, changed));
        controls.push(slider(exposureBody, "Black crush", scr, "blackCrush", 0, 0.4, 0.005, changed, 3));
        controls.push(slider(exposureBody, "Black lift", scr, "blackLift", 0, 0.15, 0.002, changed, 3));
        controls.push(slider(exposureBody, "Bloom", scr, "bloom", 0, 2, 0.01, changed));

        const lensBody = section(screenControls, "Lens and screen", false);
        controls.push(slider(lensBody, "Zoom / crop", scr, "zoom", 1, 1.5, 0.01, changed));
        controls.push(slider(lensBody, "Keystone", scr, "keystone", -0.4, 0.4, 0.005, changed, 3));
        controls.push(slider(lensBody, "Barrel distortion", scr, "barrel", 0, 0.3, 0.005, changed, 3));
        controls.push(slider(lensBody, "Chromatic aberration", scr, "aberration", 0, 0.01, 0.0002, changed, 4));
        controls.push(slider(lensBody, "Edge softness", scr, "edgeSoftness", 0, 4, 0.05, changed));
        controls.push(slider(lensBody, "Screen grid / moire", scr, "gridDepth", 0, 0.6, 0.005, changed, 3));
        controls.push(slider(lensBody, "Grid pitch", scr, "gridPitch", 0.15, 0.7, 0.005, changed, 3));
        controls.push(slider(lensBody, "Refresh beat", scr, "beat", 0, 0.4, 0.005, changed, 3));
        controls.push(slider(lensBody, "Beat bars", scr, "beatBars", 0.5, 5, 0.1, changed, 1));
        controls.push(slider(lensBody, "Beat speed", scr, "beatSpeed", 0, 0.5, 0.005, changed, 3));
        controls.push(slider(lensBody, "Glass reflection", scr, "glare", 0, 0.5, 0.005, changed, 3));
        controls.push(slider(lensBody, "Vignette", scr, "vignette", 0, 1, 0.01, changed));
        controls.push(slider(lensBody, "Sensor noise", scr, "noise", 0, 0.15, 0.002, changed, 3));

        // ── Compression ──
        const encodingBody = section(scroll, "Compression", true);
        if (formatOptions && Object.keys(formatOptions).length > 0) {
            const inverted = Object.fromEntries(Object.entries(formatOptions).map(([name, id]) => [id, name]));
            // A remembered container the browser cannot encode has to be corrected even
            // when there is no dropdown to correct it with - a Firefox profile carries a
            // stored "mp4-h264" that Chrome wrote, and vice versa.
            if (!inverted[settings.encoding.formatId]) {
                settings.encoding.formatId = Object.values(formatOptions)[0];
            }
            if (Object.keys(inverted).length > 1) {
                dropdown(encodingBody, "Container / codec", inverted, settings.encoding.formatId, (value) => {
                    settings.encoding.formatId = value;
                });
            }
        }
        controls.push(slider(encodingBody, "Bitrate (Mbit/s)", settings.encoding, "bitrateMbps", 0.5, 60, 0.5, () => {}, 1));
        controls.push(slider(encodingBody, "Keyframe interval (frames)", settings.encoding, "keyFrameInterval", 1, 120, 1, () => {}, 0));

        // ── Buttons ──
        const buttonRow = element("div", "display: flex; gap: 8px; margin-top: 12px; flex-shrink: 0;", dialog);
        const renderButton = button(buttonRow, "Render", "#1976d2");
        const cancelButton = button(buttonRow, "Cancel", "#757575");

        // ── Live preview loop ──
        let filter = null;
        let sourceCanvas = buildSourceCanvas(getPreviewCanvas, false);
        let timer = null;

        const rebuildFilter = () => {
            if (filter) { filter.dispose(); filter = null; }
            const out = filterOutputSize(settings, sourceCanvas.width, sourceCanvas.height);
            const scale = PREVIEW_WIDTH / out.width;
            const width = Math.ceil(PREVIEW_WIDTH / 2) * 2;
            const height = Math.ceil(out.height * scale / 2) * 2;
            previewCanvas.width = width;
            previewCanvas.height = height;
            try {
                filter = new AnalogVideoFilter({width, height, settings, fps: PREVIEW_FPS});
                previewNote.textContent =
                    `Preview at ${width}x${height}; export renders at full resolution.`;
            } catch (e) {
                console.error("Video filter preview unavailable:", e);
                previewNote.textContent = "Preview unavailable (WebGL2 required); the export will still run.";
            }
        };

        const previewCtx = previewCanvas.getContext("2d");
        const tick = () => {
            if (previewDirty) {
                previewDirty = false;
                rebuildFilter();
            }
            if (!filter) {
                previewCtx.drawImage(sourceCanvas, 0, 0, previewCanvas.width, previewCanvas.height);
                return;
            }
            try {
                previewCtx.drawImage(filter.filterFrame(sourceCanvas), 0, 0);
            } catch (e) {
                console.error("Video filter preview failed:", e);
                filter.dispose();
                filter = null;
            }
        };

        barsInput.onchange = () => {
            sourceCanvas = buildSourceCanvas(getPreviewCanvas, barsInput.checked);
            changed();
        };

        const cleanup = (result) => {
            if (timer) clearInterval(timer);
            document.removeEventListener("keydown", onKey);
            if (filter) filter.dispose();
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            resolve(result);
        };

        const onKey = (e) => {
            if (e.key === "Escape") { e.preventDefault(); cleanup(null); }
            // Enter renders, but not while a range slider has focus - there the arrow
            // keys and Enter belong to the control the user is adjusting.
            else if (e.key === "Enter" && document.activeElement?.tagName !== "INPUT") {
                e.preventDefault();
                accept();
            }
        };

        const accept = () => {
            saveSettings(settings);
            cleanup(settings);
        };

        renderButton.onclick = accept;
        cancelButton.onclick = () => cleanup(null);
        overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) cleanup(null); });
        document.addEventListener("keydown", onKey);

        updateFormatDescription();
        updateScreenEnabled();
        document.body.appendChild(overlay);
        rebuildFilter();
        previewDirty = false;
        timer = setInterval(tick, 1000 / PREVIEW_FPS);
        renderButton.focus();
    });
}
