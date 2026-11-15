import {Matrix4, Quaternion} from "three";
import {GlobalDateTimeNode, guiMenus, NodeMan, setRenderOne, Sit} from "../Globals";
import {par} from "../par";
import {CNodeViewUI} from "../nodes/CNodeViewUI";
import {AddTimeDisplayToUI} from "../UIHelpers";
import {DragDropHandler} from "../DragDropHandler";
import JSURL from "jsurl"
import {SITREC_SERVER} from "../configUtils";
import {CNodeSwitch} from "../nodes/CNodeSwitch";
import {CNodeControllerManualPosition} from "../nodes/CNodeControllerVarious";
import {assert} from "../assert";
import {MV3} from "../threeUtils";
import {getPTZController} from "../js/CameraControls";
import {radians} from "../utils";
import {legacyEUSToECEF} from "../LLA-ECEF-ENU";

import {waitForParsingToComplete} from "../CFileManager";


export const SitNightSky = {
    name: "nightsky",
    menuName: "(OLD) Night Sky / Starlink",

    // DEPRECATED. The Starlink sitch (data/starlink/SitStarlink.js) replaces it. "hidden" takes it
    // out of the sitch menu, Test All and the sitch lists, so a new sitch cannot start from it.
    // Old links (?sitch=nightsky&data=...) still load it: index.js finds the sitch by its name and
    // does not read "hidden".
    hidden: true,

    isTextable: false,
    isTool: true,

    canMod: false, // night sky is not modifiable, and (deprecated) it saves no new permalinks

    showDateTime: false, // opens the DateTime folder in the UI - not needed any more with new menu system

    showFlareBand: true,
    showSunArrows: true,

    farClipLook: 80000000,



    files: {

        // This is a DYNAMIC link, i.e. it will change
        // so if we make a permalink, we need to rehost this
        // So in the file manager we'll need to store the raw file
        // not just the parsed file.
        // we flag it as dynamic by prepending a !
//        starLink: "!"+SITREC_SERVER+"proxy.php?url=https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?FILE=starlink&FORMAT=tle",
        starLink: "!"+SITREC_SERVER+"proxy.php?request=CURRENT_STARLINK",


       // sun: 'images/nightsky/MickSun.png',
       // moon: "images/nightsky/MickMoon.png",


    },

    units: "Imperial",

    fps: 30,
    frames: (10*60+50)*30,
    startTime: new Date().toISOString(),  // "2023-10-13T07:39:13.000Z",
    lookCamera: {
        fov: 10,
    },

    lat: 51.48,
    lon: -3.16,

    // with a ptz setup, add showGUI:true to allow changing it
    // then can set it to false once the settings are locked in
    ptz: {az: 6.2, el: 9.8, fov: 32, roll:0, showGUI: true},

    lookPosition: { fromLat: 51.48, fromLon: -3.16, fromAltFeet: 822, fromAltFeetMin: 0, fromAltFeetMax: 55000,},

    targetSpeedMax: 100,

    marks: [
        //       {LL: {lat:50.197944,lon:-5.428180}, width: 1, color:0xffff00},
    ],


    mainCamera: {
        far: 80000000,
        startCameraPositionLLA: [9.423020, 0.232847, 28439497.682404],
        startCameraTargetLLA: [9.423053, 0.232852, 28438497.891991],
    },

    targetSize: 500,

    videoFile: "../sitrec-videos/private/Area6-1x-speed-08-05-2023 0644UTC.mp4",

    mainView: {left: 0.0, top: 0, width: 0.5, height: 1, background: '#132d44'},
    lookView: {left: 0.5, top: 0, width: 0.5, height: 1,
        ptzControls:true, // flag so dragging the view around will alter the ptz controls
    },

    DisplayCameraFrustum: {radius: 500000, lineWeight: 1.0, color: "white"},


    nightSky: true,
    useGlobe: true,
    useDayNightGlobe: true,
    globeScale: 1,  // was defaulting to 0.99
    localLatLon: true,
    useEllipsoid: true,

    dropTargets: {
        "track": ["cameraSwitch"],
    },

    dropAsController: true,

    include_Compasses: true,


    // so this is the night sky, and there's a Sync Start Time to Track button
    // we want to make that a switch.

    setup2: function () {

        const cameraSwitch = new CNodeSwitch({
            id: "cameraSwitch",
            desc: "Camera Motion",
            inputs: {
                "Manual Position": new CNodeControllerManualPosition ({
                    id: "manualController",
                    // C, Q and E have other uses in Sitrec (see CNodeControllerManualPosition).
                    disableConflictingKeys: true,
                }),

                // "XXX Position": new CNodeControllerManualPosition ({
                //     id: "manual2Controller"
                // }),

            }
        }, guiMenus.view)

        // cameraSwitch.addOptionToGUIMenu("YYY Position", new CNodeControllerManualPosition ({
        //     id: "manual3Controller"
        // }))

        //cameraSwitch.removeOption("XXX Position")

        NodeMan.get("lookCamera").addControllerNode(cameraSwitch)

        const view = NodeMan.get("mainView");
        const viewLook = NodeMan.get("lookView");

        DragDropHandler.addDropArea(view.div);
        DragDropHandler.addDropArea(viewLook.div);

        var labelVideo = new CNodeViewUI({id: "labelVideo", overlayView: viewLook});
        AddTimeDisplayToUI(labelVideo, 99.5, 3, -16, "#f0f000", "right")

        // No "SAVE Night Sky Permalink" button: the sitch is deprecated and makes no new links.
        // Old links still load (parseURLDataBeforeSetup and parseURLDataAfterSetup).
    },

    parseURLDataBeforeSetup(data) {
        console.log("PARSING (BEFORE): "+data)
        const p = JSURL.parse(data)

        if (p.olat !== undefined) {
            Sit.lat = p.olat;
            Sit.lon = p.olon;
        } else {
            // for backwards compatibility, we just use the default lat/lon
            // somewhere in Wales
        }

    },

    parseURLDataAfterSetup(data) {
        console.log("PARSING (AFTER): "+data)
        const p = JSURL.parse(data)

        const lookPTZ = getPTZController("lookCamera");
        assert(lookPTZ !== undefined, "lookCamera's PTZ controller not found");

        lookPTZ.az = p.az;
        lookPTZ.el = p.el;
        lookPTZ.fov = p.fov;
        lookPTZ.roll = p.roll ?? 0;
        lookPTZ.refresh();
        NodeMan.get("cameraLat").value = p.lat;
        NodeMan.get("cameraLon").value = p.lon;
        NodeMan.get("cameraAlt").value = p.alt;
        NodeMan.get("cameraLat").recalculateCascade() // manual update

        const mainCam = NodeMan.get("mainCamera").camera;

        if (p.v === undefined || p.v < 2) {
            // Legacy EUS (East-Up-South) camera coordinates — convert to ECEF
            const latRad = radians(Sit.lat);
            const lonRad = radians(Sit.lon);

            // Convert position from EUS to ECEF
            mainCam.position.copy(legacyEUSToECEF(MV3(p.p), latRad, lonRad));

            // Build EUS→ECEF rotation matrix
            // EUS axes: X=East, Y=Up, Z=South
            // Combined: EUS→ENU swap then ENU→ECEF rotation
            const sLat = Math.sin(latRad), cLat = Math.cos(latRad);
            const sLon = Math.sin(lonRad), cLon = Math.cos(lonRad);
            const eusToEcef = new Matrix4().set(
                -sLon,  cLat*cLon,  sLat*cLon,  0,
                 cLon,  cLat*sLon,  sLat*sLon,  0,
                 0,     sLat,      -cLat,        0,
                 0,     0,          0,           1
            );

            // Convert up vector (direction only — transformDirection ignores translation)
            mainCam.up.copy(MV3(p.u).transformDirection(eusToEcef));

            // Convert quaternion: q_ecef = q_eusToEcef * q_old
            const eusToEcefQuat = new Quaternion().setFromRotationMatrix(eusToEcef);
            const oldQuat = new Quaternion(p.q.x, p.q.y, p.q.z, p.q.w);
            mainCam.quaternion.copy(eusToEcefQuat.multiply(oldQuat));
        } else {
            // v2+: camera data is already in ECEF
            mainCam.up.copy(MV3(p.u));
            mainCam.position.copy(MV3(p.p));
            mainCam.quaternion.set(p.q.x, p.q.y, p.q.z, p.q.w);
        }
        mainCam.updateMatrixWorld();

        par.frame = p.f;
        par.paused = p.pd;

        Sit.startTime = p.startTime;
        GlobalDateTimeNode.populateStartTimeFromUTCString(Sit.startTime)

        const nightSkyNode = NodeMan.get("NightSkyNode");
        if (p.ssa !== undefined) {
            nightSkyNode.showSunArrows = p.ssa;
            nightSkyNode.showFlareRegion = p.sfr;
            nightSkyNode.showFlareBand = p.sfb ?? true;
            nightSkyNode.showSatelliteNames = p.ssn
            nightSkyNode.sunArrowGroup.visible = nightSkyNode.showSunArrows;
            nightSkyNode.flareRegionGroup.visible = nightSkyNode.showFlareRegion;
            nightSkyNode.flareBandGroup.visible = nightSkyNode.showFlareBand;
            // satelliteTextGroup was removed; names now render via CNodeDisplaySkyOverlay
            setRenderOne(true);
        }

        // Sim Speed
        if (p.spd !== undefined) {
            Sit.simSpeed = p.spd;
        }

        if (p.rehostedFiles !== undefined) {
           // FileManger.rehoster.rehostedFiles = p.rehostedFiles;
            /// we need a list of used URLs that are not in the sitch
            for (const url of p.rehostedFiles) {
                console.log(`Calling DragDropHandler.uploadURL(url) for ${url}`)
                DragDropHandler.uploadURL(url).then(() => {
                    console.log(`uploaded ${url} from rehostedFiles, checking drop queue`)
                    // uploadURL will add to the drop queue, so we need to check it now
                    // so we can wait for parsing to complete
                    // otherwise it would be added to the queue, but not processed until the next frame
                    // this is a backwards compatibility thing
                    DragDropHandler.checkDropQueue();
                    waitForParsingToComplete().then(() => {

                        console.log(`done with simulating dropped files, resetting time`)
                        // as adding tracks can change start time, restore it here
                        Sit.startTime = p.startTime;
                        GlobalDateTimeNode.populateStartTimeFromUTCString(Sit.startTime)

                        // a bit brutal
                        NodeMan.recalculateAllRootFirst();
                    })

                });
            }




        }





        // ANY NEW  should be checked to see if they exist, for backwards compatibility.



        // we do a par.renderOne to ensure the initial display looks good if we are paused.
        setRenderOne(true);
    },

    update: function(frame) {

    },
}
