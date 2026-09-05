import {gestureHelp, GESTURE_PROFILES} from "./GestureActions";
import {getInteractionRouter} from "./InteractionRouter";
// A variety of functions related to the jet and the atflir pod orientation, and glare
// so mostly related to Gimbal, GoFast, FLIR1 and Aguadilla

import {
    EarthRadiusMiles,
    getEffectiveRenderScale,
    Globals,
    gui,
    guiMenus,
    guiPhysics,
    guiTweaks,
    infoDiv,
    NodeMan,
    setRenderOne,
    Sit
} from "./Globals";
import {par} from "./par";
import {metersFromMiles, metersFromNM, radians} from "./utils";
import {EA2XYZ, EAJP2PR, getLocalNorthVector, getLocalUpVector, PRJ2XYZ} from "./SphericalMath";
import {DebugArrowAB, dispose, GridHelperWorld, propagateLayerMaskObject, sphereMark} from "./threeExt";
import * as LAYER from "./LayerMasks";
import {LLAToECEF} from "./LLA-ECEF-ENU";
import {Line2} from "three/addons/lines/Line2.js";
import {LineGeometry} from "three/addons/lines/LineGeometry.js";
import {showHider} from "./KeyBoardHandler";
import {t} from "./i18n";
import {VG} from "./nodes/CNodeView";
import {chartDiv, setupGimbalChart, theChart, UpdateChart, UpdateChartLine, updateChartSize} from "./JetChart";
import {CNodeDisplayATFLIR} from "./nodes/CNodeDisplayATFLIR";
import {calculateGlareStartAngle, getDeroFromFrame, getPodRollFromGlareAngleFrame} from "./JetHorizon";
import {GlobalScene, LocalFrame} from "./LocalFrame";
import {CNodeDisplayTrack} from "./nodes/CNodeDisplayTrack";
import {CNodeConstant} from "./nodes/CNode";
import {scaleNodeF2M} from "./nodes/CNodeScale";
import {CNodeGUIValue, CNodeGUIFlag} from "./nodes/CNodeGUIValue";
import {CNodeLOSTraverse} from "./nodes/CNodeLOSTraverse";
import {CNodeLOSTraverseConstantSpeed} from "./nodes/CNodeLOSTraverseConstantSpeed";
import {CNodeMunge} from "./nodes/CNodeMunge";
import {
    CNodeLOSTraverseStraightLine,
    CNodeLOSTraverseStraightLineFixed,
    CNodeLOSTraverseWind
} from "./nodes/CNodeLOSTraverseStraightLine";
import {CNodeLOSTraverseConstantAltitude} from "./nodes/CNodeLOSTraverseConstantAltitude";
import {CNodeLOSTraversePerspective} from "./nodes/CNodeLOSTraversePerspective";
import {CNodeLOSFitCV} from "./nodes/CNodeLOSFitCV";
import {CNodeLOSFitCA} from "./nodes/CNodeLOSFitCA";
import {CNodeLOSFitKalman} from "./nodes/CNodeLOSFitKalman";
import {CNodeLOSFitMonteCarlo} from "./nodes/CNodeLOSFitMonteCarlo";
import {CNodeLOSFitMonteCarlo2} from "./nodes/CNodeLOSFitMonteCarlo2";
import {CNodeLOSFitPhysics} from "./nodes/CNodeLOSFitPhysics";
import {CNodeLOSFitPlausible} from "./nodes/CNodeLOSFitPlausible";
import {CNodeLOSFitMinSpeed} from "./nodes/CNodeLOSFitMinSpeed";
import {CNodeLOSFitWindTracer} from "./nodes/CNodeLOSFitWindTracer";
import {CNodeLOSFitStationaryPoint} from "./nodes/CNodeLOSFitStationaryPoint";
import {CNodeLOSFitGroundVehicle} from "./nodes/CNodeLOSFitGroundVehicle";
import {CNodeLOSFitAnalysisResult} from "./nodes/CNodeLOSFitAnalysisResult";
import {CNodeSwitch} from "./nodes/CNodeSwitch";
import {QUADCOPTER_MODELS, FIXED_WING_MODELS} from "./VehicleModels";
import {EventManager} from "./CEventManager";
import {makeMatLine, updateMatLineResolution} from "./MatLines";
import {CNodeViewUI} from "./nodes/CNodeViewUI";
import {
    AddAltitudeGraph,
    AddSizePercentageGraph,
    AddSpeedGraph,
    AddTailAngleGraph,
    AddTargetDistanceGraph
} from "./JetGraphs";
import {
    AlwaysDepth,
    BufferGeometry,
    Color,
    DoubleSide,
    Float32BufferAttribute,
    Group,
    LineBasicMaterial,
    Matrix4,
    Mesh,
    MeshBasicMaterial,
    PerspectiveCamera,
    Plane,
    Sprite,
    SpriteMaterial,
    SRGBColorSpace,
    TextureLoader,
    Vector3
} from "three";
import {CNodeDisplayLOS} from "./nodes/CNodeDisplayLOS";
import {isLocal, SITREC_APP} from "./configUtils";
import {CNodeATFLIRUI} from "./nodes/CNodeATFLIRUI";
import {CNodeView3D} from "./nodes/CNodeView3D";
import {CNodeChartView} from "./nodes/CNodeChartView";
import {CNodeHeading} from "./nodes/CNodeHeading";
import {CNodeInterpolateTwoFramesTrack} from "./nodes/CNodeInterpolateTwoFramesTrack";
import {CNodeCamera} from "./nodes/CNodeCamera";
import {trackVelocity} from "./trackUtils";
import {V3} from "./threeUtils";
import {ViewMan} from "./CViewManager";
import {Frame2Az, Frame2El, jetPitchFromFrame} from "./JetUtils";
import {MakeTraverseNodesMenu} from "./MakeTraverseNodesMenu";
import {Ball, EOSU, PODBack, PodFrame} from "./nodes/ATFLIRVars";
import {
    aSphere,
    ATFLIR,
    bSphere,
    glareSphere,
    glareSprite,
    setASphere,
    setATFLIR,
    setBSphere,
    setGlareSphere,
    setGlareSprite,
    setTargetSphere,
    targetSphere,
    vizRadius
} from "./JetStuffVars";


const matLineWhite = makeMatLine(0xffffff);
const matLineCyan = makeMatLine(0x00ffff,1.5);
const matLineGreen = makeMatLine(0x00ff00);
const matLineGreenThin = makeMatLine(0x00c000,1.0);



// marker spheres and maybe a sprite for the glare
// these are all in the LocalFrame
// setup by Gimbal, GoFast, FLIR1 and Aguadilla
export function initJetVariables() {
    setTargetSphere(sphereMark(V3(0,0,0),2,0xffffff, LocalFrame))

    setASphere(sphereMark(V3(0,0,0),1.5,0xc08080,LocalFrame))
    setBSphere(sphereMark(V3(0,0,0),1.5,0x80c080,LocalFrame))
    setGlareSphere (sphereMark(V3(0,0,0),1.8,0x00ff00,LocalFrame))

    glareSphere.name = "glareSphere"

    if (Sit.showGlare) {
        const mapt = new TextureLoader().load(SITREC_APP+'data/images/GlareSprite.png?v=1');
        mapt.colorSpace = SRGBColorSpace;
        const spriteMaterial = new SpriteMaterial({map: mapt, color: 0xffffff, sizeAttenuation: false});

        setGlareSprite(new Sprite(spriteMaterial));
        glareSprite.position.set(0, 0, -50)
        glareSprite.scale.setScalar(0.04)
        glareSprite.layers.disable(LAYER.MAIN)
        glareSprite.layers.enable(LAYER.podsEye)
        glareSprite.layers.enable(LAYER.LOOK)
    }
}


let LOS_line;
let LOS_points;
let LOS_geometry;
let LOSX_line;
let LOSX_points;
let LOSX_geometry;

export function updateLOS(scene, targetPos) {


    LOS_points = [0, 0, 0, 0, 0, 0]
    if (par.deroFromGlare) {
        LOS_points[3] = glareSphere.position.x;
        LOS_points[4] = glareSphere.position.y;
        LOS_points[5] = glareSphere.position.z;
    } else {
        LOS_points[3] = targetPos.x;
        LOS_points[4] = targetPos.y;
        LOS_points[5] = targetPos.z;
    }
    LocalFrame.remove(LOS_line)
    dispose(LOS_geometry)
    LOS_geometry = new LineGeometry();
    LOS_geometry.setPositions(LOS_points);
    LOS_line = new Line2(LOS_geometry, matLineGreen);
    LOS_line.layers.mask = LAYER.MASK_HELPERS;
    LocalFrame.add(LOS_line)

    const LOSXlen = 10000
    LOSX_points = [0, 0, 0, 0, 0, 0]

    const localOrigin = V3(0, 0, 0)
    const worldLos = targetPos.clone().multiplyScalar(LOSXlen)

    LocalFrame.localToWorld(localOrigin)
    LocalFrame.localToWorld(worldLos)

    LOSX_points[0] = localOrigin.x;
    LOSX_points[1] = localOrigin.y;
    LOSX_points[2] = localOrigin.z;

    LOSX_points[3] = worldLos.x;
    LOSX_points[4] = worldLos.y;
    LOSX_points[5] = worldLos.z;

    scene.remove(LOSX_line)
    dispose(LOSX_geometry)

    LOSX_geometry = new LineGeometry();
    LOSX_geometry.setPositions(LOSX_points);
    LOSX_line = new Line2(LOSX_geometry, matLineWhite);
    LOSX_line.layers.mask = LAYER.MASK_HELPERS;
    scene.add(LOSX_line)
}

let ERROR_circle;
let ERROR_points;
let ERROR_geometry;

export function update_ERROR_circle(scence, circleCenter) {
    // to make the circle, we have a vector v, and we want to first rotate it
    // by 5° away from itself.
    // to do this we get a rotation vector p that's perpendicular to v and rotate around that

    LocalFrame.remove(ERROR_circle)
    const p = V3(-circleCenter.z, circleCenter.y, circleCenter.x)
    p.cross(circleCenter)

    p.normalize()  // to use a vector as an axis it needs to be normalized

    const circlePoint = V3(circleCenter.x, circleCenter.y, circleCenter.z)
    circlePoint.applyAxisAngle(p, radians(5))
    ERROR_points = []

    const circleDirection = circleCenter.clone().normalize()

    ERROR_points.push(circlePoint.x, circlePoint.y, circlePoint.z)
    const circleTurn = 5;
    for (let i = 0; i <= 360; i += circleTurn) {
        circlePoint.applyAxisAngle(circleDirection, radians(circleTurn))
        ERROR_points.push(circlePoint.x, circlePoint.y, circlePoint.z)
    }

    dispose(ERROR_geometry)
    ERROR_geometry = new LineGeometry();
    ERROR_geometry.setPositions(ERROR_points);
    let oldErrorCircleVisible = true;
    if (ERROR_circle !== undefined)
        oldErrorCircleVisible = ERROR_circle.visible
    ERROR_circle = new Line2(ERROR_geometry, matLineGreenThin);
    ERROR_circle.layers.enable(LAYER.podsEye)
    ERROR_circle.visible = oldErrorCircleVisible
    LocalFrame.add(ERROR_circle)
    showHider(ERROR_circle, 'showErrorCircle', oldErrorCircleVisible, 'o').name(t("showHiders.showErrorCircle.label"))
}

let debugText = ""; // stick text in here, and it's show instead of keyboard shortcuts
export function UpdateHUD(text="") {
    /*
     var pitch1, pitch2, startRoll, endRoll;


     [pitch1, startRoll] = EAJP2PR(par.el, -54, jetPitchFromFrame());
     startRoll -= jetRollFromFrame(0);
     [pitch2, endRoll] = EAJP2PR(par.el, 8, jetPitchFromFrame());
     endRoll -= jetRollFromFrame(Sit.frames-1);
     var rollRange = Math.abs(endRoll-startRoll)

     infoDiv.innerHTML =
         "El           " + par.el.toFixed(1) + "°<br>" +
         "Az           " + par.az.toFixed(1) + "°<br>" +
         "Global Roll  " + par.globalRoll.toFixed(1) + "°<br>" +
         "Jet Roll     " + NodeMan.get("bank").v(par.frame).toFixed(1) + "°<br>" +
         "Pod Roll     " + par.podRollIdeal.toFixed(1) + "°<br>" +
         "Roll Range   " + rollRange.toFixed(1) + "°<br>" +
         "Pod Pitch    "    + par.podPitchPhysical.toFixed(1) + "°<br>"
 */
    let keyInfo = "";

    // keyInfo += navigator.userAgent+"<br>"
    // keyInfo += navigator.platform+"<br>"

    if (par.showKeyboardShortcuts) {
        keyInfo = text +
            "Q - Move/Edit Views<br>" +
            "F - Full Screen<br>" +
            "U - Toggle UI (menus)<br>" +
            "Num-1 - Z Axis Snap<br>" +
            "Num-7 - Y Axis Snap<br>" +
            "Num-3 - X Axis Snap<br>" +
            "Num-9 - 180° view toggle<br>" +
            "Num-. - Reset Camera<br>" +
            "< - Frame Back<br>" +
            "> - Frame Forward<br>" +
            "G - Go To frame/time/coords/place<br>" +
            "I - Set In Frame<br>" +
            "O - Set Out Frame<br>" +
            "Space Play/Pause<br>" +
            "Left - Backwards<br>" +
            "Right - Forwards<br>" +
            "Up - Faster Backwards<br>" +
            "Down - Faster Forwards<br>" +
            "V/B - Measure distance<br>" +
            "Right Click - Context Menu<br>" +
            "/ - Crosshair. Click to fix<br>" +
            "K - Show/Hide Shortcuts<br>" +

            ""


        ;
    }
    if (ViewMan.list.video && ViewMan.list.video.data.videoPercentLoaded > 0 && ViewMan.list.video.data.videoPercentLoaded < 100) {
        keyInfo += "Loading Video " + ViewMan.list.video.data.videoPercentLoaded + "%<br>";
    }


    if (par.showKeyboardShortcuts) {

        // Object.keys(toggles).forEach(function (key) {
        //     keyInfo += toggles[key]._name + "<br>"
        // })
    }

    if (par.showKeyboardShortcuts) {
        const router = getInteractionRouter();
        const profile = (router.session?.owner ?? router.hovered)?.profile;
        if (GESTURE_PROFILES[profile]) {
            keyInfo += `<br><b>${GESTURE_PROFILES[profile].label}</b><br>${gestureHelp(profile).replaceAll(" • ", "<br>")}`;
        }
    }

    if (debugText !== "")
        infoDiv.innerHTML = debugText;
    else
        infoDiv.innerHTML = keyInfo;

    UpdateChartLine();

}

// Do what needs doing if pitch and or roll (including JetRoll) has changed
// we re-calculate global roll here
// so are assuming that podRoll and jetRoll are correc
export function ChangedPR() {

    if (Ball === undefined) {
        // waiting for the model to load, so set a flag saying we need to do this again
        // this is a patch, as we really should separate the the rendered model from the calculations
        // of the gimbal orientation (plane->EOSU->Ball)
        // this is legacy code
        par.needsGimbalBallPatch = true;
        return;
    }

    par.needsGimbalBallPatch = false;

    // calculate the global roll (total roll needed)
    // this is used elsewhere
    par.globalRoll = par.podRollPhysical + NodeMan.get("bank").v(par.frame);

    // give pitch, roll, bank, set the ATFLIR pods pars rotations
    // These are all relative to the jet
    PodFrame.rotation.z = radians(-NodeMan.get("bank").v(par.frame))
    PodFrame.rotation.x = radians(jetPitchFromFrame())
    Ball.rotation.x = radians(-par.podPitchPhysical)
    EOSU.rotation.z = radians(-par.podRollPhysical)

    // INPUT
    const jetTrack = NodeMan.get("jetTrack")
    // move the jet!!!
    // we also need to be able to move the camera WITH the jet.
    const jet = jetTrack.p(par.frame);
    const offset = jet.clone().sub(LocalFrame.position)
    LocalFrame.position.add(offset)


    // how much has the heading changed
    const oldHeading = par.jetHeading;
    const newHeading = jetTrack.v(par.frame).heading
    let headingChange = newHeading - oldHeading;
    if (headingChange < -180) headingChange += 360;

    // Build LocalFrame orientation from the local tangent plane at the jet position.
    // In old EUS, identity quaternion had Y=up, -Z=north, so rotating around Y by -heading worked.
    // In ECEF, we must construct the tangent frame explicitly:
    //   X = east, Y = up, -Z = north (matching Three.js convention where -Z is forward)
    // then apply heading rotation around the up axis.
    const upAxis = getLocalUpVector(jet)
    const northAxis = getLocalNorthVector(jet)
    const eastAxis = V3().crossVectors(northAxis, upAxis).normalize()

    // Start with the tangent frame: X=east, Y=up, Z=south (i.e. -Z=north)
    const _x = eastAxis.clone()
    const _y = upAxis.clone()
    const _z = northAxis.clone().negate() // south = -north, so -Z = north

    // Rotate the horizontal axes (X and Z) by -heading around Y (up)
    _x.applyAxisAngle(_y, -radians(newHeading))
    _z.applyAxisAngle(_y, -radians(newHeading))

    const m = new Matrix4()
    m.makeBasis(_x, _y, _z)
    LocalFrame.quaternion.setFromRotationMatrix(m)

    LocalFrame.updateMatrix()
    LocalFrame.updateMatrixWorld()

    par.jetHeading = newHeading;

    const glarePos = PRJ2XYZ(par.podPitchPhysical, par.podRollPhysical + NodeMan.get("bank").v(par.frame), jetPitchFromFrame(), vizRadius)

   glareSphere.position.copy(glarePos);

    const targetPos = PRJ2XYZ(par.podPitchIdeal, par.podRollIdeal + NodeMan.get("bank").v(par.frame), jetPitchFromFrame(), vizRadius)
    targetSphere.position.copy(targetPos)

    updateLOS(GlobalScene, targetPos)

    const aV = EA2XYZ(Frame2El(Sit.aFrame), Frame2Az(Sit.aFrame), vizRadius)
    aSphere.position.copy(aV)
    const bV = EA2XYZ(Frame2El(Sit.bFrame), Frame2Az(Sit.bFrame), vizRadius)
    bSphere.position.copy(bV)

    const circleCenter = glareSphere.position;

    update_ERROR_circle(GlobalScene, circleCenter)

    if (theChart !== undefined) {
        theChart.cursor.show = true;
        theChart.cursor.x = 100;
        theChart.cursor.y = 200;
    }


    //  var rotationMatrix = new Matrix4().extractRotation(PodFrame.matrixWorld);
    //  var jetUp = new Vector3(0, 1, 0).applyMatrix4(rotationMatrix).normalize();

    // The rotations below are equivalent to the above,
    // but I'm doing it explicitly like this
    // to match the code in Frame2CueAz,
    // so the graph uses the same code as the arrows
    // except instead of using a unit sphere
    // we use one of radius vizRadius
    // to get the large arrows in the display.
    const jetUp = new Vector3(0, 1, 0)
    jetUp.applyAxisAngle(V3(0, 0, 1), -radians(NodeMan.get("bank").v(par.frame)))
    jetUp.applyAxisAngle(V3(1, 0, 0), radians(jetPitchFromFrame()))
    const jetPlane = new Plane(jetUp, 0) // plane in Hessian normal form, normal unit vector and a distance from the origin
    // take the targetPos (the white dot) and project it onto the jetPlane
    const cuePos = new Vector3;
    jetPlane.projectPoint(targetPos, cuePos) // project targetPos onto jetPlane, return in cuePos
//    DebugArrowAB("Projected Cue", targetPos, cuePos, 0x00ffff, false, LocalFrame)
//    DebugArrowAB("Cue Az", V3(0, 0, 0), cuePos, 0x00ffff, false, LocalFrame)

    const horizonPlane = new Plane(V3(0, 1, 0), 0)
    const azPos = new Vector3;
    horizonPlane.projectPoint(targetPos, azPos) // the same as just setting y to 0
//    DebugArrowAB("Projected Az", targetPos, azPos, 0xffff00, false, LocalFrame)
//    DebugArrowAB("Az", V3(0, 0, 0), azPos, 0xffff00, false, LocalFrame)
    UpdateHUD()
}


export function UpdatePRFromEA() {
    let pitch, roll;
    [pitch, roll] = EAJP2PR(Frame2El(par.frame), Frame2Az(par.frame), jetPitchFromFrame());
    par.podPitchPhysical = pitch;
    par.podPitchIdeal = pitch;
    par.globalRoll = roll
    par.podRollIdeal = par.globalRoll - NodeMan.get("bank").v(par.frame);
    if (par.deroFromGlare) {
        par.podRollPhysical = getPodRollFromGlareAngleFrame(par.frame)
    } else
        par.podRollPhysical = par.podRollIdeal
    ChangedPR()
}

export function UIChangedAz() {
    // we find the correct frame by finding the first one that has a calculated Az that
    // is greater than this az
    const aZDecreasing = Frame2Az(Sit.frames - 1) < Frame2Az(0)
    for (let f = 0; f < Sit.frames; f++) {
        if ((aZDecreasing ? Frame2Az(f) <= par.az : Frame2Az(f) >= par.az)) {
            console.log("UIChangedAz: frame " + par.frame + "-> " + f + " from az = " + par.az)
            par.frame = f;
            break;
        }
    }
    UIChangedFrame();
}

export function UIChangedTime() {
    setRenderOne(true);

    par.frame = Math.round(par.time * Sit.fps)
    if (par.frame >= Sit.frames) {
        par.frame = Sit.frames - 1
    }
    if (Sit.azSlider) {
        par.az = Frame2Az(par.frame)
        par.el = Frame2El(Sit.aFrame)
        UpdatePRFromEA()
    }

    par.paused = true;
}


// not sure if this function is even needed
export function UIChangedFrame() {
    setRenderOne(true);

    if (par.frame > Sit.frames - 1) par.frame = Sit.frames - 1;

    par.time = par.frame / Sit.fps
    if (Sit.azSlider) {
        par.az = Frame2Az(par.frame)
        par.el = Frame2El(Sit.aFrame)
        UpdatePRFromEA()
        NodeMan.get("azSources").recalculateCascade()
    }
    par.paused = true;
}

export function curveChanged() {
    UpdateChart()
    UpdatePRFromEA()

    ATFLIR.recalculate()

    setRenderOne(true);

}

export function UIChangedPR() {
    par.paused = true;
    setRenderOne(true);
    ChangedPR();
}

export function SetupTrackLOSNodes() {

//    console.log("+++ JetLOSDisplayNode")

    if (Sit.gimbalSetup || Sit.name.startsWith("gimbal")) {
        new CNodeDisplayLOS({
            id: "JetLOSDisplayNode",
            inputs: {
                LOS: "JetLOS",
            },
            color: 0x004040,
        })
    }

//    console.log("+++ JetTrackDisplayNode")
    new CNodeDisplayTrack({
        id: "jetTrackDisplayNode",
        track: "jetTrack",
        color: new CNodeConstant({id: "jetTrackColor", value: new Color(0, 1, 1)}),
        secondColor:    new CNodeConstant({id: "jetTrackColor2", value: new Color(0, 0.75, 0.75)}),
        width: 3,
        depthFunc:AlwaysDepth,
        toGround:60,
    })

//    console.log("+++ LOSTraverseDisplayNode")
    new CNodeDisplayTrack({
        id: "LOSTraverseDisplayNode",
        inputs: {
            track: "LOSTraverseSelect",
            color:          new CNodeConstant({id: "losTraverseColor", value: new Color(0, 1, 0)}),
            secondColor:    new CNodeConstant({id: "losTraverseColor2",value: new Color(0, 0.75, 0)}),
            width:          new CNodeConstant({id: "losTraverseWidth",value: 3}),
        },
        frames: Sit.frames,
        depthFunc:AlwaysDepth,
    })



}


export function SetupTraverseNodes(id, traverseInputs,defaultTraverse,los = "JetLOS", idExtra="", exportable=true) {
    CreateTraverseNodes(idExtra, los);
    return MakeTraverseNodesMenu(id, traverseInputs,defaultTraverse, idExtra, exportable)
}



// COMMON TRAVERSE NODE OPTIONS
//
export function CreateTraverseNodes(idExtra="", los = "JetLOS") {


    // A GUI variable for the start distance - this is one of the biggest variables
    // It's the distance of the start of the traverse along the first LOS
    if (!NodeMan.exists("startDistance")) {
        // new CNodeScale("startDistance", Units.big2M, new CNodeGUIValue({
        //     id: "startDistanceGUI",
        //     value: Sit.startDistance,
        //     start: Sit.startDistanceMin,
        //     end: Sit.startDistanceMax,
        //     step: 0.01,
        //     desc: "Tgt Start Dist " + Units.bigUnitsAbbrev,
        //     color: "#FFC0C0",
        // }, guiMenus.traverse))

        // new method, we supply the units, and return the value in SI units
        new CNodeGUIValue({
            id: "startDistance",
            value: Sit.startDistance,
            start: Sit.startDistanceMin,
            end: Sit.startDistanceMax,
            // No explicit maxMax: it defaults to `end`, so re-ranging the
            // slider can always reach the range the sitch declared. A fixed 30
            // sat BELOW the default ceiling and quietly capped it there.
            step: 0.001,
            desc: "Tgt Start Dist",
            color: "#FFC0C0",
            unitType: "big",
            // elastic: true,
            // elasticMin: 1,
            // elasticMax: 10000,
            tooltip: "Start distance of the traverse object along the first LOS",
        }, guiMenus.traverse)


    }

    // The optional Min/Max analysis-distance range limits for the traverse
    // analysis now live in the "Traverse Analysis Tweaks" subfolder,
    // created by addAnalyzeTweaks() in MakeTraverseNodesMenu.js.

//    console.log("+++ LOSTraverse")
//     new CNodeLOSTraverse({
//         id: "LOSTraverse1"+idExtra,
//         LOS: los,
//         startDist: "startDistance",
//         VcMPH: new CNodeGUIValue({id: "targetVCGUI"+idExtra, value: 20, start: -500, end: 500, step: 0.01, desc: "Target Vc MPH"
//         },
//             guiMenus.traverse),
//     })


    new CNodeLOSTraverse({
        id: "LOSTraverseConstantDistance"+idExtra,
        LOS: los,
        startDist: "startDistance",
        },
    guiMenus.traverse)

    // // GUI variable Target Speed in Knots (scaled to m/s)
    // if (!NodeMan.exists("speedScaled")) {
    //     new CNodeScale("speedScaled", 1 / Units.m2Speed,
    //         new CNodeGUIValue({
    //             id: "targetSpeedGUI"+idExtra,
    //             value: Sit.targetSpeed,
    //             start: Sit.targetSpeedMin,
    //             end: Sit.targetSpeedMax,
    //             step: Sit.targetSpeedStep,
    //             desc: "Target Speed " + Units.speedUnits
    //         }, guiMenus.traverse))
    // }

    if (!NodeMan.exists("speedScaled")) {
        new CNodeGUIValue({
            id: "speedScaled",
            value: Sit.targetSpeed,
            start: Sit.targetSpeedMin,
            end: Sit.targetSpeedMax,
            step: Sit.targetSpeedStep,
            desc: "Target Speed",
            unitType: "speed",
            tooltip: "Target speed of the traverse object.\ni.e. the speed you want the traverse object to be travelling when in 'Constant Speed' mode",
        }, guiMenus.traverse)
    }


    // Traverse at constant GROUND speed (using the above)
    new CNodeLOSTraverseConstantSpeed({
        id: "LOSTraverseConstantSpeed"+idExtra,
        inputs: {
            LOS: los,
            startDist: "startDistance",
            speed: "speedScaled",
            wind: "targetWind"
        },
        airSpeed:false,

    }, guiPhysics)

    // Traverse at constant AIR speed
    new CNodeLOSTraverseConstantSpeed({
        id: "LOSTraverseConstantAirSpeed"+idExtra,
        inputs: {
            LOS: los,
            startDist: "startDistance",
            speed: "speedScaled",
            wind: "targetWind"
        },
        airSpeed:true,
    },guiMenus.traverse)

    // as above, but interpolate between the start and end frames
    // remaining constant speed, but not necessarily on the LOS
    new CNodeInterpolateTwoFramesTrack({
        id: "LOSTraverseStraightConstantAir"+idExtra,
        source: "LOSTraverseConstantAirSpeed"+idExtra,
    },guiMenus.traverse)


    // In any Sitch we have an initialHeading and a relativeHeading
    // initialHeading is historically the start direction of the jet, like in Gimbal
    // it's the direction we set the jet going in
    //
    // relativeHeading is added to initialHeading to get targetActualHeading
    //
    // for Gimbal and similar this allowed us to rotate the jet's path with initialHeading
    // and then adjust (rotate) the targetActualHeading realtive to that.
    // For Aguadilla though, the initialheading is a fixed 0, sicne the path is fixed
    // meaning that relativeHeading is actually absolut (i.e. relative to 0)
    // i.e. we have a single number defining targetActualHeading

    // initial Heading might not exist
    if (!NodeMan.exists("initialHeading")) {
        new CNodeHeading({
            id: "initialHeading",
            heading: Sit.heading ?? 0,
            name: "Initial",
            arrowColor: "green",
            tooltip: "Start heading of straight-line traversal"

        }, guiMenus.traverse)
    }

    if (!NodeMan.exists("targetRelativeHeading")) {
        new CNodeGUIValue({
            id: "targetRelativeHeading",
            value: Sit.relativeHeading,
            start: -180,
            end: 180,
            step: 0.01,
            desc: "Tgt Relative Heading",
            tooltip: "[Deprecated] Relative heading of the target, added to initialHeading to get targetActualHeading.\nUse for fine tuning",
        }, guiMenus.traverse)
    }

    if (!NodeMan.exists("targetActualHeading")) {
        new CNodeMunge({
            id: "targetActualHeading",
            inputs: {initialHeading: "initialHeading", relativeHeading: "targetRelativeHeading"},
            munge: function (f) {
                let newHeading = this.in.initialHeading.getHeading() + this.in.relativeHeading.v0
                if (newHeading < 0) newHeading += 360;
                if (newHeading >= 360) newHeading -= 360
                return newHeading
            }
        }, guiMenus.traverse)
    }
    // and with that target heading we can try for a stright line traversal
    // currently very simplistic and does not work with noisy data.
    new CNodeLOSTraverseStraightLine({
        id: "LOSTraverseStraightLine"+idExtra,
        LOS: los,
        startDist: "startDistance",
        lineHeading: "targetActualHeading",
    })

    new CNodeLOSTraverseStraightLineFixed({
        id: "LOSTraverseStraightLineFixed"+idExtra,
        LOS: los,  // we just need the first LOS
        startDist: "startDistance",
        lineHeading: "targetActualHeading",
        speed: "speedScaled",
    })

    new CNodeLOSTraverseWind({
        id: "LOSTraverseWind"+idExtra,
            LOS: los,
            startDist: "startDistance",
            wind: "targetWind"
    });


    // this isn't used in custom, but it's still in some old saves
    // leaving it here is fine as, like all tracks now, it will
    // get recalculate-culled if there's no display outputs.
    if (NodeMan.exists("fixedTargetPosition")) {
        new CNodeLOSTraverseWind({
            id: "LOSTraverseWindTarget" + idExtra,
            LOS: los,
            startDist: "startDistance",
            wind: "targetWind",
            targetStart: "fixedTargetPosition",
        });
    }



    // Constant altitude
//    console.log("+++ LOSTraverseConstantAltitude Node")
    new CNodeLOSTraverseConstantAltitude({
        id: "LOSTraverseConstantAltitude"+idExtra,
        inputs: {
            LOS: los,
            startDist: "startDistance",
         //   radius: "radiusMiles",
        },
    })

    new CNodeLOSTraversePerspective({
        id: "LOSTraversePerspective"+idExtra,
        inputs: {
            LOS: los,
            startDist: "startDistance",
        },
    })

    // Global least-squares fits
    new CNodeLOSFitCV({
        id: "LOSFitCV"+idExtra,
        LOS: los,
    })

    new CNodeLOSFitCA({
        id: "LOSFitCA"+idExtra,
        LOS: los,
    })

    // Kalman smoother parameters
    if (!NodeMan.exists("kalmanProcessNoise")) {
        new CNodeGUIValue({
            id: "kalmanProcessNoise",
            value: -4, start: -8, end: 2, step: 0.1,
            desc: "KF Process",
            color: "#C0C0FF",
            tooltip: "Kalman process noise exponent. Higher = tracks maneuvers, lower = smoother.",
        }, guiMenus.traverse)

        new CNodeGUIValue({
            id: "kalmanMeasurementNoise",
            value: 0, start: -4, end: 4, step: 0.1,
            desc: "KF Noise",
            color: "#C0C0FF",
            tooltip: "Kalman measurement noise exponent. Higher = smoother, lower = follows LOS more closely.",
        }, guiMenus.traverse)
    }

    new CNodeLOSFitKalman({
        id: "LOSFitKalman"+idExtra,
        LOS: los,
        processNoise: "kalmanProcessNoise",
        measurementNoise: "kalmanMeasurementNoise",
    })

    // Monte Carlo parameters
    if (!NodeMan.exists("mcNumTrials")) {
        new CNodeGUIValue({
            id: "mcNumTrials",
            value: 1000, start: 100, end: 10000, step: 100,
            desc: "MC Num Trials",
            color: "#FFC0FF",
            tooltip: "Number of Monte Carlo random trials. More = better fit, slower.",
        }, guiMenus.traverse)

        new CNodeGUIValue({
            id: "mcLOSUncertainty",
            value: 2, start: 0, end: 10, step: 0.1,
            desc: "MC LOS Uncertainty (deg)",
            color: "#FFC0FF",
            tooltip: "Max random perturbation of LOS direction per trial.",
        }, guiMenus.traverse)

        new CNodeGUIValue({
            id: "mcOrder",
            value: 1, start: 1, end: 5, step: 1,
            desc: "MC Polynomial Order",
            color: "#FFC0FF",
            tooltip: "Polynomial degree. 1=linear, 2=quadratic, 3=cubic.",
        }, guiMenus.traverse)
    }

    new CNodeLOSFitMonteCarlo({
        id: "LOSFitMonteCarlo"+idExtra,
        LOS: los,
        numTrials: "mcNumTrials",
        losUncertaintyDeg: "mcLOSUncertainty",
        order: "mcOrder",
    })

    new CNodeLOSFitMonteCarlo2({
        id: "LOSFitMonteCarlo2"+idExtra,
        LOS: los,
        numTrials: "mcNumTrials",
        losUncertaintyDeg: "mcLOSUncertainty",
        order: "mcOrder",
    })

    // Physics model parameters
    if (!NodeMan.exists("physicsMaxIter")) {
        new CNodeGUIValue({
            id: "physicsMaxIter",
            value: 5000, start: 500, end: 20000, step: 500,
            desc: "Physics Max Iterations",
            color: "#C0FFC0",
            tooltip: "Maximum Nelder-Mead optimizer iterations.",
        }, guiMenus.traverse)

        // Default the wind guess from the sitch's target-altitude wind when
        // it has one (Sit.targetWindKnots/From) — that IS the wind at the
        // object, and the fixed-wing fit softly pins its wind to this guess.
        new CNodeGUIValue({
            id: "physicsWindSpeed",
            value: Sit.targetWindKnots ?? 18, start: 0, end: 150, step: 0.5,
            desc: "Physics Wind Speed (kt)",
            color: "#C0FFC0",
            tooltip: "Initial guess for wind speed. Optimizer refines this.",
        }, guiMenus.traverse)

        new CNodeGUIValue({
            id: "physicsWindFrom",
            value: Sit.targetWindFrom ?? 70, start: 0, end: 360, step: 1,
            desc: "Physics Wind From (°)",
            color: "#C0FFC0",
            tooltip: "Initial guess for wind direction (meteorological, degrees). Optimizer refines this.",
        }, guiMenus.traverse)

        new CNodeGUIValue({
            id: "physicsInitialRange",
            value: 3000, start: 100, end: 20000, step: 100,
            desc: "Physics Initial Range (m)",
            color: "#C0FFC0",
            tooltip: "Initial guess for distance along first LOS ray.",
        }, guiMenus.traverse)
    }

    // Physics-model choice for the physics fit (string constants behind a switch)
    if (!NodeMan.exists("physicsModelChoice")) {

        // Make/model sub-dropdowns: one option per catalog entry (display name ->
        // catalog id). Choosing a specific make/model tightens the physics fit to
        // that airframe's real envelope; the AUTO entry (first in each catalog)
        // fits the generic envelope and the analysis reports the closest match.
        // Only the sub-dropdown for the currently-selected physics model is shown
        // (see updateModelSubMenus below).
        const quadInputs = {};
        for (const m of QUADCOPTER_MODELS) {
            quadInputs[m.name] = new CNodeConstant({id: "quadModel_" + m.id, value: m.id});
        }
        new CNodeSwitch({
            id: "quadModelChoice",
            inputs: quadInputs,
            desc: "Quadcopter Model",
            default: QUADCOPTER_MODELS[0].name,
            tooltip: "Which multirotor to bound the Quadcopter physics fit to. AUTO fits the full multirotor envelope and reports the closest common model.",
        }, guiMenus.traverse)

        const fwInputs = {};
        for (const m of FIXED_WING_MODELS) {
            fwInputs[m.name] = new CNodeConstant({id: "fixedWingModel_" + m.id, value: m.id});
        }
        new CNodeSwitch({
            id: "fixedWingModelChoice",
            inputs: fwInputs,
            desc: "Fixed-Wing Model",
            default: FIXED_WING_MODELS[0].name,
            tooltip: "Which fixed-wing type to bound the Fixed Wing physics fit to. AUTO fits the generic envelope and reports the closest type.",
        }, guiMenus.traverse)

        // Show only the sub-dropdown relevant to the selected physics model.
        const updateModelSubMenus = (choice) => {
            const quad = NodeMan.get("quadModelChoice", false);
            const fw = NodeMan.get("fixedWingModelChoice", false);
            if (quad) { choice === "Quadcopter" ? quad.show() : quad.hide(); }
            if (fw) { choice === "Fixed Wing Aircraft" ? fw.show() : fw.hide(); }
        };

        new CNodeSwitch({
            id: "physicsModelChoice",
            inputs: {
                "Sky Lantern": new CNodeConstant({id: "physicsModelLantern", value: "Sky Lantern"}),
                "Fixed Wing Aircraft": new CNodeConstant({id: "physicsModelFixedWing", value: "Fixed Wing Aircraft"}),
                "Quadcopter": new CNodeConstant({id: "physicsModelQuad", value: "Quadcopter"}),
            },
            desc: "Physics Model",
            default: "Sky Lantern",
            tooltip: "Dynamics model used by the 'Global Fit: Physics' traverse method.",
        }, guiMenus.traverse)

        // choiceChanged fires this event on user change AND on quiet deserialize
        // (restoring a saved Quadcopter/Fixed-Wing fit), so the right sub-dropdown
        // shows after a sitch load without needing a manual re-select. Listeners
        // are cleared per sitch load, so this does not accumulate.
        EventManager.addEventListener("Switch.choiceChanged.physicsModelChoice",
            (choice) => updateModelSubMenus(choice));
        updateModelSubMenus("Sky Lantern");   // initial visibility (default model)
    }

    new CNodeLOSFitPhysics({
        id: "LOSFitPhysics"+idExtra,
        LOS: los,
        physicsModel: "physicsModelChoice",
        quadModel: "quadModelChoice",
        fixedWingModel: "fixedWingModelChoice",
        maxIter: "physicsMaxIter",
        windSpeed: "physicsWindSpeed",
        windFrom: "physicsWindFrom",
        initialRange: "physicsInitialRange",
    })

    // Wind Tracer — a drifting, slowly descending object fitted with the
    // camera's own pointing motion modelled instead of believed. The anchor is
    // eliminated in closed form, so there is no start-distance input; see
    // src/WindTracerFit.js.
    if (!NodeMan.exists("windTracerPointingSigma")) {
        new CNodeGUIValue({
            id: "windTracerPointingSigma",
            value: 0.4, start: 0.02, end: 3, step: 0.01,
            desc: "Tracer Pointing σ (°)",
            color: "#C0FFC0",
            tooltip: "How far off the object the operator's boresight plausibly wanders, in degrees.\nRoughly the frame half-width. Larger values let the fit attribute more of the residual to camera motion rather than to the object.",
        }, guiMenus.traverse)

        new CNodeGUIFlag({
            id: "windTracerLooseShear",
            value: false,
            desc: "Tracer Loose Shear",
            tooltip: "Widen the wind-shear bound past the physical marine value (about 5e-4 per metre).\nA fit that needs the loose bound is telling you the drift decelerates more than any ordinary wind profile can explain.",
        }, guiMenus.traverse)
    }

    if (!NodeMan.exists("LOSFitWindTracer"+idExtra)) {
        // No wind input: the fit resolves targetWind by name at fit time and
        // samples it at a fixed frame, so a track-driven wind cannot cascade a
        // multi-second refit per MISB row. See CNodeLOSFitWindTracer._windPrior.
        new CNodeLOSFitWindTracer({
            id: "LOSFitWindTracer"+idExtra,
            LOS: los,
            pointingSigma: "windTracerPointingSigma",
            looseShear: "windTracerLooseShear",
        });
    }

    // Best-fit smooth traverse with soft speed target — reads the same
    // "Tgt Start Dist" and "Target Speed" sliders as the Const Air Spd
    // traverse, but solves for the least-maneuvering LOS-riding path with
    // the speed as a loose target rather than an exact constraint.
    if (!NodeMan.exists("LOSFitPlausible"+idExtra)) {
        const plausibleDef = {
            id: "LOSFitPlausible"+idExtra,
            LOS: los,
            startDist: "startDistance",
            speed: "speedScaled",
        };
        if (NodeMan.exists("targetWind")) plausibleDef.wind = "targetWind";
        new CNodeLOSFitPlausible(plausibleDef);
    }

    // Minimum-speed fit — the slowest object consistent with the sightlines
    // (drifting lantern / near-static object). Same traverseMinSpeed core the
    // traverse-analysis gallery uses, so its "Minimum Speed" contender
    // applies to exactly this method.
    if (!NodeMan.exists("LOSFitMinSpeed"+idExtra)) {
        const minSpeedDef = {
            id: "LOSFitMinSpeed"+idExtra,
            LOS: los,
            startDist: "startDistance",
        };
        if (NodeMan.exists("targetWind")) minSpeedDef.wind = "targetWind";
        new CNodeLOSFitMinSpeed(minSpeedDef);
    }

    // Stationary-point family — live counterparts of the analysis gallery's
    // "Stationary Point in Space", "Ground Object" and "Ground Vehicle" tiles,
    // built on the same fits so "Use This" reproduces the tile exactly. (No
    // on-ray traverse can hold a fixed point: walking rays at speed 0 still
    // moves by the rays' closest-approach distance each frame and flags the
    // over-speed segments white — the old broken apply.)
    if (!NodeMan.exists("LOSFitStationaryPoint"+idExtra)) {
        new CNodeLOSFitStationaryPoint({id: "LOSFitStationaryPoint"+idExtra, LOS: los});
        new CNodeLOSFitStationaryPoint({id: "LOSFitGroundPoint"+idExtra, LOS: los, groundPin: true});
        new CNodeLOSFitGroundVehicle({id: "LOSFitGroundVehicle"+idExtra, LOS: los});
    }

    // Pointwise-exact snapshot installed by the Traverse Analysis gallery.
    // This avoids re-running a different live algorithm after the user has
    // already reviewed and selected a solved trajectory.
    if (!NodeMan.exists("LOSFitAnalysisResult"+idExtra)) {
        new CNodeLOSFitAnalysisResult({id: "LOSFitAnalysisResult"+idExtra, LOS: los});
    }

    if (!NodeMan.exists("startAltitude")) {
        new CNodeGUIValue({
            id: "startAltitude",
            value: 1000,
            start: 0,
            end: 10000,
            step: 1,
            desc: "Tgt Start Altitude",
            unitType: "small",
            color: "#FFC0C0",
            elastic: true,
            elasticMin: 1000,
            elasticMax: 100000,
        }, guiMenus.traverse)


        new CNodeGUIValue({
            id: "verticalSpeed",
            value: 0,
            start: -1000,
            end: 1000,
            step: 1,
            desc: "Tgt Vert Spd",
            unitType: "verticalSpeed",
            color: "#FFC0C0"
        }, guiMenus.traverse)
    }


    // // we want another node to adjust the max altitude, to make it easier to change
    // // like for some sitches, it will be withing 5000 feet, and other 100,000 feet?
    // new CNodeGUIValue({
    //     id: "maxAltitudeGUI",
    //     value: 1000,
    //     start: 0,
    //     end: 100000,
    //     step: 1,
    //     desc: "Tgt Start Altitude " + Units.smallUnitsAbbrev,
    //     color: "#FFC0C0"
    // }, guiMenus.traverse))


    new CNodeLOSTraverseConstantAltitude({
        id: "LOSTraverseStartingAltitude"+idExtra,
        inputs: {
            LOS: los,
            altitude: "startAltitude",
            verticalSpeed: "verticalSpeed",
        },
    })

}


// pixel dimension of the overall browser window renderble area.
// same coordinate system as the mouse clicks
//windowWidth  = window.innerWidth;
//windowHeight = window.innerHeight;

let lastWindowWidth, lastWindowHeight;
let lastContentWidth, lastContentHeight;

// Detects if the page's window has been resized, and resize things as needed.
export function updateSize(force) {

    const contentWidth = ViewMan.container ? ViewMan.container.offsetWidth : window.innerWidth;
    const contentHeight = ViewMan.container ? ViewMan.container.offsetHeight : window.innerHeight;

    if (force || lastWindowWidth !== window.innerWidth || lastWindowHeight !== window.innerHeight ||
        lastContentWidth !== contentWidth || lastContentHeight !== contentHeight) {
        const windowWidth = window.innerWidth;
        const windowHeight = window.innerHeight;
        lastWindowHeight = windowHeight;
        lastWindowWidth = windowWidth;
        lastContentWidth = contentWidth;
        lastContentHeight = contentHeight;

        // Match the actual render-target size so LineMaterial's shader maps
        // pixel-width uniforms to real fb pixels. Stale resolution → lines
        // render at sub-pixel widths and drop fragments at low renderScale.
        const lineDPR = (window.devicePixelRatio || 1) * getEffectiveRenderScale();
        updateMatLineResolution(windowWidth * lineDPR, windowHeight * lineDPR)

        const scale = window.innerWidth / 1920

        ViewMan.updateSize();

        ViewMan.iterate((key, data) => data.updateWH())
        infoDiv.style.fontSize = 16 * scale + "px"
        updateChartSize()
        setRenderOne(true);
    }
}


function ensureGroundFrame() {
    if (Sit.groundFrame !== undefined) {
        return Sit.groundFrame;
    }

    // Legacy sitches (like flir1) can call initViews without creating groundFrame first.
    if (Sit.lat === undefined || Sit.lon === undefined) {
        console.warn("initViews: missing Sit.groundFrame and Sit.lat/lon, skipping ground-frame helper setup");
        return null;
    }

    const surfacePos = LLAToECEF(Sit.lat, Sit.lon, 0);
    const groundUp = getLocalUpVector(surfacePos);
    const groundNorth = getLocalNorthVector(surfacePos);
    const groundEast = V3().crossVectors(groundNorth, groundUp).normalize();
    const groundSouth = groundNorth.clone().negate();
    const groundMatrix = new Matrix4();
    groundMatrix.makeBasis(groundEast, groundUp, groundSouth);

    Sit.groundFrame = new Group();
    Sit.groundFrame.position.copy(surfacePos);
    Sit.groundFrame.quaternion.setFromRotationMatrix(groundMatrix);
    Sit.groundFrame.updateMatrix();
    Sit.groundFrame.updateMatrixWorld();
    GlobalScene.add(Sit.groundFrame);

    return Sit.groundFrame;
}



export function initViews() {
    new CNodeChartView({
        id: "chart",
        top: 0.5, height: 0.5, width: -1,
        visible: true,
        // draggable is handled internally
    })

    ViewMan.get("chart").setVisible(par.showChart);

    if (ViewMan.list.video) {
        const labelOriginalVideo = new CNodeViewUI({id: "labelOriginalVideo", overlayView: ViewMan.list.video.data});
        labelOriginalVideo.addText("videolabel", "ORIGINAL VIDEO", 70, 10, 3, "#f0f00080")
        labelOriginalVideo.setVisible(true)
    }

    if (!isLocal) {
        const labelMainView = new CNodeViewUI({id: "labelMainView", overlayView: ViewMan.list.mainView.data});
        labelMainView.addText("videolabel1", "WORK IN PROGRESS", 45, 90, 3, "#f0f00020")
        labelMainView.addText("videolabel2", "RESULTS MAY VARY", 45, 95, 3, "#f0f00020")
        labelMainView.setVisible(true)
    }
    const farClipLook = metersFromMiles(500)



    if (Sit.showATFLIR || Sit.name.startsWith("gimbal") || Sit.name === "flir1") {

        // a grid spaced one Nautical mile square
        const gridSquaresGround = 200
        let gridHelperGround = new GridHelperWorld(1,metersFromNM(gridSquaresGround), gridSquaresGround, metersFromMiles(EarthRadiusMiles), 0x606000, 0x606000);
        const groundFrame = ensureGroundFrame();
        if (groundFrame) {
            groundFrame.add(gridHelperGround);
        }

        setATFLIR(new CNodeDisplayATFLIR({
            id: "displayATFLIR",
            inputs: {},
            layers: LAYER.MASK_MAIN, // ATFLIR pod would obscure the camera in look view
        }))

        // everything in the local frame should show up in MAIN, but not in LOOK
        LocalFrame.layers.mask = LAYER.MASK_MAIN;
        propagateLayerMaskObject(LocalFrame);

    }


    const line_material = new LineBasicMaterial({color: 0xffffff});
    const line_materialRED = new LineBasicMaterial({color: 0xff8080, linewidth: 5});

    // Now using the Line2, etc from https://github.com/mrdoob/three.js/blob/master/examples/webgl_lines_fat.html

    const pitchStep = 2;
    const rollStep = 1;
    const pitchGap = 10
    const rollGap = 10;

    // an invisible hemisphere, just for collision, with vizRadius
    const positions = [];
    for (let pitch = 0; pitch < 90; pitch += pitchGap) {

        for (let roll = 0; roll <= 360; roll += rollGap) {
            const A = PRJ2XYZ(pitch, roll, 0, vizRadius)
            const B = PRJ2XYZ(pitch, roll + rollGap, 0, vizRadius)
            const C = PRJ2XYZ(pitch + pitchGap, roll, 0, vizRadius)
            const D = PRJ2XYZ(pitch + pitchGap, roll + rollGap, 0, vizRadius)

            // It's a triangle list (not a strip), so need two sets of three verts for a quad.
            positions.push(A.x, A.y, A.z);
            positions.push(C.x, C.y, C.z);
            positions.push(B.x, B.y, B.z);

            positions.push(C.x, C.y, C.z);
            positions.push(D.x, D.y, D.z);
            positions.push(B.x, B.y, B.z);

        }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
    geometry.computeBoundingSphere();

    const material = new MeshBasicMaterial({
        color: 0x101010,
        transparent: true,
        opacity: 0.5,
        side: DoubleSide  // not workingf ?

    });

    if (Sit.showGimbalDragMesh || Sit.name.startsWith("gimbal")) {
        const dragMesh = new Mesh(geometry, material);
        dragMesh.visible = false;
        dragMesh.name = "dragMesh"
        PodFrame.add(dragMesh);
    }

    // These are Az, El, so the numbers read on screen


    if ((Sit.showGimbalDragMesh || Sit.name.startsWith("gimbal")) && Sit.showGlare) {
        LocalFrame.add(glareSprite);
        showHider(glareSprite, "Glare Spr[I]te", false, 'i').name(t("showHiders.glareSprite.label"))
    }

    // mobile adjustments, no keyboard, no chart, UI closed
    // Note: Globals.isMobile is set early in index.js checkUserAgent()
    if (Globals.isMobile) {
        gui.close()
        par.showChart = false;
        chartDiv.style.display = 'none';
        par.showKeyboardShortcuts = false;
        //   infoDiv.style.display = 'none';
    }


    if (Sit.showGimbalCharts || Sit.name.startsWith("gimbal")) {
        // this is calculated at the start, and when glareAngle switch node is changed
        calculateGlareStartAngle();

        setupGimbalChart()
    }


    updateSize(true);
}

export function SetupCommon(altitude=25000) {
//    console.log("+++ radiusMiles Node")
    // new CNodeGUIValue({
    //     id: "radiusMiles",
    //     value: EarthRadiusMiles,
    //     start: 500,
    //     end: 10000,
    //     step: 1,
    //     desc: "Earth Radius"
    // }, guiTweaks)

    // console.log(">>>+++ jetAltitude Node")
    // scaleNodeF2M("jetAltitude", new CNodeGUIValue({
    //     value: altitude,
    //     desc: "Altitude",
    //     start: altitude-500,
    //     end: altitude+500,
    //     step: 1
    // }, guiTweaks))

//    console.log("+++ cloudAltitude Node")
    scaleNodeF2M("cloudAltitude", new CNodeGUIValue({
        id: "cloudAltitudeGUI",
        value: 11740,           // Was 9500 when we had refraction adjusted Earth radius, not it's all wgs84.RADIUS
        start: 0,
        end: 26000,
        step: 10,
        desc: "Cloud Altitude"
    }, guiTweaks))

}

export function CommonJetStuff() {
    console.log(">>>+++ CommonJetStuff()")
    // For the piece-by-piece Gimbal build, the traverse track hasn't been
    // created yet.  All graphs here depend on LOSTraverseSelect, so bail
    // cleanly — the user can invoke them later once traverse is added
    // (see CustomSupport._setupManualBuildFolder "Gimbal Graphs" step).
    if (!NodeMan.exists("LOSTraverseSelect")) {
        console.log("CommonJetStuff: deferred (LOSTraverseSelect not yet created)");
        return;
    }
    // Idempotent: `chart` is the first node initViews() creates; if it already
    // exists we've been here before (e.g. re-invocation from a manual-build step).
    if (NodeMan.exists("chart")) {
        console.log("CommonJetStuff: already run, skipping");
        return;
    }
    // only gimbal uses this
    AddSpeedGraph({
        source: "LOSTraverseSelect",
        caption: "Traverse Speed",
        minY: 0, maxY: 360,
        left: 0.6, top: 0, width: -1, height: 0.25,
        lines: [
            {x: 716, x2: 725, color: "#FF00ff40"},
            {x: 813, x2: 828, color: "#ff00ff40"},
            {x: 861, x2: 943, color: "#ff00ff40"},
            {x: 978, x2: 984, color: "#ff00ff40"},
        ],
    })
    AddAltitudeGraph(10000, 45000)

    if (Sit.showGimbalCharts || Sit.name === "gimbal") {
        AddTailAngleGraph(null, {left: 0.73, top: .25, width: -1, height: .25})
    }

    AddTargetDistanceGraph()
    AddSizePercentageGraph()

    initViews()

    UpdateHUD()
    UpdateChart()
}

// for Gimbal, GoFast, FLIR1, and Aguadilla
export function initJetStuff() {
    console.log(">>>+++ initJetStuff()")

    // note that since we have a very large distance to the far clipping plane
    // but we use a logarithmic depth buffer, so it works out.
    const farClip = metersFromMiles(2000)

    const mainCam = NodeMan.get("mainCamera").camera;
    mainCam.layers.enable(LAYER.podBack)

    const view = NodeMan.get("mainView");
    view.preRenderFunction = function () {

        // Piece-by-piece Gimbal build: these nodes are created on demand, so
        // bail out cleanly until the pipeline is far enough along.
        const sa = ViewMan.get("SAPage", false);
        if (!sa) return;
        if (!NodeMan.exists("localWind") || !NodeMan.exists("targetWind")
            || !NodeMan.exists("LOSTraverseSelect") || !NodeMan.exists("jetTrack")) {
            return;
        }

        const displayWindArrows = sa.buttonBoxed(16);  // wind button

        const windTrackLocal = NodeMan.get("localWind")
        const windTrackTarget = NodeMan.get("targetWind")
        const ufoTrack = NodeMan.get("LOSTraverseSelect")
        const jetTrack = NodeMan.get("jetTrack")

        const vScale = Sit.frames
        const windVelocityScaledLocal = windTrackLocal.v(par.frame).multiplyScalar(vScale)
        const windVelocityScaledTarget = windTrackTarget.v(par.frame).multiplyScalar(vScale)

        let jetPosition = ufoTrack.p(par.frame);
        let jetVelocityScaled = trackVelocity(ufoTrack, par.frame).multiplyScalar(vScale)
        let groundVelocityEnd = jetPosition.clone().add(jetVelocityScaled);
        let airVelocityEnd = groundVelocityEnd.clone().sub(windVelocityScaledTarget);
        DebugArrowAB("UFO Ground V", jetPosition, groundVelocityEnd, "#00ff00", displayWindArrows, GlobalScene) // green = ground speed
        DebugArrowAB("UFO Wind", airVelocityEnd, groundVelocityEnd, "#00ffff", displayWindArrows, GlobalScene) // cyan = wind speed
        DebugArrowAB("UFO Air V", jetPosition, airVelocityEnd, "#0000ff", displayWindArrows, GlobalScene) // blue = air speed

        jetPosition = jetTrack.p(par.frame);
        jetVelocityScaled = trackVelocity(jetTrack, par.frame).multiplyScalar(vScale)
        groundVelocityEnd = jetPosition.clone().add(jetVelocityScaled);
        airVelocityEnd = groundVelocityEnd.clone().sub(windVelocityScaledLocal);
        DebugArrowAB("JET Ground V", jetPosition, groundVelocityEnd, "#00ff00", displayWindArrows, GlobalScene) // green = ground speed
        DebugArrowAB("JET Wind", airVelocityEnd, groundVelocityEnd, "#00ffff", displayWindArrows, GlobalScene) // cyan = wind speed
        DebugArrowAB("JET Air V", jetPosition, airVelocityEnd, "#0000ff", displayWindArrows, GlobalScene) // blue = air speed
    }

    const farClipLook = metersFromMiles(500)

    // view of the back of the pod with rotating glare on it.
    const podCamera = new PerspectiveCamera(45, window.innerWidth / window.innerHeight, 1, farClipLook);
    // Position the pod camera offset from LocalFrame using local tangent vectors
    const podUp = getLocalUpVector(LocalFrame.position);
    const podNorth = getLocalNorthVector(LocalFrame.position);
    const podEast = V3().crossVectors(podUp, podNorth).normalize();
    podCamera.position.copy(LocalFrame.position.clone()
        .add(podEast.clone().multiplyScalar(-20))
        .add(podUp.clone().multiplyScalar(20))
        .add(podNorth.clone().multiplyScalar(40)));
    podCamera.up.copy(podUp);
    podCamera.lookAt(LocalFrame.position);


    // wrap these other cameras in nodes
    const podCameraNode = new CNodeCamera({id:"podCamera", camera: podCamera})

// 0 - podhead
    const viewPod = new CNodeView3D({
        id: "podBackView",
        visible: false,
        top: 0.010319917440660475, left: 0.6583333333333333, width: 0.2, height: 0.3993808049535604,
        background: new Color().setRGB(0.0, 0.0, 0.0),
        up: [0, 1, 0],
        fov: 30,
        draggable: true,
        resizable: true,
        freeAspect: true,
        camera: podCameraNode,

        postRenderFunction: function() {
                if (PODBack) {
                    PODBack.visible = true;
                }
        }


    })

    viewPod.addOrbitControls(view.renderer);
    // Set orbit controls position/target relative to LocalFrame using local tangent vectors
    const podCtrlUp = getLocalUpVector(LocalFrame.position);
    const podCtrlNorth = getLocalNorthVector(LocalFrame.position);
    const podCtrlEast = V3().crossVectors(podCtrlUp, podCtrlNorth).normalize();
    viewPod.controls.position = LocalFrame.position.clone().add(podCtrlEast.clone().multiplyScalar(10));
    viewPod.controls.target = LocalFrame.position.clone();


//

    // Pod's eye - what the pod sees, physical angles, and then tweaked to look at target
    const podsEyeCamera = new PerspectiveCamera(20, window.innerWidth / window.innerHeight, 99, farClipLook);
    podsEyeCamera.lookAt(new Vector3(0, 0, -1));
    podsEyeCamera.layers.disable(LAYER.MAIN)
    podsEyeCamera.layers.disable(LAYER.HELPERS)
    podsEyeCamera.layers.enable(LAYER.podsEye)

    let podsEyeCameraNode = new CNodeCamera({id:"podsEyeCamera", camera: podsEyeCamera})

    new CNodeView3D({
        id: "podsEyeView",

        debug: true,
        visible: false,
        left: 0.28958, top: 0.52425, width: -1, height: 0.46749,
        background: new Color().setRGB(0.0, 0.0, 0.0),
        up: [0, 1, 0],
        fov: 1,
        draggable: true,
        resizable: true,
        camera: podsEyeCameraNode,
        preRenderFunction: function () {
            if (!Ball) return;
            // we want the camera to be based on the ball orientation
            // (i.e. what the pod head is looking at)
            // but be centered on the target
            // so we set the camera's up vector to match the ball
            // and then use lookAt to focus on the target
            // this keeps the same orientation as the ball
            this.camera.up = V3(Ball.matrixWorld.elements[4],
                Ball.matrixWorld.elements[5],
                Ball.matrixWorld.elements[6])
            this.camera.up.normalize()
            this.camera.lookAt(targetSphere.position)

            if (Sit.showGlare) {
                glareSprite.material.rotation = radians(par.glareStartAngle)
            }
        },

        postRenderFunction: function () {
            if (Sit.showGlare) {
                glareSprite.material.rotation = 0
            }
        }
    })

    const ui = new CNodeViewUI({id: "podseye", overlayView: ViewMan.list.podsEyeView.data});
    ui.addText("info", "Pods-Eye View", 50, 90, 6, "#FFFF00")

    // Pod's eye, same, but derotated so horizon is correct.
    const podsEyeDeroCamera = new PerspectiveCamera(20, window.innerWidth / window.innerHeight, 99, farClipLook);
    podsEyeDeroCamera.layers.disable(LAYER.MAIN)
    podsEyeDeroCamera.layers.disable(LAYER.HELPERS)

    podsEyeDeroCamera.layers.enable(LAYER.podsEye)
    podsEyeDeroCamera.lookAt(new Vector3(0, 0, -1));

    let podsEyeDeroCameraNode = new CNodeCamera({id:"podsEyeDeroCamera", camera: podsEyeDeroCamera})

    new CNodeView3D({
        id: "podsEyeViewDero",
        visible: false,
        left: 0.52656, top: 0.52425, width: -1, height: 0.46749,
        background: new Color().setRGB(0.0, 0.0, 0.0),
        up: [0, 1, 0],
        fov: 10,
        draggable: true,
        resizable: true,
        camera: podsEyeDeroCameraNode,
        preRenderFunction: function () {
            if (!Ball) return;
            if (this.camera.parent === null) {
                // PROBLEM, MAYBE - the ball has scale.

                Ball.add(this.camera)
            }

            if (Sit.showGlare) {
                glareSprite.scale.setScalar(0.04)
                glareSprite.material.rotation = radians(-par.podRollPhysical + par.glareStartAngle)
            }

            this.camera.up = V3(Ball.matrixWorld.elements[4],
                Ball.matrixWorld.elements[5],
                Ball.matrixWorld.elements[6])

            const worldTarget = V3(0, 0, 0)
            targetSphere.getWorldPosition(worldTarget)
            this.camera.lookAt(worldTarget)

            this.camera.rotateZ(radians(par.podRollPhysical))
        },

        postRenderFunction: function () {

            if (Sit.showGlare) {
                glareSprite.material.rotation = 0
            }
        },
    })


/////////////////////////////////////////////////////////////////
// ATRLIR pod CAM

    VG("lookView").preRenderFunction = function () {

        // PATCH for the jet sitches,
        // camera is a child of the ball, and will get the layer mask reset when the model loads
        // so we force it here.
        this.camera.layers.mask = LAYER.MASK_LOOKRENDER;

        if (!Ball) return;
        
        if (this.camera.parent === Ball) {
            Ball.remove(this.camera)
        }
        
        PodFrame.updateMatrixWorld(true)
        Ball.updateMatrixWorld(true)
        
        const ballWorldPos = V3(0, 0, 0)
        Ball.getWorldPosition(ballWorldPos)
        this.camera.position.copy(ballWorldPos)

        this.camera.up = V3(Ball.matrixWorld.elements[4],
            Ball.matrixWorld.elements[5],
            Ball.matrixWorld.elements[6])

        const worldTarget = V3(0, 0, 0)
        targetSphere.getWorldPosition(worldTarget)
        this.camera.lookAt(worldTarget)

        const deroNeeded = getDeroFromFrame(par.frame)

//                console.log(deroNeeded + " -> " + par.podRollPhysical)

        this.camera.rotateZ(radians(deroNeeded))
        if (Sit.showGlare) {
            glareSprite.scale.setScalar(0.0005)
            glareSprite.material.rotation = radians(-deroNeeded + par.glareStartAngle)
        }
    }

    VG("lookView").postRenderFunction = function () {

        // re-attach to Ball for legacy reasons
        if (this.camera.parent === null && Ball) {
            Ball.add(this.camera)
            // normalize the camera position to be local to the ball
            const localPos = V3(0, 0, 0)
            this.camera.getWorldPosition(localPos)
            this.camera.position.copy(localPos)
            // reset rotation
            this.camera.rotation.set(0, 0, 0)
            // scale
            this.camera.scale.set(1, 1, 1)
        }



        if (Sit.showGlare) {
            glareSprite.material.rotation = 0
        }
    }


    VG("lookView").setVisible(par.showLookCam);


    console.table(ViewMan.list)
}

export function initJetStuffOverlays() {
    let ui = new CNodeATFLIRUI({
        id: "dero",
        jetAltitude: "jetAltitude",
        overlayView: ViewMan.list.podsEyeViewDero.data,
        defaultFontSize: 3.5,
        defaultFontColor: '#E0E0E0',
        defaultFont: 'sans-serif',
        syncVideoZoom: true,
    });
    ui.addText("info", "Derotated", 50, 90, 6, "#FFFF00")

    ui = new CNodeATFLIRUI({
        id: "ATFLIRUIOverlay",
        jetAltitude: "jetAltitude",

        overlayView: ViewMan.list.lookView.data,
        defaultFontSize: 3.5,
        defaultFontColor: '#E0E0E0',
        defaultFont: 'sans-serif',
        syncVideoZoom: true,
    });
    ui.addText("info", "NAR Cam", 50, 90, 6, "#FFFF00")
    ViewMan.get("ATFLIRUIOverlay").setVisible(par.showLookCam);
}
