// Wind field visualization with animated streamlines on the globe.
// Uses GPU-efficient shader animation: a frame counter offsets a dash pattern
// along each streamline, creating a flowing effect without per-frame geometry updates.

import {CNode3DGroup} from "./CNode3DGroup";
import {ECEFToLLAVD_radii, LLAToECEF} from "../LLA-ECEF-ENU";
import {DebugArrowAB, removeDebugArrow} from "../threeExt";
import {getLocalEastVector, getLocalNorthVector} from "../SphericalMath";
import {sharedUniforms} from "../js/map33/material/SharedUniforms";
import {FileManager, GlobalDateTimeNode, Globals, NodeMan, setRenderOne, Sit, Units} from "../Globals";
import {LoadingManager} from "../CLoadingManager";
import {mouseInView, mouseToView} from "../ViewUtils";
import {ViewMan} from "../CViewManager";
import pako from "pako";
import * as LAYER from "../LayerMasks";
import {BufferAttribute, BufferGeometry, LineSegments, ShaderMaterial, Vector3,} from "three";
import {meanSeaLevelOffset} from "../EGM96Geoid";
import {
    bracketingLevels,
    compassFromDeg,
    fromDirSpeedKnotsToUV,
    fromDirSpeedToUV,
    fromUVToDirKnots,
    greatCircleDistanceDeg,
    levelToAltFeet,
    sampleJSONGrid,
    WIND_LEVEL_TABLE,
    windDirFromBearing,
} from "./WindHelpers";
import {isTrackSourceKey, trackDataIdFromSourceKey} from "./WindSources";
import {isSecureBuild} from "../configUtils";
import {MISB} from "../MISBUtils";
import {installTerrestrialRefractionOnShaderMaterial} from "../atmosphere/terrestrialRefraction";

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

// Module-level scratch Vector3s for the per-frame screen-grid path.
// Each renders ~60 arrows; without these, every iteration allocates 4-6
// Vector3s (ndc, hit, dir, end, plus the local-frame helpers' internals).
// Wind nodes are singletons within a sitch so sharing scratches across
// arrows is safe — they're never read after a single iteration completes.
const _scratchNDC = new Vector3();
const _scratchHit = new Vector3();
const _scratchDir = new Vector3();
const _scratchEnd = new Vector3();

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
        this._lastDateCycle = null;  // "YYYYMMDD_HH" of the last-fetched GFS cycle
        this._levelCache = {};       // level string → GFS json (one per pressure level)

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

        // Inspect mode: when on, renders one arrow + readout per "inspect
        // point". Three kinds of points can be active:
        //   - cursor:  follows the mouse (one transient point)
        //   - dropped: persistent, click-to-add / right-click-to-remove
        //   - camera/target: anchored to lookCamera / target track positions,
        //     auto-added when inspect is on if the corresponding node exists
        // Listeners (mousemove/click/contextmenu) are installed only while
        // inspect is on so we don't pay the cost when the feature is off.
        this.inspect = false;
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
        this.material = new ShaderMaterial({
            uniforms: {
                uTime:      {value: 0},
                uNumDashes: {value: this.numDashes},
                uFlowSpeed: {value: this.flowSpeed},
                uOpacity:   {value: this.lineOpacity},
                uMaxSpeed:  {value: this.maxWindSpeed},
                ...sharedUniforms,
            },
            vertexShader: VERT,
            fragmentShader: FRAG,
            transparent: true,
            depthTest: false,
            depthWrite: false,
        });
        installTerrestrialRefractionOnShaderMaterial(this.material);

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

    // Sample wind at (lat, lon) at a specific altitude (meters MSL).
    //
    // Sounding-based sources keep multi-level wind in CNodeAtmosphericProfile
    // for each loaded station, so we can do a per-point IDW from the K=3
    // nearest profiles' wind-at-altitude values — accurate at any altitude,
    // not just the one the IDW grid was built for.
    //
    // GFS keeps every fetched pressure level in _levelCache (and FileManager
    // for save/restore). Bracket the requested altitude between two cached
    // levels and bilinearly interpolate each, then blend.
    //
    // For sources without a per-altitude path (manual, openmeteo cache miss),
    // returns null so the caller can fall back to the current display-altitude
    // sample. Returns null in any error path so callers don't have to spot-
    // check intermediate failures.
    sampleWindAtAltitude(lat, lon, altM) {
        if (!Number.isFinite(altM)) return null;
        const altFt = altM * 3.28084;

        // Sounding-based: per-profile getAtAltitude + IDW.
        if (this.source === "uwyo" || this.source === "igra2"
            || this.source === "manual-soundings") {
            const profiles = this._gatherSondeProfiles(
                this.source === "manual-soundings" ? null : this.source);
            // A station only contributes at altitudes where it actually MEASURED
            // wind. Above its top valid-wind level it drops OUT of the blend
            // rather than holding a lower-altitude wind that would pollute a
            // high-altitude estimate — so as altitude rises the IDW gracefully
            // degrades from all nearby stations down to whichever few still
            // reach that high (3→2→1). Radiosondes commonly measure wind to very
            // different tops (one to ~50k ft, another to ~100k ft).
            const samples = [];
            let highestTop = null; // station whose valid wind reaches highest
            for (const p of profiles) {
                if (p.stationLat == null || p.stationLon == null) continue;
                if (p.topWindAlt != null
                    && (highestTop == null || p.topWindAlt > highestTop.topWindAlt)) {
                    highestTop = p;
                }
                if (p.topWindAlt != null && altM > p.topWindAlt) continue; // no measured wind here
                const data = p.getAtAltitude(altM);
                if (!data || data.windDir == null || data.windSpeed == null) continue;
                const dLat = p.stationLat - lat;
                const dLon = p.stationLon - lon;
                const cosLat = Math.cos(lat * DEG);
                const distDeg2 = dLat * dLat + (dLon * cosLat) ** 2;
                samples.push({distDeg2, data});
            }
            if (samples.length === 0) {
                // Above EVERY station's top — no measured wind anywhere. Repeat
                // the highest-reaching station's top wind (best available guess)
                // rather than reverting to no wind.
                if (!highestTop) return null;
                const d = highestTop.getAtAltitude(highestTop.topWindAlt);
                if (!d || d.windDir == null || d.windSpeed == null) return null;
                return fromDirSpeedToUV(d.windDir, d.windSpeed);
            }
            samples.sort((a, b) => a.distDeg2 - b.distDeg2);
            const K = Math.min(3, samples.length);
            let sumU = 0, sumV = 0, totalW = 0;
            for (let i = 0; i < K; i++) {
                const s = samples[i];
                // 1/d² IDW. Tiny epsilon (0.0001 deg² ≈ 11 m²) protects
                // against div-by-zero when the sample point coincides with
                // a station; the resulting weight just dominates the blend.
                const w = 1 / Math.max(s.distDeg2, 1e-4);
                const {u, v} = fromDirSpeedToUV(s.data.windDir, s.data.windSpeed);
                sumU += u * w; sumV += v * w; totalW += w;
            }
            return {u: sumU / totalW, v: sumV / totalW};
        }

        // GFS / Custom: cached pressure-level grids, bracket-then-blend.
        if (this._isGridSource() && this._lastDateCycle) {
            const [dateStr, hour] = this._lastDateCycle.split("_");
            const {lo, hi, t} = bracketingLevels(altFt);
            const jsonLo = this._levelCache[`${dateStr}_${hour}_${lo.level}`];
            const jsonHi = lo.level === hi.level
                ? jsonLo
                : this._levelCache[`${dateStr}_${hour}_${hi.level}`];
            if (!jsonLo || !jsonHi) return null;
            const sampleLo = sampleJSONGrid(jsonLo, lat, lon);
            const sampleHi = sampleJSONGrid(jsonHi, lat, lon);
            return {
                u: (1 - t) * sampleLo.u + t * sampleHi.u,
                v: (1 - t) * sampleLo.v + t * sampleHi.v,
            };
        }

        // openmeteo with a cache hit at this exact (lat,lon,altBucket,hour).
        if (this.source === "openmeteo" && this._omCache) {
            const dateNow = GlobalDateTimeNode?.dateNow ?? new Date();
            const key = `${lat.toFixed(4)}|${lon.toFixed(4)}`
                + `|${Math.round(altM / 100)}`
                + `|${dateNow.toISOString().slice(0, 13)}`;
            const cached = this._omCache.get(key);
            if (cached) return cached;
        }

        // Manual: targetWind is treated as uniform across the column, so
        // the grid sample IS the right answer at any altitude — return it
        // (rather than null) so the caller treats this as a hit and shows
        // the requested altitude (e.g. Camera @ jet altitude) instead of
        // falling back to the display altitude in the readout.
        if (this.source === "manual") {
            return this.sampleWind(lat, lon);
        }

        return null;
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
            if (this._sondeArrows) {
                for (const [name, entry] of this._sondeArrows) {
                    const lengthM = view.pixelsToMeters(entry.start, PX);
                    _scratchEnd.copy(entry.start).addScaledVector(entry.dir, lengthM);
                    DebugArrowAB(name, entry.start, _scratchEnd, "#ff66ff", true,
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

    // Toggle inspect mode. Installs/removes document mousemove + mouse-
    // down/up listeners. On disable, hides all readout divs and removes
    // the per-point arrows (dropped points themselves stay in
    // this.inspectPoints so the next enable restores them).
    //
    // Click semantics:
    //   shift+left-click → drop a new point at the wind-shell hit
    //   alt/option+left-click → remove the closest dropped point
    //   plain left-click → no inspect action (camera-orbit / etc still works)
    // The modifier requirement keeps inspect from interfering with normal
    // mouse navigation; right-click is left alone for the OS / page menu.
    setInspect(enabled) {
        this.inspect = !!enabled;

        if (this.inspect && !this._inspectMouseHandler) {
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
            document.addEventListener("mousemove", this._inspectMouseHandler);

            // Modified-click handler. Tracks mousedown vs mouseup so a drag
            // (camera-orbit / pan) doesn't get reinterpreted as a click.
            this._inspectClickHandler = this._handleInspectClick.bind(this);
            document.addEventListener("mousedown", this._inspectClickHandler);
            document.addEventListener("mouseup", this._inspectClickHandler);
        } else if (!this.inspect && this._inspectMouseHandler) {
            document.removeEventListener("mousemove", this._inspectMouseHandler);
            document.removeEventListener("mousedown", this._inspectClickHandler);
            document.removeEventListener("mouseup", this._inspectClickHandler);
            this._inspectMouseHandler = null;
            this._inspectClickHandler = null;
        }

        if (!this.inspect) {
            this._inspectClient = null;
            // Hide all per-point readouts and remove all arrows; the next
            // enable will recreate them. inspectPoints itself is preserved
            // so dropped points re-appear when the user re-enables.
            for (const div of this._inspectDivs.values()) {
                if (div) div.style.display = "none";
            }
            this._removeAllInspectArrows();
        }
    }

    // True when the event target sits inside a UI panel (lil-gui, native
    // form input, button) — clicks there should be handled by the GUI,
    // never reinterpreted as drop/remove gestures even if their pixel
    // coords happen to fall inside the mainView rectangle (lil-gui panels
    // float over the canvas in many layouts).
    _eventTargetIsGui(e) {
        const t = e.target;
        if (!t || typeof t.closest !== "function") return false;
        return !!t.closest(".lil-gui, .dg, .gui, select, input, textarea, button, label");
    }

    // mousedown/mouseup pair-detector for click vs drag classification.
    // We track the down position AND whether shift/alt was held; on up, if
    // the modifier still matches (or was set on either edge), the delta is
    // < 5 px, and the event target is in mainView, we treat it as a click.
    //   shift → add a new point
    //   alt   → remove the closest dropped point
    // Larger deltas mean the user was orbiting/panning, so we ignore.
    _handleInspectClick(e) {
        if (!this.inspect) return;
        if (e.button !== 0) return;  // only left-button
        if (this._eventTargetIsGui(e)) {
            this._inspectMouseDown = null;
            return;
        }

        if (e.type === "mousedown") {
            this._inspectMouseDown = {
                x: e.clientX, y: e.clientY,
                shift: e.shiftKey, alt: e.altKey,
            };
            return;
        }
        // mouseup
        const down = this._inspectMouseDown;
        this._inspectMouseDown = null;
        if (!down) return;
        const dx = e.clientX - down.x, dy = e.clientY - down.y;
        if (dx * dx + dy * dy > 25) return;  // > 5 px = drag, not click

        // Require the modifier on both edges OR on mouseup (some users only
        // press the modifier mid-click). The down state covers users who
        // release the modifier before mouseup. Either path is intentional.
        const wantAdd = down.shift || e.shiftKey;
        const wantDelete = down.alt || e.altKey;
        if (!wantAdd && !wantDelete) return;
        // Don't ambiguously do both if the user held both — prefer add,
        // since destroying state on a stray modifier combo is the worse
        // failure mode.
        const action = wantAdd ? "add" : "delete";

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
            z-index: 10000;
            line-height: 1.2;
            white-space: nowrap;
        `;
        document.body.appendChild(d);
        this._inspectDivs.set(id, d);
        return d;
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
        if (!this.inspect || !this.windU || !view.pixelsToMeters) return;

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

        // Cursor — only when inside mainView.
        if (this._inspectClient
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

        // Camera + Target anchors. Sample at the track's own altitude (the
        // ECEF position's z above MSL), not the display altitude — these
        // points exist precisely so the user can see what wind a moving
        // object is in without having to align the slider manually.
        for (const [anchor, color] of [["camera", "#00cc66"], ["target", "#ff3366"]]) {
            const track = this._trackForAnchor(anchor);
            if (!track) continue;
            const pos = track.p(Sit.currentFrame ?? 0);
            if (!pos) continue;
            const lla = ECEFToLLAVD_radii(pos);
            if (!Number.isFinite(lla.x) || !Number.isFinite(lla.y)
                || !Number.isFinite(lla.z)) continue;
            const trackAltM = lla.z - meanSeaLevelOffset(lla.x, lla.y);
            points.push({
                id: anchor, color, label: anchor[0].toUpperCase() + anchor.slice(1),
                lat: lla.x, lon: lla.y, altMSL: trackAltM,
            });
        }

        // Persisted dropped points — at the display altitude.
        for (let i = 0; i < this.inspectPoints.length; i++) {
            const p = this.inspectPoints[i];
            points.push({
                id: `drop:${i}`, color: "#ff9900", label: `#${i + 1}`,
                lat: p.lat, lon: p.lon, altMSL: dispAltMSL,
            });
        }

        // Render each point. seenIds tracks which arrows/divs are still
        // active so we can clean up leftovers from the previous frame.
        const speedUnit = Units?.speedUnits ?? "knots";
        const seenIds = new Set();
        for (const p of points) {
            const ecef = LLAToECEF(p.lat, p.lon, p.altMSL);
            if (!ecef) continue;
            // Try the per-altitude path first (sounding profiles, GFS
            // bracketing levels, openmeteo cache). Fall back to the
            // displayed-altitude grid sample when the source can't sample
            // at p.altMSL (e.g. manual wind, openmeteo cache miss). The
            // readout's altitude line reflects what was actually sampled
            // so the user can tell the difference.
            let w = this.sampleWindAtAltitude(p.lat, p.lon, p.altMSL);
            let usedAltMSL = p.altMSL;
            if (!w || !Number.isFinite(w.u) || !Number.isFinite(w.v)) {
                w = this.sampleWind(p.lat, p.lon);
                usedAltMSL = dispAltMSL;
            }
            if (!w || !Number.isFinite(w.u) || !Number.isFinite(w.v)) continue;
            const speedMS = Math.hypot(w.u, w.v);
            const {from} = fromUVToDirKnots(w.u, w.v);
            const compass = compassFromDeg(from);
            const speedDisp = speedMS * (Units?.m2Speed ?? 1.94384);

            // Arrow points TO (drift direction), 100 px on screen.
            windDirFromBearing(p.lat, p.lon, from * DEG, _scratchDir);
            _scratchHit.copy(ecef);
            const lengthM = view.pixelsToMeters(_scratchHit, 100);
            _scratchEnd.copy(_scratchHit).addScaledVector(_scratchDir, lengthM);
            const arrowName = `windInspect_${p.id}`;
            DebugArrowAB(arrowName, _scratchHit, _scratchEnd, p.color, true,
                this.group, 30, LAYER.MASK_MAIN);
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
            const div = this._ensureInspectDiv(p.id, p.color);
            const altFt = usedAltMSL * 3.28084;
            const altLabel = altFt < 300
                ? "Surface"
                : `${Math.round(altFt).toLocaleString()} ft`;
            if (p.id === "cursor") {
                div.innerHTML =
                    `<div style="font-size:22px;font-weight:600">${speedDisp.toFixed(0)} ${speedUnit}</div>`
                    + `<div style="font-size:13px;opacity:0.85">FROM ${compass} ${Math.round(from)}°</div>`
                    + `<div style="font-size:11px;opacity:0.65">@ ${altLabel}</div>`;
            } else {
                div.innerHTML =
                    `<div style="font-size:11px;opacity:0.85">${p.label}</div>`
                    + `<div style="font-size:14px;font-weight:600">${speedDisp.toFixed(0)} ${speedUnit}</div>`
                    + `<div style="font-size:11px;opacity:0.85">${compass} ${Math.round(from)}°</div>`
                    + `<div style="font-size:10px;opacity:0.65">@ ${altLabel}</div>`;
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
            const tipW = div.offsetWidth;
            const tipH = div.offsetHeight;
            const M = INSPECT_TOOLTIP_OFFSET_PX;
            const left = (anchorPx.x + M + tipW > window.innerWidth)
                ? anchorPx.x - M - tipW : anchorPx.x + M;
            const top = (anchorPx.y + M + tipH > window.innerHeight)
                ? anchorPx.y - M - tipH : anchorPx.y + M;
            div.style.left = Math.max(0, left) + "px";
            div.style.top = Math.max(0, top) + "px";
        }

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
            const f = Sit.currentFrame ?? 0;
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
            !!this.fetching;
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

        const geom = new BufferGeometry();
        geom.setAttribute("position",     new BufferAttribute(new Float32Array(out.pos),  3));
        geom.setAttribute("lineProgress", new BufferAttribute(new Float32Array(out.prog), 1));
        geom.setAttribute("lineId",       new BufferAttribute(new Float32Array(out.id),   1));
        geom.setAttribute("windSpeed",    new BufferAttribute(new Float32Array(out.spd),  1));
        geom.setAttribute("coverage",     new BufferAttribute(new Float32Array(out.cov),  1));
        geom.setAttribute("lodLevel",     new BufferAttribute(new Float32Array(out.lod),  1));
        geom.computeBoundingSphere();

        this.linesMesh = new LineSegments(geom, this.material);
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
    _isGridSource() {
        return this.source === "gfs" || this.source === "custom";
    }

    // True when both bracketing pressure levels for `altFt` are already
    // resident (in _levelCache or in FileManager via _loadedWindFiles).
    // The altitude-slider live-update path uses this to decide whether it can
    // safely re-fetch on every drag tick without hitting the network.
    hasGFSBracketCached(altFt) {
        if (!this._isGridSource()) return false;
        const dateNode = GlobalDateTimeNode;
        const dateNow = dateNode?.dateNow ?? new Date();
        const dateStr = dateNow.toISOString().slice(0, 10).replace(/-/g, "");
        const hour = Math.floor(dateNow.getUTCHours() / 6) * 6;
        const {lo, hi} = bracketingLevels(altFt);
        const has = (level) => {
            if (this._levelCache[`${dateStr}_${hour}_${level}`]) return true;
            for (const meta of this._loadedWindFiles.values()) {
                if (meta.dateStr === dateStr
                    && meta.hour === String(hour)
                    && meta.level === level) return true;
            }
            return false;
        };
        return has(lo.level) && (lo.level === hi.level || has(hi.level));
    }

    // ── fetch a single level (with caching) ─────────────────────────
    async _fetchLevel(level, dateStr, hour) {
        const cacheKey = `${dateStr}_${hour}_${level}`;
        if (this._levelCache[cacheKey]) return this._levelCache[cacheKey];

        // Persistent cache: a previous session may have stored this level's
        // grid in FileManager (and we restored it in modDeserialize). Reuse
        // the cached file rather than re-hitting the network.
        for (const [fid, meta] of this._loadedWindFiles) {
            if (meta.dateStr === dateStr && meta.hour === String(hour) && meta.level === level) {
                const entry = FileManager.list[fid];
                if (entry) {
                    const cached = CNodeDisplayWindField._parseWindEntry(entry);
                    if (cached?.u && cached?.v) {
                        this._levelCache[cacheKey] = cached;
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

        const proxy = this.source === "custom"
            ? "customWindProxy.php"
            : "windProxy.php";
        const url = `sitrecServer/${proxy}?date=${dateStr}&hour=${hour}&level=${level}`;
        const label = `${this.source === "custom" ? "Custom" : "GFS"} wind `
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
                this._levelCache[cacheKey] = json;
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
        const dateNow = GlobalDateTimeNode?.dateNow ?? new Date();
        const dateStr = dateNow.toISOString().slice(0, 10).replace(/-/g, "");
        const hour = Math.floor(dateNow.getUTCHours() / 6) * 6;
        const need = [];
        for (let i = 0; i < WIND_LEVEL_TABLE.length; i++) {
            need.push(WIND_LEVEL_TABLE[i].level);
            if (WIND_LEVEL_TABLE[i].ft >= altFt) break;   // include the bracketing level above altFt
        }
        const before = Object.keys(this._levelCache).length;
        const MAX_CONCURRENT = 3;   // don't hammer the proxy / NOMADS
        for (let i = 0; i < need.length; i += MAX_CONCURRENT) {
            await Promise.all(need.slice(i, i + MAX_CONCURRENT).map(
                (lvl) => this._fetchLevel(lvl, dateStr, hour).catch(() => null)));
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
            } else if (this.source === "uwyo"
                    || this.source === "igra2"
                    || this.source === "manual-soundings") {
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
        } catch (err) {
            console.error("Wind fetch failed:", err);
            this.statusText = `Error: ${err.message}`;
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
        const dateNode = GlobalDateTimeNode;
        const dateNow = dateNode?.dateNow ?? new Date();
        const dateStr = dateNow.toISOString().slice(0, 10).replace(/-/g, "");
        const hour = Math.floor(dateNow.getUTCHours() / 6) * 6;

        const {lo, hi, t} = bracketingLevels(altFt);
        const needTwo = lo.level !== hi.level;

        this.statusText = needTwo
            ? `Fetching ${lo.level} + ${hi.level}...`
            : `Fetching ${lo.level === "surface" ? "Surface" : lo.level + " hPa"}...`;
        console.log(`Wind alt ${altFt} ft → ${lo.level}(${(1 - t).toFixed(2)}) + ${hi.level}(${t.toFixed(2)})`);

        const jsonLo = await this._fetchLevel(lo.level, dateStr, hour);
        const jsonHi = needTwo ? await this._fetchLevel(hi.level, dateStr, hour) : jsonLo;

        const n = jsonLo.u.length;
        const blendedU = new Array(n);
        const blendedV = new Array(n);
        for (let i = 0; i < n; i++) {
            blendedU[i] = Math.round(((1 - t) * jsonLo.u[i] + t * jsonHi.u[i]) * 100) / 100;
            blendedV[i] = Math.round(((1 - t) * jsonLo.v[i] + t * jsonHi.v[i]) * 100) / 100;
        }

        const defaultSourceName = this.source === "custom" ? "Custom" : "GFS";
        const blended = {
            ...jsonLo,
            u: blendedU,
            v: blendedV,
            level: `${Math.round(altFt)}ft`,
            source: jsonLo.source ?? defaultSourceName,
            _loLevel: lo.level,
            _hiLevel: hi.level,
            _blendT: t,
        };

        this._applyWindJSON(blended);
        this.windLevel = lo.level === hi.level ? lo.level : `${lo.level}+${hi.level}`;
        this._lastDateCycle = `${dateStr}_${hour}`;
        this._storeWindFiles(jsonLo, jsonHi, needTwo, dateStr, hour);

        const altLabel = altFt < 300 ? "Surface" : `${altFt.toLocaleString()} ft`;
        const statusName = blended.source;
        this.statusText = `${statusName} ${jsonLo.refTime?.slice(0, 10) ?? dateStr} ${altLabel}`;
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
        for (const p of profiles) {
            if (p.stationLat == null || p.stationLon == null) {
                droppedNoCoords++;
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
            throw new Error(`${label} profiles have no wind at ${Math.round(altFt)} ft`);
        }

        this._buildGridFromSamples(samples, label);
        this.windLevel = `${Math.round(altFt)}ft`;
        const altLabel = altFt < 300 ? "Surface" : `${altFt.toLocaleString()} ft`;
        this.statusText = `${label} (${samples.length}) ${altLabel}`;
    }

    // Map internal source key → {profiles, label}. Separated so sampleAtLLA
    // and _fillFromSoundings share the same filter semantics.
    _resolveSoundingProfiles(sourceKey) {
        if (sourceKey === "uwyo") {
            return {profiles: this._gatherSondeProfiles("uwyo"), label: "UWYO"};
        }
        if (sourceKey === "igra2") {
            return {profiles: this._gatherSondeProfiles("igra2"), label: "IGRA2"};
        }
        // manual-soundings — any loaded profile, regardless of origin
        return {profiles: this._gatherSondeProfiles(null), label: "Manual Soundings"};
    }

    // ── Open-Meteo: fetch at target/local and tile globally ─────────
    //
    // Each activation can trigger up to 4 fetches (2 for display + 2 for
    // propagation at each node's own altitude). Results are cached in
    // `_omCache` keyed on (lat, lon, altFt-bucket, date-hour) so the
    // propagation pass reuses fetches done for the display pass when
    // altitudes happen to match.
    async _fillFromOpenMeteo(altFt) {
        const altLabel = altFt < 300 ? "Surface" : `${altFt.toLocaleString()} ft`;
        this.statusText = `Fetching open-meteo at ${altLabel}...`;

        const points = this._windNodePositions();
        if (points.length === 0) {
            throw new Error("No target/local wind node with an origin track");
        }

        const samples = [];
        for (const pt of points) {
            try {
                const uv = await this._cachedOpenMeteo(pt.lat, pt.lon, altFt * 0.3048);
                if (uv) samples.push({lat: pt.lat, lon: pt.lon, u: uv.u, v: uv.v});
            } catch (err) {
                console.warn("open-meteo fetch failed for", pt, err.message);
            }
        }
        if (samples.length === 0) {
            throw new Error("open-meteo returned no usable samples");
        }

        this._buildGridFromSamples(samples, "OpenMeteo");
        this.windLevel = `${Math.round(altFt)}ft`;
        this.statusText = `open-meteo (${samples.length}) ${altLabel}`;
    }

    async _cachedOpenMeteo(lat, lon, altM) {
        if (!this._omCache) this._omCache = new Map();
        const dateNow = GlobalDateTimeNode?.dateNow ?? new Date();
        // Cache key: round lat/lon to 4 decimals, altitude to 100m, date to hour.
        const key = `${lat.toFixed(4)}|${lon.toFixed(4)}|${Math.round(altM / 100)}|${dateNow.toISOString().slice(0, 13)}`;
        if (this._omCache.has(key)) return this._omCache.get(key);
        const uv = await fetchOpenMeteoUV(lat, lon, altM);
        this._omCache.set(key, uv);
        return uv;
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
        const altLabel = altFt < 300 ? "Surface" : `${altFt.toLocaleString()} ft`;
        this.statusText = `Manual ${Math.round(tw.from)}° ${Math.round(tw.knots)} kn @ ${altLabel}`;
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
        const f = Sit.currentFrame ?? 0;
        const denom = Math.max(1, (Sit.frames ?? 1) - 1);
        const slotF = (f / denom) * (misb.length - 1);
        const slot = Math.max(0, Math.min(misb.length - 1, Math.round(slotF)));
        const row = misb[slot];
        const dir = row?.[MISB.WindDirection];
        const spd = row?.[MISB.WindSpeed];
        if (typeof dir !== "number" || !Number.isFinite(dir)
            || typeof spd !== "number" || !Number.isFinite(spd)) {
            throw new Error(`Track ${trackId} missing wind data at frame ${f}`);
        }

        const {u, v} = fromDirSpeedKnotsToUV(dir, spd);
        const points = this._windNodePositions();
        if (points.length === 0) {
            this._buildUniformGrid(u, v, "Track");
        } else {
            const samples = points.map(pt => ({lat: pt.lat, lon: pt.lon, u, v}));
            this._buildGridFromSamples(samples, "Track");
        }
        this.windLevel = `${Math.round(altFt)}ft`;
        const altLabel = altFt < 300 ? "Surface" : `${altFt.toLocaleString()} ft`;
        const shortName = td.shortName ?? trackId;
        this.statusText = `${shortName} ${Math.round(dir)}° ${Math.round(spd)} kn @ ${altLabel}`;
        // Remember the (frame → wind) snapshot so update() can detect when
        // the track row's wind has changed enough to warrant a refresh.
        this._trackLastDir = dir;
        this._trackLastSpd = spd;
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
            const f = Sit.currentFrame ?? 0;
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
    sondeProfileSignature() {
        if (this.source !== "uwyo" && this.source !== "igra2"
            && this.source !== "manual-soundings") return "";
        const profiles = this._gatherSondeProfiles(
            this.source === "manual-soundings" ? null : this.source);
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
    _buildGridFromSamples(samples, sourceLabel) {
        const nx = 72, ny = 37;           // 5° resolution
        const dlon = 5, dlat = -5;
        const lon0 = 0, lat0 = 90;
        const u = new Array(nx * ny);
        const v = new Array(nx * ny);
        const cov = new Array(nx * ny);

        const POWER = 2;
        const K = Math.min(3, samples.length);
        const L = this.coverageLengthDeg;  // decay length scale (degrees)
        // Per-cell distance buffer; reused across cells to avoid allocation.
        const dists = new Array(samples.length);
        for (let j = 0; j < ny; j++) {
            const lat = lat0 + j * dlat;
            for (let i = 0; i < nx; i++) {
                const lon = lon0 + i * dlon;
                for (let k = 0; k < samples.length; k++) {
                    dists[k] = {
                        d: greatCircleDistanceDeg(lat, lon, samples[k].lat, samples[k].lon),
                        s: samples[k],
                    };
                }
                // Partial-sort would be fine but samples.length is small
                // (typically 1-10), so full sort is clearer and cheap enough.
                dists.sort((a, b) => a.d - b.d);
                let wsum = 0, usum = 0, vsum = 0;
                for (let k = 0; k < K; k++) {
                    const {d, s} = dists[k];
                    // Clamp very-small distance so exact hits don't divide by 0.
                    const dd = Math.max(d, 0.01);
                    const w = 1 / Math.pow(dd, POWER);
                    wsum += w; usum += w * s.u; vsum += w * s.v;
                }
                const dMin = dists[0].d;
                const idx = j * nx + i;
                u[idx] = wsum > 0 ? Math.round((usum / wsum) * 100) / 100 : 0;
                v[idx] = wsum > 0 ? Math.round((vsum / wsum) * 100) / 100 : 0;
                // Exponential falloff — smooth, no hard edges. 1.0 at the
                // sample, ≈0.37 at L degrees away, ≈0.14 at 2L.
                cov[idx] = Math.exp(-dMin / L);
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

    // ── Sample wind at a specific (lat,lon,altMeters) per-source ────
    // Returns {u,v} in m/s, or null. Used to drive target/local winds.
    async sampleAtLLA(lat, lon, altM) {
        if (this._isGridSource()) {
            return await this._sampleGFSAtLLA(lat, lon, altM);
        }
        if (this.source === "uwyo"
            || this.source === "igra2"
            || this.source === "manual-soundings") {
            return this._sampleSoundingsAtLLA(lat, lon, altM, this.source);
        }
        if (this.source === "openmeteo") {
            try { return await this._cachedOpenMeteo(lat, lon, altM); }
            catch (e) { console.warn("openmeteo sample:", e.message); return null; }
        }
        if (this.source === "manual") {
            // Manual is authoritative in the wind nodes themselves — no-op.
            return null;
        }
        return null;
    }

    async _sampleGFSAtLLA(lat, lon, altM) {
        const altFt = altM / 0.3048;
        const {lo, hi, t} = bracketingLevels(altFt);
        const dateNow = GlobalDateTimeNode?.dateNow ?? new Date();
        const dateStr = dateNow.toISOString().slice(0, 10).replace(/-/g, "");
        const hour = Math.floor(dateNow.getUTCHours() / 6) * 6;

        const jsonLo = await this._fetchLevel(lo.level, dateStr, hour);
        const jsonHi = lo.level === hi.level
            ? jsonLo
            : await this._fetchLevel(hi.level, dateStr, hour);
        const sLo = sampleJSONGrid(jsonLo, lat, lon);
        const sHi = sampleJSONGrid(jsonHi, lat, lon);
        return {u: (1 - t) * sLo.u + t * sHi.u, v: (1 - t) * sLo.v + t * sHi.v};
    }

    _sampleSoundingsAtLLA(lat, lon, altM, sourceKey) {
        const {profiles} = this._resolveSoundingProfiles(sourceKey);
        if (profiles.length === 0) return null;

        // Build the same (lat,lon,u,v) sample list the grid builder uses,
        // then 3-nearest IDW with haversine distance. Matches grid behavior
        // so target/local wind values line up with the visualised field.
        const items = [];
        for (const p of profiles) {
            if (p.stationLat == null || p.stationLon == null) continue;
            const data = p.getAtAltitude(altM);
            if (!data || data.windDir == null || data.windSpeed == null) continue;
            const uv = fromDirSpeedToUV(data.windDir, data.windSpeed);
            const d = greatCircleDistanceDeg(lat, lon, p.stationLat, p.stationLon);
            if (d < 0.01) return uv; // Exact station hit — use directly.
            items.push({d, u: uv.u, v: uv.v});
        }
        if (items.length === 0) return null;

        items.sort((a, b) => a.d - b.d);
        const K = Math.min(3, items.length);
        const POWER = 2;
        let wsum = 0, usum = 0, vsum = 0;
        for (let k = 0; k < K; k++) {
            const {d, u, v} = items[k];
            const dd = Math.max(d, 0.01);
            const w = 1 / Math.pow(dd, POWER);
            wsum += w; usum += w * u; vsum += w * v;
        }
        if (wsum === 0) return null;
        return {u: usum / wsum, v: vsum / wsum};
    }

    // ── Drive target/local wind nodes from the active source ────────
    //
    // `recalculateCascade()` can trigger downstream nodes that eventually
    // call back into the wind field (e.g., altitude slider listeners).
    // The `_propagating` guard prevents re-entrant propagation loops.
    async propagateToWindNodes() {
        if (this.source === "manual") return; // Manual is user-driven
        if (this._propagating) return;
        this._propagating = true;
        // Sources that may hit the network during sampleAtLLA get a
        // progress status. GFS reuses the level cache from the display
        // fetch; openmeteo may trigger fresh per-point fetches.
        const hitsNetwork = this.source === "openmeteo" || this._isGridSource();
        const originalStatus = this.statusText;
        try {
            const positions = this._windNodePositions();
            for (const pt of positions) {
                if (hitsNetwork) {
                    this.statusText = `Propagating ${pt.id}...`;
                }
                const uv = await this.sampleAtLLA(pt.lat, pt.lon, pt.altM);
                if (!uv) continue;
                const {from, knots} = fromUVToDirKnots(uv.u, uv.v);
                const node = NodeMan.get(pt.id);
                node.from = Math.round(from);
                node.knots = Math.round(knots);
                if (node.guiFrom) node.guiFrom.updateDisplay();
                if (node.guiKnots) node.guiKnots.updateDisplay();
                node.recalculateCascade();
                console.log(`Propagated ${pt.id} @ ${pt.altM.toFixed(0)}m → from ${node.from}° at ${node.knots} kn`);
            }
            if (hitsNetwork) this.statusText = originalStatus;
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
    _storeWindFiles(jsonLo, jsonHi, needTwo, dateStr, hour) {
        const src = (jsonLo.source ?? "GFS").replace(/[^a-zA-Z0-9]/g, "");
        this._windFileIds = [];

        const store = (json, suffix) => {
            const fileId = `windGrid_${src}_${suffix}`;
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
            this._loadedWindFiles.set(fileId, {
                level: json.level ?? suffix,
                dateStr: refDate || dateStr,
                hour: refHour || String(hour),
                source: src,
            });
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
        // Clearing _lastDateCycle keeps the cycle-change detector in
        // update() from treating a manual refresh as "still on the same
        // cycle"; without this, a refresh on a stale cycle wouldn't
        // re-arm the detector for the next clock advance.
        this._lastDateCycle = null;
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
            visible: this.visible,
            linesVisible: this.linesVisible,
            lineOpacity: this.lineOpacity,
            seedSpacing: this.seedSpacing,
            maxWindSpeed: this.maxWindSpeed,
            lockAltitudeTo: this.lockAltitudeTo,
            lastDateCycle: this._lastDateCycle,
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
        // Route inspect through setInspect so the document mousemove/down/up
        // listeners + readout divs come back online. A bare `this.inspect = v`
        // leaves the checkbox showing checked but the cursor produces no
        // readout and shift-click does nothing until the user toggles it.
        if (typeof v.inspect === "boolean") this.setInspect(v.inspect);
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
        if (v.lastDateCycle) this._lastDateCycle = v.lastDateCycle;
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
                    .map(e => [e.fileId, {
                        level: e.level, dateStr: e.dateStr,
                        hour: e.hour, source: e.source,
                    }])
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
                this.statusText = "Reloading...";
                this._needsPostDeserializeFetch = true;
            } else {
                this.statusText = "Not loaded";
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
                    ? v.loadedWindFiles : [];
                this.statusText = savedLevels.length > 0
                    ? `Reloading 0/${savedLevels.length} wind levels…`
                    : "Reloading wind…";
                // Deferred to finishDeserialization for the same reason as
                // the non-GFS branch above — see comment there.
                this._needsPostDeserializeReloadGFS = savedLevels;
            }
            return;
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

        const altLabel = this.windAltFt < 300 ? "Surface" : `${this.windAltFt.toLocaleString()} ft`;
        const statusName = jsons[0].source ?? (this.source === "custom" ? "Custom" : "GFS");
        this.statusText = `${statusName} ${jsons[0].refTime ?? "?"} ${altLabel}`;
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
        const dateNow = GlobalDateTimeNode?.dateNow ?? new Date();
        const fallbackDate = dateNow.toISOString().slice(0, 10).replace(/-/g, "");
        const fallbackHour = Math.floor(dateNow.getUTCHours() / 6) * 6;

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
                await this._fetchLevel(e.level, dateStr, hour);
                loaded++;
                if (total > 0) {
                    this.statusText = `Reloading ${loaded}/${total} wind levels…`;
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

        // Final status: tailored to outcome.
        const altLabel = this.windAltFt < 300 ? "Surface" : `${this.windAltFt.toLocaleString()} ft`;
        if (total === 0) {
            // Pre-loadedWindFiles save format — single fetchWindForAltitude
            // already set a sensible status; leave it alone.
        } else if (failures.length === 0) {
            this.statusText = `GFS ${altLabel} — all ${total} levels loaded`;
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
            this.statusText =
                `GFS ${altLabel} — ${total - failures.length}/${total} levels (closest: ${closest})`;
        } else {
            this.statusText = `GFS reload failed (${failures.length}/${total} levels)`;
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

        // Check if the sitch date has moved to a different GFS cycle
        if (this._lastDateCycle && !this.fetching) {
            const dateNode = GlobalDateTimeNode;
            const dateNow = dateNode?.dateNow;
            if (dateNow) {
                const dateStr = dateNow.toISOString().slice(0, 10).replace(/-/g, "");
                const hour = Math.floor(dateNow.getUTCHours() / 6) * 6;
                const currentCycle = `${dateStr}_${hour}`;
                if (currentCycle !== this._lastDateCycle) {
                    this._lastDateCycle = currentCycle;
                    // Cycle changed — last cycle's GFS grids are stale. Drop them
                    // from FileManager and the in-memory cache so we re-fetch.
                    this._evictAllWindGrids();
                    this.fetchWindForAltitude(this.windAltFt);
                }
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
        if (isTrackSourceKey(this.source) && this.windU && !this.fetching) {
            const trackId = trackDataIdFromSourceKey(this.source);
            if (trackId && NodeMan.exists(trackId)) {
                const td = NodeMan.get(trackId);
                const misb = td?.misb;
                if (Array.isArray(misb) && misb.length > 0) {
                    const denom = Math.max(1, (Sit.frames ?? 1) - 1);
                    const slotF = (frame / denom) * (misb.length - 1);
                    const slot = Math.max(0, Math.min(misb.length - 1, Math.round(slotF)));
                    const row = misb[slot];
                    const dir = row?.[MISB.WindDirection];
                    const spd = row?.[MISB.WindSpeed];
                    if (typeof dir === "number" && Number.isFinite(dir)
                        && typeof spd === "number" && Number.isFinite(spd)) {
                        const dDir = Math.abs((dir - (this._trackLastDir ?? dir) + 540) % 360 - 180);
                        const dSpd = Math.abs(spd - (this._trackLastSpd ?? spd));
                        if (dDir > 2 || dSpd > 1) {
                            this.fetchWindForAltitude(this.windAltFt);
                        }
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


// ── Open-Meteo wind fetch at (lat,lon,altM) → {u,v} in m/s ──
const _openMeteoPressureLevels = [1000, 975, 950, 925, 900, 850, 800, 700, 600, 500, 400, 300, 250, 200, 150, 100, 70, 50, 30];
const _openMeteoApproxAlt = {
    1000: 100, 975: 300, 950: 500, 925: 750, 900: 1000,
    850: 1500, 800: 2000, 700: 3000, 600: 4200, 500: 5500,
    400: 7200, 300: 9200, 250: 10400, 200: 11800, 150: 13600,
    100: 16200, 70: 18500, 50: 20600, 30: 23800,
};
export async function fetchOpenMeteoUV(lat, lon, altM) {
    // The secure build makes no request to this source. WindSources.js drops the option from
    // the dropdown, so this is only reachable from a sitch saved with the source selected; the
    // callers already treat a thrown fetch as "no usable samples" (see docs/dev/Secure-Build.md).
    if (isSecureBuild) throw new Error("open-meteo is not available in this build");

    // Select a small subset of pressure levels bracketing altM.
    // Pressure levels are sorted by ascending altitude; pick the first whose
    // approx altitude meets/exceeds altM, else the last.
    let upper = _openMeteoPressureLevels.findIndex(l => _openMeteoApproxAlt[l] >= altM);
    if (upper < 0) upper = _openMeteoPressureLevels.length - 1;
    const lo = Math.max(0, upper - 1);
    const hi = Math.min(_openMeteoPressureLevels.length - 1, upper + 1);
    const levels = _openMeteoPressureLevels.slice(lo, hi + 1);

    const dateNow = GlobalDateTimeNode?.dateNow ?? new Date();
    const dateStr = dateNow.toISOString().slice(0, 10);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const isHistorical = dateNow < today;
    const baseUrl = isHistorical
        ? "https://historical-forecast-api.open-meteo.com/v1/forecast"
        : "https://api.open-meteo.com/v1/forecast";
    const wsVars = levels.map(l => `wind_speed_${l}hPa`).join(",");
    const wdVars = levels.map(l => `wind_direction_${l}hPa`).join(",");
    const ghVars = levels.map(l => `geopotential_height_${l}hPa`).join(",");
    const url = `${baseUrl}?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}`
        + `&hourly=${wsVars},${wdVars},${ghVars}`
        + `&wind_speed_unit=ms&start_date=${dateStr}&end_date=${dateStr}`;

    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 30000);
    let data;
    try {
        const resp = await fetch(url, {signal: ctrl.signal});
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        data = await resp.json();
    } finally { clearTimeout(to); }

    const hourIndex = dateNow.getUTCHours();
    const valid = [];
    for (const l of levels) {
        const h = data.hourly?.[`geopotential_height_${l}hPa`]?.[hourIndex];
        const s = data.hourly?.[`wind_speed_${l}hPa`]?.[hourIndex];
        const d = data.hourly?.[`wind_direction_${l}hPa`]?.[hourIndex];
        if (h == null || s == null || d == null) continue;
        valid.push({h, s, d});
    }
    if (valid.length === 0) return null;
    valid.sort((a, b) => a.h - b.h);

    // Height-interpolate speed and (circular) direction
    let hit;
    if (altM <= valid[0].h) hit = valid[0];
    else if (altM >= valid[valid.length - 1].h) hit = valid[valid.length - 1];
    else {
        for (let i = 0; i < valid.length - 1; i++) {
            if (altM >= valid[i].h && altM <= valid[i + 1].h) {
                const t = (altM - valid[i].h) / (valid[i + 1].h - valid[i].h);
                const speed = valid[i].s + t * (valid[i + 1].s - valid[i].s);
                // circular interp on direction
                const aR = valid[i].d * Math.PI / 180, bR = valid[i + 1].d * Math.PI / 180;
                const sV = Math.sin(aR) * (1 - t) + Math.sin(bR) * t;
                const cV = Math.cos(aR) * (1 - t) + Math.cos(bR) * t;
                let dir = Math.atan2(sV, cV) * 180 / Math.PI;
                if (dir < 0) dir += 360;
                hit = {s: speed, d: dir};
                break;
            }
        }
    }
    if (!hit) return null;
    return fromDirSpeedToUV(hit.d, hit.s); // speed already in m/s
}

// ═══════════════════════════════════════════════════════════════════
//  GLSL Shaders
// ═══════════════════════════════════════════════════════════════════

const VERT = /* glsl */ `
    attribute float lineProgress;
    attribute float lineId;
    attribute float windSpeed;
    attribute float coverage;
    attribute float lodLevel;

    varying float vProgress;
    varying float vId;
    varying float vSpeed;
    varying float vCoverage;
    varying float vDepth;
    varying float vLod;
    varying float vCamDist;
    varying float vBackFace;

    void main() {
        vProgress = lineProgress;
        vId       = lineId;
        vSpeed    = windSpeed;
        vCoverage = coverage;
        vLod      = lodLevel;

        vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
        vCamDist  = length(mvPos.xyz);
        gl_Position = applyTerrestrialRefraction_clip(mvPos);
        vDepth = gl_Position.w;

        // back-face detection: dot(surface normal, view direction)
        // positive = facing away from camera (far side of globe)
        vec3 worldPos = (modelMatrix * vec4(position, 1.0)).xyz;
        vec3 surfaceNormal = normalize(worldPos);
        vec3 viewDir = normalize(worldPos - cameraPosition);
        vBackFace = dot(surfaceNormal, viewDir);
    }
`;

const FRAG = /* glsl */ `
    uniform float uTime;
    uniform float uNumDashes;
    uniform float uFlowSpeed;
    uniform float uOpacity;
    uniform float uMaxSpeed;
    uniform float nearPlane;
    uniform float farPlane;

    varying float vProgress;
    varying float vId;
    varying float vSpeed;
    varying float vCoverage;
    varying float vDepth;
    varying float vLod;
    varying float vCamDist;
    varying float vBackFace;

    vec3 hsv(float h, float s, float v) {
        vec3 c = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
        return v * mix(vec3(1.0), c, s);
    }

    void main() {
        // discard back-facing fragments (far side of globe)
        if (vBackFace > 0.0) discard;

        // ── per-vertex LOD fade based on camera distance ──
        // LOD 0 (coarsest): always visible
        // LOD 1:            fade in within 15,000 km
        // LOD 2:            fade in within 8,000 km
        // LOD 3 (finest):   fade in within 4,000 km
        float lodFade = 1.0;
        if (vLod > 0.5) lodFade *= smoothstep(15000000.0, 10000000.0, vCamDist);
        if (vLod > 1.5) lodFade *= smoothstep(8000000.0,  5000000.0, vCamDist);
        if (vLod > 2.5) lodFade *= smoothstep(4000000.0,  2500000.0, vCamDist);
        if (lodFade < 0.01) discard;

        // animated dash — long bright segments with short dim gaps
        float phase = fract(vProgress * uNumDashes - uTime * uFlowSpeed + vId);
        float dash  = smoothstep(0.0, 0.08, phase) * smoothstep(0.75, 0.65, phase);
        dash = 0.15 + 0.85 * dash;

        // fade at streamline endpoints
        float endFade = smoothstep(0.0, 0.08, vProgress) * smoothstep(1.0, 0.92, vProgress);

        // wind-speed color ramp (blue -> cyan -> green -> yellow -> red)
        float t = clamp(vSpeed / uMaxSpeed, 0.0, 1.0);
        float hue = (1.0 - t) * 0.65;
        vec3 color = hsv(hue, 0.8, 0.8 + 0.2 * t);

        // vCoverage (per-vertex, interpolated along segment) dims streamlines
        // in regions that are far from any IDW input sample. GFS / Manual
        // sources emit coverage = 1 everywhere, so those are unaffected.
        float alpha = dash * endFade * uOpacity * lodFade * vCoverage;
        if (alpha < 0.01) discard;

        gl_FragColor = vec4(color, alpha);

        // logarithmic depth (matches Sitrec convention). Orthographic projection
        // makes vDepth a constant 1.0, collapsing the log formula to one value per
        // fragment → z-fighting; use linear rasteriser depth there.
        if (vDepth == 1.0) {
            gl_FragDepthEXT = gl_FragCoord.z;
        } else {
            float z = (log2(max(nearPlane, 1.0 + vDepth)) / log2(1.0 + farPlane)) * 2.0 - 1.0;
            gl_FragDepthEXT = z * 0.5 + 0.5;
        }
    }
`;
