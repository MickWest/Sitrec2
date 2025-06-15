import {QuadTreeMap} from "./QuadTreeMap";
import {QuadTreeTile} from "./QuadTreeTile";
import {assert} from "./assert";

export class QuadTreeMapElevation extends QuadTreeMap {
    constructor(terrainNode, geoLocation, options = {}) {
        super(terrainNode, geoLocation, options)


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


    // IDEA: the interpolated elevaation calculation via LAT/LON is not very efficient
    // we should be able to calculate the elevation directly from the tile coordinates
    // Maybe the mesh should be built with the elevation data step size????


    activateTile(x,y,z) {


        assert(z <= this.maxZoom, `activateTile: z (${z}) must be less than of equal to maxZoom (${this.maxZoom})`);

//        console.log("NEW activateTile Elevation ", x, y, z);
        const key = `${z}/${x}/${y}`;
        let tile = this.tileCache[key];
        if (tile) {
        } else {
            tile = new QuadTreeTile(this, z, x, y);
            this.tileCache[key] = tile;
            tile.fetchElevationTile(this.controller.signal).then(tile => {
                if (this.controller.signal.aborted) {
                    // flag that it's aborted, so we can filter it out later
                    return Promise.resolve('Aborted');
                }
                this.terrainNode.elevationTileLoaded(tile);
            })
        }
        tile.active = true; // mark the tile as active

        this.refreshDebugGeometry(tile);

    }

    deactivateTile(x,y,z) {
        // console.log("DUMMY deactivateTile Elevation ", x, y, z);
        const key = `${z}/${x}/${y}`;
        let tile = this.tileCache[key];
        tile.active = false; // mark the tile as inactive
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

        const projection = this.options.mapProjection;

        // quick check to see if it matches the last tile we found
        // this is for when we do bulk operations and we want to avoid finding the same tile again
        if (this.lastGeoTile && this.lastGeoTile.elevation && (desiredZoom === null || desiredZoom === this.lastGeoTile.z)) {
            let zoom = this.lastGeoTile.z;
            const maxTile = Math.pow(2, zoom);
            var x = Math.abs(projection.lon2Tile(geoLocation[1], zoom) % maxTile);
            var y = Math.abs(projection.lat2Tile(geoLocation[0], zoom) % maxTile);

            const xInt = Math.floor(x);
            const yInt = Math.floor(y);
            if (xInt === this.lastGeoTile.x && yInt === this.lastGeoTile.y) {
                // if the last tile is the same as the current tile, return it
                return {x, y, zoom};
            }
        }
        this.lastGeoTile = null; // reset the last tile if it's not the same

        // if a desired zoom level is specified, we can just use that
        if (desiredZoom !== null) {
            assert(desiredZoom <= this.maxZoom, `geo2TileFractionAndZoom: desiredZoom (${desiredZoom}) must be less than or equal to maxZoom (${this.maxZoom})`);

            const maxTile = Math.pow(2, desiredZoom);
            var x = Math.abs(projection.lon2Tile(geoLocation[1], desiredZoom) % maxTile);
            var y = Math.abs(projection.lat2Tile(geoLocation[0], desiredZoom) % maxTile);

            let xInt = Math.floor(x);
            let yInt = Math.floor(y);
            // if we have a tile cache, check if the tile is in the cache
            const tileKey = `${desiredZoom}/${xInt}/${yInt}`;
            const tile = this.tileCache[tileKey];
            if (tile !== undefined && tile.active && tile.elevation) {
                this.lastGeoTile = tile; // keep track of the last tile found
                return {x, y, zoom: desiredZoom};
            }

            // not this one, so go up the tree with xInt, yInt
            // until we find a tile that has elevation data

            let zoom = desiredZoom - 1;
            while (zoom >= 0) {
                const maxTile = Math.pow(2, zoom);
                xInt = Math.floor(x / (2 ** (desiredZoom - zoom)));
                yInt = Math.floor(y / (2 ** (desiredZoom - zoom)));

                // if we have a tile cache, check if the tile is in the cache
                const tileKey = `${zoom}/${xInt}/${yInt}`;
                const tile = this.tileCache[tileKey];
                if (tile !== undefined && tile.elevation) {
                    this.lastGeoTile = tile; // keep track of the last tile found

                    const maxTile = Math.pow(2, zoom);
                    var x = Math.abs(projection.lon2Tile(geoLocation[1], desiredZoom) % maxTile);
                    var y = Math.abs(projection.lat2Tile(geoLocation[0], desiredZoom) % maxTile);


                    return {x, y, zoom};
                }
                zoom--;
            }



        }





        // if no desired zoom level, we need to search through all zoom levels
        // (which is a bit inefficient)
        let zoom = this.maxZoom;
        while (zoom >= 0) {
            const maxTile = Math.pow(2, zoom);
            var x = Math.abs(projection.lon2Tile(geoLocation[1], zoom) % maxTile);
            var y = Math.abs(projection.lat2Tile(geoLocation[0], zoom) % maxTile);

            const xInt = Math.floor(x);
            const yInt = Math.floor(y);
            // if we have a tile cache, check if the tile is in the cache
            const tileKey = `${zoom}/${xInt}/${yInt}`;
            const tile = this.tileCache[tileKey];
            if (tile !== undefined && tile.active) {
                this.lastGeoTile = tile; // keep track of the last tile found

                return {x, y, zoom};
            }
            zoom--;
        }

        //  console.error("geo2TileAndZoom: No tile found for geoLocation", geoLocation, "at any zoom level");
        //  return {x: 0, y: 0, zoom: 0}; // default to 0,0,0 if no tile found
        return {x: null, y: null, zoom: null}; // return null if no tile found


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
        const {x, y, zoom} = this.geo2TileFractionAndZoom([lat, lon], desiredZoom);

        if (x === null)
            return 0; // no tile found, return sea level

        const intX = Math.floor(x)
        const intY = Math.floor(y)
//    const tile = this.tileCache[`${this.zoom}/${intX}/${intY}`]
        const tile = this.tileCache[`${zoom}/${intX}/${intY}`]
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
        return 0  // default to sea level if elevation data not loaded
    }


    clean() {
//    console.log("elevationMap clean()");

        // abort the pending loading of tiles
        this.controller.abort();

        Object.values(this.tileCache).forEach(tile => {
            tile.removeDebugGeometry(); // any debug arrows, etc
        })
        this.tileCache = {}
    }


}