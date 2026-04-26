// Wind field visualization with animated streamlines on the globe.
// Uses GPU-efficient shader animation: a frame counter offsets a dash pattern
// along each streamline, creating a flowing effect without per-frame geometry updates.

import {CNode3DGroup} from "./CNode3DGroup";
import {ECEFToLLAVD_radii, LLAToECEF} from "../LLA-ECEF-ENU";
import {DebugArrowAB, DebugArrows, removeDebugArrow} from "../threeExt";
import {getLocalNorthVector, getLocalEastVector} from "../SphericalMath";
import {sharedUniforms} from "../js/map33/material/SharedUniforms";
import {FileManager, GlobalDateTimeNode, Globals, NodeMan, Sit, Units} from "../Globals";
import {mouseInView, mouseToView} from "../ViewUtils";
import pako from "pako";
import * as LAYER from "../LayerMasks";
import {
    BufferAttribute, BufferGeometry, LineSegments,
    ShaderMaterial, Vector3,
} from "three";
import {setRenderOne} from "../Globals";
import {meanSeaLevelOffset} from "../EGM96Geoid";
import {
    WIND_LEVEL_TABLE,
    bracketingLevels,
    levelToAltFeet,
    sampleJSONGrid,
    fromDirSpeedToUV,
    fromDirSpeedKnotsToUV,
    fromUVToDirKnots,
    greatCircleDistanceDeg,
} from "./WindHelpers";

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

        this.frameCount = 0;
        this.linesMesh = null;
        this.dataSource = "none";
        this.fetching = false;
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

        // Inspect mode: cursor-driven single arrow + on-screen readout
        // (heading and speed at the wind altitude under the mouse). Drives a
        // document-level mousemove listener that's installed/removed on
        // toggle so we don't pay the cost when the feature is off.
        this.inspect = false;
        this._inspectClient = null;     // {x, y} clientX/Y or null when no cursor
        this._inspectDiv = null;        // DOM readout, lazy-created
        this._inspectMouseHandler = null;

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
    sampleWind(lat, lon) {
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
                    const end = entry.start.clone().addScaledVector(entry.dir, lengthM);
                    DebugArrowAB(name, entry.start, end, "#ff66ff", true,
                        this.group, 50, LAYER.MASK_HELPERS);
                }
            }
        }
        this._updateScreenWindArrows(view);
        this._updateInspectArrow(view);
    }

    // Cast a ray from the main view's camera through the given pixel and
    // intersect with the WGS84-shaped shell at altMSL. Returns the ECEF hit
    // point or null. Shared between the screen-grid arrows and inspect mode.
    _rayHitWindShell(view, px, py, altMSL) {
        if (!view?.camera || !view.widthPx || !view.heightPx) return null;
        const a = Globals.equatorRadius + altMSL;
        const b = Globals.polarRadius + altMSL;
        const a2 = a * a, b2 = b * b;
        const cam = view.camera.position;

        const ndc = new Vector3(
            (px / view.widthPx) * 2 - 1,
            -(py / view.heightPx) * 2 + 1,
            1,
        );
        ndc.unproject(view.camera);

        let dirX = ndc.x - cam.x;
        let dirY = ndc.y - cam.y;
        let dirZ = ndc.z - cam.z;
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
        return new Vector3(cam.x + dirX * t, cam.y + dirY * t, cam.z + dirZ * t);
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
        const seen = new Set();

        if (this.showArrows && this.windU
            && view.pixelsToMeters && view.camera
            && view.widthPx > 0 && view.heightPx > 0) {

            const altMSL = this.windAltFt * 0.3048;
            const STEP = 200;
            const PX = 100;

            for (let py = STEP / 2; py < view.heightPx; py += STEP) {
                for (let px = STEP / 2; px < view.widthPx; px += STEP) {
                    const hit = this._rayHitWindShell(view, px, py, altMSL);
                    if (!hit) continue;
                    const lla = ECEFToLLAVD_radii(hit);
                    if (!Number.isFinite(lla.x) || !Number.isFinite(lla.y)) continue;

                    const w = this.sampleWind(lla.x, lla.y);
                    if (!w || !Number.isFinite(w.u) || !Number.isFinite(w.v)) continue;
                    if (Math.hypot(w.u, w.v) < 0.5) continue;  // noise floor

                    // Wind FROM → arrow TO direction.
                    const {from} = fromUVToDirKnots(w.u, w.v);
                    const bearingRad = ((from + 180) % 360) * DEG;
                    const north = getLocalNorthVector(hit);
                    const east  = getLocalEastVector(hit);
                    const dir3d = new Vector3()
                        .addScaledVector(north, Math.cos(bearingRad))
                        .addScaledVector(east,  Math.sin(bearingRad))
                        .normalize();

                    const lengthM = view.pixelsToMeters(hit, PX);
                    const end = hit.clone().addScaledVector(dir3d, lengthM);
                    const name = `windArrowGrid_${px}_${py}`;
                    DebugArrowAB(name, hit, end, "#00ffff", true,
                        this.group, 30, LAYER.MASK_MAIN);
                    seen.add(name);
                }
            }
        }

        // Drop arrows that didn't get refreshed this frame (off-screen, or
        // toggle flipped off). Cheap — usually 0 entries to remove.
        for (const name of this._screenArrowNames) {
            if (!seen.has(name)) removeDebugArrow(name);
        }
        this._screenArrowNames = seen;
    }

    // Toggle inspect mode. Installs/removes a document mousemove listener
    // and tears down the readout DOM + arrow when disabled.
    setInspect(enabled) {
        this.inspect = !!enabled;
        if (this.inspect && !this._inspectMouseHandler) {
            this._inspectMouseHandler = (e) => {
                this._inspectClient = {x: e.clientX, y: e.clientY};
                setRenderOne(true);
            };
            document.addEventListener("mousemove", this._inspectMouseHandler);
        } else if (!this.inspect && this._inspectMouseHandler) {
            document.removeEventListener("mousemove", this._inspectMouseHandler);
            this._inspectMouseHandler = null;
        }
        if (!this.inspect) {
            removeDebugArrow("windInspectArrow");
            this._inspectClient = null;
            if (this._inspectDiv) this._inspectDiv.style.display = "none";
        }
    }

    // 16-point compass direction string from a degree value (0 = N, CW).
    static _compassFromDeg(deg) {
        const points = ["N","NNE","NE","ENE","E","ESE","SE","SSE",
                        "S","SSW","SW","WSW","W","WNW","NW","NNW"];
        const idx = Math.floor(((deg % 360 + 360) % 360 + 11.25) / 22.5) % 16;
        return points[idx];
    }

    // Build (lazily) the floating readout div used by inspect mode.
    _ensureInspectDiv() {
        if (this._inspectDiv) return this._inspectDiv;
        const d = document.createElement("div");
        d.style.cssText = `
            position: fixed;
            background: rgba(0, 0, 0, 0.78);
            color: #fff;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            padding: 8px 12px;
            border: 1px solid #00ffff;
            border-radius: 4px;
            pointer-events: none;
            z-index: 10000;
            line-height: 1.25;
            white-space: nowrap;
        `;
        document.body.appendChild(d);
        this._inspectDiv = d;
        return d;
    }

    // Cursor-driven inspect arrow + readout. Same shell intersection as the
    // grid; computes wind speed in current display units and a 16-point
    // compass heading (FROM) plus exact degrees.
    _updateInspectArrow(view) {
        // Single-view feature; bail before any side effects on other views
        // so we don't churn the inspect ArrowHelper between mainView and
        // lookView passes (would crash Edge under sustained interaction).
        if (view?.id !== "mainView") return;
        if (!this.inspect || !this.windU
            || !view.pixelsToMeters || !this._inspectClient) {
            return;
        }
        // Cursor must be inside the main view to inspect.
        if (!mouseInView(view, this._inspectClient.x, this._inspectClient.y)) {
            removeDebugArrow("windInspectArrow");
            if (this._inspectDiv) this._inspectDiv.style.display = "none";
            return;
        }

        const [vx, vy] = mouseToView(view, this._inspectClient.x, this._inspectClient.y);
        const altMSL = this.windAltFt * 0.3048;
        const hit = this._rayHitWindShell(view, vx, vy, altMSL);
        if (!hit) {
            removeDebugArrow("windInspectArrow");
            if (this._inspectDiv) this._inspectDiv.style.display = "none";
            return;
        }
        const lla = ECEFToLLAVD_radii(hit);
        if (!Number.isFinite(lla.x) || !Number.isFinite(lla.y)) {
            removeDebugArrow("windInspectArrow");
            return;
        }
        const w = this.sampleWind(lla.x, lla.y);
        if (!w || !Number.isFinite(w.u) || !Number.isFinite(w.v)) {
            removeDebugArrow("windInspectArrow");
            return;
        }

        const speedMS = Math.hypot(w.u, w.v);
        // Wind FROM (where it's coming from) — what aviation reports.
        const {from} = fromUVToDirKnots(w.u, w.v);
        const compass = CNodeDisplayWindField._compassFromDeg(from);
        const speedDisp = speedMS * (Units?.m2Speed ?? 1.94384);  // m/s → display
        const speedUnit = Units?.speedUnits ?? "knots";

        // Arrow points TO (drift direction), 100 px on screen.
        const bearingRad = ((from + 180) % 360) * DEG;
        const north = getLocalNorthVector(hit);
        const east  = getLocalEastVector(hit);
        const dir3d = new Vector3()
            .addScaledVector(north, Math.cos(bearingRad))
            .addScaledVector(east,  Math.sin(bearingRad))
            .normalize();
        const lengthM = view.pixelsToMeters(hit, 100);
        const end = hit.clone().addScaledVector(dir3d, lengthM);
        DebugArrowAB("windInspectArrow", hit, end, "#ffff00", true,
            this.group, 30, LAYER.MASK_MAIN);

        // Readout, positioned next to the cursor (offset so it doesn't
        // sit under the pointer and steal hover focus).
        const div = this._ensureInspectDiv();
        div.style.display = "block";
        div.style.left = (this._inspectClient.x + 18) + "px";
        div.style.top  = (this._inspectClient.y + 18) + "px";
        div.innerHTML =
            `<div style="font-size:22px;font-weight:600">${speedDisp.toFixed(0)} ${speedUnit}</div>` +
            `<div style="font-size:13px;opacity:0.85">FROM ${compass} ${Math.round(from)}°</div>`;
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
        if (this.nearbyOnly) {
            const ref = this._referenceLatLon();
            if (ref) {
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
        this.group.add(this.linesMesh);

        const lodCounts = [0, 0, 0];
        out.lod.forEach(l => lodCounts[l]++);
        console.log(`Wind field: ${lineIndex} streamlines, ${out.pos.length / 3} verts ` +
            `(LOD0: ${lodCounts[0] / 2}, LOD1: ${lodCounts[1] / 2}, LOD2: ${lodCounts[2] / 2})`);
    }

    // True when both bracketing GFS pressure levels for `altFt` are already
    // resident (in _levelCache or in FileManager via _loadedWindFiles).
    // The altitude-slider live-update path uses this to decide whether it can
    // safely re-fetch on every drag tick without hitting the network.
    hasGFSBracketCached(altFt) {
        if (this.source !== "gfs") return false;
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

        const url = `sitrecServer/windProxy.php?date=${dateStr}&hour=${hour}&level=${level}`;
        // The proxy shells out to fetch_wind.py which pulls a GRIB2 slice from
        // NOMADS/AWS — can take 10–20s on a cold cache. 60s covers the worst
        // case without letting a stalled proxy hang the UI indefinitely.
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), 60000);
        let resp;
        try {
            resp = await fetch(url, {signal: ctrl.signal});
        } catch (e) {
            if (e.name === "AbortError") {
                throw new Error(`Timeout fetching ${level} (60s)`);
            }
            throw e;
        } finally {
            clearTimeout(to);
        }
        if (!resp.ok) throw new Error(`HTTP ${resp.status} for level ${level}`);
        const json = await resp.json();
        if (json.error) throw new Error(json.error);
        if (!json.u || !json.v) throw new Error(`Missing u/v for level ${level}`);

        this._levelCache[cacheKey] = json;
        return json;
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
            if (this.source === "gfs") {
                await this._fillFromGFS(altFt);
            } else if (this.source === "uwyo"
                    || this.source === "igra2"
                    || this.source === "manual-soundings") {
                await this._fillFromSoundings(altFt, this.source);
            } else if (this.source === "openmeteo") {
                await this._fillFromOpenMeteo(altFt);
            } else if (this.source === "manual") {
                this._fillFromManual(altFt);
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

    // ── GFS: global pressure-level grids ────────────────────────────
    async _fillFromGFS(altFt) {
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

        const blended = {
            ...jsonLo,
            u: blendedU,
            v: blendedV,
            level: `${Math.round(altFt)}ft`,
            source: jsonLo.source ?? "GFS",
            _loLevel: lo.level,
            _hiLevel: hi.level,
            _blendT: t,
        };

        this._applyWindJSON(blended);
        this.windLevel = lo.level === hi.level ? lo.level : `${lo.level}+${hi.level}`;
        this._lastDateCycle = `${dateStr}_${hour}`;
        this._storeWindFiles(jsonLo, jsonHi, needTwo, dateStr, hour);

        const altLabel = altFt < 300 ? "Surface" : `${altFt.toLocaleString()} ft`;
        this.statusText = `GFS ${jsonLo.refTime?.slice(0, 10) ?? dateStr} ${altLabel}`;
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
        const profiles = [];
        NodeMan.iterate((id, node) => {
            if (!node || node.constructor?.name !== "CNodeAtmosphericProfile") return;
            if (sourceFilter && node.source !== sourceFilter) return;
            profiles.push(node);
        });
        return profiles;
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
        if (this.source === "gfs") {
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
        const hitsNetwork = this.source === "openmeteo" || this.source === "gfs";
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
    // don't accumulate stale data across days.
    _evictAllWindGrids() {
        for (const fid of this._loadedWindFiles.keys()) {
            if (FileManager.list[fid]) delete FileManager.list[fid];
        }
        this._loadedWindFiles.clear();
        this._levelCache = {};
        this._windFileIds = [];
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
        // Only GFS writes files we can rehydrate from. Other sources are
        // recomputed on load (see modDeserialize), so skip the _storeWindFile
        // path for them — it would tag the file with the wrong source and
        // confuse a later GFS activation.
        if (this.source === "gfs"
            && this._lastWindJSON
            && (!this._windFileIds || this._windFileIds.length === 0)) {
            this._storeWindFile();
        }

        // Serialize the full catalog (level/date/hour per file id) so reload
        // restores every level we'd fetched, not just the active blend. This
        // lets altitude scrubbing skip the network entirely.
        const loadedWindFiles = this.source === "gfs"
            ? Array.from(this._loadedWindFiles.entries()).map(([fileId, meta]) => ({fileId, ...meta}))
            : [];

        return {
            ...super.modSerialize(),
            source: this.source,
            windAltFt: this.windAltFt,
            windLevel: this.windLevel,
            windFileIds: this.source === "gfs" ? (this._windFileIds ?? []) : [],
            loadedWindFiles,
            hasWindData: this.source === "gfs" && !!this._lastWindJSON,
            nearbyOnly: this.nearbyOnly,
            nearbyRadiusKm: this.nearbyRadiusKm,
            showArrows: this.showArrows,
            lastDateCycle: this._lastDateCycle,
        };
    }

    async modDeserialize(v) {
        super.modDeserialize(v);

        this.source = v.source ?? "gfs";
        this.windAltFt = v.windAltFt ?? 33;
        this.nearbyOnly = v.nearbyOnly ?? true;
        this.nearbyRadiusKm = v.nearbyRadiusKm ?? 250;
        this.showArrows = v.showArrows ?? false;
        if (v.lastDateCycle) this._lastDateCycle = v.lastDateCycle;

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

        // Non-GFS sources don't persist grids — they're recomputed on demand.
        // If the saved sitch had the wind field visible, re-fetch after the
        // rest of the sitch finishes deserializing (dependent nodes like
        // CNodeAtmosphericProfile / targetTrack may not exist yet at this
        // point in the restore pass).
        if (this.source !== "gfs") {
            this.windLevel = v.windLevel ?? `${Math.round(this.windAltFt)}ft`;
            if (this.visible) {
                this.statusText = "Reloading...";
                setTimeout(() => {
                    this.fetchWindForAltitude(this.windAltFt).catch(err => {
                        console.warn("Non-GFS wind reload failed:", err);
                    });
                }, 0);
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
                setTimeout(() => {
                    this._reloadGFSAfterDeserialize(savedLevels).catch(err => {
                        console.warn("GFS wind reload failed:", err);
                    });
                }, 0);
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
        this.statusText = `GFS ${jsons[0].refTime ?? "?"} ${altLabel}`;
        console.log("Wind data restored from saved files");
    }

    // Pre-warm every level the saved sitch had loaded, then render the
    // saved altitude from cache. Reports progress and a final summary that
    // distinguishes "all loaded", "partial — closest is X", and pure failure.
    async _reloadGFSAfterDeserialize(savedLevels) {
        const dateNow = GlobalDateTimeNode?.dateNow ?? new Date();
        const fallbackDate = dateNow.toISOString().slice(0, 10).replace(/-/g, "");
        const fallbackHour = Math.floor(dateNow.getUTCHours() / 6) * 6;

        const total = savedLevels.length;
        let loaded = 0;
        const failures = [];

        // Parallel re-fetch — windProxy serialises on its end, but firing
        // them off together hides individual round-trip latency.
        const promises = savedLevels.map(async (e) => {
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
        });
        await Promise.all(promises);

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
        this.frameCount++;
        this.material.uniforms.uTime.value = this.frameCount;

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
        // Inspect-mode tear-down: drop the listener, the floating div, and
        // the arrow so nothing leaks across sitch reloads.
        if (this._inspectMouseHandler) {
            document.removeEventListener("mousemove", this._inspectMouseHandler);
            this._inspectMouseHandler = null;
        }
        if (this._inspectDiv) {
            this._inspectDiv.remove();
            this._inspectDiv = null;
        }
        removeDebugArrow("windInspectArrow");
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
        gl_Position = projectionMatrix * mvPos;
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

        // logarithmic depth (matches Sitrec convention)
        float z = (log2(max(nearPlane, 1.0 + vDepth)) / log2(1.0 + farPlane)) * 2.0 - 1.0;
        gl_FragDepthEXT = z * 0.5 + 0.5;
    }
`;
