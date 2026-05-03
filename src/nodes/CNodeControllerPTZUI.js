import {degrees, ExpandKeyframes, radians} from "../utils";
import {RollingAverage} from "../smoothing";
import {
    getAzElFromPositionAndForward,
    getLocalDownVector,
    getLocalNorthVector,
    getLocalUpVector,
    getNorthPole
} from "../SphericalMath";
import {NodeMan, Sit} from "../Globals";

import {CNodeController} from "./CNodeController";
import {V3} from "../threeUtils";
import {assert} from "../assert";
import {Euler, Matrix4, Quaternion, Vector3} from "three";
import {extractFOV} from "./CNodeControllerVarious";
import {t} from "../i18n";

const pszUIColor = "#C0C0FF";
const _xAxis = new Vector3(1, 0, 0);
const _yAxis = new Vector3(0, 1, 0);
const _zAxis = new Vector3(0, 0, 1);

// Generic controller that has azimuth, elevation, and zoom
export class CNodeControllerAzElZoom extends CNodeController {
    _az = 0;
    _el = 0;

    get az() { return this._az; }
    set az(value) {
        assert(!isNaN(value), "CNodeControllerAzElZoom: setting az to NaN, id=" + this.id);
        this._az = value;
    }

    get el() { return this._el; }
    set el(value) {
        assert(!isNaN(value), "CNodeControllerAzElZoom: setting el to NaN, id=" + this.id);
        this._el = value;
    }

    constructor(v) {
        super(v);
    }


    apply(f, objectNode ) {

        // Since we are in ECEF, the origin is at Earth's center
        // we need to get the LOCAL up

        const camera = objectNode.camera

        //  since the user controls roll here, we don't want to use north for up
        var up = getLocalUpVector(camera.position)

        // to get a northish direction we get the vector from here to the north pole.
        var northPoleECEF = getNorthPole()
        var toNorth = northPoleECEF.clone().sub(camera.position).normalize()
        // take only the component perpendicular
        let dot = toNorth.dot(up)
        let north = toNorth.clone().sub(up.clone().multiplyScalar(dot))
        assert(north.lengthSq() >= 1e-10, "CNodeControllerAzElZoom: north vector is zero (at pole?), camera.position=" + camera.position.toArray());
        north.normalize()
        let south = north.clone().negate()
        let east = V3().crossVectors(up, south)

        // length = 100000;
        // DebugArrow("local East",east,camera.position,length,"#FF8080")
        // DebugArrow("local Up",up,camera.position,length,"#80FF90")
        // DebugArrow("local South",south,camera.position,length,"#8080FF")

        var right = east;
        var fwd = north;

        let el = this.el
        let az = this.az
        if (this.relative) {
            // if we are in relative mode, then we just rotate the camera's fwd vector

            const xAxis = new Vector3()
            const yAxis = new Vector3()
            const zAxis = new Vector3()
            camera.updateMatrix();
            camera.updateMatrixWorld()
            camera.matrix.extractBasis(xAxis,yAxis,zAxis)
            fwd = zAxis.clone().negate()

            // project fwd onto the horizontal plane define by up
            // it's only relative to the heading, not the tilt
            let dot = fwd.dot(up)
            fwd = fwd.sub(up.clone().multiplyScalar(dot)).normalize()

            right = fwd.clone().cross(up)



        }


        fwd.applyAxisAngle(right,radians(el))
        fwd.applyAxisAngle(up,-radians(az))
        camera.fov = extractFOV(this.fov);
        assert(!Number.isNaN(camera.fov), "CNodeControllerPTZUI: camera.fov is NaN");
        assert(camera.fov !== undefined && camera.fov>0 && camera.fov <= 180, `bad fov ${camera.fov}` )
        fwd.add(camera.position);
        camera.up = up;
        camera.lookAt(fwd)
        if (this.roll !== undefined ) {
            camera.rotateZ(radians(this.roll))
        }

    }


}


// UI based version of this, PTZ = Az, El, Zoom, and have constants defined by the gui
export class CNodeControllerPTZUI extends CNodeControllerAzElZoom {
    constructor(v) {
        super(v);
        assert(v.az !== undefined, "CNodeControllerPTZUI: initial az is undefined")
        assert(v.el !== undefined, "CNodeControllerPTZUI: initial el is undefined")
        this.az = v.az;
        this.el = v.el
        this.fov = v.fov
        this.roll = v.roll
        this.xOffset = v.xOffset ?? 0;
        this.yOffset = v.yOffset ?? 0;
        this.nearPlane = v.nearPlane ?? 0.1;
        this.relative = false;
        this.satellite = v.satellite ?? false;
        this.rotation = v.rotation ?? 0; // screen-space rotation around camera look axis (satellite mode only)
        this.satQuat = new Quaternion(); // satellite mode orientation (relative to nadir frame)
        this._satQuatDirty = true;       // rebuild from angles on next applySatellite

        assert(v.fov !== undefined, "CNodeControllerPTZUI: initial fov is undefined")

        if (v.showGUI) {

            this.setGUI(v,"camera");
            const guiPTZ = this.gui;

            this.azController = guiPTZ.add(this, "az", -180, 180, 0.01, false).listen().name(t("ptzUI.panAz.label")).tooltip(t("ptzUI.panAz.tooltip")).onChange(v => this.refresh()).setLabelColor(pszUIColor).wrap()
            this.elController = guiPTZ.add(this, "el", -89, 89, 0.01, false).listen().name(t("ptzUI.tiltEl.label")).tooltip(t("ptzUI.tiltEl.tooltip")).onChange(v => this.refresh()).setLabelColor(pszUIColor)
            if (this.fov !== undefined) {
                guiPTZ.add(this, "fov", 0.0001, 170, 0.01, false).listen().name(t("ptzUI.zoomFov.label")).tooltip(t("ptzUI.zoomFov.tooltip")).onChange(v => {
                    this.refresh()
                }).setLabelColor(pszUIColor) // .elastic(0.0001, 170)
            }
            if (this.roll !== undefined ) {
                this.rollController = guiPTZ.add(this, "roll", -180, 180, 0.005).listen().name(t("ptzUI.roll.label")).tooltip(t("ptzUI.roll.tooltip")).onChange(v => this.refresh()).setLabelColor(pszUIColor)
            }
            guiPTZ.add(this, "xOffset", -20, 20, 0.001).listen().name(t("ptzUI.xOffset.label")).tooltip(t("ptzUI.xOffset.tooltip")).onChange(v => this.refresh()).setLabelColor(pszUIColor)
            guiPTZ.add(this, "yOffset", -20, 20, 0.001).listen().name(t("ptzUI.yOffset.label")).tooltip(t("ptzUI.yOffset.tooltip")).onChange(v => this.refresh()).setLabelColor(pszUIColor)
            guiPTZ.add(this, "nearPlane", 0.001, 1, 0.001).listen().name(t("ptzUI.nearPlane.label")).tooltip(t("ptzUI.nearPlane.tooltip")).onChange(v => this.refresh()).setLabelColor(pszUIColor)
            guiPTZ.add(this, "relative").listen().name(t("ptzUI.relative.label")).tooltip(t("ptzUI.relative.tooltip")).onChange(v => this.refresh())
            guiPTZ.add(this, "satellite").listen().name(t("ptzUI.satellite.label")).tooltip(t("ptzUI.satellite.tooltip")).onChange(v => {
                this.syncModeTransition();
            }).setLabelColor(pszUIColor)
            this.rotationController = guiPTZ.add(this, "rotation", -180, 180, 0.1).listen().name(t("ptzUI.rotation.label")).tooltip(t("ptzUI.rotation.tooltip")).onChange(v => this.refresh()).setLabelColor(pszUIColor)

            if (this.satellite) {
                this.updateSatelliteSliderRanges();
            }
            this.updateSatelliteSliderVisibility();
        }
       // this.refresh()
    }

    modSerialize() {
        return {
            ...super.modSerialize(),
            az: this.az,
            el: this.el,
            fov: this.fov,
            roll: this.roll,
            xOffset: this.xOffset,
            yOffset: this.yOffset,
            nearPlane: this.nearPlane,
            relative: this.relative,
            satellite: this.satellite,
            rotation: this.rotation,
        }
    }

    modDeserialize(v) {
        super.modDeserialize(v);
        assert(v.az !== undefined, "CNodeControllerPTZUI.modDeserialize: az is undefined");
        assert(v.el !== undefined, "CNodeControllerPTZUI.modDeserialize: el is undefined");
        this.az = v.az;
        this.el = v.el;
        this.fov = v.fov;
        this.roll = v.roll;
        this.xOffset = v.xOffset ?? 0;
        this.yOffset = v.yOffset ?? 0;
        this.nearPlane = v.nearPlane ?? 0.1;
        this.relative = v.relative ?? false;
        this.satellite = v.satellite ?? false;
        this.rotation = v.rotation ?? 0;
        this.updateSatelliteSliderVisibility();
    }

    // Note this has to be in apply, not update, as there are update orders issues
    apply(f, objectNode ) {

        // check if the switch node fovSwitch is present
        // and if set to somthing other than userFOV
        // if so, we use that

        const fovSwitch = NodeMan.get("fovSwitch",false)
        if (fovSwitch) {
            this.fov = extractFOV(fovSwitch.getValue(f));
        }

        if (this.satellite) {
            this.applySatellite(objectNode);
        } else {
            super.apply(f, objectNode);
        }

        const camera = objectNode.camera;
        camera.near = this.nearPlane;
        camera.updateProjectionMatrix();
    }

    // Satellite mode: quaternion-based orientation, no gimbal lock.
    //
    // The camera orientation is stored as a quaternion (satQuat) relative to a
    // "nadir frame" defined by the camera's position on the Earth:
    //   nadir frame: camera X = east, Y = north, Z = up (looking down along -Z)
    //
    // satQuat encodes intrinsic ZXY Euler rotations:
    //   Z = roll (heading — which world direction is "up" on screen)
    //   X = pitch (tilt from nadir: 0° = nadir, 90° = horizon)
    //   Y = yaw (horizontal pan)
    //
    // Mouse drag applies incremental rotations in camera-local space:
    //   horizontal drag → rotate around camera Y (up on screen)
    //   vertical drag   → rotate around camera X (right on screen)
    // This always produces correct screen-space motion at any orientation.

    // Build the nadir-frame quaternion from the camera's position.
    // Nadir frame: X=east, Y=north, Z=up → camera looks along -Z = down.
    _buildNadirQuat(cameraPosition) {
        const up = getLocalUpVector(cameraPosition);
        const northPoleECEF = getNorthPole();
        const toNorth = northPoleECEF.clone().sub(cameraPosition).normalize();
        const north = toNorth.clone().sub(up.clone().multiplyScalar(toNorth.dot(up)));
        assert(north.lengthSq() >= 1e-10, "applySatellite: north vector is zero (at pole?)");
        north.normalize();
        const east = new Vector3().crossVectors(north, up).normalize();

        const m = new Matrix4().makeBasis(east, north, up);
        return new Quaternion().setFromRotationMatrix(m);
    }

    // Construct satQuat from the current (roll, el, az, rotation) slider values.
    // Euler order ZXY: Z=roll, X=pitch(90+el), Y=yaw(-az),
    // then a final Z rotation for screen-space spin around the look axis.
    // Baking rotation into satQuat ensures mouse drags stay screen-aligned.
    buildSatQuatFromAngles() {
        const euler = new Euler(
            radians(90 + this.el),   // X: pitch from nadir (0 at nadir, 90 at horizon)
            radians(-this.az),       // Y: yaw
            radians(this.roll),      // Z: roll / heading
            'ZXY'
        );
        this.satQuat.setFromEuler(euler);
        if (this.rotation !== 0) {
            const spin = new Quaternion().setFromAxisAngle(_zAxis, radians(this.rotation));
            this.satQuat.multiply(spin);
        }
        this._satQuatDirty = false;
    }

    // Decompose satQuat back to (roll, el, az, rotation) for slider display.
    // Strips the known screen rotation from satQuat before extracting ZXY euler.
    extractAnglesFromSatQuat() {
        let q = this.satQuat;
        if (this.rotation !== 0) {
            // Remove the baked-in screen rotation to get the base orientation
            const invSpin = new Quaternion().setFromAxisAngle(_zAxis, -radians(this.rotation));
            q = q.clone().multiply(invSpin);
        }
        const euler = new Euler().setFromQuaternion(q, 'ZXY');
        this.roll = degrees(euler.z);
        this.el = degrees(euler.x) - 90;
        this.az = -degrees(euler.y);
    }

    // Apply incremental mouse drag as camera-local rotations.
    applySatelliteMouseDelta(xRotate, yRotate) {
        if (this._satQuatDirty) {
            this.buildSatQuatFromAngles();
        }

        const fovScale = this.fov / 45;

        // Horizontal drag: rotate around camera's local Y (screen-up)
        if (Math.abs(xRotate) > 1e-10) {
            const yaw = new Quaternion().setFromAxisAngle(_yAxis, xRotate * fovScale);
            this.satQuat.multiply(yaw);
        }

        // Vertical drag: rotate around camera's local X (screen-right)
        if (Math.abs(yRotate) > 1e-10) {
            const pitch = new Quaternion().setFromAxisAngle(_xAxis, yRotate * fovScale);
            this.satQuat.multiply(pitch);
        }

        this.satQuat.normalize();
        this.extractAnglesFromSatQuat();
        this._satQuatDirty = false;
        this.recalculateCascade();
    }

    applySatellite(objectNode) {
        const camera = objectNode.camera;

        if (this._satQuatDirty) {
            this.buildSatQuatFromAngles();
        }

        // Final camera orientation = nadirFrame * satQuat
        // (rotation is already baked into satQuat)
        const nadirQuat = this._buildNadirQuat(camera.position);
        camera.quaternion.copy(nadirQuat).multiply(this.satQuat);

        // Apply FOV
        camera.fov = extractFOV(this.fov);
        assert(!Number.isNaN(camera.fov), "applySatellite: camera.fov is NaN");
        assert(camera.fov > 0 && camera.fov <= 180, `applySatellite: bad fov ${camera.fov}`);
    }

    updateSatelliteSliderRanges() {
        if (this.elController) {
            if (this.satellite) {
                // Free look: -270 to +90 covers full sphere.
                // -90 = nadir, 0 = heading horizon, +90 = zenith,
                // -180 = back horizon, -270 = zenith (from below)
                this.elController.min(-270).max(90);
            } else {
                this.el = Math.max(-89, Math.min(89, this.el));
                this.elController.min(-89).max(89);
            }
            this.elController.updateDisplay();
        }
    }

    // Seamless mode switch: capture the current camera orientation and decompose it
    // into the new mode's parameters so the view doesn't jump.
    syncModeTransition() {
        const camNode = this.outputs.find(o => o.isCamera) ?? NodeMan.get("lookCamera", false);
        const camera = camNode?.camera;
        if (camera) {
            camera.updateMatrixWorld();
            if (this.satellite) {
                // Switching TO satellite mode.
                // Derive satQuat from current camera orientation: satQuat = nadirQuat^-1 * cameraQuat
                const nadirQuat = this._buildNadirQuat(camera.position);
                this.satQuat.copy(nadirQuat).invert().multiply(camera.quaternion);
                this.satQuat.normalize();
                // Extract roll/el/az with rotation=0 first, then no residual rotation
                this.rotation = 0;
                this.extractAnglesFromSatQuat();
                this._satQuatDirty = false;
            } else {
                // Switching FROM satellite mode back to normal.
                // Extract az/el/roll from the current camera direction.
                const fwd = new Vector3();
                camera.getWorldDirection(fwd);
                const localUp = getLocalUpVector(camera.position);

                let [az, el] = getAzElFromPositionAndForward(camera.position, fwd);
                if (az > 180) az -= 360;
                this.az = az;
                this.el = el;

                // Extract roll from camera up vs zero-roll up
                if (this.roll !== undefined) {
                    const cameraUp = new Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
                    const zeroRollUp = localUp.clone().sub(fwd.clone().multiplyScalar(localUp.dot(fwd)));
                    if (zeroRollUp.lengthSq() > 1e-10) {
                        zeroRollUp.normalize();
                        const cross = new Vector3().crossVectors(zeroRollUp, cameraUp);
                        const sinAngle = cross.dot(fwd);
                        const cosAngle = zeroRollUp.dot(cameraUp);
                        this.roll = -Math.atan2(sinAngle, cosAngle) * 180 / Math.PI;
                    } else {
                        this.roll = 0;
                    }
                }
                this.rotation = 0;
            }
        }
        this.updateSatelliteSliderRanges();
        this.updateSatelliteSliderVisibility();
        this.refresh();
    }

    updateSatelliteSliderVisibility() {
        if (this.satellite) {
            this.azController?.hide();
            this.elController?.hide();
            this.rollController?.hide();
            this.rotationController?.show();
        } else {
            this.azController?.show();
            this.elController?.show();
            this.rollController?.show();
            this.rotationController?.hide();
        }
    }

    refresh(v) {
        // legacy check
        assert(v === undefined, "CNodeControllerPTZUI: refresh called with v, should be undefined");

        // When sliders change, rebuild the satellite quaternion from angles
        if (this.satellite) this._satQuatDirty = true;


        // the FOV UI node is also updated, It's a hidden UI element that remains for backwards compatibility.
        const fovUINode = NodeMan.get("fovUI", false)
        if (fovUINode) {
            fovUINode.setValue(this.fov);
        }

        // don't think this is needed
        this.recalculateCascade();
    }

    // Extract az/el/roll from the camera's current orientation and update this controller's values.
    // Called when another controller (e.g. a track) is driving the camera,
    // so switching back to Manual PTZ preserves the current view.
    syncFromCamera(camera) {
        camera.updateMatrixWorld();

        const fwd = new Vector3();
        camera.getWorldDirection(fwd);
        const localUp = getLocalUpVector(camera.position);
        const dotUpFwd = fwd.dot(localUp);

        // Camera Y axis (up direction) from world matrix
        const cameraUp = new Vector3();
        cameraUp.setFromMatrixColumn(camera.matrixWorld, 1);

        if (Math.abs(dotUpFwd) > 1 - 1e-6) {
            // Near-vertical (nadir/zenith): normal az/el has gimbal lock.
            // Switch to satellite mode where roll=heading, az=horizontal pan, el=vertical pan.
            this.satellite = true;
            this.updateSatelliteSliderRanges();
            this.updateSatelliteSliderVisibility();
            this.el = dotUpFwd > 0 ? 90 : -90;
            this.az = 0; // no horizontal pan offset

            // Camera Y projected to horizontal gives the heading → store in roll
            const cameraUpH = cameraUp.clone().sub(localUp.clone().multiplyScalar(cameraUp.dot(localUp)));
            if (this.roll !== undefined) {
                if (cameraUpH.lengthSq() > 1e-10) {
                    cameraUpH.normalize();
                    const north = getLocalNorthVector(camera.position);
                    const east = north.clone().cross(localUp);
                    let heading = Math.atan2(cameraUpH.dot(east), cameraUpH.dot(north)) * 180 / Math.PI;
                    if (heading > 180) heading -= 360;
                    this.roll = heading;
                } else {
                    this.roll = 0;
                }
            }
            this.rotation = 0;
            this._satQuatDirty = true;
        } else {
            this.satellite = false;
            this.updateSatelliteSliderRanges();
            this.updateSatelliteSliderVisibility();
            // Normal case: extract az/el from camera direction
            let [az, el] = getAzElFromPositionAndForward(camera.position, fwd);
            // Convert from 0..360 to -180..180 to match PTZ range
            if (az > 180) az -= 360;
            this.az = az;
            this.el = el;

            // Extract roll: angle between the zero-roll up and the actual camera up,
            // measured around the view axis.
            if (this.roll !== undefined) {
                const zeroRollUp = localUp.clone().sub(fwd.clone().multiplyScalar(localUp.dot(fwd)));
                if (zeroRollUp.lengthSq() > 1e-10) {
                    zeroRollUp.normalize();
                    // Signed angle: rotateZ(+angle) rotates counterclockwise around +Z (camera backward),
                    // which is clockwise around fwd. So negate the atan2 result.
                    const cross = new Vector3().crossVectors(zeroRollUp, cameraUp);
                    const sinAngle = cross.dot(fwd);
                    const cosAngle = zeroRollUp.dot(cameraUp);
                    this.roll = -Math.atan2(sinAngle, cosAngle) * 180 / Math.PI;
                }
            }
        }
    }

}

export class CNodeControllerCustomAzEl extends CNodeControllerAzElZoom {
    constructor(v) {
        super(v);
        this.input("azSmooth",true);
        this.input("elSmooth", true);
        this.fallback = NodeMan.get(v.fallback);
        this.frames = Sit.frames;
        this.useSitFrames = true;

        this.relative = this.fallback.relative

    }



    setAzFile(azFile, azCol) {
        this.azFile = azFile;
        this.azCol = azCol;
        this.recalculate();
    }

    setElFile(elFile, elCol) {
        this.elFile = elFile;
        this.elCol = elCol;
    }



    recalculate() {

        const azSmooth = this.in.azSmooth ? this.in.azSmooth.v0 : 200;
        const elSmooth = this.in.elSmooth ? this.in.elSmooth.v0 : 200;

        if (this.azFile !== undefined) {
            assert(this.frames === Sit.frames, "CNodeControllerCustomAzEl: frames not set right");
            this.azArrayRaw = ExpandKeyframes(this.azFile, this.frames, 0, this.azCol);
            this.azArray = RollingAverage(this.azArrayRaw, azSmooth);
        }

        if (this.elFile !== undefined) {
            assert(this.frames === Sit.frames, "CNodeControllerCustomAzEl: frames not set right");
            this.elArrayRaw = ExpandKeyframes(this.elFile, this.frames, 0, this.elCol);
            this.elArray = RollingAverage(this.elArrayRaw, elSmooth);
        }



    }



    apply(f, objectNode ) {
        if (this.relative !== this.fallback.relative) {
            this.relative = this.fallback.relative;
            this.recalculateCascade();
        }

        if (this.fallback) {
            this.az = this.fallback.az;
            this.el = this.fallback.el;
            this.fov = this.fallback.fov;
        }

        if (this.azArray) {
            this.az = this.azArray[f];
        }

        if (this.elArray) {
            this.el = this.elArray[f];
        }



        super.apply(f, objectNode);

    }




}

export class CNodeControllerCustomHeading extends CNodeController {
    constructor(v) {
        super(v);
        this.input("headingSmooth", true);
        this.fallback = NodeMan.get(v.fallback);
        this.frames = Sit.frames;
        this.useSitFrames = true;
        this.heading = 0; // default heading
        this.forceHeadingPerFrame = true;
    }

    setHeadingFile(headingFile, headingCol) {
        this.headingFile = headingFile;
        this.headingCol = headingCol;
        this.recalculate();
    }

    recalculate() {
        const headingSmooth = this.in.headingSmooth ? this.in.headingSmooth.v0 : 200;

        if (this.headingFile !== undefined) {
            assert(this.frames === Sit.frames, "CNodeControllerCustomHeading: frames not set right");
            this.headingArrayRaw = ExpandKeyframes(this.headingFile, this.frames, 0, this.headingCol);
            this.headingArray = RollingAverage(this.headingArrayRaw, headingSmooth);
        }
    }


    getValueFrame(f) {
        return this.headingArray[f]
    }

    apply(f, objectNode) {
        // // default to the fallback heading if available
        // if (this.fallback && this.fallback.heading !== undefined) {
        //     this.heading = this.fallback.heading;
        // }
        //
        // // override with file data if available
        // if (this.headingArray) {
        //     this.heading = this.headingArray[f];
        // }
        //
        // // apply heading rotation to the object node
        // if (objectNode) {
        //     // DON'T rotate around the Y axis (up direction) for heading
        //     // need to set the heading on on the objectNode to the current cser
        //
        //
        // }
    }
}


// simlar, but move an object based on the inputs vertical speed feet per second
export class CNodeControllerVerticalSpeed extends CNodeController {
    constructor(v) {
        super(v);
        this.input("verticalSpeed", true);
        this.speed = 0;
        this.frames = Sit.frames;
        this.useSitFrames = true;
    }

    apply(f, objectNode) {
        if (!objectNode) {
            return;
        }
        const ob = objectNode._object;
        const feetPerSecond = this.in.verticalSpeed.v(f);
        if (feetPerSecond !== undefined) {
            const metersPerSecond = feetPerSecond * 0.3048;
            const distance = metersPerSecond / Sit.fps;


            const down = getLocalDownVector(ob.position)
            ob.position.add(down.multiplyScalar(distance))

            console.log(`moving ${distance}m`)

        }


    }
}
