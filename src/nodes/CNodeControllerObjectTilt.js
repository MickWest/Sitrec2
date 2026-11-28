import {CNodeController} from "./CNodeController";
import {guiMenus, NodeMan, setRenderOne, Sit} from "../Globals";
import {horizontalTurnBank, trackAcceleration, trackVelocity} from "../trackUtils";
import {V3} from "../threeUtils";
import {assert} from "../assert";
import {Matrix4, Quaternion} from "three";
import {radians} from "../utils";
import {getLocalEastVector, getLocalNorthVector, getLocalUpVector} from "../SphericalMath";
import {CNodeSmoothedPositionTrack} from "./CNodeSmoothedPositionTrack";
import {getGlareAngleFromFrame} from "../JetUtils";
import {t} from "../i18n";
import {getTrackAltitudeLock, isAGLLockActive} from "../AltitudeLock";
import {isRoadTrackActive} from "../TrackGround";


// Full set of tilt options for sitch-defined objects (Gimbal, etc.)
// lil-gui convention: { displayLabel: storedValue }
const allTiltOptions = {
    "No Banking":"none",
    "Physical Banking":"banking",
    "Fixed Heading":"fixedHeading",
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
    "Fixed Heading":"fixedHeading",
};

export class CNodeControllerObjectTilt extends CNodeController {
    constructor(v) {
        super(v);

        this.input("track")
        this.optionalInputs(["wind", "airTrack"])
        this.tiltType = v.tiltType ?? "none"
        // Compass heading (degrees true) the model holds when tiltType is "fixedHeading",
        // i.e. when the object's attitude is independent of its direction of travel.
        this.fixedHeading = v.fixedHeading ?? 0
        // Tilt and sway, applied after the banking mode's rotation: the top leans toward tiltDirection (degrees true) by
        // tiltAngle + swayAmplitude * sin(2 pi t / swayPeriod). Estimated scene inputs with no measured
        // default (a sky lantern or balloon swinging in gusts); all zero leaves the orientation unchanged.
        this.tiltAngle = v.tiltAngle ?? 0
        this.tiltDirection = v.tiltDirection ?? 0
        this.swayAmplitude = v.swayAmplitude ?? 0
        this.swayPeriod = v.swayPeriod ?? 2
        this._swayRotation = null;
        this._savedQuaternion = null;



        // The frame's track sets heading. The smoothed track estimates turn rate
        // and the sustained grade of a terrain-following track.


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
        this.fixedHeadingGui = null;
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
            inheritAltitudeLock: false,
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
        // ObjectTilt owns an internal smoothed helper track with a deterministic id.
        // Tear it down explicitly so recreating the controller cannot collide with a
        // stale `${controllerId}Smoothed` node left in NodeMan.
        NodeMan.unlinkDisposeRemove(this.smoothedTrack?.id ?? this.smoothedTrack)
        if (this.tiltTypeGui) {
            this.tiltTypeGui.destroy();
            this.tiltTypeGui = null;
        }
        if (this.fixedHeadingGui) {
            this.fixedHeadingGui.destroy();
            this.fixedHeadingGui = null;
        }
    }

    _createTiltGui(parent, options) {
        if (this.tiltTypeGui) {
            this.tiltTypeGui.destroy();
        }
        if (this.fixedHeadingGui) {
            this.fixedHeadingGui.destroy();
            this.fixedHeadingGui = null;
        }
        this.tiltTypeGuiParent = parent;
        this.tiltTypeGui = parent.add(this, "tiltType", options)
            .name(t("misc.banking.label"))
            .tooltip(t("misc.banking.tooltip"))
            .onChange(() => { this._updateFixedHeadingGui() })
            .listen(() => { setRenderOne(true) })
        // Mark as common so CNode3DObject.destroyNonCommonUI() preserves it
        // when rebuilding geometry-specific GUI controls during deserialization
        this.tiltTypeGui.isCommon = true;

        this.fixedHeadingGui = parent.add(this, "fixedHeading", 0, 360, 0.1)
            .name(t("misc.fixedHeading.label"))
            .tooltip(t("misc.fixedHeading.tooltip"))
            .listen(() => { setRenderOne(true) })
        this.fixedHeadingGui.isCommon = true;
        this._updateFixedHeadingGui();

        for (const gui of this.swayGuis ?? []) gui.destroy();
        this.swayGuis = [["tiltAngle", 0, 90, 0.5], ["tiltDirection", 0, 360, 1], ["swayAmplitude", 0, 45, 0.5], ["swayPeriod", 0.2, 20, 0.1]]
            .map(([key, min, max, step]) => {
                const gui = parent.add(this, key, min, max, step)
                    .name(t(`misc.${key}.label`))
                    .tooltip(t(`misc.${key}.tooltip`))
                    .listen(() => { setRenderOne(true) })
                gui.isCommon = true;
                return gui;
            });
    }

    // The heading only means anything in "fixedHeading" mode, so it is only shown there.
    _updateFixedHeadingGui() {
        if (!this.fixedHeadingGui) return;
        if (this.tiltType.toLowerCase() === "fixedheading") {
            this.fixedHeadingGui.show();
        } else {
            this.fixedHeadingGui.hide();
        }
        setRenderOne(true);
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
            fixedHeading: this.fixedHeading,
            tiltAngle: this.tiltAngle,
            tiltDirection: this.tiltDirection,
            swayAmplitude: this.swayAmplitude,
            swayPeriod: this.swayPeriod,
        }
    }

    modDeserialize(v) {
        super.modDeserialize(v)
        this.tiltType = v.tiltType
        if (v.fixedHeading !== undefined) this.fixedHeading = v.fixedHeading
        for (const key of ["tiltAngle", "tiltDirection", "swayAmplitude", "swayPeriod"])
            if (v[key] !== undefined) this[key] = v[key]
        this._updateFixedHeadingGui()
    }

    // The lean in degrees at frame f: the fixed tilt plus a sinusoidal sway in scene time (frames x simSpeed / fps).
    leanAt(f) {
        const seconds = f * (Sit.simSpeed ?? 1) / Sit.fps
        return this.tiltAngle + this.swayAmplitude * Math.sin(2 * Math.PI * seconds / this.swayPeriod)
    }

    // Point the model at a compass bearing rather than along its track, so an object can
    // translate without turning - crabbing sideways, drifting, or holding station with its
    // nose somewhere else. Independent of speed, so it works for a stationary object too.
    applyFixedHeading(object, objectNode, pos) {
        const h = radians(this.fixedHeading)

        let north = getLocalNorthVector(pos)
        let east = getLocalEastVector(pos)

        // At exactly +/-90 degrees latitude the local north/east basis collapses: every
        // horizontal direction is south (or north), so the projection leaves a zero vector
        // and normalize() returns (0,0,0). lookAt() would then get a zero-length direction
        // and silently pick an arbitrary axis. CoordinateParser accepts those latitudes, so
        // fall back to GRID NORTH - the prime-meridian direction, the convention polar
        // navigation already uses - which keeps the requested heading deterministic there.
        if (north.lengthSq() < 1e-12 || east.lengthSq() < 1e-12) {
            const up = getLocalUpVector(pos)
            north = V3(1, 0, 0).sub(up.clone().multiplyScalar(up.x)).normalize()
            east = V3().crossVectors(up, north.clone().negate())
        }

        const target = pos.clone()
            .add(north.multiplyScalar(Math.cos(h) * 100))
            .add(east.multiplyScalar(Math.sin(h) * 100))

        // lookAt() reads the object's own position, which clampAboveGround may have moved,
        // so aim from the track position and put it back (as the velocity path below does)
        const oldPos = object.position.clone();
        object.position.copy(pos)
        object.up = objectNode.getUpVector(object.position)
        object.lookAt(target)
        object.position.copy(oldPos);
        object.updateMatrix()
        object.updateMatrixWorld()

        if (this._savedQuaternion) {
            this._savedQuaternion.copy(object.quaternion);
        } else {
            this._savedQuaternion = object.quaternion.clone();
        }
    }

    apply(f, objectNode) {
        if (objectNode.isCameraSample) {
            // A sample starts with the live pose, including its previous lean.
            // Its banking and lean history must never replace the live history.
            const sample = Object.create(this);
            sample._swayRotation = this._swayRotation?.clone();
            sample._savedQuaternion = this._savedQuaternion?.clone();
            return sample.applyTilt(f, objectNode);
        }
        this.applyTilt(f, objectNode);
    }

    applyTilt(f, objectNode) {
        const object = objectNode._object;
        // Remove last frame's lean first: some banking paths keep or restore the previous orientation.
        if (object !== undefined && this._swayRotation) {
            object.quaternion.premultiply(this._swayRotation.invert());
            this._swayRotation = null;
        }
        this.applyBanking(f, objectNode);
        if (object === undefined || f < 0) return;
        const lean = radians(this.leanAt(f));
        if (lean === 0) return;
        // Rotate about the horizontal axis up x d through the object's origin, so the top leans toward d.
        const pos = object.position, up = getLocalUpVector(pos), d = radians(this.tiltDirection);
        const toward = getLocalNorthVector(pos).multiplyScalar(Math.cos(d)).add(getLocalEastVector(pos).multiplyScalar(Math.sin(d)));
        this._swayRotation = new Quaternion().setFromAxisAngle(V3().crossVectors(up, toward).normalize(), lean);
        object.quaternion.premultiply(this._swayRotation);
        object.updateMatrix();
        object.updateMatrixWorld();
    }

    noseDisplacement(f, pos, next, tiltType) {
        const forward = next.clone().sub(pos);
        if (["none", "banking", "frontpointing", "frontpointingwind"].includes(tiltType)) {
            const lock = getTrackAltitudeLock(this.in.track);
            if (lock && isAGLLockActive(lock) && !isRoadTrackActive(lock)) {
                // The position follows each terrain triangle. For pitch use
                // the sustained grade, keeping the actual frame's heading.
                const up = getLocalUpVector(pos);
                const trend = trackVelocity(this.smoothedTrack, f);
                const rise = trend.dot(up);
                const run = trend.projectOnPlane(up).length();
                if (run > 1e-6) {
                    forward.projectOnPlane(up);
                    forward.addScaledVector(up, forward.length() * rise / run);
                }
            }
        }
        if (this.in.wind) forward.sub(this.in.wind.getValueFrame(f, pos));
        return forward;
    }

    applyBanking(f, objectNode ) {

        const object = objectNode._object;

        if (object !== undefined) {
            if (f >= 0) {

                const pos = this.in.track.p(f);
                let next = this.in.track.p(f + 1);
                let tiltType = this.tiltType.toLowerCase();

                // "Fixed Heading" does not read the track direction at all, so it is applied
                // BEFORE the degenerate-position check below. An object that is genuinely
                // stationary - hovering, or parked, or simply on the last frame of its track,
                // where p(f+1) clamps to p(f) - would otherwise take that early return and
                // keep the default quaternion, never getting its heading at all.
                if (tiltType === "fixedheading") {
                    this.applyFixedHeading(object, objectNode, pos)
                    return;
                }

                // FIX B/C: distance check on RAW positions (before wind),
                // store/restore quaternion for degenerate positions
                if (pos.distanceTo(next) < 1e-6) {
                    if (this._savedQuaternion) {
                        object.quaternion.copy(this._savedQuaternion);
                        object.updateMatrix();
                        object.updateMatrixWorld();
                    } else {
                        this._savedQuaternion = object.quaternion.clone();
                    }
                    return;
                }

                if (!this.in.airTrack) {
                    if (tiltType === "frontpointingair") tiltType = "frontpointing";
                    if (tiltType === "bottompointingair") tiltType = "bottompointing";
                }
                const nose = this.noseDisplacement(f, pos, next, tiltType);

                // we want to use track positions not the object.position as the clampAboveGroung might have moved it
                // so temporarily set the object position back to where it was before any clampAboveGround call

                const oldPos = object.position.clone();
                object.position.copy(pos)

                object.up = objectNode.getUpVector(object.position)
                object.lookAt(pos.clone().add(nose))

                // restore the object position
                object.position.copy(oldPos);

                // Save base orientation AFTER lookAt, BEFORE switch block modifies it
                // (reuse the saved quaternion object rather than allocating per frame)
                if (this._savedQuaternion) {
                    this._savedQuaternion.copy(object.quaternion);
                } else {
                    this._savedQuaternion = object.quaternion.clone();
                }

                switch (tiltType) {
                    case "banking":
                        const secondsPerFrame = (Sit.simSpeed ?? 1) / Sit.fps;
                        const lastStep = Sit.frames - 2;
                        const start = Math.max(0, f - Sit.fps / 2);
                        const end = Math.min(lastStep, f + Sit.fps / 2);
                        const bankAngle = horizontalTurnBank(
                            trackVelocity(this.smoothedTrack, start), trackVelocity(this.smoothedTrack, end),
                            trackVelocity(this.smoothedTrack, f), getLocalUpVector(pos),
                            (end - start) * secondsPerFrame, secondsPerFrame);
                        if (bankAngle === null || nose.lengthSq() < 1e-12) {
                            object.updateMatrix()
                            object.updateMatrixWorld()
                            break;
                        }

                        // Roll around the nose set by lookAt, including any wind correction.
                        const rollAxis = nose.normalize();
                        object.rotateOnWorldAxis(rollAxis, bankAngle);

                        if (this.in.angleOfAttack !== undefined) {
                            const aoa = this.in.angleOfAttack.v(f)
                            const aoaRad = radians(aoa)
                            const up = getLocalUpVector(object.position)
                            const left = up.cross(rollAxis)
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
                        // The unconditional pre-switch lookAt(next) already
                        // oriented the object using currentPos (and wind
                        // subtraction when this.in.wind is present). Repeating
                        // lookAt here would use the restored oldPos and aim
                        // along (next - oldPos), which tilts the model when
                        // ground clamping has moved oldPos away from
                        // currentPos. Just flush matrices.
                        object.updateMatrix()
                        object.updateMatrixWorld()
                        break;

                    case "frontpointingwind":
                        // Same reasoning as "frontpointing": the pre-switch
                        // lookAt already subtracted wind (via getValueFrame
                        // with the track position) and ran lookAt from
                        // currentPos. The legacy code here called
                        // this.in.wind.v(f) without a position and lookAt
                        // from oldPos, both of which are wrong now.
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

                    // Unreachable - applyFixedHeading() returns before this switch. Kept
                    // because the default branch below asserts, which halts the app.
                    case "fixedheading":
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
