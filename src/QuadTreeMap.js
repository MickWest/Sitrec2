import {wgs84} from "./LLA-ECEF-ENU";
import {Matrix4} from "three/src/math/Matrix4";
import {Frustum} from "three/src/math/Frustum";
import {Vector3} from "three/src/math/Vector3";
import {debugLog} from "./Globals";
import {isLocal} from "./configUtils";
import {altitudeAboveSphere, distanceToHorizon, hiddenByGlobe} from "./SphericalMath";
import * as LAYER from "./LayerMasks";


///////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// QuadTreeMap is the base class of a QuadTreeMapTexture and a QuadTreeMapElevation
export class QuadTreeMap {
    constructor(terrainNode, geoLocation, options) {
        this.options = this.getOptions(options)
        this.nTiles = this.options.nTiles
        this.zoom = this.options.zoom
        this.tileSize = this.options.tileSize
        this.radius = wgs84.RADIUS; // force this
        this.loadedCallback = options.loadedCallback; // function to call when map is all loaded
        this.loaded = false; // mick flag to indicate loading is finished
        this.tileCache = {};
        this.terrainNode = terrainNode
        this.geoLocation = geoLocation
        this.dynamic = options.dynamic || false; // if true, we use a dynamic tile grid
        this.maxZoom = options.maxZoom ?? 15; // default max zoom level
        this.minZoom = options.minZoom ?? 0; // default min zoom level
        this.lastLoggedStats = new Map(); // Track last logged stats per view to reduce console spam
        this.inactiveTileTimeout = 1000; // Time in ms before pruning inactive tiles (1 seconds)
        this.currentStats = new Map(); // Store current stats per view for debug display

    }

    // Helper methods for nested cache access
    getTile(x, y, z) {
        return this.tileCache[z] && this.tileCache[z][x] && this.tileCache[z][x][y];
    }

    setTile(x, y, z, tile) {
        if (!this.tileCache[z]) this.tileCache[z] = {};
        if (!this.tileCache[z][x]) this.tileCache[z][x] = {};
        this.tileCache[z][x][y] = tile;
    }

    deleteTile(x, y, z) {
        if (this.tileCache[z] && this.tileCache[z][x] && this.tileCache[z][x][y]) {
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

    // Helper to get all tiles (for Object.values() replacement)
    getAllTiles() {
        const tiles = [];
        for (const z in this.tileCache) {
            for (const x in this.tileCache[z]) {
                for (const y in this.tileCache[z][x]) {
                    tiles.push(this.tileCache[z][x][y]);
                }
            }
        }
        return tiles;
    }

    // Helper to get tile count (more efficient than getAllTileKeys().length)
    getTileCount() {
        let count = 0;
        for (const z in this.tileCache) {
            for (const x in this.tileCache[z]) {
                count += Object.keys(this.tileCache[z][x]).length;
            }
        }
        return count;
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

    // Helper to iterate over all tiles
    forEachTile(callback) {
        for (const z in this.tileCache) {
            for (const x in this.tileCache[z]) {
                for (const y in this.tileCache[z][x]) {
                    callback(this.tileCache[z][x][y]);
                }
            }
        }
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
        const options = Object.assign({}, this.defaultOptions, providedOptions)
        options.tileSegments = Math.min(256, Math.round(options.tileSegments))
        return options
    }

    defaultOptions = {
        nTiles: 3,
        zoom: 11,
        tileSize: 600,
        tileSegments: 100,
        zScale: 1,
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
    subdivideTiles(view, subdivideSize = 2000) {
        // Skip subdivision for flat elevation maps
        if (this.constructor.name === 'QuadTreeMapElevation' && this.options.elevationType === "Flat") {
            return;
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

        // PASS 1: Debug logging and cleanup
        if (isLocal) {
            this.logDebugStats(tileLayers, view.id);
        }
        this.cleanupInactiveTiles();

        // PASS 2: Deactivate parent tiles whose children are fully loaded (texture maps only)
        if (isTextureMap) {
            this.deactivateParentsWithLoadedChildren(tileLayers);
        }

        // PASS 3: Remove inactive tiles from scene
        this.removeInactiveTilesFromScene();

        // PASS 3.5: Prune complete sets of inactive tiles
        // Enable for both texture and elevation maps to prevent memory leaks
        this.pruneInactiveTileSets();

        // PASS 4: Process each tile for subdivision/merging and lazy loading
        this.forEachTile((tile) => {
            if (!this.canSubdivide(tile)) return;

            const hasChildren = this.hasAnyChildren(tile);
            
            // Skip inactive tiles without children
            if (!tile.tileLayers && !hasChildren) return;

            // Calculate visibility and screen size
            const visibility = this.calculateTileVisibility(tile, camera);
            
            // Handle lazy loading for visible tiles using parent data
            if (isTextureMap && visibility.actuallyVisible) {
                this.triggerLazyLoadIfNeeded(tile, tileLayers);
            }

            // Determine if subdivision is needed
            const shouldSubdivide = this.shouldSubdivideTile(tile, visibility, subdivideSize);

            if (shouldSubdivide && (tile.tileLayers & tileLayers) && tile.z < this.maxZoom) {
                // RACE CONDITION FIX: Defer subdivision while parent tile is loading
                // 
                // Problem: On page reload (with cached resources), parent tiles are created and
                // immediately start loading textures asynchronously. If subdivideTiles() runs
                // before the parent texture finishes loading, child tiles can't extract parent
                // data and fall back to normal loading (0 lazy tiles).
                //
                // Solution: Wait for parent tile to finish loading before subdividing. This gives
                // child tiles access to the parent's loaded texture for lazy loading.
                //
                // Safety: Don't wait forever - after 60 frames (~1 second at 60fps), subdivide
                // anyway to prevent blocking the UI if a tile load is slow or fails.
                if (isTextureMap && tile.isLoading) {
                    // Track how many frames we've deferred subdivision
                    if (!tile.subdivisionDeferredFrames) {
                        tile.subdivisionDeferredFrames = 0;
                    }
                    tile.subdivisionDeferredFrames++;
                    
                    // Timeout: If we've waited 60 frames, proceed anyway
                    // Most texture loads complete in 1-10 frames, so this is a safety net
                    if (tile.subdivisionDeferredFrames < 60) {
                        return; // Defer subdivision until next frame (when parent may be loaded)
                    }
                    // Fall through: subdivide without parent data after timeout
                    // Child tiles will load normally, can still be upgraded later via triggerLazyLoadIfNeeded()
                }
                
                // Reset the deferred frames counter when we actually subdivide
                tile.subdivisionDeferredFrames = 0;
                
                this.subdivideTile(tile, tileLayers, isTextureMap);
                return; // Process one subdivision at a time
            }

            // Check for merging children back to parent
            if (!shouldSubdivide && hasChildren) {
                this.mergeChildrenIfPossible(tile, tileLayers);
            }
        });
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
     * Cancel pending loads for tiles that are no longer active in any view
     */
    cleanupInactiveTiles() {
        this.forEachTile((tile) => {
            if (!tile.tileLayers && (tile.isLoading || tile.isLoadingElevation)) {
                tile.cancelPendingLoads();
            }
        });
    }

    /**
     * Deactivate parent tiles when all their children are loaded and active
     * Children with parent data are OK - they're valid for display, just lower quality
     * The key is that children are loaded (even if using parent data) and added to scene
     */
    deactivateParentsWithLoadedChildren(tileLayers) {
        this.forEachTile((tile) => {
            if (tile.z >= this.maxZoom) return;
            if (tile.isLoading) return;

            const children = this.getChildren(tile);
            if (!children) return;

            // Children must be loaded and added (parent data is OK - it's valid for display)
            const allChildrenReady = children.every(child => 
                child && 
                (child.tileLayers & tileLayers) && 
                child.loaded && 
                child.added
            );

            if (allChildrenReady) {
                this.deactivateTile(tile.x, tile.y, tile.z, tileLayers, true);
            }
        });
    }

    /**
     * Remove tiles from scene that are inactive in all views
     */
    removeInactiveTilesFromScene() {
        this.forEachTile((tile) => {
            if (!tile.added || tile.tileLayers || !tile.mesh) return;

            tile.cancelPendingLoads();

            const children = this.getChildren(tile);
            if (!children) return;

            const allChildrenLoaded = children.every(child => child && child.loaded);
            if (allChildrenLoaded) {
                this.scene.remove(tile.mesh);
                if (tile.skirtMesh) {
                    this.scene.remove(tile.skirtMesh);
                }
                tile.added = false;
                
                // Reset lazy loading flags when tile is removed from scene
                // This prevents inactive tiles from being counted in lazy loading stats
                if (tile.usingParentData) {
                    tile.needsHighResLoad = false;
                }
                
                this.refreshDebugGeometry(tile);
            }
        });
    }

    /**
     * Prune complete sets of four sibling tiles that have been inactive for too long
     * Only prunes if all four siblings exist, are inactive, have no children, and have been inactive long enough
     */
    pruneInactiveTileSets() {
        const now = Date.now();
        let prunedCount = 0;
        
        // Iterate through all tiles to find parent tiles with complete sets of inactive children
        this.forEachTile((tile) => {
            // Check if this tile has all four children
            const children = this.getChildren(tile);
            if (!children) return;
            
            // Check if all four children meet pruning criteria:
            // 1. Inactive (tileLayers === 0)
            // 2. Have no children of their own
            // 3. Have been inactive for longer than the timeout
            const allChildrenPrunable = children.every(child => {
                if (child.tileLayers !== 0) return false; // Still active
                if (this.hasAnyChildren(child)) return false; // Has children
                if (!child.inactiveSince) return false; // No timestamp (shouldn't happen)
                if (now - child.inactiveSince < this.inactiveTileTimeout) return false; // Not old enough
                return true;
            });
            
            if (allChildrenPrunable) {
                // Delete all four children as a set
                children.forEach(child => {
                    // Clean up the tile
                    if (child.mesh) {
                        this.scene.remove(child.mesh);
                        // Dispose of geometry and material to free memory
                        if (child.mesh.geometry) child.mesh.geometry.dispose();
                        if (child.mesh.material) {
                            if (child.mesh.material.map) child.mesh.material.map.dispose();
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
            }
        });
        
        if (prunedCount > 0 && isLocal) {
            debugLog(`Pruned ${prunedCount} inactive tiles (${prunedCount / 4} sets of 4)`);
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

        // Check frustum intersection
        const frustumIntersects = camera.viewFrustum.intersectsSphere(worldSphere);
        
        if (frustumIntersects) {
            const radius = worldSphere.radius;
            const distance = camera.position.distanceTo(worldSphere.center);
            
            // Check if sphere center is behind the camera FIRST
            // Project sphere center onto camera's forward direction
            const cameraForward = camera.getWorldDirection(new Vector3());
            const toSphere = worldSphere.center.clone().sub(camera.position);
            const projectionOnForward = toSphere.dot(cameraForward);
            
            // If center is behind camera (negative projection) but frustum intersects,
            // the tile wraps around the camera - skip horizon checks and force subdivision
            if (projectionOnForward < 0) {
                screenSize = 1000000; // Force subdivision for tiles wrapping around camera
                visible = true;
                // Don't mark as actuallyVisible - this prevents premature lazy loading
                // The visible parts (children) will be actuallyVisible when their centers are in front
                actuallyVisible = false;
            } else {
                // Normal case: center is in front of camera
                // Now perform horizon and globe occlusion checks
                const cameraAltitude = altitudeAboveSphere(camera.position.clone());
                const closestDistance = Math.max(0, distance - radius);
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

        // Force subdivision for first 3 zoom levels
        if (tile.z < 3) {
            screenSize = 10000000000;
            visible = true;
            // actuallyVisible remains unchanged - used for lazy loading
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
     * This is called only for tiles that are actuallyVisible (not forced visible for subdivision)
     */
    triggerLazyLoadIfNeeded(tile, tileLayers) {
        // Only load if tile is using parent data, needs high-res, not currently loading, and active in this view
        const needsLoad = tile.usingParentData && 
                         tile.needsHighResLoad &&
                         !tile.isLoading && 
                         !tile.isCancelling &&
                         (tile.tileLayers & tileLayers);

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
                             tile.mesh.material.map && !tile.mesh.material.wireframe;
        
        // Create 4 child tiles (standard quadtree subdivision)
        this.activateTile(tile.x * 2, tile.y * 2, tile.z + 1, tileLayers, useParentData);
        this.activateTile(tile.x * 2, tile.y * 2 + 1, tile.z + 1, tileLayers, useParentData);
        this.activateTile(tile.x * 2 + 1, tile.y * 2, tile.z + 1, tileLayers, useParentData);
        this.activateTile(tile.x * 2 + 1, tile.y * 2 + 1, tile.z + 1, tileLayers, useParentData);

        // For texture maps: Deactivate parent if all children are loaded and added
        // (even if using parent data - that's valid for display, just lower quality)
        if (isTextureMap) {
            const children = this.getChildren(tile);
            if (children && children.every(child => child && child.loaded && child.added)) {
                this.deactivateTile(tile.x, tile.y, tile.z, tileLayers, true); // instant=true to hide parent immediately
            }
            // Otherwise parent stays active until children are ready
            // (deactivateParentsWithLoadedChildren will handle it on next frame)
        } else {
            // Elevation maps: always deactivate parent immediately
            this.deactivateTile(tile.x, tile.y, tile.z, tileLayers);
        }
    }

    /**
     * Merge children back to parent if they're all active in this view
     */
    mergeChildrenIfPossible(tile, tileLayers) {
        const children = this.getChildren(tile);
        if (!children) return;

        const allChildrenActiveInView = children.every(child => 
            child && (child.tileLayers & tileLayers)
        );

        if (allChildrenActiveInView) {
            this.activateTile(tile.x, tile.y, tile.z, tileLayers);
            children.forEach(child => {
                if (child) {
                    this.deactivateTile(child.x, child.y, child.z, tileLayers, true);
                }
            });
        }
    }

    /**
     * Check if tile has any children
     */
    hasAnyChildren(tile) {
        return this.getTile(tile.x * 2, tile.y * 2, tile.z + 1) !== undefined;
    }

    /**
     * Get all 4 children of a tile (returns null if any are missing)
     */
    getChildren(tile) {
        const child1 = this.getTile(tile.x * 2, tile.y * 2, tile.z + 1);
        const child2 = this.getTile(tile.x * 2, tile.y * 2 + 1, tile.z + 1);
        const child3 = this.getTile(tile.x * 2 + 1, tile.y * 2, tile.z + 1);
        const child4 = this.getTile(tile.x * 2 + 1, tile.y * 2 + 1, tile.z + 1);
        
        if (!child1 || !child2 || !child3 || !child4) return null;
        return [child1, child2, child3, child4];
    }

    // Set the layer mask on a tile's mesh objects
    setTileLayerMask(tile, layerMask) {
        if (tile.mesh) {
            tile.mesh.layers.disableAll();
            tile.mesh.layers.mask = layerMask;
        }
        if (tile.skirtMesh) {
            tile.skirtMesh.layers.disableAll();
            tile.skirtMesh.layers.mask = layerMask;
        }
    }


}




