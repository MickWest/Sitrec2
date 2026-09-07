// Diffraction PSF Studio — UI glue.
//
// The physics lives in psf.js / aperture.js / cie.js and knows nothing about the DOM; this
// file only builds controls, moves numbers into a spec object, and paints three canvases.
//
// The controls are generated from a SCHEMA rather than written out in HTML. There are about
// forty of them and they all behave the same way — read a path out of the spec, write it
// back, recompute — so writing each one by hand would be forty chances to typo a property
// name into a control that silently does nothing.

import { computePSF, DEFAULT_SPEC, describeSampling } from "./psf.js";
import { rasterStop } from "./aperture.js";
import { PRESETS, presetById, cloneSpec, loadUserPresets, saveUserPreset, deleteUserPreset } from "./presets.js";
import { STRETCH, toImageData, maskToImageData } from "./display.js";
import { GlareRenderer, scenePoints, sceneFromImageData } from "./glare.js";
import { buildPSFFile, validatePSFFile } from "./psfFile.js";

const VERSION = "1.0.0";
// The cache-busting query this module was loaded with (see the import map in index.html),
// passed on to the worker so both sides run the same build.
const MODULE_VERSION = new URL(import.meta.url).search;

// ── State ───────────────────────────────────────────────────────────────────────

let spec = presetById("chandelier").spec;
let presetId = "chandelier";
let result = null;              // the last completed PSF
let userPresets = loadUserPresets();

/** View state — how things are DISPLAYED, kept out of `spec` because none of it is physics
 *  and none of it belongs in an exported PSF. */
const view = {
    // psfParam is in SLIDER space, not curve space: stretchParam() raises 10 to it for the
    // log and asinh curves, and passes it through for gamma. Seeding it with a curve-space
    // 1e4 gives 10^10000 = Infinity, and a uniformly black canvas.
    // Brightness is in DECADES (10^v), not a linear multiplier. It has to be: the spikes sit
    // around 1e-6 of the peak, so seeing them means gains in the thousands, and a linear
    // slider that reached 1e4 would spend 99% of its travel below 100. Defaults chosen by
    // rendering the Chandelier preset four ways and comparing against the reference images —
    // gamma 2.2 at 1e4 is the one that shows all eight spikes with the core blown, which is
    // what the published pattern looks like.
    psfStretch: "gamma", psfGain: 4, psfParam: 2.2, psfZoom: 1,
    glareScene: "points", glareDetail: 256, glareSky: 0.02, glareFlux: 4000,
    glareThreshold: 0.5, glareGain: 1, glarePsfScale: 1, glareStretch: "gamma",
    glareGainDisplay: 0, glareParam: 2.2, highlightBoost: 300,   // exposure also in decades
};

let glare = null;               // GlareRenderer, rebuilt when the detail size changes
let sceneImageData = null;      // an uploaded scene, if any
let worker = null;
let jobId = 0;

const $ = (id) => document.getElementById(id);

// ── Path access into the spec ───────────────────────────────────────────────────

const getPath = (o, p) => p.split(".").reduce((a, k) => (a == null ? a : a[k]), o);
function setPath(o, p, v) {
    const keys = p.split(".");
    const last = keys.pop();
    const t = keys.reduce((a, k) => a[k], o);
    t[last] = v;
}

// ── Control builder ─────────────────────────────────────────────────────────────

/** Every schema row becomes one .row div. `show` gates visibility on the current spec, which
 *  is how "sides" only appears for a polygon and the blackbody temperature only for a
 *  blackbody. */
const rebindable = [];          // [{ el, row, def }] — refreshed by syncControls()

function makeRow(def, target, onChange) {
    const row = document.createElement("div");
    row.className = "row";

    if (def.t === "note") {
        row.className = "note" + (def.warn ? " warn" : "");
        row.innerHTML = def.text;
        return { row, sync: () => {} };
    }

    // A note whose text is derived from the current spec. Exists so a control whose EFFECT is
    // invisible in the panel it sits next to can state that effect where the decision is made,
    // instead of leaving it in a caption under a different canvas.
    if (def.t === "derived") {
        row.className = "note";
        return { row, sync: () => {
            const { text, warn } = def.compute(target());
            row.textContent = text;
            row.className = "note" + (warn ? " warn" : "");
        } };
    }

    const label = document.createElement("label");
    label.textContent = def.label;
    if (def.hint) label.title = def.hint;
    row.appendChild(label);

    let read, write;

    if (def.t === "sel") {
        const sel = document.createElement("select");
        for (const [v, t] of def.opts) {
            const o = document.createElement("option");
            o.value = String(v); o.textContent = t;
            sel.appendChild(o);
        }
        sel.onchange = () => { setPath(target(), def.p, def.int ? Number(sel.value) : sel.value); onChange(def); };
        row.appendChild(sel);
        read = () => { sel.value = String(getPath(target(), def.p)); };

    } else if (def.t === "chk") {
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.onchange = () => { setPath(target(), def.p, cb.checked); onChange(def); };
        row.appendChild(cb);
        read = () => { cb.checked = !!getPath(target(), def.p); };

    } else {
        // A slider paired with an editable number. The slider is for exploring, the number
        // for reproducing a value someone quoted — both are needed and neither is enough.
        const rng = document.createElement("input");
        rng.type = "range";
        rng.min = def.min; rng.max = def.max; rng.step = def.step;
        const num = document.createElement("input");
        num.type = "number";
        num.min = def.min; num.max = def.max; num.step = def.step;

        const push = (v) => {
            v = Math.min(def.max, Math.max(def.min, v));
            setPath(target(), def.p, v);
            rng.value = String(v); num.value = String(v);
            onChange(def);
        };
        rng.oninput = () => push(Number(rng.value));
        num.onchange = () => push(Number(num.value));
        row.appendChild(rng); row.appendChild(num);
        read = () => { const v = getPath(target(), def.p); rng.value = String(v); num.value = String(v); };
    }

    return { row, sync: read };
}

function buildSection(title, rows, target, onChange, collapsed = false) {
    const sec = document.createElement("section");
    sec.className = "panel" + (collapsed ? " collapsed" : "");
    const h = document.createElement("h2");
    h.textContent = title;
    h.onclick = () => sec.classList.toggle("collapsed");
    sec.appendChild(h);
    for (const def of rows) {
        const { row, sync } = makeRow(def, target, onChange);
        sec.appendChild(row);
        rebindable.push({ row, def, sync });
    }
    return sec;
}

/** Refresh only the rows whose text is DERIVED from the spec. Separate from syncControls()
 *  because this runs on every slider movement, and re-reading forty inputs mid-drag to update
 *  one line of text is both wasteful and a good way to fight the control being dragged. */
function refreshDerived() {
    for (const { def, sync } of rebindable) if (def.t === "derived") sync();
}

/** Re-read every control from the spec and re-apply the `show` gates. Called after a preset
 *  load, and after any change that could open or close a dependent control. */
function syncControls() {
    for (const { row, def, sync } of rebindable) {
        sync();
        if (def.show) row.classList.toggle("disabled", !def.show(spec, view));
        if (def.hide) row.style.display = def.hide(spec, view) ? "none" : "";
    }
}

// ── Schema ──────────────────────────────────────────────────────────────────────

const SHAPES = [["truncatedCircle", "Circle with flats"], ["circle", "Circle"],
                ["square", "Square"], ["polygon", "Polygon"]];
const APODS = [["none", "None (straight)"], ["sawtooth", "Serrated"], ["sine", "Wavy"]];

/** One stop's controls. `i` selects which stop, so the two are literally the same schema. */
function stopRows(i) {
    const s = `stops.${i}`;
    const isPoly = (sp) => sp.stops[i].shape === "polygon";
    const isTrunc = (sp) => sp.stops[i].shape === "truncatedCircle";
    const hasVanes = (sp) => sp.stops[i].vanes.count > 0;
    const apod = (sp) => hasVanes(sp) && sp.stops[i].vanes.apodize !== "none";
    return [
        { t: "chk", p: `${s}.enabled`, label: "Enabled" },
        { t: "range", p: `${s}.weight`, label: "Weight", min: 0, max: 2, step: 0.05,
          hint: "How much this stop contributes when the two PSFs are summed." },
        { t: "sel", p: `${s}.shape`, label: "Shape", opts: SHAPES },
        { t: "range", p: `${s}.sides`, label: "Sides", min: 3, max: 16, step: 1, show: isPoly,
          hint: "Blades of the iris. Even N gives N spikes, odd N gives 2N." },
        { t: "range", p: `${s}.rotationDeg`, label: "Rotation °", min: -90, max: 90, step: 0.5 },
        { t: "range", p: `${s}.flatTop`, label: "Flat top/bot", min: 0.3, max: 1, step: 0.005, show: isTrunc,
          hint: "Where the top and bottom chords cut the circle, in radii. 1 = no cut." },
        { t: "range", p: `${s}.flatSide`, label: "Flat sides", min: 0.3, max: 1, step: 0.005, show: isTrunc },
        { t: "range", p: `${s}.obstruction`, label: "Obstruction", min: 0, max: 0.6, step: 0.005,
          hint: "Central obstruction (the secondary mirror), as a fraction of pupil DIAMETER." },

        { t: "note", text: "<b>Spider vanes.</b> Each vane throws a spike pair perpendicular to itself, so N vanes give 2N spikes — unless they pair into collinear lines, which is why 4 vanes give 4 spikes and 3 give 6." },
        { t: "range", p: `${s}.vanes.count`, label: "Vane count", min: 0, max: 12, step: 1 },
        { t: "range", p: `${s}.vanes.rotationDeg`, label: "Vane angle °", min: 0, max: 180, step: 0.5, show: hasVanes },
        { t: "range", p: `${s}.vanes.width`, label: "Vane width", min: 0.002, max: 0.15, step: 0.001, show: hasVanes,
          hint: "As a fraction of pupil diameter. A wider vane makes a BRIGHTER, not a longer, spike." },
        { t: "range", p: `${s}.vanes.taper`, label: "Taper", min: 0.2, max: 3, step: 0.02, show: hasVanes,
          hint: "Outer width / inner width. 1 = parallel-sided." },
        { t: "sel", p: `${s}.vanes.apodize`, label: "Edge profile", opts: APODS, show: hasVanes },
        { t: "range", p: `${s}.vanes.apodAmplitude`, label: "Wave depth", min: 0, max: 1.5, step: 0.01, show: apod,
          hint: "Wave depth as a fraction of the vane half-width. Measured: past about 0.4 the edge slope fans the spike so wide it drops BELOW the surrounding background and disappears." },
        { t: "range", p: `${s}.vanes.apodPeriod`, label: "Wave period", min: 0.01, max: 0.5, step: 0.005, show: apod,
          hint: "One wave per this many pupil radii. Sets how far the feather spreads." },
        { t: "range", p: `${s}.vanes.apodPhase`, label: "Wave phase", min: 0, max: 1, step: 0.02, show: apod },
        { t: "sel", p: `${s}.vanes.edgeMode`, label: "Edge mode", show: apod,
          opts: [["width", "Serrated (both edges)"], ["meander", "Meandering centreline"]] },
        { t: "chk", p: `${s}.vanes.oppositePhase`, label: "Opposed", show: apod,
          hint: "Give the two edges opposite phase, so the vane pinches into diamonds." },
    ];
}

const SCHEMA = [
    ["Grid & optics", [
        { t: "sel", p: "n", label: "Grid size", int: true,
          opts: [[128, "128 (draft)"], [256, "256"], [512, "512"], [1024, "1024 (slow)"]] },
        { t: "range", p: "fill", label: "Pupil fill", min: 0.12, max: 0.9, step: 0.01,
          hint: "How much of the transform grid the pupil fills; the rest is zero padding. This is NOT a zoom of the drawing — it sets how finely the PSF is sampled and how much of it fits on the grid." },
        { t: "derived", compute: (spec) => {
            const s = describeSampling(spec);
            const core = s.airyRadiusPx;
            const text = `Airy core ${core.toFixed(1)} px across ${(2 * core).toFixed(1)} px, `
                       + `field ±${s.fieldHalfWidthArcsec.toFixed(1)}″ `
                       + `(${Math.round(s.airyRadiiAcrossField)} Airy radii).`
                       + (s.undersampledCore
                            ? " The core is under a pixel and a half: what you are seeing is spikes"
                              + " with no real core. Lower the fill."
                            : " Lower fill resolves the core; higher fill reaches further out.");
            return { text, warn: s.undersampledCore };
          } },
        { t: "range", p: "supersample", label: "Edge samples", min: 1, max: 5, step: 1,
          hint: "Sub-samples per pixel when rasterising the mask. Hard pixel edges ring in the transform." },
        { t: "range", p: "optics.apertureM", label: "Aperture (m)", min: 0.01, max: 2, step: 0.005 },
        { t: "range", p: "optics.focalM", label: "Focal (m)", min: 0.05, max: 20, step: 0.05 },
        { t: "range", p: "defocusUm", label: "Defocus (µm)", min: -400, max: 400, step: 5,
          hint: "Longitudinal focus shift. Non-zero forces one FFT per wavelength instead of one in total, so it is much slower." },
    ], false],

    ["Stop 1 — main aperture", stopRows(0), false],
    ["Stop 2 — iris", stopRows(1), true],

    ["Combine", [
        { t: "sel", p: "combine", label: "Two stops",
          opts: [["sumPSF", "Sum the two PSFs"], ["intersect", "Intersect into one pupil"]] },
        { t: "note", text: "Two stops in DIFFERENT planes (a housing window and an iris near the sensor) do not share a pupil, so their patterns add as intensities — <i>Sum</i>. Two stops in the SAME plane really are one pupil and their transmissions multiply — <i>Intersect</i>. Sum is what the Chandelier analysis used, and is the honest choice when the stops are separated." },
    ], true],

    ["Spectrum", [
        { t: "range", p: "spectrum.nm0", label: "From (nm)", min: 300, max: 1000, step: 5 },
        { t: "range", p: "spectrum.nm1", label: "To (nm)", min: 320, max: 1400, step: 5,
          hint: "The LONGEST wavelength sets the output pixel scale — it makes the widest pattern." },
        { t: "range", p: "spectrum.steps", label: "Samples", min: 1, max: 64, step: 1 },
        { t: "sel", p: "spectrum.kind", label: "Source",
          opts: [["flat", "Flat (Maskulator)"], ["blackbody", "Blackbody"]] },
        { t: "range", p: "spectrum.kelvin", label: "Temp (K)", min: 800, max: 12000, step: 50,
          show: (s) => s.spectrum.kind === "blackbody" },
        { t: "note", text: "Wavelength sets only the SCALE of the pattern, so a spike is a spectrum smeared along its own length. One sample gives a monochrome pattern; 32 is enough that the rainbow is smooth." },
    ], true],
];

// ── Display and glare controls (view state, not spec) ───────────────────────────

const psfDisplaySchema = [
    { t: "sel", p: "psfStretch", label: "Stretch",
      opts: Object.entries(STRETCH).map(([k, v]) => [k, v.label]) },
    { t: "range", p: "psfGain", label: "Brightness", min: 0, max: 8, step: 0.05,
      hint: "In DECADES: 4 means a gain of 10,000. The spikes are around a millionth of the peak, so this needs to be large before they appear." },
    { t: "range", p: "psfParam", label: "Curve", min: 1, max: 6, step: 0.05,
      hint: "Gamma: the exponent itself. Log and Asinh: the number of DECADES shown, as a power of ten." },
    { t: "sel", p: "psfZoom", label: "Zoom", int: true,
      opts: [[1, "Whole field"], [2, "2×"], [4, "4×"], [8, "8×"]] },
];

const glareSchema = [
    { t: "sel", p: "glareScene", label: "Scene",
      opts: [["points", "Point sources"], ["image", "Loaded image…"]] },
    { t: "range", p: "glareSky", label: "Background", min: 0, max: 0.3, step: 0.002,
      hide: (s, v) => v.glareScene !== "points" },
    { t: "range", p: "glareFlux", label: "Source flux", min: 10, max: 40000, step: 10,
      hide: (s, v) => v.glareScene !== "points" },
    { t: "range", p: "highlightBoost", label: "Clipped gain", min: 1, max: 3000, step: 10,
      hide: (s, v) => v.glareScene !== "image",
      hint: "An 8-bit photo has already clipped its bright sources to white. This is the assumed headroom above that — a guess, and labelled as one." },
    { t: "range", p: "glarePsfScale", label: "PSF size", min: 0.1, max: 4, step: 0.05,
      hint: "Angular size of the pattern relative to its native scale. Larger aperture or wider field of view = smaller pattern." },
    { t: "range", p: "glareThreshold", label: "Threshold", min: 0, max: 5, step: 0.01,
      hint: "Luminance above which a pixel glares." },
    { t: "range", p: "glareGain", label: "Glare gain", min: 0, max: 8, step: 0.05 },
    { t: "sel", p: "glareStretch", label: "Stretch",
      opts: Object.entries(STRETCH).map(([k, v]) => [k, v.label]) },
    { t: "range", p: "glareGainDisplay", label: "Exposure", min: -3, max: 5, step: 0.05,
      hint: "In decades: 0 is unity." },
    { t: "range", p: "glareParam", label: "Curve", min: 1, max: 6, step: 0.05,
      hint: "Gamma: the exponent itself. Log and Asinh: the number of DECADES shown, as a power of ten." },
    { t: "sel", p: "glareDetail", label: "Detail", int: true,
      opts: [[128, "128 (fast)"], [256, "256"], [512, "512 (slow)"]] },
];

// ── Worker ──────────────────────────────────────────────────────────────────────

function setStatus(text, cls = "") {
    const el = $("status");
    el.textContent = text;
    el.className = "status " + cls;
}

function setProgress(p) { $("progressBar").style.width = `${Math.round(p * 100)}%`; }

let computeTimer = null;
function scheduleCompute(delay = 220) {
    drawPupil();                             // cheap, so it tracks the sliders live
    updateSamplingCaption();
    refreshDerived();
    clearTimeout(computeTimer);
    computeTimer = setTimeout(compute, delay);
}

function compute() {
    // Terminate rather than flag-and-poll: the inner loop is a tight numeric kernel where an
    // abort check per iteration costs more than simply starting a new worker.
    if (worker) worker.terminate();
    worker = new Worker("psfWorker.js" + MODULE_VERSION, { type: "module" });
    const id = ++jobId;

    const heavy = spec.defocusUm !== 0;
    setStatus(heavy ? `computing ${spec.spectrum.steps} transforms…` : "computing…", "busy");
    setProgress(0);

    worker.onmessage = (e) => {
        const m = e.data;
        if (m.id !== jobId) return;
        if (m.type === "progress") { setProgress(m.p); return; }
        if (m.type === "error") { setStatus(m.message, "error"); setProgress(0); return; }
        result = { n: m.n, rgb: m.rgb, masks: m.masks, peak: m.peak, sampling: m.sampling, ms: m.ms };
        setProgress(1);
        setStatus(`${m.n}² in ${Math.round(m.ms)} ms`);
        drawPSF();
        rebuildGlare();
        setTimeout(() => setProgress(0), 400);
    };
    worker.postMessage({ spec, id });
}

// ── Drawing ─────────────────────────────────────────────────────────────────────

function paint(canvas, imageData) {
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    canvas.getContext("2d").putImageData(imageData, 0, 0);
}

/** The pupil, rasterised on the main thread at a capped size so it can track a slider. */
function drawPupil() {
    const n = Math.min(320, spec.n);
    const active = spec.stops.filter((s) => s.enabled !== false);
    if (active.length === 0) { paint($("pupilCanvas"), new ImageData(n, n)); return; }

    let mask = rasterStop(active[0], n, spec.fill, 2);
    if (spec.combine === "intersect") {
        for (let i = 1; i < active.length; i++) {
            const m = rasterStop(active[i], n, spec.fill, 2);
            for (let k = 0; k < mask.length; k++) mask[k] *= m[k];
        }
    } else if (active.length > 1) {
        // Summed stops are separate pupils, so show them overlaid at half weight each —
        // this is a diagram of two masks, not a single physical aperture, and it should not
        // pretend otherwise.
        const combined = new Float32Array(mask.length);
        for (let i = 0; i < active.length; i++) {
            const m = rasterStop(active[i], n, spec.fill, 2);
            for (let k = 0; k < mask.length; k++) combined[k] += m[k] / active.length;
        }
        mask = combined;
    }
    paint($("pupilCanvas"), maskToImageData(mask, n));

    const names = active.map((s) => s.shape).join(spec.combine === "intersect" ? " ∩ " : " + ");
    $("pupilCaption").textContent = active.length > 1 && spec.combine === "sumPSF"
        ? `${names}\ntwo separate stops, shown overlaid`
        : names;
}

function drawPSF() {
    if (!result) return;
    const n = result.n, z = view.psfZoom;
    const src = { rgb: result.rgb, n };

    let rgb = src.rgb, w = n;
    if (z > 1) {
        // Centre crop. Cropping rather than scaling keeps the display at 1:1 with the
        // computed pixels, so a one-pixel spike stays a one-pixel spike.
        w = Math.max(16, Math.round(n / z));
        const o = Math.floor((n - w) / 2);
        rgb = new Float32Array(w * w * 3);
        for (let y = 0; y < w; y++)
            for (let x = 0; x < w; x++)
                for (let c = 0; c < 3; c++)
                    rgb[(y * w + x) * 3 + c] = src.rgb[((y + o) * n + (x + o)) * 3 + c];
    }

    paint($("psfCanvas"), toImageData(rgb, w, w, {
        stretch: view.psfStretch, gain: stretchGain(view.psfGain),
        param: stretchParam(view.psfStretch, view.psfParam),
        normalise: result.peak,
    }));
    updateSamplingCaption();
}

/** The stretch curves want very different parameter ranges (a gamma of 2.2, a log of 1e4),
 *  but one slider serves all three. Map a 1..6 slider onto whatever the curve wants. */
function stretchParam(kind, v) {
    if (kind === "gamma") return v;          // the exponent itself
    return Math.pow(10, v);                  // log and asinh: v is a count of decades
}

/** Brightness sliders are in decades throughout, for the reason given at `view`. */
const stretchGain = (v) => Math.pow(10, v);

function updateSamplingCaption() {
    const s = result ? result.sampling : describeSampling(spec);
    const fmt = (x, d = 2) => Number(x).toFixed(d);
    const lines = [
        `${spec.n}² grid, pupil ${Math.round(s.pupilPx)} px, f/${fmt(s.fNumber, 1)}`,
        `${fmt(s.anglePerPixelArcsec, 3)}″ per pixel — field ±${fmt(s.fieldHalfWidthArcsec, 1)}″`,
        `Airy radius ${fmt(s.airyRadiusPx)} px — ${fmt(s.airyRadiiAcrossField, 0)} across the field`,
        `sensor pitch ${fmt(s.imagePixelPitchUm)} µm, critical focus ±${fmt(s.criticalFocusUm, 0)} µm`,
    ];
    const el = $("psfCaption");
    el.textContent = lines.join("\n");
    if (s.undersampledCore) {
        const w = document.createElement("span");
        w.className = "warn";
        w.textContent = "\nCore is under-sampled at this fill — the Airy disc is under 1.5 px, "
                      + "so what you see is spikes without a real core. Lower the pupil fill.";
        el.appendChild(w);
    }
}

// ── Glare ───────────────────────────────────────────────────────────────────────

function buildScene(n) {
    if (view.glareScene === "image" && sceneImageData) {
        return sceneFromImageData(sceneImageData, n, view.highlightBoost);
    }
    return scenePoints(n, {
        sky: view.glareSky,
        sources: [
            { x: 0.5, y: 0.5, flux: view.glareFlux, rgb: [1, 1, 1] },
            { x: 0.22, y: 0.28, flux: view.glareFlux * 0.065, rgb: [1, 0.85, 0.6] },
            { x: 0.78, y: 0.72, flux: view.glareFlux * 0.022, rgb: [0.7, 0.85, 1] },
        ],
    });
}

/** Full rebuild: new PSF spectrum, new scene, new convolution. */
function rebuildGlare() {
    if (!result) return;
    const n = view.glareDetail;
    if (!glare || glare.n !== n) glare = new GlareRenderer(n);
    // Fit the whole PSF into the working grid by default, then apply the user's size factor.
    glare.setPSF(result.rgb, result.n, (n / result.n) * view.glarePsfScale);
    glare.setScene(buildScene(n));
    recomposeGlare(true);
}

function recomposeGlare(reconvolve = false) {
    if (!glare || !glare.scene || !glare.psfSpectrum) return;
    if (reconvolve || !glare.halo) glare.convolve(view.glareThreshold);
    const n = glare.n;
    const composed = glare.compose(view.glareGain);
    paint($("glareCanvas"), toImageData(composed, n, n, {
        stretch: view.glareStretch, gain: stretchGain(view.glareGainDisplay),
        param: stretchParam(view.glareStretch, view.glareParam),
        normalise: 1,
    }));
    const scale = (n / result.n) * view.glarePsfScale;
    $("glareCaption").textContent =
        `exact FFT convolution at ${n}², PSF drawn at ${scale.toFixed(3)} px per PSF pixel\n`
      + `scene + ${view.glareGain.toFixed(2)} × (bright pass ⊛ PSF)`;
}

// ── Presets ─────────────────────────────────────────────────────────────────────

function refreshPresetList() {
    const sel = $("presetSelect");
    sel.innerHTML = "";
    const add = (group, list) => {
        if (!list.length) return;
        const g = document.createElement("optgroup");
        g.label = group;
        for (const p of list) {
            const o = document.createElement("option");
            o.value = p.id; o.textContent = p.name;
            g.appendChild(o);
        }
        sel.appendChild(g);
    };
    add("Built in", PRESETS);
    add("Saved", userPresets);
    sel.value = presetId;
}

function allPresets() { return [...PRESETS, ...userPresets]; }

function loadPreset(id) {
    const p = allPresets().find((x) => x.id === id);
    if (!p) return;
    presetId = id;
    spec = cloneSpec(p.spec);
    $("presetNote").textContent = p.note || "";
    $("exportName").value = p.name;
    $("exportNote").value = (p.note || "").split(".")[0];
    syncControls();
    scheduleCompute(0);
}

// ── Export ──────────────────────────────────────────────────────────────────────

function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const slug = (s) => (s || "psf").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

async function exportPSFFile() {
    if (!result) return;
    setStatus("encoding…", "busy");
    try {
        const file = await buildPSFFile(result, spec, {
            name: $("exportName").value.trim() || "Diffraction PSF",
            note: $("exportNote").value.trim(),
            floorFraction: Number($("exportFloor").value),
        });
        const json = JSON.stringify(file);
        download(new Blob([json], { type: "application/json" }), `${slug(file.name)}.psf.json`);
        setStatus(`exported ${(json.length / 1024).toFixed(0)} kB`);
    } catch (err) {
        setStatus(String(err.message || err), "error");
    }
}

function exportCanvas(canvasId, suffix) {
    $(canvasId).toBlob((b) => download(b, `${slug($("exportName").value)}-${suffix}.png`), "image/png");
}

async function openSpecFile(file) {
    try {
        const o = JSON.parse(await file.text());
        const err = validatePSFFile(o);
        // A .psf.json is the normal case, but a bare spec is accepted too — someone who
        // copied the spec out of the clipboard button should be able to paste it back.
        const incoming = err ? o : o.spec;
        if (!incoming || !incoming.stops) throw new Error(err || "no spec in this file");
        spec = { ...cloneSpec(DEFAULT_SPEC), ...cloneSpec(incoming) };
        presetId = "";
        $("presetNote").textContent = o.note || "Loaded from file.";
        if (o.name) $("exportName").value = o.name;
        syncControls();
        scheduleCompute(0);
        setStatus("loaded " + file.name);
    } catch (e) {
        setStatus("could not read: " + (e.message || e), "error");
    }
}

// ── Wiring ──────────────────────────────────────────────────────────────────────

function init() {
    const mount = $("schemaMount");
    for (const [title, rows, collapsed] of SCHEMA) {
        mount.appendChild(buildSection(title, rows, () => spec, () => scheduleCompute(), collapsed));
    }

    // View controls live under their own canvas rather than in the sidebar: they change how
    // one panel looks and nothing else, and putting them next to it makes that obvious.
    const psfMount = $("psfDisplayMount");
    for (const def of psfDisplaySchema) {
        const { row, sync } = makeRow(def, () => view, () => drawPSF());
        psfMount.appendChild(row);
        rebindable.push({ row, def, sync });
    }

    const glareMount = $("glareMount");
    for (const def of glareSchema) {
        const { row, sync } = makeRow(def, () => view, (d) => {
            if (d.p === "glareScene" && view.glareScene === "image" && !sceneImageData) {
                $("sceneFile").click();
            }
            // Which controls need what: the exposure and curve only recompose, everything
            // else changes the convolution input and has to redo it.
            const cheap = ["glareGain", "glareStretch", "glareGainDisplay", "glareParam"];
            if (cheap.includes(d.p)) recomposeGlare(false);
            else rebuildGlare();
            syncControls();
        });
        glareMount.appendChild(row);
        rebindable.push({ row, def, sync });
    }

    $("presetSelect").onchange = (e) => loadPreset(e.target.value);
    $("savePreset").onclick = () => {
        const name = $("presetName").value.trim();
        if (!name) { setStatus("name it first", "error"); return; }
        userPresets = saveUserPreset(name, spec);
        presetId = "user:" + name;
        refreshPresetList();
        $("presetName").value = "";
        setStatus(`saved "${name}"`);
    };
    $("deletePreset").onclick = () => {
        if (!presetId.startsWith("user:")) { setStatus("built-ins cannot be deleted", "error"); return; }
        userPresets = deleteUserPreset(presetId);
        loadPreset(PRESETS[0].id);
        refreshPresetList();
    };
    $("resetPreset").onclick = () => loadPreset(presetId || PRESETS[0].id);
    $("copySpec").onclick = () => {
        navigator.clipboard.writeText(JSON.stringify(spec, null, 2))
            .then(() => setStatus("spec copied"), () => setStatus("clipboard blocked", "error"));
    };
    $("loadSpec").onclick = () => $("specFile").click();
    $("specFile").onchange = (e) => { if (e.target.files[0]) openSpecFile(e.target.files[0]); };

    $("sceneFile").onchange = async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        const bmp = await createImageBitmap(f);
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const cx = c.getContext("2d");
        cx.drawImage(bmp, 0, 0);
        sceneImageData = cx.getImageData(0, 0, bmp.width, bmp.height);
        view.glareScene = "image";
        syncControls();
        rebuildGlare();
    };

    $("exportPSF").onclick = exportPSFFile;
    $("exportPNG").onclick = () => exportCanvas("psfCanvas", "psf");
    $("exportGlare").onclick = () => exportCanvas("glareCanvas", "glare");

    refreshPresetList();
    loadPreset("chandelier");
}

init();

// ── MCP / debug bridge ──────────────────────────────────────────────────────────
// sitrec_eval runs in the page-bridge's scope and can only see window.*, but everything in
// this file is module scope. Same two hooks as tools/shf, and gated to local hosts for the
// same reason: no eval gadget ships to production.
const isLocalHost = /^(local\.metabunk\.org|localhost|127\.0\.0\.1)$/.test(window.location.hostname);
if (isLocalHost) {
    window.psfEval = (code) => eval(code);
    window.psfTool = {
        VERSION,
        get spec() { return spec; },
        get result() { return result; },
        get view() { return view; },
        get glare() { return glare; },
        get presetId() { return presetId; },
        loadPreset,
        setSpec(patch) { Object.assign(spec, patch); syncControls(); scheduleCompute(0); },
        set(path, value) { setPath(spec, path, value); syncControls(); scheduleCompute(0); },
        setView(patch) { Object.assign(view, patch); syncControls(); drawPSF(); rebuildGlare(); },
        // Peak-normalised luminance at an offset from the PSF centre — the measurement a
        // spike check actually needs, without pulling a 3 MB array through the bridge.
        psfAt(dx, dy) {
            if (!result) return null;
            const n = result.n, i = ((n / 2 + dy) * n + (n / 2 + dx)) * 3;
            return (result.rgb[i] + result.rgb[i + 1] + result.rgb[i + 2]) / 3 / result.peak;
        },
        radialProfile(angleDeg, rMax = 200) {
            const out = [];
            const a = (angleDeg * Math.PI) / 180;
            for (let r = 0; r <= rMax; r++) {
                out.push(this.psfAt(Math.round(r * Math.cos(a)), Math.round(r * Math.sin(a))));
            }
            return out;
        },
    };
}
