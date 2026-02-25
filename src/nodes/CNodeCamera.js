import {Camera, PerspectiveCamera, Vector3} from "three";
import {f2m, m2f} from "../utils";
import {GlobalDateTimeNode, guiMenus, NodeMan, Sit} from "../Globals";
import {EUSToLLA, LLAToEUS, LLAVToEUS} from "../LLA-ECEF-ENU";
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

export class CNodeCamera extends CNode3D {
    constructor(v, camera = null) {
        super(v);

        this.isCamera = true;
        
        this.addInput("altAdjust", "altAdjust", true);

        this.startPos = v.startPos;
        this.lookAt = v.lookAt;
        this.startPosLLA = v.startPosLLA;
        this.lookAtLLA = v.lookAtLLA;

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
            guiMenus.view.add(this, "snapshotCamera").name("Snapshot Camera")
                .tooltip("Save the current camera position and heading for use with 'Reset Camera'")
            guiMenus.view.add(this, "resetCamera").name("Reset Camera")
                .tooltip("Reset the camera to the default, or to .last snapshot position and heading\nAlso Numpad-.")
        }

        this.applyEarlyMods();
    }



    modSerialize() {
        this.camera.updateMatrixWorld();
        const p = this.camera.position.clone()
        const v = new Vector3();
        v.setFromMatrixColumn(this.camera.matrixWorld,2);
        v.multiplyScalar(-1000)
        v.add(p)
        const posLLA = EUSToLLA(this.camera.position)
        const atLLA = EUSToLLA(v)
        const upLLA = EUSToLLA(this.camera.position.clone().add(this.camera.up.clone().multiplyScalar(1000)))

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
            this._object.position.copy(LLAVToEUS(MV3(this.startPosLLA)));
        }

        // If no explicit position was set, default to the surface at Sit origin.
        // In ECEF-based EUS this prevents the camera from being at (0,0,0) = Earth's center.
        if (this.startPos === undefined && this.startPosLLA === undefined && Sit.lat !== undefined) {
            this._object.position.copy(LLAToEUS(Sit.lat, Sit.lon, 0));
        }

        if (this.upLLA !== undefined) {
            const upWorld = LLAVToEUS(MV3(this.upLLA));
            this._object.up.copy(upWorld.sub(this._object.position).normalize());
        } else {
            const localUp = getLocalUpVector(this._object.position);
            this._object.up.copy(localUp);
        }

        if (this.lookAt !== undefined) {
            this._object.lookAt(MV3(this.lookAt));
        }

        if (this.lookAtLLA !== undefined) {
            this._object.lookAt(LLAVToEUS(MV3(this.lookAtLLA)));
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
        this.startPosLLA = EUSToLLA(this.camera.position)
        this.lookAtLLA = EUSToLLA(v)
        this.upLLA = EUSToLLA(this.camera.position.clone().add(this.camera.up.clone().multiplyScalar(1000)))
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

    }


    updateUIPosition() {
        // propagate the camera position values value to the camera position UI (if there is one)
        if (NodeMan.exists("cameraLat")) {
            const LLA = EUSToLLA(this.camera.position)
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

    setFromDirection(dir) {
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
            ptzController.recalculateCascade();
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
            return;
        }
        this.setFromDirection(dir);
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



