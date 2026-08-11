// GroundPaint.js
//
// "Paint On Ground" — a texture brush for the ground surface. The texture-space
// sibling of "Remove Geometry" (TilesTreeFlatten's manual brush): same gesture,
// same persistence model, but it paints the tile IMAGERY instead of moving or
// deleting geometry.
//
// WHAT IS STORED. Nothing is baked into any image permanently. A stroke is
// recorded as an ordered list of "dabs" — {lla, r, colour | erase} — in
// geographic coordinates, exactly like the geometry brush's dab list, and that
// list is what gets serialized with the sitch. The painted pixels are always a
// REPLAY of that list onto whatever tile textures happen to be loaded, so:
//   • tiles that stream in later get the strokes applied as they arrive,
//   • a tile that subdivides / changes zoom / re-fetches gets them re-applied to
//     its new texture at its own resolution,
//   • and the original imagery is never lost (every painted texture keeps its
//     source image, which is what "erase" paints back).
//
// TWO SURFACES. Sitrec has two unrelated textured grounds, and a dab is applied
// to both, so the paint follows whichever one is actually being rendered:
//
//   1. The basemap quadtree tiles (QuadTreeTile — ESRI, MapBox, …). Each tile is a
//      lat/lon rectangle, so a dab maps to a plain ellipse in the tile's image: a
//      circle of r metres is a circle in Web Mercator (conformal) and an ellipse
//      in the equirectangular 4326 grid, which is why the horizontal and vertical
//      pixel radii are computed separately.
//
//   2. The Google Photorealistic 3D tile textures. Those have arbitrary glTF UVs,
//      so there is no rectangle to draw into: the dab sphere has to be rasterized
//      through the mesh. For every triangle the sphere touches we clip the
//      triangle against the sphere (linear interpolation of the distance field
//      along each edge — the standard convex single-plane clip) and add the
//      resulting 3- or 4-gon to ONE path in UV space. A single fill per dab per
//      mesh then avoids the hairline seams that per-triangle fills leave along
//      shared edges from antialiased blending.
//
// STATE + IDEMPOTENCE. Painted state hangs off the objects themselves, so it dies
// with them and needs no registry (which would keep disposed textures alive):
//   • a Texture carries {canvas, ctx, orig, applied, gen} — its painting canvas,
//     the source image to erase back to, and how many dabs it has had applied,
//   • a 3D-tile Mesh carries its own applied count, because several meshes can
//     share one texture and each contributes different triangles to it.
// The dab list is append-only during a stroke, so a texture/mesh whose count is
// below the list length just needs the new tail — that is what makes the
// per-frame reapply pass cheap and safe to call repeatedly.
//
// Any change that is NOT an append (undo, redo, "Clear Paint", "Apply Paint" off,
// loading a sitch) bumps a GENERATION counter instead of trying to reach every
// painted texture. Anything stamped with an older generation is reset from its
// original image and replayed from scratch the next time the pass sees it. That
// matters because a pruned basemap tile's material survives in materialCache and
// can be handed back to a later tile — with an old generation stamp on it, so it
// gets corrected rather than resurrecting cleared paint.

import {Matrix4, Vector3} from "three";
import {saveAs} from "file-saver";
import {NodeMan, Sit, setRenderOne} from "./Globals";
import {isKeyCodeHeld} from "./KeyBoardHandler";
import {ECEFToLLAVD_radii, RLLAToECEF_radii} from "./LLA-ECEF-ENU";
import {getLocalEastVector, getLocalNorthVector} from "./SphericalMath";
import {undoManager as UndoManager} from "./UndoManager";
import {showError} from "./showError";
import {GroundPaintBrush} from "./GroundPaintBrush";
import {PAINT_TEX_STATE} from "./GroundPaintState";

const DEG2RAD = Math.PI / 180;

// Per-mesh applied-dab count + generation, for the 3D-tile path where several
// meshes can feed triangles into one shared texture.
const PAINT_MESH_COUNT = Symbol("groundPaint_meshCount");
const PAINT_MESH_GEN = Symbol("groundPaint_meshGen");

// Header written into (and required by) the Export/Import JSON files.
const GROUND_PAINT_FILE_TYPE = "sitrec-ground-paint";

// A dab whose footprint is smaller than this many pixels on a given tile is
// skipped for that tile: invisible, but on coarse ancestor tiles a whole stroke
// would otherwise pile up into a speck of noise.
const MIN_DAB_PIXELS = 0.35;

// How many textures (basemap tiles / 3D-tile meshes) may be brought up to date per
// reapply pass, so a big backlog spreads over frames instead of stalling one.
const REAPPLY_BUDGET = 8;

// Ceiling on the dabs one shift-click line may generate. Refused rather than
// silently truncated or thinned — the guard exists because a shift-click after
// panning to another continent would otherwise ask for millions of dabs and wedge
// the browser. At 0.4 * radius spacing this allows a line ~800x the brush radius.
const MAX_LINE_DABS = 2000;

const _gpInv = new Matrix4();
const _gpLocal = new Vector3();
const _gpSphere = new Vector3();
const _gpEast = new Vector3();
const _gpNorth = new Vector3();
const _gpProbe = new Vector3();

// Plane-space polygon clip scratch. A triangle clipped by DISC_SIDES half-planes
// can gain at most one vertex per plane, so 3 + DISC_SIDES is the true bound.
const DISC_SIDES = 16;
const POLY_CAP = 3 + DISC_SIDES + 2;
const _polyX = new Float64Array(POLY_CAP);
const _polyY = new Float64Array(POLY_CAP);
const _tmpX = new Float64Array(POLY_CAP);
const _tmpY = new Float64Array(POLY_CAP);
// Outward normals of the tangent half-planes approximating the disc.
const _discCos = new Float64Array(DISC_SIDES);
const _discSin = new Float64Array(DISC_SIDES);
for (let i = 0; i < DISC_SIDES; i++) {
    const a = (i + 0.5) * 2 * Math.PI / DISC_SIDES;
    _discCos[i] = Math.cos(a);
    _discSin[i] = Math.sin(a);
}

// ---------------------------------------------------------------------------
// Parameter definitions — single source of truth shared by the painter and the
// GUI builder in CNodeTerrainUI, mirroring TREE_FLATTEN_DEFS.
// ---------------------------------------------------------------------------
export const GROUND_PAINT_DEFS = [
    {key: "paintMode", type: "bool", default: false,
        label: "Paint Mode", tooltip: "Paint the colour below onto the ground textures. While on, left-click-dragging over the terrain or the 3D tiles paints under the brush; a ring shows the footprint. SHIFT-CLICK draws a straight line from wherever you last painted — the end of your last drag, or your last click — so shift-clicks chain into a polyline and continue on from a freehand stroke. [ and ] shrink and grow the brush. Strokes are undoable (Ctrl/Cmd+Z). Hold Option/Alt while painting to ERASE back to the original imagery"},
    {key: "brushRadius", type: "num", default: 8, min: 0.5, max: 200, step: 0.5,
        label: "Brush Radius (m)", tooltip: "World-space radius of the paint brush, in metres. Held in metres (not pixels) so a stroke covers the same ground however far the tiles later subdivide. [ and ] adjust it while Paint Mode is on"},
    {key: "color", type: "color", default: 0x6b7a52,
        label: "Paint Color", tooltip: "Colour applied by the brush. Stored per dab, so changing it does not restyle strokes already painted"},
    {key: "applyPaint", type: "bool", default: true,
        label: "Apply Paint", tooltip: "Re-apply the saved paint to tiles as they load (persists with Paint Mode off). Turn off to temporarily see the original imagery without discarding the strokes"},
];

export function makeDefaultGroundPaintParams() {
    const p = {};
    for (const def of GROUND_PAINT_DEFS) p[def.key] = def.default;
    // Ordered dab list: [{lla:[lat,lon,alt], r, c?:0xRRGGBB, e?:1}, ...]
    p.dabs = [];
    return p;
}

// Read the colour map out of a material, covering both the plain-material case
// (`.map`) and Sitrec's terrain ShaderMaterial (`uniforms.map.value`), plus
// multi-material meshes. Deliberately not threeExt's Material.getMap(): importing
// threeExt pulls in three/addons, which breaks any Jest test that reaches this file.
function materialMap(material) {
    if (!material) return null;
    const m = Array.isArray(material) ? material[0] : material;
    return m?.uniforms?.map?.value ?? m?.map ?? null;
}

function colorToCSS(c) {
    return "#" + ((c ?? 0) & 0xffffff).toString(16).padStart(6, "0");
}

export class CGroundPainter {
    /** @param {Object} terrainUI the CNodeTerrainUI that owns groundPaintParams */
    constructor(terrainUI) {
        this.ui = terrainUI;
        // Bumped on any non-append change; see the file header.
        this.generation = 1;
        // World-space form of the dab list, rebuilt when the list changes.
        this._dabsWorld = [];
        this._lastDab = null;
        // True once anything has been painted this session. Lets the per-frame pass
        // exit immediately in the overwhelmingly common case of a sitch with no
        // paint at all, without touching a single tile.
        this._anyPainted = false;
        this.brush = new GroundPaintBrush(this);
        this.rebuildDabsWorld();
    }

    get params() {
        return this.ui.groundPaintParams;
    }

    get dabs() {
        return this.params.dabs;
    }

    // How many dabs SHOULD be applied right now. "Apply Paint" off means zero, so
    // the ordinary stale-state path restores the original imagery for free.
    _targetCount() {
        return this.params.applyPaint === false ? 0 : this.dabs.length;
    }

    // Rebuild the world-space dab cache from the serialized lat/lon/alt list.
    // Called on construction, after deserialize, and after undo/redo.
    //
    // dLat/dLon are the brush radius expressed in DEGREES at this dab's position,
    // measured through the real ellipsoid (step r metres along the local east /
    // north vectors and convert back). Done once per dab here rather than per tile,
    // and exactly rather than with a metres-per-degree constant.
    rebuildDabsWorld() {
        const dabs = this.dabs;
        this._dabsWorld = dabs.map(d => {
            const lat = d.lla[0], lon = d.lla[1];
            const center = RLLAToECEF_radii(lat * DEG2RAD, lon * DEG2RAD, d.lla[2]);
            _gpEast.copy(getLocalEastVector(center));
            _gpNorth.copy(getLocalNorthVector(center));
            const east = ECEFToLLAVD_radii(_gpProbe.copy(center).addScaledVector(_gpEast, d.r));
            const north = ECEFToLLAVD_radii(_gpProbe.copy(center).addScaledVector(_gpNorth, d.r));
            return {
                center,
                lat, lon,
                r: d.r,
                dLon: Math.abs(east.y - lon),
                dLat: Math.abs(north.x - lat),
                erase: !!d.e,
                css: colorToCSS(d.c),
            };
        });
        this._lastDab = this._dabsWorld.length ? this._dabsWorld[this._dabsWorld.length - 1] : null;
    }

    // Record a brush dab and apply it to everything currently loaded.
    applyBrush(worldCenter, radius, erase) {
        if (!this._pushDab(worldCenter, radius, erase)) return 0;
        // Apply now for immediate feedback. Idempotent via the applied-count stamps,
        // so the per-frame pass won't double-apply.
        const painted = this.reapplyAll(Infinity);
        setRenderOne(true);
        return painted;
    }

    // Shift-click line: lay a run of dabs from `startWorld` to `endWorld`, so a
    // shift-click continues from the previous click in a straight line.
    //
    // The line is EXPANDED INTO ORDINARY DABS rather than stored as a segment
    // record. A segment would be more compact, but it would need its own rasterizer
    // in both painters — a capsule-plane intersection is a stadium, not the disc the
    // 3D-tile path clips against — and this way the line serializes, erases, undoes
    // and replays through exactly the same code as every other dab, with no new
    // geometry to get wrong.
    //
    // Interpolated in LAT/LON/ALT, not by lerping the ECEF endpoints: a straight
    // chord through the earth sags below the surface (~2 m over 10 km, ~49 m over
    // 50 km), which would drop the 3D-tile spheres under the ground they are meant
    // to paint. Each step's altitude is then snapped to the terrain, so a line
    // crossing a valley follows it instead of flying over it.
    applyBrushLine(startWorld, endWorld, radius, erase) {
        const dist = startWorld.distanceTo(endWorld);
        const spacing = Math.max(0.05, radius * 0.4);   // > the 0.3r dedupe gate
        const steps = Math.ceil(dist / spacing);
        if (steps > MAX_LINE_DABS) {
            showError(`That shift-click line is too long for a ${radius} m brush ` +
                `(${Math.round(dist)} m needs ${steps} dabs, limit ${MAX_LINE_DABS}). ` +
                `Use a bigger Brush Radius, or paint it in shorter runs.`);
            return 0;
        }
        if (steps < 1) return this.applyBrush(endWorld, radius, erase);

        const a = ECEFToLLAVD_radii(startWorld);
        const b = ECEFToLLAVD_radii(endWorld);
        // Longitude difference taken the SHORT way round. Straight subtraction turns a
        // 20 km line across the antimeridian (179.9 -> -179.9) into a 359.8-degree trip
        // the other way around the planet — and because `steps` came from the true
        // (short) ECEF distance, the dabs would be smeared into a sparse dotted ring
        // round the world instead of the local line asked for.
        let deltaLon = b.y - a.y;
        if (deltaLon > 180) deltaLon -= 360;
        else if (deltaLon < -180) deltaLon += 360;

        const terrain = NodeMan.get("TerrainModel", false);
        let added = 0;
        // From i=1: the previous click already painted the start.
        for (let i = 1; i <= steps; i++) {
            const t = i / steps;
            const lat = a.x + (b.x - a.x) * t;
            // May land outside [-180,180] one step past the antimeridian; harmless,
            // because RLLAToECEF_radii is periodic in longitude and _pushDab derives
            // the STORED lat/lon back from the resulting ECEF point, which normalises
            // it via atan2.
            const lon = a.y + deltaLon * t;
            const alt = a.z + (b.z - a.z) * t;
            let p = RLLAToECEF_radii(lat * DEG2RAD, lon * DEG2RAD, alt);
            // Snap to the ground. getPointBelow's default path is an elevation-map
            // lookup, not a mesh raycast — cheap enough to do per step, and its
            // few-metre error is well inside the brush radius.
            if (terrain?.getPointBelow) {
                const g = terrain.getPointBelow(p);
                if (g) p = g;
            }
            if (this._pushDab(p, radius, erase)) added++;
        }
        if (added === 0) return 0;
        const painted = this.reapplyAll(Infinity);
        setRenderOne(true);
        return painted;
    }

    // Append one dab to the list + world cache. Returns false when it was deduped
    // against the previous dab, so a drag doesn't store hundreds of near-identical
    // circles; 0.3 * radius spacing still leaves a smooth continuous stroke. Split
    // out of applyBrush so a shift-line can append many dabs and then replay ONCE
    // instead of re-running the whole reapply pass per dab.
    _pushDab(worldCenter, radius, erase) {
        const last = this._lastDab;
        const color = this.params.color & 0xffffff;
        if (last && last.erase === !!erase && last.r === radius
            && (erase || last.css === colorToCSS(color))
            && last.center.distanceTo(worldCenter) < radius * 0.3) {
            return false; // too close to the previous dab — skip
        }
        const lla = ECEFToLLAVD_radii(worldCenter);
        const dab = {
            lla: [+lla.x.toFixed(7), +lla.y.toFixed(7), +lla.z.toFixed(2)],
            r: radius,
        };
        if (erase) dab.e = 1; else dab.c = color;
        this.dabs.push(dab);
        // Mirror the entry into the world cache rather than rebuilding the lot.
        const center = worldCenter.clone();
        _gpEast.copy(getLocalEastVector(center));
        _gpNorth.copy(getLocalNorthVector(center));
        const east = ECEFToLLAVD_radii(_gpProbe.copy(center).addScaledVector(_gpEast, radius));
        const north = ECEFToLLAVD_radii(_gpProbe.copy(center).addScaledVector(_gpNorth, radius));
        const entry = {
            center,
            lat: lla.x, lon: lla.y,
            r: radius,
            dLon: Math.abs(east.y - lla.y),
            dLat: Math.abs(north.x - lla.x),
            erase: !!erase,
            css: colorToCSS(color),
        };
        this._dabsWorld.push(entry);
        this._lastDab = entry;
        return true;
    }

    // Per-frame pass: bring newly-streamed tiles up to date with the dab list.
    // Free when there is no paint in the sitch and none has ever been applied.
    update() {
        this.handleBrushSizeKeys();
        if (this.brush) this.brush.refreshPreview();
        if (this.dabs.length === 0 && !this._anyPainted) return;
        this.reapplyAll(REAPPLY_BUDGET);
    }

    // [ and ] shrink / grow the brush, the same keys and the same polled, repeat-
    // delayed shape as the video mask brush (CNodeMaskOverlay.handleBrushSizeKeys).
    // Only while Paint Mode is on, so the keys stay free for everything else.
    //
    // The step is PROPORTIONAL rather than the mask's sqrt curve: this radius is in
    // metres over 0.5..200, so a fixed step either crawls at the top of the range or
    // overshoots the bottom. 15% per press crosses the whole range in ~40 presses at
    // any size. Bounds come from the GUI definition, so the keys can never drive the
    // value off the end of its own slider.
    handleBrushSizeKeys() {
        if (!this.params.paintMode) return;
        const left = isKeyCodeHeld("BracketLeft");
        const right = isKeyCodeHeld("BracketRight");
        if (!left && !right) return;
        const now = performance.now();
        if (now - (this._lastBrushKeyMs ?? 0) < 50) return;

        const def = GROUND_PAINT_DEFS.find(d => d.key === "brushRadius");
        const radius = this.params.brushRadius;
        const step = Math.max(def?.step ?? 0.5, radius * 0.15);
        let next = radius + (right ? step : 0) - (left ? step : 0);
        next = Math.min(def?.max ?? 200, Math.max(def?.min ?? 0.5, next));
        // Keep it on the slider's own increments so the readout stays tidy.
        const grain = def?.step ?? 0.5;
        next = Math.round(next / grain) * grain;
        if (next === radius) return;

        this.params.brushRadius = next;
        this._lastBrushKeyMs = now;
        setRenderOne(true);
    }

    // Apply the outstanding tail of the dab list to both ground surfaces.
    // `budget` bounds how many textures are brought up to date this call.
    reapplyAll(budget = REAPPLY_BUDGET) {
        let painted = 0;
        painted += this._paintBasemapTiles(budget);
        painted += this._paint3DTiles(budget);
        return painted;
    }

    // --- persistence-facing operations -------------------------------------

    // Anything that is not an append: bump the generation so every painted
    // texture/mesh is reset from its original and replayed from scratch.
    _invalidate() {
        this.generation++;
        // Replay immediately (unbudgeted) so the change is visible at once rather
        // than trickling in over the next frames.
        this.reapplyAll(Infinity);
        setRenderOne(true);
    }

    // "Clear Paint" — drop every stroke and restore the original imagery.
    clearAllPaint() {
        if (this.brush) { this.brush.hidePreview(); this.brush.resetPaintAnchor(); }
        this.dabs.length = 0;
        this._dabsWorld = [];
        this._lastDab = null;
        this._invalidate();
    }

    // "Apply Paint" toggled.
    setApplyPaint(on) {
        this.params.applyPaint = on;
        this._invalidate();
    }

    // "Paint Mode" toggled. The brush reads the flag live, so just tidy up.
    setPaintMode(on) {
        this.params.paintMode = on;
        if (!on && this.brush) this.brush.hidePreview();
        setRenderOne(true);
    }

    // --- undo/redo ---------------------------------------------------------
    // Same shape as the geometry brush: the dab list is append-only and applied
    // idempotently, so there is no "remove the last dab" — moving to any earlier or
    // later state means resetting the textures and replaying the chosen list. A
    // whole gesture (which may append many dabs) collapses into one undo entry.

    snapshotDabs() {
        return this.dabs.map(d => ({...d, lla: [...d.lla]}));
    }

    restoreDabsState(snapshot) {
        if (this.brush) { this.brush.hidePreview(); this.brush.resetPaintAnchor(); }
        this.params.dabs = snapshot.map(d => ({...d, lla: [...d.lla]}));
        this.rebuildDabsWorld();
        this._invalidate();
    }

    commitStrokeUndo(before) {
        const after = this.snapshotDabs();
        if (after.length === before.length) return;
        UndoManager.add({
            description: "Paint On Ground brush stroke",
            undo: () => this.restoreDabsState(before),
            redo: () => this.restoreDabsState(after),
        });
    }

    // --- JSON interchange --------------------------------------------------
    // The dab list is already the complete, resolution-independent description of
    // the paint (that is what the sitch serializes), so the interchange file is
    // just that list plus enough header to recognise and version it. Geographic
    // coordinates mean a file can be moved between sitches of the same place, and
    // survives any change of map source, zoom or tile scheme.

    exportJSON() {
        const json = {
            type: GROUND_PAINT_FILE_TYPE,
            version: 1,
            sitch: Sit?.name ?? "",
            dabs: this.snapshotDabs(),
        };
        const name = `${Sit?.name ?? "sitrec"}-groundpaint.json`;
        saveAs(new Blob([JSON.stringify(json, null, 2)], {type: "application/json"}), name);
        console.log(`Exported ${json.dabs.length} ground-paint dabs to ${name}`);
        return json;
    }

    // Open a file picker and load the chosen file. Self-contained rather than
    // routed through the FileManager: the strokes belong to the terrain UI's own
    // serialized state, so the file itself must NOT become part of the sitch (it
    // would re-import and double up on every reload).
    importJSONPrompted() {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".json,application/json";
        input.style.display = "none";
        input.addEventListener("change", (event) => {
            const file = event.target.files && event.target.files[0];
            input.remove();
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                let json;
                try {
                    json = JSON.parse(reader.result);
                } catch (e) {
                    showError(`Can't import "${file.name}": it is not valid JSON`);
                    return;
                }
                this.importJSON(file.name, json);
            };
            reader.onerror = () => showError(`Can't read "${file.name}"`);
            reader.readAsText(file);
        });
        document.body.appendChild(input);
        input.click();
    }

    // Replace the current strokes with the file's. Undoable as a single step, so an
    // import over work in progress is recoverable. Everything is validated BEFORE
    // anything is replaced, so a bad file leaves the current paint untouched.
    importJSON(filename, json) {
        const problem = validateGroundPaintJSON(json);
        if (problem) {
            showError(`Can't import ground paint from "${filename}": ${problem}`);
            return false;
        }
        const dabs = json.dabs.map(d => ({
            lla: [d.lla[0], d.lla[1], d.lla[2]],
            r: d.r,
            ...(d.e ? {e: 1} : {}),
            ...(d.e ? {} : {c: (d.c ?? 0) & 0xffffff}),
        }));
        const before = this.snapshotDabs();
        // Imported paint the user cannot see reads as a failed import, so make sure
        // "Apply Paint" is on. The GUI controls all .listen(), so the checkbox
        // follows. Set BEFORE the replay so it takes one invalidate, not two, and
        // recorded in the undo entry or an undo would leave it flipped.
        const applyBefore = this.params.applyPaint;
        if (dabs.length > 0 && applyBefore === false) this.params.applyPaint = true;
        this.restoreDabsState(dabs);
        UndoManager.add({
            description: "Import ground paint",
            undo: () => { this.params.applyPaint = applyBefore; this.restoreDabsState(before); },
            redo: () => { this.params.applyPaint = true; this.restoreDabsState(dabs); },
        });
        console.log(`Imported ${dabs.length} ground-paint dabs from ${filename}`);
        return true;
    }

    // --- basemap quadtree tiles -------------------------------------------

    _paintBasemapTiles(budget) {
        const map = this.ui.terrainNode?.maps?.[this.ui.mapType]?.map;
        const proj = map?.options?.mapProjection;
        if (!map || !proj || typeof map.forEachTile !== "function") return 0;

        const dabs = this._dabsWorld;
        const n = this._targetCount();
        const gen = this.generation;
        let painted = 0;

        map.forEachTile(tile => {
            if (budget <= 0 || !tile || !tile.mesh) return;
            // Static textures (one image shared by EVERY tile of the layer) must
            // never be painted — a single dab would appear on the whole planet.
            if (tile.materialCacheKey && tile.materialCacheKey.startsWith("static_")) return;
            const tex = materialMap(tile.mesh.material);
            if (!tex) return; // placeholder / wireframe material: nothing to paint

            let state = tex[PAINT_TEX_STATE];
            if (!state) {
                if (n === 0) return;
                // Lightweight stamp first; the canvas is only allocated if a dab
                // actually lands on this tile.
                state = tex[PAINT_TEX_STATE] = {canvas: null, ctx: null, orig: null, applied: 0, gen, dead: false};
            }
            if (state.gen !== gen) this._resetTexState(tex, state, gen, n);
            if (state.dead || state.applied >= n) return;

            const from = state.applied;
            state.applied = n;
            let drew = false;
            for (let i = from; i < n; i++) {
                const dab = dabs[i];
                // Fractional tile coordinates of the dab centre and its radius.
                const fx = proj.lon2Tile(dab.lon, tile.z) - tile.x;
                const fy = proj.lat2Tile(dab.lat, tile.z) - tile.y;
                const rfx = Math.abs(proj.lon2Tile(dab.lon + dab.dLon, tile.z) - proj.lon2Tile(dab.lon, tile.z));
                const rfy = Math.abs(proj.lat2Tile(clampLat(dab.lat + dab.dLat), tile.z) - proj.lat2Tile(dab.lat, tile.z));
                if (fx < -rfx || fx > 1 + rfx || fy < -rfy || fy > 1 + rfy) continue;

                // Size the footprint BEFORE allocating anything: the quadtree keeps
                // ancestor tiles at every zoom, and on a continent-scale ancestor a
                // metre-scale dab is far below a pixel. Allocating a canvas per
                // ancestor just to draw nothing is the bulk of the wasted memory.
                const src = state.canvas ?? tex.image;
                if (!src || !src.width || !src.height) { state.dead = true; return; }
                const w = src.width, h = src.height;
                const rx = rfx * w, ry = rfy * h;
                if (rx < MIN_DAB_PIXELS && ry < MIN_DAB_PIXELS) continue;
                if (!state.canvas && !this._initTexCanvas(tex, state)) return; // unusable image

                const ctx = state.ctx;
                ctx.beginPath();
                ctx.ellipse(fx * w, fy * h, Math.max(rx, 0.1), Math.max(ry, 0.1), 0, 0, Math.PI * 2);
                if (dab.erase) {
                    ctx.save();
                    ctx.clip();
                    ctx.drawImage(state.orig, 0, 0, w, h);
                    ctx.restore();
                } else {
                    ctx.fillStyle = dab.css;
                    ctx.fill();
                }
                drew = true;
            }
            if (drew) {
                tex.needsUpdate = true;
                this._anyPainted = true;
                painted++;
                budget--;
            }
        });
        return painted;
    }

    // --- Google Photorealistic 3D tiles -----------------------------------

    _paint3DTiles(budget) {
        const buildings = this.ui.buildingsNode;
        if (!buildings || typeof buildings.forEachLoadedTileMesh !== "function") return 0;

        const dabs = this._dabsWorld;
        const n = this._targetCount();
        const gen = this.generation;
        let painted = 0;

        buildings.forEachLoadedTileMesh((mesh) => {
            if (budget <= 0) return;
            const geo = mesh.geometry;
            if (!geo?.attributes?.position || !geo.attributes.uv) return;
            const tex = materialMap(mesh.material);
            if (!tex) return;

            let state = tex[PAINT_TEX_STATE];
            if (!state) {
                if (n === 0) return;
                state = tex[PAINT_TEX_STATE] = {canvas: null, ctx: null, orig: null, applied: 0, gen, dead: false};
            }
            if (state.gen !== gen) this._resetTexState(tex, state, gen, n);
            if (state.dead) return;

            // The applied count lives on the MESH here: several meshes can paint
            // into one shared tile texture, each contributing its own triangles.
            if (mesh[PAINT_MESH_GEN] !== gen) {
                mesh[PAINT_MESH_COUNT] = 0;
                mesh[PAINT_MESH_GEN] = gen;
            }
            const from = mesh[PAINT_MESH_COUNT] || 0;
            if (from >= n) return;
            mesh[PAINT_MESH_COUNT] = n;

            // World bounding sphere, for the per-dab reject.
            mesh.updateWorldMatrix(true, false);
            geo.boundingSphere || geo.computeBoundingSphere();
            const me = mesh.matrixWorld.elements;
            const scale = Math.hypot(me[0], me[1], me[2]) || 1;
            _gpSphere.copy(geo.boundingSphere.center).applyMatrix4(mesh.matrixWorld);
            const meshR = geo.boundingSphere.radius * scale;

            let drew = false;
            for (let i = from; i < n; i++) {
                const dab = dabs[i];
                if (_gpSphere.distanceTo(dab.center) > meshR + dab.r) continue;
                if (!state.canvas && !this._initTexCanvas(tex, state)) return;
                if (this._paintMeshDab(mesh, tex, state, dab, scale)) drew = true;
            }
            if (drew) {
                tex.needsUpdate = true;
                this._anyPainted = true;
                painted++;
                budget--;
            }
        });
        return painted;
    }

    // Rasterize one dab through one mesh into its texture canvas. Every triangle the
    // dab sphere touches contributes its sphere-clipped part to ONE path in UV
    // space; a single fill (or a single clipped redraw of the original, when
    // erasing) then covers the whole footprint without the hairline seams that
    // per-triangle fills leave along shared edges.
    //
    // The clip is done PER TRIANGLE PLANE, not by interpolating the sphere's
    // distance field along the edges, because photogrammetry meshes are adaptive:
    // flat ground is a handful of huge triangles while a building is dense, and
    // distance is nowhere near linear along a 50 m edge. Intersecting the sphere
    // with the triangle's plane gives a true disc of radius sqrt(r^2 - d^2) about
    // the projected centre, and clipping the triangle against that disc is correct
    // whatever the triangle's size — including the case that a distance-field clip
    // gets flatly wrong: a brush landing wholly INSIDE one big triangle, where no
    // vertex is inside the sphere at all.
    _paintMeshDab(mesh, tex, state, dab, scale) {
        const geo = mesh.geometry;
        const pos = geo.attributes.position.array;
        const uv = geo.attributes.uv.array;
        const index = geo.index ? geo.index.array : null;
        const triCount = index ? (index.length / 3) | 0 : (geo.attributes.position.count / 3) | 0;

        _gpInv.copy(mesh.matrixWorld).invert();
        _gpLocal.copy(dab.center).applyMatrix4(_gpInv);
        const r = dab.r / scale;
        const r2 = r * r;
        const cx = _gpLocal.x, cy = _gpLocal.y, cz = _gpLocal.z;
        // AABB of the dab, for the cheap per-triangle reject.
        const bxMin = cx - r, bxMax = cx + r;
        const byMin = cy - r, byMax = cy + r;
        const bzMin = cz - r, bzMax = cz + r;

        const w = state.canvas.width, h = state.canvas.height;
        // glTF textures come in with flipY=false (UV origin top-left); Sitrec's own
        // canvas/image textures keep three's flipY=true default (origin bottom-left).
        const flip = tex.flipY;
        const ctx = state.ctx;
        ctx.beginPath();
        let any = false;

        for (let t = 0; t < triCount; t++) {
            const i0 = index ? index[t * 3] : t * 3;
            const i1 = index ? index[t * 3 + 1] : t * 3 + 1;
            const i2 = index ? index[t * 3 + 2] : t * 3 + 2;

            const ax = pos[i0 * 3], ay = pos[i0 * 3 + 1], az = pos[i0 * 3 + 2];
            const bx = pos[i1 * 3], by = pos[i1 * 3 + 1], bz = pos[i1 * 3 + 2];
            const ccx = pos[i2 * 3], ccy = pos[i2 * 3 + 1], ccz = pos[i2 * 3 + 2];

            // Cheap conservative reject: triangle AABB vs dab AABB.
            if (Math.min(ax, bx, ccx) > bxMax || Math.max(ax, bx, ccx) < bxMin) continue;
            if (Math.min(ay, by, ccy) > byMax || Math.max(ay, by, ccy) < byMin) continue;
            if (Math.min(az, bz, ccz) > bzMax || Math.max(az, bz, ccz) < bzMin) continue;

            const u0 = uv[i0 * 2], v0 = uv[i0 * 2 + 1];
            const u1 = uv[i1 * 2], v1 = uv[i1 * 2 + 1];
            const u2 = uv[i2 * 2], v2 = uv[i2 * 2 + 1];

            // Fast path — the whole triangle is inside the sphere, which is what a
            // dense mesh under a metre-scale brush mostly looks like. Emit its UVs
            // verbatim; no plane maths, no clipping.
            const d0 = sq(ax - cx) + sq(ay - cy) + sq(az - cz);
            const d1 = sq(bx - cx) + sq(by - cy) + sq(bz - cz);
            const d2 = sq(ccx - cx) + sq(ccy - cy) + sq(ccz - cz);
            if (d0 <= r2 && d1 <= r2 && d2 <= r2) {
                emitUV(ctx, u0, v0, u1, v1, u2, v2, w, h, flip);
                any = true;
                continue;
            }

            // Build a 2D orthonormal frame in the triangle's plane, origin at a:
            // e1 along a->b, n the face normal, e2 = n x e1.
            const abx = bx - ax, aby = by - ay, abz = bz - az;
            const acx = ccx - ax, acy = ccy - ay, acz = ccz - az;
            const abLen = Math.sqrt(abx * abx + aby * aby + abz * abz);
            if (abLen < 1e-9) continue;
            const e1x = abx / abLen, e1y = aby / abLen, e1z = abz / abLen;
            let nx = aby * acz - abz * acy;
            let ny = abz * acx - abx * acz;
            let nz = abx * acy - aby * acx;
            const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz);
            if (nLen < 1e-12) continue; // degenerate (collinear) triangle
            nx /= nLen; ny /= nLen; nz /= nLen;
            const e2x = ny * e1z - nz * e1y;
            const e2y = nz * e1x - nx * e1z;
            const e2z = nx * e1y - ny * e1x;

            // Triangle in plane coordinates: a=(0,0), b=(abLen,0), c=(cu,cv).
            const c2u = acx * e1x + acy * e1y + acz * e1z;
            const c2v = acx * e2x + acy * e2y + acz * e2z;
            if (Math.abs(c2v) < 1e-12) continue; // zero-area in plane

            // Dab centre projected into the plane, and the radius of the circle the
            // sphere cuts out of it.
            const cpx = cx - ax, cpy = cy - ay, cpz = cz - az;
            const dPlane = cpx * nx + cpy * ny + cpz * nz;
            if (dPlane * dPlane >= r2) continue; // sphere misses the plane entirely
            const rDisc = Math.sqrt(r2 - dPlane * dPlane);
            const pu = cpx * e1x + cpy * e1y + cpz * e1z;
            const pv = cpx * e2x + cpy * e2y + cpz * e2z;

            _polyX[0] = 0; _polyY[0] = 0;
            _polyX[1] = abLen; _polyY[1] = 0;
            _polyX[2] = c2u; _polyY[2] = c2v;
            const count = clipPolyDisc(3, pu, pv, rDisc);
            if (count < 3) continue; // disc lies outside this triangle

            // Back to UV: a plane point is a + u*(b-a) + v*(c-a), and in plane
            // coordinates b-a is (abLen,0) and c-a is (c2u,c2v), so the barycentric
            // weights fall straight out.
            for (let k = 0; k < count; k++) {
                const vv = _polyY[k] / c2v;
                const uu = (_polyX[k] - vv * c2u) / abLen;
                const tu = u0 + uu * (u1 - u0) + vv * (u2 - u0);
                const tv = v0 + uu * (v1 - v0) + vv * (v2 - v0);
                const px = tu * w;
                const py = (flip ? 1 - tv : tv) * h;
                if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
            }
            ctx.closePath();
            any = true;
        }

        if (!any) return false;
        if (dab.erase) {
            ctx.save();
            ctx.clip();
            ctx.drawImage(state.orig, 0, 0, w, h);
            ctx.restore();
        } else {
            ctx.fillStyle = dab.css;
            ctx.fill();
        }
        return true;
    }

    // --- per-texture canvas plumbing --------------------------------------

    // Swap a texture's image for a canvas copy of it, keeping the source image as
    // the "original" that erase paints back. Mutating texture.image in place (rather
    // than building a replacement texture and re-pointing every material at it)
    // keeps the material graph and the material cache untouched.
    //
    // Returns false — and marks the state dead so we stop retrying — when the image
    // is unusable. The taint probe matters: uploading a cross-origin-tainted canvas
    // to WebGL throws a SecurityError inside the renderer, where we could not catch
    // it. Sitrec's tile imagery and the 3D-tile textures both arrive via fetch →
    // blob → same-origin object URL, so this should never trigger; it is here so a
    // future source that doesn't can only lose its paint, not break rendering.
    _initTexCanvas(tex, state) {
        const img = tex.image;
        if (!img || !img.width || !img.height) { state.dead = true; return false; }
        try {
            const canvas = document.createElement("canvas");
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            ctx.getImageData(0, 0, 1, 1); // throws if the canvas is tainted
            state.orig = img;
            state.canvas = canvas;
            state.ctx = ctx;
            tex.image = canvas;
            tex.needsUpdate = true;
            return true;
        } catch (e) {
            state.dead = true;
            return false;
        }
    }

    // Bring a stale-generation texture back to a clean slate. With no paint left to
    // apply we hand the original image back and drop the canvas entirely, so
    // "Clear Paint" leaves the tile exactly as it was found.
    _resetTexState(tex, state, gen, targetCount) {
        if (state.canvas) {
            if (targetCount === 0) {
                tex.image = state.orig;
                state.canvas = null;
                state.ctx = null;
                state.orig = null;
            } else {
                state.ctx.drawImage(state.orig, 0, 0, state.canvas.width, state.canvas.height);
            }
            tex.needsUpdate = true;
        }
        state.applied = 0;
        state.gen = gen;
    }

    dispose() {
        if (this.brush) {
            this.brush.dispose();
            this.brush = null;
        }
        this.ui = null;
    }
}

function clampLat(lat) {
    return Math.max(-89.9999, Math.min(89.9999, lat));
}

// Validate an imported ground-paint file. Returns a human-readable reason string,
// or null when the file is usable. Deliberately strict about the numbers: a dab
// with a NaN coordinate or radius would produce a non-finite ellipse and poison
// every tile's canvas, which is far harder to diagnose than a rejected import.
export function validateGroundPaintJSON(json) {
    if (!json || typeof json !== "object") return "not a JSON object";
    if (json.type !== GROUND_PAINT_FILE_TYPE) {
        return `not a ground-paint file (expected type "${GROUND_PAINT_FILE_TYPE}")`;
    }
    if (!Array.isArray(json.dabs)) return "no dabs array";
    for (let i = 0; i < json.dabs.length; i++) {
        const d = json.dabs[i];
        if (!d || typeof d !== "object") return `dab ${i} is not an object`;
        if (!Array.isArray(d.lla) || d.lla.length < 3) return `dab ${i} has no [lat,lon,alt]`;
        if (!d.lla.every(Number.isFinite)) return `dab ${i} has a non-finite coordinate`;
        if (d.lla[0] < -90 || d.lla[0] > 90) return `dab ${i} has latitude out of range`;
        if (!Number.isFinite(d.r) || d.r <= 0) return `dab ${i} has an invalid radius`;
    }
    return null;
}

function sq(x) {
    return x * x;
}

// Add a whole triangle's UV triangle to the current path, in pixels.
function emitUV(ctx, u0, v0, u1, v1, u2, v2, w, h, flip) {
    ctx.moveTo(u0 * w, (flip ? 1 - v0 : v0) * h);
    ctx.lineTo(u1 * w, (flip ? 1 - v1 : v1) * h);
    ctx.lineTo(u2 * w, (flip ? 1 - v2 : v2) * h);
    ctx.closePath();
}

// Clip the convex polygon in _polyX/_polyY (n vertices, plane coordinates) against
// the disc of radius r about (cx,cy), approximated by DISC_SIDES tangent
// half-planes. Result is left in _polyX/_polyY; returns the new vertex count.
//
// A polygon whose edges are tangent to the circle CIRCUMSCRIBES it, so the
// footprint is ~1.3% larger in area than a true circle at 16 sides — invisible for
// a paint brush, and far cheaper than a per-pixel test.
function clipPolyDisc(n, cx, cy, r) {
    for (let s = 0; s < DISC_SIDES; s++) {
        if (n < 3) return 0;
        const dx = _discCos[s], dy = _discSin[s];
        // Keep points with (p - c) . d <= r
        const limit = r + cx * dx + cy * dy;
        let m = 0;
        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            const xi = _polyX[i], yi = _polyY[i];
            const xj = _polyX[j], yj = _polyY[j];
            const di = xi * dx + yi * dy - limit;
            const dj = xj * dx + yj * dy - limit;
            if (di <= 0) { _tmpX[m] = xi; _tmpY[m] = yi; m++; }
            if ((di < 0) !== (dj < 0)) {
                const t = di / (di - dj);
                _tmpX[m] = xi + t * (xj - xi);
                _tmpY[m] = yi + t * (yj - yi);
                m++;
            }
            if (m > POLY_CAP - 2) break; // cannot happen for a convex clip; guard anyway
        }
        n = m;
        for (let i = 0; i < n; i++) { _polyX[i] = _tmpX[i]; _polyY[i] = _tmpY[i]; }
    }
    return n;
}
