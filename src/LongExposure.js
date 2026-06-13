// LongExposure.js
//
// Simulated long exposure of the Look view, plus the "Nudge Camera" damped
// camera jolt (Video menu > Long Exposure).
//
// Two parts:
//
// 1) Simple long exposure: every frame of the A-B range is rendered offline
//    (mirroring the Scripted Video offline recipe), decoded to LINEAR light
//    (inverse sRGB, plus inverse ACES when the look view tone-maps), summed
//    into a Float32 accumulator and averaged. The result is the time-average
//    of the scene — what a camera would record with the shutter open for the
//    whole range, displayed at single-frame-equivalent exposure (an EV slider
//    in the result window re-tone-maps from the kept float buffer).
//
// 2) HDR point sources: the cosmetic star/planet sprites and aircraft-light
//    billboards are display approximations — a mag -4 Venus renders as a soft
//    white-green disk that would average away to nothing. During the exposure
//    those sprites are hidden and each source is instead splatted into the
//    float buffer with its true linear flux F = 10^(-0.4(mag - satMag))
//    (satMag = the magnitude that just saturates a single frame), through an
//    energy-conserving erf-integrated Gaussian PSF, with Kasten-Young
//    atmospheric extinction. Sources are projected continuously along each
//    inter-frame interval (slerped base camera pose + the analytic nudge
//    offset), adaptively subdivided to sub-pixel steps — so a camera nudge
//    draws smooth decaying zigzag light trails, and strobing aircraft lights
//    draw duty-cycle-correct dashes. The Moon (an extended source) stays in
//    the LDR render but its disk pixels are scaled so the disk's total energy
//    matches its catalog magnitude under the same calibration.
//
// 3) HDR background: a night scene's lit content may quantize into a handful
//    of 8-bit codes (EV-pushing the result shows color bands). The scene
//    lighting (Sun + Ambient) is temporarily boosted so the first frame's
//    brightest lit content just fills the 8-bit range, every decoded frame is
//    divided by the same factor, and the lights are restored afterwards —
//    true brightness, far finer quantization (lighting is linear, so the
//    division is exact for everything the lights illuminate).
//
// Physically-accurate notes / v1 approximations:
//  - splat energy is deposited per frame and averaged like the background, so
//    a static star keeps exactly flux F while a moving one spreads F along its
//    path (trail brightness = dwell-time fraction — correct photometry).
//  - terrain/object occlusion of splats is ignored (a star trail can cross a
//    foreground hill; an aircraft body doesn't occlude its own far light).
//  - non-catalogued bright content that saturates the LDR frame stays clipped
//    at 1.0 (only catalog sources + the Moon get HDR treatment).
//  - satellites are not yet splatted (they keep their LDR rendering).

import {GlobalDateTimeNode, Globals, guiMenus, markSitchDirty, NodeMan, setRenderOne, Sit} from "./Globals";
import {par} from "./par";
import {ExportProgressWidget, getExportPrefix} from "./utils";
import {waitForExportFrameSettled} from "./ExportFrameSettler";
import {Quaternion, Vector3} from "three";
import {nudgeParams, defaultNudgeParams, nudgeQuaternion} from "./nodes/CNodeControllerCameraNudge";
import {applyRefractionECI, refractionOptsFromUniforms, refractionUniforms} from "./atmosphere/refraction";
import {raDec2Celestial} from "./CelestialMath";
import {CNode3DLight} from "./nodes/CNode3DLight";
import {CNodeViewUI} from "./nodes/CNodeViewUI";
import {degrees, radians} from "./mathUtils";
import {flareRamp} from "../tools/shf/flarePhysics.js";
import {altitudeHAE, getLocalUpVector} from "./SphericalMath";
import {GlobalScene} from "./LocalFrame";
import {MeshBasicMaterial, WebGLRenderTarget, Color} from "three";

// ---------------------------------------------------------------------------
// Parameters

const defaultParams = () => ({
    durationMin: 5,      // exposure length in minutes, from the start of the sitch
    lockHeading: true,   // hold the camera heading AS IT IS NOW for the whole
                         // exposure (a tripod doesn't track): even in To Target /
                         // Celestial Lock / Horizon Flare Region modes the camera
                         // acts like "Use Angles" pointed at the current spot
    hdrPoints: true,     // splat stars/planets/lights with true flux
    hdrBackground: true, // boost the scene lighting (Sun + Ambient) so a dark
                         // background renders using the full 8-bit range, then
                         // scale it back down in the float buffer — pushing the
                         // EV up reveals smooth detail instead of quantized
                         // bands (calibrated on the first frame, restored after)
    moonlight: false,    // light the scene with ONLY the Moon: no ambient, the
                         // sun light re-aimed at the Moon with its true
                         // phase-dependent brightness (~20 stops below daylight
                         // at full moon). Uses the HDR Background machinery to
                         // make that renderable; the result window auto-develops
    satMag: 4.0,         // magnitude that just saturates one frame's exposure
                         // (Venus at -4.4 is then ~2300x saturation — a real
                         // "2000+ on a 0-255 scale" point source)
    lightGain: 1,        // candela multiplier on model-light intensity
    moonGain: 1,         // user multiplier on the magnitude-calibrated moon disk
    psfSigma: 0.6,       // Gaussian PSF sigma in pixels
    extinctionK: 0.15,   // V-band extinction, mag/airmass (clear sea-level air;
                         // 0.2+ = humid/hazy, 0.12 = pristine mountain site)
    starTint: 1.0,       // intrinsic star color: 0 = flat white, 1 = blue-white
                         // bright-star population average (hot A/B stars dominate
                         // prominent trails) — reddening then neutralizes before
                         // it warms, matching real star-trail photos
    reddening: false,    // chromatic horizon extinction (dim AND redden); off =
                         // achromatic dimming only (V coefficient on all channels)
    settle: true,        // settle terrain/tiles per frame before capture
    step: 30,            // sample every Nth frame (exposure normalizes per sample,
                         // and point-source trails are splatted continuously across
                         // the whole inter-sample interval, so they stay smooth and
                         // photometrically correct; only background motion steps)
    occlusion: true,     // occlusion mask: splats blocked by terrain and other
                         // opaque foreground (rebuilt automatically whenever the
                         // camera position moves)
});

class CLongExposureManager {
    constructor() {
        this.params = defaultParams();
        this.nudge = nudgeParams;
        this.rendering = false;
    }

    // attach the nudge controller to the look camera (idempotent; the
    // controller is a no-op unless enabled and past nudge time)
    ensureNudgeController() {
        const camNode = NodeMan.get("lookCamera", false);
        if (camNode && !NodeMan.exists("cameraNudgeController")) {
            camNode.addController("CameraNudge", {id: "cameraNudgeController"});
        }
        // trajectory preview overlay on the look view (draws only while the
        // Camera Nudge folder is open and the nudge is enabled)
        if (NodeMan.exists("lookView") && !NodeMan.exists("nudgeTrajectoryOverlay")) {
            new CNudgeTrajectoryOverlay({id: "nudgeTrajectoryOverlay", overlayView: "lookView"});
        }
    }

    setupMenu() {
        if (!guiMenus || !guiMenus.video) return;
        const folder = guiMenus.video.addFolder("Long Exposure").close().perm();
        this.folder = folder;
        const dirty = () => { markSitchDirty(); setRenderOne(true); };

        folder.add({render: () => this.render()}, "render").name("Render Long Exposure").perm()
            .tooltip("Render an averaged long-exposure still: Duration minutes of real time\n" +
                "from the start of the sitch (the timeline is extended temporarily if the\n" +
                "exposure is longer than the sitch). Shown in a window with an EV\n" +
                "(exposure) slider and Save PNG.");
        folder.add(this.params, "durationMin", 0.1, 720, 0.1).name("Duration (Minutes)").perm().listen().onChange(dirty)
            .tooltip("Exposure length in minutes of real (sitch) time, from the start of\n" +
                "the sitch. May extend past the sitch's own end.");
        folder.add(this.params, "lockHeading").name("Lock Camera Heading").perm().listen().onChange(dirty)
            .tooltip("Hold the camera heading exactly as it is RIGHT NOW for the whole\n" +
                "exposure — a tripod doesn't track. Works in any camera mode (To Target,\n" +
                "Celestial Lock, Horizon Flare Region...): the exposure behaves as if\n" +
                "Use Angles were locked on the current spot in the sky. The Camera\n" +
                "Nudge still applies on top.");
        folder.add(this.params, "hdrPoints").name("HDR Point Sources").perm().listen().onChange(dirty)
            .tooltip("Replace the cosmetic star/planet/light sprites with physically-bright point\n" +
                "splats (true linear flux) so bright sources stay visible in the average and\n" +
                "leave correct trails. Disable for a plain frame average.");
        folder.add(this.params, "hdrBackground").name("HDR Background").perm().listen().onChange(dirty)
            .tooltip("Recover dynamic range in dark scenes: the Sun/Ambient lighting is\n" +
                "temporarily boosted so the night background renders using the full 8-bit\n" +
                "range, then scaled back down in the HDR buffer — pushing the EV slider up\n" +
                "then reveals smooth ground detail instead of quantized color bands.\n" +
                "Calibrated once on the first frame; the lighting is restored afterwards.");
        folder.add(this.params, "moonlight").name("Moonlight").perm().listen().onChange(dirty)
            .tooltip("Light the scene with ONLY the Moon: ambient light is removed and the\n" +
                "sun light is re-aimed at the Moon's position with the Moon's true\n" +
                "phase-dependent brightness (a full moon is ~20 stops dimmer than the\n" +
                "sun; shadows, if enabled, fall from the Moon). The HDR Background\n" +
                "calibration makes this renderable, and the result window opens with\n" +
                "the EV pre-set to a developed moonlit exposure. Moon below the\n" +
                "horizon = a dark scene (stars still record).");
        folder.add(this.params, "reddening").name("Horizon Reddening").perm().listen().onChange(dirty)
            .tooltip("Chromatic extinction: sources near the horizon redden as well as dim\n" +
                "(Rayleigh removes blue first, with broadband Forbes correction). Off =\n" +
                "achromatic dimming only. In real star-trail photos the reddening is\n" +
                "largely masked by blue star colors and sky glow.");
        folder.add(this.params, "starTint", 0, 2, 0.05).name("Star Tint").perm().listen().onChange(dirty)
            .tooltip("Intrinsic blue-white tint of splatted stars. 0 = flat white,\n" +
                "1 = bright-star population average (hot blue-white stars dominate\n" +
                "visible trails). With tint, horizon extinction first neutralizes the\n" +
                "blue before warming — like real star-trail photos. Stars only;\n" +
                "planets stay white, lights keep their own colors.");
        folder.add(this.params, "satMag", -6, 6, 0.1).name("Saturation Magnitude").perm().listen().onChange(dirty)
            .tooltip("Calibration: the star magnitude whose light just saturates one pixel in a\n" +
                "single frame. Lower = brighter stars overall. Venus (-4.4) with the default +1\n" +
                "is ~144x saturation.");
        folder.add(this.params, "lightGain", 0, 20, 0.1).name("Light Brightness").perm().listen().onChange(dirty)
            .tooltip("Brightness multiplier on model lights in the exposure. 1 = realistic:\n" +
                "model intensities are mapped to real effective candela (~100cd nav,\n" +
                "~200cd beacon), with inverse-square falloff and slant-path extinction.");
        folder.add(this.params, "moonGain", 0, 10, 0.05).name("Moon Gain").perm().listen().onChange(dirty)
            .tooltip("Multiplier on the magnitude-calibrated HDR moon disk (1 = physical).");
        folder.add(this.params, "psfSigma", 0.3, 2, 0.05).name("Point Spread (px)").perm().listen().onChange(dirty)
            .tooltip("Gaussian point-spread sigma in pixels for splatted sources.");
        folder.add(this.params, "settle").name("Wait For Loading").perm().listen()
            .tooltip("Settle terrain/3D-tiles each frame before capture (slower, stable).");
        folder.add(this.params, "step", 1, 600, 1).name("Frame Step").perm().listen().onChange(dirty)
            .tooltip("Sample every Nth frame of the exposure (default 30 = ~30x faster).\n" +
                "Exposure brightness is unaffected. Star/light/satellite trails stay smooth\n" +
                "and photometrically exact (they are integrated continuously between samples);\n" +
                "only background/scene motion becomes stepped. Use 1 for full quality.");
        folder.add(this.params, "occlusion").name("Occlusion Mask").perm().listen().onChange(dirty)
            .tooltip("Hide splatted sources (stars/planets/satellites/lights) behind terrain\n" +
                "and other opaque foreground, using a mask rendered from the scene.\n" +
                "Exact under camera rotation (panning, the nudge); recalculated\n" +
                "automatically whenever the camera position moves.");
        // mirrors View menu > Atmospheric Refraction. Sit is replaced per sitch
        // and this menu is built once, so bind through a live proxy.
        const refrProxy = {
            get refraction() { return !!Sit?.refractionEnabled; },   // Sit doesn't exist yet at startup
            set refraction(v) { if (Sit) Sit.refractionEnabled = v; },
        };
        folder.add(refrProxy, "refraction").name("Refraction").perm().listen()
            .onChange(() => setRenderOne(true))
            .tooltip("Atmospheric refraction (same setting as View > Atmospheric Refraction).\n" +
                "When on, splatted stars/planets/satellites use refracted apparent positions,\n" +
                "and the horizon culling and extinction altitude follow the refracted direction.");

        const nf = folder.addFolder("Camera Nudge").close().perm();
        this.nudgeFolder = nf;
        // opening/closing the folder shows/hides the trajectory preview, which
        // only redraws on a render — poke one (render-on-demand)
        for (const f of [folder, nf]) {
            if (f.$title) f.$title.addEventListener("click", () => setRenderOne(true));
        }
        const nudgeChanged = () => { this.ensureNudgeController(); dirty(); };
        nf.add(this.nudge, "enabled").name("Nudge Enabled").perm().listen().onChange(nudgeChanged)
            .tooltip("Jolt the look camera at the given time: it bounces around and settles\n" +
                "(damped spring impulse). Works live and in the long-exposure render,\n" +
                "where it draws light trails.");
        nf.add(this.nudge, "time", 0, 120, 0.1).name("Nudge Time (s)").perm().listen().onChange(nudgeChanged);
        nf.add(this.nudge, "magnitude", 0, 10, 0.05).name("Magnitude (°)").perm().listen().onChange(nudgeChanged)
            .tooltip("Peak deflection of the first swing, degrees.");
        nf.add(this.nudge, "frequency", 0.2, 10, 0.1).name("Frequency (Hz)").perm().listen().onChange(nudgeChanged)
            .tooltip("Elasticity — natural frequency of the bounce.");
        nf.add(this.nudge, "damping", 0.02, 0.8, 0.01).name("Damping").perm().listen().onChange(nudgeChanged)
            .tooltip("Damping ratio: low = rings for a long time, high = settles quickly.");
        nf.add(this.nudge, "direction", -180, 180, 1).name("Direction (°)").perm().listen().onChange(nudgeChanged);

        this.ensureNudgeController();
    }

    render() {
        if (this.rendering) return;
        this.rendering = true;
        renderLongExposure(this).catch((e) => {
            console.error("Long exposure render failed:", e);
            alert("Long exposure render failed: " + (e.message || e));
        }).finally(() => { this.rendering = false; });
    }
}

export const LongExposure = new CLongExposureManager();
if (typeof window !== "undefined") window.LongExposure = LongExposure;   // console/MCP access

// ---------------------------------------------------------------------------
// Nudge trajectory preview: the nudge path is a pure analytic function, so we
// can draw the whole bounce instantly — the exact screen-space trail a point at
// the frame center will trace. Shown on the look view only while the Camera
// Nudge folder is open (and the nudge enabled): cyan path fading as it settles,
// a yellow dot at the impulse start, and a green dot at the current frame time.

class CNudgeTrajectoryOverlay extends CNodeViewUI {
    renderCanvas(frame) {
        super.renderCanvas(frame);
        if (!this.visible || !this.ctx) return;
        const p = nudgeParams;
        if (!p.enabled || !p.magnitude) return;
        const nf = LongExposure.nudgeFolder;
        // folder open AND actually visible (parent menu open / sidebar shown)
        if (!nf || nf._closed || !nf.domElement || nf.domElement.offsetParent === null) return;
        const cam = this.overlayView?.camera;
        if (!cam) return;

        const e = cam.projectionMatrix.elements;
        const W = this.widthPx, H = this.heightPx;

        // time span: from the impulse until the envelope has decayed to 0.1%
        const zeta = Math.min(0.99, Math.max(0.005, p.damping));
        const lambda = zeta * 2 * Math.PI * Math.max(0.01, p.frequency);
        const span = Math.min(120, Math.log(1000) / lambda);
        const n = Math.min(2000, Math.max(120, Math.ceil(span * p.frequency * 48)));

        const v = new Vector3();
        const qi = new Quaternion();
        const pt = (t) => {
            const q = nudgeQuaternion(t, p);
            v.set(0, 0, -1);
            if (q) v.applyQuaternion(qi.copy(q).invert());
            const cw = e[3] * v.x + e[7] * v.y + e[11] * v.z;
            if (cw <= 1e-9) return null;
            const cx = e[0] * v.x + e[4] * v.y + e[8] * v.z;
            const cy = e[1] * v.x + e[5] * v.y + e[9] * v.z;
            return [(cx / cw + 1) * 0.5 * W, (1 - cy / cw) * 0.5 * H];
        };

        const ctx = this.ctx;
        ctx.save();
        ctx.lineWidth = 1.5;
        // draw in batches with decaying alpha so the path visually settles
        const batches = 24;
        const per = Math.ceil(n / batches);
        let prev = pt(p.time);
        let i = 1;
        for (let b = 0; b < batches && prev; b++) {
            ctx.beginPath();
            ctx.moveTo(prev[0], prev[1]);
            for (let k = 0; k < per && i <= n; k++, i++) {
                const cur = pt(p.time + (span * i) / n);
                if (!cur) { prev = null; break; }
                ctx.lineTo(cur[0], cur[1]);
                prev = cur;
            }
            ctx.strokeStyle = `rgba(0, 255, 255, ${0.85 * (1 - b / batches) + 0.1})`;
            ctx.stroke();
        }
        // impulse start (center) and current-frame position
        const start = pt(p.time);
        if (start) {
            ctx.fillStyle = "#ffff00";
            ctx.beginPath();
            ctx.arc(start[0], start[1], 3, 0, 2 * Math.PI);
            ctx.fill();
        }
        const now = pt(par.frame / (Sit.fps || 30));
        if (now) {
            ctx.fillStyle = "#00ff00";
            ctx.beginPath();
            ctx.arc(now[0], now[1], 4, 0, 2 * Math.PI);
            ctx.fill();
        }
        ctx.restore();
    }
}

export function addLongExposureMenu() {
    LongExposure.setupMenu();
}

// ---------------------------------------------------------------------------
// Serialization (saved with custom sitches, see CustomManagerSerialize)

export function serializeLongExposure() {
    const def = defaultParams(), defN = defaultNudgeParams();
    const allDefault =
        Object.keys(def).every((k) => LongExposure.params[k] === def[k]) &&
        Object.keys(defN).every((k) => nudgeParams[k] === defN[k]);
    if (allDefault) return null;
    return {params: {...LongExposure.params}, nudge: {...nudgeParams}};
}

export function deserializeLongExposure(data) {
    if (!data) return;
    Sit.longExposure = data;
    if (data.params) Object.assign(LongExposure.params, data.params);
    if (data.nudge) Object.assign(nudgeParams, data.nudge);
    if (nudgeParams.enabled) LongExposure.ensureNudgeController();
}

// ---------------------------------------------------------------------------
// Math helpers

// Abramowitz & Stegun 7.1.26, |error| < 1.5e-7
function erf(x) {
    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * x);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return sign * y;
}

// fraction of [t0, t1) during which a strobe (period `every`, on-window
// `length`, phase `offset`) is lit — exact integral, so sub-frame dashes
// carry the correct duty-cycle energy
function strobeOnFraction(t0, t1, every, length, offset) {
    if (!every || !length) return 1;
    const F = (t) => {
        t += offset;
        return Math.floor(t / every) * length + Math.min(((t % every) + every) % every, length);
    };
    if (t1 <= t0) {
        const m = (((t0 + offset) % every) + every) % every;
        return m < length ? 1 : 0;
    }
    return Math.min(1, Math.max(0, (F(t1) - F(t0)) / (t1 - t0)));
}

// clear-air extinction along a horizontal-ish slant path, magnitudes per km
// (applied to in-atmosphere model lights; stars use the airmass model below)
const LIGHT_EXT_MAG_PER_KM = 0.015;

// satellite splat calibration: apparent magnitude of a full (ramp=1) flare,
// and of the sunlit ISS. Only flaring satellites (+ the lit ISS) are splatted.
const SAT_FLARE_PEAK_MAG = -4;
const ISS_MAG = -2;
// The flare cone's falloff band fades the flare by this many MAGNITUDES.
// A linear ramp is photometrically instantaneous here (peak is ~1600x pixel
// saturation, so the square-law band crosses the whole visible range in its
// last ~1%) — streaks would start and end at full brightness. Fading in
// magnitude space makes the streak taper smoothly to zero at both ends
// while the core still flares at full peak.
const SAT_FLARE_TAPER_MAGS = 13;

// Model-light intensity -> candela for the exposure. GLB light intensities are
// tuned for DISPLAY visibility and run hot photometrically: the 737 models use
// ~543 (nav/strobe) and ~1087 (beacon), vs real effective intensities of
// ~40-100 cd (position), ~150-400 cd (beacon/strobe). 0.2 lands them in the
// realistic range (543 -> ~109 cd) without touching the display billboards.
const LIGHT_CANDELA_PER_INTENSITY = 0.2;

// Kasten-Young 1989 airmass at apparent altitude. Capped at the grazing-ray
// tangent value (~28, including refraction path-shortening) rather than the
// plane-parallel 38: a horizon ray grazes the limb and rises out of the air,
// it does not keep accumulating column. Below 0° apparent (a dipped horizon
// seen from altitude) the airmass HOLDS at the horizon value — extrapolating
// the plane-parallel fit below 0° badly over-counts a rising grazing ray.
const AIRMASS_TANGENT = 28;
function airmassKY(sinAlt) {
    const altDeg = Math.max(0, degrees(Math.asin(Math.min(1, Math.max(-1, sinAlt)))));
    const s = Math.sin(radians(altDeg));
    const am = 1 / (s + 0.50572 * Math.pow(altDeg + 6.07995, -1.6364));
    return Math.min(AIRMASS_TANGENT, Math.max(1, am));
}

// Chromatic extinction: R/G/B multipliers on the base (V-band) coefficient at
// the effective sRGB primaries 620/550/460nm — Rayleigh (λ⁻⁴) + typical clear
// aerosol + ozone Chappuis (expert-reviewed clear-air breakdown).
const EXT_RGB = [0.72, 1.00, 1.77];

// Heterochromatic (Forbes) correction: a wide sRGB channel does NOT extinct
// exponentially in airmass — as the column grows, the surviving flux shifts
// to the channel's red (low-extinction) edge, so the effective coefficient
// FALLS with airmass. Without this, a monochromatic law applied linearly to
// X≈30+ over-reddens the horizon by ~2.5 magnitudes of B−R differential.
// Modeled as a per-channel effective airmass X/(1 + a·X); a values for ~90nm
// channels at k_V = 0.16, scaled linearly with the actual coefficient.
const EXT_FORBES_A = [0.0012, 0.0030, 0.0058];

// Per-channel transmittance for a source at apparent altitude sinAlt.
// kAltScale is the observer's pressure-altitude factor exp(-h/8400m): an
// airborne camera sits above most of the extinction.
// Targets the observed horizon differential B−R ≈ 3.5-4 mag (B/R ~25-60),
// not the naive monochromatic ~6.7 mag (~470) which looks blood-red.
const _ext3 = new Float32Array(3);
function extinctionRGB(sinAlt, kBase, kAltScale, chromatic) {
    if (kBase <= 0) { _ext3[0] = _ext3[1] = _ext3[2] = 1; return _ext3; }
    const X = airmassKY(sinAlt);
    const kEff = kBase * kAltScale;
    const aScale = kEff / 0.16;            // Forbes curvature scales with the coefficient
    if (!chromatic) {
        // achromatic: V-band dimming on all channels, no color shift
        const Xe = X / (1 + EXT_FORBES_A[1] * aScale * X);
        _ext3[0] = _ext3[1] = _ext3[2] = Math.pow(10, -0.4 * kEff * (Xe - 1));
        return _ext3;
    }
    for (let c = 0; c < 3; c++) {
        const a = EXT_FORBES_A[c] * aScale;
        const Xe = X / (1 + a * X);
        _ext3[c] = Math.pow(10, -0.4 * kEff * EXT_RGB[c] * (Xe - 1));
    }
    return _ext3;
}

// --- ACES Filmic (Stephen Hill fit) forward + inverse -----------------------
// Must match shaders/ACESFilmicToneMappingShader.js exactly (incl. the /0.6).
const ACES_IN = [0.59719, 0.35458, 0.04823, 0.07600, 0.90834, 0.13383, 0.02840, 0.01566, 0.83777];
const ACES_OUT = [1.60475, -0.53108, -0.07367, -0.10208, 1.10813, -0.00605, -0.00327, -0.07276, 1.07602];

function mat3Invert(m) {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
        B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
        C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}
const ACES_IN_INV = mat3Invert(ACES_IN);
const ACES_OUT_INV = mat3Invert(ACES_OUT);

function mat3MulVec(m, x, y, z, out) {
    out[0] = m[0] * x + m[1] * y + m[2] * z;
    out[1] = m[3] * x + m[4] * y + m[5] * z;
    out[2] = m[6] * x + m[7] * y + m[8] * z;
}

function rrtOdtFit(v) {
    return (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.4329510) + 0.238081);
}

// inverse of rrtOdtFit via the quadratic formula; clamped below the asymptote
function rrtOdtFitInv(r) {
    r = Math.min(r, 0.99);                       // fit saturates near 1; cap the unclip
    const A = 1 - 0.983729 * r;
    const B = 0.0245786 - 0.4329510 * r;
    const C = -(0.000090537 + 0.238081 * r);
    const disc = B * B - 4 * A * C;
    if (disc <= 0) return 0;
    return Math.max(0, (-B + Math.sqrt(disc)) / (2 * A));
}

const _m3a = [0, 0, 0], _m3b = [0, 0, 0];

// display-linear [0..1] rgb -> scene-linear (in place on arr at idx)
function acesInverse(arr, idx, exposure) {
    mat3MulVec(ACES_OUT_INV, arr[idx], arr[idx + 1], arr[idx + 2], _m3a);
    _m3a[0] = rrtOdtFitInv(_m3a[0]);
    _m3a[1] = rrtOdtFitInv(_m3a[1]);
    _m3a[2] = rrtOdtFitInv(_m3a[2]);
    mat3MulVec(ACES_IN_INV, _m3a[0], _m3a[1], _m3a[2], _m3b);
    const s = 0.6 / exposure;
    arr[idx] = Math.max(0, _m3b[0] * s);
    arr[idx + 1] = Math.max(0, _m3b[1] * s);
    arr[idx + 2] = Math.max(0, _m3b[2] * s);
}

// scene-linear rgb -> display-linear [0..1] (in place)
function acesForward(arr, idx, exposure) {
    const s = exposure / 0.6;
    mat3MulVec(ACES_IN, arr[idx] * s, arr[idx + 1] * s, arr[idx + 2] * s, _m3a);
    mat3MulVec(ACES_OUT, rrtOdtFit(_m3a[0]), rrtOdtFit(_m3a[1]), rrtOdtFit(_m3a[2]), _m3b);
    arr[idx] = Math.min(1, Math.max(0, _m3b[0]));
    arr[idx + 1] = Math.min(1, Math.max(0, _m3b[1]));
    arr[idx + 2] = Math.min(1, Math.max(0, _m3b[2]));
}

// ---------------------------------------------------------------------------
// The offline render

async function renderLongExposure(mgr) {
    const lookView = NodeMan.get("lookView", false);
    if (!lookView || !lookView.camera) { alert("Long Exposure: no look view in this sitch."); return; }
    const camera = lookView.camera;
    const P = mgr.params;

    const fps = Sit.fps || 30;
    // expose for Duration minutes from the FIRST frame of the sitch. If that
    // runs past the sitch end, temporarily extend Sit.frames / aFrame / bFrame
    // so the world keeps evaluating (restored in the finally below).
    const startFrame = 0;
    const numFrames = Math.max(1, Math.round((P.durationMin ?? 5) * 60 * fps));
    const endFrame = startFrame + numFrames - 1;
    const savedSitFrames = Sit.frames, savedSitA = Sit.aFrame, savedSitB = Sit.bFrame;
    if (endFrame >= (Sit.frames ?? 1)) {
        Sit.frames = endFrame + 1;
        Sit.bFrame = endFrame;
        if (Sit.aFrame === undefined) Sit.aFrame = 0;
    }
    const step = Math.max(1, Math.round(P.step || 1));
    const numSamples = Math.ceil(numFrames / step);
    // preview cadence: roughly every 30 frames of sitch time, at least every sample
    const previewEvery = Math.max(1, Math.round(30 / step));

    mgr.ensureNudgeController();

    // Lock Camera Heading: capture the orientation AS IT IS RIGHT NOW (before
    // the exposure loop re-runs the controllers at exposure frames), minus any
    // live nudge offset, and hold it for every sample — a tripod doesn't track,
    // whatever camera mode (To Target / Celestial Lock / ...) is active.
    let lockQuat = null;
    if (P.lockHeading && camera) {
        lockQuat = camera.quaternion.clone();
        const nqNow = nudgeQuaternion((par.frame ?? 0) / fps);
        if (nqNow) lockQuat.multiply(nqNow.invert());
    }

    // ---- save / take over state ----
    const savedFrame = par.frame, savedPaused = par.paused, savedTime = par.time;
    par.paused = true;
    Globals.scriptedVideoRendering = true;   // exclusive rendering control (same flag as Scripted Video):
                                             // stops the live RAF loop resizing views / re-pinning par.frame mid-await
    const savedVisible = lookView.visible;
    lookView.setVisible(true);

    // opaque cover: the offline render drives the live view (camera nudges,
    // terrain streams) which would otherwise flash on screen; captured buffers
    // are unaffected by what's drawn on top. It also hosts a live preview of
    // the developing exposure, refreshed every 30 frames.
    const cover = document.createElement("div");
    cover.style.cssText = "position:fixed;inset:0;background:#000;z-index:2147483646;" +
        "display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;" +
        "color:#777;font-family:sans-serif;font-size:18px;";
    const coverLabel = document.createElement("div");
    coverLabel.textContent = "Rendering long exposure…";
    cover.appendChild(coverLabel);
    document.body.appendChild(cover);
    let preview = null, previewCtx = null, previewImg = null;

    const progress = new ExportProgressWidget(
        `Rendering long exposure (${numSamples} of ${numFrames} frames${step > 1 ? `, step ${step}` : ""})…`,
        numSamples);

    // ---- gather HDR sources, hide their cosmetic LDR versions ----
    const nightSky = NodeMan.get("NightSkyNode", false);
    const starField = nightSky?.starField;
    const planets = nightSky?.planets;
    const hiddenSprites = [];   // {obj, was} — re-hidden every frame (some are rewritten by updates)
    const lightNodes = [];

    let starDirsECI = null, starFlux = null, starCount = 0;
    if (P.hdrPoints) {
        if (starField?.lightCloud) {
            for (const pts of [starField.lightCloud.points, starField.lightCloud.mainViewPoints]) {
                if (pts) hiddenSprites.push({obj: pts, was: pts.visible});
            }
            // full catalog (the displayed cloud is pre-filtered by Sit.starLimit;
            // a real exposure integrates every star)
            starCount = starField.BSC_NumStars || 0;
            if (starCount) {
                starDirsECI = new Float32Array(starCount * 3);
                starFlux = new Float32Array(starCount);
                for (let i = 0; i < starCount; i++) {
                    const eq = raDec2Celestial(starField.BSC_RA[i], starField.BSC_DEC[i], 1);
                    starDirsECI[i * 3] = eq.x;
                    starDirsECI[i * 3 + 1] = eq.y;
                    starDirsECI[i * 3 + 2] = eq.z;
                    starFlux[i] = Math.pow(10, -0.4 * (starField.BSC_MAG[i] - P.satMag));
                }
            }
        }
        if (planets?.planetSprites) {
            for (const [name, ps] of Object.entries(planets.planetSprites)) {
                if (name === "Moon" || name === "Sun") continue;   // Moon stays (HDR disk); Sun not splatted
                for (const s of [ps.sprite, ps.daySkySprite]) {
                    if (s) hiddenSprites.push({obj: s, was: s.visible});
                }
            }
        }
        for (const entry of Object.values(NodeMan.list)) {
            const n = entry.data;
            if (n instanceof CNode3DLight) {
                lightNodes.push(n);
                n.suppressBillboard = true;
            }
        }
        // hide the LDR satellite cloud: only flaring satellites (+ lit ISS)
        // are splatted; everything else is omitted from the exposure
        if (nightSky?.satellites?.lightCloud) {
            for (const pts of [nightSky.satellites.lightCloud.points, nightSky.satellites.lightCloud.mainViewPoints]) {
                if (pts) hiddenSprites.push({obj: pts, was: pts.visible});
            }
        }
    }
    // chart furniture never belongs in a photograph: constellation lines and
    // the equatorial grid are hidden for the exposure (both modes), restored after
    if (nightSky) {
        for (const g of [nightSky.constellationsGroup, nightSky.equatorialSphereGroup]) {
            if (g) hiddenSprites.push({obj: g, was: g.visible});
        }
    }
    const reHide = () => { for (const h of hiddenSprites) h.obj.visible = false; };

    // ---- decode (display bytes -> scene-linear) setup ----
    const srgbLut = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
        const c = i / 255;
        srgbLut[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }
    // mirrors useAtmosphereHDR in CNodeView3D.renderTargetAndEffects — when the
    // look view tone-maps the whole frame with ACES, invert it exactly.
    // (The non-HDR sky-only ACES pass on GlobalDaySkyScene sitches is NOT
    // inverted — documented approximation; the night sky it affects is dark.)
    const useACES = !!(lookView.useLookViewHDR && lookView.atmosphereEnabled && lookView.atmosphereHDR && lookView.hdrToneMappingPass);
    let acesExposure = 1;
    if (useACES) {
        const skyExposure = NodeMan.get("theSky", false)?.effectController?.exposure ?? 1.0;
        const sceneExposure = NodeMan.get("lighting", false)?.sceneExposure ?? 1.0;
        acesExposure = skyExposure * (lookView.atmosphereExposure ?? 1.0) * sceneExposure;
    }

    // ---- HDR background: temporary lighting boost ----
    // A night scene's lit content may land in just a few 8-bit codes (ambient
    // 0.01 -> the whole ground in codes 0-5), so pushing the result's EV up
    // shows quantized color bands. Because Three.js lighting is linear, we can
    // temporarily multiply the scene lighting (Sun + Ambient) so the first
    // frame's brightest lit content sits just under saturation — using the
    // full 8-bit range — then divide the decoded frame by the same factor:
    // true brightness, far finer quantization. Calibrated on the first sample
    // (re-rendering it until the 99.9th-percentile pixel hits the target),
    // held for the whole exposure, restored in the finally.
    // Content that does NOT respond to the lights (the atmosphere's sky glow,
    // emissive sprites) ends up boost x darker in the buffer — at night that
    // is near-black anyway, and stars/planets/lights are splatted in HDR.
    // Moonlight mode needs a far higher cap: physical moonlight is ~20+ stops
    // below the daylight calibration (more for a crescent), and the boost is
    // what brings it back into the 8-bit render.
    const BG_BOOST_CAP = P.moonlight ? 1e9 : 1024;
    let bgBoost = 1, bgProbed = false;

    // Point-source ↔ rendered-scene tie (Moonlight mode). The splat flux scale
    // (satMag, an astronomical zero-point) and the rendered ground (the engine's
    // physical lighting, scaled by the HDR boost) are otherwise on unrelated
    // absolute scales — a mag-4 star deposits 1.0 while moonlit ground sits at
    // ~1e-6, an ~20-stop gap, so no single EV shows both stars AND landscape the
    // way a real moonlit long exposure does. For a real camera the recorded
    // signal of a POINT source vs an EXTENDED surface differs by the plate
    // scale: star/ground = E_star / (L_ground · ω_pixel). Working it through
    // (the moon's own brightness cancels), the physically-correct splat scale is
    //   splatScale = 10^(0.4(moonMag − satMag)) · π · bgTarget / (albedo · boost · ω_pixel)
    // applied to every point-source deposit. 1.0 in every other mode.
    let splatScale = 1;
    const GROUND_ALBEDO_REF = 0.3;   // assumed albedo of the brightest patch
                                     // that set the boost; only affects the
                                     // star/ground RATIO, EV absorbs the rest
    let bgTargetLin = 0.9;     // decoded-linear value the p99.9 pixel should reach
    let bgClipLin = 0.98;      // decoded-linear value that means "clipped, back off"
    if (useACES) {
        _tmPx[0] = _tmPx[1] = _tmPx[2] = 0.9;
        acesInverse(_tmPx, 0, acesExposure);
        bgTargetLin = _tmPx[0];
        _tmPx[0] = _tmPx[1] = _tmPx[2] = 0.98;
        acesInverse(_tmPx, 0, acesExposure);
        bgClipLin = _tmPx[0];
    }
    // Moonlight mode: the override lives INSIDE the sun pipeline
    // (CNodeSunlight.update honors theSun.moonlightMode) because every view
    // render re-runs that update, clobbering any external light writes. Set
    // the flag for the whole exposure; cleared in the finally.
    const theSunNode = NodeMan.get("theSun", false);
    if (P.moonlight) {
        if (theSunNode) theSunNode.moonlightMode = true;
        else console.warn("Long exposure: Moonlight mode needs a theSun node — ignoring");
    }
    const savedLights = [];
    function scaleSceneLights(ratio) {
        // theSun (when present) rewrites the global light intensities from its
        // own properties every update, so the boost must go on the node
        // properties; the lighting node is scaled too so a mid-render
        // recalculate() can't push unboosted values back onto theSun.
        const targets = [];
        const theSun = NodeMan.get("theSun", false);
        const lighting = NodeMan.get("lighting", false);
        if (theSun) targets.push([theSun, "sunIntensity"], [theSun, "ambientIntensity"]);
        if (lighting) targets.push([lighting, "sunIntensity"], [lighting, "ambientIntensity"]);
        if (!theSun && !lighting) {
            if (Globals.sunLight) targets.push([Globals.sunLight, "intensity"]);
            if (Globals.ambientLight) targets.push([Globals.ambientLight, "intensity"]);
        }
        for (const [o, k] of targets) {
            if (!savedLights.some(([so, sk]) => so === o && sk === k)) savedLights.push([o, k, o[k]]);
            o[k] *= ratio;
        }
    }
    function restoreSceneLights() {
        for (const [o, k, v] of savedLights) o[k] = v;
        savedLights.length = 0;
    }
    // 99.9th-percentile per-pixel max channel of the decoded frame: robust to
    // a few stray bright pixels (sprite edges, a tiny moon), and inert
    // (boost ~1) when genuinely bright content fills the frame
    function bgPercentile() {
        const nPix = W * H;
        const vals = new Float32Array(Math.ceil(nPix / 2));
        let n = 0;
        for (let p = 0; p < nPix; p += 2) {
            const r = frameLin[p * 3], g = frameLin[p * 3 + 1], b = frameLin[p * 3 + 2];
            vals[n++] = r > g ? (r > b ? r : b) : (g > b ? g : b);
        }
        vals.subarray(0, n).sort();
        return vals[Math.min(n - 1, Math.floor(n * 0.999))];
    }

    // ---- per-run state, sized after the first render ----
    let W = 0, H = 0, acc = null, frameLin = null, readCanvas = null, readCtx = null;

    const _q = new Quaternion(), _qInv = new Quaternion(), _qTmp = new Quaternion();
    const _v = new Vector3(), _v2 = new Vector3();
    let projElements = null;

    // ---- static-camera occlusion mask ----
    // Rendered once from the first sample's base pose: the whole GlobalScene
    // with a white override material on black — any opaque pixel (terrain,
    // buildings, models) occludes, exactly as the look view renders it (same
    // camera layers). Splat sub-samples are tested by projecting the SOURCE
    // through the MASK's pose, so the test depends only on direction from the
    // (static) camera position — exact under rotation-only motion like the
    // nudge. Invalidated if the camera position moves.
    let occMask = null, occW = 0, occH = 0;
    const occQuatInv = new Quaternion();
    const occPos = new Vector3();
    let occProj = null;
    const _vm = new Vector3();

    function maskOccluded(src) {
        if (src.isDir) _vm.set(src.x, src.y, src.z);
        else _vm.copy(src.pos).sub(occPos);
        _vm.applyQuaternion(occQuatInv);
        const e = occProj;
        const w = src.isDir ? 0 : 1;
        const cw = e[3] * _vm.x + e[7] * _vm.y + e[11] * _vm.z + e[15] * w;
        if (cw <= 1e-9) return false;                  // behind the mask camera: assume visible
        const cx = e[0] * _vm.x + e[4] * _vm.y + e[8] * _vm.z + e[12] * w;
        const cy = e[1] * _vm.x + e[5] * _vm.y + e[9] * _vm.z + e[13] * w;
        const mx = Math.floor((cx / cw + 1) * 0.5 * occW);
        const my = Math.floor((1 - cy / cw) * 0.5 * occH);
        if (mx < 0 || my < 0 || mx >= occW || my >= occH) return false;   // outside mask: assume visible
        return occMask[my * occW + mx] !== 0;
    }

    function computeOcclusionMask(qBase) {
        const renderer = lookView.renderer;
        if (!renderer || !GlobalScene) return null;
        const rt = new WebGLRenderTarget(W, H);
        const override = new MeshBasicMaterial({color: 0xffffff});
        const savedQuat = camera.quaternion.clone();
        const savedClearColor = new Color();
        renderer.getClearColor(savedClearColor);
        const savedClearAlpha = renderer.getClearAlpha();
        const savedOverride = GlobalScene.overrideMaterial;
        let mask = null;
        try {
            camera.quaternion.copy(qBase);
            camera.updateMatrix();
            camera.updateMatrixWorld(true);
            GlobalScene.overrideMaterial = override;
            renderer.setRenderTarget(rt);
            renderer.setClearColor(0x000000, 1);
            renderer.clear();
            renderer.render(GlobalScene, camera);
            const buf = new Uint8Array(W * H * 4);
            renderer.readRenderTargetPixels(rt, 0, 0, W, H, buf);
            mask = new Uint8Array(W * H);
            // GL readback is bottom-to-top: flip Y into canvas orientation
            for (let y = 0; y < H; y++) {
                const srcRow = (H - 1 - y) * W;
                for (let x = 0; x < W; x++) {
                    mask[y * W + x] = buf[(srcRow + x) * 4] > 16 ? 1 : 0;
                }
            }
        } catch (e) {
            console.warn("Long exposure: occlusion mask render failed", e);
            mask = null;
        } finally {
            GlobalScene.overrideMaterial = savedOverride;
            renderer.setRenderTarget(null);
            renderer.setClearColor(savedClearColor, savedClearAlpha);
            camera.quaternion.copy(savedQuat);
            camera.updateMatrix();
            camera.updateMatrixWorld(true);
            rt.dispose();
            override.dispose();
        }
        return mask;
    }

    // project a source through pose (q, camPos); src: {isDir, x,y,z | pos}
    // returns false if behind/invalid; result in out {x, y} canvas-pixel coords
    function projectAt(q, camPos, src, out) {
        _qInv.copy(q).invert();
        if (src.isDir) _v.set(src.x, src.y, src.z);
        else _v.copy(src.pos).sub(camPos);
        _v.applyQuaternion(_qInv);
        const e = projElements;
        const w = src.isDir ? 0 : 1;
        const cw = e[3] * _v.x + e[7] * _v.y + e[11] * _v.z + e[15] * w;
        if (cw <= 1e-9) return false;            // behind the camera (cw = -z)
        const cx = e[0] * _v.x + e[4] * _v.y + e[8] * _v.z + e[12] * w;
        const cy = e[1] * _v.x + e[5] * _v.y + e[9] * _v.z + e[13] * w;
        out.x = (cx / cw + 1) * 0.5 * W;
        out.y = (1 - cy / cw) * 0.5 * H;
        return true;
    }

    // energy-conserving erf-integrated Gaussian deposit at sub-pixel (px, py)
    const wxArr = new Float32Array(16), wyArr = new Float32Array(16);
    function deposit(px, py, energy, r, g, b) {
        if (energy <= 0) return;
        const sigma = Math.max(0.2, P.psfSigma);
        const inv = 1 / (Math.SQRT2 * sigma);
        const rad = Math.min(7, Math.max(1, Math.ceil(3 * sigma)));
        const ix0 = Math.round(px) - rad, iy0 = Math.round(py) - rad;
        const n = rad * 2 + 1;
        if (ix0 + n < 0 || iy0 + n < 0 || ix0 >= W || iy0 >= H) return;
        let prevX = erf((ix0 - px) * inv);
        for (let i = 0; i < n; i++) {
            const nextX = erf((ix0 + i + 1 - px) * inv);
            wxArr[i] = 0.5 * (nextX - prevX);
            prevX = nextX;
        }
        let prevY = erf((iy0 - py) * inv);
        for (let i = 0; i < n; i++) {
            const nextY = erf((iy0 + i + 1 - py) * inv);
            wyArr[i] = 0.5 * (nextY - prevY);
            prevY = nextY;
        }
        for (let j = 0; j < n; j++) {
            const y = iy0 + j;
            if (y < 0 || y >= H) continue;
            const ew = energy * wyArr[j];
            for (let i = 0; i < n; i++) {
                const x = ix0 + i;
                if (x < 0 || x >= W) continue;
                const e2 = ew * wxArr[i];
                const idx = (y * W + x) * 3;
                acc[idx] += e2 * r;
                acc[idx + 1] += e2 * g;
                acc[idx + 2] += e2 * b;
            }
        }
    }

    // splat one source along the interval [t0, t1]: slerp the base pose,
    // compose the analytic nudge, adaptively subdivide to ~0.6px steps
    const _pA = {x: 0, y: 0}, _pB = {x: 0, y: 0}, _pM = {x: 0, y: 0}, _pS = {x: 0, y: 0};
    function splatInterval(src, prevPose, curPose, t0, t1, flux, r, g, b, strobe) {
        const poseAt = (s, t) => {
            _qTmp.slerpQuaternions(prevPose.qBase, curPose.qBase, s);
            const nq = nudgeQuaternion(t);
            if (nq) _qTmp.multiply(nq);
            _v2.lerpVectors(prevPose.pos, curPose.pos, s);
            return _qTmp;
        };
        const srcAt = (s) => {
            if (src.isDir || !src.prevPos) return src;
            _movingSrc.pos.lerpVectors(src.prevPos, src.pos, s);
            return _movingSrc;
        };
        // estimate path length from endpoints + midpoint
        const okA = projectAt(poseAt(0, t0), _v2, srcAt(0), _pA);
        const okM = projectAt(poseAt(0.5, (t0 + t1) / 2), _v2, srcAt(0.5), _pM);
        const okB = projectAt(poseAt(1, t1), _v2, srcAt(1), _pB);
        if (!okA && !okM && !okB) return;
        let est = 0;
        if (okA && okM) est += Math.hypot(_pM.x - _pA.x, _pM.y - _pA.y);
        if (okM && okB) est += Math.hypot(_pB.x - _pM.x, _pB.y - _pM.y);
        if (!okM && okA && okB) est = Math.hypot(_pB.x - _pA.x, _pB.y - _pA.y);
        // cap scales with Frame Step: inter-sample intervals are step× longer,
        // so a fast streak can legitimately cover step× more pixels per interval
        const nSub = Math.min(4096, Math.max(1, Math.ceil(est / 0.6)));
        const eSub = flux * splatScale / nSub;
        const dt = (t1 - t0);
        for (let k = 0; k < nSub; k++) {
            const s = (k + 0.5) / nSub;
            const t = t0 + dt * s;
            let e2 = eSub;
            if (strobe) {
                e2 *= strobeOnFraction(t0 + dt * (k / nSub), t0 + dt * ((k + 1) / nSub),
                    strobe.every, strobe.length, strobe.offset);
                if (e2 <= 0) continue;
            }
            const ss = srcAt(s);
            if (occMask && maskOccluded(ss)) continue;   // blocked by foreground
            if (projectAt(poseAt(s, t), _v2, ss, _pS)) {
                deposit(_pS.x, _pS.y, e2, r, g, b);
            }
        }
    }
    const _movingSrc = {isDir: false, pos: new Vector3()};

    // ---- offline per-frame recipe (mirrors ScriptRenderer.renderViewAt) ----
    async function updateWorld(f) {
        par.frame = f;
        par.time = f / fps;            // strobes etc. read par.time; only the live loop sets it
        GlobalDateTimeNode?.update(f);
        for (const entry of Object.values(NodeMan.list)) {
            const n = entry.data;
            if (n.isController && !n.allowUpdate) continue;
            if (n.update !== undefined) n.update(f);
            if (n.videoData && n.videoData.waitForFrame) {
                try { await n.videoData.waitForFrame(f); } catch (e) { /* video frame not critical */ }
            }
        }
        reHide();
    }
    function applyHeadingLock(t) {
        if (!lockQuat) return;
        camera.quaternion.copy(lockQuat);
        const nq = nudgeQuaternion(t);           // the nudge still bounces the locked heading
        if (nq) camera.quaternion.multiply(nq);
        camera.updateMatrix();
        camera.updateMatrixWorld(true);
    }
    function renderOnce(f) {
        for (const pn of NodeMan.getPreRenderNodes()) pn.preRender(lookView);
        lookView.renderCanvas(f);
        for (const pn of NodeMan.getPostRenderNodes()) pn.postRender(lookView);
    }

    let prevPose = null;             // {qBase, pos, t}
    const prevLightPos = new Map();  // light node id -> Vector3 (last frame's world pos)
    const prevSatPos = new Map();    // satellite number -> Vector3 (last frame's apparent pos)
    let framesDone = 0;              // SAMPLES actually accumulated (early "Enough" stop);
                                     // the average normalizes per sample, so Frame Step
                                     // changes speed, not exposure brightness

    try {
        for (let i = 0; i < numFrames; i += step) {
            if (progress.shouldStop()) break;
            const f = startFrame + i;
            const t = f / fps;

            await updateWorld(f);
            applyHeadingLock(t);
            renderOnce(f);
            if (P.settle) {
                await waitForExportFrameSettled({
                    frame: null, viewIds: [lookView.id],
                    renderFrame: async () => { await updateWorld(f); applyHeadingLock(t); renderOnce(f); },
                    maxWaitMs: 8000, stableChecks: 2, postSettleRenders: 1,
                    logPrefix: "Long exposure",
                });
            }

            // first frame: size buffers to the canvas backing store
            if (!acc) {
                W = lookView.canvas.width;
                H = lookView.canvas.height;
                acc = new Float32Array(W * H * 3);
                frameLin = new Float32Array(W * H * 3);
                readCanvas = document.createElement("canvas");
                readCanvas.width = W; readCanvas.height = H;
                readCtx = readCanvas.getContext("2d", {willReadFrequently: true});
                preview = document.createElement("canvas");
                preview.width = W; preview.height = H;
                preview.style.cssText = "max-width:86vw;max-height:78vh;object-fit:contain;border:1px solid #333;";
                previewCtx = preview.getContext("2d");
                previewImg = previewCtx.createImageData(W, H);
                cover.appendChild(preview);
            }

            // pose actually rendered (controllers incl. nudge have run);
            // un-apply the analytic nudge to get the base pose for sub-frame slerp
            const qRendered = camera.quaternion.clone();
            const nq = nudgeQuaternion(t);
            const qBase = nq ? qRendered.clone().multiply(_q.copy(nq).invert()) : qRendered;
            const pose = {qBase, pos: camera.position.clone(), t};
            projElements = camera.projectionMatrix.elements.slice();

            // occlusion mask: build from this sample's base pose, and rebuild
            // whenever the camera POSITION moves (parallax changes what hides
            // what). Rotation alone (panning, the nudge) needs no rebuild —
            // the lookup projects sources through the mask's own pose, which
            // is exact for a fixed viewpoint.
            if (P.hdrPoints && P.occlusion) {
                if (!occMask || pose.pos.distanceTo(occPos) > 0.25) {
                    occW = W; occH = H;
                    occPos.copy(pose.pos);
                    occQuatInv.copy(pose.qBase).invert();
                    occProj = projElements.slice();
                    occMask = computeOcclusionMask(pose.qBase);
                }
            } else {
                occMask = null;
            }

            // ---- readback + decode to scene-linear ----
            const nPix = W * H;
            const decodeFrame = () => {
                readCtx.fillStyle = "#000";
                readCtx.fillRect(0, 0, W, H);
                readCtx.drawImage(lookView.canvas, 0, 0, W, H);
                const data = readCtx.getImageData(0, 0, W, H).data;
                for (let p = 0; p < nPix; p++) {
                    frameLin[p * 3] = srgbLut[data[p * 4]];
                    frameLin[p * 3 + 1] = srgbLut[data[p * 4 + 1]];
                    frameLin[p * 3 + 2] = srgbLut[data[p * 4 + 2]];
                }
                if (useACES) {
                    for (let p = 0; p < nPix; p++) acesInverse(frameLin, p * 3, acesExposure);
                }
            };
            decodeFrame();

            // ---- HDR background: calibrate the lighting boost (first sample) ----
            // (moonlight mode depends on it: physical moonlight would render black)
            if ((P.hdrBackground || P.moonlight) && !bgProbed) {
                bgProbed = true;
                for (let iter = 0; iter < 10; iter++) {
                    const ref = bgPercentile();
                    let next;
                    if (ref <= 1e-7) next = bgBoost * 1024;                     // unmeasurably dark (all code 0):
                                                                                // step up by a measurable factor —
                                                                                // jumping straight to a huge cap
                                                                                // can't walk back down by halving
                    else if (ref >= bgClipLin) next = bgBoost * 0.5;            // clipped: back off
                    else next = bgBoost * (bgTargetLin / ref);                  // linear lighting: exact step
                    next = Math.min(BG_BOOST_CAP, Math.max(1, next));
                    if (Math.abs(next / bgBoost - 1) < 0.05) break;
                    scaleSceneLights(next / bgBoost);
                    bgBoost = next;
                    // re-render this sample under the adjusted lighting
                    await updateWorld(f);
                    applyHeadingLock(t);
                    renderOnce(f);
                    decodeFrame();
                }
                if (bgBoost > 1.01) {
                    console.log(`Long exposure: HDR background lighting boost ${bgBoost.toFixed(1)}x`);
                } else if (bgBoost !== 1) {
                    restoreSceneLights();
                    bgBoost = 1;
                }
                // tie the point-source scale to the now-calibrated ground
                if (P.moonlight && bgBoost > 1) {
                    const e = projElements;
                    const omegaPix = (2 * Math.atan(1 / e[0]) / W) * (2 * Math.atan(1 / e[5]) / H);
                    const moonMag = nightSky?.planets?.planetSprites?.Moon?.mag ?? -12.7;
                    splatScale = Math.pow(10, 0.4 * (moonMag - P.satMag)) *
                        Math.PI * bgTargetLin / (GROUND_ALBEDO_REF * bgBoost * omegaPix);
                    console.log(`Long exposure: moonlight splat scale ${splatScale.toExponential(2)} ` +
                        `(moonMag ${moonMag.toFixed(2)}, ωpix ${omegaPix.toExponential(2)})`);
                }
            }
            if (bgBoost !== 1) {
                const ib = 1 / bgBoost;
                for (let p = 0; p < nPix * 3; p++) frameLin[p] *= ib;
            }

            // ---- HDR moon disk: scale so the disk's total energy matches its magnitude ----
            if (P.hdrPoints && P.moonGain > 0 && planets?.planetSprites?.Moon && nightSky?.celestialSphere) {
                boostMoonDisk(frameLin, W, H, planets, nightSky, camera, projElements, P, projectAt);
            }

            // ---- accumulate the frame ----
            for (let p = 0; p < nPix * 3; p++) acc[p] += frameLin[p];

            // ---- HDR point splats over [prev frame, this frame] ----
            if (P.hdrPoints) {
                const pPose = prevPose || pose;
                const t0 = prevPose ? prevPose.t : t;

                // geodetic zenith + observer pressure altitude: an airborne
                // camera sits above most of the extinction (scale exp(-h/8400m))
                // and its horizon dips below 0° apparent altitude
                const up = getLocalUpVector(camera.position);
                const camAltM = Math.max(0, altitudeHAE(camera.position));
                const kAltScale = Math.exp(-camAltM / 8400);
                const horizonSin = -(Math.sqrt(2 * camAltM / 6371000) + 0.01);

                // celestial sources (skip in full daylight, like renderSky)
                const skyOp = NodeMan.get("theSun", false)?.skyOpacity ?? 0;
                if (nightSky?.celestialSphere && skyOp < 1) {
                    const celQ = nightSky.celestialSphere.getWorldQuaternion(new Quaternion());
                    const celQInv = celQ.clone().invert();
                    const refractOn = refractionUniforms.uRefractionEnabled.value > 0.5;
                    const refractOpts = refractOn ? refractionOptsFromUniforms() : null;
                    const zenith = refractionUniforms.uZenithECEF.value;

                    // FOV cone pre-cull in ECI (avoids transforming all ~9000 stars)
                    const fwd = new Vector3(0, 0, -1).applyQuaternion(pose.qBase);
                    const fwdPrev = new Vector3(0, 0, -1).applyQuaternion(pPose.qBase);
                    const fwdECI = fwd.clone().add(fwdPrev).normalize().applyQuaternion(celQInv);
                    const e = projElements;
                    const halfDiag = Math.atan(Math.hypot(1 / e[0], 1 / e[5]));
                    const interFrame = fwd.angleTo(fwdPrev);
                    const margin = radians(3) + interFrame +
                        (nudgeParams.enabled ? radians(nudgeParams.magnitude * 2.6) : 0);
                    const cosLimit = Math.cos(Math.min(Math.PI, halfDiag + margin));

                    const celSrc = {isDir: true, x: 0, y: 0, z: 0};
                    // chromatic extinction rides in the splat color channels:
                    // per-channel transmittance × source color, so horizon
                    // sources dim AND redden together
                    const splatCelestial = (dirECI, flux, r, g, b) => {
                        _v2.copy(dirECI).applyQuaternion(celQ);       // -> ECEF/world
                        if (refractOn) applyRefractionECI(_v2, zenith, refractOpts);
                        const sinAlt = _v2.dot(up);
                        if (sinAlt < horizonSin) return;              // below (dipped) horizon
                        const ex = extinctionRGB(sinAlt, P.extinctionK, kAltScale, P.reddening);
                        if (flux * ex[0] < 1e-5) return;              // red fades last
                        celSrc.x = _v2.x; celSrc.y = _v2.y; celSrc.z = _v2.z;
                        splatInterval(celSrc, pPose, pose, t0, t, flux, r * ex[0], g * ex[1], b * ex[2], null);
                    };

                    if (starDirsECI) {
                        // intrinsic blue-white tint (Star Tint dial): lerp from flat
                        // white toward the bright-star population average [.78,.90,1.10]
                        const tt = Math.max(0, P.starTint ?? 1);
                        const sr = 1 + tt * (0.78 - 1), sg = 1 + tt * (0.90 - 1), sb = 1 + tt * (1.10 - 1);
                        for (let s = 0; s < starCount; s++) {
                            const x = starDirsECI[s * 3], y = starDirsECI[s * 3 + 1], z = starDirsECI[s * 3 + 2];
                            if (x * fwdECI.x + y * fwdECI.y + z * fwdECI.z < cosLimit) continue;
                            splatCelestial(_v.set(x, y, z), starFlux[s], sr, sg, sb);
                        }
                    }
                    if (planets?.planetSprites) {
                        for (const [name, ps] of Object.entries(planets.planetSprites)) {
                            if (name === "Moon" || name === "Sun") continue;
                            if (ps.mag === undefined || !ps.equatorial) continue;
                            // ps.equatorial is ECI and ALREADY refracted (CPlanets,
                            // under the same Sit.refractionEnabled flag) — don't
                            // re-refract; rotate to ECEF directly.
                            // white: the display sprites are color-coded for
                            // identification, but photometrically planets are
                            // near-white point sources
                            const flux = Math.pow(10, -0.4 * (ps.mag - P.satMag));
                            if (flux < 1e-5) continue;
                            _v2.copy(ps.equatorial).normalize().applyQuaternion(celQ);
                            const sinAlt = _v2.dot(up);
                            if (sinAlt < horizonSin) continue;
                            const ex = extinctionRGB(sinAlt, P.extinctionK, kAltScale, P.reddening);
                            if (flux * ex[0] < 1e-5) continue;
                            celSrc.x = _v2.x; celSrc.y = _v2.y; celSrc.z = _v2.z;
                            splatInterval(celSrc, pPose, pose, t0, t, flux, ex[0], ex[1], ex[2], null);
                        }
                    }

                    // Satellites: only FLARING ones, plus the ISS when sunlit —
                    // everything else is omitted (the LDR cloud is hidden above).
                    // The glint ramp is recomputed fresh per frame (the display's
                    // updateSatellites staggers each sat every ~10 frames), and the
                    // flare flux ramps with the same shared cone falloff the live
                    // view uses. Fast-moving sats get the same sub-frame interval
                    // splatting as everything else -> smooth flare streaks.
                    const sats = nightSky?.satellites;
                    if (sats?.TLEData?.satData && sats.showSatellites !== false && Globals.toSun) {
                        const spread = sats.flareAngle;
                        const fluxFlarePeak = Math.pow(10, -0.4 * (SAT_FLARE_PEAK_MAG - P.satMag));
                        const fluxISS = Math.pow(10, -0.4 * (ISS_MAG - P.satMag));
                        for (const sd of sats.TLEData.satData) {
                            if (!sd || sd.invalidPosition || !sd.ecef) continue;
                            // isLit is staggered (~10 frame refresh) but the shadow
                            // boundary moves slowly; the glint itself is recomputed
                            // fresh for EVERY lit satellite every frame so streak
                            // entry/exit are exact, not stagger-truncated.
                            if (!sd.isLit) continue;
                            const isISS = sd.number === 25544;
                            const pos = sd.ecefApparent ?? sd.ecef;
                            _v.copy(pos).sub(camera.position).normalize();
                            const sinAlt = _v.dot(up);
                            if (sinAlt < horizonSin) continue;
                            let flux = isISS ? fluxISS : 0;
                            const satNormal = sats.getSatelliteNormal(sd.ecef, nightSky.globe.center);
                            const reflected = _v2.copy(sd.ecef).sub(camera.position).reflect(satNormal).normalize();
                            const dotS = Math.max(-1, Math.min(1, reflected.dot(Globals.toSun)));
                            const glintAngle = Math.abs(degrees(Math.acos(dotS)));
                            if (glintAngle < spread) {
                                // magnitude-space taper: the falloff band fades the
                                // flare by SAT_FLARE_TAPER_MAGS mags -> the streak
                                // brightens smoothly from nothing, flares at full
                                // peak through the core, and fades back to nothing
                                flux += fluxFlarePeak * Math.pow(10,
                                    -0.4 * SAT_FLARE_TAPER_MAGS * (1 - flareRamp(glintAngle, spread)));
                            }
                            if (flux <= 0) continue;
                            const ex = extinctionRGB(sinAlt, P.extinctionK, kAltScale, P.reddening);
                            if (flux * ex[0] < 1e-4) continue;        // red fades last
                            const pPos = prevSatPos.get(sd.number);
                            const cur = pos.clone();
                            prevSatPos.set(sd.number, cur);
                            const src = {isDir: false, pos: cur, prevPos: pPos || cur};
                            splatInterval(src, pPose, pose, t0, t, flux, ex[0], ex[1], ex[2], null);
                        }
                    }
                }

                // Aircraft/model lights: photometric, same calibration as stars.
                // (intensity × Light Brightness) is candela; illuminance E = I/d²
                // lux; apparent magnitude m = -14.2 - 2.5·log10(E); then the
                // Pogson flux vs satMag — which simplifies to flux ∝ E. A real
                // ~500 cd nav light at 15 km is mag ≈ 0 (Vega-bright); at 300 km
                // it fades into the stars. Slant-path extinction (~0.015 mag/km
                // clear air) dims the distant ones the way a camera sees them.
                for (const ln of lightNodes) {
                    if (!ln.lightVisible || !ln.light) continue;
                    const pos = ln.light.getWorldPosition(new Vector3());
                    const d = Math.max(1, pos.distanceTo(camera.position));
                    const E = (ln.light.intensity ?? 100) * LIGHT_CANDELA_PER_INTENSITY * P.lightGain / (d * d);
                    let flux = E * Math.pow(10, 0.4 * (P.satMag + 14.2));
                    if (flux > 1e7) flux = 1e7;          // 3m-away light: don't blow up the splat loop
                    const pPos = prevLightPos.get(ln.id);
                    prevLightPos.set(ln.id, pos);
                    // chromatic slant-path extinction, scaled by the mean
                    // pressure altitude of the path (plane-to-plane paths at
                    // cruise altitude run through far thinner air)
                    const pathAltM = Math.max(0, (camAltM + altitudeHAE(pos)) / 2);
                    const xl = LIGHT_EXT_MAG_PER_KM * Math.exp(-pathAltM / 8400) * (d / 1000);
                    const exG = Math.pow(10, -0.4 * xl * EXT_RGB[1]);
                    const exR = P.reddening ? Math.pow(10, -0.4 * xl * EXT_RGB[0]) : exG;
                    const exB = P.reddening ? Math.pow(10, -0.4 * xl * EXT_RGB[2]) : exG;
                    if (flux * exR < 1e-5) continue;
                    const c = ln.light.color ?? {r: 1, g: 1, b: 1};
                    const strobe = (ln.strobeEvery && ln.strobeLength)
                        ? {every: ln.strobeEvery, length: ln.strobeLength, offset: ln.strobeOffset || 0}
                        : null;
                    const src = {isDir: false, pos, prevPos: pPos || pos};
                    splatInterval(src, pPose, pose, t0, t, flux, c.r * exR, c.g * exG, c.b * exB, strobe);
                }
            }

            prevPose = pose;
            framesDone++;

            // live preview of the developing exposure (running average so far);
            // moonlight mode previews at the developed gain (raw values are
            // ~20 stops down and would preview black)
            if (previewCtx && framesDone % previewEvery === 0) {
                const previewGain = (P.moonlight && bgBoost > 1) ? bgBoost : 1;
                tonemapBufferInto(acc, 1 / framesDone, W, H, previewGain, {useACES, acesExposure}, previewCtx, previewImg);
                coverLabel.textContent = `Rendering long exposure… ${framesDone} / ${numSamples} samples`;
            }

            progress.update(framesDone);
            if (framesDone % 4 === 1) await new Promise((r) => setTimeout(r, 0));
        }

        if (acc && framesDone > 0) {
            // normalize by frames actually accumulated (early "Enough" stop included)
            const inv = 1 / framesDone;
            for (let p = 0; p < acc.length; p++) acc[p] *= inv;
            // moonlight mode: open pre-developed (EV = the calibrated boost,
            // i.e. the moonlit ground exposed like the boosted render), with
            // the slider range extended to reach it
            const evInit = (P.moonlight && bgBoost > 1) ? Math.round(Math.log2(bgBoost) * 10) / 10 : 0;
            const evMax = Math.max(10, Math.ceil(evInit) + 4);
            showResultWindow(acc, W, H, {useACES, acesExposure, evInit, evMax});
        }
    } finally {
        progress.remove();
        if (cover.parentNode) cover.parentNode.removeChild(cover);
        restoreSceneLights();
        if (theSunNode) theSunNode.moonlightMode = false;
        for (const h of hiddenSprites) h.obj.visible = h.was;
        for (const ln of lightNodes) ln.suppressBillboard = false;
        lookView.setVisible(savedVisible);
        Globals.scriptedVideoRendering = false;
        Sit.frames = savedSitFrames;
        Sit.aFrame = savedSitA;
        Sit.bFrame = savedSitB;
        par.frame = savedFrame;
        par.paused = savedPaused;
        par.time = savedTime;
        setRenderOne(true);
    }
}

// Scale the Moon's projected disk in the decoded frame so its total linear
// energy equals its catalog-magnitude flux under the star calibration —
// preserving the phase/limb texture while letting the disk burn out and trail
// like a real exposure. Never dims below the LDR rendering.
function boostMoonDisk(frameLin, W, H, planets, nightSky, camera, projElements, P, projectAt) {
    const moon = planets.planetSprites.Moon;
    if (!moon || moon.mag === undefined || !moon.equatorial || !moon.sprite) return;
    const celQ = nightSky.celestialSphere.getWorldQuaternion(new Quaternion());
    const dir = moon.equatorial.clone().normalize().applyQuaternion(celQ);
    const up = getLocalUpVector(camera.position);
    if (dir.dot(up) < -0.01) return;                       // below horizon
    const src = {isDir: true, x: dir.x, y: dir.y, z: dir.z};
    const ctr = {x: 0, y: 0};
    const qNow = camera.quaternion;
    if (!projectAt(qNow, camera.position, src, ctr)) return;
    // angular radius from the mesh scale (CPlanets: scale = tan(angDiam/2) * sphereRadius)
    const sphereR = planets.sphereRadius ?? nightSky.starField?.sphereRadius ?? 100;
    const halfAng = Math.atan2(moon.sprite.scale.x, sphereR);
    const rPx = halfAng * (projElements[5] * H / 2);
    if (rPx < 0.5 || rPx > Math.max(W, H)) return;
    const x0 = Math.max(0, Math.floor(ctr.x - rPx - 1)), x1 = Math.min(W - 1, Math.ceil(ctr.x + rPx + 1));
    const y0 = Math.max(0, Math.floor(ctr.y - rPx - 1)), y1 = Math.min(H - 1, Math.ceil(ctr.y + rPx + 1));
    if (x1 < x0 || y1 < y0) return;
    const r2 = (rPx + 1) * (rPx + 1);
    let sum = 0;
    for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
            const dx = x + 0.5 - ctr.x, dy = y + 0.5 - ctr.y;
            if (dx * dx + dy * dy > r2) continue;
            const idx = (y * W + x) * 3;
            sum += 0.2126 * frameLin[idx] + 0.7152 * frameLin[idx + 1] + 0.0722 * frameLin[idx + 2];
        }
    }
    if (sum < 1e-4) return;                                // moon occluded / not actually rendered
    const fMoon = Math.pow(10, -0.4 * (moon.mag - P.satMag)) * P.moonGain;
    const factor = fMoon / sum;
    if (factor <= 1) return;                               // never dim below the LDR render
    for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
            const dx = x + 0.5 - ctr.x, dy = y + 0.5 - ctr.y;
            if (dx * dx + dy * dy > r2) continue;
            const idx = (y * W + x) * 3;
            frameLin[idx] *= factor;
            frameLin[idx + 1] *= factor;
            frameLin[idx + 2] *= factor;
        }
    }
}

// ---------------------------------------------------------------------------
// Tone-map a linear buffer (× scale × gain) into an ImageData and blit it.
// Shared by the in-progress preview (scale = 1/framesSoFar) and the result
// window (scale = 1, gain = 2^EV).
//
// A hard clamp makes HDR streaks look unrealistic: every pixel >= 1 goes
// identical flat white. A soft highlight shoulder (linear below SHOULDER_KNEE,
// Reinhard-style rolloff above) lets values grade smoothly into white instead
// of flat-topping. (The ACES path has its own shoulder.)

const SHOULDER_KNEE = 0.7;
function softClip(x) {
    if (x <= SHOULDER_KNEE) return x;
    const t = (x - SHOULDER_KNEE) / (1 - SHOULDER_KNEE);
    return SHOULDER_KNEE + (1 - SHOULDER_KNEE) * (t / (1 + t));
}

const _tmPx = new Float32Array(3);
function tonemapBufferInto(buf, scale, W, H, gain, opts, ctx, img) {
    const d = img.data;
    const n = W * H;
    const k = scale * gain;
    for (let p = 0; p < n; p++) {
        _tmPx[0] = buf[p * 3] * k;
        _tmPx[1] = buf[p * 3 + 1] * k;
        _tmPx[2] = buf[p * 3 + 2] * k;
        if (opts.useACES) {
            acesForward(_tmPx, 0, opts.acesExposure);   // ACES has its own shoulder
        } else {
            _tmPx[0] = softClip(_tmPx[0]);
            _tmPx[1] = softClip(_tmPx[1]);
            _tmPx[2] = softClip(_tmPx[2]);
        }
        for (let c = 0; c < 3; c++) {
            const v = _tmPx[c];
            d[p * 4 + c] = Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));
        }
        d[p * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
}

// ---------------------------------------------------------------------------
// Result window: HDR float average + live EV re-tone-mapping + Save PNG

function showResultWindow(avg, W, H, opts) {
    const win = document.createElement("div");
    win.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:2147483647;" +
        "display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;" +
        "font-family:sans-serif;color:#ccc;";

    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    canvas.style.cssText = "max-width:92vw;max-height:82vh;object-fit:contain;background:#000;" +
        "border:1px solid #444;";
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(W, H);

    let ev = opts.evInit ?? 0;
    function tonemap() {
        tonemapBufferInto(avg, 1, W, H, Math.pow(2, ev), opts, ctx, img);
    }
    tonemap();

    const bar = document.createElement("div");
    bar.style.cssText = "display:flex;align-items:center;gap:14px;background:#222;padding:8px 16px;" +
        "border-radius:6px;border:1px solid #444;";
    const label = document.createElement("span");
    label.textContent = `Exposure: ${ev.toFixed(1)} EV`;
    const slider = document.createElement("input");
    slider.type = "range"; slider.min = "-6"; slider.max = String(opts.evMax ?? 10); slider.step = "0.1";
    slider.value = String(ev);
    slider.style.width = "260px";
    slider.oninput = () => {
        ev = parseFloat(slider.value);
        label.textContent = `Exposure: ${ev.toFixed(1)} EV`;
        tonemap();
    };
    const save = document.createElement("button");
    save.textContent = "Save PNG";
    save.onclick = () => {
        canvas.toBlob((blob) => {
            if (!blob) return;
            const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = `${getExportPrefix()}_longexposure_${stamp}.png`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        }, "image/png");
    };
    const close = document.createElement("button");
    close.textContent = "Close";
    close.onclick = () => { win.remove(); };

    bar.append(label, slider, save, close);
    win.append(canvas, bar);
    document.body.appendChild(win);
}
