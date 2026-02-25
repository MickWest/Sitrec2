import {wgs84} from "./LLA-ECEF-ENU";
import {Frustum, Matrix4, Vector3} from "three";
import {debugLog, Globals} from "./Globals";
import {isLocal} from "./configUtils";
import {altitudeAboveSphere, distanceToHorizon, hiddenByGlobe} from "./SphericalMath";
import * as LAYER from "./LayerMasks";
import {assert} from "./assert";
import "./threeExt";
import {EventManager} from "./CEventManager";

// Reusable Vector3 objects to avoid garbage collection pressure
// These are reused across all tile visibility calculations
const _cameraForward = new Vector3();
const _toSphere = new Vector3();
const _cameraPositionClone = new Vector3();

///////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// QuadTreeMap is the base class of a QuadTreeMapTexture and a QuadTreeMapElevation
export class QuadTreeMap {
    constructor(terrainNode, geoLocation, options) {
        this.options = this.getOptions(options)
        this.nTiles = this.options.nTiles
        this.zoom = this.options.zoom
        this.tileSize = this.options.tileSize
        // Web Mercator tile math uses spherical radius — correct for tile indexing.
        // Vertex positioning uses LLAToEUS() which reads Globals.equatorRadius/polarRadius.
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
        this.inactiveTileTimeout = 100000; // Time in ms before pruning inactive tiles (100 seconds)
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
    subdivideTilesGeneral() {
        // Skip subdivision for flat elevation maps
        if (this.constructor.name === 'QuadTreeMapElevation' && this.options.elevationType === "Flat") {
            return;
        }

        const now = Date.now();
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
                        now - child.inactiveSince < this.inactiveTileTimeout) {
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
                if (child.mesh.material) {
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
     * @param {number} subdivideSize - Screen size threshold for subdivision (default: 2000)
     */
    subdivideTilesViewSpecific(view, subdivideSize = 2000) {
        // Skip subdivision for flat elevation maps
        if (this.constructor.name === 'QuadTreeMapElevation' && this.options.elevationType === "Flat") {
            return;
        }

        // debug code - check for holes in the map
        // the root tile covers the whole world, so if it's not active, then check if it's covered by the descendants
        if (isLocal) {
            if (this.constructor.name === 'QuadTreeMapTexture') {
                const rootTile = this.getTile(0, 0, 0);

                if (!(rootTile.mesh.layers.mask & view.tileLayers)) {
                    if (!this.areaCoveredByDescendants(rootTile, view.tileLayers)) {
                        this.dumpChildren(rootTile);
                        console.log(this.areaCoveredByDescendants(rootTile, view.tileLayers));
                        // root tile is not active in this view - so check area coverage
                        assert(0, "Root tile area is not covered!");
                    }
                }
            }
        }

        const camera = view.cameraNode.camera;
        const tileLayers = view.tileLayers;
        const isTextureMap = this.constructor.name === 'QuadTreeMapTexture';

        // Setup camera frustum for visibility checks
        camera.updateMatrixWorld();
        const frustum = new Frustum();
        frustum.setFromProjectionMatrix(new Matrix4().multiplyMatrices(
            camera.projectionMatrix, camera.matrixWorldInverse
        ));
        camera.viewFrustum = frustum;

        // PASS 1: Debug logging (view-specific)
        if (Globals.showTileStats) {
           this.logDebugStats(tileLayers, view.id);
        } else {
            // Clear stats when flag is disabled
            this.currentStats.clear();
        }

        // PASS 2: Deactivate parent tiles whose children are fully loaded (texture maps only, view-specific)
        if (isTextureMap) {
            this.deactivateParentsWithLoadedChildren(tileLayers);
        }

        // PASS 3: Process each tile for subdivision/merging and lazy loading
        // Inlined iteration over allTiles Set to avoid callback overhead (hot path)
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
            const visibility = this.calculateTileVisibility(tile, camera);

            // OPTIMIZATION #7: Early exit for invisible tiles without children
            // If tile is not visible and has no children to merge, skip further processing
            if (!visibility.visible && !hasChildren) continue;

            // Handle lazy loading for visible tiles using parent data
            if (isTextureMap && visibility.actuallyVisible) {
                this.triggerLazyLoadIfNeeded(tile, tileLayers);
            }

            // Determine if subdivision is needed
            const shouldSubdivide = this.shouldSubdivideTile(tile, visibility, subdivideSize);

            if (shouldSubdivide && isActiveInView && tile.z < this.maxZoom) {
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

                this.subdivideTile(tile, tileLayers, isTextureMap);
                continue; // Process one subdivision at a time
            }

            // Check for merging children back to parent
            if (!shouldSubdivide && hasChildren) {
                this.mergeChildrenIfPossible(tile, tileLayers);
            }
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
    deactivateParentsWithLoadedChildren(tileLayers) {
        if (this._dirtyParents.size === 0) return;

        // Process only parents whose children changed state.
        // Copy to array since deactivateTile may trigger further invalidations.
        const toCheck = [...this._dirtyParents];
        this._dirtyParents.clear();

        for (let i = 0; i < toCheck.length; i++) {
            const tile = toCheck[i];
            if (!tile.children) continue;       // already pruned
            if (tile.z >= this.maxZoom) continue;
            if (tile.isLoading) continue;
            if (tile.isDeadBranch) continue;
            // Only check if tile is still active in this view
            if (!(tile.tileLayers & tileLayers)) continue;

            if (this.areaCoveredByDescendants(tile, tileLayers)) {
                this.deactivateTile(tile, tileLayers, true);
            }
        }
    }

    /**
     * Calculate visibility and screen size for a tile
     */
    calculateTileVisibility(tile, camera) {
        const worldSphere = tile.getWorldSphere();
        let screenSize = 0;
        let visible = false;
        let actuallyVisible = false;

        const radius = worldSphere.radius;
        const distance = camera.position.distanceTo(worldSphere.center);
        const closestDistance = Math.max(0, distance - radius);

        // CRITICAL: Check if camera is close to the tile BEFORE frustum check.
        // A tile directly underneath/behind the camera won't intersect the view frustum,
        // but it still needs high-res textures because it's nearby and could come into view.
        // Use a generous threshold - within 2x the tile's radius.
        const isNearCamera = closestDistance < radius * 2;

        // Check frustum intersection
        const frustumIntersects = camera.viewFrustum.intersectsSphere(worldSphere);

        if (frustumIntersects || isNearCamera) {
            // Check if sphere center is behind the camera
            const cameraForward = camera.getWorldDirection(_cameraForward);
            const toSphere = _toSphere.copy(worldSphere.center).sub(camera.position);
            const projectionOnForward = toSphere.dot(cameraForward);

            // If center is behind camera OR tile is near camera (regardless of frustum),
            // force subdivision and enable lazy loading
            if (projectionOnForward < 0 || (isNearCamera && !frustumIntersects)) {
                screenSize = 1000000; // Force subdivision for nearby/behind tiles
                visible = true;
                actuallyVisible = true;
            } else {
                // Normal case: center is in front of camera and in frustum
                // If camera is inside or very close to the bounding sphere,
                // skip horizon checks - the tile is obviously visible
                if (closestDistance < radius * 0.1) {
                    const fov = camera.getEffectiveFOV() * Math.PI / 180;
                    const height = 2 * Math.tan(fov / 2) * distance;
                    const screenFraction = (2 * radius) / height;
                    screenSize = screenFraction * 1024;
                    visible = true;
                    actuallyVisible = true;
                } else {
                    // Perform horizon and globe occlusion checks for distant tiles
                    const cameraAltitude = altitudeAboveSphere(_cameraPositionClone.copy(camera.position));
                    const horizon = distanceToHorizon(cameraAltitude);

                    // Check if visible over horizon
                    if (horizon > closestDistance ||
                        hiddenByGlobe(cameraAltitude, closestDistance) <= tile.highestAltitude) {

                        const fov = camera.getEffectiveFOV() * Math.PI / 180;
                        const height = 2 * Math.tan(fov / 2) * distance;
                        const screenFraction = (2 * radius) / height;
                        screenSize = screenFraction * 1024;
                        visible = true;
                        actuallyVisible = true;
                    }
                }
            }
        }

        // Force subdivision for first 3 zoom levels
        if (tile.z < 3) {
            screenSize = 10000000000;
            visible = true;
            // For low zoom tiles that cover large areas, also enable lazy loading
            // These tiles are always "visible" in the sense that they provide texture data
            actuallyVisible = true;
        }

        // IMPORTANT: If a tile is visible (will be rendered), it should be eligible for lazy loading.
        // The distinction between visible and actuallyVisible was causing tiles to stay at low resolution.
        if (visible) {
            actuallyVisible = true;
        }

        return {
            screenSize,
            visible,
            actuallyVisible,
            frustumIntersects
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
     * Determine if a tile should be subdivided
     */
    shouldSubdivideTile(tile, visibility, subdivideSize) {

        // don't subdivide if this is a dead branch (i.e. child tile gave a loading error)
        if (tile.isDeadBranch) {
            return false;
        }

        // Don't subdivide if we're at or beyond the effective max zoom
        const effectiveMaxZoom = this.getEffectiveMaxZoom();
        if (tile.z >= effectiveMaxZoom) {
            return false;
        }
        
        return visibility.visible && visibility.screenSize > subdivideSize;
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
     * Merge children back to parent if they're all active in this view
     */
    mergeChildrenIfPossible(tile, tileLayers) {

        // THIS NEEDS TO CONSIDER ALL THE DESCENDANTS, NOT JUST THE IMMEDIATE CHILDREN
        // AND DEACTIVE THEM ALL
        // also fixe where it's not finding any elevation data!!!!!


        const children = this.getChildren(tile);
        if (!children) return;

        const allChildrenActiveInView = children.every(child =>
            child && (child.tileLayers & tileLayers)
        );

        if (allChildrenActiveInView) {
            this.activateTile(tile.x, tile.y, tile.z, tileLayers);
            children.forEach(child => {
                if (child) {
                    this.deactivateBranch(child, tileLayers, true);
                }
            });
        }
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




