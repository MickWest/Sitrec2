import {Camera, PerspectiveCamera, Raycaster, Vector3} from "three";
import {f2m, m2f} from "../utils";
import {GlobalDateTimeNode, guiMenus, NodeMan, setRenderOne, Sit} from "../Globals";
import {ECEFToLLAVD_radii, LLAToECEF, LLAVToECEF} from "../LLA-ECEF-ENU";
import {
    altitudeAboveSphere,
    getAzElFromPositionAndForward,
    getLocalSouthVector,
    getLocalUpVector,
    raisePoint
} from "../SphericalMath";
import {CNode3D} from "./CNode3D";
import {MV3} from "../threeUtils";
import {getCelestialDirection, getCelestialDirectionFromRaDec} from "../CelestialMath";
import {t} from "../i18n";
import {raycastLocalGround} from "../raycastGround";

export class CNodeCamera extends CNode3D {
    constructor(v, camera = null) {
        super(v);

        this.isCamera = true;
        this.celestialLock = null; // {type:"named", object:"Moon"} or {type:"radec", ra:hours, dec:degrees}

        this.addInput("altAdjust", "altAdjust", true);

        this.startPos = v.startPos;
        this.lookAt = v.lookAt;
        this.startPosLLA = v.startPosLLA;
        this.lookAtLLA = v.lookAtLLA;
        this.switchToGroundTrackFrame = v.switchToGroundTrackFrame ?? 0;
        if (v.switchToGroundTrackEnabled && this.switchToGroundTrackFrame <= 0) {
            this.switchToGroundTrackFrame = 1;
        }
        this._groundTrackSwitchComputing = false;
        this._groundTrackSwitchRaycaster = new Raycaster();
        this._groundTrackSwitchWarned = false;
        this._groundTrackSwitchCachedFrame = null;
        this._groundTrackSwitchCachedTarget = null;
        this.addSimpleSerial("switchToGroundTrackFrame");
        this.onTerrainLoaded(() => this.clearGroundTrackSwitchCache());

        if (camera) {
            this._object = camera;
        } else {
            this._object = new PerspectiveCamera(v.fov, v.aspect, v.near, v.far);
        }

        if (v.layers !== undefined) {
            this._object.layers.mask = v.layers;
        }

//        console.log("🎥🎥🎥 " + this.id + " CREATE CAMERA " + this.id);

        this.resetCamera()

        if (this.id === "mainCamera") {
            guiMenus.view.add(this, "snapshotCamera").name(t("misc.snapshotCamera.label"))
                .tooltip(t("misc.snapshotCamera.tooltip"))
            guiMenus.view.add(this, "resetCamera").name(t("misc.resetCamera.label"))
                .tooltip(t("misc.resetCamera.tooltip"))
        }

        this.applyEarlyMods();

        if (this.id === "lookCamera") {
            this.addGroundTrackSwitchGUI();
        }
    }



    modSerialize() {
        this.camera.updateMatrixWorld();
        const p = this.camera.position.clone()
        const v = new Vector3();
        v.setFromMatrixColumn(this.camera.matrixWorld,2);
        v.multiplyScalar(-1000)
        v.add(p)
        const posLLA = ECEFToLLAVD_radii(this.camera.position)
        const atLLA = ECEFToLLAVD_radii(v)
        const upLLA = ECEFToLLAVD_radii(this.camera.position.clone().add(this.camera.up.clone().multiplyScalar(1000)))

        return {
            ...super.modSerialize(),
            startPosLLA: [posLLA.x, posLLA.y, posLLA.z],
            lookAtLLA: [atLLA.x, atLLA.y, atLLA.z],
            upLLA: [upLLA.x, upLLA.y, upLLA.z],
            fov: this.camera.fov,
        }
    }

    modDeserialize(v) {
        super.modDeserialize(v);
        this.startPosLLA = v.startPosLLA;
        this.lookAtLLA = v.lookAtLLA;
        this.upLLA = v.upLLA;
        this.camera.fov = v.fov;

        this.resetCamera()
    }

    // when a camera object is treated like a track
    // it can only return the current position
    // so if you want to get the position at a specific frame
    // you need to use a CNodeTrack object or similar
    getValueFrame(f) {
        return this._object.position;
    }

    resetCamera() {

        if (this.startPos !== undefined) {
            this._object.position.copy(MV3(this.startPos));
        }

        if (this.startPosLLA !== undefined) {
            this._object.position.copy(LLAVToECEF(MV3(this.startPosLLA)));
        }

        // If no explicit position was set, default to the surface at Sit origin.
        // In ECEF this prevents the camera from being at (0,0,0) = Earth's center.
        if (this.startPos === undefined && this.startPosLLA === undefined && Sit.lat !== undefined) {
            this._object.position.copy(LLAToECEF(Sit.lat, Sit.lon, 0));
        }

        if (this.upLLA !== undefined) {
            const upWorld = LLAVToECEF(MV3(this.upLLA));
            this._object.up.copy(upWorld.sub(this._object.position).normalize());
        } else {
            const localUp = getLocalUpVector(this._object.position);
            this._object.up.copy(localUp);
        }

        if (this.lookAt !== undefined) {
            this._object.lookAt(MV3(this.lookAt));
        }

        if (this.lookAtLLA !== undefined) {
            this._object.lookAt(LLAVToECEF(MV3(this.lookAtLLA)));
        }

        this.camera.updateMatrix();
        this.camera.updateMatrixWorld();
    }


    snapshotCamera() {
        this.camera.updateMatrixWorld();
        var p = this.camera.position.clone()
        const v = new Vector3();
        v.setFromMatrixColumn(this.camera.matrixWorld,2);
        v.multiplyScalar(-1000)
        v.add(p)
        this.startPosLLA = ECEFToLLAVD_radii(this.camera.position)
        this.lookAtLLA = ECEFToLLAVD_radii(v)
        this.upLLA = ECEFToLLAVD_radii(this.camera.position.clone().add(this.camera.up.clone().multiplyScalar(1000)))
    }

    addGroundTrackSwitchGUI() {
        // Lives in Camera ▸ Camera Tweaks (falls back to the Camera menu itself if
        // that permanent shell isn't present, e.g. on cut-down menu setups).
        const menu = guiMenus.cameraTweaks ?? guiMenus.camera;
        if (!menu) return;

        const controller = menu.add(
            this,
            "switchToGroundTrackFrame",
            0,
            Math.max(0, (Sit.frames ?? 1) - 1),
            1
        )
            .name("Switch to Ground Track at")
            .listen()
            .onChange(() => {
                this.switchToGroundTrackFrame = Math.round(this.switchToGroundTrackFrame);
                this.clearGroundTrackSwitchCache();
                setRenderOne(true);
            })
            .tooltip("0 disables this. Any positive frame bakes the camera's ground intersection at that frame, then aims at that point for all later frames.")
            .moveToEnd();
        this.groundTrackSwitchFrameController = controller;
        setTimeout(() => controller.moveToEnd(), 0);
    }

    clearGroundTrackSwitchCache() {
        this._groundTrackSwitchCachedFrame = null;
        this._groundTrackSwitchCachedTarget = null;
        this._groundTrackSwitchWarned = false;
    }



    get camera() {
        return this._object
    }

    update(f) {
        super.update(f);

        if (this.in.altAdjust !== undefined) {
            // raise or lower the position
            this.camera.position.copy(raisePoint(this.camera.position, f2m(this.in.altAdjust.v())))
        }

        // Celestial lock: update PTZ angles to track the locked object.
        // We ONLY set ptzController.az/el here — we do NOT call setFromDirection()
        // or camera.lookAt(), because CNodeLOSFromCamera calls cameraNode.update()
        // from within getValueFrame(), causing infinite recursion if we modify the
        // camera or trigger any node evaluation from here.
        if (this.celestialLock) {
            let dir = null;
            if (this.celestialLock.type === "named") {
                dir = getCelestialDirection(this.celestialLock.object, GlobalDateTimeNode.dateNow);
            } else if (this.celestialLock.type === "radec") {
                const raRad = this.celestialLock.ra * (Math.PI / 12);
                const decRad = this.celestialLock.dec * (Math.PI / 180);
                dir = getCelestialDirectionFromRaDec(raRad, decRad, GlobalDateTimeNode.dateNow);
            }
            if (dir) {
                // Compute az/el from the celestial direction without modifying the camera
                const fakeTarget = this.camera.position.clone().add(dir.multiplyScalar(1000));
                const toTarget = fakeTarget.clone().sub(this.camera.position).normalize();
                const [az, el] = getAzElFromPositionAndForward(this.camera.position, toTarget);
                const ptzController = NodeMan.get("ptzAngles", false);
                if (ptzController) {
                    ptzController.az = az;
                    ptzController.el = el;
                }
            }
        }

        this.updateGroundTrackSwitchFrameRange();
        this.applyGroundTrackSwitch(f);
    }

    updateGroundTrackSwitchFrameRange() {
        const controller = this.groundTrackSwitchFrameController;
        if (!controller || Sit.frames === undefined) return;

        const maxFrame = Math.max(0, Sit.frames - 1);
        if (controller._max !== maxFrame) {
            controller._max = maxFrame;
            // Do NOT clamp this.switchToGroundTrackFrame here. Sit.frames can
            // transiently shrink during load (e.g. before the video decode
            // reports its final frame count), and overwriting the stored value
            // would permanently destroy the user's setting — which then gets
            // serialized as the clamped value (typically 0). The stored
            // property is the user's intent; it is clamped safely at use-time
            // in getGroundTrackSwitchFrame(). Only the GUI display range updates.
            controller.updateDisplay();
        }
    }

    getGroundTrackSwitchFrame() {
        return Math.max(0, Math.min(Math.round(this.switchToGroundTrackFrame), Math.max(0, (Sit.frames ?? 1) - 1)));
    }

    applyGroundTrackSwitch(f) {
        if (this._groundTrackSwitchComputing) return;

        const switchFrame = this.getGroundTrackSwitchFrame();
        if (switchFrame <= 0 || f < switchFrame) return;

        const target = this.getGroundTrackSwitchTarget(switchFrame);
        if (!target) return;

        this.camera.up.copy(this.getUpVector(this.camera.position));
        this.camera.lookAt(target);
        this.camera.updateMatrix();
        this.camera.updateMatrixWorld(true);
    }

    getGroundTrackSwitchTarget(switchFrame) {
        if (this._groundTrackSwitchCachedFrame === switchFrame) {
            return this._groundTrackSwitchCachedTarget?.clone() ?? null;
        }

        const camera = this.camera;
        const savedPosition = camera.position.clone();
        const savedQuaternion = camera.quaternion.clone();
        const savedUp = camera.up.clone();
        const savedFov = camera.fov;
        const savedNear = camera.near;
        const savedFar = camera.far;

        this._groundTrackSwitchComputing = true;
        try {
            this.applyControllers(switchFrame);
            if (this.in.altAdjust !== undefined) {
                camera.position.copy(raisePoint(camera.position, f2m(this.in.altAdjust.v())));
            }

            camera.updateMatrix();
            camera.updateMatrixWorld(true);

            this._groundTrackSwitchRaycaster.ray.origin.copy(camera.position);
            camera.getWorldDirection(this._groundTrackSwitchRaycaster.ray.direction);
            this._groundTrackSwitchRaycaster.near = 0;
            this._groundTrackSwitchRaycaster.far = Infinity;

            const hit = raycastLocalGround(this._groundTrackSwitchRaycaster);
            if (!hit && !this._groundTrackSwitchWarned) {
                console.warn(`Camera ground track switch could not find a ground intersection at frame ${switchFrame}.`);
                this._groundTrackSwitchWarned = true;
            }
            this._groundTrackSwitchCachedFrame = switchFrame;
            this._groundTrackSwitchCachedTarget = hit?.point.clone() ?? null;
            return this._groundTrackSwitchCachedTarget?.clone() ?? null;
        } finally {
            camera.position.copy(savedPosition);
            camera.quaternion.copy(savedQuaternion);
            camera.up.copy(savedUp);
            camera.fov = savedFov;
            camera.near = savedNear;
            camera.far = savedFar;
            camera.updateProjectionMatrix();
            camera.updateMatrix();
            camera.updateMatrixWorld(true);
            this.syncUIPosition();
            this._groundTrackSwitchComputing = false;
        }
    }

    // The "Camera Heading" switch and its "Celestial Lock" controller, if this
    // sitch has them (the custom sitch does, built in CustomManagerSetup). When
    // present we drive the lock through that menu mechanism so the GUI ("Camera
    // Heading" → Celestial Lock) reflects reality, instead of the standalone
    // ptzAngles hack below — which silently stayed on "Use Angles".
    celestialMenu() {
        const sw = NodeMan.get("CameraLOSController", false);
        const controller = NodeMan.get("celestialController", false);
        if (sw && controller && sw.inputs["Celestial Lock"] === controller) {
            return { sw, controller };
        }
        return null;
    }

    lockOnObject(objectName) {
        const dir = getCelestialDirection(objectName, GlobalDateTimeNode.dateNow);
        if (!dir) return false;
        const menu = this.celestialMenu();
        if (menu) {
            this.celestialLock = null;
            menu.controller.setLockObject(objectName);
            menu.sw.selectOption("Celestial Lock");
        } else {
            // Fallback for sitches without the menu: drive PTZ angles each frame.
            this.celestialLock = { type: "named", object: objectName };
            this.setFromDirection(dir, true);
        }
        return true;
    }

    lockOnRaDec(ra, dec) {
        const menu = this.celestialMenu();
        if (menu) {
            this.celestialLock = null;
            menu.controller.setLockRaDec(ra, dec);
            menu.sw.selectOption("Celestial Lock");
        } else {
            this.celestialLock = { type: "radec", ra, dec };
            const raRad = ra * (Math.PI / 12);
            const decRad = dec * (Math.PI / 180);
            const dir = getCelestialDirectionFromRaDec(raRad, decRad, GlobalDateTimeNode.dateNow);
            this.setFromDirection(dir, true);
        }
        return true;
    }

    unlockCelestial() {
        this.celestialLock = null;
        const menu = this.celestialMenu();
        if (menu && menu.sw.choice === "Celestial Lock") {
            // Leave the camera pointing where it is, on the manual-angle path.
            menu.sw.selectOption("Use Angles");
        }
    }


    updateUIPosition() {
        // propagate the camera position values value to the camera position UI (if there is one)
        if (NodeMan.exists("cameraLat")) {
            const LLA = ECEFToLLAVD_radii(this.camera.position)
            NodeMan.get("cameraLat").value = LLA.x
            NodeMan.get("cameraLon").value = LLA.y
            NodeMan.get("cameraAlt").value = m2f(LLA.z)
        }
    }


    syncUIPosition() {
        // propogate the camera position values value to the camera position UI (if there is one)
        // and then recalculate dependent nodes
        if (NodeMan.exists("cameraLat")) {
            this.updateUIPosition();

            // we should not even need this, UI changes will trigger a recalculation cascade
            // if they change
            //    NodeMan.get("cameraLat").recalculateCascade() // manual update
        }
    }


    goToPoint(point, above = 200, back = 20) {
        const altitude = altitudeAboveSphere(point);
        console.log("🎥🎥🎥 goToPoint altitude = " + altitude)


        // get the local up vector at the track point
        const up = getLocalUpVector(point);
        // and south vector
        const south = getLocalSouthVector(point);
        // make a point 200m above, and 20m south
        const newCameraPos = point.clone().add(up.clone().multiplyScalar(above)).add(south.clone().multiplyScalar(back));

        const newCameraPosAltitude = altitudeAboveSphere(newCameraPos);
        console.log("🎥🎥🎥 newCameraPos altitude = " + newCameraPosAltitude)

        // set the position to the target
        this.camera.position.copy(newCameraPos);
        // Set up to local up
        this.camera.up.copy(up);
        // and look at the target point
        this.camera.lookAt(point);
        this.camera.updateMatrixWorld(true);

        if (NodeMan.exists("terrainUI")) {
            NodeMan.get("terrainUI").requestSubdivisionPass();
        }

        setRenderOne(true);
    }


    setFromRaDec(ra, dec) {
        // set the camera orientation based on Right Ascension and Declination
        // ra is in hours, dec is in degrees
        // convert ra to radians
        const raRad = ra * (Math.PI / 12); // 1 hour = π/12 radians
        const decRad = dec * (Math.PI / 180); // degrees to radians


        const dateNow = GlobalDateTimeNode.dateNow;

        const dir = getCelestialDirectionFromRaDec(raRad, decRad, dateNow);
        this.setFromDirection(dir);

    }

    setFromDirection(dir, fromLock = false) {
        // If this is a manual point-at (not from the lock update loop), clear any active lock
        if (!fromLock) {
            this.celestialLock = null;
            // If a menu-driven Celestial Lock is active, drop back to "Use Angles"
            // so this one-shot point actually holds (otherwise the lock controller
            // would re-point the camera on the next frame).
            const menu = this.celestialMenu();
            if (menu && menu.sw.choice === "Celestial Lock") {
                menu.sw.selectOption("Use Angles");
            }
        }

        const target = this.camera.position.clone().add(dir.multiplyScalar(1000)); // 1000m away in the direction of the celestial body
        this.camera.lookAt(target);
        this.camera.updateMatrixWorld();

        // FIXED: Use camera.getWorldDirection() which correctly negates Z for cameras
        const fwd = new Vector3();
        this.camera.getWorldDirection(fwd);
        const [az, el] = getAzElFromPositionAndForward(this.camera.position, fwd);

        // get the PTZ Controller and set the az/el
        const ptzController = NodeMan.get("ptzAngles", false);
        if (ptzController) {
            ptzController.az = az;
            ptzController.el = el;
            // Only cascade for one-shot pointing (user/API action).
            // During the per-frame lock update, the PTZ controller's apply()
            // will read these values naturally — cascading here would cause
            // infinite recursion via dependent nodes (e.g. CNodeLOSFromCamera)
            // that re-evaluate the camera.
            if (!fromLock) {
                ptzController.recalculateCascade();
            }
        } else {
            console.warn("CNodeCamera:setFromRaDec No PTZ Controller found to set az/el for camera " + this.id);
        }
    }

// set the camera orientation based on a named celestial object
    // e.g. "Sun", "Moon", "Mars"
    setFromNamedObject(objectName) {
        const dir = getCelestialDirection(objectName, GlobalDateTimeNode.dateNow);
        if (!dir) {
            console.warn("CNodeCamera:setFromNamedObject No direction found for object " + objectName);
            return false;
        }
        this.setFromDirection(dir);
        return true;
    }


}

// given a camera object that's either:
//  - a Three.js Camera
//  - a CNodeCamera object
//  - the name of a CNodeCamera object
// then return a CNodeCamera object, creating one if needed ot wrap the Camera
export function getCameraNode(cam) {
    var cameraNode;
    if (cam instanceof Camera) {
        // It's a THREE.JS Camaera, so encapsulate it in a CNodeCamera
        cameraNode = new CNodeCamera("cameraNode",cam)
    } else {
        cameraNode = NodeMan.get(cam) // this handles disambiguating Nodes and Node Names.
        //assert(cameraNode instanceof CNodeCamera, "CNodeView3D ("+this.id+") needs a camera node")
    }
    return cameraNode;
}
