import {LLAToEUS} from "./LLA-ECEF-ENU";
import {QuadTreeTile} from "./QuadTreeTile";
import {QuadTreeMap} from "./QuadTreeMap";
import {setRenderOne} from "./Globals";
import {showError, showErrorOnce} from "./showError";
import {CanvasTexture, NearestFilter} from "three";
import {createTerrainDayNightMaterial} from "./js/map33/material/TerrainDayNightMaterial";
import {asyncOperationRegistry} from "./AsyncOperationRegistry";
import {assert} from "./assert";
import {isLocal} from "./configUtils";
import "./threeExt";
import {meanSeaLevelOffset} from "./EGM96Geoid";

class QuadTreeMapTexture extends QuadTreeMap {
    constructor(scene, terrainNode, geoLocation, options = {}) {

        super(terrainNode, geoLocation, options)

        this.scene = scene; // the scene to add the tiles to
        this.dynamic = options.dynamic ?? false; // if true, use dynamic tile loading

        this.elOnly = options.elOnly ?? false;
        this.elevationMap = options.elevationMap;

        // Track loading promises to properly call loadedCallback when all tiles are loaded
        // This only makes sense if not dynamic
        this.pendingTileLoads = new Set();

        // Register the tile loading controller with async operation registry
        if (this.controller) {
            asyncOperationRegistry.registerAbortable(
                this.controller,
                'tile-texture-load',
                `Terrain texture tiles at zoom ${this.zoom}`
            );
        }

        // this.initTilePositions(this.options.deferLoad) // now in super

        this.initTiles();
        
        // Call loadedCallback when all initial tiles have finished loading their materials
        if (this.loadedCallback) {
            // Use setTimeout to allow initTiles() to complete and any initial tiles to be created
            this.loadedCallbackTimeout = setTimeout(() => {
                this.checkAndCallLoadedCallback();
            }, 0);
        }


    }

    // Check if all tiles have finished loading and call the loadedCallback if so
    checkAndCallLoadedCallback() {
        // If there are no pending tile loads and we haven't called the callback yet
        // Also check that the map hasn't been cleaned up (scene would be null)
        if (this.pendingTileLoads.size === 0 && !this.loaded && this.loadedCallback && this.scene !== null) {
            this.loaded = true;
            this.loadedCallback();
        }
    }

    // Track a tile's loading promise
    trackTileLoading(tileKey, promise) {
        // Only track loading if we haven't already called the loaded callback
        if (!this.loaded) {
            this.pendingTileLoads.add(tileKey);
            
            promise.finally(() => {
                this.pendingTileLoads.delete(tileKey);
                this.checkAndCallLoadedCallback();
            });
        }
        
        return promise;
    }

    canSubdivide(tile) {
        return (tile.mesh !== undefined && tile.mesh.geometry !== undefined)
    }

    addTileWhenReady(tile) {
        const addToScene = () => {
            if (this.scene && tile.tileLayers > 0) {
                this.scene.add(tile.mesh);
                if (tile.skirtMesh) {
                    this.scene.add(tile.skirtMesh);
                }
                tile.added = true;
                this.invalidateCoverageCache(tile);
                this.refreshDebugGeometry(tile);
                setRenderOne(true);
            }
        };

        if (tile.geometryReady) {
            addToScene();
        } else if (tile.curvePromise) {
            tile.curvePromise.then(() => {
                addToScene();
            }).catch(error => {
                console.warn(`Failed to wait for geometry for tile ${tile.key()}:`, error);
            });
        }
    }


    recalculateCurveMap(radius, force = false) {

        if (!force && radius === this.radius) {
            console.log('map33 recalculateCurveMap Radius is the same - no need to recalculate, radius = ' + radius);
            return;
        }

        if (!this.loaded) {
            showError('Map not loaded yet - only call recalculateCurveMap after loadedCallback')
            return;
        }
        this.radius = radius
        // Fire off all tile normal calculations in background (non-blocking)
        const promises = this.getAllTiles().map(tile => 
            tile.recalculateCurve(radius).catch(error => {
                console.warn(`Failed to recalculate curve for tile ${tile.key()}:`, error);
            })
        );
        setRenderOne(true);
    }


    clean() {
//        console.log("QuadTreeMap clean()");

        // abort the pending loading of tiles
        this.controller.abort();
        
        // Cancel any pending loadedCallback timeout
        if (this.loadedCallbackTimeout) {
            clearTimeout(this.loadedCallbackTimeout);
            this.loadedCallbackTimeout = null;
        }

        this.getAllTiles().forEach(tile => {
            tile.removeDebugGeometry(); // any debug arrows, etc
            // Abort any in-flight elevation computations on individual tiles
            if (tile.elevationAbortController) {
                tile.elevationAbortController.abort();
            }
            if (tile.mesh !== undefined) {
                this.scene.remove(tile.mesh)
                tile.mesh.geometry.dispose();
                
                // Dispose the texture if it exists
                tile.mesh.getMap()?.dispose();
                
                tile.mesh.material.dispose()
            }
            
            // Clean up skirt mesh
            if (tile.skirtMesh !== undefined) {
                this.scene.remove(tile.skirtMesh);
                tile.skirtMesh.geometry.dispose();
                // Note: skirtMaterial is shared, so we don't dispose it here
            }
        })
        this.tileCache = {}
        this.pendingTileLoads.clear(); // Clear pending loads when cleaning up
        this.loaded = false; // Reset loaded state
        this.scene = null; // MICK - added to help with memory management
    }

    // interpolate the elevation at a lat/lon
    // does not handle interpolating between tiles (i.e. crossing tile boundaries)
    getElevationInterpolated(lat, lon, desiredZoom = null) {

        if (!this.elevationMap) {
            console.warn("No elevation map available for interpolation");
            return meanSeaLevelOffset(lat, lon); // default to geoid sea level if no elevation map
        }

        return this.elevationMap.getElevationInterpolated(lat, lon, desiredZoom);
    }

    getElevationWithTileInfo(lat, lon, desiredZoom = null) {
        if (!this.elevationMap) {
            return {elevation: meanSeaLevelOffset(lat, lon), tileZ: -1, tileX: -1, tileY: -1};
        }
        return this.elevationMap.getElevationWithTileInfo(lat, lon, desiredZoom);
    }

    tileHasHigherZoom(z, x, y) {
        if (!this.elevationMap) return false;
        return this.elevationMap.tileHasHigherZoom(z, x, y);
    }


    // check if the area of a tile is fully covered by its descendants
    // which might be the direct children, or further descendants
    // this is a sanity check before removing a parent tile from the scene
    // should only be needed for debugging
    areaCoveredByDescendants(tile, tileLayerMask) {
        // Cache check: if tile state hasn't changed since last check, return cached result
        if (tile._coverageCacheGen === this._tileStateGeneration
            && tile._coverageCacheMask === tileLayerMask) {
            return tile._coverageCacheResult;
        }

        // if no children, return false
        if (!tile.children) {
            tile._coverageCacheGen = this._tileStateGeneration;
            tile._coverageCacheMask = tileLayerMask;
            tile._coverageCacheResult = false;
            return false;
        }

        // tile.children should have 4 children
        assert(tile.children.length === 4, `Tile ${tile.key()} should have 4 children, has ${tile.children.length}`);

        let result = true;

        // for each child, check if it is loaded and visible OR has all visible children
        for (let i = 0; i < 4; i++) {
            const child = tile.children[i];
            if (!child) continue;

            if (!child.loaded
                || !child.added
                || !child.mesh.visible
                || !(child.mesh.layers.mask & tileLayerMask)
                || !child.mesh.material
                || !child.mesh.material.uniforms?.map           // No texture
                || child.mesh.material.wireframe      // Still wireframe
                || !child.geometryReady               // Geometry not ready
                || !child.mesh.parent                 // Not in scene
            ) {
                // child is not loaded or not visible
                // but maybe all its children are?
                if (!this.areaCoveredByDescendants(child, tileLayerMask)) {
                    result = false;
                    break;
                }
            }

            // Debug: verify tile center position (only in dev, only once per tile)
            if (isLocal && !child._positionVerified) {
                const lat1 = this.options.mapProjection.getNorthLatitude(child.y, child.z);
                const lon1 = this.options.mapProjection.getLeftLongitude(child.x, child.z);
                const lat2 = this.options.mapProjection.getNorthLatitude(child.y + 1, child.z);
                const lon2 = this.options.mapProjection.getLeftLongitude(child.x + 1, child.z);
                const lat = (lat1 + lat2) / 2;
                const lon = (lon1 + lon2) / 2;
                const center = LLAToEUS(lat, lon, 0);
                assert(center.x === child.mesh.position.x
                    && center.y === child.mesh.position.y
                    && center.z === child.mesh.position.z,
                    `Child tile ${child.key()} center position mismatch`
                );
                child._positionVerified = true;
            }
        }

        // Cache the result
        tile._coverageCacheGen = this._tileStateGeneration;
        tile._coverageCacheMask = tileLayerMask;
        tile._coverageCacheResult = result;
        return result;
    }

    // Covered if EITHER
    // 1) all 4 children are loaded and visible
    // OR
    // 2) at least one ancestor is loaded and visible
    areaIsCovered(tile, tileLayerMask) {
        // Check if any ancestor is loaded and visible
        let current = tile.parent;
        while (current) {
            if (current.loaded && current.added && (current.mesh.layers.mask & tileLayerMask)) {
                return true;
            }
            current = current.parent;
        }

        return this.areaCoveredByDescendants(tile, tileLayerMask)
    }

    dumpChildren(tile, indent = '') {
        if (!tile.children) {
            console.log(`${indent}No children`);
            return;
        }
        for (let child of tile.children) {
            if (!child) continue;
            console.log(`${indent}Child ${child.key()} loaded=${child.loaded} added=${child.added} mesh layers=${child.mesh?.layers.mask}`);
            this.dumpChildren(child, indent + '  ');
        }
    }

    dumpParents(tile) {
        let current = tile.parent;
        while (current) {
            console.log(`Parent ${current.key()} loaded=${current.loaded} added=${current.added} tileLayers=${current.tileLayers}`);
            current = current.parent;
        }
    }

    dumpChildrenAndParents(tile) {
        console.log(`Dumping children and parent of tile ${tile.key()}:`);
        this.dumpChildren(tile);
        this.dumpParents(tile);

    }




    deactivateTile(tile, layerMask = 0, instant = false) {
      //  let tile = this.getTile(x, y, z);
        if (!tile) {
            return;
        }
        
        // If no specific layer mask provided, clear all layers (backward compatibility)
        if (layerMask === 0) {
            tile.tileLayers = 0;
        } else {
            // Clear only the specified layer bits using bitwise AND with NOT mask
            tile.tileLayers = tile.tileLayers & (~layerMask);
        }

        // Debug validation: check if the area is still covered by descendants or ancestors
        // (which is a requirement for deactivating a tile)
        // Wrapped in isLocal guard so areaIsCovered() is skipped in production builds
        // if (isLocal) {
        //     if (!this.areaIsCovered(tile, layerMask)) {
        //         this.dumpChildrenAndParents(tile)
        //         assert(0, `Deactivating tile ${tile.key} which does not have full coverage, layerMask=${layerMask}`);
        //     }
        // }

        if (instant) {
            // defer updating the mesh mask.
            // if all the children are loaded, then the parent will be updated automatically
            // (this will be called again from the "first pass" code in subdivideTiles)
            this.setTileLayerMask(tile, tile.tileLayers);
        }

        // If tile is no longer active in any view, cancel any pending loads and mark timestamp
        if (tile.tileLayers === 0) {
            tile.cancelPendingLoads();
            // Track when tile became inactive for pruning purposes
            if (!tile.inactiveSince) {
                tile.inactiveSince = Date.now();
            }
        }

        if (instant && tile.tileLayers === 0) {
            // remove the tile immediately (if inactive in all views)
            this.scene.remove(tile.mesh);
            if (tile.skirtMesh) {
                this.scene.remove(tile.skirtMesh);
            }
            tile.added = false;
            this.invalidateCoverageCache(tile);
        }

        //   removeDebugSphere(key)
    }

    // if tile exists, activate it, otherwise create it
    activateTile(x, y, z, layerMask = 0, useParentData = false) {
        //console.log(`activateTile Texture ${z}/${x}/${y} layerMask=${layerMask} useParentData=${useParentData} maxZoom=${this.maxZoom}`);
        
        // Don't create tiles beyond the effective max zoom (considering maxDetails)
        const effectiveMaxZoom = this.getEffectiveMaxZoom();
        if (z > effectiveMaxZoom) {
            return null;
        }
        
        let tile = this.getTile(x, y, z);


        if (tile) {
            // Tile is being cancelled - return the tile object (so it can be stored
            // in children arrays) but don't activate its layers. The cancellation will
            // complete asynchronously and the tile can be properly activated next frame.
            if (tile.isCancelling) {
                return tile;
            }
            
            // tile already exists, just activate it
            // maybe later rebuild a mesh if we unloaded it

            // Combine the new layer mask with existing layers (don't overwrite)
            if (layerMask > 0) {
                tile.tileLayers = (tile.tileLayers || 0) | layerMask;
                
                // If tile was deactivated (tileLayers was 0), re-add to scene
                if (!tile.added) {
                    this.addTileWhenReady(tile);
                }
            } else {
                // layerMask=0 means load tile data but don't make it visible (e.g., for ancestor tiles)
                tile.tileLayers = 0;
            }
            
            // Clear inactive timestamp since tile is now active
            tile.inactiveSince = undefined;

            // Update the actual layer mask on the tile
            if (tile.mesh) {
                this.setTileLayerMask(tile, tile.tileLayers);
            }
            
            // Check if the tile needs its texture loaded (e.g., if it was aborted previously)
            if (tile.mesh?.material?.wireframe && 
                tile.textureUrl() && !tile.isLoading && !tile.isCancelling) {
//                console.log(`Reactivated tile ${tile.key()} needs texture loading`);
                const key = `${z}/${x}/${y}`;
                const materialPromise = tile.applyMaterial().catch(error => {
                    // Don't log abort errors or cancellation errors - they're expected when tiles are cancelled
                    if (error.message !== 'Aborted' && error.message !== 'Tile is being cancelled') {
                        showErrorOnce("TILE_LOADING_ERROR", `Failed to load texture for reactivated tile ${key}:`, error);
                    }
                });
                this.trackTileLoading(`${key}-reactivated`, materialPromise);
            }
            
            this.refreshDebugGeometry(tile); // Update debug geometry for reactivated tiles
            setRenderOne(true);
            return tile;
        }

        // create a new tile
        tile = new QuadTreeTile(this, z, x, y);

        tile.buildGeometry();
        tile.buildMesh();

        // So at this point the tile has bad geometry, as it's just a flat mesh
        // and not aligned to the globe yet.

        // Set the tile's layer mask BEFORE applying material to ensure it's available in addAfterLoaded()
//        console.log(`activateTile: ${key} - layerMask=${layerMask}, existing tileLayers=${tile.tileLayers}`);
        if (layerMask > 0) {
            // OR the new layer mask with existing layers to support multiple views
            tile.tileLayers = (tile.tileLayers || 0) | layerMask;
     //       console.log(`activateTile: ${key} - set tileLayers to ${tile.tileLayers.toString(2)} (${tile.tileLayers}) via layerMask`);
        } else {
            // layerMask=0 means load tile data but don't make it visible (e.g., for ancestor tiles)
            tile.tileLayers = 0;
     //       console.log(`activateTile: ${key} - set tileLayers to ${tile.tileLayers.toString(2)} (${tile.tileLayers}) via layerMask=0`);
        }

        // Apply the layer mask to the tile's mesh objects immediately
        this.setTileLayerMask(tile, tile.tileLayers);

        // calculate the LLA position of the center of the tile
        const lat1 = this.options.mapProjection.getNorthLatitude(tile.y, tile.z);
        const lon1 = this.options.mapProjection.getLeftLongitude(tile.x, tile.z);
        const lat2 = this.options.mapProjection.getNorthLatitude(tile.y + 1, tile.z);
        const lon2 = this.options.mapProjection.getLeftLongitude(tile.x + 1, tile.z);
        const lat = (lat1 + lat2) / 2;
        const lon = (lon1 + lon2) / 2;
        const center = LLAToEUS(lat, lon, 0);

        tile.setPosition(center);
        tile.geometryReady = false;
        tile.curvePromise = tile.recalculateCurve().then(() => {
            tile.geometryReady = true;
            this.invalidateCoverageCache(tile);
        }).catch(error => {
            console.warn(`Failed to recalculate curve for tile ${z}/${x}/${y}:`, error);
            tile.geometryReady = true;
            this.invalidateCoverageCache(tile);
        });
        this.setTile(x, y, z, tile);
        
        // Set up parent relationship in tree structure
        const parent = this.getParent(tile);
        if (parent) {
            tile.parent = parent;
            // Note: children array is set up in subdivideTile when all 4 children are created
        }

        const key = `${z}/${x}/${y}`;

        // If z is below minZoom, create a dummy tile with black texture
        if (z < this.minZoom) {
            // Create a black texture
            const canvas = document.createElement('canvas');
            canvas.width = 256;
            canvas.height = 256;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = 'black';
            ctx.fillRect(0, 0, 256, 256);
            
            const blackTexture = new CanvasTexture(canvas);
            blackTexture.minFilter = NearestFilter;
            blackTexture.magFilter = NearestFilter;
            
            // Use the same shader material as regular tiles for consistency
            const transparency = this.terrainNode.UI.transparency ?? 1;
            const material = createTerrainDayNightMaterial(blackTexture, 0.3, false, transparency);
            
            tile.mesh.material = material;
            tile.updateSkirtMaterial();
            tile.loaded = true;
            this.invalidateCoverageCache(tile);

            this.addTileWhenReady(tile);

            return tile;
        }

        // If z is above maxZoom, try to create tile from ancestor data at maxZoom
        if (z > this.maxZoom) {
            // Calculate which tile at maxZoom would contain this tile
            const zoomDiff = z - this.maxZoom;
            const scale = Math.pow(2, zoomDiff);
            const ancestorX = Math.floor(x / scale);
            const ancestorY = Math.floor(y / scale);
            const ancestorZ = this.maxZoom;
            
            // Check if the ancestor tile at maxZoom exists and is loaded
            let ancestorTile = this.getTile(ancestorX, ancestorY, ancestorZ);
            
            // If ancestor doesn't exist or isn't loaded yet, force-load it
            if (!ancestorTile || !ancestorTile.loaded || 
                !ancestorTile.mesh?.getMap() || ancestorTile.mesh.material.wireframe) {
                
                // Activate the ancestor tile to trigger loading (if it doesn't exist)
                // Pass layerMask=0 so ancestor is loaded but NOT visible in the scene
                if (!ancestorTile) {
                    ancestorTile = this.activateTile(ancestorX, ancestorY, ancestorZ, 0, false);
                }
                
                // If ancestor is still loading, mark this tile as pending and return
                // The tile will be reactivated once the ancestor loads
                if (!ancestorTile.loaded || !ancestorTile.mesh?.getMap() || 
                    ancestorTile.mesh.material.wireframe) {
                    
                    // Mark tile as pending ancestor load
                    tile.pendingAncestorLoad = true;
                    tile.ancestorTileKey = `${ancestorZ}/${ancestorX}/${ancestorY}`;
                    
                    // Set up a callback to retry once ancestor loads
                    // We'll check periodically or use a promise-based approach
                    const checkAncestorLoaded = () => {
                        const loadedAncestor = this.getTile(ancestorX, ancestorY, ancestorZ);
                        if (loadedAncestor && loadedAncestor.loaded && 
                            loadedAncestor.mesh?.getMap() && 
                            !loadedAncestor.mesh.material.wireframe) {
                            
                            // Ancestor is now loaded, extract texture and update this tile
                            const currentTile = this.getTile(x, y, z);
                            if (currentTile && currentTile.pendingAncestorLoad) {
                                const ancestorMaterial = currentTile.buildMaterialFromAncestor(loadedAncestor);
                                if (ancestorMaterial) {
                                    // Dispose old wireframe material
                                    if (currentTile.mesh.material) {
                                        currentTile.mesh.material.dispose();
                                    }
                                    
                                    // Apply new material from ancestor
                                    currentTile.mesh.material = ancestorMaterial;
                                    currentTile.updateSkirtMaterial();
                                    currentTile.usingParentData = true;
                                    currentTile.loaded = true;
                                    this.invalidateCoverageCache(currentTile);
                                    currentTile.pendingAncestorLoad = false;
                                    
                                    this.refreshDebugGeometry(currentTile);
                                    setRenderOne(true);
                                }
                            }
                        }
                    };
                    
                    // If ancestor has a loading promise, wait for it
                    if (ancestorTile.isLoading) {
                        // Poll for completion (simple approach)
                        const pollInterval = setInterval(() => {
                            if (!ancestorTile.isLoading) {
                                clearInterval(pollInterval);
                                checkAncestorLoaded();
                            }
                        }, 100);
                        
                        // Timeout after 10 seconds to prevent infinite polling
                        setTimeout(() => clearInterval(pollInterval), 10000);
                    }
                    
                    // Add tile to scene with wireframe material as placeholder
                    // This ensures the tile occupies space and old tiles are properly replaced
                    tile.updateWireframeMaterial();
                    tile.loaded = false;
                    
                    this.addTileWhenReady(tile);
                    
                    return tile;
                }
            }
            
            // Ancestor is loaded, try to extract texture from it
            if (ancestorTile && ancestorTile.mesh && ancestorTile.mesh.material && 
                ancestorTile.mesh.getMap() && !ancestorTile.mesh.material.wireframe) {
                // Extract texture from ancestor tile
                const ancestorMaterial = tile.buildMaterialFromAncestor(ancestorTile);
                if (ancestorMaterial) {
                    tile.mesh.material = ancestorMaterial;
                    tile.updateSkirtMaterial();
                    tile.usingParentData = true;
                    tile.loaded = true;
                    this.invalidateCoverageCache(tile);

                    this.addTileWhenReady(tile);

                    return tile;
                }
            }
            
            // Fallback: If we still can't get ancestor data, add tile with wireframe
            // This ensures the tile occupies space and old tiles are properly replaced
            tile.pendingAncestorLoad = true;
            tile.updateWireframeMaterial();
            tile.loaded = false;
            
            this.addTileWhenReady(tile);
            
            return tile;
        }

        // LAZY LOADING: Try to create child tile using parent's texture data
        // This allows child tiles to appear instantly with lower-quality parent texture,
        // then upgrade to high-res later when visible (via triggerLazyLoadIfNeeded)
        if (useParentData && z > 0) {
            const parentTile = tile.parent;
            
            // Verify parent has a loaded texture that we can extract data from
            // Requirements:
            // 1. Parent tile exists and has a mesh with material
            // 2. Material has a texture map (material.map)
            // 3. Material is not wireframe (texture has actually loaded, not placeholder)
            //
            // This check is critical for the race condition fix - it ensures we only
            // attempt to use parent data when the parent texture is actually available.
            // The deferred subdivision logic in subdivideTiles() ensures this is true.
            if (parentTile && parentTile.mesh && parentTile.mesh.material && 
                parentTile.mesh.getMap() && !parentTile.mesh.material.wireframe) {
                // Extract and downsample parent texture for this child tile
                const parentMaterial = tile.buildMaterialFromParent(parentTile);
                if (parentMaterial) {
                    tile.mesh.material = parentMaterial;
                    tile.updateSkirtMaterial();
                    tile.usingParentData = true;
                    tile.needsHighResLoad = true;
                    tile.loaded = true;
                    this.invalidateCoverageCache(tile);

                    this.addTileWhenReady(tile);

                    return tile;
                }
            }
            // If parent data not available, fall through to normal loading path
        }

        // Track the async texture loading (normal path or fallback if parent data unavailable)
        const materialPromise = tile.applyMaterial().catch(error => {
            // Don't log abort errors or cancellation errors - they're expected when tiles are cancelled
            if (error.message !== 'Aborted' && error.message !== 'Tile is being cancelled') {

                // check the ignoreErrors flag

                const sourceDef = this.terrainNode.UI.getSourceDef();
                if (!sourceDef.ignoreTileLoadingErrors && isLocal) {
                   showErrorOnce("TILE_LOADING_ERROR", `Failed to load texture for tile ${key}:`, error);
                }

                // we leave the tile visible as is,  created from a quarter for the parent texture
                //tile.tileLayers = 0;

                tile.isLoading = false;

                tile.isDeadBranch = true; // mark tile as dead branch to prevent further subdivision attempts



            } else if (error.message === 'Aborted') {
                // Check if the tile is active again - this should now be rare since we prevent reactivation during cancellation
                const sourceDef = this.terrainNode.UI.getSourceDef();
                if (tile.tileLayers > 0 && !sourceDef.ignoreTileLoadingErrors && isLocal) {
                    showError(`Tile ${key} ABORTED load texture but is still active - this should not happen with the new prevention logic.`);
                }
            }
            // Tile will remain with wireframe material if texture loading fails
        });

        // Track this tile's loading promise
        this.trackTileLoading(key, materialPromise);
        this.refreshDebugGeometry(tile);
        setRenderOne(true);

        return tile;
    }


}

export {QuadTreeMapTexture};