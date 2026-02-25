import {CNodeController} from "./CNodeController";
import {guiMenus, NodeMan, setRenderOne, Sit} from "../Globals";
import {trackAcceleration, trackDirection, trackVelocity} from "../trackUtils";
import {V3} from "../threeUtils";
import {Matrix4} from "three";
import {radians} from "../utils";
import {getLocalUpVector} from "../SphericalMath";
import {CNodeSmoothedPositionTrack} from "./CNodeSmoothedPositionTrack";
import {getGlareAngleFromFrame} from "../JetUtils";


// Full set of tilt options for sitch-defined objects (Gimbal, etc.)
// lil-gui convention: { displayLabel: storedValue }
const allTiltOptions = {
    "No Banking":"none",
    "Physical Banking":"banking",
    frontPointing:"frontPointing",
    frontPointingAir:"frontPointingAir",
    axialPush:"axialPush",
    axialPull:"axialPull",
    axialPushZeroG:"axialPushZeroG",
    axialPullZeroG:"axialPullZeroG",
    bottomPointing:"bottomPointing",
    bottomPointingAir:"bottomPointingAir",
    glareAngle:"glareAngle",
};

// Simplified set for dynamically-added track objects
const simpleTiltOptions = {
    "No Banking":"none",
    "Physical Banking":"banking",
};

export class CNodeControllerObjectTilt extends CNodeController {
    constructor(v) {
        super(v);

        this.input("track")
        this.optionalInputs(["wind", "airTrack"])
        this.tiltType = v.tiltType ?? "none"
        this._savedQuaternion = null;



        // with a large smoothing sliding window, the smoothed track will be offset from the original track
        // when going around a corner.
        // so we use the original track for the position, and the smoothed track for the heading


        // Debug display
        // new CNodeDisplayTrack({
        //     id: this.id + "Disp",
        //     track: this.id + "Smoothed",
        //     color: "#0030FF",
        //     width: 1,
        //     ignoreAB: true,
        //     layers: LAYER.MASK_HELPERS,
        //     skipGUI: true,
        //
        // })



        // Add orientation type menu
        this.noMenu = v.noMenu;
        this.tiltTypeGui = null;
        this.tiltTypeGuiParent = null;
        if (!v.noMenu) {
            this.tiltTypeGuiParent = v.guiFolder ?? guiMenus.physics;
            this._explicitGuiFolder = !!v.guiFolder;
            const options = this._explicitGuiFolder ? simpleTiltOptions : allTiltOptions;
            this._createTiltGui(this.tiltTypeGuiParent, options);
        }

        // the input track is likely not smooth enought, so create a smoothed version
        this.smoothedTrack = new CNodeSmoothedPositionTrack({
            id: this.id + "Smoothed",
            source: this.in.track,
            method: "sliding",
            window: 200}
        )

        // hook the to this node so it will get updated before this node does
        this.addInput("smoothedTrack", this.smoothedTrack)

        // optional input for the angle of attack
        this.input("angleOfAttack",true);

    }

    recalculate() {

        super.recalculate();
    }

    dispose() {
        super.dispose()
        NodeMan.unlinkDisposeRemove(this.smoothedTrack)
        if (this.tiltTypeGui) {
            this.tiltTypeGui.destroy();
            this.tiltTypeGui = null;
        }
    }

    _createTiltGui(parent, options) {
        if (this.tiltTypeGui) {
            this.tiltTypeGui.destroy();
        }
        this.tiltTypeGuiParent = parent;
        this.tiltTypeGui = parent.add(this, "tiltType", options)
            .name("Banking")
            .listen(() => { setRenderOne(true) })
        // Mark as common so CNode3DObject.destroyNonCommonUI() preserves it
        // when rebuilding geometry-specific GUI controls during deserialization
        this.tiltTypeGui.isCommon = true;
    }

    // Move the tilt type GUI from physics menu to the object's GUI folder
    moveGuiTo(newParent) {
        if (this._explicitGuiFolder) return;
        if (this.tiltTypeGui && this.tiltTypeGuiParent !== newParent) {
            this._createTiltGui(newParent, allTiltOptions);
        }
    }

    modSerialize() {
        return {
            ...super.modSerialize(),
            tiltType: this.tiltType,
        }
    }

    modDeserialize(v) {
        super.modDeserialize(v)
        this.tiltType = v.tiltType
    }

    apply(f, objectNode ) {

        const object = objectNode._object;

        if (object !== undefined) {
            if (f >= 0) {

                var rawNext = this.in.track.p(f + 1)
                const currentPos = this.in.track.p(f)

                // FIX B/C: distance check on RAW positions (before wind),
                // store/restore quaternion for degenerate positions
                if (currentPos.distanceTo(rawNext) < 1e-6) {
                    if (this._savedQuaternion) {
                        object.quaternion.copy(this._savedQuaternion);
                        object.updateMatrix();
                        object.updateMatrixWorld();
                    } else {
                        this._savedQuaternion = object.quaternion.clone();
                    }
                    return;
                }

                var next = rawNext;
                // if we have a wind vector then subtract that to get the nose heading
                // pass the track position to get wind in the correct local frame
                if (this.in.wind !== undefined) {
                    const trackPos = this.in.track.p(f)
                    const windVector = this.in.wind.getValueFrame(f, trackPos)
                    next = rawNext.clone();
                    next.sub(windVector)
                }

                // we want to use track positions not the object.position as the clampAboveGroung might have moved it
                // so temporarily set the object position back to where it was before any clampAboveGround call

                const oldPos = object.position.clone();
                object.position.copy(currentPos)

                object.up = objectNode.getUpVector(object.position)
                object.lookAt(next)

                // restore the object position
                object.position.copy(oldPos);

                // Save base orientation AFTER lookAt, BEFORE switch block modifies it
                this._savedQuaternion = object.quaternion.clone();

                // calculate the heading on the SMOOTHED track
                var from = this.in.track.p(f)
                var to = this.in.track.p(f + 1)
                var fwdAir = to.sub(from);

                // but we need to use the actual track for the position
                // i.e. pos and next
                var pos = this.in.track.p(f); //
                var next = pos.clone().add(fwdAir)


                // var pos = this.smoothedTrack.p(f);
                // var next = this.smoothedTrack.p(f + 1)

                let tiltType = this.tiltType.toLowerCase()

                // if we don't have an air track, then we can't use the air tilt types
                // so we just use the non-air versions
                if (this.in.airTrack === undefined) {
                    if (tiltType === "frontpointingair")
                        tiltType = "frontpointing";
                    if (tiltType === "bottompointingair")
                        tiltType = "bottompointing";
                }

                switch (tiltType) {
                    case "banking":
                        // with banking, we calculate the angular velocity
                        // from the track, and then use that to rotate the model
                        // around the track direction

                        const sampleDuration = 1;
                        // first get the angular velocity
                        const velocityA = trackDirection(this.smoothedTrack, f - sampleDuration * Sit.fps / 2, 2)
                        const velocityB = trackDirection(this.smoothedTrack, f + sampleDuration * Sit.fps / 2, 3)
                        const velocity = trackVelocity(this.smoothedTrack, f)
                        const fwd = velocity.clone().normalize()
                        let angularVelocity = velocityA.angleTo(velocityB) / sampleDuration;  // radians per second

                        // is it left or right turn? Use local up vector instead of global Y
                        const cross = V3().crossVectors(velocityA, velocityB)
                        const localUp = getLocalUpVector(pos)
                        const right = cross.dot(localUp) > 0
                        if (right)
                            angularVelocity = -angularVelocity


                        const speed = velocity.length() * Sit.fps; // meters per second
                        // convert angular velocity to bank angle
                        // function turnRate(bankDegrees, speedMPS) {
                        //     var g = 9.77468   // local gravity at 36°latitude, 25000 feet https://www.sensorsone.com/local-gravity-calculator/
                        //     var rate = (g * tan(radians(bankDegrees))) / speedMPS
                        //     return degrees(rate);
                        // }
                        // rate = g * tan(bank) / speed
                        // so bank = atan(rate * speed / g)

                        const bankAngle = Math.atan(angularVelocity * speed / 9.77468)

                        // and rotate the model about fwd by the bank angle
                        const m = new Matrix4()
                        m.makeRotationAxis(fwd, bankAngle)
                        object.rotateOnWorldAxis(fwd, bankAngle);

                        if (this.in.angleOfAttack !== undefined) {
                            const aoa = this.in.angleOfAttack.v(f)
                            const aoaRad = radians(aoa)
                            const up = getLocalUpVector(object.position)
                            const left = up.cross(fwd)
                            object.rotateOnWorldAxis(left, -aoaRad)
                        }

                        object.updateMatrix()
                        object.updateMatrixWorld()


                        break;

                    case "axialpush":
                    case "axialpull":
                    case "axialpullzerog":
                    case "axialpushzerog":
                        // In Lazarian thrust, the vertical axis is aligned in the net force vector,
                        // including gravity.
                        // so a saucer tilts in the direction it is going in
                        // like a helicopter

                        if (f > this.frames - 4)
                            f = this.frames - 4;

                        // object.quaternion.identity()
                        object.updateMatrix()
                        object.updateMatrixWorld()

                        var accelerationDir = trackAcceleration(this.smoothedTrack, f)

                        if (this.tiltType === "axialPull")
                            accelerationDir.negate()

                        if (this.tiltType === "axialPull" || this.tiltType === "axialPush") {
                            const localDown = getLocalUpVector(pos).negate()
                            const gravity = localDown.multiplyScalar(9.81 / this.fps / this.fps) // 9.81 is per second, so divide by fps^2 to get per frame
                            accelerationDir.sub(gravity) // add in a force opposite gravity
                        }

                        this.pointBottomAt(object, pos, pos.clone().add(accelerationDir))


                        break;
                    case "bottompointing":
                        this.pointBottomAt(object, pos, next)
                        break;

                    case "bottompointingair":
                        var from = this.in.airTrack.p(f)
                        var to = this.in.airTrack.p(f + 1)
                        var fwdAir = to.sub(from);
                        next = pos.clone().add(fwdAir)
                        this.pointBottomAt(object, pos, next)
                        break;

                    case "frontpointing":
                        object.lookAt(next)
                        object.updateMatrix()
                        object.updateMatrixWorld()
                        break;

                    case "frontpointingwind":
                        if (this.in.wind !== undefined) {
                            next.sub(this.in.wind.v(f))
                        }
                        object.lookAt(next)
                        object.updateMatrix()
                        object.updateMatrixWorld()
                        break;

                    case "frontpointingair":

                        var from = this.in.airTrack.p(f)
                        var to = this.in.airTrack.p(f + 1)
                        var fwdAir = to.sub(from);
                        next = pos.clone().add(fwdAir)


                        object.lookAt(next)
                        object.updateMatrix()
                        object.updateMatrixWorld()
                        break;

                    case "glareangle":
                        // so we just need to rotate it around the line of sight by the glare angle
                        var glare = radians(getGlareAngleFromFrame(f) + 90);
                        var mg = new Matrix4()
                        // get LOS from the camera to the target
                        var to = this.in.airTrack.p(f)

                        if (NodeMan.exists("jetTrack")) {

                            var from = NodeMan.get("jetTrack").p(f)
                            var fwdLOS = to.clone().sub(from).normalize()
                            // make mg a rotation matrix that rotates around the line of sight
                            mg.makeRotationAxis(fwdLOS, glare)

                            // and appy it to the model
                            object.quaternion.setFromRotationMatrix(mg);
                            object.updateMatrix()
                            object.updateMatrixWorld()
                        } else {
                            console.warn("jetTrack not found for glare angle in CNodeDisplayTargetModel.js")
                        }
                        break;

                    case "none":
                        break;

                    default:
                        assert(0, "Unknown tilt type: " + this.tiltType + " in CNodeControllerObjectTilt.js, node id: " + this.id)
                        break;

                }

            }
        }
    }

    pointBottomAt(object, pos, next) {

        // we just use the point at function, and then change axis order to y,z,x
        object.lookAt(next)
        object.updateMatrix()
        object.updateMatrixWorld()

        // debug only
        var direction = next.clone().sub(pos)
        direction.normalize()
        direction.multiplyScalar(300)
        //      DebugArrow("pointing", direction, pos.clone(), 300, "#ff00ff")


        var _x = V3()
        var _y = V3()
        var _z = V3()
        object.matrix.extractBasis(_x, _y, _z)
        _x.normalize()
        _y.normalize()
        _z.normalize()
        //     DebugArrow("saucer X", _x, pos.clone(), 300, "#ff0000")
        //     DebugArrow("saucer Y", _y, pos.clone(), 300, "#00FF00")
        //    DebugArrow("saucer Z", _z, pos.clone(), 300, "#0000FF")


        var m = new Matrix4()
        m.makeBasis(_y, _z, _x)    // z goes into the y slot


        object.quaternion.setFromRotationMatrix(m);

        // the local matrix is composed from position, quaternion, and scale.
        // the world matrix is the parent's world matrix multipled by this local matrix

        // not sure if this finalization is needed.
        object.updateMatrix()
        object.updateMatrixWorld()
    }

}