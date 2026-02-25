import {CNode3DGroup} from "./CNode3DGroup";
import {GlobalNightSkyScene, GlobalScene, GlobalSunSkyScene, setupNightSkyScene, setupSunSkyScene} from "../LocalFrame";
import {Color, Group, Matrix4, Ray, Raycaster, Scene, Sphere, Vector3} from "three";
import {degrees, radians} from "../utils";
import {FileManager, GlobalDateTimeNode, Globals, guiMenus, guiShowHide, NodeMan, setRenderOne, Sit} from "../Globals";
import {
    DebugArrow,
    DebugArrowAB,
    DebugWireframeSphere,
    propagateLayerMaskObject,
    setLayerMaskRecursive
} from "../threeExt";
import {ECEFToLLAVD_Sphere, EUSToECEF, getLST, raDecToAzElRADIANS, wgs84} from "../LLA-ECEF-ENU";
// npm install three-text2d --save-dev
// https://github.com/gamestdio/three-text2d
//import { MeshText2D, textAlign } from 'three-text2d'
import * as LAYER from "../LayerMasks";
import {par} from "../par";


import {CNodeDisplayGlobeCircle} from "./CNodeDisplayGlobeCircle";
import {CNodeDisplayEarthShadow} from "./CNodeDisplayEarthShadow";
import {CNodeDisplayMoonShadow} from "./CNodeDisplayMoonShadow";
import {assert} from "../assert.js";
import {intersectSphere2, V3} from "../threeUtils";
import {
    getCelestialDirectionFromRaDec,
    getGeocentricBodyPositionEUS,
    getJulianDate,
    getSiderealTime,
    raDecToAltAz
} from "../CelestialMath";
import {ViewMan} from "../CViewManager";
import {CNodeLabeledArrow} from "./CNodeLabels3D";
import {CNodeDisplaySkyOverlay} from "./CNodeDisplaySkyOverlay";
import {CNodeViewUI} from "./CNodeViewUI";
import {CNodeViewEphemeris} from "./CNodeViewEphemeris";
import {CNodeSkyPlotView} from "./CNodeSkyPlotView";
//import { eci_to_geodetic } from '../../pkg/eci_convert.js';
// npm install satellite.js --save-dev
// installed with
// npm install astronomy-engine --save-dev
// in the project dir (using terminal in PHPStorm)
import * as Astronomy from "astronomy-engine";

// Star field rendering system
import {CStarField} from "./CStarField";
import {CCelestialElements} from "./CCelestialElements";
import {CPlanets} from "./CPlanets";
import {CSatellite} from "./CSatellite";
import {EventManager} from "../CEventManager";


// other source of stars, if we need more (for zoomed-in pics)
// https://www.astronexus.com/hyg

// TLE Data is in fixed positions in a 69 character string, which is how the satellite.js library expects it
// but sometimes we get it with spaces removed, as it's copied from a web page
// so we need to fix that
// 1 48274U 21035A 21295.90862762 .00005009 00000-0 62585-4 0 9999
// 2 48274 41.4697 224.1728 0006726 240.5427 202.4055 15.60684462 27671
// becomes
// 0000000001111111111222222222233333333334444444444555555555566666666667777777777
// 1234567890123456789012345678901234567890123456789012345678901234567890123456789
// 1 48274U 21035A   21295.90862762  .00005009  00000-0  62585-4 0  9999
// 2 48274  41.4697 224.1728 0006726 240.5427 202.4055 15.60684462 27671


// 0000000001111111111222222222233333333334444444444555555555566666666667777777777
// 1234567890123456789012345678901234567890123456789012345678901234567890123456789
// 1 48274U 21035A 21296.86547910 .00025288 00000-0 29815-3 0 9999
// 1 48274U 21035A   21296.86547910  .00025288  00000-0  29815-3 0  9999
// 2 48274 41.4699 218.3498 0006788 245.5794 180.5604 15.60749710 27823
// 2 48274  41.4699 218.3498 0006788 245.5794 180.5604 15.60749710 27823

// 0 STARLINK-1007
// 1 44713U 19074A   23216.03168702  .00031895  00000-0  21481-2 0  9995
// 2 44713  53.0546 125.3135 0001151  98.9698 261.1421 15.06441263205939


// NightSkyFiles - loaded when Sit.nightSky is true, defined in ExtraFiles.js
// export const NightSkyFiles = {
//     IAUCSN: "nightsky/IAU-CSN.txt",
//     BSC5: "nightsky/BSC5.bin",
// }


export class CNodeDisplayNightSky extends CNode3DGroup {

    constructor(v) {
        if (v.id === undefined) v.id = "NightSkyNode"
        super(v);
        //     this.checkInputs(["cloudData", "material"])
        this.addInput("startTime", GlobalDateTimeNode)


        if (GlobalNightSkyScene === undefined) {
            setupNightSkyScene(new Scene())
        }
        if (GlobalSunSkyScene === undefined) {
            setupSunSkyScene(new Scene())
        }

        const satGUI = guiMenus.satellites

        // globe used for collision
        // and specifying the center of the Earth
        // Use POLAR_RADIUS (slightly smaller than equatorial) so that cameras on
        // the surface at equatorial radius are outside the sphere, avoiding false
        // ray-sphere intersections for above-horizon satellites.
        this.globe = new Sphere(new Vector3(0, 0, 0), wgs84.POLAR_RADIUS)

        this.camera = NodeMan.get("lookCamera").camera;
        assert(this.camera, "CNodeDisplayNightSky needs a look camera")

        this.mainCamera = NodeMan.get("mainCamera").camera;
        assert(this.mainCamera, "CNodeDisplayNightSky needs a main camera")

        // Create star field instance for rendering stars
        this.starField = new CStarField({
            starLimit: Sit.starLimit ?? 6.5,
            starScale: Sit.starScale ?? 1.0,
            sphereRadius: 100
        });

        // Create celestial elements instance (grid, constellations)
        this.celestialElements = new CCelestialElements({
            sphereRadius: 100
        });

        // Create planets instance
        this.planets = new CPlanets({
            sphereRadius: 100
        });

        // Create satellites instance
        this.satellites = new CSatellite({
            showSatelliteTracks: Sit.showSatelliteTracks ?? false,
            showFlareTracks: Sit.showFlareTracks ?? false,
            showSatelliteGround: Sit.showSatelliteGround ?? false,
            flareAngle: 5,
            penumbraDepth: 5000
        });

        this.firstRenderTLE = true;
        EventManager.addEventListener("tleLoaded", () => {
            this.firstRenderTLE = true;
        });

        if (Globals.env?.SITREC_USE_CUSTOM_TLE) {

            const menuName = Globals.env.SITREC_CUSTOM_TLE_MENU_NAME || "Custom Satellites";
            const tooltipText = Globals.env.SITREC_CUSTOM_TLE_TOOLTIP || "Load custom TLE data for satellites from the custom source.";


            satGUI.add(this.satellites,"updateCustomSats").name(menuName)
                .onChange(function (x) {this.parent.close()})
                .tooltip(tooltipText)

        }

        if (Globals.env?.SITREC_ENABLE_DEFAULT_TLE_SOURCES) {

            satGUI.add(this.satellites, "updateLEOSats").name("Load LEO Satellites For Date")
                .onChange(function (x) {
                    this.parent.close()
                })
                .tooltip("Get the latest LEO Satellite TLE data for the set simulator date/time. This will download the data from the internet, so it may take a few seconds.\nWill also enable the satellites to be displayed in the night sky.")
        }

        if (process.env.CURRENT_STARLINK) {
            satGUI.add(this.satellites, "updateStarlink").name("Load CURRENT Starlink")
                .onChange(function (x) {
                    this.parent.close()
                })
                .tooltip("Get the CURRENT (not historical, now, real time) Starlink satellite positions. This will download the data from the internet, so it may take a few seconds.\n")
        }

        if (process.env.CURRENT_ACTIVE) {
            satGUI.add(this.satellites, "updateActive").name("Load ACTIVE Satellites")
                .onChange(function (x) {
                    this.parent.close()
                })
                .tooltip("Get the CURRENT (not historical, now, real time) ACTIVE satellite positions. This will download the data from the internet, so it may take a few seconds.\n")
        }

        if (Globals.env?.SITREC_ENABLE_DEFAULT_TLE_SOURCES) {

            satGUI.add(this.satellites, "updateSLOWSats").name("(Experimental) Load SLOW Satellites")
                .onChange(function (x) {
                    this.parent.close()
                })
                .tooltip("Get the latest SLOW Satellite TLE data for the set simulator date/time. This will download the data from the internet, so it may take a few seconds.\nWill also enable the satellites to be displayed in the night sky. Might time-out for recent dates")

            satGUI.add(this.satellites, "updateALLSats").name("(Experimental) Load ALL Satellites")
                .onChange(function (x) {
                    this.parent.close()
                })
                .tooltip("Get the latest Satellite TLE data for ALL the satellites for the set simulator date/time. This will download the data from the internet, so it may take a few seconds.\nWill also enable the satellites to be displayed in the night sky. Might time-out for recent dates")
        }

        satGUI.add(this.satellites, 'flareAngle', 0, 20, 0.1).listen().name("Flare Angle Spread").tooltip("Maximum angle of the reflected view vector for a flare to be visible\ni.e. the range of angles between the vector from the satellite to the sun and the vector from the camera to the satellite reflected off the bottom of the satellite (which is parallel to the ground)")
        this.addSimpleSerial("flareAngle")


        satGUI.add(this.satellites, 'penumbraDepth', 0, 100000, 1).listen().name("Earth's Penumbra Depth")
            .tooltip("Vertical depth in meters over which a satellite fades out as it enters the Earth's shadow")
        this.addSimpleSerial("penumbraDepth")

        this.showSunArrows = Sit.showSunArrows;
        this.sunArrowGroup = new Group();
        this.sunArrowGroup.visible = this.showSunArrows;
        GlobalScene.add(this.sunArrowGroup)
        satGUI.add(this, "showSunArrows").listen().onChange(() => {
            setRenderOne(true);
            this.sunArrowGroup.visible = this.showSunArrows;
        }).name("Sun Angle Arrows")
            .tooltip("When glare is detected, show arrows from camera to satellite, and then satellite to sun")
        this.addSimpleSerial("showSunArrows")

        this.celestialGUI = guiShowHide.addFolder("Celestial").close().tooltip("night sky related things");

        this.addCelestialArrow("Venus")
        this.addCelestialArrow("Mars")
        this.addCelestialArrow("Jupiter")
        this.addCelestialArrow("Saturn")
        this.addCelestialArrow("Sun")
        this.addCelestialArrow("Moon")

        this.celestialArrowsOnTraverse = false;
        this.celestialGUI.add(this, "celestialArrowsOnTraverse")
            .listen()
            .onChange((x) => {
                if (x) {
                    this.updateCelestialArrowsTo("traverseObject")
                } else {
                    this.updateCelestialArrowsTo("lookCamera")
                }
            })
            .name("Vectors On Traverse")
            .tooltip("If checked, the vectors are shown relative to the traverse object. Otherwise they are shown relative to the look camera.");


        this.celestialArrowsInLookView = false;
        this.celestialGUI.add(this, "celestialArrowsInLookView")
            .listen()
            .onChange((x) => {
                if (x) {
                    this.updateCelestialArrowsMask(LAYER.MASK_LOOKRENDER)
                } else {
                    this.updateCelestialArrowsMask(LAYER.MASK_HELPERS)
                }
            })
            .name("Vectors in Look View")
            .tooltip("If checked, the vectors are shown in the Look View Otherwise just the main view.");


        this.flareRegionGroup = new Group();
        // get a string of the current time in MS
        const timeStamp = new Date().getTime().toString();
        this.flareRegionGroup.debugTimeStamp = timeStamp;
        this.flareRegionGroup.visible = this.showFlareRegion;
        GlobalScene.add(this.flareRegionGroup)

        this.flareBandGroup = new Group();

        new CNodeDisplayGlobeCircle({
            id: "globeCircle1",
            normal: new Vector3(1, 0, 0),
            color: [1, 1, 0],
            width: 2,
            offset: 3000000,
            container: this.flareBandGroup,
        })

        new CNodeDisplayGlobeCircle({
            id: "globeCircle2",
            normal: new Vector3(1, 0, 0),
            color: [0, 1, 0],
            width: 2,
            offset: 5000000,
            container: this.flareBandGroup,
        })

        GlobalScene.add(this.flareBandGroup)


        setLayerMaskRecursive(this.flareBandGroup, LAYER.MASK_HELPERS);


        if (Sit.showEathShadow === undefined)
            Sit.showEarthShadow = false;


        this.earthShadow = new CNodeDisplayEarthShadow({
            id: "earthShadow",
            altitude: this.earthShadowAltitude,
            fromSun: this.satellites.fromSun.clone(),
            gui: this.celestialGUI,
            visible: Sit.showEarthShadow,
        });

        if (Sit.showMoonShadow === undefined)
            Sit.showMoonShadow = false;

        this.moonShadow = new CNodeDisplayMoonShadow({
            id: "moonShadow",
            gui: this.celestialGUI,
            visible: Sit.showMoonShadow,
        });

        this.showFlareRegion = Sit.showFlareRegion;
        this.showFlareBand = Sit.showFlareBand;

        this.maxLabelsDisplayed = 1000;

        const satelliteOptions = [
            {
                key: "showSatellites", name: "Show Satellites (Global)", object: this.satellites, action: () => {
                    this.satelliteGroup.visible = this.satellites.showSatellites;
                    this.satellites.filterSatellites()
                }
            },
            {
                key: "showStarlink",
                name: "Starlink",
                object: this.satellites,
                action: () => this.satellites.filterSatellites()
            },
            {key: "showISS", name: "ISS", object: this.satellites, action: () => this.satellites.filterSatellites()},
            {
                key: "showBrightest",
                name: "Celestrack's Brightest",
                object: this.satellites,
                action: () => this.satellites.filterSatellites()
            },
            {
                key: "showOtherSatellites",
                name: "Other Satellites",
                object: this.satellites,
                action: () => this.satellites.filterSatellites()
            },
            {
                key: "showSatelliteList",
                name: "List",
                object: this.satellites,
                action: () => this.satellites.filterSatellites()
            },
            {
                key: "showSatelliteTracks",
                name: "Satellite Arrows",
                object: this.satellites,
                action: () => this.satelliteTrackGroup.visible = this.satellites.showSatelliteTracks
            },
            {
                key: "showFlareTracks",
                name: "Flare Lines",
                object: this.satellites,
                action: () => this.satelliteFlareTracksGroup.visible = this.satellites.showFlareTracks
            },
            {
                key: "showSatelliteGround",
                name: "Satellite Ground Arrows",
                object: this.satellites,
                action: () => this.satelliteGroundGroup.visible = this.satellites.showSatelliteGround
            },
            {
                key: "showSatelliteNames",
                name: "Satellite Labels (Look View)",
                object: this.satellites,
                action: () => setRenderOne(true)
            },
            {
                key: "showSatelliteNamesMain",
                name: "Satellite Labels (Main View)",
                object: this.satellites,
                action: () => setRenderOne(true)
            },
            {
                key: "labelFlares",
                name: "Label Flares Only",
                object: this.satellites,
                action: () => setRenderOne(true)
            },
            {
                key: "labelLit",
                name: "Label Lit Only",
                object: this.satellites,
                action: () => setRenderOne(true)
            },
            {
                key: "labelLookVisible",
                name: "Label Look Visible Only",
                object: this.satellites,
                action: () => setRenderOne(true)
            },
            {
                key: "showFlareRegion",
                name: "Flare Region",
                object: this,
                action: () => this.flareRegionGroup.visible = this.showFlareRegion
            },
            {
                key: "showFlareBand",
                name: "Flare Band",
                object: this,
                action: () => this.flareBandGroup.visible = this.showFlareBand
            },
        ];

        satelliteOptions.forEach(option => {
            satGUI.add(option.object, option.key).listen().onChange(() => {
                setRenderOne(true);
                option.action();
            }).name(option.name);
            // All satellite properties now have getters/setters on NightSkyNode
            // so they should be serialized directly (not with satellites. prefix)
            this.addSimpleSerial(option.key);
        });

        satGUI.add(this, "maxLabelsDisplayed", 100, 10000, 100).listen().name("Max Labels Displayed")
            .onChange(() => setRenderOne(true));
        this.addSimpleSerial("maxLabelsDisplayed");

        this.flareBandGroup.visible = this.showFlareBand;

        // NOTE: older vars set from Sit
        // they will get saves as all of Sit is saved
        // the addSimpleSerial calls were doing nothing

        // Create star brightness slider and store reference
        this.guiStarScale = guiMenus.view.add(Sit, "starScale", 0, 3, 0.01).name("Star Brightness").listen()
            .tooltip("Scale factor for the brightness of the stars. 1 is normal, 0 is invisible, 2 is twice as bright, etc.")
            .onChange(() => {
                setRenderOne(true);
                // Update star field scale
                this.starField.updateScale(Sit.starScale);
                if (Sit.lockStarPlanetBrightness) {
                    Sit.planetScale = Sit.starScale;
                    this.guiPlanetScale.updateDisplay();
                }
            })

        if (Sit.starLimit === undefined)
            Sit.starLimit = 15; // default to 15 if not set


        guiMenus.view.add(Sit, "starLimit", -2, 15, 0.01).name("Star Limit").listen()
            .tooltip("Brightness limit for stars to be displayed")
            .onChange(() => {
                setRenderOne(true);
                this.starField.updateStarVisibility(Sit.starLimit, this.celestialSphere);
            })


        if (Sit.planetScale === undefined)
            Sit.planetScale = 1; // default to 1 if not set

        if (Sit.lockStarPlanetBrightness === undefined)
            Sit.lockStarPlanetBrightness = true; // default to true (locked) if not set

        // Create planet brightness slider and store reference
        this.guiPlanetScale = guiMenus.view.add(Sit, "planetScale", 0, 3, 0.01).name("Planet Brightness").listen()
            .tooltip("Scale factor for the brightness of the planets (except Sun and Moon). 1 is normal, 0 is invisible, 2 is twice as bright, etc.")
            .onChange(() => {
                if (Sit.lockStarPlanetBrightness) {
                    Sit.starScale = Sit.planetScale;
                    this.guiStarScale.updateDisplay();
                }
            })

        // Add lock checkbox
        guiMenus.view.add(Sit, "lockStarPlanetBrightness").name("Lock Star Planet Brightness").listen()
            .tooltip("When checked, the Star Brightness and Planet Brightness sliders are locked together")

        satGUI.add(Sit, "satScale", 0, 50, 0.01).name("Sat Brightness").listen()
            .tooltip("Scale factor for the brightness of the satellites. 1 is normal, 0 is invisible, 2 is twice as bright, etc.")

        satGUI.add(Sit, "flareScale", 0, 1, 0.001).name("Flare Brightness").listen()
            .tooltip("Scale factor for the additional brightness of flaring satellites. 0 is nothing")


        satGUI.add(Sit, "satCutOff", 0, 0.5, 0.001).name("Sat Cut-Off").listen()
            .tooltip("Satellites dimmed to this level or less will not be displayed")


        satGUI.add(this.satellites, "arrowRange", 10, 100000, 1).name("Display Range (km)").listen()
            .tooltip("Satellites beyond this distance will not have their names or arrows displayed")
            .onChange(() => {
                this.satellites.filterSatellites();
                setRenderOne(true);
            })
        this.addSimpleSerial("arrowRange");


        // Sun Direction will get recalculated based on data (in satellites)


        this.celestialSphere = new Group();
        GlobalNightSkyScene.add(this.celestialSphere)

        // Create a separate celestial sphere for the day sky scene
        this.celestialDaySphere = new Group();
        if (GlobalSunSkyScene) {
            GlobalSunSkyScene.add(this.celestialDaySphere);
        }

        this.satelliteGroup = new Group();
        GlobalScene.add(this.satelliteGroup)

        // a sub-group for the satellite tracks
        this.satelliteTrackGroup = new Group();
        this.satelliteGroup.add(this.satelliteTrackGroup)
        this.satelliteFlareTracksGroup = new Group();
        this.satelliteGroup.add(this.satelliteFlareTracksGroup)
        this.satelliteGroundGroup = new Group();
        this.satelliteGroup.add(this.satelliteGroundGroup)

//        console.log("Loading stars")
        this.starField.addToScene(this.celestialSphere)

//        console.log("Loading planets")
        this.planets.addPlanets(this.celestialSphere, this.celestialDaySphere, {
            date: this.in.startTime.dateNow,
            cameraPos: this.camera.position,
            ecefToLla: (pos) => {
                const ecef = EUSToECEF(pos);
                return ECEFToLLAVD_Sphere(ecef);
            }
        })


        // if (FileManager.exists("starLink")) {
        //     console.log("parsing starlink")
        //     this.replaceTLE(FileManager.get("starLink"))
        // }

        // the file used is now passed in as a parameter "starlink"
        // this is the id of the file in the FileManager
        // which might be the filename, or an ID.
        if (v.starLink !== undefined) {
            console.log("parsing starlink " + v.starLink)
            if (FileManager.exists(v.starLink)) {
                this.replaceTLE(FileManager.get(v.starLink))
            } else {
                if (v.starLink !== "starLink")
                    console.warn("Starlink file/ID " + v.starLink + " does not exist")
            }
        }

//        console.log("Adding celestial grid")
        this.equatorialSphereGroup = new Group();
        this.celestialSphere.add(this.equatorialSphereGroup);
        this.celestialElements.addCelestialSphereLines(this.equatorialSphereGroup, 10);
        this.showEquatorialGrid = (v.showEquatorialGrid !== undefined) ? v.showEquatorialGrid : true;


        this.celestialGUI.add(this, "showEquatorialGrid").listen().onChange(() => {
            setRenderOne(true);
            this.updateVis()
        }).name("Equatorial Grid")
        this.addSimpleSerial("showEquatorialGrid")


        this.constellationsGroup = new Group();
        this.celestialSphere.add(this.constellationsGroup);
        this.showConstellations = (v.showConstellations !== undefined) ? v.showConstellations : true;
        this.celestialGUI.add(this, "showConstellations").listen().onChange(() => {
            setRenderOne(true);
            this.updateVis()
        }).name("Constellation Lines")
        this.addSimpleSerial("showConstellations")
        this.celestialElements.addConstellationLines(this.constellationsGroup)

        this.showStars = (v.showStars !== undefined) ? v.showStars : true;
        this.celestialGUI.add(this, "showStars").listen().onChange(() => {
            setRenderOne(true);
            this.updateVis()
        }).name("Render Stars")
        this.addSimpleSerial("showStars")

        this.celestialElements.addConstellationNames(this.constellationsGroup);

        // For the stars to show up in the lookView
        // we need to enable the layer for everything in the celestial sphere.
        this.celestialSphere.layers.enable(LAYER.LOOK);  // probably not needed
        propagateLayerMaskObject(this.celestialSphere)


        // Not longer used?
        // this.useDayNight = (v.useDayNight !== undefined) ? v.useDayNight : true;
        // guiShowHide.add(this,"useDayNight" ).listen().onChange(()=>{
        //     setRenderOne(true);
        // }).name("Day/Night Sky")


        this.showEquatorialGridLook = (v.showEquatorialGridLook !== undefined) ? v.showEquatorialGridLook : true;
        this.celestialGUI.add(this, "showEquatorialGridLook").listen().onChange(() => {
            setRenderOne(true);
            this.updateVis()

        }).name("Equatorial Grid in Look View")
        this.addSimpleSerial("showEquatorialGridLook")

        // same for the flare region
        this.showFlareRegionLook = false;
        satGUI.add(this, "showFlareRegionLook").listen().onChange(() => {
            if (this.showFlareRegionLook) {
                this.flareRegionGroup.layers.mask = LAYER.MASK_LOOKRENDER;
            } else {
                this.flareRegionGroup.layers.mask = LAYER.MASK_HELPERS;
            }
            propagateLayerMaskObject(this.flareRegionGroup);
        }).name("Flare Region in Look View");
        this.addSimpleSerial("showFlareRegionLook");


        this.updateVis()


        this.recalculate()

        this.rot = 0


        const labelMainViewPVS = new CNodeViewUI({id: "labelMainViewPVS", overlayView: ViewMan.list.mainView.data});
        // labelMainViewPVS.addText("videoLabelp1", "L = Lat/Lon from cursor",    10, 2, 1.5, "#f0f00080")
        // labelMainViewPVS.addText("videoLabelp2", ";&' or [&] ' advance start time", 12, 4, 1.5, "#f0f00080")
        // labelMainViewPVS.addText("videoLabelp3", "Drag and drop .txt or .tle files", 12, 6, 1.5, "#f0f00080")
        // labelMainViewPVS.setVisible(true)

        //
        // labelMainViewPVS.addText("videoLabelp1", "",    10, 2, 1.5, "#f0f00080").update(function() {
        //     this.text = "sitchEstablished = "+Globals.sitchEstablished;
        // })


        par.validPct = 0;
        const nightSky = this;
        labelMainViewPVS.addText("videoLabelInRange", "xx", 100, 2, 1.5, "#f0f00080", "right").update(function () {

            this.text = "";

            const TLEData = nightSky.satellites.TLEData;
            if (TLEData !== undefined && TLEData.satData !== undefined && TLEData.satData.length > 0) {
                // format dates as YYYY-MM-DD HH:MM
                this.text = "TLEs: " + TLEData.startDate.toISOString().slice(0, 19).replace("T", " ") + " - " +
                    TLEData.endDate.toISOString().slice(0, 19).replace("T", " ") + "   ";
            }

            this.text += par.validPct ? "In Range:" + par.validPct.toFixed(1) + "%" : "";

            // if validPct < 95%, make text red, if 99-100 yellow, if 100% green
            if (par.validPct < 95) {
                this.color = "#ff8080";
            } else if (par.validPct < 100) {
                this.color = "#ffff00";
            } else {
                this.color = "#00ff00";
            }

        });

        EventManager.addEventListener("tleLoaded", () => {
            if (!this.ephemerisView) {
                this.ephemerisView = new CNodeViewEphemeris({
                    id: "ephemerisView",
                    nightSkyNode: this,
                    visible: false,
                    draggable: true, resizable: true, freeAspect: true,
                    left: 0.05, top: 0.10, width: 0.60, height: 0.80,
                });
                
                this.celestialGUI.add(this.ephemerisView, "show").name("Satellite Ephemeris").onChange(() => {
                    this.celestialGUI.close();
                });
            }
            
            if (!this.skyPlotView) {
                this.skyPlotView = new CNodeSkyPlotView({
                    id: "skyPlotView",
                    nightSkyNode: this,
                    visible: false,
                    draggable: true, resizable: true, freeAspect: true,
                    left: 0.60, top: 0.10, width: 0.35, height: 0.35,
                });
                
                this.celestialGUI.add(this.skyPlotView, "show").name("Sky Plot").onChange(() => {
                    this.celestialGUI.close();
                });
            }
        });

//        console.log("Done with CNodeDisplayNightSky constructor")
    }

    // See updateArrow
    addCelestialArrow(name) {
        const flagName = "show" + name + "Arrow";
        const groupName = name + "ArrowGroup";
        const obName = name + "ArrowOb";

        this[flagName] = Sit[flagName] ?? false;
        this[groupName] = new CNode3DGroup({id: groupName});
        this[groupName].show(this[flagName]);

        this[obName] = new CNodeLabeledArrow({
            id: obName,
            visible: this[flagName],
            start: "lookCamera",
            direction: V3(0, 0, 1),
            length: -200,
            color: this.planets.planetColors[this.planets.planets.indexOf(name)],
            groupNode: groupName,
            label: name,
            labelPosition: "1",
            offsetY: 20,
            // checkDisplayOutputs: true,
        })


        this.celestialGUI.add(this, flagName).listen().onChange(() => {
            setRenderOne(true);
            this[obName].show(this[flagName]);
            this[groupName].show(this[flagName]);
        }).name(name + " Vector");
        this.addSimpleSerial(flagName)
    }

    // Update all celestial arrows to use a new start object
    updateCelestialArrowsTo(startObject) {

        this.planets.planets.forEach(name => {
            const obName = name + "ArrowOb";
            if (this[obName]) {
                // Remove the old input connection and add the new one
                this[obName].removeInput("start");
                this[obName].addInput("start", startObject);
            }
        });

        // it takes two frames for this to have an effect
        setRenderOne(2);
    }

    // Update all celestial arrows to use a new start object
    updateCelestialArrowsMask(mask) {

        this.planets.planets.forEach(name => {
            const groupName = name + "ArrowGroup";
            if (this[groupName]) {
                this[groupName].group.layers.mask = mask;
                this[groupName].propagateLayerMask()
            }
        });

        // it takes two frames for this to have an effect
        setRenderOne(2);
    }


    updateVis() {

        this.equatorialSphereGroup.visible = this.showEquatorialGrid;
        this.constellationsGroup.visible = this.showConstellations;
        if (this.starSprites) {
            this.starSprites.visible = this.showStars;
        }

        // equatorial lines might not want to be in the look view
        this.equatorialSphereGroup.layers.mask = this.showEquatorialGridLook ? LAYER.MASK_MAINRENDER : LAYER.MASK_HELPERS;

        this.sunArrowGroup.visible = this.showSunArrows;
        this.VenusArrowGroup.show(this.showVenusArrow);
        this.MarsArrowGroup.show(this.showMarsArrow);
        this.JupiterArrowGroup.show(this.showJupiterArrow);
        this.SunArrowGroup.show(this.showSunArrow);
        this.MoonArrowGroup.show(this.showMoonArrow);
        this.flareRegionGroup.visible = this.showFlareRegion;
        this.flareBandGroup.visible = this.showFlareBand;
        this.satelliteGroup.visible = this.satellites.showSatellites;
        this.satelliteTrackGroup.visible = this.satellites.showSatelliteTracks;
        this.satelliteFlareTracksGroup.visible = this.satellites.showFlareTracks;
        this.satelliteGroundGroup.visible = this.satellites.showSatelliteGround;

        propagateLayerMaskObject(this.equatorialSphereGroup)
    }

    modDeserialize(v) {
        super.modDeserialize(v);

        if (Globals.exportTagNumber <= 2025003) {
            console.log("Old save with Dispay Range, updating from " + this.arrowRange + " to 100000");
            this.arrowRange = 100000;
        }


        // a guid value's .listen() only updates the gui, so we need to do it manually
        // perhaps better to flag the gui system to update it?
        this.satellites.filterSatellites();
        this.updateVis();


    }

    update(frame) {

        if (this.useDayNight) {
            const sun = Globals.sunTotal / Math.PI;
            this.sunLevel = sun;
            const blue = new Vector3(0.53, 0.81, 0.92)
            blue.multiplyScalar(sun)
            this.skyColor = new Color(blue.x, blue.y, blue.z)
        }


        // Reset both celestial spheres to identity
        this.celestialSphere.quaternion.identity()
        this.celestialSphere.updateMatrix()

        if (this.celestialDaySphere) {
            this.celestialDaySphere.quaternion.identity()
            this.celestialDaySphere.updateMatrix()
        }

        // The celestial sphere star data is in ECI (Earth-Centered Inertial) coordinates:
        //   X = vernal equinox (RA=0), Y = RA=6h, Z = north celestial pole
        // In ECEF, Z is also the north pole. The only difference is Earth's rotation:
        // ECEF X (lon=0) points at RA = GMST on the celestial sphere.
        // So we just rotate by -GMST around Z to convert ECI → ECEF.
        // (The old EUS code also needed lat/lon tilts and a 180° Y flip
        //  to convert from Z-up celestial to Y-up local tangent plane.)

        var nowDate = this.in.startTime.dateNow;
        const GMST = getSiderealTime(nowDate, 0); // degrees

        const rotationMatrixZ = new Matrix4();
        rotationMatrixZ.makeRotationZ(radians(-GMST));

        this.celestialSphere.applyMatrix4(rotationMatrixZ)

        if (this.celestialDaySphere) {
            this.celestialDaySphere.applyMatrix4(rotationMatrixZ)
        }


        var nowDate = this.in.startTime.dateNow

        // Use lookCamera position for observer instead of fixed Sit coordinates
        const cameraPos = this.camera.position;
        const cameraEcef = EUSToECEF(cameraPos);
        const cameraLLA = ECEFToLLAVD_Sphere(cameraEcef);
        let observer = new Astronomy.Observer(cameraLLA.x, cameraLLA.y, cameraLLA.z);
        // update the planets position for the current time
        for (const [name, planet] of Object.entries(this.planets.planetSprites)) {
            // Update both the regular sprite and day sky sprite in one call
            this.planets.updatePlanetSprite(name, planet.sprite, nowDate, observer, planet.daySkySprite)
            // Update celestial arrows and Sun-specific calculations
            const planetData = this.planets.planetSprites[name];
            this.updateArrow(name, planetData.ra, planetData.dec, nowDate, observer, 100)
        }

        if (this.satellites.showSatellites && this.satellites.TLEData) {
            // Update satellites to correct position for nowDate
            const satResult = this.satellites.updateAllSatellites(nowDate, {
                lookCameraPos: this.camera.position,
                satelliteTrackGroup: this.satelliteTrackGroup,
                satelliteGroundGroup: this.satelliteGroundGroup
            });
            // Calculate percentage of valid satellites, only counting those not filtered out
            if (satResult && this.satellites.TLEData.satData.length > 0) {
                par.validPct = (satResult.validCount / satResult.visibleCount) * 100;
            }
            
            this.updateSatelliteBrightness();
        }

        //const fromSun = this.satellites.fromSun

        if (this.showFlareBand && NodeMan.exists("globeCircle1")) {
            const globeCircle1 = NodeMan.get("globeCircle1")
            globeCircle1.normal = this.satellites.fromSun.clone().normalize();
            globeCircle1.rebuild();
            const globeCircle2 = NodeMan.get("globeCircle2")
            globeCircle2.normal = this.satellites.fromSun.clone().normalize();
            globeCircle2.rebuild();
        }

    }

    updateSatelliteBrightness() {
        if (!this.satellites.showSatellites || !this.satellites.TLEData) {
            return;
        }

        if (!this.satellites.lightCloud || !this.satellites.lightCloud.material) {
            return;
        }

        const toSun = this.satellites.toSun;
        const raycaster = new Raycaster();
        raycaster.layers.mask |= LAYER.MASK_MAIN | LAYER.MASK_LOOK;

        const hitPoint = new Vector3();
        const hitPoint2 = new Vector3();
        const magnitudes = this.satellites.lightCloud.brightnessArray;
        const cameraPos = this.camera.position;

        this.satTimeStep = 10;
        if (this.satStartTime === undefined) {
            this.satStartTime = 0;
        } else {
            this.satStartTime = (this.satStartTime + 1) % this.satTimeStep;
        }

        for (let i = 0; i < this.satellites.TLEData.satData.length; i++) {
            const satData = this.satellites.TLEData.satData[i];

            if (!satData.visible) {
                magnitudes[i] = 0;
                continue;
            }

            if (satData.invalidPosition) {
                magnitudes[i] = 0;
                this.satellites.removeSatelliteArrows(satData);
                this.satellites.removeSatSunArrows(satData);
                continue;
            }

            assert(satData.eus !== undefined, `satData.eus is undefined, i= ${i}`);

            // stagger updates unless it has an arrow or this is the first render after TLE load
            if (!this.firstRenderTLE && (i - this.satStartTime) % this.satTimeStep !== 0 && !satData.hasSunArrow) {
                magnitudes[i] = satData.lastScale || 0;
                continue;
            }

            const satPosition = satData.eus;
            let brightness = 0.04;
            const darknessMultiplier = 0.3;
            let fade = 1;

            raycaster.set(satPosition, toSun);
            if (intersectSphere2(raycaster.ray, this.globe, hitPoint, hitPoint2)) {
                const midPoint = hitPoint.clone().add(hitPoint2).multiplyScalar(0.5);
                const originToMid = midPoint.clone().sub(this.globe.center);
                const occludedMeters = this.globe.radius - originToMid.length();
                if (occludedMeters < this.satellites.penumbraDepth) {
                    fade = 1 - occludedMeters / this.satellites.penumbraDepth;
                    brightness *= darknessMultiplier + (1 - darknessMultiplier) * fade;
                } else {
                    fade = 0;
                    brightness *= darknessMultiplier;
                    this.satellites.removeSatSunArrows(satData);
                }
            }
            satData.isLit = fade > 0;

            if (fade > 0) {
                const camToSat = satPosition.clone().sub(cameraPos);
                raycaster.set(cameraPos, camToSat);
                const belowHorizon = intersectSphere2(raycaster.ray, this.globe, hitPoint, hitPoint2);

                if (!belowHorizon) {
                    if (satData.number === 25544) {
                        brightness *= 3;
                    }

                    const globeToSat = satPosition.clone().sub(this.globe.center).normalize();
                    const reflected = camToSat.clone().reflect(globeToSat).normalize();
                    const dot = Math.max(-1, Math.min(1, reflected.dot(toSun)));
                    const glintAngle = Math.abs(degrees(Math.acos(dot)));

                    const spread = this.satellites.flareAngle;
                    const ramp = spread * 0.25;
                    const middle = spread - ramp;
                    const glintSize = Sit.flareScale;

                    if (glintAngle < spread) {
                        let glintScale;
                        const d = Math.abs(glintAngle);
                        if (d < middle) {
                            glintScale = fade * glintSize;
                        } else {
                            const dOffset = d - middle;
                            glintScale = fade * glintSize * (ramp - dOffset) * (ramp - dOffset) / (ramp * ramp);
                        }
                        brightness += glintScale;

                        DebugArrowAB(satData.name, cameraPos, satPosition, "#FF0000", true, this.sunArrowGroup, 10, LAYER.MASK_HELPERS);
                        DebugArrowAB(satData.name + "sun", satPosition,
                            satPosition.clone().add(toSun.clone().multiplyScalar(10000000)), "#c08000", true, this.sunArrowGroup, 10, LAYER.MASK_HELPERS);

                        if (this.satellites.showFlareTracks) {
                            const dir = satData.eusB.clone().sub(satData.eusA).normalize();
                            DebugArrow(satData.name + "flare", dir, satData.eus, 100000, "#FFFF00", true, this.satelliteFlareTracksGroup, 20, LAYER.MASK_LOOKRENDER);
                        }

                        satData.hasSunArrow = true;
                        satData.isFlaring = true;
                    } else {
                        this.satellites.removeSatSunArrows(satData);
                        satData.isFlaring = false;
                    }
                } else {
                    this.satellites.removeSatSunArrows(satData);
                    satData.isFlaring = false;
                }
            } else {
                satData.isFlaring = false;
            }

            // need the /5 as brightness calculation has changed
            if (brightness < Sit.satCutOff/5) {
                brightness = 0;
            }

            satData.lastScale = brightness;
            magnitudes[i] = brightness;
        }
        this.satellites.lightCloud.markBrightnessNeedUpdate();
        this.firstRenderTLE = false;
    }

    updateSatelliteScales(view) {
        if (!this.satellites.showSatellites || !this.satellites.TLEData) {
            return;
        }

        if (!this.satellites.lightCloud || !this.satellites.lightCloud.material) {
            return;
        }

        const isLookView = (view.id === "lookView");

        if (isLookView) {
            const uniforms = this.satellites.lightCloud.material.uniforms;
            let shaderScale = Sit.satScale;
            shaderScale = view.adjustPointScale(shaderScale * 2);
            uniforms.baseScale.value = shaderScale;
            uniforms.distanceReference.value = 3000000;
        }
    }

    /*
// Actual data used.
0 STARLINK-1007
1 44713U 19074A   23216.03168702  .00031895  00000-0  21481-2 0  9995
2 44713  53.0546 125.3135 0001151  98.9698 261.1421 15.06441263205939

// Sample given by ChatGPT
1 25544U 98067A   21274.58668981  .00001303  00000-0  29669-4 0  9991
2 25544  51.6441 179.2338 0008176  49.9505 310.1752 15.48903444320729
     */


    /**
     * Public wrapper for loading TLE data - called from DragDropHandler and other places
     * Delegates to this.satellites
     */
    replaceTLE(tle) {
        this.satellites.replaceTLE(tle);
        // Add satellites to the scene
        this.satellites.addSatellites(this.satelliteGroup, 1);
        this.satellites.filterSatellites();
    }

    /**
     * Wrapper to get satellite EUS position - delegates to this.satellites
     */
    calcSatEUS(sat, date) {
        return this.satellites.calcSatEUS(sat, date);
    }

    /**
     * Getter for TLE data - delegates to this.satellites
     * Maintains backward compatibility with code that accesses nightSky.TLEData
     */
    get TLEData() {
        return this.satellites.TLEData;
    }

    /**
     * Getters and setters for satellite properties
     * These were moved to CSatellite but need to be accessible from nightSky for proper serialization
     */
    get showSatellites() {
        return this.satellites.showSatellites;
    }

    set showSatellites(value) {
        this.satellites.showSatellites = value;
    }

    get showStarlink() {
        return this.satellites.showStarlink;
    }

    set showStarlink(value) {
        this.satellites.showStarlink = value;
    }

    get showISS() {
        return this.satellites.showISS;
    }

    set showISS(value) {
        this.satellites.showISS = value;
    }

    get showBrightest() {
        return this.satellites.showBrightest;
    }

    set showBrightest(value) {
        this.satellites.showBrightest = value;
    }

    get showOtherSatellites() {
        return this.satellites.showOtherSatellites;
    }

    set showOtherSatellites(value) {
        this.satellites.showOtherSatellites = value;
    }

    get showSatelliteList() {
        return this.satellites.showSatelliteList;
    }

    set showSatelliteList(value) {
        this.satellites.showSatelliteList = value;
    }

    get showSatelliteTracks() {
        return this.satellites.showSatelliteTracks;
    }

    set showSatelliteTracks(value) {
        this.satellites.showSatelliteTracks = value;
    }

    get showFlareTracks() {
        return this.satellites.showFlareTracks;
    }

    set showFlareTracks(value) {
        this.satellites.showFlareTracks = value;
    }

    get showSatelliteGround() {
        return this.satellites.showSatelliteGround;
    }

    set showSatelliteGround(value) {
        this.satellites.showSatelliteGround = value;
    }

    get showSatelliteNames() {
        return this.satellites.showSatelliteNames;
    }

    set showSatelliteNames(value) {
        this.satellites.showSatelliteNames = value;
    }

    get showSatelliteNamesMain() {
        return this.satellites.showSatelliteNamesMain;
    }

    set showSatelliteNamesMain(value) {
        this.satellites.showSatelliteNamesMain = value;
    }

    get arrowRange() {
        return this.satellites.arrowRange;
    }

    set arrowRange(value) {
        this.satellites.arrowRange = value;
    }

    get flareAngle() {
        return this.satellites.flareAngle;
    }

    set flareAngle(value) {
        this.satellites.flareAngle = value;
    }

    get penumbraDepth() {
        return this.satellites.penumbraDepth;
    }

    set penumbraDepth(value) {
        this.satellites.penumbraDepth = value;
    }

    get labelFlares() {
        return this.satellites.labelFlares;
    }

    set labelFlares(value) {
        this.satellites.labelFlares = value;
    }

    get labelLit() {
        return this.satellites.labelLit;
    }

    set labelLit(value) {
        this.satellites.labelLit = value;
    }

    get labelLookVisible() {
        return this.satellites.labelLookVisible;
    }

    set labelLookVisible(value) {
        this.satellites.labelLookVisible = value;
    }


    // Note, here we are claculating the ECEF position of planets on the celestial sphere
    // these are NOT the actual positions in space


    updateArrow(planet, ra, dec, date, observer, sphereRadius) {

        // problem with initialization order, so we need to check if the planet sprite is defined
        if (this.planets.planetSprites[planet] === undefined) {
            return;
        }

        const name = planet;
        const flagName = "show" + name + "Arrow";
        const groupName = name + "ArrowGroup";
        const arrowName = name + "arrow";
        const obName = name + "ArrowOb";

        if (this[flagName] === undefined) {
            return;
        }

        if (this[flagName]) {
            const eusDir = getCelestialDirectionFromRaDec(ra, dec, date)
            this[obName].updateDirection(eusDir)
        }

        // Handle Sun-specific calculations for flare region
        if (planet === "Sun") {
            const sunPos = getGeocentricBodyPositionEUS(Astronomy.Body.Sun, date, true);
            const sunDir = sunPos.clone().normalize();

            // Store sun direction vectors for flare calculations
            this.satellites.toSun.copy(sunDir)
            this.satellites.fromSun.copy(this.satellites.toSun.clone().negate())
            Globals.fromSun = this.satellites.fromSun.clone()
            Globals.toSun = this.satellites.toSun.clone()
            Globals.sunPos = sunPos.clone()

            this.updateFlareRegion(ra, dec, date);
        }

        // Handle Moon-specific calculations for shadow
        if (planet === "Moon") {
            const moonPos = getGeocentricBodyPositionEUS(Astronomy.Body.Moon, date, true);

            Globals.toMoon = moonPos.clone().normalize()
            Globals.fromMoon = Globals.toMoon.clone().negate()

            Globals.moonPos = moonPos
        }
    }


    updateFlareRegion(ra, dec, date) {


        if (this.showFlareRegion) {

            const camera = NodeMan.get("lookCamera").camera;

            const cameraPos = camera.position;
            const cameraEcef = EUSToECEF(cameraPos)
            const LLA = ECEFToLLAVD_Sphere(cameraEcef)

            const {
                az: az1,
                el: el1
            } = raDecToAzElRADIANS(ra, dec, radians(LLA.x), radians(LLA.y), getLST(date, radians(LLA.y)))
            const {az, el} = raDecToAltAz(ra, dec, radians(LLA.x), radians(LLA.y), getJulianDate(date))
            //console.log(`RA version ${planet}, ${degrees(az1)}, ${degrees(el1)}`)
            //console.log(`raDecToAltAz  ${planet}, ${degrees(az)}, ${degrees(el)}`)

            ///////////////////////////////////////////////////////////////////////
            // attempt to find the glint position for radius r
            // i.e. the position on the earth centered sphere, of radius r where
            // a line from the camera to that point will reflect in the direction of
            // the sun
            // This is a non-trivial problem, related to Alhazen's problem, and does not
            // easily submit to analytical approaches
            // So here I use an iterative geometric approach
            // first we simplify the search to two dimensions, as we know the point must lay in
            // the plane specified by the origin O, the camera position P, and the sun vector v
            // we could do it all in 2D, or just rotate about the axis perpendicular to this.
            // 2D seems like it would be fastest, but just rotating maybe simpler
            // So first calculate the axis perpendicular to OP and v
            const P = this.camera.position;
            const O = this.globe.center;
            const OP = P.clone().sub(O)             // from origin to camera
            const OPn = OP.clone().normalize();       // normalized for cross product
            const v = Globals.toSun                    // toSun is already normalized
            const axis = V3().crossVectors(v, OPn).normalize()   // axis to rotate the point on
            const r = wgs84.RADIUS + 550000         // 550 km is approximate starlink altitude

            // We are looking for a point X, at radisu R. Let's just start directly above P
            // as that's nice and simple
            const X0 = OPn.clone().multiplyScalar(r).add(O)

            var bestX = X0
            var bestGlintAngle = 100000; // large value so the first one primes it
            var bestAngle = 0;

            var start = 0
            var end = 360
            var step = 1
            var attempts = 0
            const maxAttempts = 6

            do {
                //  console.log(`Trying Start = ${start}, end=${end}, step=${step},  bestAngle=${bestAngle}, bestGlintAngle=${bestGlintAngle}`)
                // try a simple iteration for now
                for (var angle = start; angle <= end; angle += step) {
                    // the point needs rotating about the globe origin
                    // (which is not 0,0,0, as we are in EUS)
                    // so sub O, rotate about the axis, then add O back
                    const X = X0.clone().sub(O).applyAxisAngle(axis, radians(angle)).add(O)

                    // we now have a potential new position, so calculate the glint angle

                    // only want to do vectors that point tawards the sun
                    const camToSat = X.clone().sub(P)

                    if (camToSat.dot(v) > 0) {

                        const globeToSat = X.clone().sub(O).normalize()
                        const reflected = camToSat.clone().reflect(globeToSat).normalize()
                        const dot = reflected.dot(v)
                        const glintAngle = (degrees(Math.acos(dot)))
                        if ((glintAngle >= 0) && (glintAngle < bestGlintAngle)) {
                            // check if it's obscured by the globe
                            // this check is more expensive, so only do it
                            // for potential "best" angles.
                            const ray = new Ray(X, Globals.toSun)
                            if (!intersectSphere2(ray, this.globe)) {
                                bestAngle = angle;
                                bestGlintAngle = glintAngle;
                                bestX = X.clone();
                            }
                        }
                    }
                }


                start = bestAngle - step;
                end = bestAngle + step;
                step /= 10
                attempts++;

            } while (bestGlintAngle > 0.0001 && attempts < maxAttempts)

            DebugArrowAB("ToGlint", this.camera.position, bestX, "#FF0000", true, this.flareRegionGroup, 20, LAYER.MASK_HELPERS)
            DebugArrow("ToSunFromGlint", Globals.toSun, bestX, 5000000, "#FF0000", true, this.flareRegionGroup, 20, LAYER.MASK_HELPERS)
            DebugWireframeSphere("ToGlint", bestX, 500000, "#FF0000", 4, this.flareRegionGroup)

        }

    }

    //////////////////////////////////////////////////////////////////////////////////////////
    //////////////////////////////////////////////////

    dispose() {
        // Clean up star field resources
        if (this.starField) {
            this.starField.dispose();
        }
        
        // Clean up celestial elements
        if (this.celestialElements) {
            this.celestialElements.dispose(this.celestialSphere);
        }
        
        // Clean up planets resources
        if (this.planets) {
            this.planets.dispose();
        }
        
        // Clean up Earth's Shadow resources
        if (this.earthShadow) {
            this.earthShadow.dispose();
        }
        
        super.dispose();
    }


}





export function addNightSky(def) {
//    console.log("Adding CNodeDisplayNightSky")
    var nightSky = new CNodeDisplayNightSky({id: "NightSkyNode", ...def});

    // iterate over any 3D views
    // and add an overlay to each for the star names (and any other night sky UI)

//    console.log("Adding night Sky Overlays")
    ViewMan.iterate((key, view) => {
        if (view.canDisplayNightSky) {
            new CNodeDisplaySkyOverlay({
                id: view.id+"_NightSkyOverlay",
                overlayView: view,
                camera: view.camera,
                nightSky: nightSky,
                gui: nightSky.celestialGUI,
            });
        }
    })

    return nightSky;
}
