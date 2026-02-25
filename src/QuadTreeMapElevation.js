import {QuadTreeMap} from "./QuadTreeMap";
import {QuadTreeTile} from "./QuadTreeTile";
import * as LAYER from "./LayerMasks";
import {showError} from "./showError";
import {asyncOperationRegistry} from "./AsyncOperationRegistry";
import {meanSeaLevelOffset} from "./EGM96Geoid";

export class QuadTreeMapElevation extends QuadTreeMap {
    constructor(terrainNode, geoLocation, options = {}) {
        super(terrainNode, geoLocation, options)

        // Register the tile loading controller with async operation registry
        if (this.controller) {
            asyncOperationRegistry.registerAbortable(
                this.controller,
                'tile-elevation-load',
                `Terrain elevation tiles at zoom ${this.zoom}`
            );
        }

        this.initTiles();


        // if (!this.options.deferLoad) {
        //     this.startLoadingTiles()
        // }
    }

    // startLoadingTiles() {
    //     // First load the elevation tiles
    //     const promises = Object.values(this.tileCache).map(tile => {
    //
    //             return tile.fetchElevationTile(this.controller.signal).then(tile => {
    //                 if (this.controller.signal.aborted) {
    //                     // flag that it's aborted, so we can filter it out later
    //                     return Promise.resolve('Aborted');
    //                 }
    //                 return tile
    //             })
    //
    //         }
    //     )
    //
    //     // when all the elevation tiles are loaded, then call the callback
    //     Promise.all(promises).then(tiles => {
    //         if (this.loadedCallback) this.loadedCallback();
    //
    //     })
    // }

    canSubdivide(tile) {
        return true;
    }


    activateTile(x,y,z, layerMask = 0) {

//        console.log(`activateTile Elevation ${z}/${x}/${y} layerMask=${layerMask} maxZoom=${this.maxZoom}`);
        
        // Don't create tiles beyond the effective max zoom (considering maxDetails)
        const effectiveMaxZoom = this.getEffectiveMaxZoom();
        if (z > effectiveMaxZoom) {
            return null;
        }
        
        let tile = this.getTile(x, y, z);
        if (tile) {
            // Tile already exists, just reactivate it
            this.refreshDebugGeometry(tile); // Update debug geometry for reactivated tiles
        } else {
            tile = new QuadTreeTile(this, z, x, y);
            this.setTile(x, y, z, tile);
            
            // Set up parent relationship in tree structure
            const parent = this.getParent(tile);
            if (parent) {
                tile.parent = parent;
                // Note: children array is set up in subdivideTile when all 4 children are created
            }
            
            const key = `${z}/${x}/${y}`;
            
            // If z is below minZoom, create a dummy tile with zero elevation
            if (z < this.minZoom) {
                // Create a zero elevation array with standard tile dimensions (256x256)
                // This matches the typical elevation tile data size, not the world size
                const dataSize = 256;
                const elevation = new Float32Array(dataSize * dataSize);
                // elevation is already initialized to zeros by Float32Array constructor
                tile.elevation = elevation;
                tile.shape = [dataSize, dataSize];
                tile.elevationLoadFailed = false;
                tile.isLoadingElevation = false;
                // Immediately notify that the tile is loaded
                Promise.resolve().then(() => {
                    if (!this.controller.signal.aborted) {
                        this.terrainNode.elevationTileLoaded(tile);
                    }
                });
            } else if (z > this.maxZoom) {
                // If z is above maxZoom, try to create tile from ancestor elevation data at maxZoom
                // Calculate which tile at maxZoom would contain this tile
                const zoomDiff = z - this.maxZoom;
                const scale = Math.pow(2, zoomDiff);
                const ancestorX = Math.floor(x / scale);
                const ancestorY = Math.floor(y / scale);
                const ancestorZ = this.maxZoom;
                
                // Check if the ancestor tile at maxZoom exists and has elevation loaded
                let ancestorTile = this.getTile(ancestorX, ancestorY, ancestorZ);
                
                // If ancestor doesn't exist or hasn't loaded elevation yet, force-load it
                if (!ancestorTile || !ancestorTile.elevation || ancestorTile.elevationLoadFailed) {
                    
                    // Activate the ancestor tile to trigger loading (if it doesn't exist)
                    // Pass layerMask=0 so ancestor is loaded but NOT visible in the scene
                    if (!ancestorTile) {
                        ancestorTile = this.activateTile(ancestorX, ancestorY, ancestorZ, 0);
                    }
                    
                    // If ancestor is still loading elevation, mark this tile as pending
                    if (ancestorTile.isLoadingElevation || !ancestorTile.elevation) {
                        
                        // Mark tile as pending ancestor load
                        tile.pendingAncestorLoad = true;
                        tile.ancestorTileKey = `${ancestorZ}/${ancestorX}/${ancestorY}`;
                        tile.isLoadingElevation = true;
                        
                        // Set up a callback to retry once ancestor loads
                        const checkAncestorLoaded = () => {
                            const loadedAncestor = this.getTile(ancestorX, ancestorY, ancestorZ);
                            if (loadedAncestor && loadedAncestor.elevation && 
                                !loadedAncestor.elevationLoadFailed && 
                                !loadedAncestor.isLoadingElevation) {
                                
                                // Ancestor elevation is now loaded, extract data
                                const dataSize = 256;
                                const ancestorData = tile.buildElevationFromAncestor(loadedAncestor, dataSize);
                                if (ancestorData) {
                                    tile.elevation = ancestorData.elevation;
                                    tile.shape = ancestorData.shape;
                                    tile.usingParentData = true;
                                    tile.elevationLoadFailed = false;
                                    tile.isLoadingElevation = false;
                                    tile.pendingAncestorLoad = false;
                                    
                                    // Notify that the tile is loaded
                                    if (!this.controller.signal.aborted) {
                                        this.terrainNode.elevationTileLoaded(tile);
                                    }
                                } else {
                                    // Fallback to zero elevation if extraction failed
                                    const elevation = new Float32Array(dataSize * dataSize);
                                    tile.elevation = elevation;
                                    tile.shape = [dataSize, dataSize];
                                    tile.elevationLoadFailed = false;
                                    tile.isLoadingElevation = false;
                                    tile.pendingAncestorLoad = false;
                                    
                                    if (!this.controller.signal.aborted) {
                                        this.terrainNode.elevationTileLoaded(tile);
                                    }
                                }
                            }
                        };
                        
                        // Poll for ancestor elevation completion
                        if (ancestorTile.isLoadingElevation) {
                            const pollInterval = setInterval(() => {
                                if (!ancestorTile.isLoadingElevation) {
                                    clearInterval(pollInterval);
                                    checkAncestorLoaded();
                                }
                            }, 100);
                            
                            // Timeout after 10 seconds
                            setTimeout(() => {
                                clearInterval(pollInterval);
                                // If still pending after timeout, fallback to zero elevation
                                if (tile.pendingAncestorLoad) {
                                    const dataSize = 256;
                                    const elevation = new Float32Array(dataSize * dataSize);
                                    tile.elevation = elevation;
                                    tile.shape = [dataSize, dataSize];
                                    tile.elevationLoadFailed = false;
                                    tile.isLoadingElevation = false;
                                    tile.pendingAncestorLoad = false;
                                    
                                    if (!this.controller.signal.aborted) {
                                        this.terrainNode.elevationTileLoaded(tile);
                                    }
                                }
                            }, 10000);
                        }
                        
                        // Return early - tile will be completed when ancestor loads
                        return tile;
                    }
                }
                
                // Ancestor is loaded, try to extract elevation from it
                if (ancestorTile && ancestorTile.elevation && !ancestorTile.elevationLoadFailed) {
                    // Extract elevation from ancestor tile
                    const dataSize = 256;
                    const ancestorData = tile.buildElevationFromAncestor(ancestorTile, dataSize);
                    if (ancestorData) {
                        tile.elevation = ancestorData.elevation;
                        tile.shape = ancestorData.shape;
                        tile.usingParentData = true; // Mark as using ancestor data
                        tile.elevationLoadFailed = false;
                        tile.isLoadingElevation = false;
                        // Immediately notify that the tile is loaded
                        Promise.resolve().then(() => {
                            if (!this.controller.signal.aborted) {
                                this.terrainNode.elevationTileLoaded(tile);
                            }
                        });
                    } else {
                        // Fallback to zero elevation if extraction failed
                        const dataSize = 256;
                        const elevation = new Float32Array(dataSize * dataSize);
                        tile.elevation = elevation;
                        tile.shape = [dataSize, dataSize];
                        tile.elevationLoadFailed = false;
                        tile.isLoadingElevation = false;
                        Promise.resolve().then(() => {
                            if (!this.controller.signal.aborted) {
                                this.terrainNode.elevationTileLoaded(tile);
                            }
                        });
                    }
                } else {
                    // Fallback: Create a zero elevation array if no ancestor data available
                    const dataSize = 256;
                    const elevation = new Float32Array(dataSize * dataSize);
                    tile.elevation = elevation;
                    tile.shape = [dataSize, dataSize];
                    tile.elevationLoadFailed = false;
                    tile.isLoadingElevation = false;
                    Promise.resolve().then(() => {
                        if (!this.controller.signal.aborted) {
                            this.terrainNode.elevationTileLoaded(tile);
                        }
                    });
                }
            } else {
                // Normal tile loading for minZoom <= z <= maxZoom
                tile.fetchElevationTile(this.controller.signal).then(tile => {
                    if (this.controller.signal.aborted) {
                        // flag that it's aborted, so we can filter it out later
                        return Promise.resolve('Aborted');
                    }
                    this.terrainNode.elevationTileLoaded(tile);
                }).catch(error => {
                    showError(`Failed to load elevation tile ${key}: Elevation URL was: ${tile.elevationURL()}`, error);
                    // Mark tile as having no elevation data so it doesn't keep trying
                    tile.elevation = null;
                    tile.elevationLoadFailed = true;
                    // Still call elevationTileLoaded to trigger mesh updates with fallback elevation
                    this.terrainNode.elevationTileLoaded(tile);
                })
            }
        }
        // Set the tile's layer mask to activate it - combine with existing layers
        if (layerMask > 0) {
            // OR the new layer mask with existing layers to support multiple views
            tile.tileLayers = (tile.tileLayers || 0) | layerMask;
        } else {
            // Default case: activate for all layers
            tile.tileLayers = LAYER.MASK_MAIN | LAYER.MASK_LOOK;
        }
        
        // Clear inactive timestamp since tile is now active
        tile.inactiveSince = undefined;

        this.refreshDebugGeometry(tile);
        
        return tile;

    }

    deactivateTile(tile, layerMask = 0) {
        // console.log("DUMMY deactivateTile Elevation ", x, y, z);
        //let tile = this.getTile(x, y, z);
        if (tile === undefined) {
            return;
        }
        
        // If no specific layer mask provided, clear all layers (backward compatibility)
        if (layerMask === 0) {
            tile.tileLayers = 0;
        } else {
            // Clear only the specified layer bits using bitwise AND with NOT mask
            tile.tileLayers = tile.tileLayers & (~layerMask);
        }
        
        // If tile is no longer active in any view, cancel any pending loads and mark timestamp
        if (tile.tileLayers === 0) {
            tile.cancelPendingLoads();
            // Track when tile became inactive for pruning purposes
            if (!tile.inactiveSince) {
                tile.inactiveSince = Date.now();
            }
        }
        
        this.refreshDebugGeometry(tile);
    }






    // given multiple zoom levels, return the tile and zoom level for the given geoLocation
    // we try the highest zoom level first, and return the first one that works

    // this is all messed up because of the different tile systems
    // GoogleMapsCompatible uses a square grid of tiles, while GoogleCRS84Quad uses a rectangular grid
    // so we need to check the zoom level and tile size to determine if the tile is in the cache
    // and stuff....


    // THIS NEEDS TO BE REFACTORED, it's a bit of a mess with the async loading and caching
    // and the inefficient way of applying elevation data
    // we shold be able to step across the tile coordinates and apply the elevation data directly
    // at least, when the tile sizes match for both texture and elevation


    geo2TileFractionAndZoom(geoLocation, desiredZoom = null) {
        // Use generic version for all projections for now
        return this._geo2TileFractionAndZoomGeneric(geoLocation, desiredZoom);
    }

    // Unoptimized version using new array cache but old logic (for debugging)
    geo2TileFractionAndZoomUnoptimized(geoLocation, desiredZoom = null) {
        const projection = this.options.mapProjection;
        // if a desired zoom level is specified, we can just use that
        if (desiredZoom !== null) {
            // If desiredZoom is higher than maxZoom, we'll search for the best available parent tile
            // No need to assert here - let the function handle it gracefully
            // quick check to see if it matches the last tile we found
            // for lat/lon derived x, y, and desired zoom
            // this is for when we do bulk operations and we want to avoid finding the same tile again
            if (this.lastGeoTile && this.lastGeoTile.elevation && !this.lastGeoTile.elevationLoadFailed && (desiredZoom === this.lastGeoTile.z)) {
                let zoom = this.lastGeoTile.z;
                const maxTile = Math.pow(2, zoom);
                const x = Math.abs(projection.lon2Tile(geoLocation[1], zoom) % maxTile);
                const y = Math.abs(projection.lat2Tile(geoLocation[0], zoom) % maxTile);
                const xInt = Math.floor(x);
                const yInt = Math.floor(y);
                if (xInt === this.lastGeoTile.x && yInt === this.lastGeoTile.y) {
                    // if the last tile is the same as the current tile, return it
                    return {x, y, zoom};
                }
            }
            this.lastGeoTile = null; // reset the last tile if it's not the same
            const maxTile = Math.pow(2, desiredZoom);
            const x = Math.abs(projection.lon2Tile(geoLocation[1], desiredZoom) % maxTile);
            const y = Math.abs(projection.lat2Tile(geoLocation[0], desiredZoom) % maxTile);
            let xInt = Math.floor(x);
            let yInt = Math.floor(y);
            // if we have a tile cache, check if the tile is in the cache
            const tile = this.getTile(xInt, yInt, desiredZoom);
            if (tile !== undefined && tile.elevation && !tile.elevationLoadFailed) {
                this.lastGeoTile = tile; // keep track of the last tile found
                return {x, y, zoom: desiredZoom};
            }
            // not this one, so go up the tree with xInt, yInt
            // until we find a tile that has elevation data
            let zoom = Math.min(desiredZoom - 1, this.maxZoom);
            while (zoom >= 0) {
                const maxTile = Math.pow(2, zoom);
                xInt = Math.floor(x / (2 ** (desiredZoom - zoom)));
                yInt = Math.floor(y / (2 ** (desiredZoom - zoom)));
                // if we have a tile cache, check if the tile is in the cache
                const tile = this.getTile(xInt, yInt, zoom);
                if (tile !== undefined && tile.tileLayers > 0 && tile.elevation && !tile.elevationLoadFailed) {
                    this.lastGeoTile = tile; // keep track of the last tile found
                    // BUG FIX: Recalculate x,y for the actual zoom level found, not desiredZoom
                    const maxTileAtZoom = Math.pow(2, zoom);
                    const xFixed = Math.abs(projection.lon2Tile(geoLocation[1], zoom) % maxTileAtZoom);
                    const yFixed = Math.abs(projection.lat2Tile(geoLocation[0], zoom) % maxTileAtZoom);
                    return {x: xFixed, y: yFixed, zoom};
                }
                
                // If tile exists but is still loading elevation data, continue searching for a parent
                // but remember this tile for potential future use
                if (tile !== undefined && tile.isLoadingElevation && !tile.elevationLoadFailed) {
                    // Continue searching for a parent tile with elevation data
                    // but don't return null immediately
                }
                zoom--;
            }
        }
        // if no desired zoom level, we need to search through all zoom levels
        // (which is a bit inefficient)
        let zoom = this.maxZoom;
        while (zoom >= 0) {
            const maxTile = Math.pow(2, zoom);
            const x = Math.abs(projection.lon2Tile(geoLocation[1], zoom) % maxTile);
            const y = Math.abs(projection.lat2Tile(geoLocation[0], zoom) % maxTile);
            const xInt = Math.floor(x);
            const yInt = Math.floor(y);
            // if we have a tile cache, check if the tile is in the cache
            const tile = this.getTile(xInt, yInt, zoom);
            if (tile !== undefined /* && tile.elevation */ && !tile.elevationLoadFailed) {
                this.lastGeoTile = tile; // keep track of the last tile found
                return {x, y, zoom};
            }
            zoom--;
        }
        return {x: null, y: null, zoom: null}; // return null if no tile found
    }

    // Generic version for all projections
    _geo2TileFractionAndZoomGeneric(geoLocation, desiredZoom = null) {
        const projection = this.options.mapProjection;

        if (desiredZoom !== null) {
            // If desiredZoom is higher than maxZoom, we'll search for the best available parent tile
            // No need to assert here - let the function handle it gracefully

            // Quick check against last tile
            if (this.lastGeoTile && this.lastGeoTile.elevation && !this.lastGeoTile.elevationLoadFailed && (desiredZoom === this.lastGeoTile.z)) {
                let zoom = this.lastGeoTile.z;
                const maxTile = Math.pow(2, zoom);
                const x = Math.abs(projection.lon2Tile(geoLocation[1], zoom) % maxTile);
                const y = Math.abs(projection.lat2Tile(geoLocation[0], zoom) % maxTile);

                const xInt = Math.floor(x);
                const yInt = Math.floor(y);
                if (xInt === this.lastGeoTile.x && yInt === this.lastGeoTile.y) {
                    return {x, y, zoom};
                }
            }
            this.lastGeoTile = null;

            const maxTile = Math.pow(2, desiredZoom);
            const x = Math.abs(projection.lon2Tile(geoLocation[1], desiredZoom) % maxTile);
            const y = Math.abs(projection.lat2Tile(geoLocation[0], desiredZoom) % maxTile);

            let xInt = Math.floor(x);
            let yInt = Math.floor(y);
            const tile = this.getTile(xInt, yInt, desiredZoom);
            if (tile && tile.elevation && !tile.elevationLoadFailed) {
                this.lastGeoTile = tile;
                return {x, y, zoom: desiredZoom};
            }

            // Search parent tiles, starting from maxZoom if desiredZoom exceeds it
            let zoom = Math.min(desiredZoom - 1, this.maxZoom);
            while (zoom >= 0) {
                xInt = Math.floor(x / (2 ** (desiredZoom - zoom)));
                yInt = Math.floor(y / (2 ** (desiredZoom - zoom)));

                const tile = this.getTile(xInt, yInt, zoom);
                if (tile && tile.tileLayers > 0 && tile.elevation && !tile.elevationLoadFailed) {
                    this.lastGeoTile = tile;
                    // Recalculate x,y for the actual zoom level found
                    const maxTileAtZoom = Math.pow(2, zoom);
                    const xAtZoom = Math.abs(projection.lon2Tile(geoLocation[1], zoom) % maxTileAtZoom);
                    const yAtZoom = Math.abs(projection.lat2Tile(geoLocation[0], zoom) % maxTileAtZoom);
                    return {x: xAtZoom, y: yAtZoom, zoom};
                }
                zoom--;
            }



        }





        // Search all zoom levels
        let zoom = this.maxZoom;
        while (zoom >= 0) {
            const maxTile = Math.pow(2, zoom);
            const x = Math.abs(projection.lon2Tile(geoLocation[1], zoom) % maxTile);
            const y = Math.abs(projection.lat2Tile(geoLocation[0], zoom) % maxTile);

            const xInt = Math.floor(x);
            const yInt = Math.floor(y);
            const tile = this.getTile(xInt, yInt, zoom);
            if (tile && tile.elevation && !tile.elevationLoadFailed) {
                this.lastGeoTile = tile;
                return {x, y, zoom};
            }
            zoom--;
        }

        return {x: null, y: null, zoom: null};
    }

    // using geo2tileFraction to get the position in tile coordinates
    // i.e. the coordinates on the 2D grid source texture
    // TODO - altitude map might be different format to the source texture
    // even different coordinate system. So this might not work.
    getElevationInterpolated(lat, lon, desiredZoom = null) {
//    const {x, y} = this.options.mapProjection.geo2TileFraction([lat, lon], this.zoom)

        // new, we have multiple zoom levels, so we we need to calculate the zoom level
        // for the highest resolution tile that contains the lat/lon
        // as well as finding the tile coordinates
        
        // Use the optimized version now that cache access is fixed
        const {x, y, zoom} = this.geo2TileFractionAndZoom([lat, lon], desiredZoom);

        if (x === null)
            return meanSeaLevelOffset(lat, lon); // no tile found, return geoid sea level

        const intX = Math.floor(x)
        const intY = Math.floor(y)
//    const tile = this.tileCache[`${this.zoom}/${intX}/${intY}`]
        const tile = this.getTile(intX, intY, zoom)
        if (tile && tile.elevation) {
            const nElevation = Math.sqrt(tile.elevation.length)
            const xIndex = (x - tile.x) * nElevation
            const yIndex = (y - tile.y) * nElevation
            let x0 = Math.floor(xIndex)
            let x1 = Math.ceil(xIndex)
            let y0 = Math.floor(yIndex)
            let y1 = Math.ceil(yIndex)

            // clamp to the bounds of the elevation map 0 ... nElevation-1
            x0 = Math.max(0, Math.min(nElevation - 1, x0))
            x1 = Math.max(0, Math.min(nElevation - 1, x1))
            y0 = Math.max(0, Math.min(nElevation - 1, y0))
            y1 = Math.max(0, Math.min(nElevation - 1, y1))

            const f00 = tile.elevation[y0 * nElevation + x0]
            const f01 = tile.elevation[y0 * nElevation + x1]
            const f10 = tile.elevation[y1 * nElevation + x0]
            const f11 = tile.elevation[y1 * nElevation + x1]
            const f0 = f00 + (f01 - f00) * (xIndex - x0)
            const f1 = f10 + (f11 - f10) * (xIndex - x0)
            const elevation = f0 + (f1 - f0) * (yIndex - y0)
            return elevation * this.options.zScale;
        }
        return meanSeaLevelOffset(lat, lon)  // default to geoid sea level if elevation data not loaded
    }

    getElevationWithTileInfo(lat, lon, desiredZoom = null) {
        const {x, y, zoom} = this.geo2TileFractionAndZoom([lat, lon], desiredZoom);

        if (x === null)
            return {elevation: meanSeaLevelOffset(lat, lon), tileZ: -1, tileX: -1, tileY: -1};

        const intX = Math.floor(x)
        const intY = Math.floor(y)
        const tile = this.getTile(intX, intY, zoom)
        if (tile && tile.elevation) {
            const nElevation = Math.sqrt(tile.elevation.length)
            const xIndex = (x - tile.x) * nElevation
            const yIndex = (y - tile.y) * nElevation
            let x0 = Math.floor(xIndex)
            let x1 = Math.ceil(xIndex)
            let y0 = Math.floor(yIndex)
            let y1 = Math.ceil(yIndex)

            x0 = Math.max(0, Math.min(nElevation - 1, x0))
            x1 = Math.max(0, Math.min(nElevation - 1, x1))
            y0 = Math.max(0, Math.min(nElevation - 1, y0))
            y1 = Math.max(0, Math.min(nElevation - 1, y1))

            const f00 = tile.elevation[y0 * nElevation + x0]
            const f01 = tile.elevation[y0 * nElevation + x1]
            const f10 = tile.elevation[y1 * nElevation + x0]
            const f11 = tile.elevation[y1 * nElevation + x1]
            const f0 = f00 + (f01 - f00) * (xIndex - x0)
            const f1 = f10 + (f11 - f10) * (xIndex - x0)
            const elevation = f0 + (f1 - f0) * (yIndex - y0)
            return {elevation: elevation * this.options.zScale, tileZ: zoom, tileX: intX, tileY: intY};
        }
        return {elevation: meanSeaLevelOffset(lat, lon), tileZ: -1, tileX: -1, tileY: -1};
    }

    tileHasHigherZoom(z, x, y) {
        const childZ = z + 1;
        const childX0 = x * 2;
        const childY0 = y * 2;
        for (let dx = 0; dx < 2; dx++) {
            for (let dy = 0; dy < 2; dy++) {
                const tile = this.getTile(childX0 + dx, childY0 + dy, childZ);
                if (tile && tile.elevation && !tile.elevationLoadFailed) {
                    return true;
                }
            }
        }
        return false;
    }

    clean() {
//    console.log("elevationMap clean()");

        // abort the pending loading of tiles
        this.controller.abort();

        this.getAllTiles().forEach(tile => {
            tile.removeDebugGeometry(); // any debug arrows, etc
            // Abort any in-flight elevation computations on individual tiles
            if (tile.elevationAbortController) {
                tile.elevationAbortController.abort();
            }
        })
        this.tileCache = {}
    }


}