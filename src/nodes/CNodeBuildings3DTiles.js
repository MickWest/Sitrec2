// CNodeBuildings3DTiles.js
// Renders 3D building tiles using NASA's 3DTilesRendererJS library.
// Supports Cesium Ion OSM Buildings and Google Photorealistic 3D Tiles.
//
// Each visible 3D view gets its own TilesRenderer instance with independent
// LOD so that views with very different cameras (e.g. close-up mainView vs
// distant lookView) each load tiles at the appropriate resolution without
// competing for budget.

import {CNode} from "./CNode";
import {Globals, markShadowCastersDirty, NodeMan} from "../Globals";
import {GlobalScene} from "../LocalFrame";
import {DoubleSide, Group} from "three";
import * as LAYER from "../LayerMasks";
import {TilesRenderer} from "3d-tiles-renderer";
import {GLTFExtensionsPlugin, TilesFadePlugin} from "3d-tiles-renderer/plugins";
import {DRACOLoader} from "three/addons/loaders/DRACOLoader.js";
import {TilesDayNightPlugin} from "../TilesDayNightPlugin";
import {TilesEdgesPlugin} from "../TilesEdgesPlugin";
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
     */
    constructor(parentGroup, layerMask, source, cesiumIonToken, googleApiKey, googleSharedState,
                materialMode = "photo", flatColor = null) {
        this.renderer = new TilesRenderer();
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

        // Track every tile visibility state change so export settle logic can wait for transition quiescence.
        this._onTileVisibilityChange = () => {
            this.visibilityVersion++;
            this.lastVisibilityChangeAt = performance.now();
            markShadowCastersDirty(`3dTiles:${source}:visibility`);
        };
        this.renderer.addEventListener("tile-visibility-change", this._onTileVisibilityChange);

        this.renderer.group.layers.mask = layerMask;

        // Set layer mask on all tile meshes as they load
        const useDoubleSideShadow = (source === "cesium-osm");
        this.renderer.addEventListener('load-model', ({scene}) => {
            scene.traverse(child => {
                if (child.isMesh || child.isLine || child.isPoints) {
                    child.layers.mask = layerMask;
                }
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
    }

    update(view) {
        if (!view || !view.visible || !view.camera || !view.renderer) return;
        // Ensure the camera's world matrix is current — controllers may not
        // have run yet this frame depending on node update order.
        view.camera.updateMatrixWorld();
        this.renderer.setCamera(view.camera);
        this.renderer.setResolutionFromRenderer(view.camera, view.renderer);
        this.renderer.update();
    }

    /**
     * Dispose renderer resources and unregister listeners.
     * @param {Group} parentGroup
     */
    dispose(parentGroup) {
        parentGroup.remove(this.renderer.group);
        this.renderer.removeEventListener("tile-visibility-change", this._onTileVisibilityChange);
        this.renderer.dispose();
        if (this.dracoLoader && typeof this.dracoLoader.dispose === "function") {
            this.dracoLoader.dispose();
            this.dracoLoader = null;
        }
        this.fadePlugin = null;
        this._onTileVisibilityChange = null;
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

        this.group = new Group();
        this.group.layers.mask = LAYER.MASK_MAIN | LAYER.MASK_LOOK;
        GlobalScene.add(this.group);

        this._perView = {}; // keyed by view id
        this._initialized = false;

        this.updateWhilePaused = true;

        this.initTilesRenderers();
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
                this.materialMode, this.flatColor
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

        for (const [viewId, pv] of Object.entries(this._perView)) {
            const view = NodeMan.get(viewId, false);
            pv.update(view);
        }
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
        this.disposeTilesRenderers();

        if (this.group) {
            GlobalScene.remove(this.group);
            this.group = null;
        }

        super.dispose();
    }
}
