// a simple camera track that takes a named camera node and returns position and heading
// using the position and orientation of that camera
// assumes the camera does not move per frame
// but will update based on changed to the camera node
import {PerspectiveCamera, Vector3} from "three";
import {GlobalDateTimeNode, NodeMan, Sit} from "../Globals";
import {CNodeEmptyArray} from "./CNodeArray";
import {assert} from "../assert.js";
import {getAzElFromPositionAndForward} from "../SphericalMath";
import {CNodeLOS} from "./CNodeLOS";
import {ECEFToLLAVD, EUSToECEF, EUSToLLA} from "../LLA-ECEF-ENU";
import {saveAs} from "file-saver";

export class CNodeLOSFromCamera extends CNodeLOS {
    constructor(v) {
        super(v);
        this.input("cameraNode");

        this.useRecorded = v.useRecorded ?? false;

        if (this.frames == 0) {
            this.frames = Sit.frames;
            this.useSitFrames = true;
        }

        // we'll be using a dummy camera to get the position and heading
        this.dummyCamera = new PerspectiveCamera();

        this.exportable = v.exportable ?? false;
        if (this.exportable) {
            NodeMan.addExportButton(this, "exportMISBCompliantCSV")
        }

        NodeMan.addExportButton(this, "exportESP");
    }

    getValueFrame(f) {

        // swap in a dummy camera and update the camera node
        // this seems imperfect, as it does not account for state changes in
        // a camera node that might affect the camera's position
        // I don't think we have any examples of that yet
        // cameras are controlled by controllers
        const cameraNode = this.in.cameraNode
        assert(cameraNode !== undefined, "CNodeLOSFromCamera missing cameraNode input");
        const oldCamera = cameraNode.camera;
        cameraNode._object = this.dummyCamera; // _object is the camera object
        // patch so this does not count as a controller update (recursion check)
        // applyControllersCount will be incremented by the cameraNode.update call
        // (in applyControllers), so will be unchanged after this call
        cameraNode.applyControllersCount--;
        cameraNode.update(f);
        const camera = cameraNode.camera;

        // restore the original camera
        cameraNode._object = oldCamera;

        if (this.useRecorded) {
            return cameraNode.recordedLOS;
        }

        // then extract the position and heading from the dummy camera
        camera.updateMatrixWorld()
        assert(camera !== undefined, "CNodeLOSFromCamera has Missing Camera = " + this.cameraName)
        var position = camera.position.clone()
        if (isNaN(position.x) || isNaN(position.y) || isNaN(position.z)) {
            console.error("CNodeLOSFromCamera: Camera position is NaN after applying controllers, id=" + this.id + ", f=" + f);
            console.error("Camera position:", camera.position);
            console.error("Controllers on cameraNode:", Object.keys(cameraNode.inputs).filter(k => cameraNode.inputs[k].isController));
        }
        if (position.x === 0 && position.y === 0 && position.z === 0) {
            console.warn("CNodeLOSFromCamera: Camera position is at origin (0,0,0), controllers may not have been applied, id=" + this.id + ", f=" + f);
        }
        var fwd = new Vector3();
        fwd.setFromMatrixColumn(camera.matrixWorld, 2);
        // AZELISSUE: CORRECT - manually negating camera's +Z (backward) to get forward vector
        fwd.multiplyScalar(-1)
        // also return the up and right vectors of the camera
        var up = new Vector3();
        up.setFromMatrixColumn(camera.matrixWorld, 1);
        var right = new Vector3();
        right.setFromMatrixColumn(camera.matrixWorld, 0);
        const vFOV = camera.fov;
        if (isNaN(fwd.x) || isNaN(fwd.y) || isNaN(fwd.z)) {
            console.error("CNodeLOSFromCamera: heading (fwd) is NaN, id=" + this.id + ", f=" + f);
            console.error("Camera matrixWorld:", camera.matrixWorld.elements);
            console.error("Camera position:", camera.position);
            console.error("Camera quaternion:", camera.quaternion);
        }
        return {position: position, heading: fwd, up: up, right: right, vFOV: vFOV};
    }

    exportESP(inspect = false) {
        if (inspect) {
            return {
                desc: "[BETA] Google Earth Studio ESP",
            }
        }

        const totalFrames = this.frames;
        if (totalFrames === 0) {
            console.error("No frames available for ESP export");
            return;
        }

        const fps = Sit.fps;
        const totalSeconds = totalFrames / fps;

        // ESP output settings
        const espFPS = 60;
        const espDuration = Math.round(totalSeconds * espFPS);
        const keyframeIntervalSeconds = 5;

        // Get camera aspect ratio for hFOV conversion
        const cameraNode = this.in.cameraNode;
        const aspect = (cameraNode && cameraNode.camera) ? cameraNode.camera.aspect : (1920 / 1080);

        // Collect keyframe data every 5 seconds
        const keyframeData = [];

        const addKeyframe = (sitrecFrame, normalizedTime) => {
            const data = this.getValueFrame(sitrecFrame);
            if (!data || !data.position) return;

            const lla = EUSToLLA(data.position);
            // Also compute ellipsoidal altitude for comparison
            const ecef = EUSToECEF(data.position);
            const llaEllip = ECEFToLLAVD(ecef);
            console.log(`  EUS pos=(${data.position.x.toFixed(1)}, ${data.position.y.toFixed(1)}, ${data.position.z.toFixed(1)}) sphere_alt=${lla.z.toFixed(1)}m ellip_alt=${llaEllip.z.toFixed(1)}m`);
            const [az, el] = getAzElFromPositionAndForward(data.position, data.heading);

            // Convert vertical FOV to horizontal FOV
            const vFovRad = data.vFOV * Math.PI / 180;
            const hFovRad = 2 * Math.atan(Math.tan(vFovRad / 2) * aspect);
            const hFOV = hFovRad * 180 / Math.PI;

            keyframeData.push({
                time: normalizedTime,
                lon: lla.y, lat: lla.x, alt: lla.z,
                heading: az, elevation: el,
                hFOV,
            });
        };

        for (let t = 0; t <= totalSeconds; t += keyframeIntervalSeconds) {
            const sitrecFrame = Math.min(Math.round(t * fps), totalFrames - 1);
            const normalizedTime = Math.min(t / totalSeconds, 1.0);
            addKeyframe(sitrecFrame, normalizedTime);
        }

        // Ensure we have a keyframe at the very end
        const lastKeyframeTime = Math.floor(totalSeconds / keyframeIntervalSeconds) * keyframeIntervalSeconds;
        if (lastKeyframeTime < totalSeconds - 0.1) {
            addKeyframe(totalFrames - 1, 1.0);
        }

        if (keyframeData.length === 0) {
            console.error("No valid keyframe data for ESP export");
            return;
        }

        // ESP normalization constants (matching Google Earth Studio ranges)
        const ALT_MAX = 65117481;
        const ALT_MIN = -500;
        const FOV_MAX = 178; // GES FOV range is 0-178°

        // Log keyframe data for debugging
        console.log("ESP Export keyframes:");
        keyframeData.forEach((kf, i) => {
            const altNorm = (kf.alt - ALT_MIN) / (ALT_MAX - ALT_MIN);
            console.log(`  KF ${i}: t=${kf.time.toFixed(3)} lat=${kf.lat.toFixed(6)} lon=${kf.lon.toFixed(6)} alt=${kf.alt.toFixed(1)}m (norm=${altNorm.toFixed(10)}) heading=${kf.heading.toFixed(1)}° el=${kf.elevation.toFixed(1)}° hFOV=${kf.hFOV.toFixed(1)}°`);
        });

        
        // Build normalized keyframe arrays
        const lonKF = keyframeData.map(kf => ({time: kf.time, value: (kf.lon + 180) / 360}));
        const latKF = keyframeData.map(kf => ({time: kf.time, value: (kf.lat + 90) / 180}));
        const altKF = keyframeData.map(kf => ({time: kf.time, value: (kf.alt - ALT_MIN) / (ALT_MAX - ALT_MIN)}));
        // In ESP: rotationX = Pan (heading), rotationY = Tilt (elevation from nadir)
        const rotXKF = keyframeData.map(kf => ({time: kf.time, value: kf.heading / 360}));
        const rotYKF = keyframeData.map(kf => ({time: kf.time, value: (kf.elevation + 90) / 180}));
        const fovKF = keyframeData.map(kf => ({time: kf.time, value: kf.hFOV / FOV_MAX}));

        // Environment time from simulation date
        let worldTimeMin, worldTimeMax;
        if (GlobalDateTimeNode && GlobalDateTimeNode.dateStart) {
            const startMS = GlobalDateTimeNode.dateStart.valueOf();
            worldTimeMin = startMS - 86400000;
            worldTimeMax = startMS + 86400000;
        } else {
            const now = Date.now();
            worldTimeMin = now - 86400000;
            worldTimeMax = now + 86400000;
        }

        const esp = {
            modelVersion: 18,
            settings: {
                name: Sit.name || "export",
                frameRate: espFPS,
                dimensions: {width: 1920, height: 1080},
                duration: espDuration,
                timeFormat: "frames"
            },
            scenes: [{
                animationModel: {roving: false, logarithmic: false, groupedPosition: true},
                duration: espDuration,
                attributes: [
                    {
                        type: "cameraGroup",
                        inTimeline: true,
                        attributes: [
                            {
                                type: "cameraPositionGroup",
                                inTimeline: true,
                                attributes: [{
                                    type: "position",
                                    inTimeline: true,
                                    attributes: [
                                        {type: "longitude", value: {relative: lonKF[0].value}, keyframes: lonKF, inTimeline: true},
                                        {type: "latitude", value: {relative: latKF[0].value}, keyframes: latKF, inTimeline: true},
                                        {
                                            type: "altitude",
                                            value: {maxValueRange: ALT_MAX, minValueRange: ALT_MIN, relative: altKF[0].value, logarithmic: false},
                                            keyframes: altKF,
                                            inTimeline: true
                                        }
                                    ]
                                }]
                            },
                            {
                                type: "cameraTargetEffect",
                                attributes: [
                                    {type: "enabled", value: {}},
                                    {
                                        type: "poi",
                                        attributes: [
                                            {type: "longitudePOI", value: {}},
                                            {type: "latitudePOI", value: {}},
                                            {type: "altitudePOI", value: {maxValueRange: ALT_MAX, minValueRange: ALT_MIN, logarithmic: false}}
                                        ]
                                    },
                                    {type: "influence", value: {}}
                                ]
                            },
                            {
                                type: "cameraRotationGroup",
                                inTimeline: true,
                                attributes: [
                                    {type: "rotationX", value: {relative: rotXKF[0].value}, keyframes: rotXKF, inTimeline: true},
                                    {type: "rotationY", value: {relative: rotYKF[0].value}, keyframes: rotYKF, inTimeline: true},
                                    {type: "rotationZ", value: {relative: 1}}
                                ]
                            },
                            {
                                type: "cameraLensGroup",
                                inTimeline: true,
                                attributes: [
                                    {type: "fov", value: {}, keyframes: fovKF, inTimeline: true},
                                    {type: "exposure", value: {}},
                                    {type: "aperture", value: {}},
                                    {type: "minFocusLength", value: {}}
                                ]
                            }
                        ]
                    },
                    {
                        type: "environmentGroup",
                        attributes: [
                            {
                                type: "sunGroup",
                                attributes: [
                                    {type: "sunVisibility", value: {}},
                                    {type: "worldTime", value: {relative: 0.5, minValueRange: worldTimeMin, maxValueRange: worldTimeMax}}
                                ]
                            },
                            {
                                type: "cloudGroup",
                                attributes: [
                                    {type: "cloudVisibility", value: {}},
                                    {type: "cloudopacity", value: {}},
                                    {type: "cloudheight", value: {}},
                                    {type: "clouddate", value: {relative: 0.5, minValueRange: worldTimeMin, maxValueRange: worldTimeMax}}
                                ]
                            },
                            {
                                type: "starsPlanetsGroup",
                                attributes: [{type: "starsEnabled", value: {}}]
                            },
                            {
                                type: "seawaterGroup",
                                attributes: [
                                    {type: "seawater", value: {}},
                                    {type: "influence", value: {relative: 1}}
                                ]
                            },
                            {type: "buildingsEnabled", value: {}}
                        ]
                    }
                ],
                cameraExport: {logarithmic: false, modelVersion: 2}
            }],
            playbackManager: {range: {start: 0, end: espDuration}}
        };

        saveAs(new Blob([JSON.stringify(esp)], {type: 'application/json'}), `${Sit.name || 'export'}.esp`);
    }
}


export class CNodeAzFromLOS extends CNodeEmptyArray {
    constructor(v) {
        super(v);
        this.input("LOS");
        this.recalculate()
    }

    recalculate() {
        this.array = [];
        this.frames = this.in.LOS.frames

        for (let f = 0; f < this.frames; f++) {
            const los = this.in.LOS.v(f)
            const start = los.position.clone();
            const heading = los.heading.clone();

            // AZELISSUE: CORRECT - the LOS.heading is already a properly negated forward vector (from line 59)
            const [az, el] = getAzElFromPositionAndForward(start, heading)

            this.array.push(az)
        }
    }

}


export class CNodeElFromLOS extends CNodeEmptyArray {
    constructor(v) {
        super(v);
        this.input("LOS");
        this.recalculate()
    }

    recalculate() {
        this.array = [];
        this.frames = this.in.LOS.frames

        for (let f = 0; f < this.frames; f++) {
            const los = this.in.LOS.v(f)
            const start = los.position.clone();
            const heading = los.heading.clone();

            // AZELISSUE: CORRECT - the LOS.heading is already a properly negated forward vector (from line 59)
            const [az, el] = getAzElFromPositionAndForward(start, heading)

            this.array.push(el)
        }
    }

}
