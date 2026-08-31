// Client-side Sitrec API with callable functions and documentation
import {
    CustomManager,
    FileManager,
    GlobalDateTimeNode,
    Globals,
    guiMenus,
    markSitchDirty,
    NodeMan,
    setNewSitchObject,
    setRenderOne,
    Sit,
    SitchMan,
    Synth3DManager,
    TrackManager,
    UndoManager,
    Units,
    withTestUser,
} from "./Globals";
import {isLocal, isServerless, SITREC_SERVER} from "./configUtils";
import {showChoice, showError} from "./showError";
import GUI from "./js/lil-gui.esm";
import {Vector3} from "three";
import {ModelFiles, CNode3DObject} from "./nodes/CNode3DObject";
import {
    CHAT_FENCED_RESULT_FIELDS, fenceUntrustedText, refuseExternalURLParams, sanitizeLabelForPrompt,
} from "./PromptSafety";
import {getSitchSourceLabel, isSitchExternal, trustCurrentSitch} from "./SitchProvenance";
import {LLAToECEF, ECEFToLLAVD_radii} from "./LLA-ECEF-ENU";
import {getLocalUpVector, altitudeHAE} from "./SphericalMath";
import {Raycaster} from "three";
import {raycastLocalGround} from "./raycastGround";
import {meanSeaLevelOffset} from "./EGM96Geoid";
import {par} from "./par";
import {ViewMan} from "./CViewManager";
import {groundUnderCanvasPoint} from "./FitSurfacePick";
import {renderedRect} from "./ViewUtils";
import {areControlsHidden, toggleControlsVisibility} from "./PageStructure";
import {closeFullscreen, isFullscreen, openFullscreen} from "./utils";
import {forceUpdateUIText} from "./nodes/CNodeViewUI";

// Flexible RA parser: accepts decimal hours, "3h47m10s", "03:47:10", "3h47m", "3h 47m 10s", etc.
function parseRA(input) {
    if (input == null) return null;
    const n = Number(input);
    if (!isNaN(n) && isFinite(n)) return n; // decimal hours
    const s = String(input).trim();
    // sexagesimal: h/m/s or colon-separated
    const m = s.match(/^(\d+(?:\.\d+)?)\s*[h:]\s*(\d+(?:\.\d+)?)?\s*[m:]?\s*(\d+(?:\.\d+)?)?\s*s?$/i);
    if (m) {
        const h = parseFloat(m[1]);
        const min = m[2] ? parseFloat(m[2]) : 0;
        const sec = m[3] ? parseFloat(m[3]) : 0;
        return h + min / 60 + sec / 3600;
    }
    return null;
}

// Flexible Dec parser: accepts decimal degrees, "+24d07m00s", "24:07:00", "-24d07m", etc.
function parseDec(input) {
    if (input == null) return null;
    const n = Number(input);
    if (!isNaN(n) && isFinite(n)) return n; // decimal degrees
    const s = String(input).trim();
    // sexagesimal: d/m/s or colon-separated, optional leading sign
    const m = s.match(/^([+-]?)\s*(\d+(?:\.\d+)?)\s*[d°:]\s*(\d+(?:\.\d+)?)?\s*['m:]?\s*(\d+(?:\.\d+)?)?\s*["s]?$/i);
    if (m) {
        const sign = m[1] === "-" ? -1 : 1;
        const deg = parseFloat(m[2]);
        const min = m[3] ? parseFloat(m[3]) : 0;
        const sec = m[4] ? parseFloat(m[4]) : 0;
        return sign * (deg + min / 60 + sec / 3600);
    }
    return null;
}

// Callers that are an AI agent rather than a person: "chat" is the in-app chatbot,
// "webmcp" is a model driving the open page through browser site tools, and "mcp" is
// an external agent driving the page through the trusted SitrecBridge extension.
// Everything else ("ui") is a person clicking something, or Sitrec calling itself.
//
// The distinction decides where a failure goes. An agent asking for something that
// does not exist has made a correctable mistake, so the details must travel back to
// it in the return value. A modal is the wrong destination twice over: the agent
// cannot read it, and the user gets stopped by an error about a call they did not
// make and cannot fix. See handleAPICall.
const AGENT_SOURCES = new Set(["chat", "mcp", "webmcp"]);

// These callers are controlled by a model whose context may contain attacker-authored
// sitch text. Keep this distinct from AGENT_SOURCES: SitrecBridge also needs agent-friendly
// error routing, but it retains its installed/developer trust model.
const UNTRUSTED_MODEL_SOURCES = new Set(["chat", "webmcp"]);

// A control address ("video:Annotate/Edit Mode") reduced to lower-case words, for the
// near-miss scoring in _suggestControls.
function tokenizeControlAddress(address) {
    return String(address ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

// Two address words count as the same word if one is a prefix of the other, with a
// three-character floor. Deliberately NOT a substring test: "xyzzyphlogiston" contains
// both "log" and "gis", so substrings recommended "Export Debug Log" and a GIS doc page
// for a word that matches nothing at all.
function nearWord(a, b) {
    return a === b
        || (a.length >= 3 && b.startsWith(a))
        || (b.length >= 3 && a.startsWith(b));
}

// Calls that do not change the sitch's serialized state. Used for two different
// questions, which mostly coincide but not entirely — hence the second set below.
const TRANSIENT_CALLS = new Set([
    "getCameraLLA",
    "setCameraAltitude",
    "setDateTime",
    "getCurrentDateTime",
    "pointCameraAtRaDec",
    "pointCameraAtNamedObject",
    "lockCameraOnObject",
    "lockCameraOnRaDec",
    "unlockCamera",
    "getFrame",
    "setFrame",
    "getMenuValue",
    "listMenus",
    "listMenuControls",
    "listObjectFolders",
    "listAvailableModels",
    "listAvailableGeometries",
    "listSynthElements",
    "getSynthElement",
    "gotoLLA",
    "play",
    "pause",
    "toggleDebug",
    "getNearbyWeatherBalloons",
    "compareSondeTrajectory",
    "pickWorldPoint",
    "fitPointsStatus",
    "listViews",
    "showView",
    "hideView",
    "setViewPosition",
    "setLayout",
    "hideMenu",
    "showMenu",
    "hideTimeline",
    "showTimeline",
    "hideChrome",
    "showChrome",
    "toggleFullscreen",
    "listLayoutTemplates",
    "getNotes",
    "listSitches",
    "getShareLink",
    "getSitchState",
    "exportSitchState",
]);

// The same list read as a SECURITY question: "is this safe to run, unattended, on behalf
// of a sitch whose contents a stranger wrote?" TRANSIENT_CALLS was written to answer "does
// this dirty the sitch?", and the two questions diverge on exactly one entry.
//
// getShareLink is transient for serialization — it changes nothing locally — but it
// UPLOADS the current state and returns a public link. Under an untrusted sitch that is
// the propagation step: steer the model into sharing, and the victim's own browser mints
// the artifact the attacker wanted. It is therefore treated as a write.
//
// The remaining entries were audited against the same question and stand: they are reads,
// or view changes (camera, time, layout, playback) that are recoverable and carry nothing
// off the machine. Gating those would tax the exact workflow this is meant to protect —
// reading a shared recreation and asking the assistant about it.
export const CHAT_READ_ONLY_CALLS = new Set(
    [...TRANSIENT_CALLS].filter(fn => fn !== "getShareLink")
);

// Calls whose return value has information the model must read before it can answer the
// user. This is deliberately separate from both TRANSIENT_CALLS (serialization) and
// CHAT_READ_ONLY_CALLS (prompt-injection security): play, gotoLLA and pointCamera... are
// safe/transient ACTIONS, so paying for another provider turn merely to say "Done" wastes
// money. Conversely getShareLink changes nothing locally but its returned URL must reach
// the model. Keep this explicit so additions are auditable rather than guessed from a name.
export const CHAT_MODEL_RESULT_CALLS = new Set([
    "getGroundAltitude",
    "pickWorldPoint",
    "fitPointsStatus",
    "fitPointsSolve",
    "getCameraLLA",
    "getCurrentDateTime",
    "getFrame",
    "getCurrentSimTime",
    "getRealTime",
    "listCelestialObjects",
    "listSynthElements",
    "getSynthElement",
    "findSatellite",
    "getMenuValue",
    "listMenus",
    "listMenuControls",
    "listObjectFolders",
    "listAvailableModels",
    "listAvailableGeometries",
    "listViews",
    "listLayoutTemplates",
    "listTracks",
    "getTrackPosition",
    "listLoadedFiles",
    "getNotes",
    "getShareLink",
    "listSitches",
    "getSitchState",
    "exportSitchState",
    "getNearbyWeatherBalloons",
    "compareSondeTrajectory",
]);

class CSitrecAPI {
    constructor() {

        this.debug = isLocal;

        this.docs = {
            gotoLLA: "Move the camera to the location specified by Lat/Lon/Alt (Alt optional, defaults to 0). Parameters: lat (float), lon (float), alt (float, optional).",
            setDateTime: "Set the date and time for the simulation. Parameter: dateTime (ISO 8601 string).",
        };

        this.api = {
            gotoLLA: {
                doc: "Move the camera to the specified latitude, longitude, and altitude.",
                params: {
                    lat: "Latitude in degrees (float)",
                    lon: "Longitude in degrees (float)",
                    alt: "Altitude in meters (float, optional, defaults to 0)"
                },
                fn: (v) => {
                    const camera = NodeMan.get("fixedCameraPosition");
                    if (!camera) return { success: false, error: "fixedCameraPosition node not found" };
                    // Without this the missing value reaches gotoLLA as undefined and NaN
                    // propagates through the camera track and out into the render loop, so
                    // the caller gets a broken scene and no idea why. Say what is missing.
                    if (!Number.isFinite(v.lat) || !Number.isFinite(v.lon)) {
                        return { success: false, error: "lat and lon are required, in degrees" };
                    }
                    camera.gotoLLA(v.lat, v.lon, v.alt)
                    return { success: true };
                }
            },

            setCameraAltitude: {
                doc: "Set the camera altitude while keeping current lat/lon.",
                params: {
                    alt: "Altitude in meters (float)"
                },
                fn: (v) => {
                    const camera = NodeMan.get("fixedCameraPosition");
                    if (!camera) return { success: false, error: "fixedCameraPosition node not found" };
                    const lla = camera._LLA;
                    camera.setLLA(lla[0], lla[1], v.alt);
                    return { success: true, newAltitude: v.alt };
                }
            },

            getGroundAltitude: {
                doc: "Ground altitude at a lat/lon, taken from the Google 3D building tiles where"
                    + " they cover the point and the terrain elevation map elsewhere. Prefer this to"
                    + " a photograph's EXIF altitude, which cannot be trusted: some cameras write"
                    + " height above the ELLIPSOID while labelling it 'above sea level', so the same"
                    + " number means two things ~40 m apart depending on the camera.",
                params: {
                    lat: "Latitude in degrees (float, optional — defaults to the camera's)",
                    lon: "Longitude in degrees (float, optional — defaults to the camera's)"
                },
                fn: (v) => this.groundAltitudeAt(v?.lat, v?.lon)
            },

            // ---- Fit Camera to Points -------------------------------------------------
            //
            // Programmatic access to the "Fit Camera to Points" tool (CNodeFitCameraPoints),
            // added so AI agents driving Sitrec over MCP can place control points without
            // synthesising mouse gestures. Workflow and conventions: docs/FitPointsAPI.md.

            pickWorldPoint: {
                doc: "Where a pixel of a 3D view lands in the world. Casts a ray from the named"
                    + " view's camera through the pixel and returns the surface point it hits as"
                    + " lat/lon/altitude — against the 3D building tiles by default, so picking a"
                    + " rooftop returns the roof, not the street under it, and against the"
                    + " scene's own 3D objects, so picking an aircraft returns the aircraft"
                    + " rather than the ground beyond it. fx/fy are fractions"
                    + " (0-1) across the view's rendered image, so they can be read straight off"
                    + " a screenshot of that view: the centre is fx 0.5, fy 0.5.",
                params: {
                    view: "View to pick in: 'mainView' or 'lookView' (string, optional, default 'mainView')",
                    fx: "Horizontal fraction 0-1 across the view (float; give fx/fy or cx/cy)",
                    fy: "Vertical fraction 0-1 down the view (float)",
                    cx: "Canvas x in pixels, alternative to fx (float, optional)",
                    cy: "Canvas y in pixels, alternative to fy (float, optional)",
                    useTiles: "Prefer the 3D tile geometry (roofs, walls, trees) over the bare elevation surface (bool, optional, default true)",
                    useObjects: "Also hit the scene's own 3D objects — aircraft, balloons, spheres — taking whichever the ray reaches first (bool, optional, default true)",
                },
                fn: (v) => {
                    const viewName = v?.view ?? "mainView";
                    const view = ViewMan.get(viewName, false);
                    if (!view || !view.camera) return {success: false, error: `no 3D view named '${viewName}'`};
                    let cx = v?.cx, cy = v?.cy;
                    if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
                        if (!Number.isFinite(v?.fx) || !Number.isFinite(v?.fy)) {
                            return {success: false, error: "give fx/fy fractions (0-1) or cx/cy canvas pixels"};
                        }
                        const r = renderedRect(view, view.widthPx, view.heightPx);
                        cx = r.x + v.fx * r.w;
                        cy = r.y + v.fy * r.h;
                    }
                    const useTiles = v?.useTiles ?? true;
                    const useObjects = v?.useObjects ?? true;
                    const world = groundUnderCanvasPoint(view, cx, cy, useTiles, useObjects);
                    if (!world) return {success: false, error: "the ray hit no surface (was that pixel sky?)"};
                    const lla = ECEFToLLAVD_radii(world);
                    const geoid = meanSeaLevelOffset(lla.x, lla.y);
                    return {success: true, lat: lla.x, lon: lla.y,
                        altHAE: lla.z, altMSL: lla.z - geoid,
                        canvas: [cx, cy], view: viewName};
                }
            },

            fitPointsStatus: {
                doc: "State of the 'Fit Camera to Points' tool: settings, the control points"
                    + " (each pairs a video pixel with a world position), solve status, residual,"
                    + " and the current look camera. Video pixel coordinates are in the ORIGINAL"
                    + " video frame, whose size is videoSize [width, height].",
                fn: () => {
                    const fit = this._fitNode();
                    if (!fit) return {success: false, error: "no fitCameraPoints node (needs a custom sitch with a video)"};
                    return {success: true, ...this._fitSummary(fit)};
                }
            },

            fitPointsConfigure: {
                doc: "Configure the 'Fit Camera to Points' tool. All parameters optional; returns"
                    + " the resulting state (as fitPointsStatus). Enable the tool before solving.",
                params: {
                    enabled: "Turn the tool on/off (bool, optional)",
                    useTiles: "Place points against the 3D building geometry rather than the elevation surface (bool, optional)",
                    useObjects: "Place points on the scene's own 3D objects (aircraft, balloons, spheres) too, taking whichever the ray reaches first. The camera's own marker is never hit (bool, optional)",
                    autoFit: "Re-solve the camera after every point change (bool, optional)",
                    syncLookCamera: "Point the look view's controls at the video: its wheel and left drag zoom and pan the VIDEO instead of moving the camera. Does not touch Match Video Aspect. A fit turns this on (bool, optional)",
                    lockPosition: "Keep the camera position, solve pointing/FOV only (bool, optional)",
                    lockFOV: "Keep the current field of view (bool, optional)",
                    lockRoll: "Hold camera roll at its current value (bool, optional)",
                    method: "Solver: 'direct' or 'homography' (string, optional)",
                },
                fn: (v) => {
                    const fit = this._fitNode();
                    if (!fit) return {success: false, error: "no fitCameraPoints node (needs a custom sitch with a video)"};
                    if (typeof v?.enabled === "boolean") fit.setEnabled(v.enabled);
                    if (typeof v?.useTiles === "boolean") fit.useTiles = v.useTiles;
                    if (typeof v?.useObjects === "boolean") fit.useObjects = v.useObjects;
                    if (typeof v?.autoFit === "boolean") fit.autoFit = v.autoFit;
                    if (typeof v?.syncLookCamera === "boolean") fit.setSyncLookCamera(v.syncLookCamera);
                    if (typeof v?.lockPosition === "boolean") fit.lockPosition = v.lockPosition;
                    if (typeof v?.lockFOV === "boolean") fit.lockFOV = v.lockFOV;
                    if (typeof v?.lockRoll === "boolean") fit.lockRoll = v.lockRoll;
                    if (v?.method === "direct" || v?.method === "homography") {
                        fit.fitMethod = v.method;
                        fit.syncMethodControls();
                    }
                    setRenderOne(true);
                    return {success: true, ...this._fitSummary(fit)};
                }
            },

            fitPointsAdd: {
                doc: "Add one control point pair to 'Fit Camera to Points': a pixel on the video"
                    + " (vx/vy in original video pixels, or fx/fy as 0-1 fractions of the video"
                    + " frame) plus, optionally, the real-world position that pixel shows. Without"
                    + " lat/lon the world point just seeds on the surface under the current"
                    + " camera's ray and carries no information until moved. Altitude: pass alt"
                    + " (metres above the ellipsoid, as pickWorldPoint returns) or altMSL, or omit"
                    + " both for the surface height at lat/lon. Enables the tool if it is off.",
                params: {
                    vx: "Video x in original video pixels (float; give vx/vy or fx/fy)",
                    vy: "Video y in original video pixels (float)",
                    fx: "Video x as a fraction 0-1 of the video width (float, optional)",
                    fy: "Video y as a fraction 0-1 of the video height (float, optional)",
                    lat: "Latitude of the real-world feature (float, optional)",
                    lon: "Longitude of the real-world feature (float, optional)",
                    alt: "Altitude of the feature in metres above the ellipsoid (float, optional)",
                    altMSL: "Altitude of the feature in metres above sea level (float, optional)",
                },
                fn: (v) => {
                    const fit = this._fitNode();
                    if (!fit) return {success: false, error: "no fitCameraPoints node (needs a custom sitch with a video)"};
                    if (!fit.enabled) fit.setEnabled(true);
                    const size = fit.videoSize;
                    if (!size) return {success: false, error: "no video loaded"};
                    // Points own the frame they were placed on, exactly as in the UI: the first
                    // point adopts the current frame, and after that mixing frames would
                    // serialize observations no single camera can satisfy.
                    if (fit.points.length === 0) fit.fitFrame = Math.round(par.frame);
                    else if (!fit.onCorrectFrame()) return this._fitWrongFrame(fit);
                    let vx = v?.vx, vy = v?.vy;
                    if (!Number.isFinite(vx) || !Number.isFinite(vy)) {
                        if (!Number.isFinite(v?.fx) || !Number.isFinite(v?.fy)) {
                            return {success: false, error: "give vx/vy pixels or fx/fy fractions (0-1)"};
                        }
                        vx = v.fx * size[0];
                        vy = v.fy * size[1];
                    }
                    const world = this._fitResolveWorld(v);
                    if (world?.error) return world;
                    let point = null;
                    fit.withUndo("Add camera fit point", () => {
                        // The world position goes INTO the add, not on afterwards: the seeds
                        // the add pushes into the other keyframes are projections of the world
                        // position, and they must describe the caller's landmark, not a surface
                        // guess that was about to be discarded.
                        point = fit.addPointAtVideo(vx, vy, world);
                        if (point) fit.requestFit();
                    });
                    if (!point) return {success: false, error: "could not add the point (no video or no look camera)"};
                    return {success: true, point: this._fitPointOut(point),
                        status: fit.status, residual: fit.residual};
                }
            },

            fitPointsMove: {
                doc: "Move either half of an existing fit point pair: the video pixel (vx/vy in"
                    + " original video pixels) and/or the world position (lat/lon with alt or"
                    + " altMSL, as in fitPointsAdd). Re-solves if 'Fit on Change' is on.",
                params: {
                    id: "Point id from fitPointsAdd or fitPointsStatus (integer)",
                    vx: "New video x in original video pixels (float, optional)",
                    vy: "New video y in original video pixels (float, optional)",
                    lat: "New latitude (float, optional, needs lon)",
                    lon: "New longitude (float, optional, needs lat)",
                    alt: "New altitude in metres above the ellipsoid (float, optional)",
                    altMSL: "New altitude in metres above sea level (float, optional)",
                },
                fn: (v) => {
                    const fit = this._fitNode();
                    if (!fit) return {success: false, error: "no fitCameraPoints node (needs a custom sitch with a video)"};
                    const p = fit.points.find((q) => q.id === v?.id);
                    if (!p) return {success: false, error: `no fit point with id ${v?.id}`};
                    if (!fit.onCorrectFrame()) return this._fitWrongFrame(fit);
                    let world = this._fitResolveWorld(v);
                    if (world?.error) return world;
                    if (!world && (Number.isFinite(v?.alt) || Number.isFinite(v?.altMSL))) {
                        // Altitude-only change, at the point's own lat/lon.
                        world = {lat: p.lat, lon: p.lon, alt: Number.isFinite(v?.alt)
                            ? v.alt : v.altMSL + meanSeaLevelOffset(p.lat, p.lon)};
                    }
                    const movedPixel = Number.isFinite(v?.vx) || Number.isFinite(v?.vy);
                    fit.withUndo("Move camera fit point", () => {
                        if (Number.isFinite(v?.vx)) p.vx = v.vx;
                        if (Number.isFinite(v?.vy)) p.vy = v.vy;
                        // The caller has stated where this landmark is on this frame, exactly
                        // as a hand drag would — the pixel stops being a seed.
                        if (movedPixel) p.seeded = false;
                        if (world) Object.assign(p, world);
                        // Same lifecycle as the UI edits: a pixel edit stales this keyframe's
                        // solution, a world edit stales every keyframe's, and the refits that
                        // follow re-earn what they can.
                        if (movedPixel || world) {
                            fit.invalidateKeyframes(world ? "all" : "active");
                        }
                        fit.requestFit();
                        if (world && fit.autoFit) fit.refitOtherKeyframes();
                    });
                    setRenderOne(true);
                    return {success: true, point: this._fitPointOut(p),
                        status: fit.status, residual: fit.residual};
                }
            },

            fitPointsRemove: {
                doc: "Delete one 'Fit Camera to Points' control point by id.",
                params: {
                    id: "Point id from fitPointsAdd or fitPointsStatus (integer)",
                },
                fn: (v) => {
                    const fit = this._fitNode();
                    if (!fit) return {success: false, error: "no fitCameraPoints node (needs a custom sitch with a video)"};
                    const p = fit.points.find((q) => q.id === v?.id);
                    if (!p) return {success: false, error: `no fit point with id ${v?.id}`};
                    fit.removePoint(p.id);
                    return {success: true, remaining: fit.points.length};
                }
            },

            fitPointsSolve: {
                doc: "Solve the camera from the current fit points (the 'Fit Now' button) and"
                    + " report the result: status, RMS residual in original video pixels,"
                    + " observability, and the camera the fit produced. A solve only applies if"
                    + " it beats the camera it started from — 'Rejected' in the status means the"
                    + " camera was left alone. Points can only be solved on the frame they were"
                    + " placed on: off it, the status says which frame to go to and nothing is"
                    + " changed. Free Look Camera also blocks a solve and says so in the status,"
                    + " because it suspends the camera sources a fit writes to, so the camera"
                    + " could not move; switch it off first with setMenuValue {menu: 'camera',"
                    + " path: 'Camera Tweaks/Free Look Camera', value: false}.",
                fn: () => {
                    const fit = this._fitNode();
                    if (!fit) return {success: false, error: "no fitCameraPoints node (needs a custom sitch with a video)"};
                    if (!fit.enabled) return {success: false, error: "fit tool is off — call fitPointsConfigure {enabled: true} first"};
                    // No frame-jump prompt: there is nobody here to answer it. Off a fit
                    // keyframe this refuses, and says so in the returned status.
                    fit.fitNow(false);
                    return {success: true, ...this._fitSummary(fit)};
                }
            },

            setCameraToEyeLevel: {
                doc: "Put the camera at eye height above the ground at its current lat/lon, using"
                    + " the 3D tile surface where available. This is how to place an observer for a"
                    + " photograph taken from the ground or a low structure — it needs only the GPS"
                    + " position, which is reliable, and never the GPS altitude, which is not.",
                params: {
                    eyeHeight: "Metres above the ground (float, optional, default 1.6 — standing eye height)"
                },
                fn: (v) => {
                    const camera = NodeMan.get("fixedCameraPosition", false);
                    if (!camera) return {success: false, error: "fixedCameraPosition node not found"};
                    const eye = Number.isFinite(v?.eyeHeight) ? v.eyeHeight : 1.6;
                    const lla = camera._LLA;
                    const ground = this.groundAltitudeAt(lla[0], lla[1]);
                    if (!ground.success) return ground;
                    // setLLA takes MSL, which is what groundAltitudeAt reports as altMSL.
                    const altMSL = ground.altMSL + eye;
                    camera.setLLA(lla[0], lla[1], altMSL);
                    setRenderOne(true);
                    return {
                        success: true, lat: lla[0], lon: lla[1],
                        groundAltMSL: ground.altMSL, groundAltHAE: ground.altHAE,
                        eyeHeight: eye, altMSL, source: ground.source,
                    };
                }
            },

            getCameraLLA: {
                doc: "Get the current camera latitude, longitude, and altitude.",
                fn: () => {
                    const camera = NodeMan.get("fixedCameraPosition");
                    if (!camera) return { success: false, error: "fixedCameraPosition node not found" };
                    const lla = camera._LLA;
                    return { lat: lla[0], lon: lla[1], alt: lla[2] };
                }
            },

            setDateTime: {
                doc: "Set the date and time for the simulation.",
                params: {
                    dateTime: "ISO 8601 date-time string with Z or timezone offset (e.g. '2023-10-01T12:00:00+02:00')"
                },
                fn: (v) => {
                    const dateTime = new Date(v.dateTime);
                    if (isNaN(dateTime.getTime())) {
                        return { success: false, error: "Invalid date-time format: " + v.dateTime };
                    }
                    GlobalDateTimeNode.setStartDateTime(v.dateTime);
                    // Chatbot-set date establishes the slider reset target.
                    GlobalDateTimeNode.establishDateTimeDefaults();
                    return { success: true, dateTime: v.dateTime };
                }
            },

            getCurrentDateTime: {
                doc: "Get the user's CURRENT REAL-WORLD ('wall-clock') date and time, including their local timezone offset. This is NOT the simulation time. Call this whenever a request depends on the actual present moment (e.g. 'what's overhead right now', 'tonight', 'in an hour'), or when you need the user's local timezone. The current SIMULATION date/time is given separately in the system prompt.",
                fn: () => {
                    const now = new Date();
                    return {
                        // ISO 8601 with the user's timezone offset, e.g. 2026-06-25T14:30:00-07:00
                        dateTime: GlobalDateTimeNode.timeWithTimeZone(now),
                        timezoneOffsetHours: GlobalDateTimeNode.getTimeZoneOffset(),
                        note: "Real-world current date/time. Distinct from the simulation time.",
                    };
                }
            },

            pointCameraAtRaDec: {
                doc: "Set the camera orientation (one-shot, no tracking) based on Right Ascension and Declination. Use for looking at stars and other fixed sky objects (not planets or the Sun). RA can be decimal hours (e.g. 3.79) or sexagesimal ('3h47m' or '03:47:00'). Dec can be decimal degrees (e.g. 24.12) or sexagesimal ('+24d07m' or '24:07:00').",
                params: {
                    ra: "Right Ascension — decimal hours or sexagesimal string (e.g. 5.92 or '5h55m')",
                    dec: "Declination — decimal degrees or sexagesimal string (e.g. 7.41 or '+7d24m')",
                },
                fn: (v) => {
                    const camera = NodeMan.get("lookCamera");
                    if (!camera) return { success: false, error: "lookCamera node not found" };
                    const ra = parseRA(v.ra);
                    const dec = parseDec(v.dec);
                    if (ra === null) return { success: false, error: `Could not parse RA '${v.ra}'. Use decimal hours (e.g. 3.79) or sexagesimal (e.g. '3h47m10s').` };
                    if (dec === null) return { success: false, error: `Could not parse Dec '${v.dec}'. Use decimal degrees (e.g. 24.12) or sexagesimal (e.g. '+24d07m00s').` };
                    camera.setFromRaDec(ra, dec);
                    return { success: true };
                }
            },

            pointCameraAtNamedObject: {
                doc: "Point the camera at a named solar-system object: Sun, Moon, Mercury, Venus, Mars, Jupiter, Saturn, Uranus, Neptune. For stars, star clusters, or constellations (e.g. M45, Polaris, Orion), use pointCameraAtRaDec instead.",
                params: {
                    object: "Name of the solar-system object (string)"
                },
                fn: (v) => {
                    const camera = NodeMan.get("lookCamera");
                    if (!camera) return { success: false, error: "lookCamera node not found" };
                    const ok = camera.setFromNamedObject(v.object);
                    if (!ok) return { success: false, error: `Unknown object '${v.object}'. Only solar-system bodies are supported (Sun, Moon, planets). For stars or deep-sky objects, use pointCameraAtRaDec with RA/Dec coordinates.` };
                    return { success: true };
                }
            },

            lockCameraOnObject: {
                doc: "Lock (continuously track) the camera onto a solar-system object so it follows the object as time changes. Supported: Sun, Moon, Mercury, Venus, Mars, Jupiter, Saturn, Uranus, Neptune. Use lockCameraOnRaDec for stars or deep-sky objects.",
                params: {
                    object: "Name of the solar-system object (string)"
                },
                fn: (v) => {
                    const camera = NodeMan.get("lookCamera");
                    if (!camera) return { success: false, error: "lookCamera node not found" };
                    const ok = camera.lockOnObject(v.object);
                    if (!ok) return { success: false, error: `Unknown object '${v.object}'. Only solar-system bodies are supported. For stars or deep-sky objects, use lockCameraOnRaDec.` };
                    return { success: true, locked: v.object };
                }
            },

            lockCameraOnRaDec: {
                doc: "Lock (continuously track) the camera onto a fixed sky position given by Right Ascension and Declination. The camera will follow the position as the sky rotates. RA can be decimal hours (e.g. 3.79) or sexagesimal ('3h47m' or '03:47:00'). Dec can be decimal degrees (e.g. 24.12) or sexagesimal ('+24d07m' or '24:07:00'). Use for stars, star clusters, galaxies, constellations, etc.",
                params: {
                    ra: "Right Ascension — decimal hours or sexagesimal string (e.g. 5.92 or '5h55m')",
                    dec: "Declination — decimal degrees or sexagesimal string (e.g. 7.41 or '+7d24m')",
                },
                fn: (v) => {
                    const camera = NodeMan.get("lookCamera");
                    if (!camera) return { success: false, error: "lookCamera node not found" };
                    const ra = parseRA(v.ra);
                    const dec = parseDec(v.dec);
                    if (ra === null) return { success: false, error: `Could not parse RA '${v.ra}'. Use decimal hours (e.g. 3.79) or sexagesimal (e.g. '3h47m10s').` };
                    if (dec === null) return { success: false, error: `Could not parse Dec '${v.dec}'. Use decimal degrees (e.g. 24.12) or sexagesimal (e.g. '+24d07m00s').` };
                    camera.lockOnRaDec(ra, dec);
                    return { success: true, locked: { ra, dec } };
                }
            },

            unlockCamera: {
                doc: "Remove any celestial lock from the camera, so it stays at its current orientation and stops tracking.",
                fn: () => {
                    const camera = NodeMan.get("lookCamera");
                    if (!camera) return { success: false, error: "lookCamera node not found" };
                    camera.unlockCelestial();
                    return { success: true };
                }
            },

            satellitesShowSatellites: {
                doc: "Show satellites.",
                fn: () => {
                    const nightSky = NodeMan.get("NightSkyNode");
                    if(nightSky) {
                        nightSky.showSatellites = true;
                        nightSky.satelliteGroup.visible = true;
                        nightSky.satellites.filterSatellites();
                    }
                }
            },
            satellitesHideSatellites: {
                doc: "Hide satellites.",
                fn: () => {
                    const nightSky = NodeMan.get("NightSkyNode");
                    if(nightSky) {
                        nightSky.showSatellites = false;
                        nightSky.satelliteGroup.visible = false;
                        nightSky.satellites.filterSatellites();
                    }
                }
            },

            satellitesShowStarlink: {
                doc: "Show Starlink satellites.",
                fn: () => {
                    const nightSky = NodeMan.get("NightSkyNode");
                    if(nightSky) {
                        nightSky.showStarlink = true;
                        nightSky.satellites.filterSatellites();
                    }
                }
            },
            satellitesHideStarlink: {
                doc: "Hide Starlink satellites.",
                fn: () => {
                    const nightSky = NodeMan.get("NightSkyNode");
                    if(nightSky) {
                        nightSky.showStarlink = false;
                        nightSky.satellites.filterSatellites();
                    }
                }
            },

            satellitesShowISS: {
                doc: "Show ISS satellite.",
                fn: () => {
                    const nightSky = NodeMan.get("NightSkyNode");
                    if(nightSky) {
                        nightSky.showISS = true;
                        nightSky.satellites.filterSatellites();
                    }
                }
            },
            satellitesHideISS: {
                doc: "Hide ISS satellite.",
                fn: () => {
                    const nightSky = NodeMan.get("NightSkyNode");
                    if(nightSky) {
                        nightSky.showISS = false;
                        nightSky.satellites.filterSatellites();
                    }
                }
            },

            satellitesShowBrightest: {
                doc: "Show Celestrak brightest satellites.",
                fn: () => {
                    const nightSky = NodeMan.get("NightSkyNode");
                    if(nightSky) {
                        nightSky.showBrightest = true;
                        nightSky.satellites.filterSatellites();
                    }
                }
            },
            satellitesHideBrightest: {
                doc: "Hide Celestrak brightest satellites.",
                fn: () => {
                    const nightSky = NodeMan.get("NightSkyNode");
                    if(nightSky) {
                        nightSky.showBrightest = false;
                        nightSky.satellites.filterSatellites();
                    }
                }
            },

            satelliteLookViewNamesOn: {
                doc: "Switch on satellite names in the look view.",
                fn: () => {
                    const nightSky = NodeMan.get("NightSkyNode");
                    if(nightSky) {
                        nightSky.showSatelliteNames = true;
                        nightSky.updateSatelliteNamesVisibility();
                    }
                }
            },

            satelliteLookViewNamesOff: {
                doc: "Switch off satellite names in the look view.",
                fn: () => {
                    const nightSky = NodeMan.get("NightSkyNode");
                    if(nightSky) {
                        nightSky.showSatelliteNames = false;
                        nightSky.updateSatelliteNamesVisibility();
                    }
                }
            },

            satelliteLookViewNamesToggle: {
                doc: "Toggle satellite names in the look view.",
                fn: () => {
                    const nightSky = NodeMan.get("NightSkyNode");
                    if(nightSky) {
                        nightSky.showSatelliteNames = nightSky.showSatelliteNames === true ? false : true;
                        nightSky.updateSatelliteNamesVisibility();
                    }
                }
            },

            satelliteMainViewNamesOn: {
                doc: "Switch on satellite names in the main view.",
                fn: () => {
                    const nightSky = NodeMan.get("NightSkyNode");
                    if(nightSky) {
                        nightSky.showSatelliteNamesMain = true;
                        nightSky.updateSatelliteNamesVisibility();
                    }
                }
            },

            satelliteMainViewNamesOff: {
                doc: "Switch off satellite names/lables in the main view.",
                fn: () => {
                    const nightSky = NodeMan.get("NightSkyNode");
                    if(nightSky) {
                        nightSky.showSatelliteNamesMain = false;
                        nightSky.updateSatelliteNamesVisibility();
                    }
                }
            },

            satelliteNamesMainViewToggle: {
                doc: "Toggle the display of satellite names in the main view.",
                fn: () => {
                    const nightSky = NodeMan.get("NightSkyNode");
                    if(nightSky) {
                        nightSky.showSatelliteNamesMain = nightSky.showSatelliteNamesMain === true ? false : true ;
                        nightSky.updateSatelliteNamesVisibility();
                    }
                }
            },

            satelliteLabelsOn: {
                doc: "Switches on satellite labels.",
                fn: () => {
                    const nightSky = NodeMan.get("NightSkyNode");
                    if(nightSky) {
                        nightSky.satellites.showSatelliteNames = true;
                        nightSky.satellites.showSatelliteNamesMain = true;
                        nightSky.updateSatelliteNamesVisibility();
                    }
                }
            },

            satelliteLabelsOff: {
                doc: "Switches off satellite labels.",
                fn: () => {
                    const nightSky = NodeMan.get("NightSkyNode");
                    if(nightSky) {
                        nightSky.satellites.showSatelliteNames = false;
                        nightSky.satellites.showSatelliteNamesMain = false;
                        nightSky.updateSatelliteNamesVisibility();
                    }
                }
            },

            satellitesLoadLEO: {
                doc: "Loads LEO low-earth orbit satellites.",
                fn: () => {
                    const nightSky = NodeMan.get("NightSkyNode");
                    if(nightSky) {
                        nightSky.satellites.updateLEOSats();
                    }
                }
            },

            satellitesLoadCurrentStarlink: {
                doc: "Loads current Starlink satellites.",
                fn: () => {
                    const nightSky = NodeMan.get("NightSkyNode");
                    if(nightSky) {
                        nightSky.satellites.updateStarlink();
                    }
                }
            },

            satellitesFlareRegionOn: {
                doc: "Show the satellite flare region visualization.",
                fn: () => {
                    const nightSky = NodeMan.get("NightSkyNode");
                    if(nightSky) {
                        nightSky.showFlareRegion = true;
                        nightSky.flareRegionGroup.visible = true;
                    }
                }
            },

            satellitesFlareRegionOff: {
                doc: "Hide the satellite flare region visualization.",
                fn: () => {
                    const nightSky = NodeMan.get("NightSkyNode");
                    if(nightSky) {
                        nightSky.showFlareRegion = false;
                        nightSky.flareRegionGroup.visible = false;
                    }
                }
            },


            satellitesShowOther: {
                doc: "Show other (non-Starlink, non-ISS, non-Brightest) satellites.",
                fn: () => {
                    const nightSky = NodeMan.get("NightSkyNode");
                    if(nightSky) {
                        nightSky.satellites.showOtherSatellites = true;
                        nightSky.satellites.filterSatellites();
                    }
                }
            },

            satellitesHideOther: {
                doc: "Hide other (non-Starlink, non-ISS, non-Brightest) satellites.",
                fn: () => {
                    const nightSky = NodeMan.get("NightSkyNode");
                    if(nightSky) {
                        nightSky.satellites.showOtherSatellites = false;
                        nightSky.satellites.filterSatellites();
                    }
                }
            },

            getFrame: {
                doc: "Get the current frame number and total frames.",
                fn: () => {
                    return { 
                        frame: par.frame, 
                        totalFrames: Sit.frames,
                        time: par.time,
                        paused: par.paused
                    };
                }
            },

            setFrame: {
                doc: "Set the current frame number (0-indexed).",
                params: {
                    frame: "Frame number (integer, 0-indexed)"
                },
                fn: (v) => {
                    let frame = parseInt(v.frame);
                    if (isNaN(frame)) return { success: false, error: "Invalid frame number" };
                    if (frame < 0) frame = 0;
                    if (frame > Sit.frames - 1) frame = Sit.frames - 1;
                    par.frame = frame;
                    return { success: true, frame: par.frame, totalFrames: Sit.frames };
                }
            },

            play: {
                doc: "Start playing the simulation (unpause).",
                fn: () => {
                    par.paused = false;
                    return { success: true, paused: false };
                }
            },

            pause: {
                doc: "Pause the simulation.",
                fn: () => {
                    par.paused = true;
                    return { success: true, paused: true };
                }
            },

            togglePlayPause: {
                doc: "Toggle between play and pause states.",
                fn: () => {
                    par.paused = !par.paused;
                    return { success: true, paused: par.paused };
                }
            },

            getCurrentSimTime: {
                doc: "Get the current simulation date/time as an ISO string.",
                fn: () => {
                    if (GlobalDateTimeNode && GlobalDateTimeNode.dateNow) {
                        return { 
                            isoString: GlobalDateTimeNode.dateNow.toISOString(),
                            localString: GlobalDateTimeNode.dateNow.toLocaleString()
                        };
                    }
                    return { error: "No simulation time available" };
                }
            },

            getRealTime: {
                doc: "Get the current real-world date/time.",
                fn: () => {
                    const now = new Date();
                    return { 
                        isoString: now.toISOString(),
                        localString: now.toLocaleString()
                    };
                }
            },

            listCelestialObjects: {
                doc: "List celestial objects that can be pointed at or locked onto.",
                fn: () => {
                    return {
                        planets: ["Mercury", "Venus", "Mars", "Jupiter", "Saturn", "Uranus", "Neptune"],
                        other: ["Sun", "Moon"],
                        note: "Use pointCameraAtNamedObject/lockCameraOnObject for these. For stars and deep-sky objects, use pointCameraAtRaDec/lockCameraOnRaDec with RA/Dec coordinates. 'lock' functions continuously track; 'point' functions are one-shot."
                    };
                }
            },

            addObjectAtLLA: {
                doc: "Create a new 3D object at the specified latitude, longitude, and altitude.",
                params: {
                    lat: "Latitude in degrees (float)",
                    lon: "Longitude in degrees (float)",
                    alt: "Altitude in meters (float, optional, defaults to 0)",
                    name: "Object name (string, optional)"
                },
                fn: (v) => {
                    try {
                        const name = v.name || CustomManager.getNextObjectName();
                        const alt = v.alt ?? 0;
                        const { objectNode, trackOb } = CustomManager.createObjectFromInput(
                            name, v.lat, v.lon, alt, v.alt !== undefined
                        );
                        if (objectNode) {
                            return { 
                                success: true, 
                                name: name, 
                                lat: v.lat, 
                                lon: v.lon, 
                                alt: alt 
                            };
                        }
                        return { success: false, error: "Failed to create object" };
                    } catch (e) {
                        return { success: false, error: e.message };
                    }
                }
            },

            createWalker: {
                doc: "Create a marker object that walks/moves through a list of lat/lon waypoints over a frame range — e.g. a viewer walking around to a vantage point, or a flying object. The object follows a linear track and holds at the last waypoint until the end. Address it later by name with show/hide/setMenuValue (e.g. hide it once the camera reaches it).",
                params: {
                    name: "Object id/name (string). Avoid 'object', 'target', 'witness', 'camera', 'observer' — the scripted-video system resolves those as ALIASES for other nodes, so a walker with one of these names can't be used as a script target",
                    waypoints: "Ordered array of [lat, lon] or [lat, lon, alt] the object moves through (array, >= 2). A missing alt falls back to the 'alt' param",
                    alt: "Default altitude in meters above the WGS84 ELLIPSOID (HAE — the datum of tile raycasts and getGroundAltitude's altHAE) for waypoints without their own (float, optional, defaults to 0). NOT MSL: convert with altHAE = altMSL + geoidOffset (getGroundAltitude reports both)",
                    fractions: "Per-waypoint time fractions 0..1 of [startFrame, endFrame], non-decreasing, starting at 0 and ending at 1, same length as waypoints — for uneven timing like hover-then-dash; hold early by duplicating a waypoint (array, optional, default = even spacing)",
                    geometry: "Geometry: cylinder, sphere, box, cone, capsule (string, optional, default 'cylinder')",
                    model: "Built-in 3D model name (e.g. 'TR-3B', 'Saucer' — see listModels) rendered instead of parametric geometry; overrides 'geometry' and the color/material/size params (string, optional)",
                    modelLength: "Desired model length in meters — the model is scaled so its longest axis matches (float, optional, model only)",
                    color: "Color as a hex number or '#rrggbb' string (optional, default 0xffd24a)",
                    material: "Material type: basic, lambert, phong, physical, envmap (string, optional, default 'phong')",
                    emissive: "Self-illuminated color as '#rrggbb' (string, optional — for glowing objects; lambert/phong/physical only)",
                    emissiveIntensity: "Emissive intensity 0..1 (float, optional, default 1)",
                    height: "Object height in meters (float, optional, default 2)",
                    radius: "Object radius in meters (float, optional, default 0.5)",
                    width: "Box width (across-track) in meters (float, optional, box geometry only)",
                    depth: "Box depth (along-track) in meters (float, optional, box geometry only)",
                    rotateY: "Yaw the geometry about its vertical axis in degrees (float, optional — e.g. align a box with a heading)",
                    startFrame: "Frame the walk starts (int, optional, default 0)",
                    endFrame: "Frame the last waypoint is reached (int, optional, default 1/4 of the sitch length)",
                    upright: "Orient the object's axis along local vertical (bool, optional, default true)"
                },
                fn: (v) => {
                    try {
                        const name = v.name || "Walker";
                        const wps = v.waypoints;
                        if (!Array.isArray(wps) || wps.length < 2) {
                            return { success: false, error: "createWalker needs a 'waypoints' array of at least 2 [lat, lon] pairs" };
                        }
                        // strict numeric coercion: numbers and non-empty numeric strings
                        // only — Number() alone would take null/false/"" as 0 and place
                        // waypoints on Null Island or scramble the frame range
                        const num = (x) => (typeof x === "number" || (typeof x === "string" && x.trim() !== "")) ? Number(x) : NaN;
                        const frames = Sit.frames || 1;
                        const startFrame = Math.max(0, Math.round(num(v.startFrame ?? 0)));
                        const endFrame = Math.min(frames - 1, Math.round(num(v.endFrame ?? frames * 0.25)));
                        if (!isFinite(startFrame) || !isFinite(endFrame) || endFrame <= startFrame) {
                            return { success: false, error: `bad frame range [${v.startFrame}, ${v.endFrame}] — needs finite frames with endFrame > startFrame` };
                        }
                        const alt = num(v.alt ?? 0);
                        const geometry = v.geometry || "cylinder";
                        // optional built-in model instead of parametric geometry —
                        // registry names only, so a walker spec can never serialize a
                        // model reference the deserialize pass can't load
                        const modelName = v.model !== undefined ? String(v.model) : null;
                        if (modelName && !ModelFiles[modelName]) {
                            return { success: false, error: `unknown model "${modelName}" — use one of: ${Object.keys(ModelFiles).join(", ")}` };
                        }
                        // validate the material BEFORE the destructive teardown below, so a
                        // bad override can never destroy the existing walker and then fail
                        // inside CNode3DObject (rebuildMaterial asserts on unknown types)
                        const MATERIAL_TYPES = ["basic", "lambert", "phong", "physical", "envmap", "gradient", "checkerboard"];
                        if (v.material !== undefined && !MATERIAL_TYPES.includes(String(v.material).toLowerCase())) {
                            return { success: false, error: `unknown material "${v.material}" — use one of: ${MATERIAL_TYPES.join(", ")}` };
                        }
                        const color = (typeof v.color === "string")
                            ? parseInt(v.color.replace("#", "0x")) : (v.color ?? 0xffd24a);
                        // numeric options must be finite — these end up in the
                        // serialized walker spec, and JSON turns NaN/Infinity into
                        // null, which would silently corrupt the sitch on reload
                        const height = num(v.height ?? 2), radius = num(v.radius ?? 0.5);
                        if (!isFinite(height) || !isFinite(radius)) {
                            return { success: false, error: "'height' and 'radius' must be finite numbers" };
                        }
                        for (const k of ["width", "depth", "rotateY", "emissiveIntensity", "modelLength"]) {
                            if (v[k] !== undefined && !isFinite(num(v[k]))) {
                                return { success: false, error: `'${k}' must be a finite number` };
                            }
                        }
                        // optional per-waypoint time fractions (0..1 of the frame range,
                        // non-decreasing, 0 first and 1 last) — hover-then-dash etc.;
                        // default = even spacing. The first fraction must be 0 (a later
                        // first knot would make the track extrapolate backward before it)
                        // and the last must be 1 (endFrame is documented as the frame the
                        // final waypoint is reached — hold early by duplicating a waypoint).
                        const fr = v.fractions;
                        if (fr !== undefined) {
                            // index loop, not .some(): sparse-array holes are skipped by
                            // the iteration methods and would sail through as undefined
                            let badFr = !Array.isArray(fr) || fr.length !== wps.length
                                || fr[0] !== 0 || fr[fr.length - 1] !== 1;
                            for (let i = 0; !badFr && i < fr.length; i++) {
                                const f = fr[i];
                                badFr = typeof f !== "number" || !isFinite(f) || f < 0 || f > 1 || (i > 0 && f < fr[i - 1]);
                            }
                            if (badFr) {
                                return { success: false, error: "'fractions' must be a non-decreasing array of finite 0..1 numbers, one per waypoint, starting at 0 and ending at 1" };
                            }
                        }
                        // waypoints ([lat, lon] or [lat, lon, alt]) -> [frame, x, y, z];
                        // knots kept strictly increasing (close fractions could round
                        // together) and never past the sitch end — an overflow means the
                        // waypoints can't all be represented, which is an error, not a
                        // silent truncation
                        let prevF = -1;
                        const pts = [];
                        for (let i = 0; i < wps.length; i++) {
                            const w = wps[i];
                            // each entry must be a real [lat, lon(, alt)] ARRAY — a string
                            // like "45,-122" would otherwise index as characters and pass,
                            // or blow up in spec recording AFTER the scene was mutated
                            if (!Array.isArray(w) || w.length < 2 || w.length > 3) {
                                return { success: false, error: `waypoint ${i} must be an array: [lat, lon] or [lat, lon, alt]` };
                            }
                            const lat = num(w[0]), lon = num(w[1]);
                            const wAlt = w[2] === undefined ? alt : num(w[2]);
                            if (!isFinite(lat) || !isFinite(lon) || !isFinite(wAlt)) {
                                return { success: false, error: `waypoint ${i} must be numeric [lat, lon] or [lat, lon, alt]` };
                            }
                            const e = LLAToECEF(lat, lon, wAlt);
                            const frac = fr ? fr[i] : (i / (wps.length - 1));
                            const f = Math.max(prevF + 1, Math.round(startFrame + (endFrame - startFrame) * frac));
                            // collision bumps must not spill past endFrame — the path is
                            // documented to COMPLETE at endFrame, so overflow is an error,
                            // not a silently late finish
                            if (f > endFrame) {
                                return { success: false, error: `waypoint ${i} lands past endFrame (${endFrame}) — too many waypoints for the frame range` };
                            }
                            prevF = f;
                            pts.push([f, e.x, e.y, e.z]);
                        }
                        // hold at the last waypoint until the final frame
                        const last = pts[pts.length - 1];
                        if (last[0] < frames - 1) pts.push([frames - 1, last[1], last[2], last[3]]);
                        // idempotent: fully tear down any existing walker with this id —
                        // its track, the object node, AND the derived sub-nodes the object
                        // creates (Viewer_size, Viewer_color_colorInput, Viewer_Controller…).
                        // A bare dispose()/unlinkDisposeRemove leaves those registered and
                        // they double-add on re-create. Sever links first so disposeRemove
                        // doesn't assert on remaining inputs/outputs.
                        const existing = NodeMan.get(name, false);
                        // only ever replace a node that IS a walker — a name collision
                        // with any other node (e.g. hand-edited save data naming
                        // "mainCamera") must refuse, not destroy core scene nodes
                        if (existing && !existing._walkerTrackID) {
                            return { success: false, error: `"${name}" is already a non-walker node — pick another name` };
                        }
                        if (!existing) {
                            // first creation: the idempotent re-create path below sweeps
                            // every `${name}_*` derived node, so refuse a name whose
                            // prefix collides with existing unrelated node ids (e.g.
                            // "syntheticTrack") — otherwise a later re-create would
                            // erase those nodes. Once created, all `${name}_*` nodes
                            // are the walker's own, so re-creates stay safe.
                            const prefix = name + "_";
                            const clash = Object.keys(NodeMan.list).find((id) => id.startsWith(prefix));
                            if (clash) {
                                return { success: false, error: `"${name}" collides with existing node ids ("${clash}") — pick another name` };
                            }
                            // ...and the mirror image: refuse a name INSIDE an existing
                            // walker's namespace ("car_dog" after walker "car" would be
                            // erased by car's next re-create sweep)
                            for (let i = name.lastIndexOf("_"); i > 0; i = name.lastIndexOf("_", i - 1)) {
                                const anc = NodeMan.get(name.slice(0, i), false);
                                if (anc && anc._walkerTrackID) {
                                    return { success: false, error: `"${name}" is inside walker "${name.slice(0, i)}"'s namespace — pick another name` };
                                }
                            }
                        }
                        if (existing) {
                            const tid = existing._walkerTrackID;
                            if (tid && TrackManager.exists(tid)) TrackManager.disposeRemove(tid);
                            // sweep ONLY the derived nodes recorded at creation (plus the
                            // walker itself) — never a blind `${name}_*` prefix sweep,
                            // which would take unrelated nodes another system created
                            // inside the namespace afterwards (e.g. a synth building
                            // the user id'ed "car_annex" while walker "car" existed)
                            const ids = [name, ...(existing._walkerOwnedIds ?? [])]
                                .filter((id) => NodeMan.exists(id));
                            for (const id of ids) { const n = NodeMan.get(id, false); if (n) { n.outputs = []; n.inputs = {}; } }
                            for (const id of ids) { try { NodeMan.disposeRemove(id); } catch (e) { /* ignore */ } }
                        }
                        const start = new Vector3(pts[0][1], pts[0][2], pts[0][3]);
                        // snapshot before construction: everything under `${name}_` that
                        // appears between here and the ownership recording below is a
                        // node THIS walker created — the only ids a re-create may sweep
                        const preIds = new Set(Object.keys(NodeMan.list));
                        // optional material overrides (glowing spheres etc.) — CNode3DObject
                        // reads these prop keys when building the material's param set
                        const matProps = {};
                        if (v.material !== undefined) matProps.material = v.material;
                        if (v.emissive !== undefined) matProps.emissive = v.emissive;
                        if (v.emissiveIntensity !== undefined) matProps.emissiveIntensity = v.emissiveIntensity;
                        if (v.width !== undefined) matProps.width = v.width;
                        if (v.depth !== undefined) matProps.depth = v.depth;
                        if (v.rotateY !== undefined) matProps.rotateY = v.rotateY;
                        const objectNode = modelName
                            ? new CNode3DObject({
                                id: name, model: modelName, position: start,
                                // API contract is meters; the node's modelLength GUIValue
                                // stores the current SMALL display unit (ft in imperial/
                                // nautical), so convert at this boundary. The spec keeps
                                // the meters value, so a reload under different units
                                // re-converts correctly.
                                ...(v.modelLength !== undefined ? { modelLength: num(v.modelLength) * (Units?.m2Small ?? 1) } : {}),
                                ...(v.rotateY !== undefined ? { rotateY: v.rotateY } : {}),
                            })
                            : new CNode3DObject({
                                id: name, geometry, radiusTop: radius, radiusBottom: radius, radius, height,
                                color, material: "phong", position: start, ...matProps,
                            });
                        if (v.upright ?? true) {
                            // align the geometry's +Y axis with the local vertical so a
                            // cylinder/capsule stands up instead of lying along world-Y
                            objectNode.group.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), getLocalUpVector(start));
                        }
                        // reuseTrackID (internal, used by sitch deserialize): bind to a
                        // track that TrackManager.deserialize already restored instead of
                        // creating a duplicate — same appFlight-style rebuild contract
                        let trackID, displayTrackID = null;
                        if (v.reuseTrackID && TrackManager.exists(v.reuseTrackID)) {
                            trackID = v.reuseTrackID;
                            displayTrackID = TrackManager.get(v.reuseTrackID)?.displayTrackID ?? null;
                        } else {
                            const newTrackOb = TrackManager.addSyntheticTrack({
                                name: name + " path", curveType: "linear", initialPoints: pts,
                                color, editMode: false, startFrame,
                            });
                            trackID = newTrackOb.trackID;
                            displayTrackID = newTrackOb.displayTrackID ?? null;
                        }
                        // the walker's path line is authoring noise in a scripted shot —
                        // hide its display node (re-showable from the track's GUI folder)
                        if (displayTrackID) {
                            const disp = NodeMan.get(displayTrackID, false);
                            if (disp) {
                                if (typeof disp.show === "function") disp.show(false);
                                disp.visible = false;
                                if (disp.group) disp.group.visible = false;
                            }
                        }
                        objectNode.addController("TrackPosition", { sourceTrack: trackID });
                        objectNode._walkerTrackID = trackID;   // for idempotent re-create
                        // ownership record for the surgical re-create sweep (see teardown)
                        objectNode._walkerOwnedIds = Object.keys(NodeMan.list)
                            .filter((id) => id.startsWith(name + "_") && !preIds.has(id));
                        // record the (sanitized) spec so the custom sitch can serialize
                        // walkers and recreate them on load — objects don't otherwise persist
                        Globals.walkerSpecs = Globals.walkerSpecs || {};
                        Globals.walkerSpecs[name] = {
                            name, waypoints: wps.map((w) => w.map(Number)), alt,
                            ...(fr ? {fractions: [...fr]} : {}),
                            ...(modelName ? {model: modelName} : {}),
                            ...(v.modelLength !== undefined ? {modelLength: num(v.modelLength)} : {}),
                            geometry, color: v.color ?? 0xffd24a, height, radius,
                            ...(v.material !== undefined ? {material: v.material} : {}),
                            ...(v.emissive !== undefined ? {emissive: v.emissive} : {}),
                            ...(v.emissiveIntensity !== undefined ? {emissiveIntensity: v.emissiveIntensity} : {}),
                            ...(v.width !== undefined ? {width: v.width} : {}),
                            ...(v.depth !== undefined ? {depth: v.depth} : {}),
                            ...(v.rotateY !== undefined ? {rotateY: v.rotateY} : {}),
                            startFrame, endFrame, upright: v.upright ?? true, trackID,
                        };
                        markSitchDirty();
                        return { success: true, name, trackID, waypoints: pts.length, startFrame, endFrame };
                    } catch (e) {
                        return { success: false, error: e?.message ?? String(e) };
                    }
                }
            },

            setScriptedVideoScript: {
                // SECURITY: the "script" is not a sandboxed DSL — its body is compiled with
                // AsyncFunction and run in the page main world (see scriptedVideo/ScriptJSRunner.js).
                // llmCallable:false withholds it from the chatbot tool surface and blocks it in
                // handleAPICall when the caller is the LLM, closing the indirect-prompt-injection
                // ACE path (B1). Trusted UI/MCP callers are unaffected.
                llmCallable: false,
                doc: "Set the active Scripting tab's cinematic camera script and parse it (use previewScriptedVideo to play it). DSL: one command per line; plain/await lines are sequential, '&' lines run concurrently, '#' comments, quote multi-word captions. Camera: from(target,secs,bearing,dist,elev) place absolutely, zoom(target,secs,dist), orbit(target,secs,deg,rise), track, follow(target,secs,dist,height), ride(target,secs,lookAt,height,back) ride ON a moving target looking at another, rise(target,secs,m), fov(deg,secs), flyto(look,secs), wait/linger(secs). Layout/caption: view(name|'photo'|{layout}), text(\"cap\",secs), fade(view,secs,to). Settings/objects: set/show/hide a menu control OR a scene-object id. Targets: object, witness, a node id, or 'lat,lon,alt'.",
                params: { script: "The full script text (string)" },
                fn: (v) => {
                    const sv = Globals.scriptedVideo;
                    if (!sv) return { success: false, error: "Scripting system not available" };
                    const ed = sv.ensureEditor();
                    if (!ed || !ed.textarea) return { success: false, error: "Scripting editor not ready" };
                    const text = String(v.script ?? "");
                    ed._setText(text);
                    sv.syncActiveFromEditor();
                    return { success: true, length: text.length };
                }
            },

            previewScriptedVideo: {
                // SECURITY: executes the active script body (AsyncFunction, page main world).
                // Gated alongside setScriptedVideoScript — see the note there. (B1)
                llmCallable: false,
                doc: "Start previewing the active Scripting script (the cinematic camera move), optionally from a given time in seconds. Use stopScriptedVideo to end.",
                params: { at: "Start time in seconds (float, optional, defaults to 0)" },
                fn: (v) => {
                    const sv = Globals.scriptedVideo;
                    if (!sv) return { success: false, error: "Scripting system not available" };
                    sv.startPreview(v.at ?? 0);
                    return { success: true, duration: sv.totalDuration };
                }
            },

            stopScriptedVideo: {
                doc: "Stop the Scripting preview and restore the normal views.",
                params: {},
                fn: () => {
                    const sv = Globals.scriptedVideo;
                    if (!sv) return { success: false, error: "Scripting system not available" };
                    sv.stopAll();
                    return { success: true };
                }
            },

            listSynthElements: {
                doc: "List native synthetic scene elements managed by Synth3DManager. Types are building, clouds, overlay, or all.",
                params: {
                    type: "Element type: building, clouds, overlay, or all (string, optional, defaults to all)",
                    includeSerialized: "Include full serialized state for each element (bool, optional, defaults to true)"
                },
                fn: (v = {}) => this._listSynthElements(v.type || "all", v.includeSerialized !== false)
            },

            getSynthElement: {
                doc: "Inspect a native synthetic scene element by type and ID.",
                params: {
                    type: "Element type: building, clouds, or overlay (string)",
                    id: "Element ID, e.g. synthBuilding_1, synthClouds_1, or groundOverlay_1 (string)"
                },
                fn: (v) => {
                    const element = this._getSynthElement(v.type, v.id);
                    if (!element) return { success: false, error: `Synth ${v.type} '${v.id}' not found` };
                    return { success: true, type: this._normalizeSynthType(v.type), id: this._getSynthElementID(element), element: this._serializeSynthElement(element) };
                }
            },

            createSynthBuilding: {
                doc: "Create a native synthetic building without opening context menus or edit UI. Prefer this for agent-generated buildings. Provide either cornerLatLons or center lat/lon plus width/depth/height.",
                params: {
                    id: "Building ID (string, optional)",
                    name: "Building name (string, optional)",
                    lat: "Center latitude in degrees (float, required unless cornerLatLons is provided)",
                    lon: "Center longitude in degrees (float, required unless cornerLatLons is provided)",
                    width: "Width in meters east-west before heading rotation (float, optional, defaults to 15)",
                    depth: "Depth in meters north-south before heading rotation (float, optional, defaults to width)",
                    height: "Roof height above highest ground point in meters (float, optional, defaults to roofAGL or 4)",
                    headingDeg: "Clockwise heading in degrees for width/depth rectangle (float, optional, defaults to 0)",
                    cornerLatLons: "Array of four {lat, lon} building footprint corners (array, optional)",
                    roofAGL: "Roof height above highest ground point in meters (float, optional)",
                    rooflineHeightAGL: "Additional ridgeline height above roof edge in meters (float, optional)",
                    ridgelineInset: "Distance to inset ridgeline ends in meters (float, optional)",
                    roofEaves: "Roof eave extension in meters (float, optional)",
                    wallColor: "Wall color as hex string or number (string, optional)",
                    roofColor: "Roof color as hex string or number (string, optional)",
                    opacity: "Material opacity 0..1 (float, optional)",
                    transparent: "Material transparency flag (bool, optional)",
                    visible: "Visibility flag (bool, optional)",
                    editMode: "Leave building in edit mode after creation (bool, optional, defaults to false)"
                },
                fn: (v) => this._createSynthBuilding(v)
            },

            createSynthBuildings: {
                doc: "Batch-create native synthetic buildings in one API call. Each item accepts createSynthBuilding parameters. Much faster than context-menu creation loops.",
                params: {
                    buildings: "Array of building parameter objects accepted by createSynthBuilding (array)",
                    editMode: "Default editMode for all buildings unless overridden per item (bool, optional, defaults to false)"
                },
                fn: (v) => {
                    if (!Array.isArray(v.buildings)) return { success: false, error: "buildings must be an array" };
                    const results = v.buildings.map((building) => this._createSynthBuilding({
                        editMode: v.editMode === true,
                        ...building
                    }));
                    const failed = results.filter(r => !r.success);
                    return { success: failed.length === 0, count: results.length, failed: failed.length, buildings: results };
                }
            },

            createSynthClouds: {
                doc: "Create a native synthetic cloud layer without opening context menus or edit UI.",
                params: {
                    id: "Cloud layer ID (string, optional)",
                    name: "Cloud layer name (string, optional)",
                    centerLat: "Center latitude in degrees (float, optional; lat is also accepted)",
                    centerLon: "Center longitude in degrees (float, optional; lon is also accepted)",
                    lat: "Alias for centerLat (float, optional)",
                    lon: "Alias for centerLon (float, optional)",
                    altitude: "Altitude in meters (float, optional)",
                    radius: "Cloud disk radius in meters (float, optional)",
                    depth: "Cloud layer depth in meters (float, optional)",
                    cloudSize: "Cloud sprite size in meters (float, optional)",
                    density: "Cloud density (float, optional)",
                    opacity: "Cloud opacity 0..1 (float, optional)",
                    brightness: "Cloud brightness multiplier (float, optional)",
                    seed: "Random seed (number, optional)",
                    feather: "Edge feather distance in meters (float, optional)",
                    editMode: "Leave clouds in edit mode after creation (bool, optional, defaults to false)"
                },
                fn: (v) => this._createSynthClouds(v)
            },

            createSynthOverlay: {
                doc: "Create a native ground overlay without opening context menus or edit UI. Provide north/south/east/west bounds, or center lat/lon plus width/depth.",
                params: {
                    id: "Overlay ID (string, optional)",
                    name: "Overlay name (string, optional)",
                    north: "North latitude bound in degrees (float, optional)",
                    south: "South latitude bound in degrees (float, optional)",
                    east: "East longitude bound in degrees (float, optional)",
                    west: "West longitude bound in degrees (float, optional)",
                    lat: "Center latitude in degrees when using width/depth (float, optional)",
                    lon: "Center longitude in degrees when using width/depth (float, optional)",
                    width: "Overlay width in meters when using center lat/lon (float, optional)",
                    depth: "Overlay depth in meters when using center lat/lon (float, optional)",
                    rotation: "Overlay rotation in degrees/radians as used by ground overlays (float, optional)",
                    imageURL: "Overlay image URL (string, optional)",
                    opacity: "Overlay opacity 0..1 (float, optional)",
                    altitude: "Overlay altitude in meters (float, optional)",
                    visible: "Visibility flag (bool, optional)",
                    editMode: "Leave overlay in edit mode after creation (bool, optional, defaults to false)"
                },
                fn: (v) => this._createSynthOverlay(v)
            },

            updateSynthElement: {
                doc: "Modify a native synthetic building, cloud layer, or ground overlay, then rebuild/update its mesh and GUI controllers.",
                params: {
                    type: "Element type: building, clouds, or overlay (string)",
                    id: "Element ID (string)",
                    patch: "Properties to update (object). Buildings accept cornerLatLons, roofAGL/height, rooflineHeightAGL, ridgelineInset, roofEaves, material/color/visibility. Clouds and overlays accept their serialized fields."
                },
                fn: (v) => this._updateSynthElement(v.type, v.id, v.patch || {})
            },

            deleteSynthElement: {
                doc: "Delete a native synthetic building, cloud layer, or ground overlay by type and ID.",
                params: {
                    type: "Element type: building, clouds, or overlay (string)",
                    id: "Element ID (string)"
                },
                fn: (v) => this._deleteSynthElement(v.type, v.id)
            },

            deleteSynthElements: {
                doc: "Delete multiple native synthetic elements. Pass an elements array of {type, id}, or pass type plus ids.",
                params: {
                    elements: "Array of {type, id} objects (array, optional)",
                    type: "Element type used with ids: building, clouds, or overlay (string, optional)",
                    ids: "Array of IDs used with type (array, optional)"
                },
                fn: (v) => {
                    const elements = Array.isArray(v.elements)
                        ? v.elements
                        : (Array.isArray(v.ids) ? v.ids.map(id => ({ type: v.type, id })) : []);
                    if (elements.length === 0) return { success: false, error: "Pass elements or type plus ids" };
                    const results = elements.map(e => this._deleteSynthElement(e.type, e.id));
                    const failed = results.filter(r => !r.success);
                    return { success: failed.length === 0, count: results.length, failed: failed.length, results };
                }
            },

            findSatellite: {
                doc: "Search for satellites by name. Returns matching satellite names. Use this to find the correct name before filtering.",
                params: {
                    name: "Partial or full satellite name to search for (string)"
                },
                fn: (v) => {
                    const nightSky = NodeMan.get("NightSkyNode");
                    if (!nightSky || !nightSky.satellites || !nightSky.satellites.TLEData) {
                        return { success: false, error: "No satellite data loaded. Load satellites first with satellitesLoadLEO." };
                    }
                    const searchTerm = String(v.name).toUpperCase();
                    const matches = [];
                    for (const satData of nightSky.satellites.TLEData.satData) {
                        if (satData.name && satData.name.toUpperCase().includes(searchTerm)) {
                            matches.push(satData.name);
                            if (matches.length >= 20) break;
                        }
                    }
                    return { 
                        success: true, 
                        count: matches.length, 
                        matches: matches,
                        note: matches.length >= 20 ? "Results limited to 20. Refine your search." : undefined
                    };
                }
            },

            debug: {
                doc: "Toggle debug mode",
                params: {
                },
                fn: (v) => {
                    this.debug = !this.debug;
                }
            },

            setMenuValue: {
                doc: "Set a menu control value by menu ID and control name path.",
                params: {
                    menu: "Menu ID (e.g. 'view', 'satellites', 'terrain'). Optional — omit/null to scan ALL menus and set the first control matching path",
                    path: "Control name or path with '/' for nested folders (e.g. 'showStarlink' or 'Views/showVideo')",
                    value: "New value (type depends on control: number, boolean, string, or color hex)"
                },
                fn: (v) => {
                    const result = this._setMenuValue(v.menu, v.path, v.value);
                    if (!result.success) {
                        // Concatenated, not passed as showError's second argument: that
                        // parameter is an Error object and only its .stack is shown, so a
                        // plain string error there is silently dropped and the dialog is blank.
                        //
                        // Under an agent this dialog never reaches the screen anyway -
                        // showError routes it into handleAPICall's capture and back to the
                        // agent, which has the suggestions in `result` to retry with.
                        showError("setMenuValue failed: " + result.error);
                    }
                    return result;
                }
            },

            getMenuValue: {
                doc: "Get current value of a menu control by menu ID and control name path.",
                params: {
                    menu: "Menu ID (e.g. 'view', 'satellites', 'terrain')",
                    path: "Control name or path with '/' for nested folders (e.g. 'showStarlink' or 'Views/showVideo')"
                },
                fn: (v) => {
                    return this._getMenuValue(v.menu, v.path);
                }
            },

            listMenus: {
                doc: "List all available menu IDs.",
                fn: () => {
                    return Object.keys(guiMenus);
                }
            },

            listMenuControls: {
                doc: "List all controls in a specific menu.",
                params: {
                    menu: "Menu ID (e.g. 'view', 'satellites')"
                },
                fn: (v) => {
                    const gui = guiMenus[v.menu];
                    if (!gui) return { error: `Menu '${v.menu}' not found` };
                    return this._extractGUIDoc(gui);
                }
            },

            executeMenuButton: {
                doc: "Execute a button/function control in a menu (e.g. 'Add Object').",
                params: {
                    menu: "Menu ID (e.g. 'objects', 'view')",
                    path: "Button name or path with '/' for nested folders"
                },
                fn: (v) => {
                    return this._executeMenuButton(v.menu, v.path);
                }
            },

            listObjectFolders: {
                doc: "List all 3D object folder names in the objects menu. Use this to find the correct object name when user refers to an object (e.g. 'camera' might match 'cameraObject').",
                fn: () => {
                    const gui = guiMenus.objects;
                    if (!gui) return { error: "Objects menu not found" };
                    const folders = gui.children
                        .filter(c => c instanceof GUI)
                        .map(c => c._title);
                    return folders;
                }
            },

            listAvailableModels: {
                doc: "List all available 3D model names that can be used with setObjectModel.",
                fn: () => {
                    return Object.keys(ModelFiles);
                }
            },

            setObjectModel: {
                doc: "Set the 3D model for an object. Call listAvailableModels first to see available options, then pick the best match for the user's request (e.g. if they ask for 'plane' or 'jet', pick an appropriate aircraft model).",
                params: {
                    object: "Object name or partial name (e.g. 'camera' will match 'cameraObject')",
                    model: "Exact model name from listAvailableModels"
                },
                fn: (v) => {
                    const gui = guiMenus.objects;
                    if (!gui) return { success: false, error: "Objects menu not found" };
                    
                    const objectLower = String(v.object).toLowerCase();
                    const folders = gui.children.filter(c => c instanceof GUI);
                    
                    // Find best matching folder
                    let folder = folders.find(c => c._title.toLowerCase() === objectLower);
                    if (!folder) {
                        folder = folders.find(c => c._title.toLowerCase().includes(objectLower));
                    }
                    if (!folder) {
                        folder = folders.find(c => objectLower.includes(c._title.toLowerCase()));
                    }
                    if (!folder) {
                        const available = folders.map(c => c._title).join(', ');
                        return { success: false, error: `Object '${v.object}' not found. Available: ${available}` };
                    }
                    
                    // Find best matching model name
                    const modelLower = String(v.model).toLowerCase();
                    const modelKeys = Object.keys(ModelFiles);
                    let modelName = modelKeys.find(m => m.toLowerCase() === modelLower);
                    if (!modelName) {
                        modelName = modelKeys.find(m => m.toLowerCase().includes(modelLower));
                    }
                    if (!modelName) {
                        modelName = modelKeys.find(m => modelLower.includes(m.toLowerCase()));
                    }
                    if (!modelName) {
                        return { success: false, error: `Model '${v.model}' not found. Available: ${modelKeys.join(', ')}` };
                    }
                    
                    // Setting Model automatically switches to model mode and triggers rebuild
                    const modelResult = this._setMenuValue('objects', folder._title + '/Model', modelName);
                    if (!modelResult.success) return modelResult;
                    
                    return { success: true, object: folder._title, model: modelResult.newValue };
                }
            },

            listAvailableGeometries: {
                doc: "List all available geometry types with their specific dimension parameters. Use setAllObjectsDimensions for geometry-agnostic dimension changes, or setMenuValue with the specific parameters listed here for precise control.",
                fn: () => {
                    return {
                        geometries: ["sphere", "ellipsoid", "box", "capsule", "circle", "cone", "cylinder", 
                                "dodecahedron", "icosahedron", "octahedron", "ring", "tictac", 
                                "tetrahedron", "torus", "torusknot", "superegg"],
                        parameters: {
                            box: ["width", "height", "depth"],
                            cylinder: ["radiusTop", "radiusBottom", "height"],
                            cone: ["radius", "height"],
                            capsule: ["radius", "totalLength"],
                            sphere: ["radius"],
                            ellipsoid: ["radiusX", "radiusY", "radiusZ"],
                            torus: ["radius", "tube"],
                            superegg: ["radius", "length", "sharpness"],
                            tictac: ["radius", "length"],
                            circle: ["radius"],
                            ring: ["innerRadius", "outerRadius"],
                            icosahedron: ["radius"],
                            dodecahedron: ["radius"],
                            octahedron: ["radius"],
                            tetrahedron: ["radius"],
                            torusknot: ["radius", "tube"]
                        },
                        tip: "Use setAllObjectsDimensions(width, height, depth) for automatic parameter mapping, or setMenuValue for direct parameter control."
                    };
                }
            },

            setObjectGeometry: {
                doc: "Set an object to use a procedural geometry type (instead of a 3D model). After setting geometry, use setObjectDimensions to adjust size. Call listAvailableGeometries to see geometry types and their specific parameters.",
                params: {
                    object: "Object name or partial name (e.g. 'camera' will match 'cameraObject')",
                    geometry: "Geometry type name from listAvailableGeometries (e.g. 'sphere', 'superegg', 'box')"
                },
                fn: (v) => {
                    const gui = guiMenus.objects;
                    if (!gui) return { success: false, error: "Objects menu not found" };
                    
                    const objectLower = String(v.object).toLowerCase();
                    const folders = gui.children.filter(c => c instanceof GUI);
                    
                    // Find best matching folder
                    let folder = folders.find(c => c._title.toLowerCase() === objectLower);
                    if (!folder) {
                        folder = folders.find(c => c._title.toLowerCase().includes(objectLower));
                    }
                    if (!folder) {
                        folder = folders.find(c => objectLower.includes(c._title.toLowerCase()));
                    }
                    if (!folder) {
                        const available = folders.map(c => c._title).join(', ');
                        return { success: false, error: `Object '${v.object}' not found. Available: ${available}` };
                    }
                    
                    // Find best matching geometry type
                    const geometryTypes = ["sphere", "ellipsoid", "box", "capsule", "circle", "cone", "cylinder", 
                                           "dodecahedron", "icosahedron", "octahedron", "ring", "tictac", 
                                           "tetrahedron", "torus", "torusknot", "superegg"];
                    const geoLower = String(v.geometry).toLowerCase();
                    let geoName = geometryTypes.find(g => g.toLowerCase() === geoLower);
                    if (!geoName) {
                        geoName = geometryTypes.find(g => g.toLowerCase().includes(geoLower));
                    }
                    if (!geoName) {
                        geoName = geometryTypes.find(g => geoLower.includes(g.toLowerCase()));
                    }
                    if (!geoName) {
                        return { success: false, error: `Geometry '${v.geometry}' not found. Available: ${geometryTypes.join(', ')}` };
                    }
                    
                    // First switch to geometry mode
                    const modeResult = this._setMenuValue('objects', folder._title + '/Model or Geometry', 'geometry');
                    if (!modeResult.success) return modeResult;
                    
                    // Then set the geometry type
                    const geoResult = this._setMenuValue('objects', folder._title + '/geometry', geoName);
                    if (!geoResult.success) return geoResult;
                    
                    return { success: true, object: folder._title, geometry: geoResult.newValue };
                }
            },

            setAllObjectsGeometry: {
                doc: "Set all 3D objects to use a specific geometry type. Useful for commands like 'make all objects spheres'. After setting geometry, use setAllObjectsDimensions to adjust size, or call listAvailableGeometries to see specific parameters for each geometry type.",
                params: {
                    geometry: "Geometry type name from listAvailableGeometries (e.g. 'sphere', 'superegg', 'box')"
                },
                fn: (v) => {
                    const gui = guiMenus.objects;
                    if (!gui) return { success: false, error: "Objects menu not found" };
                    
                    const geometryTypes = ["sphere", "ellipsoid", "box", "capsule", "circle", "cone", "cylinder", 
                                           "dodecahedron", "icosahedron", "octahedron", "ring", "tictac", 
                                           "tetrahedron", "torus", "torusknot", "superegg"];
                    const geoLower = String(v.geometry).toLowerCase();
                    let geoName = geometryTypes.find(g => g.toLowerCase() === geoLower);
                    if (!geoName) {
                        geoName = geometryTypes.find(g => g.toLowerCase().includes(geoLower));
                    }
                    if (!geoName) {
                        geoName = geometryTypes.find(g => geoLower.includes(g.toLowerCase()));
                    }
                    if (!geoName) {
                        return { success: false, error: `Geometry '${v.geometry}' not found. Available: ${geometryTypes.join(', ')}` };
                    }
                    
                    const folders = gui.children.filter(c => c instanceof GUI);
                    const results = [];
                    
                    for (const folder of folders) {
                        // Switch to geometry mode
                        const modeResult = this._setMenuValue('objects', folder._title + '/Model or Geometry', 'geometry');
                        if (modeResult.success) {
                            // Set the geometry type
                            const geoResult = this._setMenuValue('objects', folder._title + '/geometry', geoName);
                            results.push({ object: folder._title, success: geoResult.success, geometry: geoName });
                        }
                    }
                    
                    return { success: true, geometry: geoName, objects: results };
                }
            },

            setAllObjectsModel: {
                doc: "Set all 3D objects to use a specific 3D model. Useful for commands like 'make all objects 737s' or 'change everything to helicopters'. Call listAvailableModels first to see available options.",
                params: {
                    model: "Exact model name from listAvailableModels"
                },
                fn: (v) => {
                    const gui = guiMenus.objects;
                    if (!gui) return { success: false, error: "Objects menu not found" };
                    
                    const modelLower = String(v.model).toLowerCase();
                    const modelKeys = Object.keys(ModelFiles);
                    let modelName = modelKeys.find(m => m.toLowerCase() === modelLower);
                    if (!modelName) {
                        modelName = modelKeys.find(m => m.toLowerCase().includes(modelLower));
                    }
                    if (!modelName) {
                        modelName = modelKeys.find(m => modelLower.includes(m.toLowerCase()));
                    }
                    if (!modelName) {
                        return { success: false, error: `Model '${v.model}' not found. Available: ${modelKeys.join(', ')}` };
                    }
                    
                    const folders = gui.children.filter(c => c instanceof GUI);
                    const results = [];
                    
                    for (const folder of folders) {
                        // Setting Model automatically switches to model mode and triggers rebuild
                        const modelResult = this._setMenuValue('objects', folder._title + '/Model', modelName);
                        results.push({ object: folder._title, success: modelResult.success, model: modelName });
                    }
                    
                    return { success: true, model: modelName, objects: results };
                }
            },

            setObjectDimensions: {
                doc: "Set the dimensions of an object's geometry using standardized width/height/depth values. Maps to appropriate parameters based on geometry type: box uses width/height/depth directly; cylinder uses width as radiusTop and radiusBottom, height as height; sphere uses width as radius; capsule uses width as radius and height as totalLength.",
                params: {
                    object: "Object name or partial name",
                    width: "Width dimension in meters, float (maps to radius for round objects)",
                    height: "Height dimension in meters, float (optional)",
                    depth: "Depth dimension in meters, float (optional, for box geometry)"
                },
                fn: (v) => {
                    const gui = guiMenus.objects;
                    if (!gui) return { success: false, error: "Objects menu not found" };
                    
                    const objectLower = String(v.object).toLowerCase();
                    const folders = gui.children.filter(c => c instanceof GUI);
                    
                    let folder = folders.find(c => c._title.toLowerCase() === objectLower);
                    if (!folder) {
                        folder = folders.find(c => c._title.toLowerCase().includes(objectLower));
                    }
                    if (!folder) {
                        folder = folders.find(c => objectLower.includes(c._title.toLowerCase()));
                    }
                    if (!folder) {
                        const available = folders.map(c => c._title).join(', ');
                        return { success: false, error: `Object '${v.object}' not found. Available: ${available}` };
                    }
                    
                    const geoResult = this._getMenuValue('objects', folder._title + '/geometry');
                    const geometry = geoResult.success ? geoResult.value : 'sphere';
                    
                    const results = [];
                    const width = v.width;
                    const height = v.height ?? v.width;
                    const depth = v.depth ?? v.width;
                    
                    switch (geometry) {
                        case 'box':
                            results.push(this._setMenuValue('objects', folder._title + '/width', width));
                            results.push(this._setMenuValue('objects', folder._title + '/height', height));
                            results.push(this._setMenuValue('objects', folder._title + '/depth', depth));
                            break;
                        case 'cylinder':
                            results.push(this._setMenuValue('objects', folder._title + '/radiusTop', width / 2));
                            results.push(this._setMenuValue('objects', folder._title + '/radiusBottom', width / 2));
                            results.push(this._setMenuValue('objects', folder._title + '/height', height));
                            break;
                        case 'cone':
                            results.push(this._setMenuValue('objects', folder._title + '/radius', width / 2));
                            results.push(this._setMenuValue('objects', folder._title + '/height', height));
                            break;
                        case 'capsule':
                            results.push(this._setMenuValue('objects', folder._title + '/radius', width / 2));
                            results.push(this._setMenuValue('objects', folder._title + '/totalLength', height));
                            break;
                        case 'sphere':
                        case 'icosahedron':
                        case 'dodecahedron':
                        case 'octahedron':
                        case 'tetrahedron':
                            results.push(this._setMenuValue('objects', folder._title + '/radius', width / 2));
                            break;
                        case 'ellipsoid':
                            results.push(this._setMenuValue('objects', folder._title + '/radiusX', width / 2));
                            results.push(this._setMenuValue('objects', folder._title + '/radiusY', height / 2));
                            results.push(this._setMenuValue('objects', folder._title + '/radiusZ', depth / 2));
                            break;
                        case 'torus':
                            results.push(this._setMenuValue('objects', folder._title + '/radius', width / 2));
                            results.push(this._setMenuValue('objects', folder._title + '/tube', height / 4));
                            break;
                        case 'superegg':
                        case 'tictac':
                            results.push(this._setMenuValue('objects', folder._title + '/radius', width / 2));
                            results.push(this._setMenuValue('objects', folder._title + '/length', height / 2));
                            break;
                        default:
                            return { success: false, error: `Unknown geometry type: ${geometry}` };
                    }
                    
                    const allSuccess = results.every(r => r.success);
                    return { success: allSuccess, object: folder._title, geometry, dimensions: { width, height, depth } };
                }
            },

            setAllObjectsDimensions: {
                doc: "Set the dimensions of all objects' geometries using standardized width/height/depth values. Automatically maps to the correct parameters based on each object's geometry type.",
                params: {
                    width: "Width dimension in meters, float (maps to radius for round objects)",
                    height: "Height dimension in meters, float (optional)",
                    depth: "Depth dimension in meters, float (optional, for box geometry)"
                },
                fn: (v) => {
                    const gui = guiMenus.objects;
                    if (!gui) return { success: false, error: "Objects menu not found" };

                    const folders = gui.children.filter(c => c instanceof GUI);
                    const results = [];

                    for (const folder of folders) {
                        const dimResult = this.api.setObjectDimensions.fn.call(this, {
                            object: folder._title,
                            width: v.width,
                            height: v.height,
                            depth: v.depth
                        });
                        results.push({ object: folder._title, ...dimResult });
                    }

                    return { success: true, objects: results };
                }
            },

            // ---- View / Layout API ----

            listViews: {
                doc: "List all available views with their current position, size, and visibility.",
                fn: () => {
                    const views = [];
                    ViewMan.iterate((id, view) => {
                        if (!view.overlayView) {
                            views.push({
                                id: id,
                                visible: view.visible,
                                left: view.left,
                                top: view.top,
                                width: view.width,
                                height: view.height,
                            });
                        }
                    });
                    return views;
                }
            },

            showView: {
                doc: "Show a view by name.",
                params: { view: "View ID (e.g. 'mainView', 'lookView', 'video')" },
                fn: (v) => {
                    const view = ViewMan.get(v.view, false);
                    if (!view) return { success: false, error: `View '${v.view}' not found` };
                    view.setVisible(true);
                    // An explicit command to show the view: lift fullscreen suppression even
                    // when the visible flag was already true - setVisible deliberately
                    // early-outs on same-value calls (see CNodeView.setVisible), which would
                    // otherwise leave this view hidden while we report success.
                    if (ViewMan.unsuppressView(view)) setRenderOne(true);
                    return { success: true };
                }
            },

            hideView: {
                doc: "Hide a view by name.",
                params: { view: "View ID (e.g. 'mainView', 'lookView', 'video')" },
                fn: (v) => {
                    const view = ViewMan.get(v.view, false);
                    if (!view) return { success: false, error: `View '${v.view}' not found` };
                    view.setVisible(false);
                    return { success: true };
                }
            },

            setViewPosition: {
                doc: "Set a view's position and size using fractional coordinates (0-1).",
                params: {
                    view: "View ID (e.g. 'mainView')",
                    left: "Left edge as float fraction of container width (0-1)",
                    top: "Top edge as float fraction of container height (0-1)",
                    width: "Width as float fraction of container width (0-1)",
                    height: "Height as float fraction of container height (0-1)",
                    visible: "Optional: also set visibility (boolean)"
                },
                fn: (v) => {
                    const view = ViewMan.get(v.view, false);
                    if (!view) return { success: false, error: `View '${v.view}' not found` };
                    if (v.visible !== undefined) view.setVisible(v.visible);
                    view.left = v.left;
                    view.top = v.top;
                    view.width = v.width;
                    view.height = v.height;
                    view.updateWH();
                    forceUpdateUIText();
                    return { success: true };
                }
            },

            setLayout: {
                doc: "Arrange views using a named layout template. Templates: 'columns' (equal-width columns), 'rows' (equal-height rows), 'leftWide' (large left pane, stacked right), 'rightWide' (stacked left, large right pane), 'grid' (auto 2D grid), 'single' (first view fullscreen, others hidden). Pass an array of view IDs to include in the layout.",
                params: {
                    template: "Layout template name: 'columns', 'rows', 'leftWide', 'rightWide', 'grid', 'single'",
                    views: "Array of view IDs to arrange (e.g. ['mainView', 'lookView', 'video'])"
                },
                fn: (v) => {
                    return this._applyLayoutTemplate(v.template, v.views);
                }
            },

            hideMenu: {
                doc: "Hide the menu bar.",
                fn: () => {
                    if (Globals.menuBar && !Globals.menuBar._hidden) {
                        Globals.menuBar.hide();
                    }
                    return { success: true };
                }
            },

            showMenu: {
                doc: "Show the menu bar.",
                fn: () => {
                    if (Globals.menuBar && Globals.menuBar._hidden) {
                        Globals.menuBar.show();
                    }
                    return { success: true };
                }
            },

            hideTimeline: {
                doc: "Hide the timeline/controls bar at the bottom.",
                fn: () => {
                    if (!areControlsHidden()) {
                        toggleControlsVisibility();
                    }
                    return { success: true };
                }
            },

            showTimeline: {
                doc: "Show the timeline/controls bar at the bottom.",
                fn: () => {
                    if (areControlsHidden()) {
                        toggleControlsVisibility();
                    }
                    return { success: true };
                }
            },

            hideChrome: {
                doc: "Hide both the menu bar and the timeline for a clean embedded view.",
                fn: () => {
                    if (Globals.menuBar && !Globals.menuBar._hidden) {
                        Globals.menuBar.hide();
                    }
                    if (!areControlsHidden()) {
                        toggleControlsVisibility();
                    }
                    requestAnimationFrame(() => {
                        ViewMan.updateSize();
                    });
                    return { success: true };
                }
            },

            showChrome: {
                doc: "Show both the menu bar and the timeline.",
                fn: () => {
                    if (Globals.menuBar && Globals.menuBar._hidden) {
                        Globals.menuBar.show();
                    }
                    if (areControlsHidden()) {
                        toggleControlsVisibility();
                    }
                    requestAnimationFrame(() => {
                        ViewMan.updateSize();
                    });
                    return { success: true };
                }
            },

            toggleFullscreen: {
                doc: "Toggle browser fullscreen mode. If the browser is not in fullscreen, it will enter fullscreen. If it is already in fullscreen, it will exit.",
                fn: () => {
                    const entering = !isFullscreen();
                    if (entering) {
                        openFullscreen();
                    } else {
                        closeFullscreen();
                    }
                    return { success: true, fullscreen: entering };
                }
            },

            listLayoutTemplates: {
                doc: "List all available layout templates with descriptions.",
                fn: () => {
                    return {
                        templates: {
                            columns: "Equal-width vertical columns, one per view",
                            rows: "Equal-height horizontal rows, one per view",
                            leftWide: "Large left pane (2/3 width), remaining views stacked on the right",
                            rightWide: "Remaining views stacked on the left, large right pane (2/3 width)",
                            grid: "Auto-sized 2D grid (rows x cols chosen to fit N views)",
                            single: "First view takes full area, others hidden",
                        },
                        usage: "Call setLayout({template: 'columns', views: ['mainView','lookView','video']})"
                    };
                }
            },

            listTracks: {
                doc: "List all tracks currently loaded in the TrackManager.",
                fn: () => {
                    if (!TrackManager) return { error: "TrackManager not available" };
                    const tracks = [];
                    TrackManager.iterate((key, trackOb) => {
                        tracks.push({
                            id: key,
                            menuText: trackOb.menuText,
                            trackID: trackOb.trackID,
                            isSynthetic: !!trackOb.isSynthetic,
                        });
                    });
                    return { count: tracks.length, tracks };
                }
            },

            getTrackPosition: {
                doc: "Get the position (LLA) of a track node at a specific frame.",
                params: {
                    id: "Track node ID (string)",
                    frame: "Frame number (integer, optional, defaults to current frame)"
                },
                fn: (v) => {
                    const node = NodeMan.get(v.id);
                    if (!node) return { error: `Track node '${v.id}' not found` };
                    const f = v.frame ?? par.frame ?? 0;
                    try {
                        const val = node.getValue(f);
                        if (val && val.position) {
                            const result = {
                                frame: f,
                                position: { x: val.position.x, y: val.position.y, z: val.position.z },
                            };
                            if (val.lla) result.lla = { lat: val.lla.lat, lon: val.lla.lon, alt: val.lla.alt };
                            return result;
                        }
                        return { frame: f, value: String(val) };
                    } catch (e) {
                        return { error: e.message };
                    }
                }
            },

            listLoadedFiles: {
                doc: "List all files currently loaded in the FileManager.",
                fn: () => {
                    if (!FileManager) return { error: "FileManager not available" };
                    const files = [];
                    if (FileManager.list) {
                        FileManager.list.forEach((file, key) => {
                            files.push({ name: key, type: file.type || "unknown" });
                        });
                    }
                    return { count: files.length, files };
                }
            },

            importMedia: {
                doc: "Import a photo or video into the current video view.",
                params: {
                    file: "Media path, URL, or Sitrec reference (string)"
                },
                fn: async (v) => {
                    const source = this._normalizeMediaSource(v.file ?? v.filename ?? v.url);
                    if (!source) {
                        return { success: false, error: "Media file is required" };
                    }

                    const videoNode = this._getVideoImportNode();
                    if (!videoNode?.newVideo) {
                        return { success: false, error: "video node not found" };
                    }

                    const clearFrames = !Array.isArray(videoNode.videos) || videoNode.videos.length === 0;
                    videoNode.newVideo(source, clearFrames);
                    markSitchDirty();

                    return {
                        success: true,
                        imported: true,
                        pending: true,
                        file: source,
                    };
                }
            },

            undo: {
                doc: "Undo the last action.",
                fn: () => {
                    if (!UndoManager) return { error: "UndoManager not available" };
                    UndoManager.undo();
                    return { success: true };
                }
            },

            redo: {
                doc: "Redo the last undone action.",
                fn: () => {
                    if (!UndoManager) return { error: "UndoManager not available" };
                    UndoManager.redo();
                    return { success: true };
                }
            },

            getNotes: {
                doc: "Get the current notes text from the notes view.",
                fn: () => {
                    return this._getNotesState();
                }
            },

            setNotes: {
                doc: "Replace the current notes text.",
                params: {
                    text: "Notes text (string)"
                },
                fn: (v) => {
                    return this._setNotesText(v.text ?? "");
                }
            },

            updateNotes: {
                doc: "Update the current notes text using replace, append, or prepend mode.",
                params: {
                    mode: "Update mode: 'replace', 'append', or 'prepend' (string, optional, defaults to 'append')",
                    text: "Notes text to apply (string)"
                },
                fn: (v) => {
                    return this._updateNotesText(v.mode ?? "append", v.text);
                }
            },

            saveSitch: {
                doc: "Save the current sitch using the server-backed or local save flow.",
                params: {
                    target: "Save target: 'auto', 'server', or 'local' (string, optional, defaults to 'auto')",
                    name: "Optional sitch name to save as (string)"
                },
                fn: async (v) => {
                    return await this._saveSitch(v);
                }
            },

            getShareLink: {
                doc: "Get the current share link for the sitch, optionally saving first if needed.",
                params: {
                    saveIfNeeded: "If true, save the sitch first when no share link exists (boolean, optional)",
                    target: "Save target to use when saveIfNeeded is true: 'auto', 'server', or 'local' (string, optional, defaults to 'server')"
                },
                fn: async (v) => {
                    return await this._getShareLink(v);
                }
            },

            loadSitch: {
                doc: "Load a built-in or saved sitch by name.",
                params: {
                    name: "Sitch name or built-in sitch key (string)",
                    source: "Load source: 'auto', 'built-in', or 'saved' (string, optional, defaults to 'auto')",
                    sourceUserID: "Optional owner user ID for saved sitches (integer, optional)"
                },
                fn: async (v) => {
                    return await this._loadSitch(v);
                }
            },

            listSitches: {
                doc: "List available built-in sitches and any saved sitches visible in the current runtime.",
                fn: async () => {
                    return await this._listSitches();
                }
            },

            getSitchState: {
                doc: "Get the current sitch state including whether it has unsaved changes.",
                fn: () => {
                    return {
                        name: Sit?.name,
                        dirty: Globals.sitchDirty,
                        isCustom: Sit?.isCustom,
                        canMod: Sit?.canMod,
                    };
                }
            },

            exportSitchState: {
                doc: "Export the current sitch as full serialized JSON state.",
                params: {
                    local: "If true, export using local-save paths when available (boolean, optional, defaults to false)"
                },
                fn: (v) => {
                    return this._getSerializedSitchState(v);
                }
            },

            getNearbyWeatherBalloons: {
                doc: "Import the N nearest weather balloon (radiosonde) soundings to the camera position. "
                    + "Picks the most recent launch before the sitch start time + 1 hour.",
                params: {
                    count: "Number of nearby stations to import, 1-10 (default 1)",
                    source: "Data source: 'uwyo' (University of Wyoming, needs proxy) or 'igra2' (NOAA NCEI, direct) (default 'uwyo')",
                },
                fn: async (v) => {
                    const { getNearbyWeatherBalloons } = await import("./SondeFetch");
                    const count = v.count ?? 1;
                    const source = v.source ?? "uwyo";
                    return await getNearbyWeatherBalloons(count, source);
                }
            },

            compareSondeTrajectory: {
                doc: "Compare a wind-reconstructed sonde trajectory against GPS ground truth. "
                    + "Fetches the same sounding from UWYO in both CSV (GPS) and LIST (wind-only) formats, "
                    + "imports both as tracks, and computes error metrics. Requires the PHP proxy (not serverless).",
                params: {
                    station: "5-digit WMO station number (e.g. '72451' for Sterling VA)",
                    date: "Sounding date as YYYY-MM-DD",
                    hour: "UTC launch hour: 0 or 12 (default 12)",
                },
                fn: async (v) => {
                    const { compareSondeTrajectory } = await import("./SondeFetch");
                    const station = v.station;
                    const date = v.date;
                    const hour = v.hour ?? 12;
                    if (!station) throw new Error("station is required (5-digit WMO number)");
                    if (!date) throw new Error("date is required (YYYY-MM-DD)");
                    return await compareSondeTrajectory(station, date, hour);
                }
            },

        }

        this._menuDocCache = null;
    }

    // Ground altitude under a lat/lon, preferring the 3D tile surface.
    //
    // Straight down from 100 km: that clears the tallest tile geometry and any
    // terrain, and the ray runs along the ellipsoid normal so it lands on the
    // point directly beneath rather than a slanted neighbour. raycastLocalGround
    // tests the Google tiles FIRST and only falls back to the elevation map where
    // they miss — which matters, because a 30 m elevation grid smooths cliffs and
    // buildings away exactly where an observer is most likely to be standing.
    groundAltitudeAt(lat, lon) {
        const camNode = NodeMan.get("fixedCameraPosition", false);
        if (lat === undefined || lon === undefined) {
            if (!camNode) return {success: false, error: "no lat/lon given and no camera to take one from"};
            const lla = camNode._LLA;
            lat = lat ?? lla[0];
            lon = lon ?? lla[1];
        }
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
            return {success: false, error: "lat/lon must be finite numbers"};
        }

        const high = LLAToECEF(lat, lon, 100000);
        const down = getLocalUpVector(high).negate();
        const raycaster = new Raycaster(high, down, 0, 200000);
        // The tiles sit on the main/look layers, and raycastLocalGround widens the
        // mask to the camera's — so hand it a camera or the tiles are skipped.
        const camera = ViewMan.get("lookView", false)?.camera
            ?? ViewMan.get("mainView", false)?.camera;
        const hit = raycastLocalGround(raycaster, camera);
        if (!hit) return {success: false, error: "no ground found under that position"};

        const altHAE = altitudeHAE(hit.point);
        const geoid = meanSeaLevelOffset(lat, lon);
        return {
            success: true, lat, lon,
            altHAE, altMSL: altHAE - geoid, geoidOffset: geoid,
            // isTerrain is false only for the bare-ellipsoid fallback, i.e. nothing
            // was actually hit — worth reporting rather than passing off as ground.
            source: hit.isTerrain ? "tiles-or-terrain" : "ellipsoid-fallback",
        };
    }

    // ---- Fit Camera to Points helpers (see the fitPoints* API entries) ----

    _fitNode() {
        return NodeMan.get("fitCameraPoints", false);
    }

    /** The refusal every off-frame edit gets, matching the UI's onCorrectFrame gate. */
    _fitWrongFrame(fit) {
        return {success: false, error: `points belong to frame ${fit.fitFrame} and the current`
            + ` frame is ${Math.round(par.frame)} — setFrame back to ${fit.fitFrame} first`
            + ` (observations from different frames cannot share one camera solve)`};
    }

    /** One control point as the API reports it. Point altitude is stored as HAE (see CNodeFitCameraPoints). */
    _fitPointOut(p) {
        const geoid = meanSeaLevelOffset(p.lat, p.lon);
        return {id: p.id, vx: p.vx, vy: p.vy, lat: p.lat, lon: p.lon,
            altHAE: p.alt, altMSL: p.alt - geoid, color: p.color};
    }

    /**
     * The world half of a point pair from API args: lat/lon plus alt (HAE), altMSL, or — with
     * neither — the surface height at lat/lon. Returns null when no lat/lon was given, or
     * {success:false, error} when one was given but no altitude could be resolved.
     */
    _fitResolveWorld(v) {
        if (!Number.isFinite(v?.lat) || !Number.isFinite(v?.lon)) return null;
        if (Number.isFinite(v?.alt)) return {lat: v.lat, lon: v.lon, alt: v.alt};
        if (Number.isFinite(v?.altMSL)) {
            return {lat: v.lat, lon: v.lon, alt: v.altMSL + meanSeaLevelOffset(v.lat, v.lon)};
        }
        const ground = this.groundAltitudeAt(v.lat, v.lon);
        if (!ground.success) return {success: false, error: "no surface found at that lat/lon to take an altitude from — pass alt or altMSL"};
        return {lat: v.lat, lon: v.lon, alt: ground.altHAE};
    }

    /** Everything an agent needs to know about the fit tool's state, shared by several entries. */
    _fitSummary(fit) {
        const state = fit.currentCameraState();
        let camera = null;
        if (state) {
            const lla = ECEFToLLAVD_radii(new Vector3(state.position[0], state.position[1], state.position[2]));
            const geoid = meanSeaLevelOffset(lla.x, lla.y);
            camera = {lat: lla.x, lon: lla.y, altHAE: lla.z, altMSL: lla.z - geoid,
                azDeg: state.azDeg, elDeg: state.elDeg, rollDeg: state.rollDeg, vfovDeg: state.vfovDeg};
        }
        return {
            enabled: fit.enabled, useTiles: fit.useTiles, useObjects: fit.useObjects,
            autoFit: fit.autoFit,
            syncLookCamera: fit.syncLookCamera,
            fitMethod: fit.fitMethod, lockPosition: fit.lockPosition,
            lockFOV: fit.lockFOV, lockRoll: fit.lockRoll,
            fitFrame: fit.fitFrame, currentFrame: par.frame,
            status: fit.status, residual: fit.residual, observability: fit.observability,
            videoSize: fit.videoSize,
            points: fit.points.map((p) => this._fitPointOut(p)),
            camera,
        };
    }

    _extractControllerDoc(controller) {
        const doc = {
            name: controller._name,
            property: controller.property,
            type: controller.constructor.name.replace('Controller', '').toLowerCase(),
            tooltip: controller.domElement?.title || null,
            currentValue: controller.getValue()
        };

        if (controller._min !== undefined) doc.min = controller._min;
        if (controller._max !== undefined) doc.max = controller._max;
        if (controller._step !== undefined) doc.step = controller._step;
        if (controller._values) doc.options = controller._values;

        return doc;
    }

    _extractGUIDoc(gui) {
        const result = {
            name: gui._title,
            tooltip: gui.domElement?.title || null,
            controls: [],
            folders: []
        };

        for (const child of gui.children) {
            if (child instanceof GUI) {
                result.folders.push(this._extractGUIDoc(child));
            } else {
                result.controls.push(this._extractControllerDoc(child));
            }
        }
        return result;
    }

    getMenuDocumentation() {
        if (this._menuDocCache) return this._menuDocCache;

        const docs = {};
        for (const [menuId, gui] of Object.entries(guiMenus)) {
            docs[menuId] = this._extractGUIDoc(gui);
        }
        this._menuDocCache = docs;
        return docs;
    }

    _getControlSummary(gui, prefix = '') {
        const controls = [];
        for (const child of gui.children) {
            if (child instanceof GUI) {
                const title = sanitizeLabelForPrompt(child._title);
                controls.push(...this._getControlSummary(child, prefix + title + '/'));
            } else {
                const type = child.constructor.name.replace('Controller', '').toLowerCase();
                let info = `${prefix}${sanitizeLabelForPrompt(child._name)} (${type})`;
                if (child._min !== undefined && child._max !== undefined) {
                    info += ` [${child._min}-${child._max}]`;
                }
                if (child._values && child._values.length <= 5) {
                    info += ` options: ${child._values.map(v => sanitizeLabelForPrompt(v)).join('|')}`;
                }
                controls.push(info);
            }
        }
        return controls;
    }

    getMenuSummary() {
        const summary = {};
        for (const [menuId, gui] of Object.entries(guiMenus)) {
            const controls = this._getControlSummary(gui);
            if (controls.length > 0) {
                summary[menuId] = controls;
            }
        }
        return summary;
    }

    invalidateMenuDocCache() {
        this._menuDocCache = null;
    }

    _matchController(current, name, allowPartial = true) {
        const nameLower = name.toLowerCase();

        // Try exact match first
        let controller = current.controllers.find(c => c._name === name);
        if (controller) return controller;

        // Try case-insensitive match on display name
        controller = current.controllers.find(c => c._name.toLowerCase() === nameLower);
        if (controller) return controller;

        // Try match on property name
        controller = current.controllers.find(c => c.property === name);
        if (controller) return controller;

        // Try case-insensitive match on property
        controller = current.controllers.find(c => c.property && c.property.toLowerCase() === nameLower);
        if (controller) return controller;

        if (!allowPartial) return null;

        // Try partial match (name contains search term)
        controller = current.controllers.find(c =>
            c._name.toLowerCase().includes(nameLower) ||
            (c.property && c.property.toLowerCase().includes(nameLower))
        );
        return controller ?? null;
    }

    _matchFolder(current, name, remainingPath, allowPartial = true) {
        const folders = current.children.filter(c => c instanceof GUI);
        const nameLower = name.toLowerCase();
        const remainingLower = remainingPath.toLowerCase();

        let folder = folders.find(c => c._title === name);
        if (folder) return { folder, consumedParts: 1 };

        folder = folders.find(c => c._title.toLowerCase() === nameLower);
        if (folder) return { folder, consumedParts: 1 };

        const slashFolder = folders
            .filter(c => c._title.includes('/'))
            .sort((a, b) => b._title.length - a._title.length)
            .find(c =>
                remainingPath === c._title
                || remainingPath.startsWith(`${c._title}/`)
                || remainingLower === c._title.toLowerCase()
                || remainingLower.startsWith(`${c._title.toLowerCase()}/`)
            );
        if (slashFolder) {
            return {
                folder: slashFolder,
                consumedParts: slashFolder._title.split('/').length,
            };
        }

        if (!allowPartial) return null;

        folder = folders.find(c => c._title.toLowerCase().includes(nameLower));
        if (folder) return { folder, consumedParts: 1 };

        return null;
    }

    _findController(gui, path) {
        const parts = path.split('/');
        let current = gui;

        for (let i = 0; i < parts.length; i++) {
            const name = parts[i];
            const nameLower = name.toLowerCase();
            const isLast = i === parts.length - 1;
            const remainingPath = parts.slice(i).join('/');

            // Controller labels can themselves contain '/' (for example
            // "Features/Pins in Main"), so try the full remaining path before
            // interpreting the next '/' as a folder separator.
            const controllerWithSlash = this._matchController(current, remainingPath, !isLast);
            if (controllerWithSlash) {
                return { success: true, controller: controllerWithSlash };
            }

            if (isLast) {
                const controller = this._matchController(current, name, true);
                if (controller) return { success: true, controller };

                // List available controls in error
                const available = current.controllers.map(c => c._name).join(', ');
                return { success: false, error: `Control '${name}' not found. Available: ${available}` };
            } else {
                const folderMatch = this._matchFolder(current, name, remainingPath, true);
                if (!folderMatch) {
                    const available = current.children.filter(c => c instanceof GUI).map(c => c._title).join(', ');
                    return { success: false, error: `Folder '${name}' not found. Available: ${available}` };
                }

                current = folderMatch.folder;
                i += folderMatch.consumedParts - 1;
            }
        }
        return { success: false, error: 'Empty path' };
    }

    // Every control whose address loosely matches `path`, as fully qualified
    // "menu:Folder/Control" strings. A failed lookup carries these back so an agent
    // gets a real address to retry with instead of guessing a second time — which is
    // what turned one wrong menu id into six identical retries. Cheap enough to run
    // only on the failure path: it walks every menu once.
    _suggestControls(path, limit = 6) {
        // Scored on shared words rather than substrings, so a typo still finds the
        // control: "Annotate/Edt Mode" shares "annotate" and "mode" with
        // "video:Annotate/Edit Mode" and outscores everything that shares only one.
        const wanted = tokenizeControlAddress(path);
        if (wanted.length === 0) return [];
        const scored = [];
        const walk = (gui, menuId, trail) => {
            for (const c of gui.controllers) {
                const address = `${menuId}:${trail}${c._name ?? c.property ?? ""}`;
                const words = tokenizeControlAddress(address);
                const score = wanted.filter(t => words.some(w => nearWord(t, w))).length;
                if (score > 0) scored.push({address, score});
            }
            for (const child of gui.children) {
                if (child instanceof GUI) walk(child, menuId, trail + child._title + "/");
            }
        };
        for (const id of Object.keys(guiMenus)) {
            const gui = guiMenus[id];
            if (!gui || !gui.controllers) continue;
            walk(gui, id, "");
        }
        if (scored.length === 0) return [];
        // Only the joint best. A query of "Annotate/Edt Mode" matches "Edit Mode" on two
        // words and a dozen unrelated controls on the word "Mode" alone; listing those
        // too buries the answer the agent needs in noise it has to re-check.
        const best = Math.max(...scored.map(h => h.score));
        return scored
            .filter(h => h.score === best)
            .sort((a, b) => a.address.length - b.address.length)   // shortest, most direct first
            .slice(0, limit)
            .map(h => h.address);
    }

    // Attach near-miss addresses to a failed control lookup, in the error text (so it
    // survives a caller that only reads .error) and as a list (so one that reads the
    // object gets it structured).
    _withControlSuggestions(path, failure) {
        const suggestions = this._suggestControls(path);
        if (suggestions.length === 0) return failure;
        // _findController's messages end on a bare list, so punctuate before appending
        // or the two run together as "...Atmospheric Refraction Did you mean:".
        const stem = /[.?!]$/.test(failure.error) ? failure.error : failure.error + ".";
        return {
            ...failure,
            error: `${stem} Did you mean: ${suggestions.join(", ")}?`,
            suggestions,
        };
    }

    // Resolve (menuId, path) to a controller. With a falsy menuId, scan every
    // menu — recursing into folders — and return the first match, so callers
    // (e.g. the Scripted Video `set("Constellation Lines", false)` command) can
    // address a control by name alone without knowing where it lives. Exact
    // matches anywhere beat partial matches anywhere (two passes), so a loose
    // substring in an early menu can't shadow an exact name in a later one.
    _resolveControl(menuId, path) {
        // Accept the fully qualified "menu:Folder/Control" form that _suggestControls
        // hands back, so an agent can feed a suggestion straight into its next call. Without
        // this the suggestion is not valid input, and retrying it fails with the same
        // suggestion attached - a loop that looks like progress and never ends.
        // Split only on a prefix that really is a menu id, so a control name keeps its colons.
        if (typeof path === "string") {
            const colon = path.indexOf(":");
            if (colon > 0 && guiMenus[path.slice(0, colon)]) {
                menuId = path.slice(0, colon);
                path = path.slice(colon + 1);
            }
        }
        if (menuId) {
            const gui = guiMenus[menuId];
            if (!gui) {
                return this._withControlSuggestions(path, { success: false,
                    error: `Menu '${menuId}' not found. Menus: ${Object.keys(guiMenus).join(", ")}.` });
            }
            const r = this._findController(gui, path);
            if (r.success) return r;
            const obj = this._resolveObjectControl(path);
            if (obj) return obj;
            // The menu id is a hint, not a constraint. `menu` is documented as optional,
            // and a caller that supplies it can still guess wrong - the chatbot asked for
            // "Annotate/Edit Mode" in `view` when that folder lives in `video` - so fall
            // back to the all-menu scan before giving up. Only when that misses too do we
            // return the named menu's error, which lists what that menu does contain.
            const anywhere = this._resolveControl(null, path);
            return anywhere.success ? anywhere : this._withControlSuggestions(path, r);
        }
        const qualified = path.includes("/");
        if (qualified) {
            for (const id of Object.keys(guiMenus)) {
                const gui = guiMenus[id];
                if (!gui || !gui.controllers) continue;
                const r = this._findController(gui, path);
                if (r.success) return r;
            }
            return this._resolveObjectControl(path)
                || this._withControlSuggestions(path, { success: false,
                    error: `Control '${path}' not found in any menu or scene object.` });
        }
        // Unqualified: EXACT menu control wins; then an EXACT scene-object id (so an
        // object named "Viewer" isn't shadowed by a menu button merely CONTAINING
        // "Viewer"); then a partial menu match. set/show/hide and MCP setMenuValue
        // can thus toggle scene objects by id, not just menu controls.
        for (const id of Object.keys(guiMenus)) {
            const gui = guiMenus[id];
            if (!gui || !gui.controllers) continue;
            const c = this._deepFindController(gui, path, false);
            if (c) return { success: true, controller: c };
        }
        const obj = this._resolveObjectControl(path);
        if (obj) return obj;
        for (const id of Object.keys(guiMenus)) {
            const gui = guiMenus[id];
            if (!gui || !gui.controllers) continue;
            const c = this._deepFindController(gui, path, true);
            if (c) return { success: true, controller: c };
        }
        return this._withControlSuggestions(path, { success: false,
            error: `Control '${path}' not found in any menu or scene object.` });
    }

    // A 3D object node (by id) presented as a synthetic boolean controller backed
    // by its visibility, or null if `path` isn't a toggleable 3D object.
    _resolveObjectControl(path) {
        const node = NodeMan.get(path, false);

        // A light (CNode3DLight) presented as ONE control that takes either a boolean or
        // a brightness, so a script can address a light directly by node id:
        //     hide RedBow_ob_PointLight              turn it off
        //     set  WhiteStern_ob_PointLight 6000     ...and make it brilliant
        // rather than threading a nested menu path through the object folder, the Lights
        // folder and the model's internal light name. Reading back the intensity (0 when
        // off) means the scripted-settings snapshot/restore round-trips correctly.
        if (node && node.light && typeof node.setIntensity === "function") {
            return { success: true, controller: {
                object: node,
                initialValue: node.lightVisible ? node.light.intensity : 0,
                getValue: () => (node.lightVisible ? node.light.intensity : 0),
                setValue: (v) => {
                    if (typeof v === "boolean") { node.setLightVisible(v); return; }
                    const n = Number(v);
                    if (!isFinite(n)) return;
                    if (n > 0) node.setIntensity(n);
                    node.setLightVisible(n > 0);
                },
            }};
        }

        if (node && typeof node.show === "function" && node.group) {
            return { success: true, controller: {
                object: node,
                initialValue: !!node.visible,
                getValue: () => !!node.visible,
                setValue: (v) => node.show(!!v),
            }};
        }
        return null;
    }

    // depth-first search of a GUI and all its sub-folders for a control name
    _deepFindController(gui, name, allowPartial) {
        const c = this._matchController(gui, name, allowPartial);
        if (c) return c;
        for (const child of gui.children) {
            if (child instanceof GUI) {
                const r = this._deepFindController(child, name, allowPartial);
                if (r) return r;
            }
        }
        return null;
    }

    _setMenuValue(menuId, path, value) {
        const result = this._resolveControl(menuId, path);
        if (!result.success) return result;

        const controller = result.controller;
        try {
            let finalValue = value;
            
            // For dropdown controllers, match option values
            if (controller._values && Array.isArray(controller._values)) {
                const valueLower = String(value).toLowerCase();
                // Try exact match first
                if (!controller._values.includes(value)) {
                    // Try case-insensitive match
                    let matched = controller._values.find(v => String(v).toLowerCase() === valueLower);
                    if (!matched) {
                        return { success: false, error: `Value '${value}' not found. Options: ${controller._values.join(', ')}` };
                    }
                    finalValue = matched;
                }
            }
            
            controller.setValue(finalValue);
            this.invalidateMenuDocCache();
            return { success: true, oldValue: controller.initialValue, newValue: finalValue };
        } catch (e) {
            return { success: false, error: e?.message ?? String(e) };
        }
    }

    _getMenuValue(menuId, path) {
        const result = this._resolveControl(menuId, path);
        if (!result.success) return result;

        return { success: true, value: result.controller.getValue() };
    }

    _executeMenuButton(menuId, path) {
        // Same resolution as setMenuValue: the menu id is a hint, a miss falls back to
        // the all-menu scan, and a real failure comes back with near-miss addresses.
        const result = this._resolveControl(menuId, path);
        if (!result.success) return result;

        const controller = result.controller;
        if (controller.constructor.name !== 'FunctionController') {
            return { success: false, error: `Control '${path}' is not a button (it's a ${controller.constructor.name})` };
        }

        try {
            controller.getValue().call(controller.object);
            controller._callOnChange();
            return { success: true, executed: path };
        } catch (e) {
            return { success: false, error: e?.message ?? String(e) };
        }
    }

    _applyLayoutTemplate(templateName, viewNames) {
        // Coerce a single string to an array (LLMs often pass a string instead of an array)
        if (typeof viewNames === "string") {
            viewNames = [viewNames];
        }
        if (!viewNames || !Array.isArray(viewNames) || viewNames.length === 0) {
            return { success: false, error: "views must be a non-empty array of view IDs" };
        }

        // Validate all views exist
        const views = [];
        for (const name of viewNames) {
            const view = ViewMan.get(name, false);
            if (!view) return { success: false, error: `View '${name}' not found` };
            views.push({ name, view });
        }

        const n = views.length;

        // Clear fullscreen state
        ViewMan.setFullscreenView(null);
        ViewMan.iterate((id, v) => {
            if (v.doubled) {
                v.doubled = false;
                v.left = v.preDoubledLeft;
                v.top = v.preDoubledTop;
                if (v.width > 0) v.width = v.preDoubledWidth;
                if (v.height > 0) v.height = v.preDoubledHeight;
                v.updateWH();
            }
        });

        // Build position map from template
        let positions;
        switch (templateName) {
            case "columns": {
                // Equal-width columns
                const w = 1 / n;
                positions = views.map((v, i) => ({
                    name: v.name, visible: true,
                    left: i * w, top: 0, width: w, height: 1,
                }));
                break;
            }

            case "rows": {
                // Equal-height rows
                const h = 1 / n;
                positions = views.map((v, i) => ({
                    name: v.name, visible: true,
                    left: 0, top: i * h, width: 1, height: h,
                }));
                break;
            }

            case "leftWide": {
                // First view large on left, rest stacked on right
                if (n === 1) {
                    positions = [{ name: views[0].name, visible: true, left: 0, top: 0, width: 1, height: 1 }];
                } else {
                    const leftW = n <= 2 ? 0.5 : 2 / 3;
                    const rightW = 1 - leftW;
                    const rh = 1 / (n - 1);
                    positions = [
                        { name: views[0].name, visible: true, left: 0, top: 0, width: leftW, height: 1 },
                    ];
                    for (let i = 1; i < n; i++) {
                        positions.push({
                            name: views[i].name, visible: true,
                            left: leftW, top: (i - 1) * rh, width: rightW, height: rh,
                        });
                    }
                }
                break;
            }

            case "rightWide": {
                // Last view large on right, rest stacked on left
                if (n === 1) {
                    positions = [{ name: views[0].name, visible: true, left: 0, top: 0, width: 1, height: 1 }];
                } else {
                    const rightW = n <= 2 ? 0.5 : 2 / 3;
                    const leftW = 1 - rightW;
                    const lh = 1 / (n - 1);
                    positions = [];
                    for (let i = 0; i < n - 1; i++) {
                        positions.push({
                            name: views[i].name, visible: true,
                            left: 0, top: i * lh, width: leftW, height: lh,
                        });
                    }
                    positions.push({
                        name: views[n - 1].name, visible: true,
                        left: leftW, top: 0, width: rightW, height: 1,
                    });
                }
                break;
            }

            case "grid": {
                // Auto grid: choose cols/rows to be roughly square
                const cols = Math.ceil(Math.sqrt(n));
                const rows = Math.ceil(n / cols);
                const cw = 1 / cols;
                const rh = 1 / rows;
                positions = views.map((v, i) => ({
                    name: v.name, visible: true,
                    left: (i % cols) * cw, top: Math.floor(i / cols) * rh,
                    width: cw, height: rh,
                }));
                break;
            }

            case "single": {
                // First view fullscreen, others hidden
                positions = views.map((v, i) => ({
                    name: v.name,
                    visible: i === 0,
                    left: 0, top: 0, width: 1, height: 1,
                }));
                break;
            }

            default:
                return { success: false, error: `Unknown template '${templateName}'. Available: columns, rows, leftWide, rightWide, grid, single` };
        }

        // Apply positions
        for (const pos of positions) {
            ViewMan.updateViewFromPreset(pos.name, pos);
        }

        forceUpdateUIText();
        return { success: true, template: templateName, views: positions };
    }

    _normalizeMediaSource(source) {
        if (typeof source !== "string") return "";

        let normalized = source.trim();
        if (normalized.startsWith("!")) {
            normalized = normalized.substring(1);
        }
        if (normalized.startsWith("data/")) {
            normalized = normalized.substring(5);
        }

        return normalized;
    }

    _getVideoImportNode() {
        return NodeMan.get("video", false) ?? NodeMan.get("videoView", false);
    }

    _getNotesNode() {
        return NodeMan.get("notesView", false);
    }

    _syncNotesNode(notesView, text) {
        notesView.notesText = text;
        if (notesView.textArea) {
            notesView.textArea.value = text;
        }
        if (typeof notesView.linkifyContent === "function") {
            notesView.linkifyContent();
        }
    }

    _getNotesState() {
        const notesView = this._getNotesNode();
        if (!notesView) {
            return { success: false, error: "notesView node not found" };
        }

        return {
            success: true,
            text: notesView.notesText ?? "",
            visible: notesView.visible === true,
        };
    }

    _setNotesText(text) {
        const notesView = this._getNotesNode();
        if (!notesView) {
            return { success: false, error: "notesView node not found" };
        }

        const nextText = text == null ? "" : String(text);
        const previousText = notesView.notesText ?? "";
        this._syncNotesNode(notesView, nextText);
        if (previousText !== nextText) {
            markSitchDirty();
        }

        return {
            success: true,
            text: nextText,
            length: nextText.length,
        };
    }

    _updateNotesText(mode, text) {
        const notesView = this._getNotesNode();
        if (!notesView) {
            return { success: false, error: "notesView node not found" };
        }
        if (text === undefined) {
            return { success: false, error: "text is required" };
        }

        const currentText = notesView.notesText ?? "";
        const fragment = String(text);
        const normalizedMode = String(mode ?? "append").toLowerCase();
        const separator = currentText && fragment ? "\n\n" : "";

        let nextText;
        switch (normalizedMode) {
            case "replace":
                nextText = fragment;
                break;
            case "append":
                nextText = currentText + separator + fragment;
                break;
            case "prepend":
                nextText = fragment + separator + currentText;
                break;
            default:
                return { success: false, error: `Unknown update mode '${mode}'. Available: replace, append, prepend` };
        }

        this._syncNotesNode(notesView, nextText);
        if (currentText !== nextText) {
            markSitchDirty();
        }

        return {
            success: true,
            mode: normalizedMode,
            text: nextText,
            length: nextText.length,
        };
    }

    _canUseServerBackedSaves() {
        if (typeof FileManager?.hasServerBackedSaves === "function") {
            return FileManager.hasServerBackedSaves();
        }
        return !isServerless;
    }

    _normalizeSavedSitchNames(entries) {
        if (!Array.isArray(entries)) {
            return [];
        }

        const names = entries
            .map((entry) => Array.isArray(entry) ? entry[0] : entry?.name ?? entry)
            .filter((entry) => typeof entry === "string" && entry !== "-")
            .map((entry) => entry.trim())
            .filter(Boolean);

        return Array.from(new Set(names)).sort((a, b) => a.localeCompare(b));
    }

    _listBuiltInSitches() {
        if (!SitchMan?.iterate) {
            return [];
        }

        const builtIn = [];
        SitchMan.iterate((key, sitch) => {
            if (!sitch) {
                return;
            }
            builtIn.push({
                key,
                name: sitch.name ?? key,
                menuName: sitch.menuName ?? null,
                hidden: sitch.hidden === true,
                kind: "built-in",
            });
        });

        builtIn.sort((a, b) => a.name.localeCompare(b.name));
        return builtIn;
    }

    async _listSavedSitches() {
        const cached = this._normalizeSavedSitchNames(FileManager?.userSaves);
        const serverBackedSaves = this._canUseServerBackedSaves();

        if (!serverBackedSaves) {
            return { items: cached, serverBackedSaves: false };
        }

        if (cached.length > 0) {
            return { items: cached, serverBackedSaves: true };
        }

        if (typeof fetch !== "function") {
            return {
                items: cached,
                serverBackedSaves: true,
                error: "fetch is not available in this runtime",
            };
        }

        try {
            const response = await fetch(withTestUser(SITREC_SERVER + "getsitches.php?get=myfiles"), {mode: "cors"});
            if (!response.ok) {
                throw new Error(`Server returned status ${response.status}`);
            }
            const data = await response.text();
            const parsed = JSON.parse(data);
            return {
                items: this._normalizeSavedSitchNames(parsed),
                serverBackedSaves: true,
            };
        } catch (error) {
            return {
                items: cached,
                serverBackedSaves: true,
                error: error.message,
            };
        }
    }

    _findBuiltInSitch(name) {
        if (!name || !SitchMan) {
            return null;
        }

        if (typeof SitchMan.exists === "function" && SitchMan.exists(name)) {
            return { key: name, sitch: SitchMan.get(name) };
        }

        if (!SitchMan.iterate) {
            return null;
        }

        const nameLower = String(name).toLowerCase();
        let match = null;
        SitchMan.iterate((key, sitch) => {
            if (match || !sitch) {
                return;
            }

            const candidates = [key, sitch.name, sitch.menuName]
                .filter(Boolean)
                .map((value) => String(value));

            if (candidates.some((value) => value === name) || candidates.some((value) => value.toLowerCase() === nameLower)) {
                match = { key, sitch };
            }
        });

        return match;
    }

    _cloneSitchObject(sitchObject) {
        if (typeof structuredClone === "function") {
            return structuredClone(sitchObject);
        }

        try {
            return JSON.parse(JSON.stringify(sitchObject));
        } catch (error) {
            return { ...sitchObject };
        }
    }

    async _listSitches() {
        const builtIn = this._listBuiltInSitches();
        const saved = await this._listSavedSitches();

        return {
            success: true,
            builtIn,
            saved: saved.items,
            counts: {
                builtIn: builtIn.length,
                saved: saved.items.length,
            },
            current: {
                name: Sit?.name ?? null,
                sitchName: Sit?.sitchName ?? null,
            },
            serverBackedSaves: saved.serverBackedSaves,
            savedFetchError: saved.error,
        };
    }

    async _loadSitch({name, source = "auto", sourceUserID = null} = {}) {
        const sitchName = typeof name === "string" ? name.trim() : "";
        if (!sitchName) {
            return { success: false, error: "name is required" };
        }

        const normalizedSource = String(source).toLowerCase();
        if (!["auto", "built-in", "saved"].includes(normalizedSource)) {
            return { success: false, error: `Unknown source '${source}'. Available: auto, built-in, saved` };
        }

        const builtInMatch = this._findBuiltInSitch(sitchName);
        if (normalizedSource === "built-in" || (normalizedSource === "auto" && builtInMatch)) {
            if (!builtInMatch) {
                return { success: false, error: `Built-in sitch '${sitchName}' not found` };
            }

            if (typeof builtInMatch.sitch?.setup === "function" || typeof builtInMatch.sitch?.setup2 === "function") {
                return { success: false, error: `Built-in sitch '${sitchName}' has setup hooks that cannot be cloned. Use saved sitches instead.` };
            }

            setNewSitchObject(this._cloneSitchObject(builtInMatch.sitch));
            return {
                success: true,
                source: "built-in",
                key: builtInMatch.key,
                name: builtInMatch.sitch?.name ?? sitchName,
                pending: true,
            };
        }

        if (!this._canUseServerBackedSaves()) {
            return { success: false, error: "Saved sitch loading is not available in this runtime" };
        }
        if (typeof FileManager?.loadSavedFile !== "function") {
            return { success: false, error: "FileManager saved sitch loader is not available" };
        }

        FileManager.loadSavedFile(sitchName, sourceUserID ?? null);
        return {
            success: true,
            source: "saved",
            name: sitchName,
            sourceUserID: sourceUserID ?? null,
            pending: true,
        };
    }

    async _saveSitch({target = "auto", name} = {}) {
        if (!FileManager) {
            return { success: false, error: "FileManager not available" };
        }

        const normalizedTarget = String(target).toLowerCase();
        if (!["auto", "server", "local"].includes(normalizedTarget)) {
            return { success: false, error: `Unknown save target '${target}'. Available: auto, server, local` };
        }

        const trimmedName = typeof name === "string" ? name.trim() : undefined;
        if (trimmedName === "") {
            return { success: false, error: "name cannot be empty" };
        }

        const canServerSave = this._canUseServerBackedSaves();
        const saveLocally = normalizedTarget === "local" || (normalizedTarget === "auto" && !canServerSave);

        if (!saveLocally && !canServerSave) {
            return { success: false, error: "Server-backed saves are not available in this runtime" };
        }

        const effectiveName = trimmedName ?? Sit?.sitchName;
        if (!effectiveName) {
            return { success: false, error: "name is required when the sitch has not been previously saved" };
        }

        if (trimmedName) {
            Sit.sitchName = trimmedName;
        }

        try {
            if (saveLocally) {
                if (typeof FileManager.saveSitchNamed === "function") {
                    await FileManager.saveSitchNamed(effectiveName, true, null, null);
                } else if (typeof FileManager.saveLocal === "function") {
                    const ok = await FileManager.saveLocal({recordAction: false});
                    if (!ok) {
                        return { success: false, error: "Local save was cancelled or failed" };
                    }
                } else {
                    return { success: false, error: "No local save flow is available" };
                }
            } else if (typeof FileManager.saveSitchNamed === "function") {
                await FileManager.saveSitchNamed(effectiveName, false, null, null);
            } else {
                return { success: false, error: "No server save flow is available" };
            }
        } catch (error) {
            return { success: false, error: error.message ?? String(error) };
        }

        return {
            success: true,
            target: saveLocally ? "local" : "server",
            name: Sit?.sitchName ?? trimmedName ?? Sit?.name ?? null,
            dirty: Globals.sitchDirty === true,
            shareLink: CustomManager?.customLink ?? null,
        };
    }

    async _getShareLink({saveIfNeeded = false, target = "server"} = {}) {
        if (!CustomManager) {
            return { success: false, error: "CustomManager not available" };
        }

        const needsSave = !CustomManager.customLink || Globals.sitchDirty;

        if (needsSave && saveIfNeeded) {
            const saveResult = await this._saveSitch({target});
            if (!saveResult.success) {
                return saveResult;
            }
        }

        if (!CustomManager.customLink) {
            return {
                success: false,
                error: isServerless
                    ? "No share link is available in serverless mode. Save to a server-backed sitch first."
                    : "No share link is available yet. Save the sitch first.",
            };
        }

        return {
            success: true,
            url: CustomManager.customLink,
            dirty: Globals.sitchDirty === true,
        };
    }

    _getSerializedSitchState({local = false} = {}) {
        if (typeof CustomManager?.getCustomSitchString !== "function") {
            return { success: false, error: "CustomManager serialization is not available" };
        }

        try {
            const serialized = CustomManager.getCustomSitchString(local === true);
            return {
                success: true,
                state: JSON.parse(serialized),
                name: Sit?.name ?? null,
                dirty: Globals.sitchDirty === true,
                isCustom: Sit?.isCustom === true,
                canMod: Sit?.canMod === true,
            };
        } catch (error) {
            return {
                success: false,
                error: error.message ?? String(error),
                name: Sit?.name ?? null,
                dirty: Globals.sitchDirty === true,
                isCustom: Sit?.isCustom === true,
                canMod: Sit?.canMod === true,
            };
        }
    }

    _normalizeSynthType(type) {
        const t = String(type || "").toLowerCase();
        if (["building", "buildings", "synthbuilding", "synthbuildings"].includes(t)) return "building";
        if (["cloud", "clouds", "synthclouds", "cloudlayer", "cloudlayers"].includes(t)) return "clouds";
        if (["overlay", "overlays", "groundoverlay", "groundoverlays"].includes(t)) return "overlay";
        if (t === "all" || t === "") return "all";
        return null;
    }

    _requireSynthManager() {
        if (!Synth3DManager) {
            throw new Error("Synth3DManager is not available");
        }
    }

    _getSynthElement(type, id) {
        this._requireSynthManager();
        const normalized = this._normalizeSynthType(type);
        if (normalized === "building") return Synth3DManager.getBuilding(id);
        if (normalized === "clouds") return Synth3DManager.getClouds(id);
        if (normalized === "overlay") return Synth3DManager.getOverlay(id);
        return null;
    }

    _getSynthElementID(element) {
        return element?.buildingID || element?.cloudsID || element?.overlayID || element?.id || null;
    }

    _serializeSynthElement(element) {
        if (!element) return null;
        const serialized = element.serialize ? element.serialize() : { ...element };
        return {
            ...serialized,
            id: serialized.id || this._getSynthElementID(element),
            editMode: element.editMode === true,
        };
    }

    _closeSynthEditMenus() {
        if (Globals.editingBuilding?.setEditMode) Globals.editingBuilding.setEditMode(false);
        if (Globals.editingClouds?.setEditMode) Globals.editingClouds.setEditMode(false);
        if (Globals.editingOverlay?.setEditMode) Globals.editingOverlay.setEditMode(false);

        for (const key of ["groundContextMenu", "buildingEditMenu", "cloudsEditMenu", "overlayEditMenu"]) {
            if (CustomManager[key]?.destroy) CustomManager[key].destroy();
            CustomManager[key] = null;
        }
    }

    _metersToLatLonOffset(lat, northMeters, eastMeters) {
        const metersPerDegLat = 111320;
        const metersPerDegLon = 111320 * Math.cos(Number(lat) * Math.PI / 180);
        return {
            dLat: northMeters / metersPerDegLat,
            dLon: eastMeters / metersPerDegLon,
        };
    }

    _buildingCornersFromCenter({lat, lon, width = 15, depth = width, headingDeg = 0}) {
        if (lat === undefined || lon === undefined) {
            throw new Error("lat and lon are required when cornerLatLons is not provided");
        }
        const centerLat = Number(lat);
        const centerLon = Number(lon);
        const halfWidth = Number(width) / 2;
        const halfDepth = Number(depth) / 2;
        const heading = Number(headingDeg || 0) * Math.PI / 180;
        const cos = Math.cos(heading);
        const sin = Math.sin(heading);

        return [
            [-halfDepth, -halfWidth],
            [ halfDepth, -halfWidth],
            [ halfDepth,  halfWidth],
            [-halfDepth,  halfWidth],
        ].map(([north, east]) => {
            const rotatedNorth = north * cos - east * sin;
            const rotatedEast = north * sin + east * cos;
            const {dLat, dLon} = this._metersToLatLonOffset(centerLat, rotatedNorth, rotatedEast);
            return {lat: centerLat + dLat, lon: centerLon + dLon};
        });
    }

    _overlayBoundsFromCenter({lat, lon, width = 1000, depth = width}) {
        if (lat === undefined || lon === undefined) {
            throw new Error("lat and lon are required when overlay bounds are not provided");
        }
        const centerLat = Number(lat);
        const centerLon = Number(lon);
        const northSouth = this._metersToLatLonOffset(centerLat, Number(depth) / 2, 0).dLat;
        const eastWest = this._metersToLatLonOffset(centerLat, 0, Number(width) / 2).dLon;
        return {
            north: centerLat + northSouth,
            south: centerLat - northSouth,
            east: centerLon + eastWest,
            west: centerLon - eastWest,
        };
    }

    _listSynthElements(type = "all", includeSerialized = true) {
        this._requireSynthManager();
        const normalized = this._normalizeSynthType(type);
        if (!normalized) return { success: false, error: `Unknown synth type '${type}'` };

        const collect = (kind) => {
            const items = [];
            if (kind === "building") {
                Synth3DManager.iterate((id, building) => {
                    items.push(includeSerialized ? this._serializeSynthElement(building) : {id, name: building.name, visible: building.visible});
                });
            } else if (kind === "clouds") {
                Synth3DManager.iterateClouds((id, clouds) => {
                    items.push(includeSerialized ? this._serializeSynthElement(clouds) : {id, name: clouds.name, visible: clouds.visible});
                });
            } else if (kind === "overlay") {
                Synth3DManager.iterateOverlays((id, overlay) => {
                    items.push(includeSerialized ? this._serializeSynthElement(overlay) : {id, name: overlay.name, visible: overlay.visible});
                });
            }
            return items;
        };

        if (normalized !== "all") {
            const elements = collect(normalized);
            return { success: true, type: normalized, count: elements.length, elements };
        }

        const buildings = collect("building");
        const clouds = collect("clouds");
        const overlays = collect("overlay");
        return {
            success: true,
            count: buildings.length + clouds.length + overlays.length,
            buildings,
            clouds,
            overlays,
        };
    }

    _setVisibilityIfProvided(element, visible) {
        if (visible === undefined) return;
        if (element.show) element.show(visible);
        else element.visible = visible;
    }

    _createSynthBuilding(v = {}) {
        try {
            this._requireSynthManager();
            this._closeSynthEditMenus();
            const cornerLatLons = Array.isArray(v.cornerLatLons)
                ? v.cornerLatLons.map(c => ({lat: Number(c.lat), lon: Number(c.lon)}))
                : this._buildingCornersFromCenter(v);

            const building = Synth3DManager.addBuilding({
                id: v.id,
                name: v.name,
                visible: v.visible,
                cornerLatLons,
                roofAGL: Number(v.roofAGL ?? v.height ?? 4),
                rooflineHeightAGL: Number(v.rooflineHeightAGL ?? 0),
                ridgelineInset: Number(v.ridgelineInset ?? 0),
                roofEaves: Number(v.roofEaves ?? 0),
                material: v.material,
                wallColor: v.wallColor ?? v.color,
                roofColor: v.roofColor,
                opacity: v.opacity,
                transparent: v.transparent,
                depthTest: v.depthTest,
                wireframe: v.wireframe,
            });
            this._setVisibilityIfProvided(building, v.visible);
            if (v.editMode === true) building.setEditMode(true);
            else this._closeSynthEditMenus();
            par.renderOne = true;
            return { success: true, type: "building", id: building.buildingID, element: this._serializeSynthElement(building) };
        } catch (e) {
            return { success: false, error: e.message ?? String(e) };
        }
    }

    _createSynthClouds(v = {}) {
        try {
            this._requireSynthManager();
            this._closeSynthEditMenus();
            const centerLat = v.centerLat ?? v.lat;
            const centerLon = v.centerLon ?? v.lon;
            if (centerLat === undefined || centerLon === undefined) {
                return { success: false, error: "centerLat/centerLon or lat/lon are required" };
            }
            const clouds = Synth3DManager.addClouds({
                ...v,
                centerLat: Number(centerLat),
                centerLon: Number(centerLon),
            });
            this._setVisibilityIfProvided(clouds, v.visible);
            if (v.editMode === true) clouds.setEditMode(true);
            else this._closeSynthEditMenus();
            par.renderOne = true;
            return { success: true, type: "clouds", id: clouds.cloudsID, element: this._serializeSynthElement(clouds) };
        } catch (e) {
            return { success: false, error: e.message ?? String(e) };
        }
    }

    _createSynthOverlay(v = {}) {
        try {
            this._requireSynthManager();
            this._closeSynthEditMenus();
            const hasBounds = v.north !== undefined && v.south !== undefined && v.east !== undefined && v.west !== undefined;
            const bounds = hasBounds ? {
                north: Number(v.north),
                south: Number(v.south),
                east: Number(v.east),
                west: Number(v.west),
            } : this._overlayBoundsFromCenter(v);

            const overlay = Synth3DManager.addOverlay({
                ...v,
                ...bounds,
                rotation: Number(v.rotation ?? 0),
            });
            this._setVisibilityIfProvided(overlay, v.visible);
            if (v.editMode === true) overlay.setEditMode(true);
            else this._closeSynthEditMenus();
            par.renderOne = true;
            return { success: true, type: "overlay", id: overlay.overlayID, element: this._serializeSynthElement(overlay) };
        } catch (e) {
            return { success: false, error: e.message ?? String(e) };
        }
    }

    _updateSynthElement(type, id, patch = {}) {
        try {
            this._requireSynthManager();
            const normalized = this._normalizeSynthType(type);
            const element = this._getSynthElement(normalized, id);
            if (!element) return { success: false, error: `Synth ${type} '${id}' not found` };

            if (normalized === "building") {
                if (Array.isArray(patch.cornerLatLons)) {
                    element.cornerLatLons = patch.cornerLatLons.map(c => ({lat: Number(c.lat), lon: Number(c.lon)}));
                } else if (patch.lat !== undefined || patch.lon !== undefined || patch.width !== undefined || patch.depth !== undefined || patch.headingDeg !== undefined) {
                    const serialized = element.serialize();
                    const corners = serialized.cornerLatLons || [];
                    const centerLat = patch.lat ?? (corners.reduce((sum, c) => sum + c.lat, 0) / Math.max(corners.length, 1));
                    const centerLon = patch.lon ?? (corners.reduce((sum, c) => sum + c.lon, 0) / Math.max(corners.length, 1));
                    if (patch.width === undefined && patch.depth === undefined && patch.size === undefined && patch.headingDeg === undefined && corners.length === 4) {
                        const oldCenterLat = corners.reduce((sum, c) => sum + c.lat, 0) / corners.length;
                        const oldCenterLon = corners.reduce((sum, c) => sum + c.lon, 0) / corners.length;
                        element.cornerLatLons = corners.map(c => ({
                            lat: c.lat + centerLat - oldCenterLat,
                            lon: c.lon + centerLon - oldCenterLon,
                        }));
                    } else {
                        element.cornerLatLons = this._buildingCornersFromCenter({
                            lat: centerLat,
                            lon: centerLon,
                            width: patch.width ?? patch.size ?? 15,
                            depth: patch.depth ?? patch.width ?? patch.size ?? 15,
                            headingDeg: patch.headingDeg ?? 0,
                        });
                    }
                }

                const directFields = ["name", "rooflineHeightAGL", "ridgelineInset", "roofEaves", "materialOpacity", "materialTransparent", "materialDepthTest", "materialWireframe"];
                directFields.forEach(field => {
                    if (patch[field] !== undefined) element[field] = patch[field];
                });
                if (patch.roofAGL !== undefined || patch.height !== undefined) element.roofAGL = Number(patch.roofAGL ?? patch.height);
                if (patch.material !== undefined) element.materialType = patch.material;
                if (patch.wallColor !== undefined || patch.color !== undefined) element.wallColor = patch.wallColor ?? patch.color;
                if (patch.roofColor !== undefined) element.roofColor = patch.roofColor;
                if (patch.opacity !== undefined) element.materialOpacity = Number(patch.opacity);
                if (patch.transparent !== undefined) element.materialTransparent = patch.transparent;
                if (patch.depthTest !== undefined) element.materialDepthTest = patch.depthTest;
                if (patch.wireframe !== undefined) element.materialWireframe = patch.wireframe;
                this._setVisibilityIfProvided(element, patch.visible);
                element.recalculateVerticesFromTerrain();
                element.buildMesh();
                element.updateGUIControllers();
            } else if (normalized === "clouds") {
                Object.assign(element, patch);
                if (patch.lat !== undefined) element.centerLat = patch.lat;
                if (patch.lon !== undefined) element.centerLon = patch.lon;
                this._setVisibilityIfProvided(element, patch.visible);
                element.buildCloudMesh();
                element.updateGUIControllers();
            } else if (normalized === "overlay") {
                const boundsPatch = (patch.north !== undefined || patch.south !== undefined || patch.east !== undefined || patch.west !== undefined)
                    ? {}
                    : ((patch.lat !== undefined || patch.lon !== undefined || patch.width !== undefined || patch.depth !== undefined) ? this._overlayBoundsFromCenter({
                        lat: patch.lat ?? (element.north + element.south) / 2,
                        lon: patch.lon ?? (element.east + element.west) / 2,
                        width: patch.width,
                        depth: patch.depth,
                    }) : {});
                Object.assign(element, patch, boundsPatch);
                this._setVisibilityIfProvided(element, patch.visible);
                element.updateMesh();
                element.updateGUIControllers();
            } else {
                return { success: false, error: `Unknown synth type '${type}'` };
            }

            if (patch.editMode === true && element.setEditMode) element.setEditMode(true);
            if (patch.editMode === false && element.setEditMode) element.setEditMode(false);
            par.renderOne = true;
            return { success: true, type: normalized, id: this._getSynthElementID(element), element: this._serializeSynthElement(element) };
        } catch (e) {
            return { success: false, error: e.message ?? String(e) };
        }
    }

    _deleteSynthElement(type, id) {
        try {
            this._requireSynthManager();
            const normalized = this._normalizeSynthType(type);
            if (normalized === "building") {
                if (!Synth3DManager.getBuilding(id)) return { success: false, type: normalized, id, error: "Building not found" };
                Synth3DManager.removeBuilding(id);
            } else if (normalized === "clouds") {
                if (!Synth3DManager.getClouds(id)) return { success: false, type: normalized, id, error: "Cloud layer not found" };
                Synth3DManager.removeClouds(id);
            } else if (normalized === "overlay") {
                if (!Synth3DManager.getOverlay(id)) return { success: false, type: normalized, id, error: "Overlay not found" };
                Synth3DManager.removeOverlay(id);
            } else {
                return { success: false, error: `Unknown synth type '${type}'` };
            }
            this._closeSynthEditMenus();
            par.renderOne = true;
            return { success: true, type: normalized, id };
        } catch (e) {
            return { success: false, type, id, error: e.message ?? String(e) };
        }
    }

    getDocumentation() {
        return this._documentationFor(() => true);
    }

    // LLM-facing documentation: the same as getDocumentation() but with entries flagged
    // `llmCallable:false` removed, so JS-executing functions are never advertised to the
    // chatbot's tool builder (client buildTools + server chatbot.php). This is the
    // "advertise" half of the B1 ACE mitigation; the "enforce" half is in handleAPICall.
    getLLMDocumentation() {
        return this._documentationFor((value) => value.llmCallable !== false);
    }

    _documentationFor(predicate) {
        return Object.entries(this.api).reduce((acc, [key, value]) => {
            if (!predicate(value)) return acc;
            let paramsString = Object.entries(value.params || {})
                .map(([param, desc]) => `${param} (${desc})`)
                .join(", ");
            let docString = value.doc || "No documentation available.";
            acc[key] = `${docString} Parameters: ${paramsString}`;
            return acc;
        }, {});
    }

    getFullDocumentation() {
        return {
            api: this.getDocumentation(),
            menus: this.getMenuDocumentation(),
            menuIds: Object.keys(guiMenus)
        };
    }

    // Coerce LLM-provided arguments to match expected types from param descriptions.
    // LLMs frequently pass numbers as strings ("45.5" instead of 45.5) or booleans
    // as strings ("true" instead of true).
    _coerceArgs(args, params) {
        if (!args || !params) return args;
        const coerced = { ...args };
        for (const [key, desc] of Object.entries(params)) {
            if (coerced[key] === undefined) continue;
            const d = desc.toLowerCase();
            if (d.includes('float') || d.includes('number') || /\bint(eger)?\b/.test(d)) {
                const n = Number(coerced[key]);
                if (!isNaN(n)) coerced[key] = n;
            } else if (d.includes('bool')) {
                if (coerced[key] === "true") coerced[key] = true;
                else if (coerced[key] === "false") coerced[key] = false;
            } else if (d.includes('array')) {
                if (typeof coerced[key] === "string") coerced[key] = [coerced[key]];
            }
        }
        return coerced;
    }

    // When the loaded sitch came from an untrusted channel (see src/SitchProvenance.js), the
    // model's context contains text a stranger wrote — Notes, track names, object titles. The
    // boundary that matters is therefore not what the model READS but what it can DO.
    //
    // Reads run untouched, so the workflow this exists to protect — open a shared recreation
    // and ask the assistant about it — gains no friction at all. Anything that changes saved
    // state or sends data outward asks once.
    //
    // Returns a refusal result to hand back to the model, or null to proceed.
    async _confirmWriteInExternalSitch(call, source = "chat") {
        if (!isSitchExternal()) return null;
        if (CHAT_READ_ONLY_CALLS.has(call.fn)) return null;

        const sourceLabel = getSitchSourceLabel();
        const choice = await showChoice(
            `The assistant wants to run "${call.fn}", which changes saved state or sends data.\n\n`
            + `This sitch was loaded from somewhere else`
            + (sourceLabel ? `:\n${sourceLabel}\n\n` : `.\n\n`)
            + `Its notes and labels were written by whoever shared it, so the request may have `
            + `come from that text rather than from you. Reading and analysing it is unaffected `
            + `either way.`,
            {
                title: "Allow this change?",
                options: [
                    {label: "Allow once", value: "once"},
                    // The escape hatch lives here, where the friction is, rather than as a
                    // setting nobody finds. It consents to CAPABILITY, which is a real
                    // decision — unlike consenting to reading, which people click through
                    // because reading is why they opened the sitch.
                    {label: "Trust this sitch", value: "trust"},
                    {label: "Don't allow", value: "deny", cancel: true},
                ],
            }
        );

        if (choice === "trust") {
            trustCurrentSitch();
            return null;
        }
        if (choice === "once") return null;

        console.warn(`Declined ${source}-sourced "${call.fn}" in an externally-sourced sitch.`);
        return {
            success: false,
            fn: call.fn,
            // Phrased so the model reports it and stops, rather than retrying around it.
            error: `The user declined "${call.fn}". This sitch came from an external source, so `
                + `changes need confirmation. Do not retry; tell the user what you were trying to do.`,
        };
    }

    // source: "ui" (default, trusted — UI buttons and programmatic call())
    //         "chat" (untrusted — issued by the LLM/chatbot, subject to prompt injection)
    //         "webmcp" (untrusted — issued by a model through browser site tools)
    //         "mcp"  (a trusted external agent driving the page through SitrecBridge).
    // Untrusted model calls are refused for any entry tagged llmCallable:false, so a guessed
    // name cannot reach a JS-executing function even though it was never advertised.
    //
    // For all agent sources this is also the single place that decides where a failure
    // is PRESENTED. An agent's mistake — a control that does not exist, a missing argument,
    // a function it invented — is correctable, so every failure exit below carries enough
    // detail for it to fix the call and retry: near-miss suggestions for a bad name, the
    // parameter list for a throw. No agent failure raises a dialog: showError is redirected
    // into `captured` for the duration of the call, and whatever it collected comes back in
    // the result. See AGENT_SOURCES, Globals.errorDialogSinks, and _runAttributed.
    async handleAPICall(call, source = "ui") {
        console.log("Handling API call:", call);
        const apiFn = this.api[call.fn];
        if (!apiFn) {
            return {
                success: false,
                fn: call.fn,
                error: `Unknown API function: ${call.fn}`,
                suggestions: this._suggestFunctions(call.fn),
            };
        }
        if (UNTRUSTED_MODEL_SOURCES.has(source) && apiFn.llmCallable === false) {
            console.warn(`Refusing ${source}-sourced call to non-LLM-callable function: ${call.fn}`);
            return {
                success: false,
                fn: call.fn,
                error: `Function ${call.fn} is not callable from chat or WebMCP`,
            };
        }
        if (UNTRUSTED_MODEL_SOURCES.has(source)) {
            const refusal = refuseExternalURLParams(call, source);
            if (refusal) return refusal;

            const denied = await this._confirmWriteInExternalSitch(call, source);
            if (denied) return denied;
        }

        // A live sink added to a set, not a global slot saved and restored around the
        // call. Agent calls overlap in practice — the MCP bridge answers each request
        // independently, and a chat turn can be in flight beside one — and with
        // save/restore whichever finished first put ITS value back, disarming the hook
        // while another call was still running and then leaving it pointing at a dead
        // array for the rest of the session, silently eating every dialog the user was
        // owed. Membership carries no such ordering assumption.
        //
        // A non-empty set also means an already-agent-driven context, so a nested call
        // stays captured whatever source it claims.
        const agent = AGENT_SOURCES.has(source) || Globals.errorDialogSinks.size > 0;
        const captured = [];
        // Non-null only when this call was made from inside another handler's synchronous
        // body, i.e. real nesting with the parent on the stack - not the accidental overlap
        // of two independent calls. See the finally block.
        const parent = Globals.errorDialogTarget;
        if (agent) Globals.errorDialogSinks.add(captured);
        try {
            const args = this._coerceArgs(call.args, apiFn.params);
            const result = await this._runAttributed(apiFn.fn, args, agent ? captured : null);
            // A function that returned {success:false} failed, even though it did not
            // throw. Say so at the top level too. The MCP bridge hands this whole object
            // to the agent, and an outer success:true wrapping an inner failure reads as
            // "it worked" — which is how a wrong menu id turned into six silent retries.
            const innerFailed = result !== null && typeof result === "object" && result.success === false;
            const out = {
                success: !innerFailed,
                fn: call.fn,
                result: UNTRUSTED_MODEL_SOURCES.has(source)
                    ? this._fenceUntrustedResultFields(call.fn, result)
                    : result,
            };
            if (innerFailed) out.error = result.error ?? `${call.fn} failed`;
            if (captured.length) out.errorDialogs = captured;
            return out;
        } catch (e) {
            // Give the agent what it needs to repair the call itself: what threw, and
            // the parameters this function actually takes.
            const out = { success: false, fn: call.fn, error: e.message };
            if (apiFn.params) out.expected = apiFn.params;
            if (captured.length) out.errorDialogs = captured;
            return out;
        } finally {
            // Removes exactly this call's array. Any other call still running keeps its own.
            if (agent) {
                Globals.errorDialogSinks.delete(captured);
                // A nested call's dialogs belong to the call that made it as well, since the
                // agent only ever sees the outermost result and the inner one is consumed
                // internally. Copied up the stack we actually have, never sideways to a call
                // that merely happened to be running at the same time.
                if (parent) parent.push(...captured);
            }
        }
    }

    // Run a handler with its SYNCHRONOUS body attributed to `sink`, so an error dialog it
    // raises before its first await lands on this call and not on whatever else happens to
    // be in flight. Almost every handler is synchronous throughout, so almost every dialog
    // is attributed exactly.
    //
    // Save-and-restore is correct here where it was not for the sink set: fn(args) runs to
    // its first await or its return with nothing else able to interleave, so unwinding
    // really is last-in-first-out. Deliberately NOT awaited inside - awaiting would extend
    // the window across the handler's own awaits and reintroduce the ordering bug.
    _runAttributed(fn, args, sink) {
        const previous = Globals.errorDialogTarget;
        Globals.errorDialogTarget = sink;
        try {
            return fn(args);
        } finally {
            Globals.errorDialogTarget = previous;
        }
    }

    // API function names close to `name`, returned with an "unknown function" error so an
    // agent that guessed gets the real spelling back instead of a dead end.
    _suggestFunctions(name, limit = 8) {
        const names = Object.keys(this.api);
        const wanted = String(name ?? "").toLowerCase();
        if (!wanted) return names.slice(0, limit);
        const hits = names.filter(k => {
            const kl = k.toLowerCase();
            return kl.includes(wanted) || wanted.includes(kl);
        });
        if (hits.length) return hits.slice(0, limit);
        // No substring overlap: fall back to a shared opening, which catches most typos.
        const head = wanted.slice(0, 4);
        return names.filter(k => k.toLowerCase().startsWith(head)).slice(0, limit);
    }

    // Some tool results carry free text that came from the sitch rather than from the user —
    // sitch Notes above all, which in a shared sitch are whatever the sender typed. Wrap those
    // fields so the model reads them as material, not as instructions.
    //
    // Applied to untrusted model calls only: a UI or MCP caller wants the raw value, and
    // fencing it there would corrupt what the app itself displays.
    _fenceUntrustedResultFields(fn, result) {
        const fields = CHAT_FENCED_RESULT_FIELDS[fn];
        if (!fields || !result || typeof result !== "object") return result;
        const out = {...result};
        for (const field of fields) {
            if (typeof out[field] === "string" && out[field].length > 0) {
                out[field] = fenceUntrustedText(out[field], "sitch notes");
            }
        }
        return out;
    }

    callChangesSerializedState(call, apiResult) {
        if (!call?.fn || !apiResult?.success) {
            return false;
        }

        const nestedResult = apiResult.result;
        if (nestedResult && typeof nestedResult === "object" && nestedResult.success === false) {
            return false;
        }

        const transientCalls = TRANSIENT_CALLS;

        return !transientCalls.has(call.fn);
    }

    // A pure action batch that fully succeeds can be acknowledged locally; a query/result
    // call must go back to the model so it can use the returned value.
    callNeedsModelResult(callOrName) {
        const name = typeof callOrName === "string" ? callOrName : callOrName?.fn;
        return Boolean(name) && CHAT_MODEL_RESULT_CALLS.has(name);
    }

    call(fn, args = {}) {
        return this.handleAPICall({fn, args});
    }

}

export const sitrecAPI = new CSitrecAPI();

// Expose to window for SitrecBridge MCP access
if (typeof window !== 'undefined') {
    window.sitrecAPI = sitrecAPI;
}
