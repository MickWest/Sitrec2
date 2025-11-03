import {CNode3DGroup} from "./CNode3DGroup";
import {GlobalNightSkyScene, GlobalScene, GlobalSunSkyScene, setupNightSkyScene, setupSunSkyScene} from "../LocalFrame";
import {Color, Group, Matrix4, Raycaster, Scene, Sphere, Vector3} from "three";
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

import SpriteText from '../js/three-spritetext';
import {CNodeDisplayGlobeCircle} from "./CNodeDisplayGlobeCircle";
import {CNodeDisplayEarthShadow} from "./CNodeDisplayEarthShadow";
import {assert} from "../assert.js";
import {intersectSphere2, V3} from "../threeUtils";
import {getCelestialDirectionFromRaDec, getJulianDate, getSiderealTime, raDecToAltAz} from "../CelestialMath";
import {ViewMan} from "../CViewManager";
import {CNodeLabeledArrow} from "./CNodeLabels3D";
import {CNodeDisplaySkyOverlay} from "./CNodeDisplaySkyOverlay";
import {CNodeViewUI} from "./CNodeViewUI";
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
import {Ray} from "three/src/math/Ray";


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
        this.globe = new Sphere(new Vector3(0, -wgs84.RADIUS, 0), wgs84.POLAR_RADIUS)

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

        // Initialize Earth's Shadow properties before GUI

        satGUI.add(this.satellites,"updateLEOSats").name("Load LEO Satellites For Date")
            .onChange(function (x) {this.parent.close()})
            .tooltip("Get the latest LEO Satellite TLE data for the set simulator date/time. This will download the data from the internet, so it may take a few seconds.\nWill also enable the satellites to be displayed in the night sky.")

        satGUI.add(this.satellites,"updateStarlink").name("Load CURRENT Starlink")
            .onChange(function (x) {this.parent.close()})
            .tooltip("Get the CURRENT (not historical, now, real time) Starlink satellite positions. This will download the data from the internet, so it may take a few seconds.\n")

        satGUI.add(this.satellites,"updateSLOWSats").name("(Experimental) Load SLOW Satellites")
            .onChange(function (x) {this.parent.close()})
            .tooltip("Get the latest SLOW Satellite TLE data for the set simulator date/time. This will download the data from the internet, so it may take a few seconds.\nWill also enable the satellites to be displayed in the night sky. Might time-out for recent dates")

        satGUI.add(this.satellites,"updateALLSats").name("(Experimental) Load ALL Satellites")
            .onChange(function (x) {this.parent.close()})
            .tooltip("Get the latest Satellite TLE data for ALL the satellites for the set simulator date/time. This will download the data from the internet, so it may take a few seconds.\nWill also enable the satellites to be displayed in the night sky. Might time-out for recent dates")


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


        //   why no work???
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

        this.showFlareRegion = Sit.showFlareRegion;
        this.showFlareBand = Sit.showFlareBand;

        this.showAllLabels = false;

        const satelliteOptions = [
            {
                key: "showSatellites", name: "Overall Satellites Flag", object: this.satellites, action: () => {
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
                name: "Satellite Names (Look View)",
                object: this.satellites,
                action: () => this.updateSatelliteNamesVisibility()
            },
            {
                key: "showSatelliteNamesMain",
                name: "Satellite Names (Main View)",
                object: this.satellites,
                action: () => this.updateSatelliteNamesVisibility()
            },
            {
                key: "showAllLabels",
                name: "Show all Labels",
                object: this,
                action: () => this.flareRegionGroup.visible = this.showFlareRegion
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

        satGUI.add(Sit, "satScale", 0, 6, 0.01).name("Sat Brightness").listen()
            .tooltip("Scale factor for the brightness of the satellites. 1 is normal, 0 is invisible, 2 is twice as bright, etc.")

        satGUI.add(Sit, "flareScale", 0, 1, 0.001).name("Flare Brightness").listen()
            .tooltip("Scale factor for the additional brightness of flaring satellites. 0 is nothing")


        satGUI.add(Sit, "satCutOff", 0, 0.5, 0.001).name("Sat Cut-Off").listen()
            .tooltip("Satellites dimmed to this level or less will not be displayed")


        satGUI.add(this.satellites, "arrowRange", 10, 10000, 1).name("Display Range (km)").listen()
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


        this.satelliteTextGroup = new Group();
        this.updateSatelliteNamesVisibility();

        GlobalScene.add(this.satelliteTextGroup)

        this.satelliteTextGroup.matrixWorldAutoUpdate = false


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

        });

//        console.log("Done with CNodeDisplayNightSky constructor")
    }

    updateSatelliteNamesVisibility() {
        this.satelliteTextGroup.visible = this.showSatelliteName || this.showSatelliteNameMain;
        this.satelliteTextGroup.layers.mask =
            (this.showSatelliteNames ? LAYER.MASK_LOOK : 0)
            | (this.showSatelliteNamesMain ? LAYER.MASK_MAIN : 0)
        propagateLayerMaskObject(this.satelliteTextGroup);
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
        this.satelliteTextGroup.visible = this.satellites.showSatelliteNames;

        propagateLayerMaskObject(this.equatorialSphereGroup)
    }

    modDeserialize(v) {
        super.modDeserialize(v);
        // a guid value's .listen() only updates the gui, so we need to do it manually
        // perhaps better to flag the gui system to update it?
        this.satellites.filterSatellites();
        this.updateVis();
        this.updateSatelliteNamesVisibility();


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

        // do adjustements for date/time, and maybe precession, here
        // .....

        // The ESU Coordinate system is right handed Y-Up
        // X = East
        // Y = Up
        // Z = South (-Z = North)

        // With the identity transform, the Celestial Sphere (CS) has:
        // RA of 0 along the X axis, i.e. EAST
        // Dec of 90 ia along the Y Axis, i.e. UP

        // The CS is in Standard ECEF, right handed, Z = up

        // a good test is where the north star ends up. No matter what date, etc,
        // Polaris has dec of about 89°, and should always be north, tilted down by the latitude


        var nowDate = this.in.startTime.dateNow;
        const fieldRotation = getSiderealTime(nowDate, 0) - 90

        // we just use the origin of the local ESU coordinate systems
        // to tilt the stars by latitude and rotate them by longitude
        const lat1 = radians(Sit.lat);
        const lon1 = radians(Sit.lon);

        // note, rotateOnAxis is in LOCAL space, so we can't just chain them here
        // we need to rotate around the WORLD Z then the WORLD X

//         // Create a matrix for rotation around Y-axis by 180° to get north in the right place
        const rotationMatrixY = new Matrix4();
        rotationMatrixY.makeRotationY(radians(180));
//
// // Create a matrix for rotation around Z-axis by the longitude (will alls include data/time here)
        const rotationMatrixZ = new Matrix4();
        rotationMatrixZ.makeRotationZ(radians(Sit.lon + fieldRotation));
//
// // Create a matrix for rotation around X-axis by the latitude (tilt)
        const rotationMatrixX = new Matrix4();
        rotationMatrixX.makeRotationX(radians(Sit.lat));
//
//         //Combine them, so they are applied in the order Y, Z, X
//         rotationMatrixX.multiply(rotationMatrixZ.multiply(rotationMatrixY))
//
//         // apply them
//         this.celestialSphere.applyMatrix4(rotationMatrixX)

        // Apply rotation matrices to the night sky celestial sphere
        this.celestialSphere.applyMatrix4(rotationMatrixY)
        this.celestialSphere.applyMatrix4(rotationMatrixZ)
        this.celestialSphere.applyMatrix4(rotationMatrixX)

        // The day sky sphere should use the same transformations as the night sky sphere
        // since both are rendered with camera at origin and should show celestial objects
        // in the same positions
        if (this.celestialDaySphere) {
            this.celestialDaySphere.applyMatrix4(rotationMatrixY)
            this.celestialDaySphere.applyMatrix4(rotationMatrixZ)
            this.celestialDaySphere.applyMatrix4(rotationMatrixX)
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
        }
//        console.log (`out of ${numSats}, ${valid} of them are valid`)


//        this.updateSatelliteScales(this.camera)

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

    updateSatelliteScales(view) {

        const camera = view.camera;
        const isLookView = (view.id === "lookView");

        // for optimization we are not updating every scale on every frame
        if (camera.satTimeStep === undefined) {
            camera.satTimeStep = 5; // was 5
            camera.satStartTime = 0;
        } else {
            camera.satStartTime++
            if (camera.satStartTime >= camera.satTimeStep)
                camera.satStartTime = 0;
        }

        const toSun = this.satellites.toSun;
        const fromSun = this.satellites.fromSun
        // For the globe, we position it at the center of a sphere or radius wgs84.RADIUS
        // but for the purposes of occlusion, we use the POLAR_RADIUS
        // erring on not missing things
        // this is a slight fudge, but most major starlink satellites sightings are over the poles
        // and atmospheric refraction also makes more visible.

        const raycaster = new Raycaster();
        raycaster.layers.mask |= LAYER.MASK_MAIN | LAYER.MASK_LOOK;

        var hitPoint = new Vector3();
        var hitPoint2 = new Vector3();
        // get the forward vector (-z) of the camera matrix, for perp distance
        const cameraForward = new Vector3(0, 0, -1).applyQuaternion(camera.quaternion);

        if (this.satellites.showSatellites && this.satellites.TLEData) {


            // // we scale ALL the text sprites, as it's per camera
            // for (let i = 0; i < this.satellites.TLEData.satData.length; i++) {
            //     const satData = this.satellites.TLEData.satData[i];
            //     if (satData.visible) {
            //         const satPosition = satData.eus;
            //         // scaling based on the view camera
            //         // whereas later scaling is done with the look Camera?????
            //         const camToSat = satPosition.clone().sub(camera.position)
            //         // get the perpendicular distance to the satellite, and use that to scale the name
            //         const distToSat = camToSat.dot(cameraForward);
            //         const nameScale = 0.025 * distToSat * tanHalfFOV;
            //         satData.spriteText.scale.set(nameScale * satData.spriteText.aspect, nameScale, 1);
            //     } else {
            //         satData.spriteText.scale.set(0,0,0);
            //     }
            // }


            // sprites are scaled in pixels, so we need to scale them based on the view height

            let scale = Sit.satScale;
            scale = view.adjustPointScale(scale * 2);
            this.satellites.satelliteMaterial.uniforms.satScale.value = scale;

            const positions = this.satellites.satelliteGeometry.attributes.position.array;
            const magnitudes = this.satellites.satelliteGeometry.attributes.magnitude.array;

            for (let i = camera.satStartTime; i < this.satellites.TLEData.satData.length; i++) {
                const satData = this.satellites.TLEData.satData[i];

                // bit of a hack for visiblity, just set the scale to 0
                // and skip the update
                // TODO: the first few
                if (!satData.visible) {
                    magnitudes[i] = 0
                    continue;
                }

                // satellites might have invalid positions if we load a TLE that's not close to the time we are calculating for
                // this would be updated when updating the satellites position
                if (satData.invalidPosition) {
                    continue;
                }

                // stagger updates unless it has an arrow.
                if ((i - camera.satStartTime) % camera.satTimeStep !== 0 && !satData.hasSunArrow) {
                    //             continue;
                }

                assert(satData.eus !== undefined, `satData.eus is undefined, i= ${i}, this.satellites.TLEData.satData.length = ${this.satellites.TLEData.satData.length} `)

                const satPosition = satData.eus;

//                let scale = 0.1;                // base value for scale
                let scale = 0.04;                // base value for scale
                let darknessMultiplier = 0.3    // if in dark, multiply by this
                var fade = 1

                raycaster.set(satPosition, toSun)
                if (intersectSphere2(raycaster.ray, this.globe, hitPoint, hitPoint2)) {

                    const midPoint = hitPoint.clone().add(hitPoint2).multiplyScalar(0.5)
                    const originToMid = midPoint.clone().sub(this.globe.center)
                    const occludedMeters = this.globe.radius - originToMid.length()
                    if (occludedMeters < this.satellites.penumbraDepth) {

                        // fade will give us a value from 1 (no fade) to 0 (occluded)
                        fade = 1 - occludedMeters / this.satellites.penumbraDepth

                        scale *= darknessMultiplier + (1 - darknessMultiplier) * fade
                    } else {
                        fade = 0;
                        scale *= darknessMultiplier;
                        this.satellites.removeSatSunArrows(satData);
                    }
                }

                if (!isLookView) {
                    scale *= 2;
                }

                // fade will be 1 for full visible sats, < 1 as they get hidden
                if (fade > 0) {

                    // checking for flares
                    // we take the vector from the camera to the sat
                    // then reflect that about the vecotr from the globe center to the sat
                    // then measure the angle between that and the toSun vector
                    // if it's samall (<5°?) them glint

                    const camToSat = satPosition.clone().sub(this.camera.position)

                    // check if it's visible
                    raycaster.set(this.camera.position, camToSat)
                    var belowHorizon = intersectSphere2(raycaster.ray, this.globe, hitPoint, hitPoint2)
                    if (!belowHorizon) {


                        const globeToSat = satPosition.clone().sub(this.globe.center).normalize()
                        const reflected = camToSat.clone().reflect(globeToSat).normalize()
                        const dot = reflected.dot(toSun)
                        const glintAngle = Math.abs(degrees(Math.acos(dot)))

                        const altitudeKM = (satPosition.clone().sub(this.globe.center).length() - wgs84.RADIUS) / 1000

                        // if (altitudeKM < 450) {
                        //     scale *= 3 // a bit of a dodgy patch to make low atltitde trains stand out.
                        // }


                        // attenuate by distance if in look view
                        // use
                        if (isLookView) {
                            const distToSat = camToSat.length();
                            scale *= 3000000 / distToSat;

                            // if it's the ISS, scale it up a bit
                            if (satData.number === 25544) {
                                scale *= 3; // ISS is quite a bit bigger
                            }
                        }

                        const spread = this.satellites.flareAngle
                        const ramp = spread * 0.25; //
                        const middle = spread - ramp;  // angle at which the flare is brightest, constant
                        const glintSize = Sit.flareScale; //
                        if (glintAngle < spread) {
                            // we use the square of the angle (measured from the start of the spread)
                            // as the extra flare, to concentrate it in the middle
                            //const glintScale = 1 + fade * glintSize * (spread - glintAngle) * (spread - glintAngle) / (spread * spread)

                            //const glintScale = 1 + 4 * fade * glintSize * Math.abs(spread - glintAngle)  / (spread)

                            let glintScale;
                            let d = Math.abs(glintAngle);
                            if (d < middle) {
                                // if the angle is less than the middle, use set to the maximum (glintSize)
                                glintScale = fade * glintSize;
                            } else {
                                d = d - middle; // shift the angle to over the ramp region
                                glintScale = fade * glintSize * (ramp - d) * (ramp - d) / (ramp * ramp);
                            }

                            scale += glintScale

                            // arrows from camera to sat, and from sat to sun
                            var arrowHelper = DebugArrowAB(satData.name, this.camera.position, satPosition, (belowHorizon ? "#303030" : "#FF0000"), true, this.sunArrowGroup, 10, LAYER.MASK_HELPERS)
                            var arrowHelper2 = DebugArrowAB(satData.name + "sun", satPosition,
                                satPosition.clone().add(toSun.clone().multiplyScalar(10000000)), "#c08000", true, this.sunArrowGroup, 10, LAYER.MASK_HELPERS)
                            // var arrowHelper3 = DebugArrowAB(satData.name + "reflected", satPosition,
                            //     satPosition.clone().add(reflected.clone().multiplyScalar(10000000)), "#00ff00", true, this.sunArrowGroup, 0.025, LAYER.MASK_HELPERS)

                            // and maybe one for flare tracks
                            if (this.satellites.showFlareTracks) {
                                // we use the reflected vector, as that's the one that will be seen by the observer
                                // so we can see the flare track
                                let A = satData.eusA.clone()
                                let dir = satData.eusB.clone().sub(satData.eusA).normalize()
                                DebugArrow(satData.name + "flare", dir, satData.eus, 100000, "#FFFF00", true, this.satelliteFlareTracksGroup, 20, LAYER.MASK_LOOKRENDER)
                            }

                            satData.hasSunArrow = true;
                        } else {
                            this.satellites.removeSatSunArrows(satData);

                            // do the scale again to incorporate al
                            // satData.sprite.scale.set(scale, scale, 1);

                        }
                    } else {


                        this.satellites.removeSatSunArrows(satData);
                    }
                }


                if (isLookView && scale < Sit.satCutOff) {
                    scale = 0;
                }

                // we store to look view scale, so we can filter out those names
                if (isLookView) {
                    satData.lastScale = scale;
                }

                magnitudes[i] = scale
            }
            this.satellites.satelliteGeometry.attributes.magnitude.needsUpdate = true;
        }
    }

    // per-viewport satellite sprite text update for scale and screen offset
    updateSatelliteText(view) {
        const layerMask = this.satelliteTextGroup.layers.mask;
        if (!layerMask) {
            // if not visible in either the main or helpers layer, skip the update
            return;
        }


        const camera = view.camera;
        const cameraForward = new Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
        const cameraPos = camera.position;
        const tanHalfFOV = Math.tan(radians(camera.fov / 2))

        const viewScale = 0.025 * view.divParent.clientHeight / view.heightPx;

        if (this.satellites.TLEData === undefined) {
            console.warn("TLEData is undefined in updateSatelliteText (Not loaded yet?)")
            return;
        }

        assert(this.satellites.TLEData !== undefined, "TLEData is undefined in updateSatelliteText")

        const lookPos = NodeMan.get("lookCamera").camera.position;
        const numSats = this.satellites.TLEData.satData.length;
        for (let i = 0; i < numSats; i++) {
            const satData = this.satellites.TLEData.satData[i];

            // if the satellite is not visible, skip it
            // user filtered sats are either in the list, or ar e the brightest or the ISS (if those are enabled)
            // if the satellite is not user filtered, skip it
            if (satData.visible
                && (satData.userFiltered || satData.eus.distanceTo(lookPos) < this.satellites.arrowRange * 1000)
                && (satData.lastScale > 0 || this.showAllLabels) // if the scale is 0, we don't show the label, unless showAllLabels is true
            ) {
                //if (satData.visible) {
                if (!satData.spriteText) {
                    // if the sprite is not created, create it
                    // this is done in the TLEData constructor, but might not be called
                    // if the TLEData is loaded after the CNodeDisplayNightSky is created
                    var name = satData.name.replace("0 STARLINK", "SL").replace("STARLINK", "SL");
                    // strip whitespae off the end
                    name = name.replace(/\s+$/, '');
                    satData.spriteText = new SpriteText(name, 0.01, "white", {depthTest: true});

                    // propagate the layer mask
                    satData.spriteText.layers.mask = layerMask;

                    this.satelliteTextGroup.add(satData.spriteText);
                }
                const sprite = satData.spriteText;

                const satPosition = satData.eus;
                // scaling based on the view camera
                // whereas satellite dot scaling is done with the look Camera?????
                const camToSat = satPosition.clone().sub(cameraPos)
                // get the perpendicular distance to the satellite, and use that to scale the name
                const distToSat = camToSat.dot(cameraForward);
                const nameScale = viewScale * distToSat * tanHalfFOV;
                sprite.scale.set(nameScale * sprite.aspect, nameScale, 1);

                const pos = satData.eus;
                const offsetPost = view.offsetScreenPixels(pos, 0, 30);
                sprite.position.copy(offsetPost);
            } else {
                // if not visible dispose it
                if (satData.spriteText) {
                    // remove the sprite from the group
                    this.satelliteTextGroup.remove(satData.spriteText);
                    satData.spriteText.dispose();
                    satData.spriteText = null;
                }


                //satData.spriteText.scale.set(0,0,0);
            }
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
        this.satellites.addSatellites(this.satelliteGroup, this.satelliteTextGroup, 1);
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
            const eusDir = getCelestialDirectionFromRaDec(ra, dec, date)

            // Store sun direction vectors for flare calculations
            this.satellites.toSun.copy(eusDir.clone().normalize())
            this.satellites.fromSun.copy(this.satellites.toSun.clone().negate())
            Globals.fromSun = this.satellites.fromSun.clone()
            Globals.toSun = this.satellites.toSun.clone()

            this.updateFlareRegion(ra, dec, date);


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



