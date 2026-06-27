import {CNode} from "./CNode";
import {Globals, guiMenus, NodeMan, setRenderOne, Sit} from "../Globals";
import {sharedUniforms} from "../js/map33/material/SharedUniforms";
import {assert} from "../assert";
import {configParams} from "../runtimeConfig";
import {isLocal, isServerless, SITREC_APP, SITREC_TERRAIN} from "../configUtils";
import {CNodeSwitch} from "./CNodeSwitch";
import {ECEFToLLAVD_radii, LLAToECEF, updateEarthRadii} from "../LLA-ECEF-ENU";
import {CNodeTerrain} from "./CNodeTerrain";
import {CNodeBuildings3DTiles} from "./CNodeBuildings3DTiles";
import {TREE_FLATTEN_DEFS, makeDefaultTreeFlattenParams} from "../TilesTreeFlatten";
import {GlobalScene} from "../LocalFrame";
import {par} from "../par";
import {addAlignedGlobe, updateAlignedGlobe} from "../Globe";
import {showHider} from "../KeyBoardHandler";
import {meanSeaLevelOffset} from "../EGM96Geoid";
import * as LAYER from "../LayerMasks";
import {BufferGeometry, DoubleSide, Float32BufferAttribute, Group, Mesh, MeshPhongMaterial} from "three";
import {
    defaultSourcesEnabled,
    filterSourcesForServerless,
    filterToCustomAndOfflineSources,
    pickAvailableSourceType,
} from "../terrainSourceUtils";
import {getEnv} from "../envUtils";
import {ServiceAvailability} from "../ServiceAvailability";
import {identifyServiceFromUrl} from "../TileUsageTracker";
import {
    disposeAttributionOverlay,
    setElevationAttribution,
    setMapAttribution,
    setTilesAttribution
} from "../AttributionOverlay";
import {t} from "../i18n";

/**
 * Static map of token names to their build-time values.
 * Webpack's dotenv-webpack only replaces literal process.env.X references,
 * so dynamic access like process.env[variable] always yields undefined.
 * This object gives us a runtime-indexable lookup that webpack can still populate.
 */
const BUILD_TIME_TOKENS = {
    MAPBOX_TOKEN: process.env.MAPBOX_TOKEN,
    MAPTILER_KEY: process.env.MAPTILER_KEY,
    CESIUM_ION_TOKEN: process.env.CESIUM_ION_TOKEN,
    GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY,
};

/**
 * Check if a source's required API token is available.
 * Returns true if no token is required, or if the token is set to a real value.
 * Tokens that are missing, empty, or set to "EXAMPLEKEY" are treated as absent.
 */
function hasRequiredToken(sourceDef) {
    if (!sourceDef.requiredToken) return true;
    const token = getEnv(sourceDef.requiredToken, BUILD_TIME_TOKENS[sourceDef.requiredToken]);
    return token && token !== "EXAMPLEKEY";
}

const OCEAN_SURFACE_OFFSET_METERS = 0;
const OCEAN_SURFACE_TILE_GRID = 17;
const OCEAN_SURFACE_WATER_THRESHOLD_METERS = 2;
const OCEAN_SURFACE_REFRESH_MS = 1200;
const OCEAN_SURFACE_FIXED_DATUM = "egm96-msl";

export class CNodeTerrainUI extends CNode {
    constructor(v) {

        // Hijack the ID as we want to use it for the terain node
        const initialID = v.id
        v.id = "terrainUI"
        super(v);

//        console.log("CNodeTerrainUI: constructor with \n" + JSON.stringify(v));

        assert (v.terrain === undefined, "CNodeTerrainUI: terrain node already exists, please remove it from the sit file")

        //this.debugLog = true;

        this.lat = v.lat;
        this.lon = v.lon;
        this.nTiles = v.nTiles;
        this.zoom = v.zoom;
        this.elevationScale = v.elevationScale ?? 1;
        this.textureDetail = v.textureDetail ?? 1;
        this.elevationDetail = v.elevationDetail ?? 1;
        this.transparency = v.transparency ?? 1;

        this._layer = null;

        this.layer = v.layer ?? null;


        // Default screen-space-error targets in pixels. A texel covering more
        // than this many screen pixels triggers refinement. Lower → sharper +
        // more tiles; higher → coarser + faster. Texture is held tighter than
        // elevation since elevation errors mainly affect silhouettes.
        // (Old "subdivideSize" units were a fudged screenFraction*1024 metric;
        // these are real pixels.) Map sources can override via mapDef.errorTargetPixels.
        this.elevationErrorTarget = 4.0;
        this.textureErrorTarget = 1.5;

        this.adjustable = v.adjustable ?? true;

        this.updateWhilePaused = true;


        this.refresh = false;


        if (configParams?.customMapSources !== undefined) {
            // start with the custom map sources
            this.mapSources = configParams.customMapSources;
        } else {
            this.mapSources = {};
        }

        // add the default map sources, wireframe and flat shading
        this.mapSources = {
            ...this.mapSources,
            NoClouds: {
                allowInServerless: true,
                name: "Blue Marble (No Clouds)",
                mapURL: (z, x, y) => {
                    return SITREC_APP + `data/maps/no_clouds_4k/${z}/${x}/${y}.jpg`;
                },
                maxZoom: 3,
                attribution: "Credit: NASA Earth Observatory",
                termsURL: "https://www.nasa.gov/nasa-brand-center/images-and-media/",
            },
            wireframe: {
                allowInServerless: true,
                name: "Wireframe",
                mapURL: (z, x, y) => {
                    return null;
                },
                maxZoom: 15,
            },
            FlatShading: {
                allowInServerless: true,
                offlineSafe: true,
                name: "Flat Shading",
                mapURL: (z, x, y) => {
                    return SITREC_APP + "data/images/grey-256x256.png?v=1";
                },
                maxZoom: 15,
            },
            OceanSurface: {
                allowInServerless: true,
                offlineSafe: true,
                name: "Ocean Surface",
                mapURL: (z, x, y) => {
                    return SITREC_APP + "data/images/28_sea water texture-seamless.jpg";
                },
                maxZoom: 18, // this is the level at which the ocean tile is ideally physically real sized
                generateMipmaps: true,
            },
            ElevationColor: {
                allowInServerless: true,
                name: "Elevation Pseudo-Color",
                isElevationColor: true,
                maxZoom: 18,   // for ocean tiles to work, this should be the same as for Ocean Surface
                colorBands: [
                    { altitude: 1,      color: { red: 0, green: 0, blue: 255 } }, // Blue for water/low elevation
                    { altitude: 1,      color: { red: 140, green: 176, blue: 130 } }, // Green start
                   // { altitude: 1206*3, color: { red: 140, green: 176, blue: 130 } },
                    { altitude: 1901*3, color: { red: 214, green: 231, blue: 212 } },
                    { altitude: 2182*3, color: { red: 240, green: 241, blue: 181 } },
                    { altitude: 2464*3, color: { red: 251, green: 222, blue: 154} },
                    { altitude: 2808*3, color: { red: 217, green: 181, blue: 105 } },
                    { altitude: 3053*3, color: { red: 209, green: 209, blue: 209 } },
                    { altitude: 3312*3, color: { red: 255, green: 255, blue: 2555 } },
                ]
            }
        }

        // local debugging, add a color test map
        //if (isLocal) {
            this.mapSources = {
                ...this.mapSources,
                RGBTest: {
                    allowInServerless: true,
                    name: "RGB Test",
                    mapURL: (z, x, y) => {
                        return SITREC_APP + "data/images/colour_bars_srgb-255-128-64.png?v=1";
                    },
                    maxZoom: 15,
                },
                // GridTest: {
                //     name: "Grid Test",
                //     mapURL: (z, x, y) => {
                //         return SITREC_APP + "data/images/grid.png?v=1";
                //     },
                //     maxZoom: 15,
                // },
                ElevationBitmap: {
                    name: "Elevation Bitmap",
                    mapURL: (z, x, y) => {
                        return `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`
                    },
                    attribution: "Terrain: USGS, NOAA & contributors",
                    termsURL: "https://github.com/tilezen/joerd/blob/master/docs/attribution.md",
                },

                Debug: {
                    allowInServerless: true,
                    offlineSafe: true,
                    name: "Debug Info",
                    isDebug: true,
                    maxZoom: 20,
                },

                Local: {
                    allowInServerless: true,
                    offlineSafe: true,
                    name: "Local",
                    mapURL: (z,x,y) => {
                        return `${SITREC_TERRAIN}imagery/esri/${z}/${y}/${x}.jpg`
                    },

                    maxZoom: 8,
                    minZoom: 0,
                    tileSize: 256,
                    attribution: "Powered by Esri",
                    termsURL: "https://www.esri.com/en-us/legal/terms/data-attributions",
                    // Local Esri imagery: texels are pre-baked at modest zoom,
                    // so allow finer screen-space error before refining further.
                    errorTargetPixels: 0.5,
                },


                // osm_buggy: {
                //     name: "Open Streetmap BUGGY for testing",
                //     mapURL: (z,x,y) => {
                //
                //
                //         const url = `https://c.tile.openstreetmap.org/${z}/${x}/${y}.png`
                //
                //         // simulate a failed tile load 5% of the time at zoom 4 and above
                //         // use a hash of the url to get a consistent failure pattern
                //         // Equivalent to using Math.random, but consistent for each tile
                //         if (z >= 4 && md5AsFloat(url) < 0.25) {
                //             return "https://invalid.url/${z}/${x}/${y}.png";
                //         }
                //
                //         return url;
                //
                //     },
                //     maxZoom: 17,
                //     supportsOceanSurface: true, // OpenStreetMap can have ocean surface overlay
                //
                // },
                //
                // Debuggy: {
                //     name: "Debug Info with Failures",
                //     isDebug: true,
                //     maxZoom: 20,
                //     failurePct: 5,
                //     ignoreTileLoadingErrors: true,
                //     mapURL: (z,x,y) => {
                //         return "https://invalid.url/doesnotexist.png";
                //     },
                // }



            }
        //}

        // add any mapsources defined in the environment variable
        // this allows Docker builds, etc, to specify different map sources
        // a map source definition should be a JSON string
        // like:
        // env[SITREC_MAPTYPE_MAPBOX] = "{\"name\":\"MapBox\",\"urlTemplate\":\"https://api.mapbox.com/v4/mapbox.{layer}/{z}/{x}/{y}@2x.jpg80?access_token=YOUR_MAPBOX_TOKEN\",\"layers\":{\"satellite\":{\"type\":\"jpg\"}},\"layer\":\"satellite\",\"minZoom\":0,\"maxZoom\":18,\"supportsOceanSurface\":true}"

        // iterate over all Globals.env keys
        // if the key starts with SITREC_MAPTYPE_, then we parse the value as JSON
        // and add it to the mapSources
        if (Globals.env) {
            for (const envKey in Globals.env) {
                if (envKey.startsWith('SITREC_MAPTYPE_')) {
                    try {
                        const mapConfig = JSON.parse(Globals.env[envKey]);
                        // Extract the map type name from the env key (e.g., SITREC_MAPTYPE_MAPBOX -> MapBox)
                        const mapTypeName = envKey.replace('SITREC_MAPTYPE_', '');
                        
                        // If the config has a urlTemplate, convert it to a mapURL function
                        if (mapConfig.urlTemplate) {
                            const template = mapConfig.urlTemplate;
                            mapConfig.mapURL = (z, x, y) => {
                                let url = template
                                    .replace('{z}', z)
                                    .replace('{x}', x)
                                    .replace('{y}', y);
                                
                                // Replace layer placeholder if specified
                                if (mapConfig.layer) {
                                    url = url.replace('{layer}', mapConfig.layer);
                                }
                                
                                return url;
                            };
                            // Remove the template property as it's no longer needed
                            delete mapConfig.urlTemplate;
                        }
                        
                        // Add to mapSources using the extracted name
                        this.mapSources[mapTypeName] = mapConfig;
                        console.log(`Added map source from environment: ${mapTypeName}`, mapConfig.name);
                    } catch (e) {
                        console.error(`Failed to parse map source from ${envKey}:`, e);
                    }
                }
            }
        }

        // Add custom map sources from SITREC_CUSTOM_MAP_<NAME>_* env vars.
        // Scans Globals.env for keys matching SITREC_CUSTOM_MAP_<NAME>_URL,
        // groups related properties by <NAME>, and creates a source entry for each.
        // Exclude _TERMS_URL: it's a per-source property that also ends in _URL, so it
        // would otherwise be misread as a separate source named "<NAME>_TERMS".
        if (Globals.env) {
            for (const key in Globals.env) {
                const match = key.match(/^SITREC_CUSTOM_MAP_(.+)_URL$/);
                if (match && !key.endsWith('_TERMS_URL') && Globals.env[key]) {
                    const name = match[1];
                    const prefix = `SITREC_CUSTOM_MAP_${name}_`;
                    const template = Globals.env[key];
                    // SITREC_CUSTOM_MAP_<NAME>_ZOFFSET (integer, default 0) is ADDED to
                    // the tile z before it is substituted into the {z} placeholder; e.g.
                    // ZOFFSET=-1 requests one zoom level coarser. 0 is a no-op. Lets a
                    // source whose tiling is offset from Sitrec's standard slippy-map z
                    // be aligned without code changes.
                    const zOffset = parseInt(Globals.env[prefix + 'ZOFFSET']) || 0;
                    // MIN_ZOOM (default 0) is the lowest zoom this source serves; below it the
                    // terrain shows a placeholder tile rather than requesting one (QuadTreeMapTexture).
                    // A negative ZOFFSET also raises the effective minimum so the requested
                    // z + ZOFFSET can never go below 0 — no invalid negative-{z} requests, whatever
                    // MIN_ZOOM is (this generalizes the manual "set minZoom" workaround). The
                    // Math.max(0, …) in mapURL below is a final guard.
                    let minZoom = parseInt(Globals.env[prefix + 'MIN_ZOOM']) || 0;
                    if (zOffset < 0) minZoom = Math.max(minZoom, -zOffset);
                    const sourceKey = `CustomMap_${name}`;
                    this.mapSources[sourceKey] = {
                        name: Globals.env[prefix + 'NAME'] || `Custom Map (${name})`,
                        mapURL: (z, x, y) => template.replace('{z}', Math.max(0, z + zOffset)).replace('{x}', x).replace('{y}', y),
                        maxZoom: parseInt(Globals.env[prefix + 'MAX_ZOOM']) || 20,
                        minZoom: minZoom,
                        attribution: Globals.env[prefix + 'ATTRIBUTION'] || "",
                        termsURL: Globals.env[prefix + 'TERMS_URL'] || "",
                        allowInServerless: true,
                    };
                    // MAPPING (EPSG number, e.g. 4326) selects the tile projection, like a
                    // config.js source's `mapping`. Default is web-mercator (3857); set 4326 for
                    // equirectangular / CRS84 tile sources (e.g. a WMTS GoogleCRS84Quad layer).
                    if (Globals.env[prefix + 'MAPPING']) {
                        this.mapSources[sourceKey].mapping = parseInt(Globals.env[prefix + 'MAPPING']);
                    }
                    console.log(`Added custom map source from env: ${sourceKey}`, this.mapSources[sourceKey].name);
                }
            }
        }

        // SITREC_ENABLE_DEFAULT_MAP_SOURCES=false strips the built-in internet providers
        // (ESRI, MapBox, MapTiler, EOX, …), keeping only the env-defined CustomMap_* sources
        // and the offline-safe built-ins (Local, Debug, Flat Shading, Ocean Surface).
        if (!defaultSourcesEnabled(getEnv("SITREC_ENABLE_DEFAULT_MAP_SOURCES", process.env.SITREC_ENABLE_DEFAULT_MAP_SOURCES))) {
            this.mapSources = filterToCustomAndOfflineSources(this.mapSources, /^CustomMap_/);
        }

        if (isServerless) {
            this.mapSources = filterSourcesForServerless(this.mapSources);
        }

        // extract a K/V pair from the mapSources
        // for use in the GUI.
        // key is the name, value is the id
        this.mapTypesKV = {}
        for (const mapType in this.mapSources) {
            const mapDef = this.mapSources[mapType];
            if (!mapDef.excludeFromMenu && hasRequiredToken(mapDef)) {
                this.mapTypesKV[mapDef.name] = mapType
            }
        }


        // This is the default map type if none specificed in the Sit file
        // Use DOCKER_MAP_TYPE if building for Docker, otherwise use DEFAULT_MAP_TYPE
        // Map type precedence: runtime DOCKER_MAP_TYPE override -> runtime DEFAULT_MAP_TYPE
        // (the documented main knob, incl. CustomMap_<NAME>) -> build-time values -> "Debug".
        // getEnv("X") with no fallback is a RUNTIME-only read (window.__SITREC_ENV__ from the
        // Docker entrypoint). Runtime values must win over build-time baked ones, so a
        // DEFAULT_MAP_TYPE in a container .env is honoured even if the image happened to bake
        // a legacy DOCKER_MAP_TYPE. DOCKER_* is only an optional Docker-only override.
        const defaultMapType = isServerless
            ? "Local"
            : (getEnv("DOCKER_MAP_TYPE")
                || getEnv("DEFAULT_MAP_TYPE")
                || (process.env.DOCKER_BUILD ? process.env.DOCKER_MAP_TYPE : "")
                || process.env.DEFAULT_MAP_TYPE
                || "Debug");

        // map type from the terrain object in a saved sitch, or default to configured default.
        // quickTerrain mode (testAll=2) always forces Debug terrain for speed.
        // Regression mode no longer forces Local globally; tests that need Local should pass
        // mapType=Local explicitly in the URL.
        const regressionForceLocalTerrain =
            Globals.regression
            && typeof window !== "undefined"
            && new URLSearchParams(window.location.search).get("regressionLocalTerrain") === "1";
        const requestedMapType = Globals.quickTerrain
            ? "Debug"
            : (regressionForceLocalTerrain ? "Local" : v.mapType);
        this.mapType = pickAvailableSourceType({
            sources: this.mapSources,
            requestedType: requestedMapType,
            defaultType: defaultMapType,
        });

        this.gui = guiMenus.terrain;
        this.mapTypeMenu = this.gui.add(this, "mapType", this.mapTypesKV).listen().name(t("terrainUI.mapType.label"))
            .tooltip(t("terrainUI.mapType.tooltip"))

//////////////////////////////////////////////////////////////////////////////////////////
        // same for elevation sources
        if (configParams?.customElevationSources !== undefined) {
            this.elevationSources = configParams.customElevationSources;
        } else {
            this.elevationSources = {};
        }

        this.elevationSources = {
            ...this.elevationSources,
            // and some defaults
            Flat: {
                allowInServerless: true,
                offlineSafe: true,
                name: "Flat",
                url: "",
                maxZoom: 20,
                minZoom: 0,
                tileSize: 256,
                attribution: "",
            },
            Local: {
                allowInServerless: true,
                offlineSafe: true,
                name: "Local",
                // Tiles stored in sitrec-terrain/elevation/z/x/y.png
                mapURL: (z,x,y) => {
                    return `${SITREC_TERRAIN}elevation/${z}/${x}/${y}.png`
                },

                maxZoom: 6,
                minZoom: 0,
                tileSize: 256,
                attribution: "Elevation: USGS, NOAA & contributors",
                termsURL: "https://github.com/tilezen/joerd/blob/master/docs/attribution.md",
            }
        }
        // Add custom elevation sources from SITREC_CUSTOM_ELEVATION_<NAME>_* env vars.
        // Exclude _TERMS_URL (a per-source property that also ends in _URL), as for maps.
        if (Globals.env) {
            for (const key in Globals.env) {
                const match = key.match(/^SITREC_CUSTOM_ELEVATION_(.+)_URL$/);
                if (match && !key.endsWith('_TERMS_URL') && Globals.env[key]) {
                    const name = match[1];
                    const prefix = `SITREC_CUSTOM_ELEVATION_${name}_`;
                    const template = Globals.env[key];
                    // SITREC_CUSTOM_ELEVATION_<NAME>_ZOFFSET (integer, default 0) is ADDED
                    // to the tile z before it is substituted into {z}, exactly like the
                    // custom-map ZOFFSET above. 0 is a no-op.
                    const zOffset = parseInt(Globals.env[prefix + 'ZOFFSET']) || 0;
                    // MIN_ZOOM (default 0) gates the low end (below it the elevation system
                    // uses a zero-elevation placeholder, no request); a negative ZOFFSET also
                    // raises the effective minimum so z + ZOFFSET never goes below 0. Same as
                    // the custom-map handling above. Math.max(0, …) in mapURL is a final guard.
                    let minZoom = parseInt(Globals.env[prefix + 'MIN_ZOOM']) || 0;
                    if (zOffset < 0) minZoom = Math.max(minZoom, -zOffset);
                    const sourceKey = `CustomElevation_${name}`;
                    const source = {
                        name: Globals.env[prefix + 'NAME'] || `Custom Elevation (${name})`,
                        mapURL: (z, x, y) => template.replace('{z}', Math.max(0, z + zOffset)).replace('{x}', x).replace('{y}', y),
                        maxZoom: parseInt(Globals.env[prefix + 'MAX_ZOOM']) || 15,
                        minZoom: minZoom,
                        tileSize: 256,
                        attribution: Globals.env[prefix + 'ATTRIBUTION'] || "",
                        termsURL: Globals.env[prefix + 'TERMS_URL'] || "",
                        allowInServerless: true,
                    };
                    if (Globals.env[prefix + 'MAPPING']) {
                        source.mapping = parseInt(Globals.env[prefix + 'MAPPING']);
                    }
                    this.elevationSources[sourceKey] = source;
                    console.log(`Added custom elevation source from env: ${sourceKey}`, source.name);
                }
            }
        }

        // SITREC_ENABLE_DEFAULT_ELEVATION_SOURCES=false strips the built-in internet elevation
        // providers (AWS Terrarium, etc.), keeping only the env-defined CustomElevation_* sources
        // and the offline-safe built-ins (Flat, Local).
        if (!defaultSourcesEnabled(getEnv("SITREC_ENABLE_DEFAULT_ELEVATION_SOURCES", process.env.SITREC_ENABLE_DEFAULT_ELEVATION_SOURCES))) {
            this.elevationSources = filterToCustomAndOfflineSources(this.elevationSources, /^CustomElevation_/);
        }

        if (isServerless) {
            this.elevationSources = filterSourcesForServerless(this.elevationSources);
        }
        // and the KV pair for the GUI
        this.elevationTypesKV = {}
        for (const elevationType in this.elevationSources) {
            const elevationDef = this.elevationSources[elevationType]
            if (hasRequiredToken(elevationDef)) {
                this.elevationTypesKV[elevationDef.name] = elevationType
            }
        }

        // Same precedence as the map type: runtime DOCKER_ELEVATION_TYPE -> runtime
        // DEFAULT_ELEVATION_TYPE -> build-time values -> "Flat". Runtime wins over build-time.
        const defaultElevationType = isServerless
            ? "Local"
            : (getEnv("DOCKER_ELEVATION_TYPE")
                || getEnv("DEFAULT_ELEVATION_TYPE")
                || (process.env.DOCKER_BUILD ? process.env.DOCKER_ELEVATION_TYPE : "")
                || process.env.DEFAULT_ELEVATION_TYPE
                || "Flat");

        // quickTerrain mode (testAll=2) always forces Flat elevation for speed.
        // Regression mode no longer forces Local globally; tests that need Local should pass
        // elevationType=Local explicitly in the URL.
        const requestedElevationType = Globals.quickTerrain
            ? "Flat"
            : (regressionForceLocalTerrain ? "Local" : v.elevationType);
        this.elevationType = pickAvailableSourceType({
            sources: this.elevationSources,
            requestedType: requestedElevationType,
            defaultType: defaultElevationType,
        })
        // add the menu
        this.elevationTypeMenu = this.gui.add(this, "elevationType", this.elevationTypesKV).listen().name(t("terrainUI.elevationType.label"))
            .tooltip(t("terrainUI.elevationType.tooltip"))

        this.elevationTypeMenu.onChange(() => this.onElevationTypeChanged())


/////////////////////////////////////////////////////

        assert(this.lat !== undefined, "CNodeTerrainUI: lat must be defined")

        this.oldLat = this.lat;
        this.oldLon = this.lon;
        this.oldZoom = this.zoom;
        this.oldNTiles = this.nTiles;
        this.oldElevationScale = this.elevationScale;


        this.mapTypeMenu.onChange(v => {

            this.layer = null; // reset the layer so setMapType can set it to default for new map type
            // do this async, as we might need to wait for the capabilities to be loaded
            this.setMapType(v).then(() => {
                this.terrainNode.loadMapTexture(v)
                // Force a subdivision/render pass after the async texture
                // load resolves — same reason as the elevationType handler
                // above and doRefresh(): when paused, the camera-fingerprint
                // gate blocks any new tile work until the camera moves.
                this.requestSubdivisionPass();
            })
            this.updateAttribution();
            this.terrainNode.updateGreySphereVisibility();
        })

        this.debugElevationGrid = false;

       // if (v.fullUI) {

            this.latController = this.gui.add(this, "lat", -85, 85, .001).onChange(v => {
                this.flagForRecalculation()
                this.startLoading = false;
            }).onFinishChange(v => {
                this.startLoading = true
            }).tooltip(t("terrainUI.lat.tooltip"))


            this.lonController = this.gui.add(this, "lon", -180, 180, .001).onChange(v => {
                this.flagForRecalculation()
                this.startLoading = false;
            }).onFinishChange(v => {
                this.startLoading = true
            }).tooltip(t("terrainUI.lon.tooltip"))

            this.zoomController = this.gui.add(this, "zoom", 2, 15, 1).onChange(v => {
                this.flagForRecalculation()
                this.startLoading = false;
            }).onFinishChange(v => {
                this.startLoading = true
            }).tooltip(t("terrainUI.zoom.tooltip"))

            this.nTilesController = this.gui.add(this, "nTiles", 1, 8, 1).onChange(v => {
                this.flagForRecalculation()
                this.startLoading = false;
            }).onFinishChange(v => {
                this.startLoading = true
            }).tooltip(t("terrainUI.nTiles.tooltip"))


            // adds a button to refresh the terrain
            this.gui.add(this, "doRefresh").name(t("terrainUI.refresh.label"))
                .tooltip(t("terrainUI.refresh.tooltip"))



            // Group the assorted tweak/debug controls into a "Terrain Tweaks" sub-folder to
            // keep the top-level Terrain menu uncluttered. Re-created each time the terrain UI
            // builds (per sitch), like the controllers it holds, so it self-heals on reload.
            this.terrainTweaks = this.gui.addFolder("Terrain Tweaks").close();

            // a toggle to show or hide the debug elevation grid

            this.terrainTweaks.add(this, "debugElevationGrid").name(t("terrainUI.debugGrids.label")).onChange(v => {
                this.terrainNode.refreshDebugGrids();
            }).tooltip(t("terrainUI.debugGrids.tooltip"))


            this.zoomToTrackSwitchObject = new CNodeSwitch({
                id: "zoomToTrack", kind: "Switch",
                inputs: {"-": "null"}, desc: "Zoom to track",
                tip: "Zoom to the extents of the selected track (for the duration of the Sitch frames)",
            }, this.gui).onChange(track => {
                this.zoomToTrack(track)
            })
        // }

        this.elevationScaleController = this.terrainTweaks.add(this, "elevationScale", 0, 10, 0.1).onFinishChange(v => {
            this.flagForRecalculation()
            this.startLoading = true
        }).elastic(10, 100)
            .tooltip(t("terrainUI.elevationScale.tooltip"))

        this.transparencyController = this.terrainTweaks.add(this, "transparency", 0, 1, 0.01).name(t("terrainUI.terrainOpacity.label"))
            .tooltip(t("terrainUI.terrainOpacity.tooltip"))
            .onChange(v => {
                if (this.terrainNode && this.terrainNode.maps) {
                    for (const mapID in this.terrainNode.maps) {
                        const map = this.terrainNode.maps[mapID].map;
                        if (map && map.tileCache) {
                            for (const z in map.tileCache) {
                                for (const x in map.tileCache[z]) {
                                    for (const y in map.tileCache[z][x]) {
                                        const tile = map.tileCache[z][x][y];
                                        if (tile && tile.mesh && tile.mesh.material) {
                                            if (tile.mesh.material.uniforms && tile.mesh.material.uniforms.transparency) {
                                                tile.mesh.material.uniforms.transparency.value = v;
                                                tile.mesh.material.transparent = v < 1;
                                                tile.mesh.material.needsUpdate = true;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            })

        // Note: Tile Segments is controlled via the global settings menu in CustomSupport.js
        // No local UI controller needed here

        this.disableDynamicSubdivision = false;
        if (isLocal) {

            this.textureDetailController = this.terrainTweaks.add(this, "textureDetail", 0.1, 3, 0.1)
                .tooltip(t("terrainUI.textureDetail.tooltip"))
                .onChange(() => this.requestSubdivisionPass())

            this.elevationDetailController = this.terrainTweaks.add(this, "elevationDetail", 0.1, 3, 0.1)
                .tooltip(t("terrainUI.elevationDetail.tooltip"))
                .onChange(() => this.requestSubdivisionPass())

            this.disableDynamicSubdivisionController = this.terrainTweaks.add(this, "disableDynamicSubdivision").name(t("terrainUI.disableDynamicSubdivision.label"))
                .tooltip(t("terrainUI.disableDynamicSubdivision.tooltip"))
        }


        // terrain serializaton is handled by CustomSupport.js getCustomSitchString()
        // this.addSimpleSerial("debugElevationGrid")
        // this.addSimpleSerial("elevationScale")
        // this.addSimpleSerial("mapType")
        // this.addSimpleSerial("elevationType")

        this.dynamic = v.dynamic ?? false;
        
        // Mirror this.dynamic to Globals.dynamicSubdivision
        Globals.dynamicSubdivision = this.dynamic;
        
        this.dynamicController = this.terrainTweaks.add(this, "dynamic").name(t("terrainUI.dynamicSubdivision.label")).tooltip(t("terrainUI.dynamicSubdivision.tooltip")).onChange(v => {
            // 3D building tiles require dynamic subdivision.
            // Prevent disabling while buildings are active.
            if (!v && this.showBuildings) {
                this.dynamic = true;
                Globals.dynamicSubdivision = true;
                if (this.dynamicController) this.dynamicController.updateDisplay();
                return;
            }

            // Update the global mirror
            Globals.dynamicSubdivision = v;

            this.updateUIVisibility();
            this.terrainNode.reloadMap(this.mapType);
            // Toggling dynamic ON rebuilds the texture map down to its coarse
            // root; re-arm the subdivision grace so it refines on a static
            // camera (same fix as the Layer/Map Type handlers). Harmless when
            // toggling OFF — the subdivision driver ignores grace when !dynamic.
            this.requestSubdivisionPass();

            // Update globe visibility based on new state
            this.updateGlobeVisibility();

            // Update grey sphere visibility based on new state
            this.terrainNode.updateGreySphereVisibility();
        });

        // 3D Buildings support
        this.buildingsSource = v.buildingsSource ?? "google-photorealistic";
        this.buildingsNode = null;
        // "Flatten Trees" heuristics — one stable object shared by reference
        // with the buildings node and all GUI controls. Serialized as a whole
        // via modSerialize/modDeserialize (merged, not replaced, on load).
        this.treeFlattenParams = makeDefaultTreeFlattenParams();
        // V5 material modes for buildings: "photo" / "flat" / "halfPhoto".
        // Mode change applies to future tile loads only.
        this.buildingsMaterialMode = v.buildingsMaterialMode ?? "photo";
        // lil-gui addColor requires a defined hex; default keyed to source
        // family (warm concrete for photogrammetric, neutral for OSM). The
        // plugin still treats this as "unset" only if explicitly null at
        // construction; here we just give the picker a starting value.
        this.buildingsFlatColor = v.buildingsFlatColor
            ?? (this.buildingsSource === "google-photorealistic" ? 0xc0b8a8 : 0xb8b4ac);
        this.addSimpleSerial("buildingsMaterialMode");
        this.addSimpleSerial("buildingsFlatColor");
        this.showOceanSurface = v.showOceanSurface ?? false;
        this.oceanSurfaceDatum = OCEAN_SURFACE_FIXED_DATUM;
        this.oceanSurfaceGroup = null;
        this.oceanSurfaceMaterial = null;
        this.oceanSurfaceTileSignature = null;
        this.oceanSurfaceNeedsRebuild = true;
        this.oceanSurfaceNextRefreshAtMs = 0;

        // Determine available building sources based on API keys and user permission.
        const allowed3DBuildingGroups = [3, 2, 9, 14, 19]; // Admin, Registered, Verified, Sitrec Members, Sitrec Plus
        const userGroups = Array.isArray(Globals.userData?.userGroups) ? Globals.userData.userGroups : [];
        const hasGroupPermission = userGroups.some(group => allowed3DBuildingGroups.includes(group));
        this.canUse3DBuildings = Globals.userData?.canUse3DBuildings ?? hasGroupPermission;

        const cesiumToken = Globals.userData?.CESIUM_ION_TOKEN;
        const googleKey = Globals.userData?.GOOGLE_MAPS_API_KEY;
        const hasCesium = this.canUse3DBuildings && !!cesiumToken;
        const hasGoogle = this.canUse3DBuildings && !!googleKey;

        // Only enable showBuildings if user has permission and at least one API key;
        // otherwise force it off so we don't serialize an unusable state.
        this.showBuildings = (hasCesium || hasGoogle) ? (v.showBuildings ?? false) : false;

        if (hasCesium || hasGoogle) {
            const buildingsSourcesKV = {};
            if (hasCesium) buildingsSourcesKV["Cesium OSM Buildings"] = "cesium-osm";
            if (hasGoogle) buildingsSourcesKV["Google Photorealistic"] = "google-photorealistic";

            this.gui.add(this, "showBuildings").name(t("terrainUI.showBuildings.label")).onChange(v => {
                this.toggleBuildings(v);
            }).tooltip(t("terrainUI.showBuildings.tooltip"));

            this.showBuildingEdges = v.showBuildingEdges ?? true;
            this.terrainTweaks.add(this, "showBuildingEdges").name(t("terrainUI.buildingEdges.label")).onChange(v => {
                if (this.buildingsNode) {
                    this.buildingsNode.setShowEdges(v);
                }
            }).tooltip(t("terrainUI.buildingEdges.tooltip"));

            // Magenta border around each terrain/imagery tile. Useful for
            // debugging tile boundaries / coverage / per-zoom subdivision.
            // Drawn by DayNightStandardMaterial via a UV-edge shader chunk
            // (mirrors the building-edges barycentric trick, but per-tile).
            this.showTileEdges = v.showTileEdges ?? false;
            sharedUniforms.showTileEdges.value = this.showTileEdges;
            this.terrainTweaks.add(this, "showTileEdges").name("Tile Edges").onChange(v => {
                sharedUniforms.showTileEdges.value = v;
                setRenderOne(true);
            }).tooltip("Outline each terrain tile with a 1px magenta border");

            if (hasGoogle) {
                this.gui.add(this, "showOceanSurface").name(t("terrainUI.oceanSurface.label")).onChange(() => {
                    this.updateTerrainAndOceanVisibility();
                }).tooltip(t("terrainUI.oceanSurface.tooltip"));
            }

            if (Object.keys(buildingsSourcesKV).length > 1) {
                this.gui.add(this, "buildingsSource", buildingsSourcesKV).name(t("terrainUI.buildingsSource.label")).onChange(v => {
                    if (this.buildingsNode) {
                        this.buildingsNode.setSource(v);
                        this.updateTerrainAndOceanVisibility();
                        this.updateAttribution();
                    }
                }).tooltip(t("terrainUI.buildingsSource.tooltip"));
            }

            // V5 material modes dropdown. Photo is the default (no override).
            // Flat strips the texture; Half-photo dims it for cleaner shadows.
            const materialModesKV = {};
            materialModesKV[t("terrainUI.buildingMaterial.modes.photo")] = "photo";
            materialModesKV[t("terrainUI.buildingMaterial.modes.flat")] = "flat";
            materialModesKV[t("terrainUI.buildingMaterial.modes.halfPhoto")] = "halfPhoto";
            this.terrainTweaks.add(this, "buildingsMaterialMode", materialModesKV)
                .name(t("terrainUI.buildingMaterial.label"))
                .tooltip(t("terrainUI.buildingMaterial.tooltip"))
                .listen()
                .onChange(mode => {
                    if (this.buildingsNode) {
                        this.buildingsNode.setMaterialMode(mode, this.buildingsFlatColor);
                    }
                });
            this.terrainTweaks.addColor(this, "buildingsFlatColor")
                .name(t("terrainUI.buildingFlatColor.label"))
                .tooltip(t("terrainUI.buildingFlatColor.tooltip"))
                .listen()
                .onChange(c => {
                    if (this.buildingsNode) {
                        this.buildingsNode.setMaterialMode(this.buildingsMaterialMode, c);
                    }
                });

            // "Tree Removal" — flatten/remove tree geometry from Google
            // Photorealistic tiles (meaningless for OSM, so Google-only).
            if (hasGoogle) {
                this.buildTreeRemovalGUI();
            }
        }

        // Ellipsoid Earth Model toggle (moved here from global settings)
        this.ellipsoidController = this.terrainTweaks.add(Sit, "useEllipsoid")
            .name(t("terrainUI.useEllipsoid.label"))
            .tooltip(t("terrainUI.useEllipsoid.tooltip"))
            .listen()
            .onChange((v) => {
                // 3D building tiles are aligned to the WGS84 ellipsoid.
                // Keep this hard dependency enforced in UI.
                if (!v && this.showBuildings) {
                    Sit.useEllipsoid = true;
                    this.applyUseEllipsoid(true);
                    if (this.ellipsoidController) this.ellipsoidController.updateDisplay();
                    return;
                }

                this.applyUseEllipsoid(v);
            });

        console.log("CNodeTerrainUI: calling setMapType for initial map type " + this.mapType);
        // setMapType is async because it loads the capabilities
        this.setMapType(this.mapType).then(() => {
            // not async any more
        })

        this.terrainNode = new CNodeTerrain({
            id: initialID,
            UINode: this});

        // Create buildings node if enabled at startup
        if (this.showBuildings) {
            this.toggleBuildings(true);
        }

        // Set initial UI visibility
        this.updateUIVisibility();

        // Set initial attribution overlay
        this.updateAttribution();

        // Register fallback callbacks for when internet services become unavailable.
        // Elevation: switch to "Flat" if the elevation service goes down
        ServiceAvailability.onUnavailable("aws", () => {
            if (this.elevationType !== "Flat" && this.elevationSources["Flat"]) {
                this.elevationType = "Flat";
                this.terrainNode.reloadMap(this.mapType);
                this.updateAttribution();
            }
        });

        // Map textures: switch to an offline fallback if map services go down
        const mapFallback = (serviceName) => {
            // Only switch if we're currently using a source that depends on this service
            const currentDef = this.mapSources[this.mapType];
            if (!currentDef) return;
            // Check if the current map source generates URLs matching the failed service
            // by testing a sample URL
            if (currentDef.mapURL) {
                const sampleUrl = currentDef.mapURL(0, 0, 0);
                if (sampleUrl && identifyServiceFromUrl(sampleUrl) === serviceName) {
                    const fallbackType = this.mapSources["NoClouds"] ? "NoClouds"
                        : this.mapSources["FlatShading"] ? "FlatShading" : "Debug";
                    this.mapType = fallbackType;
                    this.setMapType(fallbackType).then(() => {
                        this.terrainNode.loadMapTexture(fallbackType);
                    });
                    this.updateAttribution();
                }
            }
        };
        for (const svcName of ["mapbox", "maptiler", "osm", "eox", "esri"]) {
            ServiceAvailability.onUnavailable(svcName, mapFallback);
        }

    }

    // Shared handler for an elevation-source change (the dropdown's onChange and
    // the programmatic fallbacks both call this). Unloads the old elevation map
    // and forces a subdivision pass so the new tiles load even when paused — the
    // camera-fingerprint gate would otherwise block them until the view moves
    // (same reason doRefresh() does this for the Refresh button).
    onElevationTypeChanged() {
        this.log("Elevation type changed to " + this.elevationType + " so unloading the elevation map");
        this.terrainNode.reloadMap(this.mapType);
        this.updateAttribution();
        this.requestSubdivisionPass();
    }

    // Rebuild the elevation dropdown from the current elevationSources (e.g. after
    // a source has been removed). lil-gui's .options() destroys and recreates the
    // controller, so we re-apply listen/name/tooltip/onChange.
    rebuildElevationMenu() {
        this.elevationTypesKV = {};
        for (const elevationType in this.elevationSources) {
            const def = this.elevationSources[elevationType];
            if (hasRequiredToken(def)) {
                this.elevationTypesKV[def.name] = elevationType;
            }
        }
        if (this.elevationTypeMenu && typeof this.elevationTypeMenu.options === "function") {
            this.elevationTypeMenu = this.elevationTypeMenu
                .options(this.elevationTypesKV)
                .listen()
                .name(t("terrainUI.elevationType.label"))
                .tooltip(t("terrainUI.elevationType.tooltip"));
            this.elevationTypeMenu.onChange(() => this.onElevationTypeChanged());
        }
    }

    // Called when a "Local" elevation tile fails to load. Local tiles are served
    // from our own origin (SITREC_TERRAIN), so a failure means the data simply
    // isn't present (e.g. no sitrec-terrain volume mounted) rather than a transient
    // network outage. Quietly drop "Local" as an elevation source — a console
    // warning, NOT a user-facing error and NOT the cross-service "offline fallback"
    // modal — and fall back to "Flat" if Local was the selected source. The missing
    // source itself is the guard: once removed, repeat calls (from other in-flight
    // tiles) are no-ops, so this runs its work only once per terrain instance.
    handleLocalElevationMissing() {
        if (!this.elevationSources || !this.elevationSources["Local"]) return;
        delete this.elevationSources["Local"];
        console.warn('[Sitrec] "Local" elevation tiles not found (no local terrain data present) — ' +
            'removing "Local" as an elevation source. Mount a sitrec-terrain volume to enable it.');

        const wasSelected = (this.elevationType === "Local");
        if (wasSelected && this.elevationSources["Flat"]) {
            this.elevationType = "Flat";
        }
        this.rebuildElevationMenu();
        if (wasSelected) {
            this.onElevationTypeChanged();
        }
    }

    // gettor and settor for layer
    get layer() {
        return this._layer;
    }

    set layer(v) {
        console.log("CNodeTerrainUI: setting layer to " + v+" was "+this._layer);
        this._layer = v;
    }


    updateUIVisibility() {
        // When Dynamic Subdivision is true, hide lat, lon, zoom, nTiles and zoom to track
        // When Dynamic Subdivision is false, hide Disable Dynamic Subdivision
        if (this.dynamic) {
            // Hide lat, lon, zoom, nTiles and zoom to track controllers
            if (this.latController) {
                this.latController.domElement.style.display = 'none';
            }
            if (this.lonController) {
                this.lonController.domElement.style.display = 'none';
            }
            if (this.zoomController) {
                this.zoomController.domElement.style.display = 'none';
            }
            if (this.nTilesController) {
                this.nTilesController.domElement.style.display = 'none';
            }
            if (this.zoomToTrackSwitchObject && this.zoomToTrackSwitchObject.controller) {
                this.zoomToTrackSwitchObject.controller.domElement.style.display = 'none';
            }
            // Show Disable Dynamic Subdivision controller (if it exists)
            if (this.disableDynamicSubdivisionController) {
                this.disableDynamicSubdivisionController.domElement.style.display = '';
            }
        } else {
            // Show lat, lon, zoom, nTiles and zoom to track controllers
            if (this.latController) {
                this.latController.domElement.style.display = '';
            }
            if (this.lonController) {
                this.lonController.domElement.style.display = '';
            }
            if (this.zoomController) {
                this.zoomController.domElement.style.display = '';
            }
            if (this.nTilesController) {
                this.nTilesController.domElement.style.display = '';
            }
            if (this.zoomToTrackSwitchObject && this.zoomToTrackSwitchObject.controller) {
                this.zoomToTrackSwitchObject.controller.domElement.style.display = '';
            }
            // Hide Disable Dynamic Subdivision controller (if it exists)
            if (this.disableDynamicSubdivisionController) {
                this.disableDynamicSubdivisionController.domElement.style.display = 'none';
            }
        }
    }

    updateGlobeVisibility() {
        // Globe should only be loaded/displayed when:
        // 1. Sit.useGlobe is true
        // 2. Globals.dynamicSubdivision is false
        const shouldShowGlobe = Sit.useGlobe && !Globals.dynamicSubdivision;
        
        if (shouldShowGlobe && !par.globe) {
            // Need to load the globe
            console.log("Loading globe (useGlobe=true, dynamicSubdivision=false)");
            par.globe = addAlignedGlobe(Sit.globeScale ?? (Sit.terrain !== undefined ? 0.9999 : 1.0));
            showHider(par.globe, "[G]lobe", true, "g").name(t("showHiders.globe.label"));
        } else if (!shouldShowGlobe && par.globe) {
            // Need to hide/remove the globe
            console.log("Hiding globe (useGlobe=" + Sit.useGlobe + ", dynamicSubdivision=" + Globals.dynamicSubdivision + ")");
            par.globe.visible = false;
        } else if (shouldShowGlobe && par.globe) {
            // Globe exists and should be visible
            par.globe.visible = true;
        }
    }

    applyUseEllipsoid(v) {
        updateEarthRadii(v);

        if (par.globe) {
            const globeScale = Sit.globeScale ?? (Sit.terrain !== undefined ? 0.9999 : 1.0);
            updateAlignedGlobe(par.globe, globeScale);
        }

        if (this.terrainNode) {
            this.terrainNode.updateGreySphereVisibility();
        }

        this.markOceanSurfaceDirty();
        this.rebuildOceanSurfaceTiles(true);

        // World coords for a given lat/lon/alt change with the radii, so rebuild
        // the manual-edit dab cache and re-apply at the new positions.
        if (this.buildingsNode) {
            this.buildingsNode.rebuildDabsWorld();
            this.buildingsNode.restoreTreeFlatten();
        }

        setRenderOne(true);
    }

    forceEllipsoidForBuildings() {
        if (!Sit.useEllipsoid) {
            Sit.useEllipsoid = true;
            this.applyUseEllipsoid(true);
            if (this.ellipsoidController) this.ellipsoidController.updateDisplay();
        }
    }

    forceDynamicForBuildings() {
        if (!this.dynamic) {
            this.dynamic = true;
            Globals.dynamicSubdivision = true;
            this.updateUIVisibility();
            this.terrainNode.reloadMap(this.mapType);
            this.updateGlobeVisibility();
            this.terrainNode.updateGreySphereVisibility();
            if (this.dynamicController) this.dynamicController.updateDisplay();
        }
    }

    toggleBuildings(show) {
        if (show && !this.canUse3DBuildings) {
            console.warn("CNodeTerrainUI: 3D Buildings not enabled for this user.");
            this.showBuildings = false;
            return;
        }

        if (show) {
            this.forceEllipsoidForBuildings();
            this.forceDynamicForBuildings();
        }

        if (show && !this.buildingsNode) {
            const cesiumToken = Globals.userData?.CESIUM_ION_TOKEN;
            const googleKey = Globals.userData?.GOOGLE_MAPS_API_KEY;
            if (!cesiumToken && !googleKey) {
                this.showBuildings = false;
                return;
            }
            this.buildingsNode = new CNodeBuildings3DTiles({
                id: "buildings3DTiles",
                source: this.buildingsSource,
                cesiumIonToken: cesiumToken,
                googleApiKey: googleKey,
                materialMode: this.buildingsMaterialMode,
                flatColor: this.buildingsFlatColor,
                treeFlattenParams: this.treeFlattenParams,
            });
            this.buildingsNode.setShowEdges(this.showBuildingEdges);
        } else if (!show && this.buildingsNode) {
            NodeMan.disposeRemove(this.buildingsNode);
            this.buildingsNode = null;
        }

        this.updateTerrainAndOceanVisibility();

        // Update grey sphere visibility — it checks buildingsNode directly now.
        if (this.terrainNode) {
            this.terrainNode.updateGreySphereVisibility();
        }

        this.updateAttribution();
    }

    isGooglePhotorealisticActive() {
        return !!this.buildingsNode && this.buildingsNode._activeSource === "google-photorealistic";
    }

    // Build the "Edit Geometry (Trees)" GUI folder, data-driven from
    // TREE_FLATTEN_DEFS so the controls and the algorithm never drift. Manual-edit
    // controls (`top`) sit at the folder root; the tree-specific automatic-removal
    // heuristics live in an "Automatic Tree Removal" sub-menu. Controls bind
    // directly to the shared this.treeFlattenParams object.
    buildTreeRemovalGUI() {
        const tf = this.treeFlattenParams;
        const root = this.gui.addFolder("Edit Geometry (Trees)").close();
        const autoRoot = root.addFolder("Automatic Tree Removal").close();
        const subFolders = {};
        // `top` defs → root; everything else → the auto sub-menu (with its own
        // sub-sub-folders by def.folder).
        const folderFor = (def) => {
            if (def.top) return root;
            if (!def.folder) return autoRoot;
            if (!subFolders[def.folder]) subFolders[def.folder] = autoRoot.addFolder(def.folder).close();
            return subFolders[def.folder];
        };
        // An automatic-heuristic param changed — restore and re-run with new params.
        const onParamChange = () => {
            if (this.buildingsNode) this.buildingsNode.applyTreeFlattenParams();
        };

        for (const def of TREE_FLATTEN_DEFS) {
            const f = folderFor(def);
            let ctrl;
            if (def.key === "flattenTrees") {
                ctrl = f.add(tf, def.key).name(def.label).onChange(v => {
                    if (this.buildingsNode) this.buildingsNode.setTreeFlattenEnabled(v);
                });
            } else if (def.key === "manualEdit") {
                // Manual-edit mode toggle: enables the paint brush. Does NOT
                // restore/reprocess tiles.
                ctrl = f.add(tf, def.key).name(def.label).onChange(v => {
                    if (this.buildingsNode) this.buildingsNode.setManualEditEnabled(v);
                });
            } else if (def.key === "applyEdits") {
                // Master toggle for re-applying the persistent manual edits.
                ctrl = f.add(tf, def.key).name(def.label).onChange(v => {
                    if (this.buildingsNode) this.buildingsNode.setApplyEdits(v);
                });
            } else if (def.manual) {
                // Other manual-brush controls (e.g. Brush Radius): bind the value
                // only — read live by the brush, no restore/reprocess on change.
                ctrl = (def.type === "bool")
                    ? f.add(tf, def.key).name(def.label)
                    : f.add(tf, def.key, def.min, def.max, def.step).name(def.label);
            } else if (def.type === "bool") {
                ctrl = f.add(tf, def.key).name(def.label).onChange(onParamChange);
            } else if (def.type === "enum") {
                ctrl = f.add(tf, def.key, def.options).name(def.label).onChange(onParamChange);
            } else {
                // Numeric: re-run on release (onFinishChange) so dragging a
                // slider doesn't restore+reprocess every tile on every tick.
                ctrl = f.add(tf, def.key, def.min, def.max, def.step).name(def.label).onFinishChange(onParamChange);
            }
            if (def.tooltip && ctrl.tooltip) ctrl.tooltip(def.tooltip);
            if (ctrl.listen) ctrl.listen();
        }

        // Root: reset everything (drop saved edits + restore original geometry).
        root.add({restore: () => { if (this.buildingsNode) this.buildingsNode.clearAllEdits(); }}, "restore")
            .name("Restore Geometry")
            .tooltip("Reset everything: discard the saved manual edits and restore all tiles to their original geometry");
        // Auto sub-menu: restore + re-run the automatic pass with current params.
        autoRoot.add({rerun: () => { if (this.buildingsNode) this.buildingsNode.applyTreeFlattenParams(); }}, "rerun")
            .name("Re-run")
            .tooltip("Restore and re-process visible tiles with the current automatic parameters");
    }

    // treeFlattenParams is serialized as a whole object, but MERGED into the
    // existing instance on load so GUI controllers and the buildings node keep
    // their shared reference (replacing it would orphan both).
    modSerialize() {
        return {
            ...super.modSerialize(),
            treeFlattenParams: {...this.treeFlattenParams},
        };
    }

    modDeserialize(v) {
        super.modDeserialize(v);
        if (v.treeFlattenParams) {
            Object.assign(this.treeFlattenParams, v.treeFlattenParams);
            if (!Array.isArray(this.treeFlattenParams.dabs)) this.treeFlattenParams.dabs = [];
            if (this.buildingsNode) {
                // Rebuild the world-space dab cache from the loaded lat/lon/alt
                // list so the saved manual edits re-apply as tiles load.
                this.buildingsNode.rebuildDabsWorld();
                this.buildingsNode.applyTreeFlattenParams();
            }
        }
    }

    ensureOceanSurface() {
        if (this.oceanSurfaceGroup) return;

        this.oceanSurfaceMaterial = new MeshPhongMaterial({
            color: 0x2f6aa8,
            emissive: 0x0d2a46,
            transparent: true,
            opacity: 0.35,
            depthTest: true,
            depthWrite: false,
            shininess: 70,
            side: DoubleSide,
        });

        this.oceanSurfaceGroup = new Group();
        this.oceanSurfaceGroup.layers.mask = LAYER.MASK_MAIN | LAYER.MASK_LOOK;
        this.oceanSurfaceGroup.visible = false;
        this.oceanSurfaceGroup.renderOrder = 1;
        GlobalScene.add(this.oceanSurfaceGroup);

        this.markOceanSurfaceDirty();
    }

    markOceanSurfaceDirty() {
        this.oceanSurfaceNeedsRebuild = true;
        this.oceanSurfaceNextRefreshAtMs = 0;
    }

    getOceanSurfaceTileSignature(tiles) {
        const keys = tiles.map(tile => tile.key()).sort().join(",");
        return `${Globals.equatorRadius}:${Globals.polarRadius}:${this.mapType}:${this.oceanSurfaceDatum}:${keys}`;
    }

    getActiveOceanSurfaceTiles() {
        const terrainMap = this.terrainNode?.maps?.[this.mapType]?.map;
        if (!terrainMap) {
            return [];
        }

        const activeTiles = [];
        terrainMap.forEachTile(tile => {
            if (!tile || !tile.mesh || !tile.tileLayers) {
                return;
            }

            // Only drop parent coverage when all four children are present and usable.
            // Frozen/partial subdivision can leave sparse child sets; dropping parent
            // unconditionally creates large visible holes.
            if (this.tileHasCompleteUsableChildCoverage(tile)) {
                return;
            }
            activeTiles.push(tile);
        });
        return activeTiles;
    }

    tileHasCompleteUsableChildCoverage(tile) {
        if (!tile?.children || tile.children.length < 4) {
            return false;
        }

        for (let i = 0; i < 4; i++) {
            const child = tile.children[i];
            if (!child || !child.mesh || !child.tileLayers) {
                return false;
            }
        }

        return true;
    }

    addOceanTriangle(indices, waterMask, a, b, c) {
        if (waterMask[a] && waterMask[b] && waterMask[c]) {
            indices.push(a, b, c);
        }
    }

    createOceanSurfaceGeometryForTile(tile) {
        const mapProjection = tile.map?.options?.mapProjection;
        const elevationMap = this.terrainNode?.elevationMap;
        const tileCenter = tile.mesh?.position;
        if (!mapProjection || !elevationMap || !tileCenter) {
            return null;
        }

        const grid = OCEAN_SURFACE_TILE_GRID;
        const vertexCount = grid * grid;
        const positions = new Float32Array(vertexCount * 3);
        const waterMask = new Uint8Array(vertexCount);

        for (let j = 0; j < grid; j++) {
            const v = j / (grid - 1);
            const yWorld = tile.y + v;
            const lat = mapProjection.getNorthLatitude(yWorld, tile.z);

            for (let i = 0; i < grid; i++) {
                const u = i / (grid - 1);
                const xWorld = tile.x + u;
                const lon = mapProjection.getLeftLongitude(xWorld, tile.z);

                const geoidOffset = meanSeaLevelOffset(lat, lon);
                const oceanAltitudeHAE = geoidOffset + OCEAN_SURFACE_OFFSET_METERS;
                const oceanPoint = LLAToECEF(lat, lon, oceanAltitudeHAE);

                const idx = j * grid + i;
                const p = idx * 3;
                positions[p] = oceanPoint.x - tileCenter.x;
                positions[p + 1] = oceanPoint.y - tileCenter.y;
                positions[p + 2] = oceanPoint.z - tileCenter.z;

                const {elevation: terrainElevation, tileZ} = elevationMap.getElevationWithTileInfo(lat, lon, tile.z);
                const waterThreshold = geoidOffset + OCEAN_SURFACE_WATER_THRESHOLD_METERS;
                waterMask[idx] = (tileZ >= 0 && terrainElevation <= waterThreshold) ? 1 : 0;
            }
        }

        const indices = [];
        for (let j = 0; j < grid - 1; j++) {
            for (let i = 0; i < grid - 1; i++) {
                const a = j * grid + i;
                const b = a + 1;
                const c = a + grid;
                const d = c + 1;

                this.addOceanTriangle(indices, waterMask, a, c, b);
                this.addOceanTriangle(indices, waterMask, b, c, d);
            }
        }

        if (indices.length === 0) {
            return null;
        }

        const geometry = new BufferGeometry();
        geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
        geometry.setIndex(indices);
        geometry.computeVertexNormals();
        geometry.computeBoundingSphere();
        return geometry;
    }

    clearOceanSurfaceTiles() {
        if (!this.oceanSurfaceGroup) {
            return;
        }

        const oldChildren = [...this.oceanSurfaceGroup.children];
        for (const child of oldChildren) {
            this.oceanSurfaceGroup.remove(child);
            child.geometry?.dispose();
        }
    }

    rebuildOceanSurfaceTiles(force = false) {
        if (!this.oceanSurfaceGroup || !this.oceanSurfaceMaterial) {
            return;
        }

        const activeTiles = this.getActiveOceanSurfaceTiles();
        const signature = this.getOceanSurfaceTileSignature(activeTiles);
        const now = Date.now();

        if (!force
            && !this.oceanSurfaceNeedsRebuild
            && signature === this.oceanSurfaceTileSignature
            && now < this.oceanSurfaceNextRefreshAtMs) {
            return;
        }

        this.clearOceanSurfaceTiles();

        for (const tile of activeTiles) {
            const geometry = this.createOceanSurfaceGeometryForTile(tile);
            if (!geometry) {
                continue;
            }

            const mesh = new Mesh(geometry, this.oceanSurfaceMaterial);
            mesh.layers.mask = LAYER.MASK_MAIN | LAYER.MASK_LOOK;
            mesh.position.copy(tile.mesh.position);
            mesh.renderOrder = 1;
            this.oceanSurfaceGroup.add(mesh);
        }

        this.oceanSurfaceTileSignature = signature;
        this.oceanSurfaceNeedsRebuild = false;
        this.oceanSurfaceNextRefreshAtMs = now + OCEAN_SURFACE_REFRESH_MS;
    }

    setOceanSurfaceVisible(visible) {
        if (visible) {
            this.ensureOceanSurface();
            this.rebuildOceanSurfaceTiles(true);
        }
        if (this.oceanSurfaceGroup) {
            this.oceanSurfaceGroup.visible = visible;
        }
    }

    updateTerrainAndOceanVisibility() {
        const googleActive = this.isGooglePhotorealisticActive();
        this.setTerrainVisible(!googleActive);
        this.setOceanSurfaceVisible(googleActive && this.showOceanSurface);
    }

    disposeOceanSurface() {
        if (!this.oceanSurfaceGroup) return;
        this.clearOceanSurfaceTiles();
        GlobalScene.remove(this.oceanSurfaceGroup);
        this.oceanSurfaceMaterial?.dispose();
        this.oceanSurfaceGroup = null;
        this.oceanSurfaceMaterial = null;
        this.oceanSurfaceTileSignature = null;
        this.oceanSurfaceNeedsRebuild = false;
        this.oceanSurfaceNextRefreshAtMs = 0;
    }

    setTerrainVisible(visible) {
        if (this.terrainNode && this.terrainNode.group) {
            this.terrainNode.group.visible = visible;
        }
    }

    getSourceDef() {
        // get the mapSource for the current mapType
        const sourceDef = this.mapSources[this.mapType];
        assert(sourceDef !== undefined, "CNodeTerrain: sourceDef for " + this.mapType + " not found in mapSources")
        return sourceDef;
    }


    setMapType(v) {
        const mapType = v;
        assert(this.mapSources, "CNodeTerrainUI: mapSources not defined");
        const mapDef = this.mapSources[mapType];

        assert(mapDef !== undefined, "CNodeTerrainUI: mapDef for " + mapType + " not found in mapSources");


        if (mapDef.capabilities !== undefined) {
            if (mapDef.layer === undefined) {
                alert("Map type " + mapType + " requires a default 'layer' property when using 'capabilities' to define layers.");
                return;
            }
            this.loadCapabilitiesInBackground(mapType, mapDef);
        }

        this.mapDef = mapDef;

        // only set the layer if it is not already set
        if (!this.layer) {
            this.layer = this.mapDef.layer;
        }

        if (mapDef.layers !== undefined) {
            // use the pre-defined layers. of the fake layer we generated last time
            this.updateLayersMenu(mapDef.layers);
        } else {
            // a temp layer menu with just a single layer of the mapType
            const fakeLayer = {};
            fakeLayer[mapDef.layer ?? "default"] = {
            }
            mapDef.layers = fakeLayer;
            this.updateLayersMenu(fakeLayer);
        }
        return Promise.resolve();
    }

    loadCapabilitiesInBackground(mapType, mapDef) {
        return fetch(mapDef.capabilities)
            .then(response => response.text())
            .then(data => {
                const parser = new DOMParser();
                const xmlDoc = parser.parseFromString(data, "text/xml");

                const contents = xmlDoc.getElementsByTagName("Contents");
                mapDef.layers = {}

                if (contents.length > 0) {
                    console.log("Capabilities for " + mapType)
                    const layers = xmlDoc.getElementsByTagName("Layer");
                    for (let layer of layers) {
                        const layerName = layer.getElementsByTagName("ows:Identifier")[0].textContent;
                        mapDef.layers[layerName] = {}
                    }
                } else {
                    const layers = xmlDoc.getElementsByTagName("Layer");
                    for (let layer of layers) {
                        const layerName = layer.getElementsByTagName("Name")[0].childNodes[0].nodeValue;
                        mapDef.layers[layerName] = {}
                    }
                }

                if (this.mapType === mapType) {
                    this.updateLayersMenu(mapDef.layers);
                }
            })
            .catch(error => {
                console.error("Error fetching capabilities for " + mapType + " from " + mapDef.capabilities + ": " + error.message);
                
                if (mapType !== "Debug") {
                    console.log("Falling back to Debug map type");
                    this.mapType = "Debug";
                    return this.setMapType("Debug");
                } else {
                    mapDef.layers = {};
                    this.updateLayersMenu({});
                }
            });
    }

    updateLayersMenu(layers) {

        this.layersMenu?.destroy()
        this.layersMenu = null;

        // layers is an array of layer names
        // we want a KV pair for the GUI
        // where both K and V are the layer name
        this.localLayers = {}

        // iterate over keys (layer names) to make the identicak KV pair for the GUI
        for (let layer in layers) {
            this.localLayers[layer] = layer
        }

        // set the layer to the specified default, or the first one in the capabilities
        if (this.mapDef.layer !== undefined) {
            if (!this.layer) {
                this.layer = this.mapDef.layer;
            }
        } else {
            this.layer = Object.keys(this.localLayers)[0]
        }
        this.layersMenu = this.gui.add(this, "layer", this.localLayers).listen().name(t("terrainUI.layer.label"))
            .tooltip(t("terrainUI.layer.tooltip"))
            .moveAfter("Map Type")

        // if the layer has changed, then unload the map and reload it
        // new layer will be handled by the mapDef.layer
        this.layersMenu.onChange(v => {

            this.terrainNode.unloadMap(this.mapType)
            this.terrainNode.loadMap(this.mapType)
            // Re-arm the subdivision grace so the new layer's tiles refine even
            // when the camera is static — mirrors the Map Type handler. Without
            // this, loadMap rebuilds the texture map down to its coarse root and
            // the static-camera grace gate (already decayed) blocks any further
            // subdivision until the camera moves or the user clicks Refresh.
            this.requestSubdivisionPass();
        })

        // Keep the advanced "Terrain Tweaks" sub-folder at the bottom of the Terrain menu,
        // below all the primary controls (it is created early so the controls can go in it).
        if (this.terrainTweaks) this.terrainTweaks.moveToEnd();

    }

    updateAttribution() {
        if (!Globals.settings?.showAttribution) {
            setMapAttribution(null);
            setElevationAttribution(null);
            setTilesAttribution("");
            return;
        }
        const googleActive = this.isGooglePhotorealisticActive();
        // Google 3D tiles replace the basemap, so hide map attribution when active
        setMapAttribution(googleActive ? null : this.mapSources[this.mapType]);
        setElevationAttribution(this.elevationSources[this.elevationType]);
        setTilesAttribution(this.buildingsNode ? this.buildingsNode.getAttribution() : "");
    }

    // note this is not the most elegant way to do this
    // but if the terrain is being removed, then we assume the GUI is too
    // this might not be the case, in the future
    dispose() {
        if (this.buildingsNode) {
            NodeMan.disposeRemove(this.buildingsNode);
            this.buildingsNode = null;
        }
        this.disposeOceanSurface();
        disposeAttributionOverlay();
        super.dispose();
    }


    zoomToTrack(v) {
        if (Globals.dontAutoZoom || Globals.disposing) return;
        const trackNode = NodeMan.get(v);
        if (!trackNode || !trackNode.getLLAExtents) return;
        const {minLat, maxLat, minLon, maxLon, minAlt, maxAlt} = trackNode.getLLAExtents();

        this.zoomToLLABox(minLat, maxLat, minLon, maxLon)

    }

    // given two Vector3s, zoom to the box they define
    zoomToBox(min, max) {
        // min and max are in ECEF, so convert to LLA
        const minLLA = ECEFToLLAVD_radii(min);
        const maxLLA = ECEFToLLAVD_radii(max);
        this.zoomToLLABox(minLLA.x, maxLLA.x, minLLA.y, maxLLA.y)
    }

    zoomToLLABox(minLat, maxLat, minLon, maxLon) {
        this.lat = (minLat + maxLat) / 2;
        this.lon = (minLon + maxLon) / 2;

        const maxZoom = 15;
        const minZoom = 3;

        // find the zoom level that fits the track, ignore altitude
        // clamp to maxZoom
        // NOTE THIS IS NOT ACCOUNTING FOR WEB MERCATOR PROJECTION
        const latDiff = maxLat - minLat;
        const lonDiff = maxLon - minLon;
        if (latDiff < 0.0001 || lonDiff < 0.0001) {
            this.zoom = maxZoom;
        } else {
            const latZoom = Math.log2(360 / latDiff);
            const lonZoom = Math.log2(180 / lonDiff);
            this.zoom = Math.min(maxZoom, Math.floor(Math.min(latZoom, lonZoom) - 1));
            this.zoom = Math.max(minZoom, this.zoom);
        }
        this.latController.updateDisplay();
        this.lonController.updateDisplay();
        this.zoomController.updateDisplay();
        this.nTilesController.updateDisplay();

        // reset the switch
        this.zoomToTrackSwitchObject.selectFirstOptionQuietly();


        this.doRefresh();
    }


    doRefresh() {
        this.log("Refreshing terrain")
        assert(this.terrainNode.maps[this.mapType].map !== undefined, "Terrain map not defined when trying the set startLoading")

        if (!this.dynamic) {
            // old way, defer loading
            this.startLoading = true;
            this.flagForRecalculation();
        } else {
            // for dynamic maps, they are async anyway
            this.terrainNode.reloadMap(this.mapType)
        }

        // Subdivision is normally gated on camera movement (a fingerprint hash
        // of camera state). When the user clicks Refresh, changes Max Details,
        // or adjusts a detail slider while the camera is stationary, the gate
        // never opens and the new state never gets applied. Force a pass.
        this.requestSubdivisionPass();
    }

    /**
     * Force the next CNodeTerrainUI.update() to run a subdivision pass even if
     * the cameras haven't moved. Use after any UI/state change that should
     * cause tiles to re-evaluate (refresh, detail sliders, source change).
     */
    requestSubdivisionPass() {
        this._lastCameraFingerprint = null;        // guarantees mismatch next tick
        this._subdivGraceFrames = 120;             // ~4s of subdivision passes
        setRenderOne(true);                        // also kick a render so the result is visible
    }

    flagForRecalculation() {
        this.recalculateSoon = true;
    }

    update() {
        if (this.recalculateSoon) {
            console.log("Recalculating terrain as recalculatedSoon is true. startLoading=" + this.startLoading)

            // something of a patch with terrain, as it's often treated as a global
            // by other nodes (like the track node, when using accurate terrain for KML polygons)
            // so we recalculate it first, and then recalculate all the other nodes
            this.recalculate();

            this.recalculateSoon = false;
        }

        // we need to wait for this.terrainNode.maps[this.mapType].map to be defined
        // because it's set async in setMapType
        // setMapType can be waiting for the capabilities to be loaded
        // if (this.startLoading && this.terrainNode.maps[this.mapType].map !== undefined) {
        //     console.log("Starting to load terrain as startLoading is true, recalulateSoon=" + this.recalculateSoon)
        //     this.startLoading = false;
        //     assert(this.terrainNode.maps[this.mapType].map !== undefined, "Terrain map not defined")
        //     this.terrainNode.maps[this.mapType].map.startLoadingTiles();
        //     assert(this.terrainNode.elevationMap !== undefined, "Elevation map not defined")
        //     this.terrainNode.elevationMap.startLoadingTiles();
        // }


        if (this.dynamic & !this.disableDynamicSubdivision) {

            const views = [
                NodeMan.get("lookView"),
                NodeMan.get("mainView")
            ];

            assert(this.terrainNode, "CNodeTerrainUI: terrainNode not defined in update dynamic subdivision")

            // Call view-independent operations once per frame for elevation map
            if (this.terrainNode.elevationMap !== undefined) {
                this.terrainNode.elevationMap.subdivideTilesGeneral();
            }

            // Call view-independent operations once per frame for texture map
            if (this.terrainNode.maps[this.mapType].map !== undefined) {
                this.terrainNode.maps[this.mapType].map.subdivideTilesGeneral();
            }

            // Skip expensive view-specific subdivision if cameras haven't moved
            // AND tiles have had time to settle. We use a grace period so that
            // tiles still loading when the camera stops continue to get subdivided.
            let cameraFingerprint = 0;
            for (const view of views) {
                if (view && view.visible && view.camera) {
                    view.camera.updateMatrixWorld(true);
                    const e = view.camera.matrixWorld.elements;
                    // Hash a few matrix elements that change on any move/rotate/zoom
                    cameraFingerprint += e[0] + e[5] + e[10] + e[12] + e[13] + e[14];
                    cameraFingerprint += view.camera.fov + view.camera.zoom;
                    // ...AND the viewport pixel size. Screen-space LOD error is measured in
                    // real pixels (camera._viewportHeightPx = view.heightPx in
                    // subdivideTilesViewSpecific), so a resize WITHOUT a camera move —
                    // fullscreen toggle, window resize, tiling layout change — still needs
                    // finer/coarser tiles. Omitting this left the terrain coarse after
                    // fullscreen until the camera moved. Weighted so width/height changes
                    // can't cancel out in the sum.
                    cameraFingerprint += (view.widthPx ?? 0) + (view.heightPx ?? 0) * 1.31;
                }
            }
            if (cameraFingerprint !== this._lastCameraFingerprint) {
                this._lastCameraFingerprint = cameraFingerprint;
                this._subdivGraceFrames = 120; // keep subdividing for ~4s after camera stops
            } else if (this._subdivGraceFrames > 0) {
                this._subdivGraceFrames--;
            }

            // Keep a short grace alive ONLY while tiles are genuinely loading
            // (network/decode in flight), so textures that finish AFTER the
            // camera-driven grace expired still get one coverage pass (otherwise
            // a freshly-loaded child renders alongside its still-active parent —
            // z-fighting). pendingTileLoads is the authoritative in-flight set;
            // when the last load completes the grace decays over 5 frames, which
            // is the cleanup window.
            //
            // We must NOT gate this on _dirtyParents.size or a tile-count
            // signature. Both create a feedback loop: a coverage pass flips a
            // tile's active state (or re-marks a parent dirty) as a SIDE EFFECT,
            // which changes the signal, which refreshes grace, which runs another
            // pass that flips it back — churning forever with a static camera and
            // re-arming the render loop every frame (~600% CPU / continuous
            // render). During that churn pendingTileLoads is empty, so gating on
            // real loads lets grace decay and the scene finally settles; genuine
            // loading still extends it. A camera move resets grace to 120.
            const textureMap = this.terrainNode.maps[this.mapType]?.map;
            if (textureMap?.pendingTileLoads?.size > 0 && this._subdivGraceFrames < 5) {
                this._subdivGraceFrames = 5;
            }

            if (this._subdivGraceFrames > 0) {
                // Prepare each view's camera with effective zoom + pan for accurate LOD.
                // This ensures tile subdivision uses the actual rendered FOV and direction.
                for (const view of views) {
                    if (view && view.visible && view.prepareCameraForLOD) {
                        view.prepareCameraForLOD();
                    }
                }

                // subdivide the elevation first so elevation requests will come before textures
                // this makes it more likely that the elevation will be ready when the texture is ready to make a tile.
                if (this.terrainNode.elevationMap !== undefined) {
                    // Higher elevationDetail → smaller error target → more refinement.
                    const elevationTarget = this.elevationErrorTarget / this.elevationDetail;
                    for (const view of views) {
                        if (view && view.visible) {
                            this.terrainNode.elevationMap.subdivideTilesViewSpecific(view, elevationTarget);
                        }
                    }
                }

                // For texture maps, call subdivideTilesViewSpecific separately for each view
                if (this.terrainNode.maps[this.mapType].map !== undefined) {
                    const mapDef = this.mapSources[this.mapType];
                    const baseTarget = mapDef?.errorTargetPixels ?? this.textureErrorTarget;
                    const textureTarget = baseTarget / this.textureDetail;

                    for (const view of views) {
                        if (view && view.visible) {
                            this.terrainNode.maps[this.mapType].map.subdivideTilesViewSpecific(view, textureTarget);
                        }
                    }
                }

                // Restore cameras after LOD evaluation
                for (const view of views) {
                    if (view && view.visible && view.restoreCameraAfterLOD) {
                        view.restoreCameraAfterLOD();
                    }
                }
            }

        }

        if (this.oceanSurfaceGroup?.visible) {
            this.rebuildOceanSurfaceTiles();
        }

        // Self-disable the paused keep-alive once the terrain is fully settled, so
        // the render loop can sleep (shouldSleepAnimationLoop needs
        // hasPausedBackgroundWork()===false). Running this node's update() ~60x/sec
        // while paused-but-focused — even though each call is cheap — kept the loop
        // alive and pegged the GC threads (~600% CPU). "Settled" = no subdivision
        // grace left, nothing loading, no pending recalc/refresh. While asleep, a
        // camera move (controls -> setRenderOne) or an async tile-load completion
        // (-> setRenderOne) wakes the loop, which re-runs this update, re-detects
        // work (grace gets re-armed / pendingTileLoads grows) and re-enables itself.
        // pendingTileLoads is a Set that only QuadTreeMapTexture maintains; the
        // elevation map (QuadTreeMapElevation) has no such field, so it needs the
        // per-tile isLoadingElevation flag instead. Keep the loop awake while either
        // map still has work in flight so freshly-loaded tiles get drawn.
        const texMap = this.terrainNode?.maps?.[this.mapType]?.map;
        const elevMap = this.terrainNode?.elevationMap;
        const texMapPending = texMap?.pendingTileLoads?.size > 0;
        const elevMapPending = !!elevMap?.getAllTiles?.().some(t => t.isLoadingElevation);
        // NOTE: do NOT include this.startLoading here — its only reset site is
        // commented out, so it would latch updateWhilePaused true forever (loop never
        // sleeps) after a Refresh/detail change on a non-dynamic terrain sitch.
        this.updateWhilePaused = this._subdivGraceFrames > 0
            || texMapPending || elevMapPending
            || !!this.recalculateSoon || !!this.refresh;
    }

    recalculate() {
        // if the values have changed, then we need to make a new terrain node
        if (this.lat === this.oldLat && this.lon === this.oldLon && this.zoom === this.oldZoom
            && this.nTiles === this.oldNTiles
            && !this.refresh) {

            if (this.elevationScale === this.oldElevationScale)
                return;

            // // so JUST the elevation scale has changed, so we can just update the elevation map
            // // and recalculate the curves for the tiles in the current map

            const map = this.terrainNode.maps[this.mapType].map;
            map.options.zScale = this.elevationScale;

            //also set the elevation scale on the elevation map
            // (probably only need to do this)
            if (this.terrainNode.elevationMap) {
                this.terrainNode.elevationMap.options.zScale = this.elevationScale;
            }

            map.recalculateCurveMap(this.terrainNode.radius, true)

            return;

        }
        this.oldLat = this.lat;
        this.oldLon = this.lon;
        this.oldZoom = this.zoom;
        this.oldNTiles = this.nTiles;
        this.oldElevationScale = this.elevationScale;
        this.refresh = false;


        let terrainID = "TerrainModel"
        // remove the old terrain
        if (this.terrainNode) {
            terrainID = this.terrainNode.id;
            NodeMan.disposeRemove(this.terrainNode)
        }
        // and make a new one
        this.terrainNode = new CNodeTerrain({
            id: terrainID,
            deferLoad: true,
            UINode: this,
            }
        )

        this.updateTerrainAndOceanVisibility();
    }

    // one time button to add a terrain node
    addTerrain() {
        this.recalculate();
        this.gui.remove(this.addTerrain)
    }


}
