import {CNode} from "./CNode";
import {pointAbove} from "../threeExt";
import {cos, radians} from "../utils";
import {Globals, NodeMan, Sit} from "../Globals";
import {EUSToLLA, RLLAToECEF_radii, RLLAToECEFV_Sphere} from "../LLA-ECEF-ENU";
import {earthCenterEUS, setAltitudeMSL} from "../SphericalMath";
import {Group, Mesh, MeshBasicMaterial, Raycaster, SphereGeometry} from "three";
import {GlobalScene} from "../LocalFrame";
import {assert} from "../assert";
import {CTileMappingGoogleCRS84Quad, CTileMappingGoogleMapsCompatible} from "../WMSUtils";
import {EventManager} from "../CEventManager";
import {QuadTreeMapTexture} from "../QuadTreeMapTexture";
import {QuadTreeMapElevation} from "../QuadTreeMapElevation";
import {meanSeaLevelOffset} from "../EGM96Geoid";
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
        this.hide3DTilesGreySphere = false;

        this.radius = Globals.equatorRadius;

        this.input("flattening", true) //optional

        // attempt to load it from mapBox.
        // so maybe want to snap this to a grid?
        this.position = [this.UI.lat, this.UI.lon]

        // Tile resolution = length of line of latitude / (2^zoom)
        // ref: https://docs.mapbox.com/help/glossary/zoom-level/
        // Tiles in Mapbox GL are 512x512

        // tileSegments is now always taken from Globals.settings (no local storage)


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

        // Create a grey ellipsoid positioned at the centre of the Earth.
        // Semi-axes are 1 km smaller than the earth model radii to prevent z-fighting.
        // A unit sphere is scaled non-uniformly: equatorial (a) on X/Z, polar (b) on Y.
        // The local Y axis (polar) is then rotated so it points along the actual Earth
        // rotation axis in EUS space: R_x(lat − 90°) maps Y → (0, sin(lat), −cos(lat)).
        // Degenerates to a sphere when polarRadius === equatorRadius.
        // Only visible when Globals.dynamicSubdivision is true.
        const greySphereGeometry = new SphereGeometry(1, 32, 32);
        const greySphereMaterial = new MeshBasicMaterial({ color: 0x808080 }); // Grey
        this.greySphere = new Mesh(greySphereGeometry, greySphereMaterial);
        this.greySphere.scale.set(
            Globals.equatorRadius - 1000,  // X – equatorial semi-axis
            Globals.polarRadius  - 1000,   // Y – polar semi-axis (before rotation)
            Globals.equatorRadius - 1000   // Z – equatorial semi-axis
        );
        // Rotate so the polar (local-Y) axis aligns with the Earth's rotation axis.
        // In ECEF the polar axis is always Z, so rotate Y→+Z with +π/2 about X.
        // (In old EUS this was latitude-dependent: Sit.lat * π/180 - π/2)
        this.greySphere.rotation.x = Math.PI / 2;
        // Position at the true Earth centre in EUS (depends on ellipsoid shape and latitude).
        this.greySphere.position.copy(earthCenterEUS());
        this.greySphere.visible = Globals.dynamicSubdivision === true;
        GlobalScene.add(this.greySphere);

        // // DEBUG: Create test spheres to verify rendering in VR
        // const testSphereRadius = 10; // 10m radius
        // const testSphereGeometry = new SphereGeometry(testSphereRadius, 32, 32);
        //
        // // Create a checkerboard texture
        // const canvas = document.createElement('canvas');
        // canvas.width = 256;
        // canvas.height = 256;
        // const ctx = canvas.getContext('2d');
        // const tileSize = 32;
        // for (let y = 0; y < canvas.height; y += tileSize) {
        //     for (let x = 0; x < canvas.width; x += tileSize) {
        //         const isWhite = ((x / tileSize) + (y / tileSize)) % 2 === 0;
        //         ctx.fillStyle = isWhite ? '#ffffff' : '#ff0000';
        //         ctx.fillRect(x, y, tileSize, tileSize);
        //     }
        // }
        // const checkerTexture = new CanvasTexture(canvas);
        //
        // // Red sphere with TerrainDayNightMaterial (shader)
        // const redMaterial = createTerrainDayNightMaterial(checkerTexture, 0.3, false);
        // this.testSphereRed = new Mesh(testSphereGeometry, redMaterial);
        // this.testSphereRed.position.set(20, 0, -100); // 20m right, 100m forward (in -Z direction)
        // GlobalScene.add(this.testSphereRed);
        //
        // // Green sphere with standard MeshBasicMaterial
        // const greenMaterial = new MeshBasicMaterial({ color: 0x00ff00 });
        // this.testSphereGreen = new Mesh(testSphereGeometry, greenMaterial);
        // this.testSphereGreen.position.set(-20, 0, -100); // 20m left, 100m forward (in -Z direction)
        // GlobalScene.add(this.testSphereGreen);
        //
        // console.log("DEBUG: Red sphere now uses TerrainDayNightMaterial with checkerboard texture");

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
            labelMainViewTerrain.ignoreMouseEvents(); // Allow mouse events to pass through to the 3D view
            const terrain = this;
            
            // Show elevation map stats for mainView
            labelMainViewTerrain.addText("elevationTileStatsMainView", "", 100, 4, 1.5, "#FFFFFF", "right").update(function() {
                this.text = "";

                // Get stats from elevation map
                if (terrain.elevationMap && terrain.elevationMap.currentStats) {
                    const elevStats = terrain.elevationMap.currentStats.get('mainView');
                    if (elevStats) {
                        this.text = `Elev [main] ${elevStats.totalTileCount}, Act ${elevStats.activeTileCount}, In: ${elevStats.inactiveTileCount}, Pend: ${elevStats.pendingLoads}, Lazy: ${elevStats.lazyLoading}`;
                    }
                }
            });
            
            // Show texture map stats for mainView
            labelMainViewTerrain.addText("textureTileStatsMainView", "", 100, 5.5, 1.5, "#FFFFFF", "right").update(function() {
                this.text = "";
                
                // Get stats from texture map
                if (terrain.UI && terrain.maps[terrain.UI.mapType] && terrain.maps[terrain.UI.mapType].map && terrain.maps[terrain.UI.mapType].map.currentStats) {
                    const texStats = terrain.maps[terrain.UI.mapType].map.currentStats.get('mainView');
                    if (texStats) {
                        this.text = `Tex [mainView] ${texStats.totalTileCount}, Act: ${texStats.activeTileCount}, In: ${texStats.inactiveTileCount}, Pend: ${texStats.pendingLoads}, Lazy: ${texStats.lazyLoading}`;
                    }
                }
            });
            
            // Show elevation map stats for lookView
            labelMainViewTerrain.addText("elevationTileStatsLookView", "", 100, 7, 1.5, "#FFFFFF", "right").update(function() {
                this.text = "";
                
                // Get stats from elevation map for lookView
                if (terrain.elevationMap && terrain.elevationMap.currentStats) {
                    const elevStats = terrain.elevationMap.currentStats.get('lookView');
                    if (elevStats) {
                        this.text = `Elev [lookView] ${elevStats.totalTileCount}, Act: ${elevStats.activeTileCount}, In: ${elevStats.inactiveTileCount}, Pend: ${elevStats.pendingLoads}, Lazy: ${elevStats.lazyLoading}`;
                    }
                }
            });
            
            // Show texture map stats for lookView
            labelMainViewTerrain.addText("textureTileStatsLookView", "", 100, 8.5, 1.5, "#FFFFFF", "right").update(function() {
                this.text = "";
                
                // Get stats from texture map for lookView
                if (terrain.UI && terrain.maps[terrain.UI.mapType] && terrain.maps[terrain.UI.mapType].map && terrain.maps[terrain.UI.mapType].map.currentStats) {
                    const texStats = terrain.maps[terrain.UI.mapType].map.currentStats.get('lookView');
                    if (texStats) {
                        this.text = `Tex [lookView] ${texStats.totalTileCount}, Act: ${texStats.activeTileCount}, In: ${texStats.inactiveTileCount}, Pend: ${texStats.pendingLoads}, Lazy: ${texStats.lazyLoading}`;
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

        // if (sourceDef.isDebug) {
        //     return null; // no URL for debug maps
        // }

        // if no layers, then don't pass any layers into the mapURL function
        if (sourceDef.layers === undefined) {
            return sourceDef.mapURL.bind(this)(z, x, y)
        }

        const layerName = this.UI.layer;
        let layerDef = sourceDef.layers[layerName];

        // layerDefs are not really used, so just warn for now if not found
        // this can happen with a saved layers type, when capabilities have not been loaded yet
        if (layerDef === undefined) {
            console.warn("CNodeTerrain: layer def for " + layerName + " not YET found in sourceDef")
            layerDef = ({type: "Dummy Type You Should Not See"} ) // pass null type
        }
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

        // Clean up the grey sphere
        if (this.greySphere !== undefined) {
            GlobalScene.remove(this.greySphere);
            this.greySphere.geometry.dispose();
            this.greySphere.material.dispose();
            this.greySphere = undefined;
        }

        // Clean up test spheres
        if (this.testSphereRed !== undefined) {
            GlobalScene.remove(this.testSphereRed);
            this.testSphereRed.geometry.dispose();
            this.testSphereRed.material.dispose();
            this.testSphereRed = undefined;
        }
        if (this.testSphereGreen !== undefined) {
            GlobalScene.remove(this.testSphereGreen);
            this.testSphereGreen.geometry.dispose();
            this.testSphereGreen.material.dispose();
            this.testSphereGreen = undefined;
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

    updateGreySphereVisibility() {
        // Grey sphere should only be visible when dynamic subdivision is on
        // and 3D tiles are not active (they provide their own ground surface).
        if (this.greySphere) {
            this.greySphere.visible = Globals.dynamicSubdivision === true
                && !this.hide3DTilesGreySphere;
            // Sync scale, rotation and position with the active earth model.
            this.greySphere.scale.set(
                Globals.equatorRadius - 1000,
                Globals.polarRadius  - 1000,
                Globals.equatorRadius - 1000
            );
            this.greySphere.rotation.x = Math.PI / 2;
            this.greySphere.position.copy(earthCenterEUS());
        }
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
        this.loadMap(mapID);
        this.updateGreySphereVisibility();
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
                tileSegments: Globals.settings.tileSegments,
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
                tileSegments: Globals.settings.tileSegments,   // this can go up to 256, with no NETWORK bandwidth.
                zScale: 1,
                radius: this.radius,
                mapProjection: this.mapProjectionTextures,
                elevationMap: this.elevationMap,
                maxZoom: mapDef.maxZoom ?? 14, // default to 14 if not set
                minZoom: mapDef.minZoom ?? 0, // default to 0 if not set
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

                    // Process any pending elevation updates that arrived before geometry was ready
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

        // Use the tree structure to get the parent tile
        const parentTile = tile.parent;
        
        if (!parentTile) {
            return; // no parent for root tile
        }

        // apply elevation to the parent tile (fire off in background)
        parentTile.recalculateCurve().catch(error => {
            console.warn('Failed to recalculate curve for parent tile:', error);
        });

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
                // Fire off normal calculation in background (non-blocking)
                tile.recalculateCurve().catch(error => {
                    console.log(error)
                    assert(0,'Failed to recalculate curve for tile:');
                });
            }

            assert(terrainMap.tileCache !== undefined, "CNodeTerrain: tileCache is undefined, cannot apply elevation to tile");

            // we need to recalculate the curve map for all the active children
            // this is recursive, so we can just call this function on the children
            // undefined children will be ignored
            // since we don't dispose the higher level elevation tiles, this should generally only be one deep
            
            // Use tree structure to iterate through children
            if (tile.children) {
                tile.children.forEach(child => {
                    if (child) this.applyElevationToTile(child, terrainMap);
                });
            }
        }
    }


    // when an elevation tile is loaded, we need to recalculate the terrain elevation
    // for the corresponding region
    // assume for now the quadtrees match
    elevationTileLoaded(tile) {
//        console.log("CNodeTerrain: elevation tile loaded " + tile.z + "/" + tile.x + "/" + tile.y)

        // DEFENSIVE: Verify this terrain node is still valid
        // During situation transitions, old async operations may still complete
        // and shouldn't try to update disposed terrain
        if (!this.maps || !this.UI) {
            console.warn("CNodeTerrain: elevationTileLoaded called on disposed terrain node, ignoring");
            return;
        }

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
        // flattening is 0 to 1, where 0=no flattening, 1=flat
        // so scale radius by (1/(1-flattening)
        if (this.in.flattening !== undefined) {
            var flattening = this.in.flattening.v0
            if (flattening >= 1) flattening = 0.999999
            radius *= (1 / (1 - flattening))

        }
        // Use ellipsoid-aware origin when no flattening override is active
        if (this.in.flattening !== undefined && this.in.flattening.v0 > 0) {
            Sit.originECEF = RLLAToECEFV_Sphere(radians(Sit.lat), radians(Sit.lon), 0, radius)
        } else {
            Sit.originECEF = RLLAToECEF_radii(radians(Sit.lat), radians(Sit.lon), 0)
        }
        const map = this.maps[this.UI.mapType].map;
        assert(map !== undefined, "CNodeTerrain: map is undefined")
        if (!map.loaded) {
            console.warn("CNodeTerrain: texture map not loaded yet, deferring recalculateCurveMap")
            return;
        }
        map.recalculateCurveMap(this.radius, true)

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

    getPointBelow(A, agl = 0, raycast = false) {
        // given a point in EUS, return the point on the terrain (or agl meters above it, if not zero)
        // We use the terrain map to get the elevation
        // we use LL (Lat and Lon) to get the data from the terrain maps
        // using LL ensure the results are consistent with the display of the map
        // even if the map is distorted slightly in latitude dud to non-linear scaling
        // it's also WAY faster than using raycasting

        // however, we can use raycasting if we want more accurate results
        // that match the actual polygons
        // this is useful for things like building that sit on the terrain
        if (raycast) {
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
        let elevation = meanSeaLevelOffset(LLA.x, LLA.y);
        if (this.elevationMap)
            elevation = this.elevationMap.getElevationInterpolated(LLA.x, LLA.y)

        // Clamp to geoid sea level to avoid z-fighting with ocean tiles
        const seaLevel = meanSeaLevelOffset(LLA.x, LLA.y);
        if (elevation < seaLevel) {
            elevation = seaLevel;
        }

        return setAltitudeMSL(A, elevation + agl);
    }

    getPointBelowWithTileInfo(A, agl = 0) {
        const LLA = EUSToLLA(A)
        const seaLevel = meanSeaLevelOffset(LLA.x, LLA.y);
        let elevation = seaLevel;
        let tileZ = -1, tileX = -1, tileY = -1;
        if (this.elevationMap) {
            const info = this.elevationMap.getElevationWithTileInfo(LLA.x, LLA.y);
            elevation = info.elevation;
            tileZ = info.tileZ;
            tileX = info.tileX;
            tileY = info.tileY;
        }

        const rawElevation = elevation;
        // Clamp to geoid sea level to avoid z-fighting with ocean tiles
        if (elevation < seaLevel) {
            elevation = seaLevel;
        }

        const point = setAltitudeMSL(A, elevation + agl);
        return {point, elevation: rawElevation, tileZ, tileX, tileY};
    }

    elevationTileHasHigherZoom(z, x, y) {
        if (!this.elevationMap) return false;
        return this.elevationMap.tileHasHigherZoom(z, x, y);
    }
}



