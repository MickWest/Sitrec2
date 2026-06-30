// CNodeBuildings3DTiles.js
// Renders 3D building tiles using NASA's 3DTilesRendererJS library.
// Supports Cesium Ion OSM Buildings and Google Photorealistic 3D Tiles.
//
// Each visible 3D view gets its own TilesRenderer instance with independent
// LOD so that views with very different cameras (e.g. close-up mainView vs
// distant lookView) each load tiles at the appropriate resolution without
// competing for budget.

import {CNode} from "./CNode";
import {Globals, markShadowCastersDirty, NodeMan, setRenderOne} from "../Globals";
import {GlobalScene} from "../LocalFrame";
import {DoubleSide, Group, Raycaster} from "three";
import * as LAYER from "../LayerMasks";
import {TilesRenderer} from "3d-tiles-renderer";
import {GLTFExtensionsPlugin, TilesFadePlugin} from "3d-tiles-renderer/plugins";
import {DRACOLoader} from "three/addons/loaders/DRACOLoader.js";
import {TilesDayNightPlugin} from "../TilesDayNightPlugin";
import {TilesEdgesPlugin} from "../TilesEdgesPlugin";
import {TreeFlattener, makeDefaultTreeFlattenParams, GROUND_SEARCH_RADIUS} from "../TilesTreeFlatten";
import {TreeManualBrush} from "../TreeManualBrush";
import {ECEFToLLAVD_radii, RLLAToECEF_radii} from "../LLA-ECEF-ENU";
import {getLocalUpVector} from "../SphericalMath";
import {getPointBelow} from "../threeExt";
import {undoManager as UndoManager} from "../UndoManager";

const DEG2RAD = Math.PI / 180;

// Reused scratch raycaster for groundBelow() so WASD walking doesn't allocate one per frame.
const _groundRaycaster = new Raycaster();
// Max metres a tile ground hit may deviate from the elevation-map ground before
// groundBelow() rejects it as not-a-real-ground-tile (coarse streaming tiles can sit
// tens of km off; building roofs sit high). Generous enough to keep a real ground
// tile (within ~1-2 m) and absorb elevation-map error / any residual geoid offset,
// tight enough to reject roofs and coarse-LOD garbage.
const GROUND_TOLERANCE = 40;
import {
    getSharedGooglePhotorealisticState,
    SharedGoogleCloudAuthPlugin,
    TrackedCesiumIonAuthPlugin,
} from "../GooglePhotorealisticTilesAuth";

function createDracoLoader() {
    const dracoLoader = new DRACOLoader();
    dracoLoader.setDecoderPath("./libs/draco/");
    return dracoLoader;
}

// Apply a global opacity to a tile mesh's material(s). depthWrite is deliberately LEFT ON
// (the default): the photogrammetric tileset keeps parent/coarser-LOD tiles rendered behind
// the finer children and relies on depth occlusion to hide them. With depthWrite off, those
// hidden LOD tiles blend in the moment opacity drops below 1 — a sudden "extra geometry" pop
// (blobby green trees, doubled walls). Keeping depthWrite on makes a faded tile read as
// tinted glass: it still occludes its own hidden geometry while letting the background through.
// needsUpdate is only flipped when the transparent flag actually changes, so dragging the
// slider doesn't recompile the shader on every step.
function applyMeshOpacity(mesh, opacity) {
    const transparent = opacity < 1;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
        if (!m) continue;
        if (m.transparent !== transparent) {
            m.transparent = transparent;
            m.needsUpdate = true;
        }
        m.opacity = opacity;
    }
}



// Per-view state: a TilesRenderer instance, its parent group, and the view it tracks.
class PerViewTiles {
    /**
     * @param {Group} parentGroup
     * @param {number} layerMask
     * @param {string} source
     * @param {string|null} cesiumIonToken
     * @param {string|null} googleApiKey
     * @param {Object|null} googleSharedState
     * @param {string} materialMode
     * @param {number|null} flatColor
     * @param {number} errorTarget  screen-space-error target (px) for tile LOD; lower = sharper
     */
    constructor(parentGroup, layerMask, source, cesiumIonToken, googleApiKey, googleSharedState,
                materialMode = "photo", flatColor = null, treeFlattenParams = null, opacity = 1,
                errorTarget = 20) {
        // Global building transparency (shared "Terrain Opacity" control). Applied to each tile
        // mesh as it streams in (see the load-model handler) so newly-loaded tiles match the
        // already-loaded ones. The fade plugin fades via shader dither, not material.opacity, so
        // these don't fight.
        this.opacity = opacity;
        this.renderer = new TilesRenderer();

        // Raise the tile cache's BYTE budget. The library default (maxBytesSize
        // 0.4GB) is sized for aerial/oblique views; a ground-level Google
        // Photorealistic camera in a dense city legitimately needs a far larger
        // working set (~0.8GB / ~1500 tiles observed). Once the LRU cache is byte-
        // full, TilesRendererBase.update() stops requesting ANY new tiles (the
        // request loop is gated on `!lruCache.isFull()`), so the near-field tiles
        // for the current view never download and the terrain "drops out" / stays
        // low-LOD. This is order-dependent: scrubbing the timeline fills the cache
        // with tiles from the camera's other positions, locking out the tiles the
        // current frame actually needs. A higher ceiling is cheap — it is a cap,
        // not an allocation: the cache only ever holds what the visible working set
        // demands, so views that don't need the headroom pay nothing for it.
        const GIGABYTE = 1024 * 1024 * 1024;
        this.renderer.lruCache.minBytesSize = 1.0 * GIGABYTE;
        this.renderer.lruCache.maxBytesSize = 1.5 * GIGABYTE;
        // Also raise the ITEM-count cap. isFull() trips on EITHER cachedBytes>=maxBytesSize OR
        // itemSet.size>=maxSize; at a low errorTarget the near field is many small tiles, so the
        // default maxSize (8000) can hit the item cap (and re-jam the admission gate) while bytes
        // are still low. Raise it so the BYTE cap — the real memory bound — is what binds.
        this.renderer.lruCache.minSize = 12000;
        this.renderer.lruCache.maxSize = 16000;

        // Monotonic counter used by export settling to detect LOD visibility churn.
        this.visibilityVersion = 0;
        // Timestamp retained for debugging/diagnostics when tracking transitions.
        this.lastVisibilityChangeAt = 0;

        this.dracoLoader = createDracoLoader();
        this.renderer.registerPlugin(new GLTFExtensionsPlugin({
            dracoLoader: this.dracoLoader,
        }));

        if (source === "cesium-osm") {
            this.renderer.registerPlugin(new TrackedCesiumIonAuthPlugin({
                apiToken: cesiumIonToken,
                assetId: 96188, // Cesium OSM Buildings
            }));
        } else if (source === "google-photorealistic") {
            this.renderer.registerPlugin(new SharedGoogleCloudAuthPlugin({
                apiToken: googleApiKey,
                sharedState: googleSharedState,
                autoRefreshToken: true,
            }));
        }

        this.dayNightPlugin = new TilesDayNightPlugin({source, materialMode, flatColor});
        this.renderer.registerPlugin(this.dayNightPlugin);
        this.edgesPlugin = new TilesEdgesPlugin();
        this.renderer.registerPlugin(this.edgesPlugin);
        // Fade plugin smooths LOD transitions so parent/child tile swaps are less abrupt in exports.
        this.fadePlugin = new TilesFadePlugin({
            fadeDuration: 250,
            fadeRootTiles: true,
            // Keep high enough to avoid forced "pop" fallback when many tiles transition together.
            maximumFadeOutTiles: 400,
        });
        this.renderer.registerPlugin(this.fadePlugin);

        // Tile LOD: the renderer's global screen-space-error target. Lower = sharper but more
        // (billed) tile fetches. Overrides the Google plugin's recommended 20. Ordinary
        // frustum-based loading with progressive parent-to-child refinement — no off-screen
        // load volume (an earlier camera-centred LoadRegionPlugin SphereRegion was reverted
        // because a non-mask region force-loads tiles OUTSIDE the frustum too, costing extra
        // root-tileset requests behind/beside the camera without reliably buying near detail).
        this.renderer.errorTarget = errorTarget;
        // Keep the default traversal strategy. It loads renderable parent tiles first, then
        // progressively swaps in children as they arrive; the experimental optimized strategy
        // skips much of that parent-placeholder path, leaving temporary holes while leaves stream in.

        // Track every tile visibility state change so export settle logic can wait for transition quiescence.
        this._onTileVisibilityChange = () => {
            this.visibilityVersion++;
            this.lastVisibilityChangeAt = performance.now();
            markShadowCastersDirty(`3dTiles:${source}:visibility`);
            // A tile became visible/invisible (loaded, LOD swapped, fade step). Under
            // render-on-demand the loop may have slept after the camera settled, so
            // request a render — otherwise a late-arriving tile is in the scene graph
            // but never drawn. Cheap: during active streaming the loop is already kept
            // awake by _isUpdatePending(); once streaming stops these events stop too.
            setRenderOne(true);
        };
        this.renderer.addEventListener("tile-visibility-change", this._onTileVisibilityChange);

        // The library fires "needs-update" from its async completion callbacks —
        // a tile finished downloading+parsing, the root tileset loaded, or child
        // nodes finished processing — i.e. OUTSIDE of update(). It means "new data
        // arrived; a fresh update() traversal is required to place it in the scene".
        // This is the critical signal our settle optimization (below) must honour:
        // once the camera is static and the tileset looks settled, update() skips
        // renderer.update(). A tile that finishes loading inside that window would
        // otherwise be stuck loaded-but-invisible forever — tile-visibility-change
        // can't rescue it because that event only fires DURING update() (the very
        // call being skipped). Latch the signal so the next update() runs, and wake
        // the render loop under render-on-demand. These events stop once streaming
        // stops, so this never defeats the idle optimization.
        this._needsLibUpdate = false;
        this._onNeedsUpdate = () => {
            this._needsLibUpdate = true;
            setRenderOne(true);
        };
        this.renderer.addEventListener("needs-update", this._onNeedsUpdate);

        this.renderer.group.layers.mask = layerMask;

        // Set layer mask on all tile meshes as they load
        const useDoubleSideShadow = (source === "cesium-osm");
        this.renderer.addEventListener('load-model', ({scene}) => {
            scene.traverse(child => {
                if (child.isMesh || child.isLine || child.isPoints) {
                    child.layers.mask = layerMask;
                }
                // Match the global building opacity on freshly-streamed tiles.
                if (child.isMesh && this.opacity < 1) applyMeshOpacity(child, this.opacity);
                // V5 shadows: opt tile meshes in to cast/receive ONLY when
                // shadows are currently active. Defaults-off invariant: when
                // off this branch is a single boolean check + no writes.
                if (Globals.shadowsEnabled) {
                    if (child.isMesh) {
                        child.castShadow = true;
                        child.receiveShadow = true;
                        // OSM building tiles have inconsistent face winding —
                        // some roofs face inward, walls outward. Three.js's
                        // default shadow pass uses shadowSide=BackSide which
                        // skips outward-facing roof triangles, creating a gap
                        // between the building base and the cast shadow.
                        // DoubleSide makes both sides cast.
                        //
                        // Google Photorealistic tiles are photogrammetric
                        // meshes with consistent winding — they DON'T need
                        // DoubleSide, and applying it actually breaks self-
                        // shadow reception (the back-face depths corrupt the
                        // depth map for ground triangles in a building's
                        // shadow). Use shadowSide=DoubleSide ONLY for OSM.
                        if (useDoubleSideShadow && child.material) {
                            if (Array.isArray(child.material)) {
                                for (const m of child.material) m.shadowSide = DoubleSide;
                            } else {
                                child.material.shadowSide = DoubleSide;
                            }
                        }
                    } else if (child.isLine || child.isPoints) {
                        child.castShadow = false;
                    }
                }
            });
            // Also notify the throttle that the caster set changed.
            markShadowCastersDirty(`3dTiles:${source}:load-model`);
        });

        parentGroup.add(this.renderer.group);

        // "Flatten Trees" post-processor. Only meaningful for the photogrammetric
        // Google tiles (OSM buildings have no tree geometry), so gate by source
        // to avoid ever touching building meshes.
        this.treeFlattener = (source === "google-photorealistic" && treeFlattenParams)
            ? new TreeFlattener(treeFlattenParams, this.renderer)
            : null;
    }

    // Analyse loaded tiles within cull distance of the view camera and
    // flatten/remove trees. Cheap when nothing new is in range (per-mesh hash
    // skip). Returns the number of meshes modified this call.
    processTreeFlatten(view) {
        if (!this.treeFlattener || !view || !view.camera) return 0;
        return this.treeFlattener.processVisible(view.camera);
    }

    update(view) {
        if (!view || !view.visible || !view.camera || !view.renderer) return;
        // Ensure the camera's world matrix is current — controllers may not
        // have run yet this frame depending on node update order.
        view.camera.updateMatrixWorld();

        // TilesRenderer.update() re-traverses the whole tileset every call to
        // recompute screen-space error / LOD, allocating tens of KB each time
        // (~119KB/frame across both views on a Google-photorealistic scene).
        // When the camera is static AND the tileset is fully settled (nothing
        // downloading / parsing / fading), re-running it changes nothing but
        // churns ~7MB/s of garbage at 60fps — a primary GC/CPU sink even while
        // paused. Skip it once settled; any camera move resumes immediately,
        // and a short grace window covers fades/late tiles after the camera
        // stops. Resolution (aspect) is folded into the fingerprint so a
        // window resize also re-triggers an LOD pass.
        const cam = view.camera;
        const e = cam.matrixWorld.elements;
        const fp = e[0] + e[5] + e[10] + e[12] + e[13] + e[14]
            + cam.fov + cam.zoom + (cam.aspect || 0);
        if (fp !== this._lastCamFingerprint) {
            this._lastCamFingerprint = fp;
            this._updateGraceFrames = 60; // keep updating ~1s after camera stops
        } else if (this._updateGraceFrames > 0) {
            this._updateGraceFrames--;
        }
        if ((this._updateGraceFrames ?? 0) <= 0 && !this._isUpdatePending() && !this._needsLibUpdate) {
            return; // static camera + settled tileset: nothing to recompute
        }
        // Consume the late-arrival signal: this update() will traverse and display
        // whatever async work just completed. If it queues further work, the normal
        // grace/pending path below keeps the loop alive until truly settled.
        this._needsLibUpdate = false;

        this.renderer.setCamera(cam);
        this.renderer.setResolutionFromRenderer(cam, view.renderer);
        this.renderer.update();
    }

    // True while the tileset still has network/parse work or fade transitions
    // in flight — i.e. update() must keep running even with a static camera.
    // Mirrors the pending check used by getPendingLoadState().
    _isUpdatePending() {
        const r = this.renderer;
        if (!r) return false;
        const s = r.stats || {};
        const fading = this.fadePlugin?.fadingTiles || 0;
        return !!r.isLoading
            || (s.queued || 0) > 0
            || (s.downloading || 0) > 0
            || (s.parsing || 0) > 0
            || fading > 0;
    }

    /**
     * Dispose renderer resources and unregister listeners.
     * @param {Group} parentGroup
     */
    dispose(parentGroup) {
        parentGroup.remove(this.renderer.group);
        this.renderer.removeEventListener("tile-visibility-change", this._onTileVisibilityChange);
        this.renderer.removeEventListener("needs-update", this._onNeedsUpdate);
        if (this.treeFlattener) {
            this.treeFlattener.dispose();
            this.treeFlattener = null;
        }
        this.renderer.dispose();
        if (this.dracoLoader && typeof this.dracoLoader.dispose === "function") {
            this.dracoLoader.dispose();
            this.dracoLoader = null;
        }
        this.fadePlugin = null;
        this._onTileVisibilityChange = null;
        this._onNeedsUpdate = null;
    }
}


export class CNodeBuildings3DTiles extends CNode {
    constructor(v) {
        super(v);

        this.source = v.source ?? "cesium-osm"; // "cesium-osm" or "google-photorealistic"
        this.cesiumIonToken = v.cesiumIonToken ?? null;
        this.googleApiKey = v.googleApiKey ?? null;
        // V5 material modes: "photo" (default), "flat", "halfPhoto".
        this.materialMode = v.materialMode ?? "photo";
        this.flatColor = v.flatColor ?? null;
        // Global tile-LOD screen-space-error target (px): lower = sharper but more (billed)
        // Google tile downloads. NOT serialized — resets per session so a saved sitch can't
        // silently drive up another user's billed tile count.
        this.errorTarget = v.errorTarget ?? 20;
        // Global building transparency, driven by the shared "Terrain Opacity" control
        // (CNodeTerrainUI). 1 = fully opaque.
        this.opacity = v.opacity ?? 1;
        // EXTRA look-view-only transparency ("Sim Opacity" under Street View Pano). The look
        // view has its own TilesRenderer (separate meshes from the main view), so multiplying
        // this in for that renderer only fades the buildings in the look view while the main
        // view stays at the global opacity. 1 = no extra fade.
        this.lookSimOpacity = v.lookSimOpacity ?? 1;

        // Shared "Edit Geometry" params. Owned by CNodeTerrainUI (which serializes
        // them) and passed in by reference so GUI edits are picked up live by
        // every per-view TreeFlattener. Includes the persistent `dabs` edit list.
        this.treeFlattenParams = v.treeFlattenParams ?? makeDefaultTreeFlattenParams();
        if (!Array.isArray(this.treeFlattenParams.dabs)) this.treeFlattenParams.dabs = [];
        // World-space form of the dab list (LLA → ECEF), rebuilt when it changes.
        this._dabsWorld = [];
        this._lastDab = null;
        this.rebuildDabsWorld();

        this.group = new Group();
        this.group.layers.mask = LAYER.MASK_MAIN | LAYER.MASK_LOOK;
        GlobalScene.add(this.group);

        this._perView = {}; // keyed by view id
        this._initialized = false;

        this.updateWhilePaused = true;

        this.initTilesRenderers();

        // Manual-edit brush. Installs document-level pointer listeners that only
        // act while the Tree Removal "Manual Edit" checkbox is on.
        this.manualBrush = new TreeManualBrush(this);
    }

    // Resolve which source to actually use: prefer the requested source,
    // but fall back to whatever has a valid API key configured.
    resolveSource() {
        if (this.source === "cesium-osm" && this.cesiumIonToken) return "cesium-osm";
        if (this.source === "google-photorealistic" && this.googleApiKey) return "google-photorealistic";
        // Requested source not available, try the other one
        if (this.googleApiKey) return "google-photorealistic";
        if (this.cesiumIonToken) return "cesium-osm";
        return null;
    }

    initTilesRenderers() {
        this.disposeTilesRenderers();

        const activeSource = this.resolveSource();
        if (!activeSource) {
            console.warn("CNodeBuildings3DTiles: No API keys configured. Buildings will not load.");
            return;
        }

        // One TilesRenderer per view, each with its own LOD and layer mask.
        const viewConfigs = [
            {id: "mainView", mask: LAYER.MASK_MAIN},
            {id: "lookView", mask: LAYER.MASK_LOOK},
        ];
        const googleSharedState = activeSource === "google-photorealistic"
            ? getSharedGooglePhotorealisticState(this.googleApiKey)
            : null;

        for (const {id, mask} of viewConfigs) {
            this._perView[id] = new PerViewTiles(
                this.group, mask, activeSource,
                this.cesiumIonToken, this.googleApiKey, googleSharedState,
                this.materialMode, this.flatColor, this.treeFlattenParams, this._effectiveOpacity(id),
                this.errorTarget   // global tile-LOD target (slider-driven)
            );
        }

        this._initialized = true;
        this._activeSource = activeSource;

        console.log("CNodeBuildings3DTiles: Initialized with source=" + activeSource
            + (activeSource !== this.source ? " (requested " + this.source + ")" : ""));
    }

    disposeTilesRenderers() {
        if (Object.keys(this._perView).length > 0) {
            markShadowCastersDirty(`${this.id}:disposeTilesRenderers`);
        }
        for (const pv of Object.values(this._perView)) {
            pv.dispose(this.group);
        }
        this._perView = {};
        this._initialized = false;
    }

    // V5 shadows: walk already-loaded tile meshes and flip cast/receiveShadow.
    // §0 invariant: if shadows have never been on AND aren't on now, no traversal.
    refreshShadowFlags() {
        if (!Globals.shadowsEnabled && !this._didEverEnableShadows) return;
        if (Globals.shadowsEnabled) this._didEverEnableShadows = true;
        const want = Globals.shadowsEnabled;
        const useDoubleSideShadow = (this._activeSource === "cesium-osm");
        for (const pv of Object.values(this._perView)) {
            if (!pv.renderer || typeof pv.renderer.forEachLoadedModel !== "function") continue;
            pv.renderer.forEachLoadedModel(scene => {
                scene.traverse(child => {
                    if (child.isMesh) {
                        child.castShadow = want;
                        child.receiveShadow = want;
                        if (want && useDoubleSideShadow && child.material) {
                            if (Array.isArray(child.material)) {
                                for (const m of child.material) m.shadowSide = DoubleSide;
                            } else {
                                child.material.shadowSide = DoubleSide;
                            }
                        } else if (want && !useDoubleSideShadow && child.material) {
                            // Clear DoubleSide if we previously had it (e.g.
                            // after source switch from OSM to Google).
                            if (Array.isArray(child.material)) {
                                for (const m of child.material) m.shadowSide = null;
                            } else {
                                child.material.shadowSide = null;
                            }
                        }
                    } else if (child.isLine || child.isPoints) {
                        child.castShadow = false;
                    }
                });
            });
        }
        markShadowCastersDirty(`${this.id}:refreshShadowFlags`);
    }

    // Toggle shader-based wireframe edge rendering on all tile meshes.
    // Edges only apply to OSM buildings — Google Photorealistic tiles are
    // terrain imagery where wireframe edges are not meaningful.
    setShowEdges(show) {
        this._showEdges = show;
        const effective = show && this._activeSource === "cesium-osm";
        const firstPv = Object.values(this._perView)[0];
        if (firstPv?.edgesPlugin) {
            firstPv.edgesPlugin.setVisible(effective);
        }
    }

    // V5 material modes. Updates plugin state for FUTURE tile loads only.
    // To re-style already-loaded tiles the user must toggle buildings off/on
    // (re-walking loaded tiles would orphan TilesFadePlugin entries).
    setMaterialMode(mode, flatColor) {
        this.materialMode = mode ?? "photo";
        if (flatColor !== undefined) this.flatColor = flatColor;
        for (const pv of Object.values(this._perView)) {
            if (pv.dayNightPlugin?.setMaterialMode) {
                pv.dayNightPlugin.setMaterialMode(this.materialMode, this.flatColor);
            }
        }
    }

    // Effective opacity for one view's tiles: the global opacity, times the look-view-only
    // sim fade for the look view's renderer.
    _effectiveOpacity(viewId) {
        return viewId === "lookView" ? this.opacity * this.lookSimOpacity : this.opacity;
    }

    // Re-apply the effective opacity to one per-view renderer's currently-loaded tiles, and
    // store it on the per-view so tiles that stream in later match (load-model handler).
    _applyOpacityToPerView(viewId) {
        const pv = this._perView[viewId];
        if (!pv) return;
        const eff = this._effectiveOpacity(viewId);
        pv.opacity = eff;
        if (pv.renderer && pv.renderer.group) {
            pv.renderer.group.traverse(child => {
                if (child.isMesh && child.material) applyMeshOpacity(child, eff);
            });
        }
    }

    // Global building transparency (shared "Terrain Opacity" control) — both views.
    setOpacity(opacity) {
        this.opacity = opacity;
        for (const id in this._perView) this._applyOpacityToPerView(id);
        setRenderOne(true);
    }

    // Look-view-only building transparency ("Sim Opacity" under Street View Pano) — fades the
    // look view's tiles (so the Street View panorama shows through) without touching mainView.
    setLookSimOpacity(opacity) {
        this.lookSimOpacity = opacity;
        this._applyOpacityToPerView("lookView");
        setRenderOne(true);
    }

    // Tile LOD detail = the renderer's global screen-space-error target (px). Lower = sharper but
    // more billed Google tile fetches. Ordinary frustum-based loading. Forces a fresh LOD pass.
    setErrorTarget(errorTarget) {
        this.errorTarget = errorTarget;
        for (const pv of Object.values(this._perView)) {
            pv.renderer.errorTarget = errorTarget;
            pv._needsLibUpdate = true;   // wake the settle optimization so update() re-evaluates LOD
        }
        setRenderOne(true);
    }

    // --- Flatten Trees control surface (called from CNodeTerrainUI) ---

    // Toggle the feature. Turning it OFF restores all modified tiles; turning
    // it ON wakes the loop so update() starts processing in-range tiles.
    setTreeFlattenEnabled(on) {
        this.treeFlattenParams.flattenTrees = on;
        if (!on) {
            this.restoreTreeFlatten();
        } else {
            setRenderOne(true);
        }
    }

    // A heuristic parameter changed: restore originals so stale edits revert,
    // then wake the loop to re-process with the new param hash.
    applyTreeFlattenParams() {
        if (this.treeFlattenParams.flattenTrees) {
            this.restoreTreeFlatten();
            setRenderOne(true);
        }
    }

    // Manual Edit toggled. The brush reads treeFlattenParams.manualEdit live, so
    // we just keep the flag in sync and wake the loop (so the suspended/resumed
    // auto pass re-evaluates on the next frame).
    setManualEditEnabled(on) {
        this.treeFlattenParams.manualEdit = on;
        if (!on && this.manualBrush) this.manualBrush.hidePreview();
        setRenderOne(true);
    }

    // Renderer group for a view, only when that view carries a Google
    // TreeFlattener (manual editing is meaningless for OSM buildings). Used by
    // the manual brush to raycast tile geometry.
    getViewRendererGroup(viewId) {
        const pv = this._perView[viewId];
        return (pv && pv.treeFlattener) ? pv.renderer.group : null;
    }

    // Record a manual brush stroke as a persistent dab (world-space sphere). The
    // actual geometry edit is done by the per-frame reapply pass (update()), which
    // also re-applies to tiles as they stream in. Deduped against the previous dab
    // so a drag doesn't store hundreds of overlapping spheres. Stored as lat/lon/alt
    // (frame-independent) for serialization.
    applyManualBrush(worldCenter, radius, actionOverride) {
        const action = actionOverride || this.treeFlattenParams.action;
        const last = this._lastDab;
        if (last && last.a === action && last.r === radius
            && last.center.distanceTo(worldCenter) < radius * 0.3) {
            return 0; // too close to the previous dab — skip
        }
        const lla = ECEFToLLAVD_radii(worldCenter);
        const dab = {
            lla: [+lla.x.toFixed(7), +lla.y.toFixed(7), +lla.z.toFixed(2)],
            r: radius,
            a: action,
        };
        const entry = {center: worldCenter.clone(), r: radius, a: action};
        // For snap, find the true ground NOW (cross-mesh, since canopy and street
        // are separate tile meshes) and persist it as the ground altitude `g`, so it
        // stays stable as tiles stream / on reload. entry.floorH is the world height.
        if (action === "snap") {
            const gr = this._groundFloorH(worldCenter);
            if (gr) {
                dab.g = +ECEFToLLAVD_radii(gr.point).z.toFixed(2);
                entry.floorH = gr.floorH;
            }
        }
        this.treeFlattenParams.dabs.push(dab);
        this._dabsWorld.push(entry);
        this._lastDab = entry;
        // Apply to currently-loaded tiles right now for immediate feedback. This
        // is idempotent via the DAB_COUNT stamps, so the per-frame reapply pass
        // (which catches tiles that stream in later) won't double-apply.
        let edited = 0;
        for (const pv of Object.values(this._perView)) {
            if (pv.treeFlattener) edited += pv.treeFlattener.reapplyDabs(this._dabsWorld, Infinity);
        }
        setRenderOne(true);
        return edited;
    }

    // Rebuild the world-space dab cache from the serialized lat/lon/alt list.
    // Called on construction, after deserialize, and on ellipsoid/radii change.
    rebuildDabsWorld() {
        const dabs = this.treeFlattenParams.dabs || [];
        this._dabsWorld = dabs.map(d => {
            const center = RLLAToECEF_radii(d.lla[0] * DEG2RAD, d.lla[1] * DEG2RAD, d.lla[2]);
            const entry = {center, r: d.r, a: d.a};
            // Persisted snap ground altitude → world floor height (along up at center).
            if (d.g !== undefined) {
                const groundWorld = RLLAToECEF_radii(d.lla[0] * DEG2RAD, d.lla[1] * DEG2RAD, d.g);
                entry.floorH = groundWorld.dot(getLocalUpVector(center));
            }
            return entry;
        });
        this._lastDab = this._dabsWorld.length ? this._dabsWorld[this._dabsWorld.length - 1] : null;
    }

    // Cross-mesh ground for a snap dab at worldCenter: the lowest ORIGINAL vertex
    // world-height (along the geodetic up) within GROUND_SEARCH_RADIUS, across the
    // per-view renderers. Returns {floorH, point} or null.
    _groundFloorH(worldCenter) {
        const up = getLocalUpVector(worldCenter);
        let best = null, bestH = Infinity;
        for (const pv of Object.values(this._perView)) {
            if (!pv.treeFlattener) continue;
            const p = pv.treeFlattener.lowestGroundPoint(worldCenter, up, GROUND_SEARCH_RADIUS);
            if (p) { const h = p.dot(up); if (h < bestH) { bestH = h; best = p.clone(); } }
        }
        return best ? {floorH: bestH, point: best} : null;
    }

    // Ground directly below an ECEF world point, taken from the actual loaded 3D
    // tile geometry (the rendered buildings/photogrammetry surface) — but only when
    // the tile is a believable refinement of the elevation-map ground. Casts a ray
    // straight down along the geodetic -up and returns the polygon intersection whose
    // height is CLOSEST to the elevation-map ground (the street/tarmac level), or
    // null if there is no tile loaded below yet OR the best hit is wildly off (see
    // GROUND_TOLERANCE below) — in which case the caller falls back to the elevation
    // map. Returns a fresh ECEF Vector3.
    //
    // Why anchor to the elevation map and not just take the highest or lowest hit:
    //   - LOWEST dips through a building's watertight shell to a sub-surface skirt
    //     polygon BELOW the surrounding tarmac → an AGL witness / WASD walker ends up
    //     inside or under the building.
    //   - HIGHEST grabs a building ROOF.
    //   - Worst of all, 3D tiles stream coarse→fine: a coarse ancestor tile covering a
    //     continent-scale region is ~planar and, sampled away from its centre, sits
    //     TENS OF KILOMETRES below the true surface (measured: −50 km at Copenhagen).
    //     Min/max/closest over those garbage hits is meaningless, and the one-shot AGL
    //     refine would latch onto it ("458 ft agl", or worse, underground).
    // The elevation map is buildings-free, complete, and always ~ground level, so it
    // is the reliable anchor: pick the tile hit nearest it, and REJECT entirely if even
    // the nearest is implausibly far (coarse-tile garbage / a tall roof). When a real
    // fine tile is loaded the tarmac is within a metre or two and still wins on detail.
    //
    // this.group recursively holds every loaded tile mesh for all per-view
    // TilesRenderers, so intersectObject(group, true) covers them all.
    groundBelow(worldPos) {
        if (!this.group || this.group.children.length === 0) return null;
        const up = getLocalUpVector(worldPos);
        // Start well above the query point so we still catch the ground if the
        // camera has dipped slightly below the surface; the ray is unbounded below.
        const origin = worldPos.clone().addScaledVector(up, 1000);
        _groundRaycaster.set(origin, up.clone().negate());
        _groundRaycaster.layers.mask = LAYER.MASK_MAIN | LAYER.MASK_LOOK;
        _groundRaycaster.firstHitOnly = false; // we need every hit to pick the best
        const hits = _groundRaycaster.intersectObject(this.group, true);
        if (hits.length === 0) return null;

        // Reference: the smooth elevation-map ground at this column (buildings-free).
        const refH = getPointBelow(worldPos).dot(up);
        let best = hits[0].point, bestErr = Math.abs(hits[0].point.dot(up) - refH);
        for (let i = 1; i < hits.length; i++) {
            const err = Math.abs(hits[i].point.dot(up) - refH);
            if (err < bestErr) { bestErr = err; best = hits[i].point; }
        }
        // Sanity gate: reject coarse-streaming-tile garbage and tall roofs. A real
        // ground tile sits within a few metres of the elevation map; anything past
        // this band means no usable ground tile is loaded → caller uses the elev map.
        if (bestErr > GROUND_TOLERANCE) return null;
        return best.clone();
    }

    // "Apply Edits" toggle. Restore so the change shows immediately; the update
    // reapply pass re-applies when on, and leaves geometry original when off.
    setApplyEdits(on) {
        this.treeFlattenParams.applyEdits = on;
        for (const pv of Object.values(this._perView)) {
            if (pv.treeFlattener) pv.treeFlattener.restoreAll();
        }
        setRenderOne(true);
    }

    // "Restore Geometry" — reset everything: drop the saved dab list and restore
    // all tiles to their original geometry (the auto pass re-runs if still on).
    clearAllEdits() {
        if (this.manualBrush) this.manualBrush.hidePreview();
        this.treeFlattenParams.dabs.length = 0;
        this._dabsWorld = [];
        this._lastDab = null;
        for (const pv of Object.values(this._perView)) {
            if (pv.treeFlattener) pv.treeFlattener.restoreAll();
        }
        setRenderOne(true);
    }

    // --- Undo/redo for manual brush strokes ---------------------------------
    // The dab list is append-only and applied idempotently per tile mesh (each
    // mesh carries a DAB_COUNT stamp; reapplyDabs only adds the new tail). So
    // there is no "remove the last dab" operation — changing the list to any
    // earlier or later state means restoring all tiles to their original
    // geometry and replaying the chosen dab set from scratch. snapshotDabs() +
    // restoreDabsState() are the primitives; the brush snapshots before a stroke
    // and calls commitStrokeUndo() after, collapsing the whole gesture (which may
    // append many deduped dabs) into a single undo entry.

    // Deep copy of the serialized dab list (plain {lla:[..], r, a, g?} objects).
    snapshotDabs() {
        return this.treeFlattenParams.dabs.map(d => ({...d, lla: [...d.lla]}));
    }

    // Replace the dab list with a snapshot, rebuild the world-space cache, then
    // restore original geometry and replay the chosen dabs onto all loaded tiles
    // so the result is visible immediately. Used by both undo and redo.
    restoreDabsState(snapshot) {
        if (this.manualBrush) this.manualBrush.hidePreview();
        this.treeFlattenParams.dabs = snapshot.map(d => ({...d, lla: [...d.lla]}));
        this.rebuildDabsWorld();
        for (const pv of Object.values(this._perView)) {
            if (pv.treeFlattener) pv.treeFlattener.restoreAll();
        }
        // Replay the reduced/expanded set now (the per-frame reapply pass in
        // update() would otherwise catch it, but immediate feedback is nicer).
        // Gated by "Apply Edits" so an undo while edits are hidden stays hidden.
        if (this.treeFlattenParams.applyEdits !== false && this._dabsWorld.length > 0) {
            for (const pv of Object.values(this._perView)) {
                if (pv.treeFlattener) pv.treeFlattener.reapplyDabs(this._dabsWorld, Infinity);
            }
        }
        setRenderOne(true);
    }

    // Push an undo action for a completed brush stroke. `before` is the snapshot
    // taken at pointer-down; the current dab list is the "after" state. No-op if
    // the stroke appended nothing (e.g. a click that hit only sky, or every dab
    // was deduped away) so empty gestures don't clutter the undo stack.
    commitStrokeUndo(before) {
        const after = this.snapshotDabs();
        if (after.length === before.length) return;
        UndoManager.add({
            description: "Remove Geometry brush stroke",
            undo: () => this.restoreDabsState(before),
            redo: () => this.restoreDabsState(after),
        });
    }

    // Non-destructive hover preview: hide the triangles the brush covers in the
    // HOVERED view's renderer only (each view holds the tiles at its own LOD, so
    // previewing both overlays a different-LOD wireframe that doesn't match the
    // displayed solid) and collect their edges for the wireframe ghost. Returns a
    // flat [x,y,z,...] array of world-space line-segment positions.
    previewManualBrush(worldCenter, radius, viewId, action) {
        const positions = [];
        const pv = this._perView[viewId];
        if (pv && pv.treeFlattener) {
            pv.treeFlattener.previewBrush(worldCenter, radius, action || this.treeFlattenParams.action, positions);
        }
        return positions;
    }

    // Restore any geometry hidden by previewManualBrush across all views.
    clearManualBrushPreview() {
        let restored = false;
        for (const pv of Object.values(this._perView)) {
            if (pv.treeFlattener) restored = pv.treeFlattener._restorePreview() || restored;
        }
        return restored;
    }

    // Restore every modified tile in every view to its original geometry.
    restoreTreeFlatten() {
        if (this.manualBrush) this.manualBrush.hidePreview(); // drop any hover ghost first
        for (const pv of Object.values(this._perView)) {
            if (pv.treeFlattener) pv.treeFlattener.restoreAll();
        }
        setRenderOne(true);
    }

    // Switch between data sources at runtime
    setSource(source) {
        if (source === this.source) return;
        this.source = source;
        this.initTilesRenderers();
        // Re-apply edge setting — edges are only valid for OSM source
        if (this._showEdges !== undefined) {
            this.setShowEdges(this._showEdges);
        }
    }

    update(f) {
        super.update(f);

        if (!this._initialized) return;

        let active = false;
        // Automatic analysis is suspended while Manual Edit is on — the brush is
        // the sole editor then, so the auto pass can't clobber painted edits.
        const flattenOn = this.treeFlattenParams
            && this.treeFlattenParams.flattenTrees
            && !this.treeFlattenParams.manualEdit;
        // Re-apply the persistent manual edits as tiles stream in. Runs whether or
        // not Manual Edit is on (the edits are committed state); gated by the
        // "Apply Edits" toggle.
        const applyDabs = this.treeFlattenParams.applyEdits !== false && this._dabsWorld.length > 0;
        let flattened = 0;
        for (const [viewId, pv] of Object.entries(this._perView)) {
            const view = NodeMan.get(viewId, false);
            pv.update(view);
            if ((pv._updateGraceFrames ?? 0) > 0 || pv._isUpdatePending()) active = true;
            // Tree flattening runs even when the camera is static + tileset
            // settled (pv.update may early-return), so tiles that finished
            // loading after the camera stopped still get processed.
            if (flattenOn) flattened += pv.processTreeFlatten(view);
            if (applyDabs && pv.treeFlattener) flattened += pv.treeFlattener.reapplyDabs(this._dabsWorld);
        }
        // If we modified geometry, draw it; and keep the loop awake one more pass
        // in case there are more in-range tiles past this call's per-pass budget.
        if (flattened > 0) {
            setRenderOne(true);
            active = true;
        }

        // Per-frame manual-brush preview refresh — tracks the cursor surface as
        // the camera moves with the mouse held still. Cheap no-op when off.
        if (this.manualBrush) this.manualBrush.refreshPreview();

        // Self-disable the paused keep-alive once the tileset is fully settled and
        // the camera is static, so the render loop can actually sleep
        // (shouldSleepAnimationLoop needs hasPausedBackgroundWork()===false). While
        // asleep, a camera move (controls -> setRenderOne) or a tile-visibility change
        // (load / LOD swap / fade -> setRenderOne in _onTileVisibilityChange) wakes the
        // loop, which re-runs this update, re-detects work via the per-view
        // grace/pending check above, and re-arms.
        this.updateWhilePaused = active;
    }

    /**
     * Return per-view loading/transition state for export frame settling.
     *
     * "Pending" includes both network/parse queue activity and fade transitions.
     * Visibility version fields are provided so callers can detect LOD churn even
     * when queue counters are zero.
     *
     * @param {string[]|null} viewIds - Optional view filter.
     * @returns {{hasPending: boolean, perView: Object<string, Object>}}
     */
    getPendingLoadState(viewIds = null) {
        const filter = Array.isArray(viewIds) && viewIds.length > 0 ? new Set(viewIds) : null;
        const perView = {};
        let hasPending = false;

        for (const [viewId, pv] of Object.entries(this._perView)) {
            if (filter && !filter.has(viewId)) continue;

            const renderer = pv?.renderer;
            if (!renderer) continue;

            const stats = renderer.stats || {};
            const queued = stats.queued || 0;
            const downloading = stats.downloading || 0;
            const parsing = stats.parsing || 0;
            const isLoading = !!renderer.isLoading;
            const fadingTiles = pv.fadePlugin?.fadingTiles || 0;
            const pending = isLoading || queued > 0 || downloading > 0 || parsing > 0 || fadingTiles > 0;

            if (pending) hasPending = true;
            perView[viewId] = {
                queued,
                downloading,
                parsing,
                isLoading,
                fadingTiles,
                visibilityVersion: pv.visibilityVersion || 0,
                lastVisibilityChangeAt: pv.lastVisibilityChangeAt || 0,
            };
        }

        return {hasPending, perView};
    }

    /**
     * Convenience boolean wrapper over getPendingLoadState().
     * @param {string[]|null} viewIds
     * @returns {boolean}
     */
    hasPendingLoads(viewIds = null) {
        return this.getPendingLoadState(viewIds).hasPending;
    }

    /**
     * Return an HTML attribution string for the currently active 3D tile source.
     * Google requires "Google" visible; Cesium OSM requires OSM attribution.
     */
    getAttribution() {
        if (!this._activeSource) return "";
        if (this._activeSource === "google-photorealistic") {
            return '<a href="https://developers.google.com/maps/documentation/tile/policies" target="_blank" rel="noopener noreferrer">\u00a9 Google</a>';
        }
        if (this._activeSource === "cesium-osm") {
            return '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">\u00a9 OpenStreetMap contributors</a>';
        }
        return "";
    }

    dispose() {
        if (this.manualBrush) {
            this.manualBrush.dispose();
            this.manualBrush = null;
        }

        this.disposeTilesRenderers();

        if (this.group) {
            GlobalScene.remove(this.group);
            this.group = null;
        }

        super.dispose();
    }
}
