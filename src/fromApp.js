// fromApp.js — receive a prediction handed off from the standalone Starlink Horizon
// Flare tool (tools/shf) via `?fromapp=1&...` URL params, and turn it into a
// live Sitrec situation: a night-sky sitch (satellites + flares) with a REAL-TIME
// (1×) timeline running from the first flare to the last flare, starting on the peak
// flare, a synthetic flight camera track (or a fixed ground camera raised 50 ft), and
// the look camera locked to the horizon flare region (Sun's azimuth, just above it).
//
// Two entry points, called from index.js:
//   parseFromAppParams(urlParams)  -> params object (or null if not a fromapp launch)
//   buildFromAppSitch(params)      -> a sitch object to feed new CSituation()
//   finishFromApp(params)          -> after setup: build the flight track + play

import { FileManager, Globals, NodeMan, Sit, SitchMan, TrackManager } from "./Globals.js";
import { par } from "./par.js";
import { getLocalEastVector, getLocalNorthVector, getLocalUpVector } from "./SphericalMath";
import { radians } from "./utils";
import { MISB, MISBFields } from "./MISBFields";
import { CTrackFileMISB } from "./TrackFiles/CTrackFileMISB";

const FPS = 30;
const FT_TO_M = 0.3048;
// Real-time playback, so frames = window-seconds × fps. We cover the FULL flare window
// (first flare → last flare) at 30 fps; MAX_FRAMES is only a high backstop so a
// pathologically long input (e.g. a transoceanic flight whose whole route is twilight)
// can't make an absurd timeline. Below the backstop the entire window is used; beyond
// it, the window is bounded to MAX_FRAMES centred on the peak (see framesAndStart).
const MAX_FRAMES = 432000;     // 4 hours at 30 fps — backstop only; full window used below this

// --- parse + validate the URL params -----------------------------------------
export function parseFromAppParams(urlParams) {
    if (!urlParams || urlParams.get("fromapp") !== "1") return null;
    const num = (k, d) => { const v = parseFloat(urlParams.get(k)); return Number.isFinite(v) ? v : d; };
    const lat = num("lat"), lon = num("lon");
    if (lat === undefined || lon === undefined) return null;
    const firstMs = num("firstMs", num("startMs", Date.now()));   // first flare (timeline start)
    const lastMs = num("lastMs", num("endMs", firstMs + 1800 * 1000)); // last flare (timeline end)
    return {
        mode: urlParams.get("mode") === "flight" ? "flight" : "fixed",
        lat, lon, firstMs, lastMs,
        peakMs: num("peakMs", (firstMs + lastMs) / 2),            // peak flare (start frame)
        peakAz: num("peakAz", 0),
        peakEl: num("peakEl", 8),
        dlat: num("dlat"), dlon: num("dlon"),
        cruiseAltFt: num("cruiseAltFt", 37000),
        flightStartMs: num("flightStartMs", firstMs),            // flight departure (for time->position)
        flightDurSec: num("flightDurSec", Math.max(1, (lastMs - firstMs) / 1000)),
        place: urlParams.get("place") || "",
    };
}

// Real-time timeline bounds: span [firstMs, lastMs] at 1×, but if that exceeds
// MAX_FRAMES, bound it to MAX_FRAMES centred on the peak (kept inside [first,last]).
// Returns { startMs, frames, peakFrame }.
function framesAndStart(p) {
    const fullFrames = Math.max(1, Math.round((p.lastMs - p.firstMs) / 1000 * FPS));
    if (fullFrames <= MAX_FRAMES) {
        const peakFrame = Math.round((p.peakMs - p.firstMs) / 1000 * FPS);
        return { startMs: p.firstMs, frames: fullFrames, peakFrame: clamp(peakFrame, 0, fullFrames - 1) };
    }
    // Window longer than the cap: centre MAX_FRAMES on the peak, clamped to [first,last].
    const halfMs = (MAX_FRAMES / 2) * 1000 / FPS;
    let startMs = clamp(p.peakMs - halfMs, p.firstMs, p.lastMs - MAX_FRAMES * 1000 / FPS);
    const peakFrame = Math.round((p.peakMs - startMs) / 1000 * FPS);
    return { startMs, frames: MAX_FRAMES, peakFrame: clamp(peakFrame, 0, MAX_FRAMES - 1) };
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// --- build the sitch object ---------------------------------------------------
// Base the scene on the existing "starlink" sitch (data/starlink/SitStarlink.js),
// which include_custom's the full Custom machinery — night sky, live Starlink
// satellites/flares, the camera-track switch, smoothing, and the PTZ aim — and just
// apply the app's parameters on top. expandSitData merges the include in key order,
// and a spread keeps `include_custom` first, so our overrides win over the base.
export function buildFromAppSitch(p) {
    const found = (SitchMan && SitchMan.findFirstData)
        ? SitchMan.findFirstData((s) => s.data.name === "starlink")
        : null;
    const base = found || {};
    const tl = framesAndStart(p);
    p._timeline = tl;                     // reused by finishFromApp (same params object)
    return {
        ...base,
        // Observer location + a REAL-TIME (1×) timeline from the first flare to the last.
        lat: p.lat,
        lon: p.lon,
        startTime: new Date(tl.startMs).toISOString(),
        startLive: false,                 // play the flare window, don't sit in live mode
        fps: FPS,
        frames: tl.frames,
        aFrame: 0,
        bFrame: tl.frames - 1,            // out-point = end (base "starlink" sets 3000, too short)
        simSpeed: 1,                      // 1× — real time
        // Aim the look camera at the peak flare direction (overriding the base az/el).
        ptzAngles: {
            ...(base.ptzAngles || { kind: "PTZUI", roll: 0, fov: 30, showGUI: true, gui: "camera" }),
            az: p.peakAz, el: p.peakEl,
        },
    };
}

// Great-circle interpolation (spherical slerp of the two unit vectors). t in [0,1].
function greatCircle(lat1, lon1, lat2, lon2, t) {
    const D = Math.PI / 180, R = 180 / Math.PI;
    const f1 = lat1 * D, l1 = lon1 * D, f2 = lat2 * D, l2 = lon2 * D;
    const a = [Math.cos(f1) * Math.cos(l1), Math.cos(f1) * Math.sin(l1), Math.sin(f1)];
    const b = [Math.cos(f2) * Math.cos(l2), Math.cos(f2) * Math.sin(l2), Math.sin(f2)];
    let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    dot = Math.max(-1, Math.min(1, dot));
    const w = Math.acos(dot);
    if (w < 1e-9) return { lat: lat1, lon: lon1 };
    const s1 = Math.sin((1 - t) * w) / Math.sin(w), s2 = Math.sin(t * w) / Math.sin(w);
    const x = s1 * a[0] + s2 * b[0], y = s1 * a[1] + s2 * b[1], z = s1 * a[2] + s2 * b[2];
    return { lat: Math.atan2(z, Math.hypot(x, y)) * R, lon: Math.atan2(y, x) * R };
}

// Frame the main (3D overview) view: put the camera UP IN SPACE and look DOWN at the
// look-camera position (the observer/aircraft, at ECEF `O`) at about 45°, so the Earth's
// limb and the Starlink shell wrapping it fill the frame with the observer in the middle.
// The camera sits on the anti-Sun side, so the view looks down past the observer toward
// the flare/Sun azimuth.
function frameMainView(O, peakAz) {
    if (!O) return;
    const mainCam = NodeMan.get("mainCamera", false);
    if (!mainCam || !mainCam.camera) return;
    const up = getLocalUpVector(O);
    const north = getLocalNorthVector(O);
    const east = getLocalEastVector(O);
    const azR = radians(peakAz);
    // Horizontal unit vector toward the flare/Sun azimuth (compass: 0=N, 90=E).
    const flareDir = north.clone().multiplyScalar(Math.cos(azR))
        .add(east.clone().multiplyScalar(Math.sin(azR))).normalize();
    // Offset from O = range·(cos45·(anti-flare horizontal) + sin45·up). The line of sight
    // back to O then has equal horizontal and vertical parts → a 45° look-down.
    const range = 6000 * 1000;          // metres from the observer (~6000 km — Earth reads as a disk with the shell around its limb)
    const a = radians(45);
    const dir = flareDir.clone().multiplyScalar(-Math.cos(a))
        .add(up.clone().multiplyScalar(Math.sin(a))).normalize();
    const camPos = O.clone().add(dir.multiplyScalar(range));
    mainCam.camera.position.copy(camPos);
    mainCam.camera.up.copy(up);
    mainCam.camera.lookAt(O);
    mainCam.camera.updateMatrixWorld(true);
    if (typeof mainCam.syncUIPosition === "function") mainCam.syncUIPosition();
}

// --- build the synthetic flight track (shared by live launch + reload) --------
// Builds the origin -> destination flight as a MISB array and loads it through the
// NORMAL track pathway (FileManager.add + TrackManager.addTracks), so it becomes a real
// CNodeTrackFromMISB ("Track_Flight"), appears in the Contents menu, and wires into
// cameraTrackSwitch — exactly as a dropped KML/MISB flight would. No special-case node.
//
// The generated MISB is fully deterministic from a handful of scalar params, so we:
//   * flag the FileManager entry `skipSerialization` (never rehosted/embedded on save), and
//   * stash the params on `Sit.appFlight`, which a custom-sitch save persists (~8 numbers)
//     and CustomManagerSerialize regenerates from on reload by calling this same function.
// Returns the selected track node (for framing the main view), or null.
export async function buildAppFlightTrack(p) {
    if (!(p.mode === "flight" && Number.isFinite(p.dlat) && Number.isFinite(p.dlon))) return null;

    const filename = "App Flight.kml";
    // Legacy saves may still embed the file and load it before we run — don't double-create.
    if (FileManager.list[filename]) {
        const sw = NodeMan.get("cameraTrackSwitch", false);
        const existing = sw && Object.keys(sw.inputs).find((k) => /Flight/.test(k));
        return existing ? sw.inputs[existing] : null;
    }

    const flightDurMs = Math.max(1000, p.flightDurSec * 1000);
    const cruiseAltM = p.cruiseAltFt * FT_TO_M;
    const climbF = 0.12, descF = 0.12;                 // climb-out / descent fraction
    const N = clamp(Math.round(p.flightDurSec / 30), 50, 1200);   // ~one sample / 30 s
    const misb = [];
    for (let i = 0; i < N; i++) {
        const ft = N > 1 ? i / (N - 1) : 0;            // progress along the flight, 0..1
        const gc = greatCircle(p.lat, p.lon, p.dlat, p.dlon, ft);
        let alt;
        if (ft < climbF) alt = cruiseAltM * (ft / climbF);
        else if (ft > 1 - descF) alt = cruiseAltM * ((1 - ft) / descF);
        else alt = cruiseAltM;
        const row = new Array(MISBFields).fill(null);
        row[MISB.UnixTimeStamp] = (p.flightStartMs + ft * flightDurMs) * 1000;  // microseconds
        row[MISB.SensorLatitude] = gc.lat;
        row[MISB.SensorLongitude] = gc.lon;
        row[MISB.SensorTrueAltitude] = alt;            // metres MSL
        row[MISB.PlatformTailNumber] = "Flight";
        misb.push(row);
    }

    // Register as a track file and run the standard track-loading pathway.
    FileManager.add(filename, new CTrackFileMISB(misb), misb);
    const info = FileManager.getInfo(filename);
    info.filename = filename;
    info.dataType = "MISB";
    // Route this track through CNodeLazyMISBFlightTrack (sparse, lazily
    // interpolated) instead of a baked per-frame array. Not serialized — the
    // file is dropped via skipSerialization and this flag is re-set on reload
    // when CustomManagerSerialize re-invokes buildAppFlightTrack.
    info.isAppFlight = true;
    // Regenerable from the params below, so never rehost/serialize the generated file:
    // skipSerialization drops it from both rehost paths and the loadedFiles save loop.
    info.skipSerialization = true;
    Sit.appFlight = {
        mode: p.mode, lat: p.lat, lon: p.lon, dlat: p.dlat, dlon: p.dlon,
        cruiseAltFt: p.cruiseAltFt, flightStartMs: p.flightStartMs, flightDurSec: p.flightDurSec,
    };

    // Keep our flare-window timeline (sitchEstablished suppresses "sync start time to
    // track"); we then select the new track into the camera switch ourselves (the
    // same thing the dropTarget does when the sitch isn't already established).
    Globals.sitchEstablished = true;
    const sw = NodeMan.get("cameraTrackSwitch", false);
    const before = sw ? new Set(Object.keys(sw.inputs)) : new Set();
    await TrackManager.addTracks([filename]);
    if (sw) {
        const added = Object.keys(sw.inputs).find((k) => !before.has(k));
        if (added) {
            sw.selectOption(added);
            const trackNode = sw.inputs[added];
            if (trackNode && typeof trackNode.p === "function") return trackNode;
        }
    }
    return null;
}

// --- lightweight flight scene: skip the unused video-analysis machinery -------
// A Starlink-from-plane scene needs only the (lazy) flight camera + satellites +
// the look-camera aim. The Custom graph it inherits also builds a target track,
// traverse, LOS-to-target, and altitude/distance measurement labels — none used
// here, yet each pins an expensive per-frame "smoothed" track / munge that re-bakes
// on every cascade (e.g. time-menu edits). Hiding their display leaves lets the
// engine's existing checkDisplayOutputs gate skip those bakes. We hide, not delete,
// so nothing that references these node ids breaks and a real dropped track would
// restore them. Gated on Sit.appFlight; shared by live launch + saved-sitch reload.
export function applyFlightLightweightGating() {
    if (!Sit.appFlight) return;
    for (const id of ["traverseDisplayTrack", "altitudeLabel2", "distanceLabel",
                      "traverseObject", "moveTargetAlongPath", "orientTarget"]) {
        NodeMan.get(id, false)?.show?.(false);
    }
}

// --- after the sitch is set up: place the camera + start playback -------------
// Uses the Custom machinery already built by the starlink sitch: a `cameraTrackSwitch`
// feeding (smooth -> trackPosition) into the look camera, with `ptzAngles` aiming it.
export async function finishFromApp(p) {
    const tl = p._timeline || framesAndStart(p);
    let observerECEF = null;   // look-camera position at the peak frame, for framing the main view

    if (p.mode === "flight" && Number.isFinite(p.dlat) && Number.isFinite(p.dlon)) {
        // Build the synthetic flight track through the normal pathway. This is shared
        // verbatim with the reload path (CustomManagerSerialize calls the same function),
        // so a saved sitch regenerates an identical track from the persisted params.
        const trackNode = await buildAppFlightTrack(p);
        if (trackNode && typeof trackNode.p === "function") observerECEF = trackNode.p(tl.peakFrame);
    } else {
        // Ground-based observer, raised 50 ft above ground (the default camera track
        // is the fixed camera position).
        const cam = NodeMan.get("fixedCameraPosition", false);
        if (cam) {
            cam.setLLA(p.lat, p.lon, 50 * FT_TO_M);
            cam.agl = true;
            if (typeof cam.recalculateCascade === "function") cam.recalculateCascade();
            if (typeof cam.p === "function") observerECEF = cam.p(0);
        }
    }

    // Aim the look camera with the "Horizon Flare Region" lock — it points at the
    // Sun's azimuth just above the horizon (where horizon flares appear) and follows
    // the Sun along the horizon as the timeline advances.
    const los = NodeMan.get("CameraLOSController", false);
    if (los && los.inputs["Horizon Flare Region"]) los.selectOption("Horizon Flare Region");

    // Turn off the red Line-Of-Sight display (no traverse target here, it just clutters).
    const losDisplay = NodeMan.get("displayLOS", false);
    if (losDisplay && typeof losDisplay.show === "function") losDisplay.show(false);

    // Skip the unused target/traverse/measurement machinery (keeps time-menu edits light).
    applyFlightLightweightGating();

    // Frame the main 3D view on the look camera + the flare band/region.
    frameMainView(observerECEF, p.peakAz);

    // Start on the peak flare and play forward at real time (1×).
    par.playbackSpeed = 1;
    par.frame = tl.peakFrame;
    par.paused = false;
}
