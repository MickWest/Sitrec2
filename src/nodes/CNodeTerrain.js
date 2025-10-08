import {CNode} from "./CNode";
import {pointAbove} from "../threeExt";
import {cos, radians} from "../utils";
import {Globals, NodeMan, Sit} from "../Globals";
import {EUSToLLA, RLLAToECEFV_Sphere, wgs84} from "../LLA-ECEF-ENU";
import {Group, Raycaster} from "three";
import {GlobalScene} from "../LocalFrame";
import {V3} from "../threeUtils";
import {assert} from "../assert";
import {CTileMappingGoogleCRS84Quad, CTileMappingGoogleMapsCompatible} from "../WMSUtils";
import {EventManager} from "../CEventManager";
import {QuadTreeMapTexture} from "../QuadTreeMapTexture";
import {QuadTreeMapElevation} from "../QuadTreeMapElevation";
import * as LAYER from "../LayerMasks";
import {ViewMan} from "../CViewManager";
import {CNodeViewUI} from "./CNodeViewUI";
import {isLocal} from "../configUtils";

const terrainGUIColor = "#c0ffc0";

/*
 * A terrain is composed of two parts:
 * A QuadTreeMapElevation which contains the geometry of the terrain
 * A QuadTreeMapTexture which contains the textures of the terrain
 *
 */


// Removed global local object - mapType and elevationType are now instance properties

//////////////////////////////////////////////////////////////////////////////////////
//                                                                                  //
// CNodeTerrain                                                                     //
//                                                                                  //
//////////////////////////////////////////////////////////////////////////////////////

export class CNodeTerrain extends CNode {
    constructor(v) {

        // for backwards compatibility reasons, we need to set the id to TerrainModel
        // unless another is specified
        if (v.id === undefined) {
            v.id = "TerrainModel"
        }

        super(v);

        this.UI = v.UINode ?? null;

        //   this.debugLog = true;

        this.loaded = false;

        this.radius = wgs84.RADIUS;

        this.input("flattening", true) //optional

        // attempt to load it from mapBox.
        // so maybe want to snap this to a grid?
        this.position = [this.UI.lat, this.UI.lon]

        // Tile resolution = length of line of latitude / (2^zoom)
        // ref: https://docs.mapbox.com/help/glossary/zoom-level/
        // Tiles in Mapbox GL are 512x512
        this.tileSegments = v.tileSegments ?? 100;


        if (Globals.quickTerrain) {
            this.UI.nTiles = 1;
        }

        // Important: The tile size calculation assumes a SPHERICAL Earth, not ellipsoid
        // and it uses the WGS84 circumference, radius 6378137, -> 40075016
        // rounded slightly to 40075000
        // this circumference is for the tile APIs, and does NOT change with radius
        let circumference = 40075000 * cos(radians(this.UI.lat));
        this.tileSize = circumference / Math.pow(2, this.UI.zoom) // tileSize is the width and height of the tile in meters


        // the origin is in the middle of the first tile
        // so we need to find the latitude and longitude of this tile center
        // this is all a bit dodgy


        if (Sit.legacyOrigin) {
            // legacy for some old sitches
            // that use world coordinates based on this origin
            // like the splines in Agua
            // these all use GoogleMapsCompatible projection
            const mapProjection = new CTileMappingGoogleMapsCompatible();
            var tilex = Math.floor(mapProjection.lon2Tile(this.position[1], this.UI.zoom)) + 0.5 // this is probably correct
            var tiley = Math.floor(mapProjection.lat2Tile(this.position[0], this.UI.zoom)) + 0.5 // this might be a bit off, as not linear?
            var lon0 = mapProjection.tile2Lon(tilex, this.UI.zoom)
            var lat0 = mapProjection.tile2Lat(tiley, this.UI.zoom)
            console.log("LL Tile" + tilex + "," + tiley + " = (Lat,Lon)" + lat0 + "," + lon0)

            // we need to adjust the LL origin to match the 3D map
            // but only if it's not already set
            if (Sit.lat === undefined) {
                Sit.lat = lat0
                Sit.lon = lon0
            }

        } else {


            // we need to adjust the LL origin to match the 3D map
            // but only if it's not already set
            if (Sit.lat === undefined) {
                // Sit.lat = lat0
                // Sit.lon = lon0
                Sit.lat = this.UI.lat
                Sit.lon = this.UI.lon
            }
        }

        // Create a single group that will be reused for all QuadTreeMapTexture objects
        this.group = new Group();
        GlobalScene.add(this.group);

        this.maps = []
        for (const mapName in this.UI.mapTypesKV) {
            const mapID = this.UI.mapTypesKV[mapName]
            this.maps[mapID] = {
                sourceDef: this.UI.mapSources[mapID],
            }
        }

        this.deferLoad = v.deferLoad;


        this.log("Calling loadMap from constructor with mapType=" + this.UI.mapType)
        this.loadMap(this.UI.mapType, (this.deferLoad !== undefined) ? this.deferLoad : false)
        
        // Try to create debug text display
        this.createDebugTextDisplay();
    }

    update(f) {
        super.update(f);
        this.createDebugTextDisplay()
    }

    createDebugTextDisplay() {
        // Add debug text display for terrain tile stats (similar to night sky module)
        // Only create if mainView exists and we haven't created it yet
        if (isLocal && !this.debugTextCreated && ViewMan.list && ViewMan.list.mainView && ViewMan.list.mainView.data) {
            // Clean up any existing label from a previous terrain instance
            if (NodeMan.exists("labelMainViewTerrain")) {
                NodeMan.unlinkDisposeRemove("labelMainViewTerrain");
            }
            
            const labelMainViewTerrain = new CNodeViewUI({id: "labelMainViewTerrain", overlayView: ViewMan.list.mainView.data});
            const terrain = this;
            
            // Show elevation map stats for mainView
            labelMainViewTerrain.addText("elevationTileStatsMainView", "", 100, 4, 1.5, "#f0f00080", "right").update(function() {
                this.text = "";
                
                // Get stats from elevation map
                if (terrain.elevationMap && terrain.elevationMap.currentStats) {
                    const elevStats = terrain.elevationMap.currentStats.get('mainView');
                    if (elevStats) {
                        this.text = `Elev [mainView] Total: ${elevStats.totalTileCount}, Active: ${elevStats.activeTileCount}, Inactive: ${elevStats.inactiveTileCount}, Pending: ${elevStats.pendingLoads}, Lazy: ${elevStats.lazyLoading}`;
                    }
                }
            });
            
            // Show texture map stats for mainView
            labelMainViewTerrain.addText("textureTileStatsMainView", "", 100, 5.5, 1.5, "#f0f00080", "right").update(function() {
                this.text = "";
                
                // Get stats from texture map
                if (terrain.UI && terrain.maps[terrain.UI.mapType] && terrain.maps[terrain.UI.mapType].map && terrain.maps[terrain.UI.mapType].map.currentStats) {
                    const texStats = terrain.maps[terrain.UI.mapType].map.currentStats.get('mainView');
                    if (texStats) {
                        this.text = `Tex [mainView] Total: ${texStats.totalTileCount}, Active: ${texStats.activeTileCount}, Inactive: ${texStats.inactiveTileCount}, Pending: ${texStats.pendingLoads}, Lazy: ${texStats.lazyLoading}`;
                    }
                }
            });
            
            // Show elevation map stats for lookView
            labelMainViewTerrain.addText("elevationTileStatsLookView", "", 100, 7, 1.5, "#f0f00080", "right").update(function() {
                this.text = "";
                
                // Get stats from elevation map for lookView
                if (terrain.elevationMap && terrain.elevationMap.currentStats) {
                    const elevStats = terrain.elevationMap.currentStats.get('lookView');
                    if (elevStats) {
                        this.text = `Elev [lookView] Total: ${elevStats.totalTileCount}, Active: ${elevStats.activeTileCount}, Inactive: ${elevStats.inactiveTileCount}, Pending: ${elevStats.pendingLoads}, Lazy: ${elevStats.lazyLoading}`;
                    }
                }
            });
            
            // Show texture map stats for lookView
            labelMainViewTerrain.addText("textureTileStatsLookView", "", 100, 8.5, 1.5, "#f0f00080", "right").update(function() {
                this.text = "";
                
                // Get stats from texture map for lookView
                if (terrain.UI && terrain.maps[terrain.UI.mapType] && terrain.maps[terrain.UI.mapType].map && terrain.maps[terrain.UI.mapType].map.currentStats) {
                    const texStats = terrain.maps[terrain.UI.mapType].map.currentStats.get('lookView');
                    if (texStats) {
                        this.text = `Tex [lookView] Total: ${texStats.totalTileCount}, Active: ${texStats.activeTileCount}, Inactive: ${texStats.inactiveTileCount}, Pending: ${texStats.pendingLoads}, Lazy: ${texStats.lazyLoading}`;
                    }
                }
            });
            
            this.debugTextCreated = true;
        }
    }

    refreshDebugGrids() {

        this.elevationMap.removeDebugGrid();
        this.elevationMap.refreshDebugGrid("#4040FF",1000); // sky blue for elevation

        // refresh debug grid for the currently active map
        if (this.maps[this.UI.mapType].map !== undefined) {
            this.maps[this.UI.mapType].map.removeDebugGrid();
            this.maps[this.UI.mapType].map.refreshDebugGrid("#00ff00"); // green for ground
        }
    }

    // a single point for map33 to get the URL of the map tiles

    textureURLDirect(z, x, y) {
        // get the mapSource for the current mapType
        const sourceDef = this.UI.mapSources[this.UI.mapType];
        assert(sourceDef !== undefined, "CNodeTerrain: sourceDef for " + this.UI.mapType + " not found in mapSources")

        if (sourceDef.isDebug) {
            return null; // no URL for debug maps
        }

        // if no layers, then don't pass any layers into the mapURL function
        if (sourceDef.layers === undefined) {
            return sourceDef.mapURL.bind(this)(z, x, y)
        }

        const layerName = this.UI.layer;
        const layerDef = sourceDef.layers[layerName];
        assert(layerDef !== undefined, "CNodeTerrain: layer def for " + layerName + " not found in sourceDef")
        // run it bound to this, so we can access the terrain node
        return sourceDef.mapURL.bind(this)(z, x, y, layerName, layerDef.type)
    }

    // Get the current map source definition
    getMapSourceDef() {
        return this.UI.mapSources[this.UI.mapType];
    }


    elevationURLDirect(z, x, y) {
        // get the elevation source for the current type
        const sourceDef = this.UI.elevationSources[this.UI.elevationType];

        if (!sourceDef.mapURL) {
            if (sourceDef.url === "" || sourceDef.url === undefined) {
                return null;
            }
            return sourceDef.url + "/" + z + "/" + x + "/" + y + ".png";
        }

        // no layers yet, so just call the mapURL function with nulls
        return sourceDef.mapURL.bind(this)(z, x, y, null, null)

    }

    dispose() {
        // first abort any pending request

        this.log("CNodeTerrain: disposing of this.maps")
        for (const mapID in this.maps) {
            if (this.maps[mapID].map !== undefined) {
                this.maps[mapID].map.clean()
                this.maps[mapID].map = undefined
            }
        }

        // Clean up the single group
        if (this.group !== undefined) {
            GlobalScene.remove(this.group);
            this.group = undefined;
        }

        if (this.elevationMap !== undefined) {
            this.elevationMap.clean()
            this.log("Setting ElevatioMap to undefined")
            this.elevationMap = undefined;
        }

        // Clear any pending elevation updates
        if (this.pendingElevationUpdates) {
            this.pendingElevationUpdates = [];
        }

        // Clean up debug text display if it was created
        if (this.debugTextCreated && NodeMan.exists("labelMainViewTerrain")) {
            NodeMan.unlinkDisposeRemove("labelMainViewTerrain");
            this.debugTextCreated = false;
        }

        super.dispose();
    }

    unloadMap(mapID) {
        this.log("CNodeTerrain: unloading map " + mapID)
        if (this.maps[mapID].map !== undefined) {
            this.maps[mapID].map.clean()
            this.maps[mapID].map = undefined
        }
        // Clear the shared group when unloading
        this.group.clear();
    }


    reloadMap(mapID) {
        // clear elevation and texture maps
        // and reload the map
        this.elevationMap.clean()
        this.elevationMap = undefined;
        this.unloadMap(mapID);
        this.loadMap(mapID)
    }

    loadMapElevation(id, deferLoad) {

        const mapDef = this.maps[id].sourceDef;


        const elevationDef = this.UI.elevationSources[this.UI.elevationType];
        if (elevationDef.mapping === 4326) {
            this.mapProjectionElevation = new CTileMappingGoogleCRS84Quad();
        } else {
            this.mapProjectionElevation = new CTileMappingGoogleMapsCompatible();
        }

        let elevationNTiles = this.UI.nTiles;
        // if they are different projections, add two tiles to the elevation map (adding a border of one tile)
        if (mapDef.mapping !== elevationDef.mapping) {
            elevationNTiles += 2;
        }

        // if we have an elevation map, then we need to check if it's the right size
        // if not, then we need to unload it
        // this can happen if we change the number of tiles due to the projection
        if (this.elevationMap !== undefined) {
            if (elevationNTiles !== this.elevationMap.nTiles) {
                this.log("CNodeTerrain: elevation map nTiles has changed, so unloading the elevation map")
                this.elevationMap.clean()
                this.elevationMap = undefined;
            }
        }


        // we do a single elevation map for all the maps
        // they will use this to get the elevation for the meshes via lat/lon
        // so the elevation map can use a different coordinate system to the textured geometry map
        if (this.elevationMap === undefined) {
            this.log("CNodeTerrain: creating elevation map")
            this.elevationMap = new QuadTreeMapElevation(this, this.position, {
                nTiles: elevationNTiles,  // +2 to ensure we cover the image map areas when using different projections
                zoom: this.UI.zoom,
                tileSize: this.tileSize,
                tileSegments: this.tileSegments,
                zScale: this.UI.elevationScale,
                radius: this.radius,
                maxZoom: elevationDef.maxZoom ?? 14, // default to 14 if not set
                minZoom: elevationDef.minZoom ?? 0, // default to 0 if not set
                elevationType: this.UI.elevationType, // pass the elevation source type
                loadedCallback: () => {
                    this.log("CNodeTerrain: elevation map loaded")
                    this.recalculate();
                    this.refreshDebugGrids()

                    // we can't add outputs to the terrain node
                    // as it gets destroyed and recreated
                    // and other nodes access it via the NodeMan, not via inputs/outputs
                    // so to ensure collisions are recalculated, we need to do it here
                    // a bit brute force, but it's not that often
                    //NodeMan.recalculateAllRootFirst(false); // false means don't recalculate the terrain again

                    EventManager.dispatchEvent("terrainLoaded", this)
                    EventManager.dispatchEvent("elevationChanged", this)
                    
                    // Try to create debug text display if it wasn't created in constructor
                    this.createDebugTextDisplay();


                },
                deferLoad: deferLoad,
                //  mapURL: this.mapURLDirect.bind(this),
                elevationULR: this.elevationURLDirect.bind(this),

                // //mapProjection: new CTileMappingGoogleCRS84Quad(),
                // mapProjection: new CTileMappingGoogleMapsCompatible(), // works with AWS

                mapProjection: this.mapProjectionElevation,
                dynamic: this.UI.dynamic, // if true, then init the terrain as 1x1 and use dynamic subdivision

                elOnly: true,
            })
        }

    }


    loadMap(id, deferLoad) {

        this.log("CNodeTerrain: loadMap, id = " + id + " deferLoad = " + deferLoad)

        assert(Object.keys(this.maps).length > 0, "CNodeTerrain: no maps found")
        assert(this.maps[id] !== undefined, "CNodeTerrain: map type " + id + " not found")


        this.loadMapElevation(id, deferLoad);
        this.loadMapTexture(id, deferLoad);
    }


    loadMapTexture(id, deferLoad) {
        const mapDef = this.maps[id].sourceDef;
        if (mapDef.mapping === 4326) {
            this.mapProjectionTextures = new CTileMappingGoogleCRS84Quad();
        } else {
            this.mapProjectionTextures = new CTileMappingGoogleMapsCompatible();

        }

        // Clean up the group when switching maps - remove all children
        this.group.clear();

        // check to see if the map has already been loaded
        // if it has, we need to clean it up first since we're reusing the group
        if (this.maps[id].map !== undefined) {
            this.maps[id].map.clean();
            this.maps[id].map = undefined;
        }

        // Always create a new map since we're reusing the group
        Globals.loadingTerrain = true;
//        console.log("CNodeTerrain: loading map "+id+" deferLoad = "+deferLoad)
        this.maps[id].map = new QuadTreeMapTexture(this.group, this, this.position, {
                dynamic: this.UI.dynamic, // if true, then init the terrain as 1x1 and use dynamic subdivision
                nTiles: this.UI.nTiles,
                zoom: this.UI.zoom,
                tileSize: this.tileSize,
                tileSegments: this.tileSegments,   // this can go up to 256, with no NETWORK bandwidth.
                zScale: 1,
                radius: this.radius,
                mapProjection: this.mapProjectionTextures,
                elevationMap: this.elevationMap,
                maxZoom: mapDef.maxZoom ?? 14, // default to 14 if not set
                loadedCallback: () => {
                    this.log("CNodeTerrain: id = " + id + " map loaded callback")

                    // first check to see if it has been disposed
                    // this happnes and need fixing, but for now just warn and
                    if (this.maps[id].map === undefined) {
                        console.error("FIX NEEDED: CNodeTerrain: id = " + id + " map loaded callback called with no map object")
                        return;
                    }

                    // Once map has finished loading, we can recalculate anything that depends on it
                    // like things that use the terrain height
                    this.outputs.forEach(o => {
                        o.recalculateCascade()
                    })
//                    console.log("CNodeTerrain: id = "+id+" map loaded");
             //      propagateLayerMaskObject(this.group)

                    // call the terrainLoadedCallback on any node that has it
                    NodeMan.iterate((id, n) => {
                        if (n.terrainLoadedCallback !== undefined) {
                            n.terrainLoadedCallback()
                        }
                    })

                    Globals.loadingTerrain = false;

                    this.refreshDebugGrids()

                    // WHY IS THIS NEEDED - IF WE HAVE WIREFRAME MODE
                    // THEN IT SHOULD ALWAYS HAVE GEOMETRY


                    // The elevation system might have tried to apply elevation to this tile before
                    // and failed because there's no geometry yet.
                    // Process any pending elevation updates that arrived before the texture map was ready
                    if (this.pendingElevationUpdates && this.pendingElevationUpdates.length > 0) {
                        this.log("CNodeTerrain: processing " + this.pendingElevationUpdates.length + " pending elevation updates")
                        this.pendingElevationUpdates.forEach(update => {
                            this.applyElevationTo(update.z, update.x, update.y);
                        });
                        this.pendingElevationUpdates = []; // Clear the pending updates
                        EventManager.dispatchEvent("elevationChanged", this)
                    }

                },
                deferLoad: deferLoad,
            })
    }


    applyElevationTo(z,x,y) {
        // TODO - make it work for differnt subdivisions
        const terrainMap = this.maps[this.UI.mapType].map;

        // if the corresponding tile is active, then recalculate the curve map
        // we can then return, as an active has no children
        const terrainTile = terrainMap.getTile(x, y, z);
        this.applyElevationToTile(terrainTile, terrainMap)
        if (this.UI.dynamic) {

            // apply elevation to parents might be needed if the tile coordiante systems don't overlap
            // but really parent tiles should NOT used higher resolution elevations
            // So I removed this.

   //        this.applyElevationToParents(terrainTile, terrainMap);
        }

    }

    applyElevationToParents(tile, terrainMap) {
        // if the tile is undefined, then we can't apply elevation to it
        if (tile === undefined) {
            return;
        }

        // caclulate the parent tile from tile.x, tile.y, tile.z
        // if the tile is at the root, then it has no parent
        if (tile.z === 0) {
            return; // no parent for root tile
        }

        const parentX = Math.floor(tile.x / 2);
        const parentY = Math.floor(tile.y / 2);
        const parentZ = tile.z - 1;
        const parentTile = terrainMap.getTile(parentX, parentY, parentZ);



        // apply elevation to the parent tile
        parentTile.recalculateCurve();

        // and recursively apply to the parent's parent
        this.applyElevationToParents(parentTile, terrainMap);
    }

    applyElevationToTile(tile, terrainMap) {

        assert (terrainMap !== undefined, "CNodeTerrain: terrainMap is undefined, cannot apply elevation to tile");


        if (terrainMap.tileCache === undefined) {
            console.warn("CNodeTerrain: tileMap is undefined, cannot apply elevation to tile")
            return;
        }

        // now if I just turn the camera and a node is not active, then it will not have a tile

        if (tile !== undefined) {

            // any tile that has a mesh, we need to recalculate the curve map (i.e. the elevation of the mesh
            if (tile.mesh) {
                tile.recalculateCurve()
            }

            assert(terrainMap.tileCache !== undefined, "CNodeTerrain: tileCache is undefined, cannot apply elevation to tile");

            // we need to recalculate the curve map for all the active children
            // this is recursive, so we can just call this function on the children
            // undefined children will be ignored
            // since we don't dispose the higher level elevation tiles, this should generally only be one deep
            this.applyElevationToTile(terrainMap.getTile(tile.x * 2, tile.y * 2, tile.z + 1), terrainMap);
            this.applyElevationToTile(terrainMap.getTile(tile.x * 2, tile.y * 2 + 1, tile.z + 1), terrainMap);
            this.applyElevationToTile(terrainMap.getTile(tile.x * 2 + 1, tile.y * 2, tile.z + 1), terrainMap);
            this.applyElevationToTile(terrainMap.getTile(tile.x * 2 + 1, tile.y * 2 + 1, tile.z + 1), terrainMap);
        }
    }


    // when an elevation tile is loaded, we need to recalculate the terrain elevation
    // for the corresponding region
    // assume for now the quadtrees match
    elevationTileLoaded(tile) {
//        console.log("CNodeTerrain: elevation tile loaded " + tile.z + "/" + tile.x + "/" + tile.y)

        // get the terrain map for the current map type
        if (this.maps[this.UI.mapType].map === undefined) {
            // Store pending elevation updates for when the texture map is ready
            if (!this.pendingElevationUpdates) {
                this.pendingElevationUpdates = [];
            }
            this.pendingElevationUpdates.push({z: tile.z, x: tile.x, y: tile.y});
            console.warn("CNodeTerrain: map is undefined, storing elevation update for later application")
            return;
        }

        // NOTE: ASSUMING THE QUADTREES MATCH
        this.applyElevationTo(tile.z, tile.x, tile.y);

        EventManager.dispatchEvent("elevationChanged", this)
    }

    recalculate() {

        if (this.maps[this.UI.mapType].map === undefined) {
            console.warn("CNodeTerrain: map is undefined, called recalculate while still loading - ignoring")
            return;
        }

        if (this.elevationMap === undefined) {
            console.warn("CNodeTerrain: elevation map is undefined, called recalculate while still loading - ignoring")
            return;
        }

        this.log("CNodeTerrain: recalculate")

        var radius = this.radius;
        // flattening is 0 to 1, whenre 0=no flattening, 1=flat
        // so scale radius by (1/(1-flattening)
        if (this.in.flattening != undefined) {
            var flattening = this.in.flattening.v0
            if (flattening >= 1) flattening = 0.999999
            radius *= (1 / (1 - flattening))

        }
        Sit.originECEF = RLLAToECEFV_Sphere(radians(Sit.lat), radians(Sit.lon), 0, radius)
        assert(this.maps[this.UI.mapType].map !== undefined, "CNodeTerrain: map is undefined")
        this.maps[this.UI.mapType].map.recalculateCurveMap(this.radius, true)

       //  propagateLayerMaskObject(this.group)

    }

    // return current group, for collision detection, etc
    getGroup() {
        return this.group;
    }

    getIntersects(raycaster) {
        const collisionSet = this.getGroup().children
        return raycaster.intersectObjects(collisionSet, true)
    }

    getClosestIntersect(raycaster) {
        const intersects = this.getIntersects(raycaster)
        return intersects.length > 0 ? intersects[0] : null
    }

    getPointBelow(A, agl = 0, accurate = false) {
        // given a point in EUS, return the point on the terrain (or agl meters above it, if not zero)
        // We use the terrain map to get the elevation
        // we use LL (Lat and Lon) to get the data from the terrain maps
        // using LL ensure the results are consistent with the display of the map
        // even if the map is distorted slightly in latitude dud to non-linear scaling
        // it's also WAY faster than using raycasting

        // however, we can use raycasting if we want more accurate results
        // that match the actual polygons
        // this is useful for things like building that sit on the terrain
        if (accurate) {
            // we are going to use a ray from 100000m above the point to
            const B = pointAbove(A, 100000)
            const BtoA = A.clone().sub(B).normalize()

            const rayCaster = new Raycaster(B, BtoA);
            rayCaster.layers.mask  |= LAYER.MASK_MAIN | LAYER.MASK_LOOK;

            const ground = this.getClosestIntersect(rayCaster);
            if (ground !== null) {
                let groundPoint = ground.point;
                groundPoint.add(BtoA.multiplyScalar(-agl))
                return groundPoint;
            }
        }


        const LLA = EUSToLLA(A)
        // elevation is the height above the wgs84 sphere
        let elevation = 0; // 0 if map not loaded
        if (this.maps[this.UI.mapType].map !== undefined)
            elevation = this.maps[this.UI.mapType].map.getElevationInterpolated(LLA.x, LLA.y)

        if (elevation < 0) {
            // if the elevation is negative, then we assume it's below sea level
            // so we set it to zero
            elevation = 0;
        }


        // then we scale a vector from the center of the earth to the point
        // so that its length is the radius of the earth plus the elevation
        // then the end of this vector (added to the center) is the point on the terrain
        const earthCenterENU = V3(0, -wgs84.RADIUS, 0)
        const centerToA = A.clone().sub(earthCenterENU)
        const scale = (wgs84.RADIUS + elevation + agl) / centerToA.length()
        return earthCenterENU.add(centerToA.multiplyScalar(scale))
    }
}



