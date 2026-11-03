import {registerSurfaceInteraction} from "../SurfaceInteraction";
// Wind field visualization with animated streamlines on the globe.
// Uses GPU-efficient shader animation: a frame counter offsets a dash pattern
// along each streamline, creating a flowing effect without per-frame geometry updates.

import {CNode3DGroup} from "./CNode3DGroup";
import {ECEFToLLAVD_radii, LLAToECEF} from "../LLA-ECEF-ENU";
import {DebugArrowAB, elevationAtLL, removeDebugArrow} from "../threeExt";
import {getLocalEastVector, getLocalNorthVector} from "../SphericalMath";
import {FileManager, GlobalDateTimeNode, Globals, NodeMan, setRenderOne, Sit, Units} from "../Globals";
import {LoadingManager} from "../CLoadingManager";
import {mouseInView, mouseToView} from "../ViewUtils";
import {ViewMan} from "../CViewManager";
import pako from "pako";
import * as LAYER from "../LayerMasks";
import {InstancedInterleavedBuffer, InterleavedBufferAttribute, Vector3} from "three";
import {LineSegmentsGeometry} from "three/addons/lines/LineSegmentsGeometry.js";
import {LineSegments2} from "three/addons/lines/LineSegments2.js";
import {SceneLineMaterial} from "../SceneLineMaterial";
import {updateLineJoins} from "../SceneLineGeometry";
import {meanSeaLevelOffset} from "../EGM96Geoid";
import {escapeXML} from "../utils";
import {par} from "../par";
import {
    bracketingLevels,
    compassFromDeg,
    fromDirSpeedKnotsToUV,
    fromDirSpeedToUV,
    fromUVToDirKnots,
    columnWindAt,
    dataTimeText,
    heightText,
    GFS_SURFACE_AGL_M,
    gfsCycleFor,
    greatCircleDistanceDeg,
    gridCadenceFromSetting,
    gridColumn,
    gridColumnBracket,
    gridTimesAround,
    knotsFromMISBWindSpeed,
    levelToAltFeet,
    placeReadoutBoxes,
    sampleJSONGrid,
    sampleJSONScalar,
    WIND_LEVEL_TABLE,
    windDirFromBearing,
    windHeightUnit,
    windSpeedText,
    windSpeedUnit,
} from "./WindHelpers";
import {
    altitudeProfileForSourceKey,
    isTrackSourceKey,
    trackDataIdFromSourceKey,
    windSourceByKey,
    windSourceShortLabel,
} from "./WindSources";
import {isSecureBuild} from "../configUtils";
import {MISB} from "../MISBUtils";
import {installTerrestrialRefractionOnMaterial} from "../atmosphere/terrestrialRefraction";

// Re-export so existing importers that reach into CNodeDisplayWindField keep working.
export {
    WIND_LEVEL_TABLE,
    bracketingLevels,
    levelToAltFeet,
    sampleJSONGrid,
    fromDirSpeedToUV,
    fromDirSpeedKnotsToUV,
    fromUVToDirKnots,
    greatCircleDistanceDeg,
};

const R_EARTH = 6371000; // meters
const DEG = Math.PI / 180;

// Cursor-jitter floor for inspect-mode mousemove (in client pixels). Small
// enough that intentional drags still feel instant, large enough that
// trackpad easing and OS coalescing don't drive a per-pixel render storm.
const INSPECT_MOVE_THRESHOLD_PX = 2;
// Padding from cursor → readout, and from viewport edge → readout when
// auto-flipped to the opposite side.
const INSPECT_TOOLTIP_OFFSET_PX = 18;
// Readouts are above the views and below the menus (the menu bar is 9000,
// lil-gui-extras.js). They were 10000 until 2026-11-03, over an open menu.
const INSPECT_READOUT_Z_INDEX = 8000;

// Module-level scratch Vector3s for the per-frame screen-grid path.
// Each renders ~60 arrows; without these, every iteration allocates 4-6
// Vector3s (ndc, hit, dir, end, plus the local-frame helpers' internals).
// Wind nodes are singletons within a sitch so sharing scratches across
// arrows is safe — they're never read after a single iteration completes.
const _scratchNDC = new Vector3();
const _scratchHit = new Vector3();
const _scratchDir = new Vector3();
const _scratchEnd = new Vector3();
const _scratchObjectPos = new Vector3();

// The frame on screen: the playhead, clamped to the sitch. This file read
// `Sit.currentFrame ?? 0` until 2026-11-02, but nothing ever set it, so every
// lookup here (Target/Local Wind at a load, the Camera and Target readouts, the
// telemetry field, the nearby-lines centre) used frame 0.
function playheadFrame() {
    const last = Math.max(0, (Sit?.frames ?? 1) - 1);
    return Math.max(0, Math.min(last, Math.round(par?.frame ?? 0)));
}

// A saved wind-grid catalog entry, in the form that _fetchLevel and
// windProxy.php use: level "surface" or "500" (the data file says "10m" or
// "500hPa"), hour "6" (the file's refTime gives "06"). Before 2026-11-02 the
// file's form was saved, so a reload asked the proxy for "10m", got HTTP 400,
// and showed a false failure; and "06" never matched hour 6 in the lookups.
// After this long, a level served from an earlier cycle is asked for again.
const EARLIER_CYCLE_RETRY_MS = 10 * 60 * 1000;

// {dateStr: "20250919", hour: 18} from a refTime "2025-09-19T18:00:00Z", or null.
function cycleOfRefTime(refTime) {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})/.exec(refTime ?? "");
    return match ? {dateStr: match[1] + match[2] + match[3], hour: Number(match[4])} : null;
}

// "2025-09-19 18Z" from a refTime, or null.
function cycleLabel(refTime) {
    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})/.exec(refTime ?? "");
    return match ? `${match[1]} ${match[2]}Z` : null;
}

const KM_PER_DEG = 111.195;

function normalizeWindFileMeta(meta) {
    let level = String(meta.level ?? "");
    if (level === "10m") level = "surface";
    else if (/^\d+hPa$/i.test(level)) level = level.replace(/hPa$/i, "");
    const hourNumber = parseInt(meta.hour, 10);
    // The wind source the file is from ("gfs" or "custom"). A save from before
    // 2026-11-03 has only the data's own label, which is "GFS" for GFS.
    const sourceKey = meta.sourceKey
        ?? (!meta.source || meta.source === "GFS" ? "gfs" : "custom");
    return {...meta, level, sourceKey, hour: Number.isFinite(hourNumber) ? String(hourNumber) : meta.hour};
}

// The key of one pressure-level grid in _levelCache. The source is part of it:
// before 2026-11-03 it was not, so after a change from GFS to an installation's
// grid source, a level already loaded from GFS was served as the other source's.
function levelKey(sourceKey, dateStr, hour, level) {
    return `${sourceKey}:${dateStr}_${hour}_${level}`;
}

// The status of a wind sample (CNodeDisplayWindField.windAt):
//   ok           inside the data
//   held-above   above the highest data: the highest value is held
//   held-below   below the lowest data: the lowest value is held
//   below-ground the point is under the terrain
//   pending      the data for this point is loading; the value is the nearest
//                data already loaded, or none
//   no-data      no data for this source
// A wind node adds "manual" and "override" for a value the user set.
const NO_DATA = Object.freeze({u: null, v: null, status: "no-data"});

// The blend in time of two grid samples {u, v, status, limitM} (a at the
// earlier grid, b at the later, w the weight of b). A sample with no value is
// left out: the other is used alone, marked "pending" while the missing one is
// on its way. Of two statuses, the one that is not "ok" is kept.
export function blendGridSamples(a, b, w) {
    const has = (x) => Number.isFinite(x?.u) && Number.isFinite(x?.v);
    if (has(a) && has(b)) {
        const out = {u: (1 - w) * a.u + w * b.u, v: (1 - w) * a.v + w * b.v,
            status: a.status !== "ok" ? a.status : b.status};
        const limitM = a.status !== "ok" ? a.limitM : b.limitM;
        if (limitM != null) out.limitM = limitM;
        return out;
    }
    const one = has(a) ? a : has(b) ? b : null;
    const other = one === a ? b : a;
    if (!one) {
        const pending = a?.status === "pending" || b?.status === "pending";
        return {u: null, v: null, status: pending ? "pending" : "no-data"};
    }
    return other?.status === "pending" ? {...one, status: "pending"} : one;
}

// The status line of a Show Wind at readout; "" for a plain value. limitM is
// the height (m MSL) that a held value is from; heightUnit from windHeightUnit.
function readoutStatusText(status, limitM = null, heightUnit = undefined) {
    const at = Number.isFinite(limitM) ? ` (${heightText(limitM, heightUnit)})` : "";
    switch (status) {
        case "held-above": return `above the top of the data${at}: top value held`;
        case "held-below": return `below the bottom of the data${at}: lowest value held`;
        case "below-ground": return "below the ground";
        case "pending": return "loading…";
        case "no-data": return "no data";
        case "override": return "Override";
        default: return "";
    }
}

// Time (ms) to wait before asking again for a GFS level that failed to load.
const LEVEL_RETRY_MS = 60 * 1000;

// A point more than this far (m) under the terrain is "below-ground". The
// margin keeps a point on the ground (a camera on a hill) from being called
// under it because of the elevation map's own error.
const BELOW_GROUND_TOLERANCE_M = 10;

// Open-Meteo columns: a point uses a column within this distance (degrees,
// about 25 km, near the model's own grid spacing); a point farther away asks
// for its own column.
const OPEN_METEO_COLUMN_RADIUS_DEG = 0.25;

export class CNodeDisplayWindField extends CNode3DGroup {
    constructor(v) {
        super(v);

        // Wind grid (flat Float32Arrays, row-major, north-to-south)
        this.windU = null;
        this.windV = null;
        // Coverage confidence ∈ [0..1] per grid cell. 1.0 = fully trusted
        // (GFS everywhere, or at a sounding's own station); falls off with
        // distance for IDW-built grids. Streamline opacity is multiplied by
        // the sampled coverage so far-from-sample regions fade to invisible
        // instead of showing physically-meaningless extrapolated wind.
        this.windCov = null;
        this.gridNx = 0;
        this.gridNy = 0;
        this.gridLon0 = 0;
        this.gridLat0 = 90;
        this.gridDLon = 1;
        this.gridDLat = -1;
        // Length scale (degrees) for coverage falloff from IDW samples.
        // ~5° ≈ 550 km — sounding-scale area of representativeness.
        this.coverageLengthDeg = v.coverageLengthDeg ?? 5;

        // Tunables
        this.renderAltitude = v.altitude       ?? 2000;
        this.seedSpacing    = v.seedSpacing    ?? 1.5;
        this.steps          = v.steps          ?? 24;
        this.dtSeconds      = v.dtSeconds      ?? 3000;
        this.numDashes      = v.numDashes      ?? 6;
        this.flowSpeed      = v.flowSpeed      ?? 0.006;
        this.lineOpacity    = v.lineOpacity    ?? 0.9;
        this.maxWindSpeed   = v.maxWindSpeed   ?? 30;
        this.minSpeedCutoff = v.minSpeedCutoff ?? 0.5;

        this.windAltFt      = v.windAltFt ?? 33;  // feet — display altitude
        this.windLevel      = "surface";          // descriptive label for status
        this.statusText     = "Not loaded";

        // Source of the wind field:
        //   "gfs" | "uwyo" | "igra2" | "manual-soundings" | "openmeteo" | "manual"
        // The three sounding sources share the same IDW pipeline but filter
        // the profile pool differently (see _gatherSondeProfiles).
        this.source = v.source ?? "gfs";

        // Local-side source (independent in separate mode; mirrors target
        // in shared mode — controlled by sourceSeparate). Internal source
        // key (matching this.source's vocabulary) or a "track:<id>" entry.
        this.sourceLocal = v.sourceLocal ?? "manual";

        // Default mode (sourceSeparate === false): one source dropdown
        // drives both target and local. Toggling true exposes a separate
        // local dropdown for independent control. Distinct from
        // "Lock Target Wind to Local" (which mirrors the *manual From/Knots
        // values* between the two wind nodes).
        this.sourceSeparate = v.sourceSeparate ?? false;

        this.frameCount = 0;
        this.linesMesh = null;
        this.dataSource = "none";
        this.fetching = false;
        // True for the whole duration of the deferred post-deserialize GFS
        // re-fetch (_reloadGFSAfterDeserialize), whose per-level network fetches
        // run BEFORE the final fetchWindForAltitude sets this.fetching — so
        // without it the settle gate (getPendingLoadState) sees a gap and can
        // screenshot a wind field whose streamlines aren't built yet (the
        // "wind test" concurrency flake: streamlines entirely absent under load).
        this._reloadInFlight = false;
        // "<source>|<interval start ms>|<time weight>" of the displayed grid
        // lines (_fillFromGridSource); update() rebuilds them when it changes.
        this._displayTimeKey = null;
        this._levelCache = {};       // levelKey() → GFS json (one per pressure level)

        // Changes when the data that windAt() reads changes: a grid level or an
        // Open-Meteo column arrives, the grids are dropped. Not when only the
        // displayed lines are rebuilt (that is _windDataVersion). The wind nodes
        // recalculate their users when it changes (CNodeWind.update).
        this._sourceDataVersion = 0;
        // On-demand loading of the grid levels that windAt() needs.
        this._levelQueue = [];          // [{sourceKey, dateStr, hour, level}]
        this._levelQueueActive = 0;
        this._failedLevels = new Map(); // levelKey → time of the failure (ms)
        // Open-Meteo columns: all pressure levels at a point for one day.
        this._omColumns = new Map();    // key → column (see _omColumnKey)
        this._omInFlight = new Map();   // key → promise

        // Catalog of every GFS pressure-level grid we've persisted to FileManager
        // for the current cycle. Map<fileId, {level, dateStr, hour, source}>.
        // Survives modSerialize/Deserialize so altitude changes after reload
        // don't re-hit the network for a level we already had on disk.
        this._loadedWindFiles = new Map();

        // Nearby-only filter: when enabled, rebuildStreamlines() restricts
        // seeding to a lat/lon box around Sit.fromLat/Sit.fromLon. Cuts the
        // streamline count from ~thousands to ~tens for typical radii,
        // making altitude scrubbing nearly instantaneous. On by default —
        // global wind fields are rarely what users actually want to look at.
        this.nearbyOnly      = v.nearbyOnly      ?? true;
        this.nearbyRadiusKm  = v.nearbyRadiusKm  ?? 250;

        // Screen-grid wind arrows: per-frame ray-cast a uniform 200 px grid
        // through the main view, intersect each ray with the ellipsoid at the
        // configured altitude, and draw a 100 px arrow there. Independent
        // of the streamline mesh visibility ("Show Wind Lines"), so users
        // can pick either or both.
        this.showArrows = v.showArrows ?? false;

        // Streamline-mesh visibility ("Show Wind Lines"). Distinct from
        // the master visibility (this.visible / this.group.visible, owned
        // by the Show/Hide menu's Wind Field entry). The master hides the
        // whole group — streamlines, arrows, inspect arrows, sonde arrows.
        // Show Wind Lines hides only the streamline mesh, so toggling it
        // off doesn't take the arrow grid down with it.
        this.linesVisible = v.linesVisible ?? true;

        // Show Wind at (formerly Inspect Wind): when on, renders one arrow +
        // readout per "inspect point". `inspect` is the folder's master
        // switch; each kind of point has its own switch under it:
        //   - inspectCursor: the mouse cursor (one transient point), plus the
        //     dropped points that Shift-click adds and Alt-click removes
        //   - inspectCamera / inspectTarget: anchored to the camera / target
        //     track positions, sampled at each track's own altitude
        //   - inspectObjects: {objectId: true} for each 3D object to show,
        //     sampled at the object's own altitude
        // The pointer listeners are installed only while the master AND the
        // cursor switch are on, so we don't pay the cost otherwise.
        this.inspect = false;
        // True once Show Wind at has been on in this sitch (saved). Until then,
        // the first change to the wind turns it on (noteWindChanged; decision
        // D2, 2026-11-02), so a new user finds where to read the wind.
        this.showAtEverOn = false;
        // Show every wind speed on the Wind panel in knots, not in the speed
        // unit of Units (decision D4).
        this.windInKnots = v.windInKnots ?? false;
        this.inspectCamera = true;
        this.inspectTarget = true;
        this.inspectCursor = false;
        this.inspectObjects = {};
        this._inspectClient = null;     // {x, y} clientX/Y of the cursor point
        this.inspectPoints = [];        // [{lat, lon}] — persisted dropped points
        this._inspectMouseHandler = null;
        this._inspectClickHandler = null;
        // Per-point DOM readouts, keyed by stable id ("cursor","camera",
        // "target","drop:<idx>"). Entries that don't get refreshed in a
        // given frame are hidden, then garbage-collected on the next
        // setInspect(false) / dispose().
        this._inspectDivs = new Map();
        // Lock the wind altitude to the camera or target track's altitude
        // each frame, instead of taking it from the manual slider. Persisted
        // alongside the wind node so save/restore preserves the lock.
        // Values: "none" (default) | "camera" | "target".
        this.lockAltitudeTo = "none";

        // ---------- shader material ----------
        this.material = new SceneLineMaterial({depthTest: false});
        Object.assign(this.material.uniforms, {
            uTime:      {value: 0},
            uNumDashes: {value: this.numDashes},
            uFlowSpeed: {value: this.flowSpeed},
            uOpacity:   {value: this.lineOpacity},
            uMaxSpeed:  {value: this.maxWindSpeed},
        });
        this.material.vertexShader = this.material.vertexShader.replace(
            "void main() {", VERT_DECLARATIONS + "\nvoid main() {").replace(
            "// scene line attributes", VERT_BODY);
        this.material.fragmentShader = this.material.fragmentShader.replace(
            "void main() {", FRAG_DECLARATIONS + "\nvoid main() {").replace(
            "#include <color_fragment>", "#include <color_fragment>\n" + FRAG_BODY);
        installTerrestrialRefractionOnMaterial(this.material);

        // visible in main view only (not look view)
        this.group.layers.mask = LAYER.MASK_MAIN;
        this.propagateLayerMask();

        // GUI is created externally (from CustomSupport.js)
        // — the node just exposes the properties and methods

        this.simpleSerials.push("seedSpacing", "lineOpacity",
            "flowSpeed", "numDashes", "maxWindSpeed", "renderAltitude");

        // Add to Show/Hide menu
        this.showHider("Wind Field");
    }

    // Bilinear sample of coverage at (lat,lon). Returns 1.0 if windCov
    // wasn't populated (GFS / Manual uniform — trust everywhere).
    sampleCoverage(lat, lon) {
        if (!this.windCov) return 1.0;
        lon = ((lon % 360) + 360) % 360;
        lat = Math.max(-90, Math.min(90, lat));
        const fi = (lon - this.gridLon0) / this.gridDLon;
        const fj = (lat - this.gridLat0) / this.gridDLat;
        let i0 = Math.floor(fi);
        let j0 = Math.floor(fj);
        const si = fi - i0;
        const sj = fj - j0;
        i0 = ((i0 % this.gridNx) + this.gridNx) % this.gridNx;
        const i1 = (i0 + 1) % this.gridNx;
        j0 = Math.max(0, Math.min(j0, this.gridNy - 2));
        const j1 = j0 + 1;
        const w00 = (1 - si) * (1 - sj);
        const w10 = si * (1 - sj);
        const w01 = (1 - si) * sj;
        const w11 = si * sj;
        return w00 * this.windCov[j0 * this.gridNx + i0]
             + w10 * this.windCov[j0 * this.gridNx + i1]
             + w01 * this.windCov[j1 * this.gridNx + i0]
             + w11 * this.windCov[j1 * this.gridNx + i1];
    }

    // ── bilinear wind lookup ─────────────────────────────────────────
    //
    // Returns null when there is no grid to sample, matching
    // sampleWindAtAltitude's contract so callers only need one check. The grid
    // arrays start out null (constructor) and stay null until wind data is
    // actually loaded, so a sitch that never fetched any — e.g. a legacy sitch
    // with a hand-set wind and no wind field — reaches here with windU/windV
    // still null. Non-finite lat/lon are rejected for the same reason: they
    // produce NaN indices, and a NaN index into a null array is exactly the
    // "cannot read properties of null (reading 'NaN')" crash this prevents.
    sampleWind(lat, lon) {
        if (!this.windU || !this.windV) return null;
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
        if (!Number.isFinite(this.gridLon0) || !Number.isFinite(this.gridDLon)
            || !Number.isFinite(this.gridLat0) || !Number.isFinite(this.gridDLat)
            || !(this.gridNx > 1) || !(this.gridNy > 1)) return null;

        lon = ((lon % 360) + 360) % 360;
        lat = Math.max(-90, Math.min(90, lat));

        const fi = (lon - this.gridLon0) / this.gridDLon;
        const fj = (lat - this.gridLat0) / this.gridDLat;

        let i0 = Math.floor(fi);
        let j0 = Math.floor(fj);
        const si = fi - i0;
        const sj = fj - j0;

        i0 = ((i0 % this.gridNx) + this.gridNx) % this.gridNx;
        const i1 = (i0 + 1) % this.gridNx;
        j0 = Math.max(0, Math.min(j0, this.gridNy - 2));
        const j1 = j0 + 1;

        const w00 = (1 - si) * (1 - sj);
        const w10 = si * (1 - sj);
        const w01 = (1 - si) * sj;
        const w11 = si * sj;

        const idx00 = j0 * this.gridNx + i0;
        const idx10 = j0 * this.gridNx + i1;
        const idx01 = j1 * this.gridNx + i0;
        const idx11 = j1 * this.gridNx + i1;

        return {
            u: w00 * this.windU[idx00] + w10 * this.windU[idx10]
             + w01 * this.windU[idx01] + w11 * this.windU[idx11],
            v: w00 * this.windV[idx00] + w10 * this.windV[idx10]
             + w01 * this.windV[idx01] + w11 * this.windV[idx11],
        };
    }

    // ── the one wind function ────────────────────────────────────────
    //
    // Wind from a source at a place, a height and a time: {u, v, status}, with
    // u east and v north in m/s, and status as listed at NO_DATA (u and v are
    // null when there is nothing to give). Everything that shows or uses a
    // wind reads this: Target and Local Wind at their users' positions on
    // every frame (CNodeWind.windStateAt), the Show Wind at readouts, the
    // balloon and the contrails.
    //
    // It is synchronous. Data that is not loaded yet (a GFS level, an Open-
    // Meteo column) is asked for, and the answer is "pending" until it comes;
    // then _sourceDataVersion changes, and the wind nodes recalculate.
    //
    // sourceKey: a WindSources key ("gfs", "uwyo", "track:<id>", ...).
    // altM: metres MSL. f: the frame, for a source that changes in time (a
    // telemetry track); the playhead if not given.
    windAt(sourceKey, lat, lon, altM, f = playheadFrame()) {
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(altM)) return NO_DATA;
        // A grid source puts its levels on the terrain, so it sets
        // "below-ground" itself.
        if (sourceKey === "gfs" || sourceKey === "custom") {
            return this._sampleGridColumn(sourceKey, lat, lon, altM, f);
        }
        let w = null;
        const soundingSet = this._soundingSet(sourceKey);
        if (soundingSet) {
            w = this._blendSoundingProfiles(soundingSet.profiles, lat, lon, altM);
        } else if (sourceKey === "openmeteo") {
            w = this._sampleOpenMeteo(lat, lon, altM);
        } else if (sourceKey === "manual") {
            // The Manual field is Target Wind, the same at every height.
            const tw = NodeMan.get("targetWind", false);
            if (tw && Number.isFinite(tw.from) && Number.isFinite(tw.knots)) {
                w = {...fromDirSpeedKnotsToUV(tw.from, tw.knots), status: "ok"};
            }
        } else if (isTrackSourceKey(sourceKey)) {
            // A telemetry track: the wind it measured at time f, the same at
            // every place and height.
            const trackId = trackDataIdFromSourceKey(sourceKey);
            const td = trackId ? NodeMan.get(trackId, false) : null;
            const tw = td ? this._telemetryWindAt(trackId, td, f) : null;
            if (tw) w = {...fromDirSpeedKnotsToUV(tw.from, tw.knots), status: "ok"};
        }
        if (!w) return NO_DATA;
        if (!Number.isFinite(w.u) || !Number.isFinite(w.v)) return w;
        const groundM = this._groundMSL(lat, lon);
        if (groundM != null && altM < groundM - BELOW_GROUND_TOLERANCE_M) {
            return {u: w.u, v: w.v, status: "below-ground"};
        }
        return w;
    }

    // The source a role reads: "target" or "local" (the camera side).
    sourceKeyFor(role) {
        return role === "local" && this.sourceSeparate ? this.sourceLocal : this.source;
    }

    // {u, v} at (lat, lon) and a height (m MSL) from the Wind Source, or null.
    // The older form of windAt() for the balloon, the contrails, the thermal
    // view and the traverse analysis. f: the frame (for a telemetry track).
    sampleWindAtAltitude(lat, lon, altM, f = playheadFrame()) {
        const w = this.windAt(this.source, lat, lon, altM, f);
        return Number.isFinite(w.u) && Number.isFinite(w.v) ? w : null;
    }

    // Ground height (m MSL) under a point, from the terrain's elevation map,
    // or null when there is no terrain.
    _groundMSL(lat, lon) {
        const map = NodeMan.get("TerrainModel", false)?.elevationMap;
        if (!map || typeof map.getElevationInterpolated !== "function") return null;
        const hae = map.getElevationInterpolated(lat, lon);
        if (!Number.isFinite(hae)) return null;
        // The terrain node holds the ground at sea level over the sea; so do we.
        return Math.max(0, hae - meanSeaLevelOffset(lat, lon));
    }

    // Hours between the grids of a grid source: 6 for GFS; an installation's
    // own source can set SITREC_CUSTOM_WIND_CADENCE_HOURS (a divisor of 24).
    gridCadenceHours(sourceKey = this.source) {
        if (sourceKey !== "custom") return 6;
        return gridCadenceFromSetting(Globals.env?.SITREC_CUSTOM_WIND_CADENCE_HOURS, 6);
    }

    // The time (epoch ms) of frame f: the sitch time of that frame.
    _frameTimeMs(f) {
        const fromFrame = Number.isFinite(f) ? GlobalDateTimeNode?.frameToMS?.(f) : null;
        if (Number.isFinite(fromFrame)) return fromFrame;
        const now = GlobalDateTimeNode?.dateNow?.valueOf();
        return Number.isFinite(now) ? now : Date.now();
    }

    // A grid source (GFS, or an installation's own) at a point and a time:
    // the two grids around the time of frame f, each read on the column at the
    // point (_sampleGridColumnAt), blended by time (decision D5). A grid that
    // cannot be had (the later cycle is not published yet) leaves the other
    // alone; one that is on its way makes the status "pending".
    _sampleGridColumn(sourceKey, lat, lon, altM, f) {
        const {c0, c1, w} = gridTimesAround(this._frameTimeMs(f), this.gridCadenceHours(sourceKey));
        const a = this._sampleGridColumnAt(sourceKey, c0, lat, lon, altM);
        if (w < 1e-9) return a;
        const b = this._sampleGridColumnAt(sourceKey, c1, lat, lon, altM);
        return blendGridSamples(a, b, w);
    }

    // The column of one grid time at a point: the levels on the terrain there
    // (gridColumnBracket), at their real heights where the grid gives them
    // (_columnHeights). A level that is not loaded yet is asked for; until it
    // comes, the nearest loaded levels of the column give the value, and the
    // status is "pending".
    _sampleGridColumnAt(sourceKey, cycle, lat, lon, altM) {
        const {dateStr, hour} = cycle;
        const groundM = this._groundMSL(lat, lon);
        const heights = this._columnHeights(sourceKey, dateStr, hour, lat, lon);
        const {lo, hi, t, status, limitM} = gridColumnBracket(altM, groundM, heights);
        const jsonLo = this._levelCache[levelKey(sourceKey, dateStr, hour, lo.level)];
        const jsonHi = hi.level === lo.level
            ? jsonLo : this._levelCache[levelKey(sourceKey, dateStr, hour, hi.level)];
        if (jsonLo && jsonHi) {
            const a = sampleJSONGrid(jsonLo, lat, lon);
            const b = sampleJSONGrid(jsonHi, lat, lon);
            const w = {u: (1 - t) * a.u + t * b.u, v: (1 - t) * a.v + t * b.v, status};
            if (limitM != null) w.limitM = limitM;
            return w;
        }
        const missing = [];
        if (!jsonLo) missing.push(lo.level);
        if (!jsonHi && hi.level !== lo.level) missing.push(hi.level);
        const loading = this._requestLevels(sourceKey, dateStr, hour, missing);
        // Meanwhile: the loaded levels of this column, sampled here.
        const loaded = [];
        for (const level of gridColumn(groundM, heights)) {
            const json = this._levelCache[levelKey(sourceKey, dateStr, hour, level.level)];
            if (json) loaded.push({altM: level.altM, ...sampleJSONGrid(json, lat, lon)});
        }
        const near = columnWindAt(loaded, altM);
        // "pending" while a level is on its way; "no-data" when one failed.
        const missingStatus = loading ? "pending" : "no-data";
        return near ? {u: near.u, v: near.v, status: missingStatus}
            : {u: null, v: null, status: missingStatus};
    }

    // The real height (m) of each pressure level at a point, from the grids of
    // one time that carry a height field (hgt, the geopotential height, which
    // fetch_wind.py adds since 2026-11-03), as {level: m}; or null. Null also
    // when a loaded level has no height (a grid cached before that, or a source
    // that does not give one): then every level takes its standard height, so
    // one column never mixes the two. A level not loaded yet takes its standard
    // height until it comes.
    _columnHeights(sourceKey, dateStr, hour, lat, lon) {
        let heights = null;
        for (const entry of WIND_LEVEL_TABLE) {
            if (entry.level === "surface") continue;
            const json = this._levelCache[levelKey(sourceKey, dateStr, hour, entry.level)];
            if (!json) continue;
            if (!Array.isArray(json.hgt) || json.hgt.length !== json.u.length) return null;
            const m = sampleJSONScalar(json, json.hgt, lat, lon);
            if (!Number.isFinite(m)) return null;
            (heights ??= {})[entry.level] = m;
        }
        return heights;
    }

    // Ask for grid levels that are not loaded. At most three load at once;
    // a level that failed is not asked for again for LEVEL_RETRY_MS. Returns
    // true when every one of `levels` is loading or waiting to load.
    _requestLevels(sourceKey, dateStr, hour, levels) {
        let allLoading = true;
        for (const level of levels) {
            const key = levelKey(sourceKey, dateStr, hour, level);
            if (this._levelCache[key]) continue;
            if (this._inFlightLevels?.[key] || this._levelQueue.some(job => job.key === key)) continue;
            const failedAt = this._failedLevels.get(key);
            if (failedAt != null && Date.now() - failedAt < LEVEL_RETRY_MS) {
                allLoading = false;
                continue;
            }
            this._levelQueue.push({key, sourceKey, dateStr, hour, level});
        }
        this._pumpLevelQueue();
        return allLoading;
    }

    _pumpLevelQueue() {
        const MAX_CONCURRENT = 3;   // as ensureLevelsUpToAltitude: do not hammer the proxy
        while (this._levelQueueActive < MAX_CONCURRENT && this._levelQueue.length > 0) {
            const job = this._levelQueue.shift();
            this._levelQueueActive++;
            this._fetchLevel(job.level, job.dateStr, job.hour, job.sourceKey)
                .then(() => this._failedLevels.delete(job.key))
                .catch(err => {
                    this._failedLevels.set(job.key, Date.now());
                    // A changed version lets the users see "no-data" now.
                    this._sourceDataVersion++;
                    console.warn(`Wind level ${job.level} (${job.sourceKey}) failed:`, err?.message ?? err);
                })
                .finally(() => {
                    this._levelQueueActive--;
                    this._pumpLevelQueue();
                    setRenderOne(true);
                });
        }
    }

    // ── Open-Meteo, as columns ───────────────────────────────────────
    //
    // One request gives every pressure level at a point for a whole day, so a
    // point is one column, read at any height and hour. A point uses the
    // nearest loaded column for the day; one farther than
    // OPEN_METEO_COLUMN_RADIUS_DEG asks for its own column.
    _omColumnKey(lat, lon, dateStr) {
        return `${lat.toFixed(2)}|${lon.toFixed(2)}|${dateStr}`;
    }

    _nearestOpenMeteoColumn(lat, lon, dateStr) {
        let best = null, bestD = Infinity;
        for (const column of this._omColumns.values()) {
            if (column.dateStr !== dateStr) continue;
            const d = greatCircleDistanceDeg(lat, lon, column.lat, column.lon);
            if (d < bestD) { bestD = d; best = column; }
        }
        return best ? {column: best, distanceDeg: bestD} : null;
    }

    _sampleOpenMeteo(lat, lon, altM) {
        const date = GlobalDateTimeNode?.dateNow ?? new Date();
        const dateStr = date.toISOString().slice(0, 10);
        const near = this._nearestOpenMeteoColumn(lat, lon, dateStr);
        if (!near || near.distanceDeg > OPEN_METEO_COLUMN_RADIUS_DEG) {
            this._requestOpenMeteoColumn(lat, lon, dateStr);
        }
        if (!near) return {u: null, v: null, status: "pending"};
        const w = columnWindAt(near.column.hours[date.getUTCHours()] ?? [], altM);
        if (!w) return {u: null, v: null, status: "no-data"};
        if (near.distanceDeg > OPEN_METEO_COLUMN_RADIUS_DEG) w.status = "pending";
        return w;
    }

    // Load the column at a point (fire and forget). Returns its promise.
    _requestOpenMeteoColumn(lat, lon, dateStr) {
        const key = this._omColumnKey(lat, lon, dateStr);
        if (this._omColumns.has(key)) return Promise.resolve(this._omColumns.get(key));
        if (this._omInFlight.has(key)) return this._omInFlight.get(key);
        const failedAt = this._failedLevels.get(`om:${key}`);
        if (failedAt != null && Date.now() - failedAt < LEVEL_RETRY_MS) return Promise.resolve(null);
        const p = fetchOpenMeteoColumn(Number(lat.toFixed(2)), Number(lon.toFixed(2)), dateStr)
            .then(column => {
                if (column) {
                    this._omColumns.set(key, column);
                    this._sourceDataVersion++;
                    this._windDataVersion = (this._windDataVersion ?? 0) + 1;
                }
                return column;
            })
            .catch(err => {
                this._failedLevels.set(`om:${key}`, Date.now());
                console.warn("open-meteo column failed:", err?.message ?? err);
                return null;
            })
            .finally(() => {
                this._omInFlight.delete(key);
                setRenderOne(true);
            });
        this._omInFlight.set(key, p);
        return p;
    }

    setGridParams(nx, ny, lon0, lat0, dlon, dlat) {
        this.gridNx = nx; this.gridNy = ny;
        this.gridLon0 = lon0; this.gridLat0 = lat0;
        this.gridDLon = dlon; this.gridDLat = dlat;
    }

    // ── trace one streamline, appending vertices to the output arrays ──
    _traceStreamline(seedLat, seedLon, lodLevel, lineIndex, alt, center, out) {
        const steps = this.steps;
        const dt    = this.dtSeconds;
        const minSpd = this.minSpeedCutoff;

        let cLat = seedLat, cLon = seedLon;
        const pts = [];
        const spds = [];
        const covs = [];

        for (let s = 0; s <= steps; s++) {
            const w = this.sampleWind(cLat, cLon);
            if (!w) return lineIndex;   // no grid to trace through
            const speed = Math.sqrt(w.u * w.u + w.v * w.v);
            if (speed < minSpd && s === 0) return lineIndex;

            const cov = this.sampleCoverage(cLat, cLon);
            // Skip seeding streamlines in effectively-zero-coverage cells —
            // they'd render invisible anyway but still cost vertex budget.
            if (cov < 0.02 && s === 0) return lineIndex;

            const ecef = LLAToECEF(cLat, cLon, alt);
            pts.push(ecef.x - center.x, ecef.y - center.y, ecef.z - center.z);
            spds.push(speed);
            covs.push(cov);

            if (s < steps && speed >= minSpd) {
                const cosLat = Math.cos(cLat * DEG);
                if (Math.abs(cosLat) < 0.01) break;
                cLat += (w.v * dt / R_EARTH) / DEG;
                cLon += (w.u * dt / (R_EARTH * cosLat)) / DEG;
                cLat = Math.max(-89, Math.min(89, cLat));
                cLon = ((cLon % 360) + 360) % 360;
            }
        }

        if (pts.length < 6) return lineIndex;

        const nPts = pts.length / 3;
        const lineId = (lineIndex * 0.6180339887) % 1.0;

        for (let s = 0; s < nPts - 1; s++) {
            const t0 = s / (nPts - 1);
            const t1 = (s + 1) / (nPts - 1);
            const speed = (spds[s] + spds[s + 1]) * 0.5;
            const base = s * 3;

            out.pos.push(pts[base], pts[base + 1], pts[base + 2]);
            out.pos.push(pts[base + 3], pts[base + 4], pts[base + 5]);
            out.prog.push(t0, t1);
            out.id.push(lineId, lineId);
            out.spd.push(speed, speed);
            out.cov.push(covs[s], covs[s + 1]);
            out.lod.push(lodLevel, lodLevel);
        }
        return lineIndex + 1;
    }

    // ── Per-sonde wind arrow at the configured altitude ─────────────
    //
    // Renders one viewport-scaled arrow per loaded sonde profile, placed at
    // the balloon's interpolated 3D position at windAltFt and pointing in
    // the direction the wind is blowing TO. Uses the same negative-length
    // pixel-relative pattern as celestial vectors (CNodeLabeledArrow),
    // realised here directly via DebugArrowAB + a preRender hook so the
    // arrows stay screen-consistent at any zoom.
    //
    // Stored direction-only data per sonde so preRender can recompute the
    // endpoint cheaply each view without re-traversing the profile.
    _updateSondeWindArrows() {
        if (!this._sondeArrows) this._sondeArrows = new Map();
        const seen = new Set();
        const altM = this.windAltFt * 0.3048;

        if (this.visible) {
            const profiles = this._gatherSondeProfiles(null);
            for (const p of profiles) {
                const data = p.getAtAltitude(altM);
                if (!data || data.windDir == null || data.windSpeed == null) continue;
                const start = p.getPositionAtAltitude(altM);
                if (!start || isNaN(start.x)) continue;

                // Wind blows FROM windDir; arrow points TO (windDir + 180).
                const bearingRad = ((data.windDir + 180) % 360) * DEG;
                const north = getLocalNorthVector(start);
                const east  = getLocalEastVector(start);
                const dir = new Vector3()
                    .addScaledVector(north, Math.cos(bearingRad))
                    .addScaledVector(east,  Math.sin(bearingRad))
                    .normalize();

                const name = `sondeWindAtAlt_${p.id}`;
                this._sondeArrows.set(name, {start, dir, profileId: p.id});
                seen.add(name);
            }
        }

        // Drop any arrows for sondes that disappeared (or all of them when
        // the wind field is hidden).
        for (const name of [...this._sondeArrows.keys()]) {
            if (!seen.has(name)) {
                removeDebugArrow(name);
                this._sondeArrows.delete(name);
            }
        }
    }

    // Per-view per-frame: turn the stored direction-only arrow data into
    // actual world-space lines whose length is the same number of pixels
    // on screen regardless of camera distance.
    preRender(view) {
        if (view.pixelsToMeters) {
            const PX = 100; // arrow length in screen pixels
            if (this._sondeArrows?.size) {
                // Every loaded sonde gets an arrow, but only the current
                // source's set (_soundingSet) shapes the field; the others are
                // gray, so an unused profile (an XML file under UWYO, any sonde
                // under GFS) does not look like part of the field. Tested here,
                // against the source selected NOW, because a source change
                // whose load fails never reaches rebuildStreamlines().
                const inUse = new Set((this._soundingSet()?.profiles ?? []).map(p => p.id));
                for (const [name, entry] of this._sondeArrows) {
                    const lengthM = view.pixelsToMeters(entry.start, PX);
                    _scratchEnd.copy(entry.start).addScaledVector(entry.dir, lengthM);
                    DebugArrowAB(name, entry.start, _scratchEnd,
                        inUse.has(entry.profileId) ? "#ff66ff" : "#a0a0a0", true,
                        this.group, 50, LAYER.MASK_HELPERS);
                }
            }
        }
        this._updateScreenWindArrows(view);
        this._updateInspectArrows(view);
    }

    // Cast a ray from the main view's camera through the given pixel and
    // intersect with the WGS84-shaped shell at altMSL. Writes the ECEF hit
    // point into `out` and returns it, or null on miss. `out` is mandatory
    // so callers can supply a scratch Vector3 and avoid per-arrow allocations.
    _rayHitWindShell(view, px, py, altMSL, out) {
        if (!view?.camera || !view.widthPx || !view.heightPx) return null;
        const a = Globals.equatorRadius + altMSL;
        const b = Globals.polarRadius + altMSL;
        const a2 = a * a, b2 = b * b;
        const cam = view.camera.position;

        _scratchNDC.set(
            (px / view.widthPx) * 2 - 1,
            -(py / view.heightPx) * 2 + 1,
            1,
        );
        _scratchNDC.unproject(view.camera);

        let dirX = _scratchNDC.x - cam.x;
        let dirY = _scratchNDC.y - cam.y;
        let dirZ = _scratchNDC.z - cam.z;
        const dlen = Math.hypot(dirX, dirY, dirZ);
        if (dlen === 0) return null;
        dirX /= dlen; dirY /= dlen; dirZ /= dlen;

        const A = (dirX * dirX + dirY * dirY) / a2 + (dirZ * dirZ) / b2;
        const B = 2 * ((cam.x * dirX + cam.y * dirY) / a2
            + (cam.z * dirZ) / b2);
        const C = (cam.x * cam.x + cam.y * cam.y) / a2
            + (cam.z * cam.z) / b2 - 1;
        const disc = B * B - 4 * A * C;
        if (disc < 0) return null;
        const sqd = Math.sqrt(disc);
        const t1 = (-B - sqd) / (2 * A);
        const t2 = (-B + sqd) / (2 * A);
        const t = t1 > 0 ? t1 : (t2 > 0 ? t2 : -1);
        if (t < 0) return null;
        out.set(cam.x + dirX * t, cam.y + dirY * t, cam.z + dirZ * t);
        return out;
    }

    // Screen-space wind arrow grid for the main view.
    //
    // For each 200 px cell in the viewport, cast a ray from the camera
    // through the cell centre, intersect it with the ellipsoid at the wind
    // altitude (a + altMSL, b + altMSL), then sample the wind grid at that
    // lat/lon and draw a 100 px arrow pointing in the wind-blow-to direction.
    // Skips cells whose ray misses the globe or where wind speed is below
    // a noise floor.
    _updateScreenWindArrows(view) {
        // preRender fires for every view; only the main view owns these
        // arrows. Skip everything (including the cleanup loop) for other
        // views or we'd remove and recreate ~60 ArrowHelpers per frame —
        // a GPU-buffer-thrash that can crash the renderer.
        if (view?.id !== "mainView") return;

        if (!this._screenArrowNames) this._screenArrowNames = new Set();

        const active = this.showArrows && this.windU
            && view.pixelsToMeters && view.camera
            && view.widthPx > 0 && view.heightPx > 0;

        if (!active) {
            // Drop any arrows from a previous active frame, then short-circuit
            // subsequent inactive frames (set will already be empty).
            if (this._screenArrowNames.size > 0) {
                for (const name of this._screenArrowNames) removeDebugArrow(name);
                this._screenArrowNames.clear();
            }
            this._lastScreenGridSnapshot = null;
            return;
        }

        // Snapshot the inputs that determine arrow positions. If unchanged
        // since last call, every arrow ends up in the same place — so the
        // ~60 ray-casts and DebugArrowAB calls are pure busy-work. A still
        // scene with the screen-grid on used to do all that every frame.
        //
        // matrixWorld covers camera position/orientation; projectionMatrix
        // covers FOV/zoom (mouse-wheel zoom, fovOverride, matchVideoAspect
        // — these mutate the projection without touching matrixWorld, but
        // they do change which rays _rayHitWindShell casts through pixels).
        const m = view.camera.matrixWorld.elements;
        const p = view.camera.projectionMatrix.elements;
        const snap = `${view.widthPx},${view.heightPx},${this.windAltFt},`
            + `${this._windDataVersion ?? 0},`
            + `${m[0]},${m[1]},${m[2]},${m[4]},${m[5]},${m[6]},`
            + `${m[8]},${m[9]},${m[10]},${m[12]},${m[13]},${m[14]},`
            + `${p[0]},${p[5]},${p[8]},${p[9]},${p[10]}`;
        if (this._lastScreenGridSnapshot === snap) return;
        this._lastScreenGridSnapshot = snap;

        const seen = new Set();
        const altMSL = this.windAltFt * 0.3048;
        const STEP = 200;
        const PX = 100;

        for (let py = STEP / 2; py < view.heightPx; py += STEP) {
            for (let px = STEP / 2; px < view.widthPx; px += STEP) {
                const hit = this._rayHitWindShell(view, px, py, altMSL, _scratchHit);
                if (!hit) continue;
                const lla = ECEFToLLAVD_radii(hit);
                if (!Number.isFinite(lla.x) || !Number.isFinite(lla.y)) continue;

                const w = this.sampleWind(lla.x, lla.y);
                if (!w || !Number.isFinite(w.u) || !Number.isFinite(w.v)) continue;
                if (Math.hypot(w.u, w.v) < 0.5) continue;  // noise floor

                const {from} = fromUVToDirKnots(w.u, w.v);
                windDirFromBearing(lla.x, lla.y, from * DEG, _scratchDir);

                const lengthM = view.pixelsToMeters(hit, PX);
                _scratchEnd.copy(hit).addScaledVector(_scratchDir, lengthM);
                const name = `windArrowGrid_${px}_${py}`;
                DebugArrowAB(name, hit, _scratchEnd, "#00ffff", true,
                    this.group, 30, LAYER.MASK_MAIN);
                seen.add(name);
            }
        }

        // Drop arrows that didn't get refreshed this frame (off-screen, or
        // wind sample dropped below noise floor at this cell). Cheap.
        for (const name of this._screenArrowNames) {
            if (!seen.has(name)) removeDebugArrow(name);
        }
        this._screenArrowNames = seen;
    }

    // The Show Wind at master switch. With Mouse Cursor on, it registers click
    // ownership and a read-only pointer observer (_syncInspectCursor). On
    // disable, hides all readout divs and removes the per-point arrows
    // (dropped points themselves stay in this.inspectPoints so the next
    // enable restores them).
    //
    // Click semantics (Mouse Cursor on):
    //   shift+left-click → drop a new point at the wind-shell hit
    //   alt/option+left-click → remove the closest dropped point
    //   plain left-click → no inspect action (camera-orbit / etc still works)
    // The modifier requirement keeps inspect from interfering with normal
    // mouse navigation; right-click is left alone for the OS / page menu.
    setInspect(enabled) {
        this.inspect = !!enabled;
        if (this.inspect) this.showAtEverOn = true;
        this._syncInspectCursor();

        if (!this.inspect) {
            // Hide all per-point readouts and remove all arrows; the next
            // enable will recreate them. inspectPoints itself is preserved
            // so dropped points re-appear when the user re-enables.
            for (const div of this._inspectDivs.values()) {
                if (div) div.style.display = "none";
            }
            this._removeAllInspectArrows();
        }
    }

    // Decision D2 (2026-11-02): the first time the user changes the wind (the
    // source, an Override, a Target or Local Wind value), turn Show Wind at on,
    // if it has never been on in this sitch, so that the user sees where the
    // wind is read. Not while a sitch loads. Returns true when it turned it on.
    noteWindChanged() {
        if (this.showAtEverOn || this.inspect || Globals.deserializing) return false;
        this.setInspect(true);
        this.showAtAutoOnAt = Date.now();
        this.onShowAtAutoOn?.();   // the menu shows the change (CustomManagerSetup)
        setRenderOne(true);
        return true;
    }

    // The Mouse Cursor switch under Show Wind at. The readout sweep in
    // _updateInspectArrows removes the cursor and dropped-point readouts on
    // the next render.
    setInspectCursor(enabled) {
        this.inspectCursor = !!enabled;
        this._syncInspectCursor();
        setRenderOne(true);
    }

    // Install the cursor listeners while both the master and the cursor
    // switch are on; remove them otherwise.
    _syncInspectCursor() {
        const wanted = this.inspect && this.inspectCursor;
        if (wanted && !this._inspectMouseHandler) {
            this._inspectMouseHandler = (e) => {
                // Sub-pixel cursor jitter (laptop trackpads, OS easing) fires
                // mousemove repeatedly with no real movement; each one schedules
                // a forced render. Filter out moves smaller than the threshold.
                if (this._inspectClient
                    && Math.abs(e.clientX - this._inspectClient.x) < INSPECT_MOVE_THRESHOLD_PX
                    && Math.abs(e.clientY - this._inspectClient.y) < INSPECT_MOVE_THRESHOLD_PX) {
                    return;
                }
                this._inspectClient = {x: e.clientX, y: e.clientY};
                setRenderOne(true);
            };
            document.addEventListener("pointermove", this._inspectMouseHandler);

            const view = ViewMan.get("mainView", false);
            if (view?.canvas) {
                let action;
                this._inspectInteraction = registerSurfaceInteraction(view.canvas, {
                    model: this, view, content: false, profile: "wind",
                    enabled: () => this.inspect && this.inspectCursor && this.visible !== false,
                    intent: {kind: "pending", priority: 30},
                    hitTest: e => e.shiftKey || e.altKey ? {} : null,
                    begin: e => { action = e.shiftKey ? "add" : "delete"; },
                    click: e => this._handleInspectClick(e, action),
                    snapshot: () => this.inspectPoints.map(p => ({...p})),
                    restore: state => { this.inspectPoints = state.map(p => ({...p})); setRenderOne(true); },
                    undo: "Edit wind samples",
                });
            }
        } else if (!wanted && this._inspectMouseHandler) {
            document.removeEventListener("pointermove", this._inspectMouseHandler);
            this._inspectInteraction?.();
            this._inspectInteraction = null;
            this._inspectMouseHandler = null;
        }
        if (!wanted) this._inspectClient = null;
    }

    // The action is frozen at pointer-down; the router admits only a stationary click.
    _handleInspectClick(e, action) {
        if (!this.inspect || !this.inspectCursor) return;
        const view = ViewMan.get("mainView", false);
        if (!view || !mouseInView(view, e.clientX, e.clientY)) return;

        if (action === "add") {
            const [vx, vy] = mouseToView(view, e.clientX, e.clientY);
            const altMSL = this.windAltFt * 0.3048;
            const hit = this._rayHitWindShell(view, vx, vy, altMSL, _scratchHit);
            if (!hit) return;
            const lla = ECEFToLLAVD_radii(hit);
            if (!Number.isFinite(lla.x) || !Number.isFinite(lla.y)) return;
            this.inspectPoints.push({lat: lla.x, lon: lla.y});
            setRenderOne(true);
            return;
        }

        // delete: closest dropped point by screen-pixel distance.
        if (this.inspectPoints.length === 0) return;
        let bestIdx = -1, bestDist = Infinity;
        const altMSL = this.windAltFt * 0.3048;
        for (let i = 0; i < this.inspectPoints.length; i++) {
            const p = this.inspectPoints[i];
            const screen = this._latLonToScreen(view, p.lat, p.lon, altMSL);
            if (!screen) continue;
            const ddx = screen.x - e.clientX, ddy = screen.y - e.clientY;
            const d = ddx * ddx + ddy * ddy;
            if (d < bestDist) { bestDist = d; bestIdx = i; }
        }
        if (bestIdx >= 0) {
            this.inspectPoints.splice(bestIdx, 1);
            setRenderOne(true);
        }
    }

    // Project (lat, lon) on the wind shell into mainView client pixel coords.
    // Returns {x, y} in clientX/Y, or null if the point is behind the camera
    // or projects outside the visible viewport (in which case showing a
    // floating readout would just clutter the corners with off-screen labels).
    //
    // view.leftPx is relative to ViewMan's Content container, NOT the page —
    // mirrors mouseToView's screenOffsetX correction so the projected screen
    // pixel matches what e.clientX reports for the same on-screen pixel.
    // Without this, layouts with a sidebar would offset all anchored
    // readouts by the sidebar width.
    _latLonToScreen(view, lat, lon, altMSL) {
        const ecef = LLAToECEF(lat, lon, altMSL);
        if (!ecef) return null;
        _scratchNDC.copy(ecef).project(view.camera);
        // NDC z is depth: <-1 means behind the near plane / camera;
        // >1 means beyond the far plane.
        if (_scratchNDC.z < -1 || _scratchNDC.z > 1) return null;
        // NDC x/y outside [-1, 1] means horizontally/vertically off the
        // visible viewport. The point is still in front of the camera,
        // just not on screen — hide the readout for it.
        if (_scratchNDC.x < -1 || _scratchNDC.x > 1
            || _scratchNDC.y < -1 || _scratchNDC.y > 1) return null;
        const offsetX = ViewMan.screenOffsetX || 0;
        const x = offsetX + view.leftPx + (_scratchNDC.x + 1) * 0.5 * view.widthPx;
        const y = view.topPx + (1 - _scratchNDC.y) * 0.5 * view.heightPx;
        return {x, y};
    }

    _removeAllInspectArrows() {
        for (const id of [...this._inspectDivs.keys()]) {
            removeDebugArrow(`windInspect_${id}`);
        }
        if (this._inspectStalkIds) {
            for (const id of this._inspectStalkIds) {
                removeDebugArrow(`windInspectStalk_${id}`);
            }
            this._inspectStalkIds.clear();
        }
    }

    // Build (lazily) a floating readout div for one inspect point. Each
    // point gets its own div, keyed by id ("cursor","camera","target",
    // "drop:<idx>"); cursor uses a slightly larger style for emphasis.
    _ensureInspectDiv(id, color) {
        let d = this._inspectDivs.get(id);
        if (d) return d;
        d = document.createElement("div");
        const isCursor = id === "cursor";
        d.style.cssText = `
            position: fixed;
            background: rgba(0, 0, 0, 0.78);
            color: #fff;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            padding: ${isCursor ? "8px 12px" : "5px 8px"};
            border: 1px solid ${color};
            border-radius: 4px;
            pointer-events: none;
            z-index: ${INSPECT_READOUT_Z_INDEX};
            line-height: 1.2;
            white-space: nowrap;
        `;
        document.body.appendChild(d);
        this._inspectDivs.set(id, d);
        return d;
    }

    // True when the Camera ("camera") or Target ("target") row of Show Wind
    // at has a track to show. The menu uses it to leave out an object that
    // only repeats that row.
    hasAnchorTrack(anchor) {
        return !!this._trackForAnchor(anchor);
    }

    // Resolve the camera/target track for a given anchor type. Mirrors the
    // fallback chains used by _windNodePositions / _referenceLatLon so the
    // anchored inspect points use the same nodes as the rest of the wind
    // pipeline. Returns null when no usable track exists.
    _trackForAnchor(anchor) {
        // Camera = the observer's physical position (the jet, the ship, the
        // ground station). Prefer the *track* nodes over lookCamera —
        // lookCamera is the *rendering* camera and in many sitches sits far
        // out in space looking down at the scene, which would project off-
        // screen and isn't a meaningful wind-sample location.
        //
        // Custom sitches use cameraTrackSwitchSmooth / targetTrackSwitchSmooth
        // (smoothed outputs of the switch nodes); legacy fixed sitches use
        // cameraTrack / targetTrack; gimbal-style sitches use jetTrack /
        // LOSTraverseSelect. Try them in that order.
        const candidates = anchor === "camera"
            ? ["cameraTrackSwitchSmooth", "cameraTrack", "jetTrack", "lookCamera"]
            : anchor === "target"
            ? ["targetTrackSwitchSmooth", "targetTrack", "LOSTraverseSelect"]
            : [];
        for (const id of candidates) {
            if (!NodeMan.exists(id)) continue;
            const n = NodeMan.get(id);
            if (typeof n.p === "function") return n;
            if (n.camera?.position) {
                // lookCamera exposes .camera.position (a Vector3 in ECEF).
                return {p: () => n.camera.position};
            }
        }
        return null;
    }

    // Per-frame multi-point inspect render. Iterates cursor + dropped +
    // camera + target points, drawing one arrow + readout per active point.
    //
    // Altitude convention: every arrow is drawn on the wind shell at the
    // current windAltFt — even for Camera/Target points, whose anchor track
    // may sit thousands of feet above. The arrow is a wind-sample marker
    // pinned to the *displayed wind layer*, not the object itself. With
    // Lock Altitude = Camera/Target, windAltFt tracks the object's altitude
    // each frame and the arrow ends up exactly at the object's height; with
    // Lock = None the arrows mark the column directly under each anchor at
    // whatever the user has set as the display altitude.
    //
    // Stale arrows/divs (from points removed since last frame) are cleaned
    // up at the end of the loop so the next frame is consistent.
    _updateInspectArrows(view) {
        // Single-view feature; bail before any side effects on other views
        // so we don't churn ArrowHelpers between mainView/lookView passes.
        if (view?.id !== "mainView") return;
        // The readouts read windAt and the wind nodes, not the displayed grid,
        // so they do not wait for the lines to load.
        if (!this.inspect || !view.pixelsToMeters) return;

        // Build the list of points to render this frame. Each entry has:
        //   id      — stable key (used for arrow name + div map)
        //   color   — arrow + readout border
        //   label   — short tag in the readout (omitted for cursor)
        //   lat/lon — sample location
        //   altMSL  — per-point sample altitude in meters MSL. Cursor and
        //             dropped points use the wind-display altitude; Camera
        //             and Target use the underlying track's actual altitude
        //             (so e.g. Camera shows the wind at jet altitude even
        //             when windAltFt is set somewhere else).
        const dispAltMSL = this.windAltFt * 0.3048;
        const points = [];

        // Cursor — only when inside mainView. _inspectClient is null unless
        // the Mouse Cursor switch is on (_syncInspectCursor clears it).
        if (this.inspectCursor && this._inspectClient
            && mouseInView(view, this._inspectClient.x, this._inspectClient.y)) {
            const [vx, vy] = mouseToView(view, this._inspectClient.x, this._inspectClient.y);
            const hit = this._rayHitWindShell(view, vx, vy, dispAltMSL, _scratchHit);
            if (hit) {
                const lla = ECEFToLLAVD_radii(hit);
                if (Number.isFinite(lla.x) && Number.isFinite(lla.y)) {
                    points.push({
                        id: "cursor", color: "#ffff00",
                        lat: lla.x, lon: lla.y, altMSL: dispAltMSL,
                        anchorClient: {x: this._inspectClient.x, y: this._inspectClient.y},
                    });
                }
            }
        }

        // Camera + Target anchors, at the track's own position and height.
        // They read Local Wind and Target Wind themselves (windStateAt), so a
        // readout always shows what that wind node gives its users there,
        // Override, Manual and Lock included.
        const frame = playheadFrame();
        for (const [anchor, color, windId] of [
            ["camera", "#00cc66", "localWind"], ["target", "#ff3366", "targetWind"]]) {
            if (!(anchor === "camera" ? this.inspectCamera : this.inspectTarget)) continue;
            const track = this._trackForAnchor(anchor);
            if (!track) continue;
            const pos = track.p(frame);
            if (!pos) continue;
            const lla = ECEFToLLAVD_radii(pos);
            if (!Number.isFinite(lla.x) || !Number.isFinite(lla.y)
                || !Number.isFinite(lla.z)) continue;
            const trackAltM = lla.z - meanSeaLevelOffset(lla.x, lla.y);
            const windNode = NodeMan.get(windId, false);
            points.push({
                id: anchor, color, label: anchor[0].toUpperCase() + anchor.slice(1),
                lat: lla.x, lon: lla.y, altMSL: trackAltM,
                windNode: typeof windNode?.windStateAt === "function" ? windNode : null,
                ecef: pos,
            });
        }

        // 3D objects picked in Show Wind at, at each object's own altitude
        // (as for Camera and Target). An id whose object was deleted is
        // skipped, not removed, so undoing the delete brings it back.
        for (const id of Object.keys(this.inspectObjects)) {
            if (!this.inspectObjects[id]) continue;
            const node = NodeMan.get(id, false);
            if (!node?.group) continue;
            node.group.getWorldPosition(_scratchObjectPos);
            const lla = ECEFToLLAVD_radii(_scratchObjectPos);
            if (!Number.isFinite(lla.x) || !Number.isFinite(lla.y)
                || !Number.isFinite(lla.z)) continue;
            points.push({
                id: `object:${id}`, color: "#33ccff", label: node.menuName ?? id,
                lat: lla.x, lon: lla.y, altMSL: lla.z - meanSeaLevelOffset(lla.x, lla.y),
            });
        }

        // Persisted dropped points — at the display altitude. They belong to
        // the Mouse Cursor switch, which also adds and removes them.
        if (this.inspectCursor) {
            for (let i = 0; i < this.inspectPoints.length; i++) {
                const p = this.inspectPoints[i];
                points.push({
                    id: `drop:${i}`, color: "#ff9900", label: `#${i + 1}`,
                    lat: p.lat, lon: p.lon, altMSL: dispAltMSL,
                });
            }
        }

        // Render each point. seenIds tracks which arrows/divs are still
        // active so we can clean up leftovers from the previous frame.
        // The speed is in the Wind panel's unit (Units, or knots with Wind in
        // Knots), the same as the Target and Local Wind sliders.
        const unit = this.windSpeedUnit();
        // Heights in the height unit of Units (feet, or metres for Metric).
        const heightUnit = this.windHeightUnit();
        const seenIds = new Set();
        const placements = [];
        for (const p of points) {
            const ecef = p.ecef ?? LLAToECEF(p.lat, p.lon, p.altMSL);
            if (!ecef) continue;
            // The wind at the point's own height, never at the display
            // altitude: with no data there, the readout says so (until
            // 2026-11-03 it showed the display altitude's wind instead).
            const sample = this._readoutSample(p, frame, ecef);
            const hasWind = Number.isFinite(sample.from) && Number.isFinite(sample.knots);
            const from = hasWind ? sample.from : 0;
            const compass = compassFromDeg(from);
            const speedText = windSpeedText(hasWind ? sample.knots : NaN, unit);
            const dirText = hasWind ? `FROM ${compass} ${Math.round(from)}°` : "";
            const statusText = readoutStatusText(sample.status, sample.limitM, heightUnit);
            const sourceText = this.readoutSourceText(sample, p.lat, p.lon);

            // Arrow points TO (drift direction), 100 px on screen.
            const arrowName = `windInspect_${p.id}`;
            if (hasWind) {
                windDirFromBearing(p.lat, p.lon, from * DEG, _scratchDir);
                _scratchHit.copy(ecef);
                const lengthM = view.pixelsToMeters(_scratchHit, 100);
                _scratchEnd.copy(_scratchHit).addScaledVector(_scratchDir, lengthM);
                DebugArrowAB(arrowName, _scratchHit, _scratchEnd, p.color, true,
                    this.group, 30, LAYER.MASK_MAIN);
            } else {
                removeDebugArrow(arrowName);
                _scratchHit.copy(ecef);
            }
            seenIds.add(p.id);

            // Stalk: for user-dropped points, draw a thin green line from
            // the surface (altMSL = 0) to the wind-shell point so it's clear
            // where on the ground the point sits — useful when scrubbing
            // altitude or panning the view at a steep angle. headLength=0
            // makes the "arrow" render as a plain line. Cursor and Camera/
            // Target points already have a clear ground anchor (the cursor
            // / the moving track) so they don't need the stalk.
            if (p.id.startsWith("drop:")) {
                const surfaceECEF = LLAToECEF(p.lat, p.lon, 0);
                if (surfaceECEF) {
                    // headLength=1 (minimum non-fraction value) keeps the
                    // arrow head essentially invisible so the stalk reads
                    // as a plain line, while still staying on the
                    // recommended (non-fraction) headLength API.
                    DebugArrowAB(`windInspectStalk_${p.id}`,
                        surfaceECEF, _scratchHit, "#00cc66", true,
                        this.group, 1, LAYER.MASK_MAIN);
                    seenIds.add(`stalk:${p.id}`);
                }
            }

            // Readout div. Every readout (cursor + anchored + dropped)
            // shows its own sample altitude — Camera/Target reflect the
            // track's altitude, dropped points reflect the display altitude.
            // The height is a number (never "Surface"), with the height above
            // the ground where there is terrain.
            const div = this._ensureInspectDiv(p.id, p.color);
            // (Not over the sea, where the ground is sea level and the two
            // heights are the same.)
            const groundM = this._groundMSL(p.lat, p.lon);
            const aboveGround = groundM != null && groundM > 1 && p.altMSL >= groundM
                ? ` · ${heightText(p.altMSL - groundM, heightUnit)} above ground` : "";
            const heightLine = `@ ${heightText(p.altMSL, heightUnit)}${aboveGround}`;
            // Override is said once, as the source.
            const statusLine = statusText && sample.status !== "override"
                ? `<div style="font-size:10px;color:#ffcc66">${escapeXML(statusText)}</div>` : "";
            // The source text can hold a track's name, from a file: escaped.
            const sourceLine = sourceText
                ? `<div style="font-size:10px;opacity:0.65">${escapeXML(sourceText)}</div>` : "";
            if (p.id === "cursor") {
                div.innerHTML =
                    `<div style="font-size:22px;font-weight:600">${speedText}</div>`
                    + (dirText ? `<div style="font-size:13px;opacity:0.85">${dirText}</div>` : "")
                    + `<div style="font-size:11px;opacity:0.65">${heightLine}</div>`
                    + sourceLine + statusLine;
            } else {
                // The label can be an object's display name, which the user
                // types or an imported file sets: escape it, never trust it.
                div.innerHTML =
                    `<div style="font-size:11px;opacity:0.85">${escapeXML(p.label)}</div>`
                    + `<div style="font-size:14px;font-weight:600">${speedText}</div>`
                    + (dirText ? `<div style="font-size:11px;opacity:0.85">${dirText}</div>` : "")
                    + `<div style="font-size:10px;opacity:0.65">${heightLine}</div>`
                    + sourceLine + statusLine;
            }
            div.style.display = "block";

            // Anchor: cursor uses the actual cursor position; others project
            // their lat/lon to screen pixels. Off-screen → hide (skip).
            const anchorPx = p.anchorClient
                ?? this._latLonToScreen(view, p.lat, p.lon, p.altMSL);
            if (!anchorPx) {
                div.style.display = "none";
                continue;
            }
            placements.push({div, anchor: anchorPx, w: div.offsetWidth, h: div.offsetHeight});
        }
        this._layoutReadouts(placements);

        // Sweep: drop arrows + hide divs whose ids didn't render this frame
        // (cursor left the view, dropped point removed, etc).
        for (const id of [...this._inspectDivs.keys()]) {
            if (seenIds.has(id)) continue;
            removeDebugArrow(`windInspect_${id}`);
            const div = this._inspectDivs.get(id);
            if (div) div.style.display = "none";
        }
        // Stalks are tracked separately because they don't have associated
        // divs (the readout div hovers near the point, not the stalk).
        if (!this._inspectStalkIds) this._inspectStalkIds = new Set();
        for (const id of this._inspectStalkIds) {
            if (seenIds.has(`stalk:${id}`)) continue;
            removeDebugArrow(`windInspectStalk_${id}`);
        }
        this._inspectStalkIds = new Set();
        for (const id of seenIds) {
            if (id.startsWith("stalk:")) {
                this._inspectStalkIds.add(id.slice("stalk:".length));
            }
        }
    }

    // {from, knots, status} for a Show Wind at point. Camera and Target read
    // their wind nodes; every other point reads the Wind Source.
    _readoutSample(p, frame, ecef) {
        if (p.windNode) return p.windNode.windStateAt(frame, ecef);
        const w = this.windAt(this.source, p.lat, p.lon, p.altMSL, frame);
        if (!Number.isFinite(w.u) || !Number.isFinite(w.v)) {
            return {from: null, knots: null, status: w.status, sourceKey: this.source};
        }
        const sample = {...fromUVToDirKnots(w.u, w.v), status: w.status, sourceKey: this.source};
        if (w.limitM != null) sample.limitM = w.limitM;
        return sample;
    }

    // The unit of every wind speed on the Wind panel: Units, or knots when
    // Wind in Knots is on. {abbrev, fromKnots}; see windSpeedUnit.
    windSpeedUnit() {
        return windSpeedUnit(Units, this.windInKnots);
    }

    // The unit of every height on the Wind panel: the height unit of Units
    // (feet, or metres for Metric). Wind in Knots does not change it.
    windHeightUnit() {
        return windHeightUnit(Units);
    }

    // The speed unit changed (Wind in Knots, or Units): every row that shows a
    // speed gets the new unit. CUnits calls changeUnits / updateDesc on every
    // node that has them; Target and Local Wind have their own.
    refreshWindSpeedRows() {
        for (const id of ["targetWind", "localWind"]) NodeMan.get(id, false)?.refreshSpeedGUI?.();
        this.onWindSpeedUnitChanged?.();   // Max Speed (CustomManagerSetup)
        this._provenanceAt = 0;            // the Status line, at the next update
        setRenderOne(true);
    }

    changeUnits() {
        this.onWindSpeedUnitChanged?.();
        this.onWindHeightUnitChanged?.();   // Altitude (CustomManagerSetup)
        this._provenanceAt = 0;
    }

    updateDesc() {
        this.onWindSpeedUnitChanged?.();
        this.onWindHeightUnitChanged?.();
    }

    // Put the readout boxes where they cover neither each other nor a menu.
    _layoutReadouts(placements) {
        if (placements.length === 0) return;
        const spots = placeReadoutBoxes(placements, this._menuRects(),
            window.innerWidth, window.innerHeight, INSPECT_TOOLTIP_OFFSET_PX);
        placements.forEach((item, i) => {
            item.div.style.left = spots[i].left + "px";
            item.div.style.top = spots[i].top + "px";
        });
    }

    // The screen rectangles of the menus: each root lil-gui panel (the menu
    // bar's menus, and any menu dragged out of it) that is on the screen.
    _menuRects() {
        const rects = [];
        for (const el of document.querySelectorAll(".lil-gui.root")) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
                rects.push({left: r.left, top: r.top, right: r.right, bottom: r.bottom});
            }
        }
        return rects;
    }

    // ── Where the wind comes from: the Status line and the readouts ───
    //
    // Facts about the data that a source gives near a point, or null:
    //   kind       "manual" | "grid" | "soundings" | "profile" | "openmeteo"
    //              | "telemetry" | "other"
    //   label      the source's short name, as the menus show it
    //   time       the data time ("2025-09-19 12Z"): the GFS cycle, the
    //              launch of the nearest sounding, the Open-Meteo hour
    //   timeNote   why that time is not the data's own (a file with no time)
    //   count      soundings in the set
    //   distanceKm from the point to the nearest data (a sounding station, an
    //              Open-Meteo column)
    //   gridDeg    the grid spacing of a grid source
    //   bottomM, topM  the heights (m MSL) of the lowest and highest wind
    sourceFacts(sourceKey, lat = null, lon = null) {
        const label = windSourceShortLabel(sourceKey);
        const havePoint = Number.isFinite(lat) && Number.isFinite(lon);
        if (sourceKey === "manual") return {kind: "manual", label};
        if (sourceKey === "gfs" || sourceKey === "custom") {
            // The two grid times that the playhead's time blends (decision D5),
            // each named by the cycle of the data loaded for it (refTime: it can
            // be an earlier cycle than the one asked for).
            const ms = this._frameTimeMs(playheadFrame());
            const {c0, c1, w} = gridTimesAround(ms, this.gridCadenceHours(sourceKey));
            let gridDeg = null;
            const labelOf = (time) => {
                const prefix = `${sourceKey}:${time.dateStr}_${time.hour}_`;
                let refTime = null;
                for (const key in this._levelCache) {
                    if (!key.startsWith(prefix)) continue;
                    const json = this._levelCache[key];
                    refTime ??= json.refTime ?? null;
                    if (gridDeg == null && Number.isFinite(json.dlon)) gridDeg = Math.abs(json.dlon);
                }
                const d = time.dateStr;
                return cycleLabel(refTime)
                    ?? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)} ${String(time.hour).padStart(2, "0")}Z`;
            };
            const first = labelOf(c0);
            const second = w > 0 ? labelOf(c1) : null;
            const blended = !!second && second !== first;
            const time = !blended ? first
                : second.slice(0, 10) === first.slice(0, 10) ? `${first}–${second.slice(11)}` : `${first}–${second}`;
            return {kind: "grid", label, time, blended, at: dataTimeText(ms)?.slice(11) ?? null, gridDeg,
                topM: WIND_LEVEL_TABLE[WIND_LEVEL_TABLE.length - 1].ft * 0.3048};
        }
        const set = this._soundingSet(sourceKey);
        if (set) {
            let nearest = null, distanceKm = null, bottomM = null, topM = null;
            for (const p of set.profiles) {
                const bottom = typeof p.bottomWindAlt === "function" ? p.bottomWindAlt() : null;
                if (bottom != null && (bottomM == null || bottom < bottomM)) bottomM = bottom;
                if (p.topWindAlt != null && (topM == null || p.topWindAlt > topM)) topM = p.topWindAlt;
                if (!havePoint || p.stationLat == null || p.stationLon == null) continue;
                const km = greatCircleDistanceDeg(lat, lon, p.stationLat, p.stationLon) * KM_PER_DEG;
                if (distanceKm == null || km < distanceKm) {
                    distanceKm = km;
                    nearest = p;
                }
            }
            nearest ??= set.profiles[0] ?? null;
            const launch = typeof nearest?.launchTimeMs === "function" ? nearest.launchTimeMs() : null;
            return {
                kind: altitudeProfileForSourceKey(sourceKey) ? "profile" : "soundings",
                label, count: set.profiles.length, time: dataTimeText(launch),
                timeNote: nearest?.timeFromFile === false ? "no time in the file: the sitch start" : null,
                distanceKm, bottomM, topM,
            };
        }
        if (sourceKey === "openmeteo") {
            const date = GlobalDateTimeNode?.dateNow ?? new Date();
            const near = havePoint
                ? this._nearestOpenMeteoColumn(lat, lon, date.toISOString().slice(0, 10)) : null;
            const levels = near?.column.hours[date.getUTCHours()] ?? [];
            const hourMs = Math.floor(date.valueOf() / 3600000) * 3600000;
            return {kind: "openmeteo", label, time: dataTimeText(hourMs),
                distanceKm: near ? near.distanceDeg * KM_PER_DEG : null,
                bottomM: levels[0]?.altM ?? null, topM: levels[levels.length - 1]?.altM ?? null};
        }
        if (isTrackSourceKey(sourceKey)) return {kind: "telemetry", label};
        return {kind: "other", label};
    }

    // One line for the Status row: the source, the data time, the distance
    // from `role` ("target" or "camera") to the nearest data, and the heights
    // that the data covers. Until 2026-11-03 the Status gave a count and the
    // display altitude ("UWYO (3) 3,050 ft").
    _factsLine(facts, role) {
        if (!facts) return "";
        const distance = facts.distanceKm != null
            ? ` ${Math.round(facts.distanceKm).toLocaleString()} km from the ${role}.` : "";
        const hu = this.windHeightUnit();
        const heights = facts.bottomM != null && facts.topM != null
            ? ` Wind data ${heightText(facts.bottomM, hu)} to ${heightText(facts.topM, hu)}.` : "";
        switch (facts.kind) {
            case "manual": {
                const tw = NodeMan.get("targetWind", false);
                const value = tw && Number.isFinite(tw.from) && Number.isFinite(tw.knots)
                    ? ` ${Math.round(tw.from)}° at ${windSpeedText(tw.knots, this.windSpeedUnit())},` : "";
                return `Manual:${value} the same at every place, height and time.`;
            }
            case "grid": {
                const grid = facts.gridDeg != null ? `, ${facts.gridDeg}° grid` : "";
                const blend = facts.blended && facts.at ? `, blended in time for ${facts.at}` : "";
                return `${facts.label} ${facts.time}${blend}${grid}.`
                    + ` Heights ${heightText(GFS_SURFACE_AGL_M, hu)} above the ground`
                    + ` to ${heightText(facts.topM, hu)}.`;
            }
            case "soundings":
                return `${facts.label}: ${facts.count} sounding${facts.count === 1 ? "" : "s"}`
                    + `${facts.time ? `, nearest launched ${facts.time}` : ""}.${distance}${heights}`;
            case "profile":
                return `${facts.label}: one profile${facts.time ? `, ${facts.time}` : ""}`
                    + `${facts.timeNote ? ` (${facts.timeNote})` : ""}.${distance}${heights}`;
            case "openmeteo":
                return `${facts.label}: model data for ${facts.time}.`
                    + (facts.distanceKm != null ? ` Column${distance}` : "") + heights;
            case "telemetry":
                return `${facts.label}: the wind in the track, at the time of each frame.`;
            default:
                return `${facts.label}.`;
        }
    }

    // A point's lat/lon from the camera or target track at the playhead, or null.
    _anchorLatLon(anchor) {
        const track = this._trackForAnchor(anchor);
        if (!track) return null;
        try {
            const pos = track.p(playheadFrame());
            if (!pos) return null;
            const lla = ECEFToLLAVD_radii(pos);
            return Number.isFinite(lla.x) && Number.isFinite(lla.y) ? {lat: lla.x, lon: lla.y} : null;
        } catch (e) {
            return null;   // a track that is not ready (during a load)
        }
    }

    // The Status line: where Target Wind (and, with Separate Wind Sources,
    // Local Wind) comes from.
    provenanceText() {
        const target = this._anchorLatLon("target");
        const camera = this._anchorLatLon("camera");
        const ref = target ?? camera ?? this._referenceLatLon();
        const role = target ? "target" : "camera";
        let text = this._factsLine(this.sourceFacts(this.source, ref?.lat, ref?.lon), role);
        if (this.sourceSeparate && this.sourceLocal !== this.source) {
            const at = camera ?? ref;
            text = `Target: ${text} Local: `
                + this._factsLine(this.sourceFacts(this.sourceLocal, at?.lat, at?.lon), "camera");
        }
        if (this._levelQueueActive > 0 || this._levelQueue.length > 0 || this._omInFlight.size > 0) {
            text += " Loading more data…";
        }
        return text;
    }

    // Show the provenance on the Status row, and keep it current (update()).
    _showProvenance() {
        this._statusIsProvenance = true;
        this._provenanceAt = performance.now();
        this.statusText = this.provenanceText();
    }

    // A message on the Status row (loading, an error, a fit result). It stays
    // until the next load.
    setStatusMessage(text) {
        if (text === this.statusText) return;
        this._statusIsProvenance = false;
        this.statusText = text;
    }

    // A short source line for a readout: the source and its data time, and the
    // distance to the data where it has one.
    readoutSourceText(sample, lat, lon) {
        if (sample.status === "override") return "Override";
        if (sample.status === "manual") return "Manual";
        const facts = this.sourceFacts(sample.sourceKey ?? this.source, lat, lon);
        if (!facts) return "";
        const parts = [facts.label];
        if (facts.time) parts.push(facts.time);
        let text = parts.join(" ");
        if (facts.distanceKm != null && facts.kind !== "openmeteo") {
            text += ` · ${Math.round(facts.distanceKm).toLocaleString()} km`;
        }
        return text;
    }

    // Resolve a "where am I looking from" lat/lon for the nearby filter.
    // Tries Sit.fromLat/fromLon first (legacy fixed-camera sitches), then
    // cameraTrack at frame 0 (jet/track sitches like Gimbal — same fallback
    // chain used by _windNodePositions). Returns null if nothing's available.
    _referenceLatLon() {
        if (Sit.fromLat != null && Sit.fromLon != null
            && Number.isFinite(Sit.fromLat) && Number.isFinite(Sit.fromLon)) {
            return {lat: Sit.fromLat, lon: Sit.fromLon};
        }
        for (const id of ["cameraTrack", "jetTrack", "lookCamera"]) {
            if (!NodeMan.exists(id)) continue;
            const n = NodeMan.get(id);
            const f = playheadFrame();
            let pos = null;
            if (typeof n.p === "function") pos = n.p(f);
            else if (n.camera?.position) pos = n.camera.position;
            if (!pos) continue;
            const lla = ECEFToLLAVD_radii(pos);
            if (Number.isFinite(lla.x) && Number.isFinite(lla.y)) {
                return {lat: lla.x, lon: lla.y};
            }
        }
        return null;
    }

    // ── streamline geometry with multi-LOD ───────────────────────────
    // Settle-gate hook (run.mjs settleStateFn + ExportFrameSettler). The wind
    // field's data is fetched ASYNCHRONOUSLY and its streamline mesh is only
    // built once that fetch lands — a window the generic load/tile/texture
    // gates can't see. Without this, under concurrent load the scene settles
    // and the screenshot is taken BEFORE the streamlines exist, so they're
    // entirely missing from the capture (the long-standing "wind test"
    // regression flake — a fixed ~30351px diff because the streamlines are
    // binary present/absent, not subtly shifted). Report pending across the
    // entire load: the queued deferred fetch, the GFS multi-level reload, and
    // any in-flight fetchWindForAltitude.
    getPendingLoadState(viewIds = null) {
        const hasPending =
            !!this._needsPostDeserializeFetch ||
            Array.isArray(this._needsPostDeserializeReloadGFS) ||
            !!this._reloadInFlight ||
            !!this.fetching ||
            // Data that windAt asked for (live Target/Local Wind, readouts).
            this._levelQueueActive > 0 || this._levelQueue.length > 0 ||
            this._omInFlight.size > 0;
        return {hasPending};
    }

    rebuildStreamlines() {
        if (this.linesMesh) {
            this.group.remove(this.linesMesh);
            this.linesMesh.geometry.dispose();
            this.linesMesh = null;
        }

        // Per-sonde altitude arrows update independently of the streamline
        // mesh — they only depend on windAltFt and the loaded sonde profiles.
        // Run BEFORE the early-returns below so they refresh even when the
        // streamline geometry is empty (e.g. nearby bbox missed all data).
        this._updateSondeWindArrows();

        if (!this.windU) return;

        const alt    = this.renderAltitude;
        const center = LLAToECEF(0, 0, alt);
        const out    = {pos: [], prog: [], id: [], spd: [], cov: [], lod: []};
        let lineIndex = 0;

        // 4-level LOD: coarse seeds always visible, finer seeds fade in near camera
        // Clamp finest spacing to 0.375° to keep vertex count under ~25M
        const baseSpacing = Math.max(this.seedSpacing, 0.75);
        const spacings = [baseSpacing * 2, baseSpacing, baseSpacing * 0.5];
        const finest = baseSpacing * 0.25;
        if (finest >= 0.375) spacings.push(finest);

        // Track which grid cells already have a seed from a coarser level
        const seeded = new Set();
        const finestSpacing = spacings[spacings.length - 1];

        // Nearby-only: clip seed iteration to a lat/lon bbox around the
        // sitch origin so we don't trace global streamlines we'll never see.
        // 1° lat ≈ 111 km; lon scales by cos(lat). Box rounds outward so the
        // visible disk is fully covered even at coarse spacings.
        let latMin = -85, latMax = 85, lonMin = 0, lonMax = 360;
        let crossesAntimeridian = false;
        // Track which reference lat/lon this build was anchored to, so
        // update() can rebuild when the camera scrubs far enough that the
        // bbox no longer covers what the user is looking at.
        this._lastRebuildRef = null;
        if (this.nearbyOnly) {
            const ref = this._referenceLatLon();
            if (ref) {
                this._lastRebuildRef = {lat: ref.lat, lon: ref.lon};
                const dLat = this.nearbyRadiusKm / 111;
                const cosLat = Math.max(0.05, Math.cos(ref.lat * DEG));
                const dLon = this.nearbyRadiusKm / (111 * cosLat);
                latMin = Math.max(-85, ref.lat - dLat);
                latMax = Math.min( 85, ref.lat + dLat);
                // Normalize sitch origin lon into [0, 360) for the cell loop,
                // which also runs in [0, 360). Antimeridian wrap is handled below.
                const cLon = ((ref.lon % 360) + 360) % 360;
                lonMin = cLon - dLon;
                lonMax = cLon + dLon;
                crossesAntimeridian = lonMin < 0 || lonMax >= 360;
            }
        }
        const inLonBox = (lon) => {
            if (!crossesAntimeridian) return lon >= lonMin && lon <= lonMax;
            // Wrap: bbox spans the seam, so accept the two halves separately.
            return lon >= ((lonMin + 360) % 360) || lon <= (lonMax % 360);
        };

        for (let lod = 0; lod < spacings.length; lod++) {
            const sp = spacings[lod];
            for (let lat0 = -85; lat0 <= 85; lat0 += sp) {
                if (lat0 < latMin || lat0 > latMax) continue;
                const row = Math.round((lat0 + 85) / sp);
                const lonOff = (row % 2) ? sp * 0.5 : 0;
                for (let lon0 = 0; lon0 < 360; lon0 += sp) {
                    if (!inLonBox(lon0)) continue;
                    // Quantise to the finest grid cell to de-duplicate across LOD levels
                    const qLat = Math.round(lat0 / finestSpacing);
                    const qLon = Math.round(lon0 / finestSpacing);
                    const key = qLat * 100000 + qLon;
                    if (seeded.has(key)) continue;
                    seeded.add(key);

                    // Jitter
                    const jHash = Math.sin(lat0 * 127.1 + lon0 * 311.7) * 43758.5453;
                    const jitter = (jHash - Math.floor(jHash)) * sp * 0.4;
                    const sLat = lat0 + jitter * 0.3;
                    const sLon = lon0 + lonOff + jitter;

                    lineIndex = this._traceStreamline(sLat, sLon, lod, lineIndex, alt, center, out);
                }
            }
        }

        if (out.pos.length === 0) return;

        const geom = new LineSegmentsGeometry().setPositions(out.pos);
        // Two packed attributes per segment retain GPU-only dash animation and
        // per-endpoint speed/coverage without duplicating ribbon vertices.
        const wind = new Float32Array(out.prog.length * 4);
        for (let i = 0; i < out.prog.length; i++) {
            wind[i * 4] = out.prog[i];
            wind[i * 4 + 1] = out.spd[i];
            wind[i * 4 + 2] = out.cov[i];
            wind[i * 4 + 3] = i % 2 === 0 ? out.id[i] : out.lod[i];
        }
        const windBuffer = new InstancedInterleavedBuffer(wind, 8, 1);
        geom.setAttribute("instanceWindStart", new InterleavedBufferAttribute(windBuffer, 4, 0));
        geom.setAttribute("instanceWindEnd", new InterleavedBufferAttribute(windBuffer, 4, 4));
        updateLineJoins(geom);
        this.linesMesh = new LineSegments2(geom, this.material);
        this.linesMesh.position.set(center.x, center.y, center.z);
        this.linesMesh.layers.mask = this.group.layers.mask;
        this.linesMesh.raycast = () => {};   // skip raycasting on millions of segments
        this.linesMesh.frustumCulled = false; // globe-spanning geometry, always draw
        this.linesMesh.visible = this.linesVisible;
        this.group.add(this.linesMesh);

        // Dash-phase determinism for regression screenshots. The flowing-dash
        // shader reads uTime; uTime is normally pinned to Globals.fixedFrame in
        // update() (see ~line 2222). But under concurrent load the per-render
        // update() that does that pinning may NOT run before the screenshot, so
        // uTime is captured at its stale initial value (0) instead of the locked
        // frame — shifting the dash phase and flipping which streamline segments
        // are bright vs dim (a bistable ~1.5% diff, the wind-test flake: identical
        // camera + identical wind data, only the cosmetic dash differs). Pin it
        // here at build time too — rebuildStreamlines always runs during load — so
        // the captured frame's dash is deterministic regardless of update() timing.
        // Live playback (fixedFrame undefined) keeps free-running off frameCount.
        if (Globals.fixedFrame !== undefined) {
            this.material.uniforms.uTime.value = Globals.fixedFrame;
        }

        const lodCounts = [0, 0, 0];
        out.lod.forEach(l => lodCounts[l]++);
        console.log(`Wind field: ${lineIndex} streamlines, ${out.pos.length / 3} verts ` +
            `(LOD0: ${lodCounts[0] / 2}, LOD1: ${lodCounts[1] / 2}, LOD2: ${lodCounts[2] / 2})`);
    }

    // True when this.source is a grid-based source (GFS or env-defined custom)
    // — both share the bracket/blend pipeline, level cache, and FileManager
    // persistence, and are mutually substitutable across that surface.
    // One sentence on where the wind for `role` ("target" or "camera") comes
    // from, for a report: the source, its data time where known, and how the
    // value was read. Null for a telemetry Track entry (the caller describes the
    // captured series) and for Manual (a typed value).
    windProvenance(role = "target") {
        const key = (role === "camera" && this.sourceSeparate) ? this.sourceLocal : this.source;
        if (key === "manual") return null;
        if (isTrackSourceKey(key) && !altitudeProfileForSourceKey(key)) return null;
        const at = `read on each frame at the ${role}'s position, height and time`;
        if (key === "gfs" || key === "custom") {
            // The cycle of the data for the current time (sourceFacts), not
            // the cycle of the displayed lines (_lastRefTime).
            const name = windSourceByKey(key)?.label ?? key;
            const facts = this.sourceFacts(key);
            const cycles = facts.blended ? `cycles ${facts.time}, blended in time` : `cycle ${facts.time}`;
            return `${name}, ${cycles}, ${at}.`;
        }
        const set = this._soundingSet(key);
        if (set) {
            const n = set.profiles.length;
            const what = altitudeProfileForSourceKey(key)
                ? `the one profile ${set.label}`
                : `${n} sounding${n === 1 ? "" : "s"} (${set.label}) blended by distance`;
            return `Wind from ${what}, ${at}.`;
        }
        const name = windSourceByKey(key)?.label ?? key;
        return `${name}, ${at}.`;
    }

    _isGridSource() {
        return this.source === "gfs" || this.source === "custom";
    }

    // True when both bracketing pressure levels for `altFt` are already
    // resident (in _levelCache or in FileManager via _loadedWindFiles).
    // The altitude-slider live-update path uses this to decide whether it can
    // safely re-fetch on every drag tick without hitting the network.
    hasGFSBracketCached(altFt) {
        if (!this._isGridSource()) return false;
        const {lo, hi} = bracketingLevels(altFt);
        // Both grid times that the playhead's time blends (decision D5).
        return this._gridTimesFor().every(({dateStr, hour}) => this._hasLevelPair(dateStr, hour, lo, hi));
    }

    // The grid times that frame f blends: the one at or before its time, and
    // the next one unless the time is exactly on the first.
    _gridTimesFor(f = playheadFrame(), sourceKey = this.source) {
        const {c0, c1, w} = gridTimesAround(this._frameTimeMs(f), this.gridCadenceHours(sourceKey));
        return w > 0 ? [c0, c1] : [c0];
    }

    _hasLevelPair(dateStr, hour, lo, hi) {
        const has = (level) => {
            if (this._levelCache[levelKey(this.source, dateStr, hour, level)]) return true;
            for (const meta of this._loadedWindFiles.values()) {
                if (meta.sourceKey === this.source
                    && meta.dateStr === dateStr
                    && meta.hour === String(hour)
                    && meta.level === level) return true;
            }
            return false;
        };
        return has(lo.level) && (lo.level === hi.level || has(hi.level));
    }

    // ── fetch a single level (with caching) ─────────────────────────
    // sourceKey: "gfs" or "custom". A level new to _levelCache changes
    // _sourceDataVersion, so the wind nodes read it.
    async _fetchLevel(level, dateStr, hour, sourceKey = this.source) {
        const cacheKey = levelKey(sourceKey, dateStr, hour, level);
        const cached = this._levelCache[cacheKey];
        // A level that came back from an EARLIER cycle (the requested one was
        // not published yet) is kept only for a while, then asked for again,
        // so it does not stand in for the requested cycle for the session.
        if (cached && !(cached._earlierCycle && Date.now() - cached._fetchedAt > EARLIER_CYCLE_RETRY_MS)) {
            return cached;
        }

        // Persistent cache: a previous session may have stored this level's
        // grid in FileManager (and we restored it in modDeserialize). Reuse
        // the cached file rather than re-hitting the network.
        for (const [fid, meta] of this._loadedWindFiles) {
            if (meta.sourceKey === sourceKey && meta.dateStr === dateStr
                && meta.hour === String(hour) && meta.level === level) {
                const entry = FileManager.list[fid];
                if (entry) {
                    const cached = CNodeDisplayWindField._parseWindEntry(entry);
                    if (cached?.u && cached?.v) {
                        this._levelCache[cacheKey] = cached;
                        this._sourceDataVersion++;
                        return cached;
                    }
                }
            }
        }

        // Custom env-defined sources go through customWindProxy.php, which
        // substitutes date/hour/level into CUSTOM_WIND_URL. Both proxies
        // return the same earth.nullschool-format JSON, so the rest of the
        // bracket/blend pipeline doesn't care which one served the data.
        // Dedupe concurrent fetches of the SAME level — the balloon layer
        // pre-load fires on every re-bake (e.g. during a frame-slider drag),
        // and without this each tick would re-hit the network for a level whose
        // fetch is already in flight.
        this._inFlightLevels = this._inFlightLevels || {};
        if (this._inFlightLevels[cacheKey]) return this._inFlightLevels[cacheKey];

        const proxy = sourceKey === "custom"
            ? "customWindProxy.php"
            : "windProxy.php";
        const url = `sitrecServer/${proxy}?date=${dateStr}&hour=${hour}&level=${level}`;
        const label = `${sourceKey === "custom" ? "Custom" : "GFS"} wind `
            + (level === "surface" ? "surface" : `${level} hPa`);
        // The GFS proxy shells out to fetch_wind.py which pulls a GRIB2 slice
        // from NOMADS/AWS — can take 10–20s on a cold cache. A corner status
        // indicator (LoadingManager, "Wind" category) shows while it loads. 60s
        // timeout covers the worst case without hanging the UI indefinitely.
        const p = (async () => {
            const taskId = `wind-${cacheKey}`;
            LoadingManager.registerLoading(taskId, label, "Wind");
            const ctrl = new AbortController();
            const to = setTimeout(() => ctrl.abort(), 60000);
            try {
                let resp;
                try {
                    resp = await fetch(url, {signal: ctrl.signal});
                } catch (e) {
                    if (e.name === "AbortError") throw new Error(`Timeout fetching ${level} (60s)`);
                    throw e;
                }
                if (!resp.ok) throw new Error(`HTTP ${resp.status} for level ${level}`);
                const json = await resp.json();
                if (json.error) throw new Error(json.error);
                if (!json.u || !json.v) throw new Error(`Missing u/v for level ${level}`);
                const ref = cycleOfRefTime(json.refTime);
                if (ref && (ref.dateStr !== dateStr || ref.hour !== Number(hour))) {
                    json._earlierCycle = true;
                    json._fetchedAt = Date.now();
                }
                this._levelCache[cacheKey] = json;
                this._sourceDataVersion++;
                return json;
            } finally {
                clearTimeout(to);
                LoadingManager.completeLoading(taskId);
            }
        })();
        this._inFlightLevels[cacheKey] = p;
        try {
            return await p;
        } finally {
            delete this._inFlightLevels[cacheKey];
        }
    }

    // Pre-fetch every grid (GFS/custom) pressure level from the surface up to
    // one level above `altFt`, so a wind-driven balloon that will climb to that
    // altitude has REAL wind at all its levels instead of the constant fallback.
    // Each uncached level shows its own loading indicator (see _fetchLevel).
    // Async, idempotent (cached levels are skipped fast), no-op for non-grid
    // sources (a sounding covers all altitudes in one fetch). Bumps the wind
    // data version when new levels arrive so baked balloons re-bake with the
    // fuller field.
    async ensureLevelsUpToAltitude(altFt) {
        if (!this._isGridSource() || !Number.isFinite(altFt) || altFt <= 0) return;
        const need = [];
        for (let i = 0; i < WIND_LEVEL_TABLE.length; i++) {
            need.push(WIND_LEVEL_TABLE[i].level);
            if (WIND_LEVEL_TABLE[i].ft >= altFt) break;   // include the bracketing level above altFt
        }
        const before = Object.keys(this._levelCache).length;
        const MAX_CONCURRENT = 3;   // don't hammer the proxy / NOMADS
        // Each grid time that the playhead's time blends (decision D5).
        const jobs = this._gridTimesFor().flatMap(time => need.map(level => ({level, time})));
        for (let i = 0; i < jobs.length; i += MAX_CONCURRENT) {
            await Promise.all(jobs.slice(i, i + MAX_CONCURRENT).map(({level, time}) =>
                this._fetchLevel(level, time.dateStr, time.hour).catch(() => null)));
        }
        if (Object.keys(this._levelCache).length !== before) {
            this._windDataVersion = (this._windDataVersion ?? 0) + 1;
            setRenderOne(true);
        }
    }

    // ── Populate the display field from the active source ────────────
    //
    // Source-agnostic entry point. The caller sets `this.source` first.
    // After filling, target/local winds are propagated from the source
    // sampled at their respective altitudes (not the display altitude).
    async fetchWindForAltitude(altFt) {
        altFt = altFt ?? this.windAltFt;

        // Coalesce rapid changes: if a fetch is in flight, record the latest
        // desired (altitude, source) and let the in-flight fetch pick it up
        // when it finishes. Tracking source as well as altitude means a
        // dropdown change during a fetch isn't silently dropped.
        if (this.fetching) {
            this._pendingAltFt = altFt;
            this._pendingSource = this.source;
            return;
        }
        this.fetching = true;
        this.windAltFt = altFt;
        const ranSource = this.source;

        try {
            if (this.source === "gfs" || this.source === "custom") {
                await this._fillFromGridSource(altFt);
            } else if (this._soundingSet()) {
                // Includes the Track entry of a sounding track, so this comes
                // before the plain track branch below.
                await this._fillFromSoundings(altFt, this.source);
            } else if (this.source === "openmeteo") {
                await this._fillFromOpenMeteo(altFt);
            } else if (this.source === "manual") {
                this._fillFromManual(altFt);
            } else if (isTrackSourceKey(this.source)) {
                this._fillFromTrackSource(altFt);
            } else {
                throw new Error(`Unknown wind source: ${this.source}`);
            }

            // Draw streamlines at the actual wind altitude (meters MSL).
            // A small floor (10 m) keeps surface wind visible without
            // disappearing into the sea/ocean at sea-level tiles. Terrain
            // clipping for higher ground is an accepted artifact; the user
            // can raise the altitude slider to clear terrain.
            this.renderAltitude = Math.max(10, altFt * 0.3048);

            this.rebuildStreamlines();
            setRenderOne(true);

            // Propagate wind at each node's *own* altitude
            await this.propagateToWindNodes();
            this._showProvenance();
        } catch (err) {
            console.error("Wind fetch failed:", err);
            this.setStatusMessage(`Error: ${err.message}`);
        } finally {
            this.fetching = false;
        }

        // Re-run if the slider moved or the source changed during the fetch.
        const pendingAlt = this._pendingAltFt;
        const pendingSource = this._pendingSource;
        this._pendingAltFt = null;
        this._pendingSource = null;
        const altChanged = pendingAlt != null && pendingAlt !== altFt;
        const sourceChanged = pendingSource != null && pendingSource !== ranSource;
        if (altChanged || sourceChanged) {
            if (sourceChanged) this.source = pendingSource;
            await this.fetchWindForAltitude(pendingAlt ?? altFt);
        }
    }

    // ── Pressure-level grid sources (GFS or env-defined custom) ─────
    //
    // Both share the earth.nullschool JSON shape and the bracket/blend
    // pipeline. The only differences — proxy URL and status label — are
    // resolved by `this.source`: _fetchLevel routes to windProxy.php or
    // customWindProxy.php, and the status string falls back to the JSON's
    // own `source` field (set server-side by the custom endpoint's upstream).
    async _fillFromGridSource(altFt) {
        const source = this.source;
        // The two grid times around the playhead's time, blended (decision D5).
        // The weight is taken to the half hour of sitch time, so update()
        // rebuilds the lines at most every half hour of sitch time.
        const {c0, c1, w} = gridTimesAround(this._frameTimeMs(playheadFrame()), this.gridCadenceHours(source));
        const wStep = Math.round(w * 12) / 12;
        const times = wStep > 0 ? [c0, c1] : [c0];

        const {lo, hi, t} = bracketingLevels(altFt);
        const needTwo = lo.level !== hi.level;

        // A message only while a level is really fetched: from the cache the
        // fill takes one frame, and the Status row keeps its provenance line.
        const cached = (time, level) => !!this._levelCache[levelKey(source, time.dateStr, time.hour, level)];
        if (times.some(time => !cached(time, lo.level) || !cached(time, hi.level))) {
            const levelName = (level) => level === "surface" ? "10 m" : `${level} hPa`;
            this.setStatusMessage(needTwo
                ? `Fetching ${levelName(lo.level)} + ${levelName(hi.level)}...`
                : `Fetching ${levelName(lo.level)}...`);
        }
        console.log(`Wind alt ${altFt} ft → ${lo.level}(${(1 - t).toFixed(2)}) + ${hi.level}(${t.toFixed(2)}),`
            + ` time weight ${wStep.toFixed(2)}`);

        // The level pair of each time. The earlier time is needed; the later
        // one can be missing (not published yet), and then the earlier is used
        // alone.
        const pairs = [];
        for (const time of times) {
            try {
                const jsonLo = await this._fetchLevel(lo.level, time.dateStr, time.hour, source);
                const jsonHi = needTwo ? await this._fetchLevel(hi.level, time.dateStr, time.hour, source) : jsonLo;
                pairs.push({time, jsonLo, jsonHi});
            } catch (err) {
                if (time === c0) throw err;
                console.warn(`Wind grid ${time.dateStr} ${time.hour}Z not available, using the earlier one alone:`,
                    err?.message ?? err);
            }
        }
        const first = pairs[0];
        // Grids of two times blend cell by cell only when they have one layout.
        const second = pairs[1] && pairs[1].jsonLo.u.length === first.jsonLo.u.length
            && pairs[1].jsonHi.u.length === first.jsonLo.u.length ? pairs[1] : null;
        const tw = second ? wStep : 0;

        const n = first.jsonLo.u.length;
        const blendedU = new Array(n);
        const blendedV = new Array(n);
        for (let i = 0; i < n; i++) {
            let u = (1 - t) * first.jsonLo.u[i] + t * first.jsonHi.u[i];
            let v = (1 - t) * first.jsonLo.v[i] + t * first.jsonHi.v[i];
            if (second) {
                u = (1 - tw) * u + tw * ((1 - t) * second.jsonLo.u[i] + t * second.jsonHi.u[i]);
                v = (1 - tw) * v + tw * ((1 - t) * second.jsonLo.v[i] + t * second.jsonHi.v[i]);
            }
            blendedU[i] = Math.round(u * 100) / 100;
            blendedV[i] = Math.round(v * 100) / 100;
        }

        const defaultSourceName = source === "custom" ? "Custom" : "GFS";
        const blended = {
            ...first.jsonLo,
            u: blendedU,
            v: blendedV,
            hgt: undefined,
            level: `${Math.round(altFt)}ft`,
            source: first.jsonLo.source ?? defaultSourceName,
            _loLevel: lo.level,
            _hiLevel: hi.level,
            _blendT: t,
            _timeWeight: tw,
        };

        this._applyWindJSON(blended);
        this.windLevel = lo.level === hi.level ? lo.level : `${lo.level}+${hi.level}`;
        this._displayTimeKey = `${source}|${c0.ms}|${wStep}`;
        this._storeWindFiles(first.jsonLo, first.jsonHi, needTwo, first.time.dateStr, first.time.hour);
        if (second) {
            this._storeWindFiles(second.jsonLo, second.jsonHi, needTwo, second.time.dateStr, second.time.hour, true);
        }

        // The Status row gives the cycles the data really is (refTime), not
        // only the date: a level can come from an earlier cycle when the
        // requested one is not published (sourceFacts).
        this._lastRefTime = first.jsonLo.refTime ?? null;
    }

    // Drop the grids of times far from the playhead's interval (from two
    // intervals before it to two after), so a long play through days of sitch
    // time does not keep every grid. windAt asks again for one it needs.
    _pruneGridTimes(c0Ms, cadenceH = this.gridCadenceHours()) {
        const stepMs = cadenceH * 3600000;
        const keep = (dateStr, hour) => {
            const ms = Date.UTC(+dateStr.slice(0, 4), +dateStr.slice(4, 6) - 1, +dateStr.slice(6, 8), +hour);
            return ms >= c0Ms - 2 * stepMs && ms <= c0Ms + 3 * stepMs;
        };
        let dropped = false;
        for (const key of Object.keys(this._levelCache)) {
            const match = /^[^:]+:(\d{8})_(\d{1,2})_/.exec(key);
            if (match && !keep(match[1], match[2])) {
                delete this._levelCache[key];
                dropped = true;
            }
        }
        for (const [fileId, meta] of [...this._loadedWindFiles]) {
            if (meta.dateStr && meta.hour != null && !keep(meta.dateStr, meta.hour)) {
                if (FileManager.list[fileId]) delete FileManager.list[fileId];
                this._loadedWindFiles.delete(fileId);
            }
        }
        if (dropped) this._sourceDataVersion++;
    }

    // ── Soundings (UWYO / IGRA2 / Manual): IDW from loaded profiles ─
    //
    // All three sounding sources share this path; they differ only in which
    // profiles are eligible. "manual-soundings" takes whatever the user has
    // loaded (any source); "uwyo" and "igra2" filter to matching profiles.
    async _fillFromSoundings(altFt, sourceKey) {
        const {profiles, label} = this._resolveSoundingProfiles(sourceKey);
        if (profiles.length === 0) {
            throw new Error(`No ${label} profiles loaded`);
        }
        const altM = altFt * 0.3048;

        // Bucket rejections so the error message can distinguish "profiles
        // loaded but missing station coords" from "profiles loaded but none
        // reached this altitude". These are different user problems.
        let droppedNoCoords = 0;
        let droppedNoWind = 0;
        const samples = [];
        // A station gives no line sample above the top of its wind data (the
        // point blend fades it out over the same 305 m, _blendSoundingProfiles).
        // Above every station's top, the highest station's top wind is held, as
        // in the blend. Until 2026-11-03 every station gave its top wind here.
        const SOUNDING_TOP_FADE_M = 305;
        let highest = null;
        for (const p of profiles) {
            if (p.stationLat == null || p.stationLon == null) continue;
            if (p.topWindAlt != null && (highest == null || p.topWindAlt > highest.topWindAlt)) highest = p;
        }
        const anyReaches = profiles.some(p => p.stationLat != null && p.stationLon != null
            && (p.topWindAlt == null || altM <= p.topWindAlt + SOUNDING_TOP_FADE_M));
        for (const p of profiles) {
            if (p.stationLat == null || p.stationLon == null) {
                droppedNoCoords++;
                continue;
            }
            if (p.topWindAlt != null && altM > p.topWindAlt + SOUNDING_TOP_FADE_M
                && (anyReaches || p !== highest)) {
                continue;
            }
            const data = p.getAtAltitude(altM);
            if (!data || data.windDir == null || data.windSpeed == null) {
                droppedNoWind++;
                continue;
            }
            samples.push({
                lat: p.stationLat,
                lon: p.stationLon,
                // Met-convention: u = east, v = north. windDir is FROM.
                ...fromDirSpeedToUV(data.windDir, data.windSpeed),
            });
        }
        if (samples.length === 0) {
            if (droppedNoCoords > 0 && droppedNoWind === 0) {
                throw new Error(`${label} profiles loaded (${droppedNoCoords}) but none have station coordinates`);
            }
            throw new Error(`${label} profiles have no wind at ${heightText(altFt * 0.3048, this.windHeightUnit())}`);
        }

        this._buildGridFromSamples(samples, label);
        this.windLevel = `${Math.round(altFt)}ft`;
    }

    // Map internal source key → {profiles, label}. Separated so sampleAtLLA
    // and _fillFromSoundings share the same filter semantics.
    _resolveSoundingProfiles(sourceKey) {
        // manual-soundings — any loaded profile, regardless of origin
        return this._soundingSet(sourceKey)
            ?? {profiles: this._gatherSondeProfiles(null), label: "Manual Soundings"};
    }

    // The profiles a source reads BY ALTITUDE, with a label for the status text,
    // or null for a source that is not read that way. The one test for "is this
    // a sounding source": the three built-in sounding sources, and the Track
    // entry of a sounding track, which uses that one profile alone.
    _soundingSet(sourceKey = this.source) {
        if (sourceKey === "uwyo") {
            return {profiles: this._gatherSondeProfiles("uwyo"), label: "UWYO"};
        }
        if (sourceKey === "igra2") {
            return {profiles: this._gatherSondeProfiles("igra2"), label: "IGRA2"};
        }
        if (sourceKey === "manual-soundings") {
            return {profiles: this._gatherSondeProfiles(null), label: "Manual Soundings"};
        }
        const profile = altitudeProfileForSourceKey(sourceKey);
        if (profile) {
            return {profiles: [profile], label: profile.id.replace(/^atmosphericProfile_/, "")};
        }
        return null;
    }

    // ── Open-Meteo: columns at target/local, tiled globally ─────────
    //
    // Loads the column at each wind node's track (one request each, all
    // heights and hours of the day; see _sampleOpenMeteo) and builds the
    // displayed grid from those columns at the display altitude.
    async _fillFromOpenMeteo(altFt) {
        this.setStatusMessage(`Fetching open-meteo at ${heightText(altFt * 0.3048, this.windHeightUnit())}...`);

        const points = this._windNodePositions();
        if (points.length === 0) {
            throw new Error("No target/local wind node with an origin track");
        }

        const altM = altFt * 0.3048;
        const samples = [];
        for (const pt of points) {
            await this.loadDataFor("openmeteo", pt.lat, pt.lon, altM);
            const w = this.windAt("openmeteo", pt.lat, pt.lon, altM);
            if (Number.isFinite(w.u) && Number.isFinite(w.v)) {
                samples.push({lat: pt.lat, lon: pt.lon, u: w.u, v: w.v});
            }
        }
        if (samples.length === 0) {
            throw new Error("open-meteo returned no usable samples");
        }

        this._buildGridFromSamples(samples, "OpenMeteo");
        this.windLevel = `${Math.round(altFt)}ft`;
    }

    // Drop the loaded Open-Meteo columns ("Refresh Wind Data").
    _clearOpenMeteoColumns() {
        this._omColumns.clear();
        for (const key of [...this._failedLevels.keys()]) {
            if (key.startsWith("om:")) this._failedLevels.delete(key);
        }
        this._sourceDataVersion++;
    }

    // ── Manual: targetWind direction/speed anchored to target track(s) ──
    // Like the sounding sources, Manual puts samples at the target/local
    // track positions so the field fades with distance via coverage —
    // a user-chosen wind is representative only near the object it applies
    // to, not globally. Falls back to a uniform global field only if no
    // target/local node exists.
    _fillFromManual(altFt) {
        const tw = NodeMan.get("targetWind", false);
        if (!tw) throw new Error("No targetWind node for Manual source");
        if (!Number.isFinite(tw.from) || !Number.isFinite(tw.knots)) {
            throw new Error("targetWind has no numeric from/knots for Manual source");
        }

        const {u, v} = fromDirSpeedKnotsToUV(tw.from, tw.knots);
        const points = this._windNodePositions();
        if (points.length === 0) {
            this._buildUniformGrid(u, v, "Manual");
        } else {
            const samples = points.map(pt => ({lat: pt.lat, lon: pt.lon, u, v}));
            this._buildGridFromSamples(samples, "Manual");
        }
        this.windLevel = `${Math.round(altFt)}ft`;
    }

    // Wind field from a single MISB track that carries WindDirection/
    // WindSpeed columns (e.g. an imported sonde track). The track has one
    // wind sample per row; we read the row that maps to the current
    // playback frame and build a uniform / IDW-anchored grid from that
    // single (dir, knots) value — i.e. the field shows "what this one
    // station is reporting right now."
    //
    // Picking a track source means "treat this as the single source of
    // truth," so the field is intentionally one-directional. Frame
    // changes refresh the field via update() since the track's wind
    // varies row-to-row (sonde ascent profile).
    _fillFromTrackSource(altFt) {
        const trackId = trackDataIdFromSourceKey(this.source);
        if (!trackId || !NodeMan.exists(trackId)) {
            throw new Error(`Track source not found: ${trackId}`);
        }
        const td = NodeMan.get(trackId);
        const misb = td?.misb;
        if (!Array.isArray(misb) || misb.length === 0) {
            throw new Error(`Track ${trackId} has no MISB data`);
        }
        const f = playheadFrame();
        const w = this._telemetryWindAt(trackId, td, f);
        if (!w) throw new Error(`Track ${trackId} missing wind data at frame ${f}`);
        const dir = w.from;
        const spd = w.knots;
        const {u, v} = fromDirSpeedKnotsToUV(dir, spd);
        const points = this._windNodePositions();
        if (points.length === 0) {
            this._buildUniformGrid(u, v, "Track");
        } else {
            const samples = points.map(pt => ({lat: pt.lat, lon: pt.lon, u, v}));
            this._buildGridFromSamples(samples, "Track");
        }
        this.windLevel = `${Math.round(altFt)}ft`;
        // Remember the (frame → wind) snapshot so update() can detect when
        // the track row's wind has changed enough to warrant a refresh.
        this._trackLastDir = dir;
        this._trackLastSpd = spd;
    }

    // Wind of a telemetry track at frame f, in knots: {from, knots}, or null.
    // Read through the wind node bound to the track (CNodeWind.trackWindAt),
    // which maps a frame to a row by TIME, so the field, the readouts and
    // Target/Local Wind use one row rule. A frame-fraction row (the old rule,
    // which ignores time stamps) is the fallback when no wind node is bound.
    _telemetryWindAt(trackId, td, f) {
        for (const id of ["targetWind", "localWind"]) {
            const node = NodeMan.get(id, false);
            if (node?.trackSource === trackId && typeof node.trackWindAt === "function") {
                const w = node.trackWindAt(f);
                if (w) return {from: w.from, knots: w.knots};
            }
        }
        const misb = td?.misb;
        if (!Array.isArray(misb) || misb.length === 0) return null;
        const denom = Math.max(1, (Sit.frames ?? 1) - 1);
        const slot = Math.max(0, Math.min(misb.length - 1, Math.round((f / denom) * (misb.length - 1))));
        const dir = misb[slot]?.[MISB.WindDirection];
        const spdMS = misb[slot]?.[MISB.WindSpeed];
        if (!Number.isFinite(dir) || !Number.isFinite(spdMS)) return null;
        // Tag 36 is metres per second (ST 0601); the field works in knots.
        return {from: dir, knots: knotsFromMISBWindSpeed(spdMS)};
    }

    // ── Find relevant wind nodes' positions (lat/lon/alt) ───────────
    // Each wind node is sampled at its track's *current-frame* position and
    // altitude. If a node has no originTrack, fall back to the conventional
    // track for its role (LOSTraverseSelect/targetTrack for target,
    // jetTrack/cameraTrack for local).
    _windNodePositions() {
        // Prefer targetTrack first: LOSTraverseSelect is a switch that in
        // some sitches depends on targetWind itself, which would make wind
        // sampling circular (values would oscillate, not diverge — but best
        // avoided).
        const fallbacks = {
            targetWind: ["targetTrack", "LOSTraverseSelect", "cameraTrack"],
            localWind:  ["jetTrack", "cameraTrack"],
        };
        const resolveTrack = (node, id) => {
            let t = node.originTrack;
            if (typeof t === "string" && NodeMan.exists(t)) t = NodeMan.get(t);
            if (t && typeof t.p === "function") return t;
            for (const name of (fallbacks[id] ?? [])) {
                if (NodeMan.exists(name)) {
                    const cand = NodeMan.get(name);
                    if (cand && typeof cand.p === "function") return cand;
                }
            }
            return null;
        };

        const out = [];
        for (const id of ["targetWind", "localWind"]) {
            if (!NodeMan.exists(id)) continue;
            const n = NodeMan.get(id);
            const track = resolveTrack(n, id);
            if (!track) continue;
            const f = playheadFrame();
            const pos = track.p(f);
            const lla = ECEFToLLAVD_radii(pos);
            out.push({id, lat: lla.x, lon: lla.y, altM: lla.z - meanSeaLevelOffset(lla.x, lla.y)});
        }
        return out;
    }

    // `sourceFilter`: "uwyo" | "igra2" | null (no filter — any source).
    _gatherSondeProfiles(sourceFilter = null) {
        // Memoize the profile-node LIST keyed by NodeMan's mutation version.
        // sampleWindAtAltitude() calls this once per query, and the balloon bake
        // queries wind once per frame over 100k+ frames — re-scanning the whole
        // node graph (NodeMan.iterate + a per-node constructor-name compare) each
        // time was the dominant bake cost (~5 s per 195k-frame bake). The set of
        // CNodeAtmosphericProfile nodes only changes when nodes are added/removed
        // (listVersion bumps), so between those events the cached list is exact.
        // Only the node REFERENCES are cached — callers still read getAtAltitude()
        // / topWindAlt live, so profile data that updates in place stays fresh.
        const version = NodeMan.listVersion ?? 0;
        const cache = this._sondeProfileCache;
        if (cache && cache.version === version && cache.sourceFilter === sourceFilter) {
            return cache.profiles;
        }
        const profiles = [];
        NodeMan.iterate((id, node) => {
            if (!node || node.constructor?.name !== "CNodeAtmosphericProfile") return;
            if (sourceFilter && node.source !== sourceFilter) return;
            profiles.push(node);
        });
        this._sondeProfileCache = {version, sourceFilter, profiles};
        return profiles;
    }

    // A cheap signature of the current sonde-profile SET for the active source:
    // profile count + summed valid-wind tops. Consumers that memoize on wind
    // state (e.g. CNodeBalloonTrack's bake) include this so they re-run when
    // soundings arrive — soundings load ASYNCHRONOUSLY as tracks after a sitch
    // reload, and their arrival does NOT bump source/_windDataVersion/
    // _lastDateCycle, so those coarse fields alone can't detect it. Empty for
    // non-sounding sources (GFS async arrival is covered by _windDataVersion).
    sondeProfileSignature(sourceKey = this.source) {
        const soundingSet = this._soundingSet(sourceKey);
        if (!soundingSet) return "";
        const profiles = soundingSet.profiles;
        let topSum = 0;
        for (const p of profiles) topSum += (p.topWindAlt ?? 0);
        return `${profiles.length}:${Math.round(topSum)}`;
    }

    // ── Build a coarse global grid from scattered (lat,lon,u,v) samples
    // via inverse-distance weighting over the K=3 nearest samples (haversine
    // distance). Using only the 3 closest samples per cell keeps the result
    // locally representative instead of smearing every distant sample across
    // the whole globe. Coverage = exp(-d_nearest / L) still drives shader
    // opacity falloff for regions far from any sample.
    // The displayed grid from scattered samples (soundings, Open-Meteo
    // columns, the Manual and Track values at the wind nodes): at each node,
    // the 1/d² blend of the K = 3 nearest samples, the same blend that the
    // readouts and Target/Local Wind read at a point (_blendSoundingProfiles),
    // and a coverage that fades with the distance to the nearest sample.
    //
    // 1° nodes, as GFS. Until 2026-11-03 they were 5° apart (about 550 km), and
    // the lines between nodes were an interpolation of the nodes, not the blend:
    // with three soundings that disagree (93°, 205° and 206° within 400 km), the
    // lines at the camera were 176° at 6 kt where the readout gave 190° at 8 kt.
    // At 1° the same point gives 189° at 7.8 kt. A finer grid adds no data; it
    // only removes that interpolation error.
    _buildGridFromSamples(samples, sourceLabel) {
        const nx = 360, ny = 181;           // 1° resolution
        const dlon = 1, dlat = -1;
        const lon0 = 0, lat0 = 90;
        const n = nx * ny;
        const u = new Float32Array(n);
        const v = new Float32Array(n);
        const cov = new Float32Array(n);

        const K = Math.min(3, samples.length);
        const L = this.coverageLengthDeg;  // decay length scale (degrees)
        const DEG_RAD = Math.PI / 180;
        // Per sample: latitude, its cosine and longitude, for the haversine
        // distance in the loop (greatCircleDistanceDeg, without its trig per call).
        const sLat = samples.map(s => s.lat * DEG_RAD);
        const sCos = sLat.map(Math.cos);
        const sLon = samples.map(s => s.lon * DEG_RAD);
        const nearD = new Float64Array(K);
        const nearK = new Int32Array(K);
        for (let j = 0; j < ny; j++) {
            const latR = (lat0 + j * dlat) * DEG_RAD;
            const cosLat = Math.cos(latR);
            for (let i = 0; i < nx; i++) {
                const lonR = (lon0 + i * dlon) * DEG_RAD;
                // The K nearest samples, kept in order of distance.
                let found = 0;
                for (let k = 0; k < samples.length; k++) {
                    const a = Math.sin((sLat[k] - latR) / 2);
                    const b = Math.sin((sLon[k] - lonR) / 2);
                    const d = 2 * Math.asin(Math.min(1, Math.sqrt(a * a + cosLat * sCos[k] * b * b))) / DEG_RAD;
                    if (found < K) found++;
                    else if (d >= nearD[K - 1]) continue;
                    let m = found - 1;
                    while (m > 0 && nearD[m - 1] > d) {
                        nearD[m] = nearD[m - 1];
                        nearK[m] = nearK[m - 1];
                        m--;
                    }
                    nearD[m] = d;
                    nearK[m] = k;
                }
                let wsum = 0, usum = 0, vsum = 0;
                for (let m = 0; m < K; m++) {
                    // Clamp very-small distance so exact hits don't divide by 0.
                    const dd = Math.max(nearD[m], 0.01);
                    const w = 1 / (dd * dd);
                    const s = samples[nearK[m]];
                    wsum += w; usum += w * s.u; vsum += w * s.v;
                }
                const idx = j * nx + i;
                u[idx] = wsum > 0 ? usum / wsum : 0;
                v[idx] = wsum > 0 ? vsum / wsum : 0;
                // Exponential falloff — smooth, no hard edges. 1.0 at the
                // sample, ≈0.37 at L degrees away, ≈0.14 at 2L.
                cov[idx] = K > 0 ? Math.exp(-nearD[0] / L) : 0;
            }
        }

        this._applyWindJSON({
            nx, ny, lon0, lat0, dlon, dlat,
            u, v, cov,
            source: sourceLabel,
            level: `${Math.round(this.windAltFt)}ft`,
        });
        // Non-GFS sources don't persist to FileManager; recompute on load
        this._windFileIds = [];
    }

    _buildUniformGrid(u, v, sourceLabel) {
        const nx = 72, ny = 37;
        const dlon = 5, dlat = -5;
        const lon0 = 0, lat0 = 90;
        const n = nx * ny;
        const uArr = new Array(n).fill(Math.round(u * 100) / 100);
        const vArr = new Array(n).fill(Math.round(v * 100) / 100);

        this._applyWindJSON({
            nx, ny, lon0, lat0, dlon, dlat,
            u: uArr, v: vArr,
            source: sourceLabel,
            level: `${Math.round(this.windAltFt)}ft`,
        });
        this._windFileIds = [];
    }

    // ── Load what windAt needs at a point, then sample ──────────────
    //
    // windAt() never waits. These wait for the data at one point (the GFS
    // levels around the height, or the Open-Meteo column), for a load that
    // should show a loaded value at once, not "pending".
    async loadDataFor(sourceKey, lat, lon, altM) {
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(altM)) return;
        if (sourceKey === "gfs" || sourceKey === "custom") {
            // The levels around the height, for each grid time that the
            // playhead's time blends (decision D5).
            const groundM = this._groundMSL(lat, lon);
            await Promise.all(this._gridTimesFor(playheadFrame(), sourceKey).flatMap(({dateStr, hour}) => {
                const heights = this._columnHeights(sourceKey, dateStr, hour, lat, lon);
                const {lo, hi} = gridColumnBracket(altM, groundM, heights);
                const levels = lo.level === hi.level ? [lo.level] : [lo.level, hi.level];
                return levels.map(level => this._fetchLevel(level, dateStr, hour, sourceKey).catch(err => {
                    this._failedLevels.set(levelKey(sourceKey, dateStr, hour, level), Date.now());
                    console.warn(`Wind level ${level} (${sourceKey}) failed:`, err?.message ?? err);
                }));
            }));
        } else if (sourceKey === "openmeteo") {
            const dateStr = (GlobalDateTimeNode?.dateNow ?? new Date()).toISOString().slice(0, 10);
            const near = this._nearestOpenMeteoColumn(lat, lon, dateStr);
            if (!near || near.distanceDeg > OPEN_METEO_COLUMN_RADIUS_DEG) {
                await this._requestOpenMeteoColumn(lat, lon, dateStr);
            }
        }
    }

    // {u, v} in m/s at (lat, lon, altM) from a source, after loading what it
    // needs there; null when there is no wind there.
    async sampleAtLLA(lat, lon, altM, sourceKey = this.source) {
        await this.loadDataFor(sourceKey, lat, lon, altM);
        const w = this.windAt(sourceKey, lat, lon, altM);
        return Number.isFinite(w.u) && Number.isFinite(w.v) ? w : null;
    }

    _sampleSoundingsAtLLA(lat, lon, altM, sourceKey) {
        return this._blendSoundingProfiles(this._resolveSoundingProfiles(sourceKey).profiles, lat, lon, altM);
    }

    // The one sounding blend, used by the readouts, the lines, the balloon and
    // Target/Local Wind alike (two copies disagreed before 2026-11-02: one
    // dropped a station above its top, the other held its top wind, which gave
    // a 32 kt step in 100 ft between the readout and Target Wind).
    //
    // 1/d² inverse-distance weighting of the three nearest stations, by great-
    // circle distance. A station only reports wind up to its top valid-wind
    // level (radiosondes reach very different tops), so above that it fades out
    // over SOUNDING_TOP_FADE_M instead of dropping out at once, and the blend
    // degrades from all nearby stations to whichever still reach that high.
    // Above EVERY station's top, the highest-reaching station's top wind is
    // held (best available guess) rather than reverting to no wind.
    // Returns {u, v, status} in m/s, or null. Status "held-above" above every
    // station's top, "held-below" when every station used is below its lowest
    // wind, else "ok".
    _blendSoundingProfiles(profiles, lat, lon, altM) {
        const SOUNDING_TOP_FADE_M = 305;   // about 1,000 ft
        // windAtAltitude reads the wind levels only (binary search); a profile
        // without it (a test double) gives its getAtAltitude.
        const windOf = (p, alt) => typeof p.windAtAltitude === "function"
            ? p.windAtAltitude(alt) : p.getAtAltitude(alt);
        const items = [];
        let allBelowBottom = true;
        let highestTop = null;
        for (const p of profiles) {
            if (p.stationLat == null || p.stationLon == null) continue;
            if (p.topWindAlt != null
                && (highestTop == null || p.topWindAlt > highestTop.topWindAlt)) {
                highestTop = p;
            }
            let fade = 1;
            if (p.topWindAlt != null && altM > p.topWindAlt) {
                fade = 1 - (altM - p.topWindAlt) / SOUNDING_TOP_FADE_M;
                if (fade <= 0) continue;   // no measured wind this high
            }
            const data = windOf(p, altM);
            if (!data || data.windDir == null || data.windSpeed == null) continue;
            const {u, v} = fromDirSpeedToUV(data.windDir, data.windSpeed);
            const d = greatCircleDistanceDeg(lat, lon, p.stationLat, p.stationLon);
            items.push({d, fade, u, v, profile: p});
        }
        if (items.length === 0) {
            if (!highestTop) return null;
            const top = windOf(highestTop, highestTop.topWindAlt);
            if (!top || top.windDir == null || top.windSpeed == null) return null;
            return {...fromDirSpeedToUV(top.windDir, top.windSpeed), status: "held-above",
                limitM: highestTop.topWindAlt};
        }
        items.sort((a, b) => a.d - b.d);
        const K = Math.min(3, items.length);
        let wsum = 0, usum = 0, vsum = 0;
        let lowestBottom = null;
        for (let k = 0; k < K; k++) {
            const {d, fade, u, v, profile} = items[k];
            // 0.01° (about 1 km) floor: a point on a station uses that station.
            const w = fade / Math.max(d, 0.01) ** 2;
            wsum += w; usum += w * u; vsum += w * v;
            const bottom = typeof profile.bottomWindAlt === "function" ? profile.bottomWindAlt() : null;
            if (bottom == null || altM >= bottom) allBelowBottom = false;
            else if (lowestBottom == null || bottom < lowestBottom) lowestBottom = bottom;
        }
        if (wsum === 0) return null;
        return allBelowBottom
            ? {u: usum / wsum, v: vsum / wsum, status: "held-below", limitM: lowestBottom}
            : {u: usum / wsum, v: vsum / wsum, status: "ok"};
    }

    // ── Get Target and Local Wind ready after a load ─────────────────
    //
    // Target and Local Wind read the wind live, at their users' positions on
    // every frame (CNodeWind.windStateAt), so nothing is copied into them
    // here. Before 2026-11-03 this wrote one reading, taken at the load, into
    // their From and Knots, and that stayed until the next load. This only
    // loads the data at each node's track now, so the first value shown after
    // a load is a loaded one, not "pending". New data changes
    // _sourceDataVersion, and the nodes then recalculate their users.
    async propagateToWindNodes() {
        if (this._propagating) return;
        this._propagating = true;
        try {
            for (const pt of this._windNodePositions()) {
                const key = this.sourceKeyFor(pt.id === "localWind" ? "local" : "target");
                if (key === "manual") continue;
                await this.loadDataFor(key, pt.lat, pt.lon, pt.altM);
            }
        } finally {
            this._propagating = false;
        }
    }

    // ── apply wind JSON and store for serialization ────────────────
    _applyWindJSON(json) {
        this.setGridParams(json.nx, json.ny, json.lon0, json.lat0, json.dlon, json.dlat);
        this.windU = new Float32Array(json.u);
        this.windV = new Float32Array(json.v);
        // Optional coverage array (set by _buildGridFromSamples). Missing
        // coverage means "trust everywhere" — sampleCoverage() returns 1.0.
        this.windCov = json.cov ? new Float32Array(json.cov) : null;
        this.dataSource = json.source ?? "GFS";
        this._lastWindJSON = json;   // keep for serialization
        // Bump data version so the screen-grid arrow cache invalidates and
        // re-samples the new field on the next preRender.
        this._windDataVersion = (this._windDataVersion ?? 0) + 1;
    }

    // Store source wind level files in FileManager for serialization.
    // ACCUMULATES — every level we've fetched for the current cycle stays in
    // FileManager and in this._loadedWindFiles so a later altitude change
    // that needs a different bracket can reuse it without re-fetching.
    // The current blend's IDs are tracked separately in this._windFileIds for
    // backward compat with code that reads "what did we just load".
    // append: add to the files of this fill (the second grid time), not replace.
    _storeWindFiles(jsonLo, jsonHi, needTwo, dateStr, hour, append = false) {
        const src = (jsonLo.source ?? "GFS").replace(/[^a-zA-Z0-9]/g, "");
        if (!append || !this._windFileIds) this._windFileIds = [];

        const store = (json, suffix) => {
            // One file per grid time and level: the data's own cycle (refTime)
            // is in the id. Until 2026-11-03 the id had the level only, which
            // was right while only one cycle was loaded at a time.
            const fileCycle = (json.refTime ?? "").replace(/[-T:Z]/g, "").slice(0, 10) || `${dateStr}${hour}`;
            const fileId = `windGrid_${src}_${fileCycle}_${suffix}`;
            // Already stored from an earlier bracket fetch this session — reuse.
            if (FileManager.list[fileId] && this._loadedWindFiles.has(fileId)) {
                this._windFileIds.push(fileId);
                return;
            }
            const compressed = pako.deflate(JSON.stringify(json));
            if (FileManager.list[fileId]) delete FileManager.list[fileId];
            FileManager.add(fileId, json, compressed.buffer);
            const entry = FileManager.list[fileId];
            entry.dynamicLink = true;
            entry.dataType = "windGrid";
            entry.filename = `wind-${src}-${suffix}.json.deflate`;
            entry.compressed = true;
            // Skip URL-based serialization: the staticURL we'd write here is
            // synthetic (data/wind/...) and only happens to exist when
            // windProxy.php cached the response server-side at exactly that
            // path. On reload we re-fetch via _fetchLevel using the
            // loadedWindFiles catalog (modSerialize/Deserialize) and
            // windProxy's cache, which is cheaper and reliable.
            entry.skipSerialization = true;
            const refDate = (json.refTime ?? "").replace(/[-T:Z]/g, "").slice(0, 8);
            const refHour = (json.refTime ?? "").slice(11, 13);
            const levelStr = json.level ?? "10m";
            entry.staticURL = `data/wind/wind_${refDate || dateStr}_${refHour || hour}z_${levelStr}.json`;
            entry.localStaticURL = entry.staticURL;
            this._windFileIds.push(fileId);
            this._loadedWindFiles.set(fileId, normalizeWindFileMeta({
                level: json.level ?? suffix,
                dateStr: refDate || dateStr,
                hour: refHour || String(hour),
                source: src,
                sourceKey: this._isGridSource() ? this.source : undefined,
            }));
        };

        store(jsonLo, jsonLo.level ?? "lo");
        if (needTwo) store(jsonHi, jsonHi.level ?? "hi");
    }

    // Drop all cached GFS grids — call when the active cycle changes so we
    // don't accumulate stale data across days. Also called from the
    // "Refresh Wind Data" button, where the user wants the next fetch to
    // round-trip the network even if the cycle is unchanged.
    _evictAllWindGrids() {
        for (const fid of this._loadedWindFiles.keys()) {
            if (FileManager.list[fid]) delete FileManager.list[fid];
        }
        this._loadedWindFiles.clear();
        this._levelCache = {};
        this._windFileIds = [];
        // windAt asks again for what it needs; a failed level may load now.
        this._levelQueue = [];
        for (const key of [...this._failedLevels.keys()]) {
            if (!key.startsWith("om:")) this._failedLevels.delete(key);
        }
        this._sourceDataVersion++;
        // The next fill sets the displayed time again.
        this._displayTimeKey = null;
    }

    // Legacy single-file store (used by _storeWindFile calls in modDeserialize)
    _storeWindFile() {
        if (!this._lastWindJSON) return;
        this._storeWindFiles(this._lastWindJSON, this._lastWindJSON, false, "", "");
    }

    // Decompress and parse wind data from a FileManager entry
    static _parseWindEntry(entry) {
        // Already parsed JSON object
        if (entry.data && entry.data.u && entry.data.v) return entry.data;
        // Compressed ArrayBuffer
        if (entry.original) {
            try {
                const decompressed = pako.inflate(new Uint8Array(entry.original), {to: "string"});
                return JSON.parse(decompressed);
            } catch (e) {
                // Not compressed — try as plain JSON text
                const text = new TextDecoder().decode(entry.original);
                return JSON.parse(text);
            }
        }
        return null;
    }

    modSerialize() {
        // Only grid sources (GFS / custom) write files we can rehydrate from.
        // Other sources are recomputed on load (see modDeserialize), so skip
        // the _storeWindFile path for them — it would tag the file with the
        // wrong source and confuse a later grid-source activation.
        const isGrid = this._isGridSource();
        if (isGrid
            && this._lastWindJSON
            && (!this._windFileIds || this._windFileIds.length === 0)) {
            this._storeWindFile();
        }

        // Serialize the full catalog (level/date/hour per file id) so reload
        // restores every level we'd fetched, not just the active blend. This
        // lets altitude scrubbing skip the network entirely.
        const loadedWindFiles = isGrid
            ? Array.from(this._loadedWindFiles.entries()).map(([fileId, meta]) => ({fileId, ...meta}))
            : [];

        return {
            ...super.modSerialize(),
            source: this.source,
            sourceLocal: this.sourceLocal,
            sourceSeparate: this.sourceSeparate,
            windAltFt: this.windAltFt,
            windLevel: this.windLevel,
            windFileIds: isGrid ? (this._windFileIds ?? []) : [],
            loadedWindFiles,
            hasWindData: isGrid && !!this._lastWindJSON,
            // GUI / behaviour state — single source of truth for save/load.
            // These used to live in par.* and were synced post-deserialize;
            // they're now persisted by the node directly.
            nearbyOnly: this.nearbyOnly,
            nearbyRadiusKm: this.nearbyRadiusKm,
            showArrows: this.showArrows,
            inspect: this.inspect,
            showAtEverOn: this.showAtEverOn || this.inspect,
            windInKnots: this.windInKnots,
            // Show Wind at switches. Object ids are kept only for objects
            // that still exist, so a deleted object does not stay in saves.
            inspectCamera: this.inspectCamera,
            inspectTarget: this.inspectTarget,
            inspectCursor: this.inspectCursor,
            inspectObjectIds: Object.keys(this.inspectObjects)
                .filter(id => this.inspectObjects[id] && NodeMan.exists(id)),
            visible: this.visible,
            linesVisible: this.linesVisible,
            lineOpacity: this.lineOpacity,
            seedSpacing: this.seedSpacing,
            maxWindSpeed: this.maxWindSpeed,
            lockAltitudeTo: this.lockAltitudeTo,
            // Inspect-mode dropped points (cursor/camera/target are
            // recomputed each frame, not persisted).
            inspectPoints: this.inspectPoints.map(p => ({lat: p.lat, lon: p.lon})),
        };
    }

    async modDeserialize(v) {
        super.modDeserialize(v);

        this.source = v.source ?? "gfs";
        this.sourceLocal = v.sourceLocal ?? "manual";
        this.sourceSeparate = !!v.sourceSeparate;
        this.windAltFt = v.windAltFt ?? 33;
        this.nearbyOnly = v.nearbyOnly ?? true;
        this.nearbyRadiusKm = v.nearbyRadiusKm ?? 250;
        this.showArrows = v.showArrows ?? false;
        // Show Wind at switches, set BEFORE setInspect so it installs the
        // cursor listeners only when Mouse Cursor is on. A save from before
        // the Show Wind at folder has only `inspect`, the old Inspect Wind
        // toggle, which showed the cursor, camera and target together: keep
        // all three on for such a save that had it on.
        if (typeof v.inspectCamera === "boolean") {
            this.inspectCamera = v.inspectCamera;
            this.inspectTarget = v.inspectTarget !== false;
            this.inspectCursor = !!v.inspectCursor;
        } else if (v.inspect === true) {
            this.inspectCamera = true;
            this.inspectTarget = true;
            this.inspectCursor = true;
        }
        if (Array.isArray(v.inspectObjectIds)) {
            this.inspectObjects = {};
            for (const id of v.inspectObjectIds) {
                if (typeof id === "string") this.inspectObjects[id] = true;
            }
        }
        // Route inspect through setInspect so the document mousemove/down/up
        // listeners + readout divs come back online. A bare `this.inspect = v`
        // leaves the checkbox showing checked but the cursor produces no
        // readout and shift-click does nothing until the user toggles it.
        if (typeof v.inspect === "boolean") this.setInspect(v.inspect);
        // A save from before 2026-11-03 has no showAtEverOn: Show Wind at was
        // on if it is on now.
        this.showAtEverOn = !!v.showAtEverOn || this.inspect;
        if (typeof v.windInKnots === "boolean") this.windInKnots = v.windInKnots;
        if (typeof v.visible === "boolean") this.visible = v.visible;
        // Pre-split saves only stored `visible`, which back then drove the
        // streamline mesh (par.windShow toggled both wn.visible AND
        // wn.group.visible). Migrate it to linesVisible so saved sitches
        // come back with the streamlines they had, and force the master
        // visible so the group can render.
        if (typeof v.linesVisible === "boolean") {
            this.linesVisible = v.linesVisible;
        } else if (typeof v.visible === "boolean") {
            this.linesVisible = v.visible;
            this.visible = true;
            this.group.visible = true;
        }
        if (this.linesMesh) this.linesMesh.visible = this.linesVisible;
        if (typeof v.lineOpacity === "number") {
            this.lineOpacity = v.lineOpacity;
            // Field assignment doesn't reach the shader — the GUI's onChange
            // does that, but .listen() polling is display-only and skips
            // onChange. Push the new value into the uniform directly so the
            // streamlines render with the saved opacity, not the constructor
            // default 0.9.
            if (this.material?.uniforms?.uOpacity) this.material.uniforms.uOpacity.value = this.lineOpacity;
        }
        if (typeof v.seedSpacing === "number") this.seedSpacing = v.seedSpacing;
        if (typeof v.maxWindSpeed === "number") {
            this.maxWindSpeed = v.maxWindSpeed;
            if (this.material?.uniforms?.uMaxSpeed) this.material.uniforms.uMaxSpeed.value = this.maxWindSpeed;
        }
        // (lastDateCycle, in a save from before 2026-11-03, is not used: the
        // displayed grid time comes from the playhead.)
        if (Array.isArray(v.inspectPoints)) {
            this.inspectPoints = v.inspectPoints
                .filter(p => p && Number.isFinite(p.lat) && Number.isFinite(p.lon))
                .map(p => ({lat: p.lat, lon: p.lon}));
        }
        if (typeof v.lockAltitudeTo === "string") {
            this.lockAltitudeTo = v.lockAltitudeTo;
        }

        // Rebuild the catalog of saved wind files. Keep entries even when
        // FileManager doesn't currently have the blob (the new normal —
        // wind grids set skipSerialization so they're not URL-saved). The
        // metadata still drives the post-deserialize re-fetch, and once
        // _fetchLevel pulls each level back, _storeWindFiles re-populates
        // FileManager under the same deterministic fileIds.
        if (Array.isArray(v.loadedWindFiles)) {
            this._loadedWindFiles = new Map(
                v.loadedWindFiles
                    .filter(e => e?.fileId)
                    .map(e => [e.fileId, normalizeWindFileMeta({
                        level: e.level, dateStr: e.dateStr,
                        hour: e.hour, source: e.source, sourceKey: e.sourceKey,
                    })])
            );
        }

        // Non-grid sources don't persist file blobs — they're recomputed on
        // demand. If the saved sitch had the wind field visible, re-fetch
        // after the rest of the sitch finishes deserializing (dependent
        // nodes like CNodeAtmosphericProfile / targetTrack may not exist
        // yet at this point in the restore pass).
        //
        // CustomManagerSerialize.finishDeserialization triggers the actual
        // fetch via this flag. A naive setTimeout(0) here would race against
        // `await waitForPendingActions()` calls inside the deserialize loop
        // (rAF runs in the same task tier as setTimeout(0)) and read stale
        // values from later-deserialized nodes such as targetWind — e.g.
        // _fillFromManual would see targetWind's constructor default 0 kn
        // and produce an empty streamline mesh.
        if (!this._isGridSource()) {
            this.windLevel = v.windLevel ?? `${Math.round(this.windAltFt)}ft`;
            if (this.visible) {
                this.setStatusMessage("Reloading...");
                this._needsPostDeserializeFetch = true;
            } else {
                this.setStatusMessage("Not loaded");
            }
            return;
        }

        const fileIds = v.windFileIds ?? [];
        // Backward compat: old single-file format
        if (fileIds.length === 0 && v.windFileId && FileManager.list[v.windFileId]) {
            fileIds.push(v.windFileId);
        }
        const jsons = [];
        for (const fid of fileIds) {
            if (!FileManager.list[fid]) continue;
            const json = CNodeDisplayWindField._parseWindEntry(FileManager.list[fid]);
            if (json && json.u && json.v) jsons.push(json);
        }

        // Wind grids are no longer URL-serialized (skipSerialization is set
        // in _storeWindFiles), so a saved-and-reloaded sitch arrives here
        // with no FileManager entries. Re-fetch each saved level via
        // windProxy on next tick so the wind reappears at the saved altitude
        // AND the per-level cache is rewarmed for instant altitude scrubbing.
        if (jsons.length === 0) {
            if (v.hasWindData && this.visible) {
                const savedLevels = Array.isArray(v.loadedWindFiles)
                    ? v.loadedWindFiles.map(normalizeWindFileMeta) : [];
                this.setStatusMessage(savedLevels.length > 0
                    ? `Reloading 0/${savedLevels.length} wind levels…`
                    : "Reloading wind…");
                // Deferred to finishDeserialization for the same reason as
                // the non-GFS branch above — see comment there.
                this._needsPostDeserializeReloadGFS = savedLevels;
            }
            return;
        }

        // Since 2026-11-03 a fill can store the files of two grid times; this
        // quick restore uses the files of one time (the next fill blends both).
        if (jsons.length > 2) {
            const oneTime = jsons.filter(j => j.refTime === jsons[0].refTime).slice(0, 2);
            jsons.length = 0;
            jsons.push(...oneTime);
        }
        // Sort the two-file blend by ascending altitude so
        // jsons[0] = lo, jsons[1] = hi — matches bracketingLevels().
        if (jsons.length > 1) {
            jsons.sort((a, b) => levelToAltFeet(a.level) - levelToAltFeet(b.level));
        }

        if (jsons.length === 1) {
            this._applyWindJSON(jsons[0]);
        } else {
            const {t} = bracketingLevels(this.windAltFt);
            const n = jsons[0].u.length;
            const bU = new Array(n), bV = new Array(n);
            for (let i = 0; i < n; i++) {
                bU[i] = Math.round(((1 - t) * jsons[0].u[i] + t * jsons[1].u[i]) * 100) / 100;
                bV[i] = Math.round(((1 - t) * jsons[0].v[i] + t * jsons[1].v[i]) * 100) / 100;
            }
            this._applyWindJSON({...jsons[0], u: bU, v: bV, level: `${Math.round(this.windAltFt)}ft`});
        }

        this.windLevel = v.windLevel ?? "surface";
        this.renderAltitude = Math.max(10, this.windAltFt * 0.3048);
        this._windFileIds = fileIds;

        this.rebuildStreamlines();
        setRenderOne(true);

        this._lastRefTime = jsons[0].refTime ?? null;
        this._showProvenance();
        console.log("Wind data restored from saved files");
    }

    // Pre-warm every level the saved sitch had loaded, then render the
    // saved altitude from cache. Reports progress and a final summary that
    // distinguishes "all loaded", "partial — closest is X", and pure failure.
    async _reloadGFSAfterDeserialize(savedLevels) {
        this._reloadInFlight = true;
        try {
            await this._reloadGFSAfterDeserializeInner(savedLevels);
        } finally {
            this._reloadInFlight = false;
        }
    }

    async _reloadGFSAfterDeserializeInner(savedLevels) {
        const {dateStr: fallbackDate, hour: fallbackHour} = gfsCycleFor(GlobalDateTimeNode?.dateNow);

        const total = savedLevels.length;
        let loaded = 0;
        const failures = [];

        // Bounded-parallel re-fetch. Hides individual round-trip latency
        // without stampeding windProxy.php — every cold-cache miss forks a
        // fetch_wind.py subprocess, and 8+ simultaneous misses can pin a
        // small server or trigger NOMADS rate limits. Three is enough to
        // keep one or two requests in-flight while another is finishing.
        const MAX_CONCURRENT = 3;
        const fetchOne = async (e) => {
            const dateStr = e.dateStr || fallbackDate;
            const hour = parseInt(e.hour ?? fallbackHour, 10);
            try {
                await this._fetchLevel(e.level, dateStr, hour, e.sourceKey ?? this.source);
                loaded++;
                if (total > 0) {
                    this.setStatusMessage(`Reloading ${loaded}/${total} wind levels…`);
                }
            } catch (err) {
                failures.push(e.level);
                console.warn(`Wind level ${e.level} reload failed:`, err.message);
            }
        };
        for (let i = 0; i < total; i += MAX_CONCURRENT) {
            await Promise.all(savedLevels.slice(i, i + MAX_CONCURRENT).map(fetchOne));
        }

        // Render at the saved altitude (uses the now-warm cache; should be
        // a single bracketing-blend tick with no network).
        try {
            await this.fetchWindForAltitude(this.windAltFt);
        } catch (err) {
            console.warn("Wind altitude render failed:", err.message);
        }

        // Final status: tailored to outcome. All loaded: the provenance line
        // (fetchWindForAltitude has shown it).
        const cycle = this._lastRefTime ? `${cycleLabel(this._lastRefTime)} ` : "";
        if (total === 0 || failures.length === 0) {
            // The provenance line that fetchWindForAltitude showed.
        } else if (failures.length < total) {
            // Pick the loaded level whose altitude is closest to the
            // current display altitude.
            const successLevels = savedLevels
                .filter(e => !failures.includes(e.level))
                .map(e => e.level);
            let closest = successLevels[0];
            let minDiff = Math.abs(levelToAltFeet(closest) - this.windAltFt);
            for (const lvl of successLevels) {
                const diff = Math.abs(levelToAltFeet(lvl) - this.windAltFt);
                if (diff < minDiff) { minDiff = diff; closest = lvl; }
            }
            this.setStatusMessage(`GFS ${cycle}— ${total - failures.length}/${total} levels`
                + ` (closest: ${closest === "surface" ? "10 m" : closest + " hPa"})`);
        } else {
            this.setStatusMessage(`GFS reload failed (${failures.length}/${total} levels)`);
        }
    }

    // ── per-frame update ─────────────────────────────────────────────
    update(frame) {
        super.update(frame);
        // Streamline dash animation. Normally uTime free-runs off a per-render
        // counter so the dashes keep flowing even when the timeline is paused.
        // But in fixed-frame / regression screenshot mode the render loop is
        // on-demand and the playhead is pinned, so a free-running counter makes
        // the dash phase differ between otherwise-identical renders — i.e.
        // non-deterministic screenshots. Pin uTime to the locked frame in that
        // mode so a given frame is exactly reproducible; live playback (where
        // fixedFrame is undefined) is unaffected.
        if (Globals.fixedFrame !== undefined) {
            this.material.uniforms.uTime.value = Globals.fixedFrame;
        } else {
            this.frameCount++;
            this.material.uniforms.uTime.value = this.frameCount;
        }

        // The displayed lines of a grid source follow the sitch time (decision
        // D5): rebuilt when the playhead moves to another half hour of a grid
        // interval, or to another interval. Grids far from that time are
        // dropped. Until 2026-11-03 a change of cycle dropped every grid and
        // loaded the new cycle alone.
        if (this._displayTimeKey && !this.fetching && this._isGridSource()) {
            const cadenceH = this.gridCadenceHours();
            const {c0, w} = gridTimesAround(this._frameTimeMs(frame), cadenceH);
            const key = `${this.source}|${c0.ms}|${Math.round(w * 12) / 12}`;
            if (key !== this._displayTimeKey) {
                this._displayTimeKey = key;
                this._pruneGridTimes(c0.ms, cadenceH);
                this.fetchWindForAltitude(this.windAltFt);
            }
        }

        // Keep the Status provenance line current: the distance to the data
        // changes as the target moves, and data arrives. Twice a second at most.
        if (this._statusIsProvenance && !this.fetching) {
            const now = performance.now();
            if (now - (this._provenanceAt ?? 0) > 500) {
                this._provenanceAt = now;
                const text = this.provenanceText();
                if (text !== this.statusText) this.statusText = text;
            }
        }

        // Time-scrub bbox staleness: when the reference comes from a
        // moving cameraTrack (jet/track sitches), scrubbing the timeline
        // drifts the lookat lat/lon. The streamline mesh was built around
        // the reference at last rebuildStreamlines(); once the camera
        // moves past half the radius, the bbox no longer covers what the
        // user is looking at, so the user sees empty space where streamlines
        // should be. Re-anchor the build when drift exceeds half the
        // current radius — once per crossing, not per frame.
        if (this.nearbyOnly && this.windU && !this.fetching && this._lastRebuildRef) {
            const ref = this._referenceLatLon();
            if (ref) {
                const driftKm = greatCircleDistanceDeg(
                    this._lastRebuildRef.lat, this._lastRebuildRef.lon,
                    ref.lat, ref.lon) * 111;
                if (driftKm > this.nearbyRadiusKm * 0.5) {
                    this.rebuildStreamlines();
                }
            }
        }

        // Track-driven source: if the underlying MISB row's wind has
        // changed enough vs the last fetch, refresh. Sonde tracks vary
        // wind row-by-row as the balloon climbs; without this hook the
        // field would freeze at whatever was current when the user
        // first picked the source. Threshold avoids a rebuild every
        // frame for track jitter — same intent as the altitude-lock
        // 50 ft snap below.
        // (Not for a sounding track: that is read by altitude, see _soundingSet.)
        if (isTrackSourceKey(this.source) && !altitudeProfileForSourceKey(this.source)
            && this.windU && !this.fetching) {
            const trackId = trackDataIdFromSourceKey(this.source);
            if (trackId && NodeMan.exists(trackId)) {
                const w = this._telemetryWindAt(trackId, NodeMan.get(trackId), frame);
                if (w) {
                    // Knots, matching what _fillFromTrackSource stored.
                    const dDir = Math.abs((w.from - (this._trackLastDir ?? w.from) + 540) % 360 - 180);
                    const dSpd = Math.abs(w.knots - (this._trackLastSpd ?? w.knots));
                    if (dDir > 2 || dSpd > 1) {
                        this.fetchWindForAltitude(this.windAltFt);
                    }
                }
            }
        }

        // Altitude-lock: drive windAltFt from the camera or target track
        // altitude. Snap to the slider's 50 ft step so smooth altitude
        // changes don't fire fetchWindForAltitude every frame — only when
        // the snapped value crosses a step boundary.
        if (this.lockAltitudeTo === "camera" || this.lockAltitudeTo === "target") {
            const track = this._trackForAnchor(this.lockAltitudeTo);
            if (track) {
                const pos = track.p(frame);
                if (pos) {
                    const lla = ECEFToLLAVD_radii(pos);
                    if (Number.isFinite(lla.x) && Number.isFinite(lla.y)
                        && Number.isFinite(lla.z)) {
                        const altM = lla.z - meanSeaLevelOffset(lla.x, lla.y);
                        const altFt = Math.max(0, Math.min(60000,
                            Math.round(altM * 3.28084 / 50) * 50));
                        if (altFt !== this.windAltFt) {
                            this.windAltFt = altFt;
                            // GUI slider .listen()s this.windAltFt directly,
                            // so no par sync needed.
                            this.fetchWindForAltitude(altFt);
                        }
                    }
                }
            }
        }
    }

    dispose() {
        if (this.linesMesh) {
            this.linesMesh.geometry.dispose();
        }
        if (this._sondeArrows) {
            for (const name of this._sondeArrows.keys()) removeDebugArrow(name);
            this._sondeArrows.clear();
        }
        if (this._screenArrowNames) {
            for (const name of this._screenArrowNames) removeDebugArrow(name);
            this._screenArrowNames.clear();
        }
        // Inspect-mode tear-down: drop every per-point arrow + readout div
        // and remove the global listeners so nothing leaks across sitch
        // reloads. setInspect(false) does the listener/arrow part already,
        // but we also have to destroy the divs (setInspect just hides them).
        this.setInspect(false);
        for (const div of this._inspectDivs.values()) {
            if (div) div.remove();
        }
        this._inspectDivs.clear();
        this.material.dispose();
        super.dispose();
    }
}


// ── Open-Meteo: one column (every pressure level, every hour of a day) ──
const _openMeteoPressureLevels = [1000, 975, 950, 925, 900, 850, 800, 700, 600, 500, 400, 300, 250, 200, 150, 100, 70, 50, 30];

// The wind at every pressure level at a point, for each hour of a UTC day
// (dateStr "YYYY-MM-DD"): {lat, lon, dateStr, hours}, where hours[h] is the
// column at hour h, [{altM, u, v}] lowest first, at each level's own height
// (geopotential height, from the same reply). Read with columnWindAt().
export async function fetchOpenMeteoColumn(lat, lon, dateStr) {
    // The secure build makes no request to this source. WindSources.js drops the option from
    // the dropdown, so this is only reachable from a sitch saved with the source selected; the
    // callers already treat a thrown fetch as "no usable samples" (see docs/dev/Secure-Build.md).
    if (isSecureBuild) throw new Error("open-meteo is not available in this build");

    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const isHistorical = new Date(`${dateStr}T00:00:00Z`) < today;
    const baseUrl = isHistorical
        ? "https://historical-forecast-api.open-meteo.com/v1/forecast"
        : "https://api.open-meteo.com/v1/forecast";
    const levels = _openMeteoPressureLevels;
    const vars = [
        ...levels.map(l => `wind_speed_${l}hPa`),
        ...levels.map(l => `wind_direction_${l}hPa`),
        ...levels.map(l => `geopotential_height_${l}hPa`),
    ].join(",");
    const url = `${baseUrl}?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}`
        + `&hourly=${vars}&wind_speed_unit=ms&timezone=GMT&start_date=${dateStr}&end_date=${dateStr}`;

    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 30000);
    let data;
    try {
        const resp = await fetch(url, {signal: ctrl.signal});
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        data = await resp.json();
    } finally { clearTimeout(to); }

    const hours = [];
    for (let h = 0; h < 24; h++) {
        const column = [];
        for (const l of levels) {
            const altM = data.hourly?.[`geopotential_height_${l}hPa`]?.[h];
            const speed = data.hourly?.[`wind_speed_${l}hPa`]?.[h];
            const dir = data.hourly?.[`wind_direction_${l}hPa`]?.[h];
            if (altM == null || speed == null || dir == null) continue;
            column.push({altM, ...fromDirSpeedToUV(dir, speed)});
        }
        column.sort((a, b) => a.altM - b.altM);
        hours.push(column);
    }
    return {lat, lon, dateStr, hours};
}

// {u, v} in m/s at (lat, lon, altM) for the sitch's current hour, or null.
// Kept for callers of the old per-height fetch.
export async function fetchOpenMeteoUV(lat, lon, altM) {
    const dateNow = GlobalDateTimeNode?.dateNow ?? new Date();
    const column = await fetchOpenMeteoColumn(lat, lon, dateNow.toISOString().slice(0, 10));
    const w = columnWindAt(column.hours[dateNow.getUTCHours()] ?? [], altM);
    return w ? {u: w.u, v: w.v} : null;
}

// ═══════════════════════════════════════════════════════════════════
//  GLSL Shaders
// ═══════════════════════════════════════════════════════════════════

const VERT_DECLARATIONS = /* glsl */ `
    attribute vec4 instanceWindStart;
    attribute vec4 instanceWindEnd;
    varying float vProgress;
    varying float vId;
    varying float vSpeed;
    varying float vCoverage;
    varying float vLod;
    varying float vCamDist;
    varying float vBackFace;
`;

const VERT_BODY = /* glsl */ `
    vec4 wind = mix(instanceWindStart, instanceWindEnd, lineVertexFraction);
    vProgress = wind.x;
    vSpeed = wind.y;
    vCoverage = wind.z;
    vId = instanceWindStart.w;
    vLod = instanceWindEnd.w;
    vec3 endpoint = mix(instanceStart, instanceEnd, lineVertexFraction);
    vCamDist = length((modelViewMatrix * vec4(endpoint, 1.0)).xyz);
    vec3 windWorldPos = (modelMatrix * vec4(endpoint, 1.0)).xyz;
    vBackFace = dot(normalize(windWorldPos), normalize(windWorldPos - cameraPosition));
`;

const FRAG_DECLARATIONS = /* glsl */ `
    uniform float uTime;
    uniform float uNumDashes;
    uniform float uFlowSpeed;
    uniform float uOpacity;
    uniform float uMaxSpeed;

    varying float vProgress;
    varying float vId;
    varying float vSpeed;
    varying float vCoverage;
    varying float vLod;
    varying float vCamDist;
    varying float vBackFace;

    vec3 hsv(float h, float s, float v) {
        vec3 c = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
        return v * mix(vec3(1.0), c, s);
    }

`;

const FRAG_BODY = /* glsl */ `
        // discard back-facing fragments (far side of globe)
        if (vBackFace > 0.0) discard;

        // ── per-vertex LOD fade based on camera distance ──
        // LOD 0 (coarsest): always visible
        // LOD 1:            fade in within 15,000 km
        // LOD 2:            fade in within 8,000 km
        // LOD 3 (finest):   fade in within 4,000 km
        float lodFade = 1.0;
        if (vLod > 0.5) lodFade *= (1.0 - smoothstep(10000000.0, 15000000.0, vCamDist));
        if (vLod > 1.5) lodFade *= (1.0 - smoothstep(5000000.0, 8000000.0, vCamDist));
        if (vLod > 2.5) lodFade *= (1.0 - smoothstep(2500000.0, 4000000.0, vCamDist));
        if (lodFade < 0.01) discard;

        // animated dash — long bright segments with short dim gaps
        float phase = fract(vProgress * uNumDashes - uTime * uFlowSpeed + vId);
        float dash  = smoothstep(0.0, 0.08, phase) * (1.0 - smoothstep(0.65, 0.75, phase));
        dash = 0.15 + 0.85 * dash;

        // fade at streamline endpoints
        float endFade = smoothstep(0.0, 0.08, vProgress) * (1.0 - smoothstep(0.92, 1.0, vProgress));

        // wind-speed color ramp (blue -> cyan -> green -> yellow -> red)
        float t = clamp(vSpeed / uMaxSpeed, 0.0, 1.0);
        float hue = (1.0 - t) * 0.65;
        vec3 color = hsv(hue, 0.8, 0.8 + 0.2 * t);

        // vCoverage (per-vertex, interpolated along segment) dims streamlines
        // in regions that are far from any IDW input sample. GFS / Manual
        // sources emit coverage = 1 everywhere, so those are unaffected.
        alpha *= dash * endFade * uOpacity * lodFade * vCoverage;
        if (alpha <= 0.0) discard;
        diffuseColor.rgb = color;
`;
