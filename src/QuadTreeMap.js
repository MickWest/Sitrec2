import {wgs84} from "./LLA-ECEF-ENU";
import {Frustum, Matrix4, Sphere, Vector3} from "three";
import {computeActiveTileHash, debugLog, Globals} from "./Globals";
import {isLocal} from "./configUtils";
import {altitudeAboveSphere, distanceToHorizon, hiddenByGlobe} from "./SphericalMath";
import * as LAYER from "./LayerMasks";
import {assert} from "./assert";
import "./threeExt";
import {EventManager} from "./CEventManager";
import {removeMaterialByCacheKeyImpl} from "./QuadTreeTileMaterial";

// Reusable scratch objects to avoid garbage collection pressure.
// Reused across all tile visibility calculations within a single pass.
const _cameraPositionClone = new Vector3();
const _cullingSphere = new Sphere();

// Tile subdivision treats a slightly-wider frustum than the render frustum as
// "eligible for high LOD" — this is the preload margin for camera pan/track.
// 1.10 = 10% wider FOV in both axes. Replaces the old `isNearCamera` radial
// bypass, which was over-eagerly subdividing tiles directly under the camera
// (a sphere-radius-based test triggers for huge low-zoom tiles even when the
// camera is looking far away in a completely different direction).
const SUBDIVISION_FOV_DILATION = 1.10;

// Earth circumference at the equator (Web Mercator reference). Used for
// per-tile geometric error: at zoom z, tile spans this/2^z meters at the
// equator, scaled by cos(lat) at higher latitudes.
const EARTH_CIRCUMFERENCE_M = 40075016.686;

// Hysteresis: only merge children back to parent when SSE drops well below
// the subdivide threshold. This leaves a dead band [target*factor, target]
// where neither subdivide nor merge fires, preventing flicker as a tracked
// camera oscillates around the boundary. 0.5 = "merge only after SSE drops
// by a full zoom level's worth of detail." Smaller = stickier, larger = less
// memory but more flicker.
const MERGE_HYSTERESIS_FACTOR = 0.5;

///////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// QuadTreeMap is the base class of a QuadTreeMapTexture and a QuadTreeMapElevation
export class QuadTreeMap {
    constructor(terrainNode, geoLocation, options) {
        this.options = this.getOptions(options)
        this.nTiles = this.options.nTiles
        this.zoom = this.options.zoom
        this.tileSize = this.options.tileSize
        // Web Mercator tile math uses spherical radius — correct for tile indexing.
        // Vertex positioning uses LLAToECEF() which reads Globals.equatorRadius/polarRadius.
        this.radius = wgs84.RADIUS;
        this.loadedCallback = options.loadedCallback; // function to call when map is all loaded
        this.loaded = false; // mick flag to indicate loading is finished
        this.tileCache = {};
        this.allTiles = new Set(); // Flat set of all tiles for fast iteration
        this.terrainNode = terrainNode
        this.geoLocation = geoLocation
        this.dynamic = options.dynamic || false; // if true, we use a dynamic tile grid
        this.maxZoom = options.maxZoom ?? 15; // default max zoom level
        this.minZoom = options.minZoom ?? 0; // default min zoom level
        this.lastLoggedStats = new Map(); // Track last logged stats per view to reduce console spam
        // Base timeout (ms) before pruning inactive tiles. Read via the getter
        // below, which scales it down at high maxDetails — at zoom 22+ the
        // working set explodes (4× tiles per zoom level), so a 100 s leash
        // means tile creation can outpace pruning indefinitely. The effective
        // timeout interpolates 100 s @ md=15 down to 5 s @ md=23.
        this.inactiveTileTimeout = 100000;
        this.currentStats = new Map(); // Store current stats per view for debug display
        this.parentTiles = new Set(); // Track tiles that have children for efficient iteration
        this._tileStateGeneration = 0; // Generation counter for areaCoveredByDescendants cache
        this._dirtyParents = new Set(); // Parents that need coverage re-check (event-driven)

    }

    // Invalidate the areaCoveredByDescendants cache and mark dirty parents.
    // Called whenever tile state changes that could affect coverage results.
    // Walks up the tree from the changed tile, adding all ancestors to the dirty set.
    invalidateCoverageCache(tile) {
        this._tileStateGeneration++;
        if (!tile) return;
        // If this tile itself is a parent, mark it dirty (e.g., its children changed)
        if (tile.children) {
            this._dirtyParents.add(tile);
        }
        // Walk up the tree marking all ancestors as needing coverage re-check
        let current = tile.parent;
        while (current) {
            this._dirtyParents.add(current);
            current = current.parent;
        }
    }

    // Helper methods for nested cache access
    getTile(x, y, z) {
        return this.tileCache[z] && this.tileCache[z][x] && this.tileCache[z][x][y];
    }

    setTile(x, y, z, tile) {
        if (!this.tileCache[z]) this.tileCache[z] = {};
        if (!this.tileCache[z][x]) this.tileCache[z][x] = {};
        this.tileCache[z][x][y] = tile;
        this.allTiles.add(tile);
    }

    deleteTile(x, y, z) {
        if (this.tileCache[z] && this.tileCache[z][x] && this.tileCache[z][x][y]) {
            const tile = this.tileCache[z][x][y];
            
            // Clean up tree structure: remove from parent's children array
            if (tile.parent && tile.parent.children) {
                const index = tile.parent.children.indexOf(tile);
                if (index !== -1) {
                    tile.parent.children[index] = null;
                }
                // If all children are null, clear the children array
                if (tile.parent.children.every(child => child === null)) {
                    tile.parent.children = null;
                    // Parent no longer has children, remove from parent tracking set
                    this.parentTiles.delete(tile.parent);
                }
                this.invalidateCoverageCache(tile);
            }

            // Clean up tree structure: clear children references
            if (tile.children) {
                tile.children.forEach(child => {
                    if (child) child.parent = null;
                });
                tile.children = null;
                // This tile no longer has children, remove from parent tracking set
                this.parentTiles.delete(tile);
                this.invalidateCoverageCache(tile);
            }
            tile.parent = null;
            
            this.allTiles.delete(tile);
            delete this.tileCache[z][x][y];
            // Clean up empty objects to prevent memory leaks
            if (Object.keys(this.tileCache[z][x]).length === 0) {
                delete this.tileCache[z][x];
                if (Object.keys(this.tileCache[z]).length === 0) {
                    delete this.tileCache[z];
                }
            }
        }
    }

    // Helper to get all tiles as an array
    getAllTiles() {
        return [...this.allTiles];
    }

    // Helper to get tile count
    getTileCount() {
        return this.allTiles.size;
    }

    // Helper to get all tile keys (for Object.keys() replacement)
    getAllTileKeys() {
        const keys = [];
        for (const z in this.tileCache) {
            for (const x in this.tileCache[z]) {
                for (const y in this.tileCache[z][x]) {
                    keys.push(`${z}/${x}/${y}`);
                }
            }
        }
        return keys;
    }

    // Helper to iterate over all tiles using the flat Set for speed
    forEachTile(callback) {
        for (const tile of this.allTiles) {
            callback(tile);
        }
    }

    // // iterate over the tile by traversing the tree starting at 0,0,0
    // forEachTile(callback) {
    //     const root = this.tileCache[0]?.[0]?.[0]; // Start at the root tile (0,0,0)
    //     this.forEachTileRecurse(root, callback);
    // }
    //
    // forEachTileRecurse(node, callback) {
    //     callback(node); // Call the callback for the current node
    //     if (node.children) {
    //         for (let i = 0; i < 4; i++) {
    //             this.forEachTileRecurse(node.children[i], callback);
    //         }
    //     }
    // }


    /**
     * Get the effective maximum zoom level considering both maxZoom and maxDetails settings
     * @returns {number} The effective max zoom level
     */
    getEffectiveMaxZoom() {
        // If maxDetails is set in Globals.settings, use it as an additional limit
        if (Globals.settings && typeof Globals.settings.maxDetails === 'number') {
            return Math.min(this.maxZoom, Globals.settings.maxDetails);
        }
        return this.maxZoom;
    }

    initTiles() {
        if (this.dynamic) {
            this.initTilePositionsDynamic()
         } else {
             this.initTilePositions()
         }
    }

    refreshDebugGeometry(tile) {
        if (this.terrainNode.UI.debugElevationGrid) {
            tile.buildDebugGeometry(this.debugColor, this.debugAltitude)
        }
    }

    refreshDebugGrid(color, altitude = 0) {
        this.getAllTiles().forEach(tile => {
            this.debugColor = color
            this.debugAltitude = altitude
            tile.buildDebugGeometry(this.debugColor, this.debugAltitude)
        })
    }

    removeDebugGrid() {
        this.getAllTiles().forEach(tile => {
            tile.removeDebugGeometry()
        })
    }

    getOptions(providedOptions) {
        const options = Object.assign({}, providedOptions)
        options.tileSegments = Math.min(256, Math.round(options.tileSegments))
        return options
    }

    initTilePositions() {
        this.center = this.options.mapProjection.geo2Tile(this.geoLocation, this.zoom)
        const tileOffset = Math.floor(this.nTiles / 2)
        this.controller = new AbortController();
        for (let i = 0; i < this.nTiles; i++) {
            for (let j = 0; j < this.nTiles; j++) {
                const x = this.center.x + i - tileOffset;
                const y = this.center.y + j - tileOffset;
                // only add tiles that are within the bounds of the map
                // we allow the x values out of range
                // because longitude wraps around
                if (y > 0 && y < Math.pow(2, this.zoom)) {
                    // For initialization, use default mask that includes both main and look views
                    this.activateTile(x, y, this.zoom, LAYER.MASK_MAIN | LAYER.MASK_LOOK) // activate the tile
                }
            }
        }
    }


// dynamic setup just uses 1x1 tile, at 0,0 at zoom 0
    initTilePositionsDynamic(deferLoad = false) {
        this.center = this.options.mapProjection.geo2Tile(this.geoLocation, this.zoom)
        this.controller = new AbortController();

        this.zoom = 0;

        for (let i = 0; i < 1; i++) {
            for (let j = 0; j < 1; j++) {
                // For initialization, use default mask that includes both main and look views
                this.activateTile(i, j, this.zoom, LAYER.MASK_MAIN | LAYER.MASK_LOOK) // activate the tile
            }
        }
    }


    /**
     * Perform view-independent tile management operations
     * This should be called once per frame before processing individual views
     * 
     * Operations performed:
     * - Cleanup inactive tiles (cancel pending loads)
     * - Remove inactive tiles from scene
     * - Prune complete sets of inactive tiles
     * 
     * OPTIMIZATION: Combines all three operations into a single forEachTile() iteration
     * to reduce overhead from 3 iterations to 1 (67% reduction in tile iterations)
     */
    // Force-prune every inactive tile (tileLayers === 0) regardless of the
    // normal all-4-siblings rule. Used by the GPU Memory Monitor's manual
    // circuit-breaker button. Returns the count pruned.
    pruneAllInactive() {
        const tilesToPrune = [];
        for (const tile of this.allTiles) {
            // Only individual leaves — don't prune parents that still have
            // children (pruning a parent strands its child references).
            if (tile.tileLayers === 0 && !tile.children) {
                tilesToPrune.push(tile);
            }
        }
        let prunedCount = 0;
        tilesToPrune.forEach(child => {
            if (!child) return;
            if (child.mesh) {
                this.scene.remove(child.mesh);
                if (child.mesh.geometry) child.mesh.geometry.dispose();
                if (child.materialCacheKey && !child.materialCacheKey.startsWith('static_')) {
                    removeMaterialByCacheKeyImpl(child.materialCacheKey);
                } else if (child.mesh.material && !child.materialCacheKey) {
                    child.mesh.getMap()?.dispose();
                    child.mesh.material.dispose();
                }
            }
            if (child.skirtMesh) {
                this.scene.remove(child.skirtMesh);
                if (child.skirtMesh.geometry) child.skirtMesh.geometry.dispose();
                if (child.skirtMesh.material) child.skirtMesh.material.dispose();
            }
            child.cancelPendingLoads();
            this.deleteTile(child.x, child.y, child.z);
            prunedCount++;
        });
        return prunedCount;
    }

    // Effective timeout, scaled down for high maxDetails so tile creation
    // can't outrun pruning. 100 s at md=15 → 5 s at md=23.
    getEffectiveInactiveTileTimeout() {
        const md = Globals.settings?.maxDetails;
        if (typeof md !== "number" || md <= 15) return this.inactiveTileTimeout;
        if (md >= 23) return 5000;
        // Linear interp from 100 s (md=15) to 5 s (md=23).
        return Math.round(this.inactiveTileTimeout - ((md - 15) / 8) * (this.inactiveTileTimeout - 5000));
    }

    subdivideTilesGeneral() {
        // Skip subdivision for flat elevation maps
        if (this.constructor.name === 'QuadTreeMapElevation' && this.options.elevationType === "Flat") {
            return;
        }

        const now = Date.now();
        const effectiveTimeout = this.getEffectiveInactiveTileTimeout();
        let prunedCount = 0;
        
        // Collect tiles to prune (can't delete during iteration)
        const tilesToPrune = [];

        // COMBINED PASS: Process all tiles in a single iteration
        // Inlined iteration over allTiles Set to avoid callback overhead
        for (const tile of this.allTiles) {
            // OPERATION 1: Cleanup inactive tiles - cancel pending loads
            if (!tile.tileLayers && (tile.isLoading || tile.isLoadingElevation)) {
                tile.cancelPendingLoads();
            }

            // OPERATION 3: Identify tiles to prune (collect for deletion after iteration)
            const children = tile.children;
            if (children) {
                // Check if all four children meet pruning criteria
                let allChildrenPrunable = true;
                for (let i = 0; i < children.length; i++) {
                    const child = children[i];
                    if (!child) continue; // null/false children are prunable
                    if (child.tileLayers !== 0 || child.children !== null || !child.inactiveSince ||
                        now - child.inactiveSince < effectiveTimeout) {
                        allChildrenPrunable = false;
                        break;
                    }
                }

                if (allChildrenPrunable) {
                    // Collect children for pruning (delete after iteration completes)
                    tilesToPrune.push(...children);
                    tile.children = null; // Clear children reference from parent
                }
            }


            // if a dead branch, prune ALL its descendants
            if (tile.isDeadBranch) {
                const deadChildren = tile.children;
                if (deadChildren) {
                    let allChildrenPrunable = true;
                    for (let i = 0; i < deadChildren.length; i++) {
                        const child = deadChildren[i];
                        if (!child) continue;
                        if (child.children || child.isLoading) {
                            child.isDeadBranch = true; // mark as dead branch, so its descendants get pruned too
                            allChildrenPrunable = false; // can't prune this one yet
                        }
                    }

                    if (allChildrenPrunable) {
                        // Collect children for pruning (delete after iteration completes)
                        tilesToPrune.push(...deadChildren);

                        // dead branch pruning can prune active tiles too, so mark them as inactive
                        // (otherwise we get possible errors from aborting loads on active tiles)
                        for (let i = 0; i < deadChildren.length; i++) {
                            if (deadChildren[i]) deadChildren[i].tileLayers = 0;
                        }

                        tile.children = null; // Clear children reference from parent
                    }
                }
            }
        }

        // Prune collected tiles after iteration completes (safe to delete now)
        tilesToPrune.forEach(child => {
            if (!child) return;
            // Clean up the tile
            if (child.mesh) {
                this.scene.remove(child.mesh);
                if (child.mesh.geometry) child.mesh.geometry.dispose();
                // Free this tile's material+texture and evict its
                // materialCache entry. Without this, the cache (keyed by
                // tile-coords-bearing URL) grew monotonically with every
                // unique tile the camera ever revealed — the actual
                // VRAM-leak driver during long orbit/pan sessions.
                // Static-shared keys are pinned for the session: multiple
                // tiles share them, so disposing on one tile's prune would
                // break the others. Skip those.
                if (child.materialCacheKey && !child.materialCacheKey.startsWith('static_')) {
                    removeMaterialByCacheKeyImpl(child.materialCacheKey);
                } else if (child.mesh.material && !child.materialCacheKey) {
                    // Pre-eviction tiles (or non-cached materials) — fall back
                    // to inline disposal of whatever the mesh is using.
                    child.mesh.getMap()?.dispose();
                    child.mesh.material.dispose();
                }
            }
            if (child.skirtMesh) {
                this.scene.remove(child.skirtMesh);
                if (child.skirtMesh.geometry) child.skirtMesh.geometry.dispose();
                if (child.skirtMesh.material) child.skirtMesh.material.dispose();
            }

            // Cancel any pending loads
            child.cancelPendingLoads();

            // Remove from cache
            this.deleteTile(child.x, child.y, child.z);
            prunedCount++;
        });
        
        if (prunedCount > 0 && isLocal) {
            debugLog(`Pruned ${prunedCount} inactive tiles (${prunedCount / 4} sets of 4)`);
        }
    }

    /**
     * Subdivide or merge tiles based on view visibility and screen size
     * 
     * This method is called every frame from the update loop and manages the quadtree
     * structure by subdividing tiles that are too large on screen and merging tiles
     * that are too small.
     * 
     * LAZY LOADING & RACE CONDITION FIX:
     * For texture maps, this method implements deferred subdivision to fix a race condition
     * where child tiles would be created before parent textures finished loading. The fix:
     * 
     * 1. When a tile needs subdivision, check if parent is still loading (tile.isLoading)
     * 2. If loading, defer subdivision by returning early (retry next frame)
     * 3. Track deferred frames to implement a 60-frame timeout (~1 second)
     * 4. Once parent loads, subdivision proceeds and children can use parent texture data
     * 5. This ensures consistent lazy loading behavior regardless of page load speed
     * 
     * The deferred subdivision approach works because this method runs every frame,
     * so deferring just means "try again next frame when parent might be ready".
     * 
     * @param {Object} view - The view containing camera and viewport info
     * @param {number} errorTargetPixels - Refine while screen-space error per
     *     texel exceeds this many pixels. ~1.5 for texture, ~4 for elevation.
     *     A texel covering >1px on screen is "too coarse" and triggers refine.
     */
    subdivideTilesViewSpecific(view, errorTargetPixels = 1.5) {
        // Skip subdivision for flat elevation maps
        if (this.constructor.name === 'QuadTreeMapElevation' && this.options.elevationType === "Flat") {
            return;
        }
        // V5 Phase 0.1.b: per-pass timing for budget warn.
        const _v5CullStartMs = performance.now();

        // Whole-world coverage check used to assert here. Now relaxed: with
        // the per-view leaf-deactivation in PASS 3 below, out-of-frustum
        // leaves are intentionally deactivated and their (non-visible) area
        // becomes uncovered — that's the point. Visible-area coverage is
        // guaranteed by the subdivision pass keeping in-frustum tiles
        // active. World-wide coverage was an over-strict invariant.

        const camera = view.cameraNode.camera;
        const tileLayers = view.tileLayers;
        const isTextureMap = this.constructor.name === 'QuadTreeMapTexture';

        // Setup camera frustums for visibility checks. We build two:
        //   viewFrustum    — strict frustum that matches what will be rendered
        //   dilatedFrustum — slightly-wider frustum used as a preload margin
        //                    so tiles the user is about to pan to stay refined
        // The dilated frustum replaces the old `isNearCamera` radial bypass,
        // which was creating a column of high-LOD tiles directly under the
        // camera regardless of look direction.
        camera.updateMatrixWorld();
        const viewProjection = new Matrix4().multiplyMatrices(
            camera.projectionMatrix, camera.matrixWorldInverse
        );
        camera.viewFrustum = new Frustum().setFromProjectionMatrix(viewProjection);

        // Widen FOV by SUBDIVISION_FOV_DILATION for the subdivision frustum.
        // In a perspective projection, m[0]=f/aspect and m[5]=f where
        // f=1/tan(fov/2); dividing both by k widens the horizontal & vertical
        // FOV by factor k, leaving near/far planes untouched.
        const dilatedProj = camera.projectionMatrix.clone();
        dilatedProj.elements[0] /= SUBDIVISION_FOV_DILATION;
        dilatedProj.elements[5] /= SUBDIVISION_FOV_DILATION;
        camera.dilatedFrustum = new Frustum().setFromProjectionMatrix(
            new Matrix4().multiplyMatrices(dilatedProj, camera.matrixWorldInverse)
        );

        // Stash the per-pass viewport height (in pixels) on the camera so the
        // visibility check can compute screen-space error in real pixel units.
        // Fallback to 1080 if the view hasn't sized itself yet (early frames).
        camera._viewportHeightPx = view.heightPx || 1080;

        // Per-pass diagnostics. Cheap to populate; only allocated when stats
        // are enabled. Surfaced via logSubdivisionDiag() below.
        const diag = Globals.showTileStats ? {
            inStrictFrustum: 0,
            inDilatedMargin: 0,
            cameraInsideSphere: 0,
            horizonOccluded: 0,
            outOfFrustum: 0,
            forcedRoot: 0,
            subdivided: 0,
            merged: 0,
        } : null;

        // PASS 1: Debug logging (view-specific)
        if (Globals.showTileStats) {
           this.logDebugStats(tileLayers, view.id);
        } else {
            // Clear stats when flag is disabled
            this.currentStats.clear();
        }

        // PASS 2: Deactivate parent tiles whose children are fully loaded (texture maps only, view-specific)
        if (isTextureMap) {
            this.deactivateParentsWithLoadedChildren(tileLayers, camera);
        }

        // PASS 3: Process each tile for subdivision/merging and lazy loading
        // IMPORTANT: Collect subdivisions into a separate array and apply AFTER iteration.
        // JavaScript Set for...of visits newly-added elements during iteration, which causes
        // cascading subdivision (z3→z4→...→z15 in one frame) creating millions of tiles.
        // By deferring subdivisions, we limit to one zoom level per frame.
        const tilesToSubdivide = [];

        for (const tile of this.allTiles) {
            if (!this.canSubdivide(tile)) continue;

            const hasChildren = tile.children !== null;

            // Skip inactive tiles without children
            if (!tile.tileLayers && !hasChildren) continue;

            // OPTIMIZATION #7: Early exit for tiles not active in this view
            // Only process tiles that are either:
            // 1. Active in this view (for subdivision/lazy loading), OR
            // 2. Have children (for potential merging)
            const isActiveInView = (tile.tileLayers & tileLayers) !== 0;
            if (!isActiveInView && !hasChildren) continue;

            // Calculate visibility and screen size
            // This is expensive, so we only do it after early exit checks
            const visibility = this.calculateTileVisibility(tile, camera, diag);

            // OPTIMIZATION #7: Early exit for invisible tiles without children.
            // Now also DEACTIVATES the leaf if it's currently flagged for this
            // view. Without this, a tile that was once visible (and got
            // subdivided to a leaf) keeps its tile.tileLayers bit set forever
            // after the camera pans away — its mesh.layers.mask still has
            // this view's bit so the renderer keeps drawing it, even though
            // the per-tile WebGL frustum cull doesn't reject all such tiles
            // (especially coarse-zoom tiles whose bounding spheres are
            // hundreds of km in radius). For narrow-FOV cameras like a
            // 6° look view, this stale fan-out accounted for ~70% of
            // "active" tiles in the original buggy build — ~580 of 841
            // active tiles were entirely outside the camera frustum.
            //
            // Coverage of the visible area is preserved: tiles in the
            // frustum stay active; out-of-frustum leaves have nothing to
            // render at, so leaving their area uncovered is harmless. As
            // the camera pans into a previously-out-of-frustum area, the
            // normal subdivision pass repopulates from coarser ancestors
            // (which remain in the tile cache; deactivation only clears
            // the per-view bit, not the underlying data).
            if (!visibility.visible && !hasChildren) {
                if (isActiveInView) {
                    this.deactivateTile(tile, tileLayers, true);
                }
                continue;
            }

            // Handle lazy loading for visible tiles using parent data
            if (isTextureMap && visibility.actuallyVisible) {
                this.triggerLazyLoadIfNeeded(tile, tileLayers);
            }

            // Determine if subdivision is needed
            const shouldSubdivide = this.shouldSubdivideTile(tile, visibility, errorTargetPixels);

            // Surgical reactivation: when this tile is visible AND this view's
            // cascade WANTS to refine past this level (shouldSubdivide), scan
            // its children for ones that are in the frustum but currently
            // inactive in this view, and activate them in place. The
            // shouldSubdivide gate is essential: without it, surgical would
            // activate one zoom level deeper than this view actually wants
            // (whenever another view created children we didn't need), which
            // causes the cross-view leak — lookView's deeper subdivision
            // bleeds into mainView's active set because mainView's surgical
            // sees the children as visible and inactive.
            //
            // We deliberately do NOT reactivate the parent itself: doing so
            // would land it in the shouldSubdivide push path below and
            // re-trigger subdivideTile, which calls activateTile on ALL 4
            // children — including the out-of-frustum ones we intentionally
            // deactivated — and the next frame's leaf-deactivate would
            // clear them again. Per-child activation avoids that thrash.
            // Surgical fires when either:
            //   (a) this view's cascade wants to refine past this level
            //       (shouldSubdivide — the normal "going deeper" case), OR
            //   (b) this tile already has some active descendant in this view
            //       but other siblings are inactive (invariant 1 violation,
            //       typically left over from zoom-out into the SSE dead band
            //       where neither subdivide nor merge fires). Completing the
            //       partial subdivision lets the next deactivateParents pass
            //       see "all visible children covering" and hide the parent,
            //       resolving the violation without needing a deeper cascade.
            const hasActiveDescendant = hasChildren && this.hasAnyActiveDescendantForView(tile, tileLayers);
            if (visibility.visible && hasChildren && (shouldSubdivide || hasActiveDescendant)) {
                for (const child of tile.children) {
                    if (!child) continue;
                    if ((child.tileLayers & tileLayers) !== 0) continue;
                    // Skip z<3 children: calculateTileVisibility force-returns
                    // visible=true for tile.z<3 (SSE=infinity to keep root
                    // tiles loaded as fallback for lazy resampling), so an
                    // unconditional activation here would re-activate z=0/1/2
                    // every frame. They were intentionally deactivated by
                    // deactivateParentsWithLoadedChildren once their
                    // descendants covered the world — we keep them that way.
                    if (child.z < 3) continue;
                    const childVis = this.calculateTileVisibility(child, camera, null);
                    if (!childVis.visible) continue;
                    // INVARIANT 1: don't reactivate a tile that already has
                    // active descendants. If its grandchildren (or deeper)
                    // are rendering, this intermediate level should stay
                    // hidden. Without this guard, deactivateParents
                    // deactivates a parent (correctly, because children
                    // cover) and then surgical reactivation immediately
                    // re-activates it (because its own parent is iterating
                    // children) — they fight each frame, producing the
                    // z-fighting violations.
                    if (this.hasAnyActiveDescendantForView(child, tileLayers)) continue;
                    this.activateTile(child.x, child.y, child.z, tileLayers);
                }
            }

            // Hysteresis: a tile that no longer warrants subdivision (sse <=
            // target) only merges its children once SSE has dropped well
            // below the threshold. The dead band (target*factor, target]
            // keeps the tree stable while a tracked camera oscillates.
            // An invisible tile (sse=0) always satisfies the merge condition.
            const shouldMerge = !shouldSubdivide
                && visibility.screenSpaceError < errorTargetPixels * MERGE_HYSTERESIS_FACTOR;

            if (shouldSubdivide && isActiveInView && tile.z < this.maxZoom && !hasChildren) {
                // Only push LEAVES to subdivide. Tiles that already have
                // children skip this path because subdivideTile would call
                // activateTile on ALL 4 children — including ones we
                // intentionally deactivated (out-of-frustum). The surgical
                // reactivation above already handles per-child activation
                // for parents-with-children. Deeper refinement is driven by
                // the children themselves on subsequent passes (they become
                // leaves in the eyes of this gate once activated).
                //
                // RACE CONDITION FIX: Defer subdivision while parent tile is loading
                if (isTextureMap && tile.isLoading) {
                    if (!tile.subdivisionDeferredFrames) {
                        tile.subdivisionDeferredFrames = 0;
                    }
                    tile.subdivisionDeferredFrames++;

                    if (tile.subdivisionDeferredFrames < 60) {
                        continue; // Defer subdivision until next frame
                    }
                }

                tile.subdivisionDeferredFrames = 0;
                tilesToSubdivide.push(tile);
                continue;
            }

            // Check for merging children back to parent (gated by hysteresis)
            if (shouldMerge && hasChildren) {
                if (this.mergeChildrenIfPossible(tile, tileLayers) && diag) diag.merged++;
            }
        }

        // Apply collected subdivisions AFTER iteration to prevent cascade.
        // Children created here will be processed on the NEXT frame, not this one.
        for (const tile of tilesToSubdivide) {
            this.subdivideTile(tile, tileLayers, isTextureMap);
        }
        if (diag) {
            diag.subdivided = tilesToSubdivide.length;
            this.logSubdivisionDiag(diag, view.id);
        }

        // V5 Phase 0.1.b: per-pass timing + per-map activeTileHash writes.
        // Last-write-wins per (view, map) for cullSelfTimeMs to avoid a
        // sticky peak that locks the budget warn. activeTileHash recorded
        // per map (texture vs elevation) so MCP procedures can compare
        // independently across mode flips.
        const _v5StatsBag = Globals.tileCullStats?.[view.id];
        if (_v5StatsBag) {
            const _v5SelfMs = performance.now() - _v5CullStartMs;
            const _v5MapKind = isTextureMap ? "texture" : "elevation";
            if (!_v5StatsBag.cullSelfTimeMsPerMap) {
                _v5StatsBag.cullSelfTimeMsPerMap = {texture: 0, elevation: 0};
            }
            _v5StatsBag.cullSelfTimeMsPerMap[_v5MapKind] = _v5SelfMs;
            _v5StatsBag.cullSelfTimeMs = Math.max(
                _v5StatsBag.cullSelfTimeMsPerMap.texture,
                _v5StatsBag.cullSelfTimeMsPerMap.elevation,
            );
            if (!_v5StatsBag.activeTileHashPerMap) {
                _v5StatsBag.activeTileHashPerMap = {texture: 0, elevation: 0};
            }
            _v5StatsBag.activeTileHashPerMap[_v5MapKind] = computeActiveTileHash(this.allTiles, tileLayers);
            // Legacy single-value field: texture-map hash drives visible content.
            _v5StatsBag.activeTileHash = _v5StatsBag.activeTileHashPerMap.texture;
            if (_v5SelfMs > Globals.tileCullBudgetMs && Globals.showTileStats) {
                console.warn(`[QuadTreeMap/${view.id}] cull ${_v5SelfMs.toFixed(2)}ms exceeds ${Globals.tileCullBudgetMs}ms budget`);
            }
        }
    }

    /**
     * Log per-pass subdivision diagnostics. Only called when Globals.showTileStats
     * is enabled. Logs only when something interesting changed (subdivisions,
     * merges, or culled-tile counts shifted by >5%) to keep the console quiet.
     */
    logSubdivisionDiag(diag, viewId) {
        const viewKey = viewId || 'View';
        if (!this._lastSubdivisionDiag) this._lastSubdivisionDiag = new Map();
        const last = this._lastSubdivisionDiag.get(viewKey);

        const interesting = diag.subdivided > 0 || diag.merged > 0
            || !last
            || Math.abs(diag.outOfFrustum   - last.outOfFrustum)   > Math.max(5, last.outOfFrustum   * 0.05)
            || Math.abs(diag.inDilatedMargin - last.inDilatedMargin) > Math.max(2, last.inDilatedMargin * 0.05)
            || Math.abs(diag.inStrictFrustum - last.inStrictFrustum) > Math.max(5, last.inStrictFrustum * 0.05);

        if (interesting) {
            debugLog(`[${viewKey}/${this.constructor.name}] strict=${diag.inStrictFrustum} margin=${diag.inDilatedMargin} insideSphere=${diag.cameraInsideSphere} horizon=${diag.horizonOccluded} outFrustum=${diag.outOfFrustum} forcedRoot=${diag.forcedRoot} +sub=${diag.subdivided} +merge=${diag.merged}`);
            this._lastSubdivisionDiag.set(viewKey, { ...diag });
        }
    }

    /**
     * Log debug statistics about tile states
     */
    logDebugStats(tileLayers, viewId) {
        let totalTileCount = this.getTileCount();
        let pendingLoads = 0;
        let lazyLoading = 0;
        let activeTileCount = 0;
        let inactiveTileCount = 0;

        this.forEachTile((tile) => {
            if (tile.tileLayers && (tile.tileLayers & tileLayers)) {
                activeTileCount++;
            } else {
                inactiveTileCount++;
            }
            if (tile.isLoading) pendingLoads++;
            // Count active tiles using parent data (whether load is pending or not)
            if (tile.usingParentData && (tile.tileLayers & tileLayers)) {
                lazyLoading++;
            }
        });

        // Store current stats for debug display
        const viewKey = viewId || 'View';
        const currentStats = { totalTileCount, activeTileCount, inactiveTileCount, pendingLoads, lazyLoading };
        this.currentStats.set(viewKey, currentStats);
        
        // Only log if counts changed from last time
        if (pendingLoads > 0 || lazyLoading > 0) {
            const lastStats = this.lastLoggedStats.get(viewKey);
            
            // Check if any value changed
            if (!lastStats || 
                lastStats.totalTileCount !== totalTileCount ||
                lastStats.activeTileCount !== activeTileCount ||
                lastStats.inactiveTileCount !== inactiveTileCount ||
                lastStats.pendingLoads !== pendingLoads ||
                lastStats.lazyLoading !== lazyLoading) {
                
                debugLog(`[${viewKey}] Total: ${totalTileCount}, Active: ${activeTileCount}, Inactive: ${inactiveTileCount}, Pending: ${pendingLoads}, Lazy: ${lazyLoading}`);
                this.lastLoggedStats.set(viewKey, currentStats);
            }
        }
    }

    /**
     * Deactivate parent tiles when their descendants cover the parent's area.
     * OPTIMIZATION: Only iterates over tiles that have children (tracked in parentTiles Set)
     * instead of all tiles. With 100 tiles, typically only 10-25 are parents (75-90% reduction).
     */
    // True if any descendant (immediate child or deeper) has the given view's
    // bit set in tileLayers. Used by surgical reactivation in
    // subdivideTilesViewSpecific to enforce REPLACE-refinement invariant 1
    // (active descendant ⟹ ancestor hidden) — without it, the surgical
    // would re-activate a parent that deactivateParentsWithLoadedChildren
    // just hid, undoing the work each frame. Recursion depth is bounded by
    // tree depth (~15 levels max).
    hasAnyActiveDescendantForView(tile, tileLayers) {
        if (!tile.children) return false;
        for (const child of tile.children) {
            if (!child) continue;
            if ((child.tileLayers & tileLayers) !== 0) return true;
            if (this.hasAnyActiveDescendantForView(child, tileLayers)) return true;
        }
        return false;
    }

    deactivateParentsWithLoadedChildren(tileLayers, camera = null) {
        // Iterate the full parentTiles set rather than just `_dirtyParents`.
        // Dirty tracking is layer-mask-change driven, so a parent that got
        // processed while its children were still loading never gets re-
        // marked dirty when the children finish (loading completion doesn't
        // flip a layer mask). That left ~62 stale parents active alongside
        // their loaded children, producing the z-fight visualization the
        // user reported. visibleAreaCoveredByDescendants below handles the
        // still-loading case correctly via its anyChildVisible gate, so the
        // full-set iteration is safe — it just catches missed dirty entries.
        // Cost: parentTiles is typically 25% of total tiles (~90 calls per
        // pass on a 360-tile scene), and each call is cheap (4 children ×
        // sphere-frustum + horizon test).
        this._dirtyParents.clear();

        for (const tile of this.parentTiles) {
            if (!tile.children) continue;       // already pruned
            if (tile.z >= this.maxZoom) continue;
            if (tile.isLoading) continue;
            if (tile.isDeadBranch) continue;
            // Only check if tile is still active in this view
            if (!(tile.tileLayers & tileLayers)) continue;

            // Use the visibility-aware coverage check when camera is provided.
            // Without it, the strict areaCoveredByDescendants would refuse to
            // deactivate any parent that has even one out-of-frustum-inactive
            // sibling, leaving the parent rendering alongside in-frustum
            // active children (the z-fighting case). Passing the camera lets
            // the check ignore children whose own area isn't visible.
            const covered = camera
                ? this.visibleAreaCoveredByDescendants(tile, tileLayers, camera)
                : this.areaCoveredByDescendants(tile, tileLayers);
            if (covered) {
                this.deactivateTile(tile, tileLayers, true);
            }
        }
    }

    /**
     * Calculate visibility and screen size for a tile.
     *
     * Eligibility gate is the dilated frustum (subdivision preload margin),
     * not a radial near-camera test — the latter caused massive over-subdivision
     * directly under the camera regardless of look direction. Anything outside
     * the dilated frustum returns visible=false and is not refined.
     *
     * Phase 2 will replace the screenFraction*1024 heuristic with proper SSE
     * (geometricError * screenHeight / (distance * 2 * tan(fov/2))).
     */
    calculateTileVisibility(tile, camera, diag = null) {
        const worldSphere = tile.getWorldSphere();
        let screenSpaceError = 0;
        let visible = false;

        // Estimate the tile's terrain altitude (max elevation, in metres above
        // the WGS84 ellipsoid). The cached worldSphere is built from corners
        // at alt=0, so its centre sits at sea level — fine for low-elevation
        // sitches but catastrophic for elevated terrain (Wyoming, Sierras,
        // Andes): the sphere centre ends up radially below the actual mesh
        // by the elevation, putting it well off the camera's gaze axis. The
        // frustum check then misses the truck-area tiles entirely and only
        // hits tiles where the camera ray exits the planet at sea level —
        // 2-5 km behind the actual ground intersection.
        //
        // Bootstrap: walk up the parent chain to find the nearest ancestor
        // with loaded elevation. Coarse tiles (z<10) have radii of km, so
        // their sphere reaches the camera ray even when centred at sea
        // level — they load their elevation first, then their descendants
        // inherit the estimate via this walk. No global default needed.
        let terrainAlt = tile.highestAltitude || 0;
        if (terrainAlt === 0) {
            let p = tile.parent;
            while (p) {
                if (p.highestAltitude > 0) {
                    terrainAlt = p.highestAltitude;
                    break;
                }
                p = p.parent;
            }
        }

        // Build the actual culling sphere: shift the centre radially outward
        // by the full estimated terrain altitude. We do NOT enlarge the
        // radius — terrain elevation variance within a single tile is small
        // (tens of metres even in mountainous areas) compared to the tile's
        // horizontal extent, so the sea-level corner radius already covers it.
        //
        // Earlier attempts grew the radius to enclose both sea level AND the
        // highest terrain, which made the sphere ~10× larger than the actual
        // tile mesh. That caused wildly off-axis spheres to pass the frustum
        // check, yielding subdivision over an area ~30× wider than the
        // visible cone for narrow-FOV cameras (a Predator gimbal at ~1.9°
        // FOV ended up subdividing a ~30° cone).
        //
        // Trade-off: in a tile with large local relief (e.g. a z=14 tile
        // spanning a Sierra valley-to-peak), the parent-walk's highestAltitude
        // estimate is conservative on the high side, so the sphere may miss
        // the lowest valley terrain. That's a much smaller failure than the
        // alternative.
        let cx = worldSphere.center.x;
        let cy = worldSphere.center.y;
        let cz = worldSphere.center.z;
        const radius = worldSphere.radius;
        if (terrainAlt > 0) {
            const r = Math.sqrt(cx * cx + cy * cy + cz * cz);
            const scale = (r + terrainAlt) / r;
            cx *= scale; cy *= scale; cz *= scale;
        }
        _cullingSphere.center.set(cx, cy, cz);
        _cullingSphere.radius = radius;

        const dx = camera.position.x - cx;
        const dy = camera.position.y - cy;
        const dz = camera.position.z - cz;
        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const closestDistance = Math.max(0, distance - radius);

        const inDilated = camera.dilatedFrustum.intersectsSphere(_cullingSphere);
        const inStrict  = camera.viewFrustum.intersectsSphere(_cullingSphere);

        if (inDilated) {
            // Screen-space error in pixels = geometric error (meters per texel
            // at this tile's zoom and latitude) projected to screen pixels.
            // Distance is camera-to-sphere-center, clamped so an inside-the-
            // sphere camera doesn't produce a divide-by-zero.
            const cosLat = Math.cos(tile._centerLatRad || 0);
            const tileSpanMeters = (EARTH_CIRCUMFERENCE_M * cosLat) / Math.pow(2, tile.z);
            const metersPerTexel = tileSpanMeters / 256;
            const fovRad = camera.getEffectiveFOV() * Math.PI / 180;
            const viewportHeightPx = camera._viewportHeightPx || 1080;
            const projDistance = Math.max(distance, radius * 0.1);
            screenSpaceError = (metersPerTexel * viewportHeightPx) /
                               (projDistance * 2 * Math.tan(fovRad / 2));

            if (closestDistance < radius * 0.1) {
                // Camera is essentially inside the bounding sphere — obviously
                // visible, skip the horizon check.
                visible = true;
                if (diag) diag.cameraInsideSphere++;
            } else {
                // Cull below-horizon and globe-occluded tiles for distant cases.
                const cameraAltitude = altitudeAboveSphere(_cameraPositionClone.copy(camera.position));
                const horizon = distanceToHorizon(cameraAltitude);

                if (horizon > closestDistance ||
                    hiddenByGlobe(cameraAltitude, closestDistance) <= tile.highestAltitude) {
                    visible = true;
                    if (diag) {
                        if (inStrict) diag.inStrictFrustum++;
                        else diag.inDilatedMargin++;
                    }
                } else if (diag) {
                    diag.horizonOccluded++;
                }
            }
        } else if (diag) {
            diag.outOfFrustum++;
        }

        // Force load of the first 3 zoom levels for the texture map only,
        // so the lazy-load fallback always has *some* parent texture to
        // resample from while higher-zoom tiles fetch. Elevation root tiles
        // are skipped — they're useless at any camera position where SSE
        // wouldn't already refine them.
        if (tile.z < 3 && this.constructor.name === 'QuadTreeMapTexture') {
            screenSpaceError = Math.max(screenSpaceError, Number.POSITIVE_INFINITY);
            visible = true;
            if (diag) diag.forcedRoot++;
        }

        return {
            screenSpaceError,
            visible,
            actuallyVisible: visible,
            frustumIntersects: inStrict,
        };
    }

    /**
     * Trigger lazy loading for tiles using parent data
     * This is called for tiles that are actuallyVisible (visible and not fully occluded).
     * Includes tiles with center behind the camera, as long as the frustum intersects them.
     */
    triggerLazyLoadIfNeeded(tile, tileLayers) {
        // Only load if tile is using parent data, needs high-res, not currently loading, and active in this view
        const needsLoad = tile.usingParentData &&
                         tile.needsHighResLoad &&
                         !tile.isLoading &&
                         !tile.isCancelling &&
                         (tile.tileLayers & tileLayers);

        // Debug: log why lazy loading isn't triggering
        if (tile.usingParentData && tile.needsHighResLoad && !needsLoad) {
            debugLog(`Lazy load blocked for ${tile.z}/${tile.x}/${tile.y}: isLoading=${tile.isLoading}, isCancelling=${tile.isCancelling}, tileLayers=${tile.tileLayers}, viewLayers=${tileLayers}`);
        }

        // Trigger high-res load if all conditions are met
        if (needsLoad) {
            tile.needsHighResLoad = false; // Clear flag to prevent repeated triggers
            const key = `${tile.z}/${tile.x}/${tile.y}`;

            const materialPromise = tile.applyMaterial().then(() => {
                tile.usingParentData = false; // Mark as using high-res data now
            }).catch(error => {
                // Reset flag to retry - whether it's an abort or real error
                tile.needsHighResLoad = true;
            });
            
            this.trackTileLoading(`${key}-highres`, materialPromise);
        }
    }

    /**
     * Determine if a tile should be subdivided.
     *
     * Refines while the tile's screen-space error (meters-per-texel projected
     * to screen pixels) exceeds the per-pixel error target. Lower target →
     * sharper imagery and more tiles; higher target → coarser and faster.
     */
    shouldSubdivideTile(tile, visibility, errorTargetPixels) {

        // don't subdivide if this is a dead branch (i.e. child tile gave a loading error)
        if (tile.isDeadBranch) {
            return false;
        }

        // Don't subdivide if we're at or beyond the effective max zoom
        const effectiveMaxZoom = this.getEffectiveMaxZoom();
        if (tile.z >= effectiveMaxZoom) {
            return false;
        }

        return visibility.visible && visibility.screenSpaceError > errorTargetPixels;
    }

    /**
     * Subdivide a tile into 4 children
     */
    subdivideTile(tile, tileLayers, isTextureMap) {
        // Check if parent tile has usable texture data for lazy loading
        // We need:
        // 1. A mesh with material (tile is initialized)
        // 2. A texture map (material.map exists)
        // 3. Not a wireframe material (actual texture is loaded, not placeholder)
        //
        // This check ensures we only use parent data when the texture has actually loaded.
        // During loading, tiles have a wireframe material, so this check will be false.
        // After the deferred subdivision logic above, this should be true (parent loaded).
        const useParentData = isTextureMap && tile.mesh && tile.mesh.material && 
                             tile.mesh.getMap() && !tile.mesh.material.wireframe;

        // Create 4 child tiles (standard quadtree subdivision)
        // note activateTile will set the parent tile automatically
        const child1 = this.activateTile(tile.x * 2,     tile.y * 2, tile.z + 1, tileLayers, useParentData);
        const child2 = this.activateTile(tile.x * 2 + 1, tile.y * 2, tile.z + 1, tileLayers, useParentData);

        let child3, child4;

        // normally we create all 4 children
        // but for zoom level 0 on GoogleCRS84Quad tiles, only use the 2 children above (both with y=0)
        const z = tile.z;
        if (z>0 || (tile.map && tile.map.options.mapProjection.name === "GoogleMapsCompatible")) {
            child3 = this.activateTile(tile.x * 2,     tile.y * 2 + 1, tile.z + 1, tileLayers, useParentData);
            child4 = this.activateTile(tile.x * 2 + 1, tile.y * 2 + 1, tile.z + 1, tileLayers, useParentData);
            tile.children = [child1, child2, child3, child4];
        } else {
            // GoogleCRS84Quad tile 0,0,0 only has 2 children, the y=1 (bottom half) is nulled
            tile.children = [child1, child2, null, null];
        }


        // Track this tile as a parent for efficient iteration
        this.parentTiles.add(tile);
        this.invalidateCoverageCache(tile);

        // For texture maps: Deactivate parent if all children are loaded and added
        // (even if using parent data - that's valid for display, just lower quality)
        if (isTextureMap) {
            if (this.areaCoveredByDescendants(tile, tileLayers)) {
                this.deactivateTile(tile, tileLayers, true); // instant=true to hide parent immediately
            }
            // Otherwise parent stays active until children are ready
            // (deactivateParentsWithLoadedChildren will handle it on next frame)
        } else {
            // Elevation maps: always deactivate parent immediately
            this.deactivateTile(tile, tileLayers);
        }
    }

    /**
     * Merge children back to parent if at least one child is currently active
     * in this view. The strict "all 4 children active" check was correct in
     * the original design but breaks once the leaf-deactivate pass starts
     * intentionally clearing out-of-frustum children: with some children
     * already deactivated, the merge would never fire, leaving over-detailed
     * tiles active forever (the "zoom out doesn't collapse" bug). Relaxing
     * to "any child active" is safe because the inactive siblings have no
     * coverage we'd be losing — they were already out-of-frustum-deactivated.
     */
    mergeChildrenIfPossible(tile, tileLayers) {
        const children = this.getChildren(tile);
        if (!children) return false;

        const anyChildActiveInView = children.some(child =>
            child && (child.tileLayers & tileLayers)
        );

        if (anyChildActiveInView) {
            this.activateTile(tile.x, tile.y, tile.z, tileLayers);
            children.forEach(child => {
                if (child) {
                    this.deactivateBranch(child, tileLayers, true);
                }
            });
            return true;
        }
        return false;
    }

    deactivateBranch(tile, layerMask = 0, instant = false) {
        // deactivate this tile
        this.deactivateTile(tile, layerMask, instant);
        if (tile.children) {
            // recursively deactivate children
            for (let child of tile.children) {
                if (child) {
                    this.deactivateBranch(child, layerMask, instant);
                }
            }
        }
    }

    /**
     * Check if tile has children
     * All tiles have either 0 or 4 children, so we can simply check if children array is null
     */
    hasChildren(tile) {
        return tile.children !== null;
    }

    /**
     * Get all 4 children of a tile (returns null if any are missing)
     */
    getChildren(tile) {
        return tile.children;
    }
    
    /**
     * Get the parent of a tile
     * If tile.parent is already set, return it (fast path)
     * Otherwise, calculate parent coordinates and look it up in the cache
     */
    getParent(tile) {
        // Fast path: if parent is already set in tree structure, return it
        if (tile.parent) {
            return tile.parent;
        }
        
        // Fallback: calculate parent coordinates and look it up
        // This is needed when setting up the tree structure for newly created tiles
        if (tile.z === 0) {
            return null; // Root tile has no parent
        }
        
        const parentX = Math.floor(tile.x / 2);
        const parentY = Math.floor(tile.y / 2);
        const parentZ = tile.z - 1;
        return this.getTile(parentX, parentY, parentZ);
    }

    // Set the layer mask on a tile's mesh objects
    setTileLayerMask(tile, layerMask) {
        const oldMask = tile.mesh ? tile.mesh.layers.mask : 0;

        if (tile.mesh) {
            tile.mesh.layers.mask = layerMask;
        }
        if (tile.skirtMesh) {
            tile.skirtMesh.layers.mask = layerMask;
        }
        
        if (oldMask !== layerMask) {
            this.invalidateCoverageCache(tile);
            EventManager.dispatchEvent("tileVisibilityChanged", {tile, oldMask, newMask: layerMask});
        }
    }


}




