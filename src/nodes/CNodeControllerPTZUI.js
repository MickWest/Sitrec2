import {degrees, ExpandKeyframes, radians} from "../utils";
import {RollingAverage} from "../smoothing";
import {
    getAzElFromPositionAndForward,
    getLocalDownVector,
    getLocalNorthVector,
    getLocalUpVector,
    getNorthPole
} from "../SphericalMath";
import {guiMenus, NodeMan, Sit} from "../Globals";
import {ViewMan} from "../CViewManager";

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


// Aspect ratios worth naming in the readout. A bare 1.7778 is correct but "16:9" is what the
// number actually means to anyone reading it.
const NAMED_ASPECTS = [
    [16 / 9, "16:9"], [4 / 3, "4:3"], [3 / 2, "3:2"], [1, "1:1"],
    [21 / 9, "21:9"], [2.39, "2.39:1"], [5 / 4, "5:4"], [9 / 16, "9:16"], [3 / 4, "3:4"],
];

function nameAspect(a) {
    for (const [value, name] of NAMED_ASPECTS) {
        if (Math.abs(a - value) < 0.005 * value) return name;
    }
    return null;
}

// The gate every "35mm equivalent focal length" is quoted against: the 36x24mm full-frame
// (135 film) format. 36 is its LONG side - see the focal35 accessors for why that is the one.
const FULL_FRAME_LONG_MM = 36;

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

        // Horizontal FOV is not a second stored quantity — it is this.fov read through an aspect
        // ratio, and setting it writes back through the same one. See fovAspect for which ratio.
        this.lockAspect = v.lockAspect ?? false;
        this.lockedAspect = v.lockedAspect ?? 16 / 9;
        // Plain field rather than a getter: lil-gui assigns to the property it is handed, and a
        // getter-only accessor would throw if anything ever wrote back. Refreshed in apply().
        this.aspectDisplay = "-";
        // What the file SAYS the lens was, as opposed to what the camera is currently set to.
        // Hidden until a photo with that metadata is loaded. Refreshed in apply().
        this.lensDisplay = "-";
        this._lensText = "";

        assert(v.fov !== undefined, "CNodeControllerPTZUI: initial fov is undefined")

        if (v.showGUI) {

            this.setGUI(v,"camera");
            const guiPTZ = this.gui;

            this.azController = guiPTZ.add(this, "az", -180, 180, 0.01, false).listen().name(t("ptzUI.panAz.label")).tooltip(t("ptzUI.panAz.tooltip")).onChange(v => this.refresh()).setLabelColor(pszUIColor).wrap()
            this.elController = guiPTZ.add(this, "el", -89, 89, 0.01, false).listen().name(t("ptzUI.tiltEl.label")).tooltip(t("ptzUI.tiltEl.tooltip")).onChange(v => this.refresh()).setLabelColor(pszUIColor)
            if (this.fov !== undefined) {
                // The Zoom (fov) slider lives in the FOV (Zoom) sub-folder, not with
                // the Pan/Tilt/Roll heading controls. Falls back to the PTZ folder if
                // that permanent shell isn't present (e.g. cut-down menu setups).
                const fovFolder = guiMenus.cameraFOV ?? guiPTZ;
                this.fovController = fovFolder.add(this, "fov", 0.0001, 170, 0.01, false).listen().name(t("ptzUI.zoomFov.label")).tooltip(t("ptzUI.zoomFov.tooltip")).onChange(v => {
                    this.refresh()
                }).setLabelColor(pszUIColor) // .elastic(0.0001, 170)

                // The same angle across the frame's width. Not a second stored value — it reads
                // and writes this.fov through fovAspect, so the two sliders can never disagree.
                this.hfovController = fovFolder.add(this, "hfov", 0.0001, 179, 0.01, false)
                    .listen()
                    .name(t("ptzUI.hfov.label", {defaultValue: "HFOV (deg)"}))
                    .tooltip(t("ptzUI.hfov.tooltip", {defaultValue:
                        "Camera HORIZONTAL field of view in degrees, across the full width of " +
                        "the frame.\n\nDerived from VFOV and the aspect ratio below — editing " +
                        "it sets VFOV to match. An HFOV means nothing without saying what " +
                        "frame it spans, which is what the aspect ratio is for."}))
                    .onChange(() => this.refresh())
                    .setLabelColor(pszUIColor);

                // The same angle again, as the lens that would produce it on a full-frame camera.
                // Elastic because focal length spans four decades - about 1mm for a fisheye up to
                // several thousand for a narrow sensor field - so a fixed linear range is useless
                // at one end or the other. The slider grows its own max when pushed past the right
                // end and shrinks it again on the way back.
                this.focal35Controller = fovFolder.add(this, "focal35", 1, 200, 0.1, false)
                    .listen()
                    .decimals(1)
                    .elastic(50, 100000, false, true)
                    .name(t("ptzUI.focal35.label", {defaultValue: "35mm Equiv (mm)"}))
                    .tooltip(t("ptzUI.focal35.tooltip", {defaultValue:
                        "The lens that would give this field of view on a 36x24mm full-frame " +
                        "camera.\n\nMeasured across the frame's LONG axis, so the number only " +
                        "moves if the frame was actually cropped. A camera shooting 3:2 stills " +
                        "and 16:9 video cuts the top and bottom off the same sensor through the " +
                        "same lens, and reports the same number for both; so does turning the " +
                        "camera to shoot portrait, which crops nothing at all. Editing it sets " +
                        "HFOV and VFOV to match."}))
                    // Writing this.fov is not enough to make an edit stick. apply() re-reads the
                    // fov from fovSwitch every frame, and for the Manual source that switch reads
                    // fovUI - so an edit that never reaches fovUI is overwritten on the next frame.
                    // refresh() is what copies it across. Same reason VFOV and HFOV have it.
                    .onChange(() => this.refresh())
                    .setLabelColor(pszUIColor);

                // What the imported photo says was actually on the camera. The slider above is a
                // property of the CAMERA SETTING; this is a property of the FILE, so the two
                // agreeing is a real check rather than a tautology - and when they disagree, the
                // import got something wrong.
                this.lensController = fovFolder.add(this, "lensDisplay")
                    .listen().disable()
                    .name(t("ptzUI.lens.label", {defaultValue: "Lens (EXIF)"}))
                    .tooltip(t("ptzUI.lens.tooltip", {defaultValue:
                        "The real focal length and lens recorded by the camera in the imported " +
                        "photo, straight from its EXIF.\n\nThis is the TRUE focal length on that " +
                        "camera's sensor, not a 35mm equivalent - on a full-frame body the two " +
                        "match, on a smaller sensor the equivalent above will be the longer " +
                        "number. Hidden when no photo with lens metadata is loaded."}));
                this.lensController.hide();

                this.aspectController = fovFolder.add(this, "aspectDisplay")
                    .listen().disable()
                    .name(t("ptzUI.aspect.label", {defaultValue: "Aspect Ratio"}))
                    .tooltip(t("ptzUI.aspect.tooltip", {defaultValue:
                        "Width divided by height of the frame that VFOV and HFOV are quoted " +
                        "against.\n\nWith a video loaded this is the video's own pixel " +
                        "dimensions and cannot be changed. Otherwise it is either pinned (Lock " +
                        "Aspect on) or taken from the view pane, which changes when you resize " +
                        "the window."}));

                this.lockAspectController = fovFolder.add(this, "lockAspect")
                    .listen()
                    .name(t("ptzUI.lockAspect.label", {defaultValue: "Lock Aspect"}))
                    .tooltip(t("ptzUI.lockAspect.tooltip", {defaultValue:
                        "Hold the aspect ratio fixed instead of letting it follow the view " +
                        "pane, so HFOV stays put when the window is resized.\n\nAlways on, and " +
                        "not editable, while a video is loaded: the video defines the frame.\n\n" +
                        "This is separate from Match Video Aspect, which changes how the 3D is " +
                        "RENDERED rather than what the FOV numbers mean."}))
                    .onChange((on) => {
                        // Freeze whatever it is right now, so ticking the box never moves the
                        // camera — it only stops the number from drifting afterwards.
                        if (on) this.lockedAspect = this.liveAspect() ?? this.lockedAspect;
                        this.refresh();
                    });
                this.updateAspectLockAvailability();
            }
            if (this.roll !== undefined ) {
                this.rollController = guiPTZ.add(this, "roll", -180, 180, 0.005).listen().name(t("ptzUI.roll.label")).tooltip(t("ptzUI.roll.tooltip")).onChange(v => this.refresh()).setLabelColor(pszUIColor)
            }
            // Lens X/Y offset and near plane are "tweaks" rather than primary
            // pan/tilt/zoom controls, so they live in Camera ▸ Camera Tweaks (falls
            // back to the PTZ folder if that permanent shell isn't present).
            const tweaksFolder = guiMenus.cameraTweaks ?? guiPTZ;
            tweaksFolder.add(this, "xOffset", -20, 20, 0.001).listen().name(t("ptzUI.xOffset.label")).tooltip(t("ptzUI.xOffset.tooltip")).onChange(v => this.refresh()).setLabelColor(pszUIColor)
            tweaksFolder.add(this, "yOffset", -20, 20, 0.001).listen().name(t("ptzUI.yOffset.label")).tooltip(t("ptzUI.yOffset.tooltip")).onChange(v => this.refresh()).setLabelColor(pszUIColor)
            tweaksFolder.add(this, "nearPlane", 0.001, 1, 0.001).listen().name(t("ptzUI.nearPlane.label")).tooltip(t("ptzUI.nearPlane.tooltip")).onChange(v => this.refresh()).setLabelColor(pszUIColor)
            this.relativeController = guiPTZ.add(this, "relative").listen().name(t("ptzUI.relative.label")).tooltip(t("ptzUI.relative.tooltip")).onChange(v => this.refresh())
            this.satelliteController = guiPTZ.add(this, "satellite").listen().name(t("ptzUI.satellite.label")).tooltip(t("ptzUI.satellite.tooltip")).onChange(v => {
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

    // ---------- vertical / horizontal FOV and the aspect that links them ----------
    //
    // Only the VERTICAL FOV is stored (this.fov, and fovUI behind it), because that is what a
    // three.js PerspectiveCamera takes. Horizontal FOV is that same angle read through an aspect
    // ratio. Which ratio is the whole question: an HFOV quoted without saying what frame it spans
    // is not a measurement of anything, and getting exactly this wrong by 10 degrees is how a
    // published reconstruction can put a sensor 60% too high.

    /** The aspect of the loaded video, from its ORIGINAL coded dimensions. Undefined if none. */
    videoAspect() {
        const videoNode = NodeMan.get("video", false);
        if (!videoNode) return undefined;
        // Originals rather than the working dimensions: a resolution cap rewrites the working
        // pair, and metadata rotation can swap it, while the coded pair stays as delivered.
        const w = videoNode.originalVideoWidth || videoNode.videoData?.videoWidth || 0;
        const h = videoNode.originalVideoHeight || videoNode.videoData?.videoHeight || 0;
        return (w > 0 && h > 0) ? w / h : undefined;
    }

    /** The aspect of the pane this camera is actually being rendered into. Undefined if none. */
    liveAspect() {
        const node = this._objectNode;
        if (!node) return undefined;
        for (const id in ViewMan.list) {
            const view = ViewMan.list[id];
            if (view.cameraNode === node && view.widthPx > 0 && view.heightPx > 0) {
                return view.widthPx / view.heightPx;
            }
        }
        return undefined;
    }

    /**
     * The aspect ratio the horizontal FOV is quoted against.
     *
     * A video wins outright and cannot be overridden — the footage IS the frame, so its shape is
     * not a preference. Otherwise Lock Aspect chooses between a pinned value and the live pane,
     * which drifts every time the window is resized and would otherwise make HFOV wander while
     * nothing about the camera changed.
     */
    get fovAspect() {
        const video = this.videoAspect();
        if (video !== undefined) return video;
        if (this.lockAspect) return this.lockedAspect;
        return this.liveAspect() ?? this.lockedAspect;
    }

    /** True when the aspect is dictated by a video, so Lock Aspect is not the user's to set. */
    get aspectForcedByVideo() {
        return this.videoAspect() !== undefined;
    }

    get hfov() {
        const a = this.fovAspect;
        if (!(a > 0) || !(this.fov > 0)) return 0;
        return 2 * degrees(Math.atan(a * Math.tan(radians(this.fov) / 2)));
    }

    set hfov(h) {
        const a = this.fovAspect;
        if (!(a > 0) || !(h > 0)) return;
        const v = 2 * degrees(Math.atan(Math.tan(radians(h) / 2) / a));
        // Same bounds as the vertical slider, so driving from either end cannot leave the camera
        // somewhere the other control could not have reached.
        this.fov = Math.min(170, Math.max(0.0001, v));
    }

    /**
     * The lens that would give this field of view on a 36x24mm full-frame camera - the number
     * photographers actually think in. A third view of the one stored angle, like hfov, so all
     * three sliders always agree.
     *
     * Anchored on the frame's LONG axis, against the gate's long side (36mm). The rule this
     * expresses is "the number must not move unless the frame was actually CROPPED":
     *
     *   3:2 still -> 16:9 video   same lens, top and bottom cut off. The long axis is still the
     *                             36mm one, so the number holds. (24mm reads 24mm both ways.)
     *   landscape -> portrait     same lens, same sensor, nothing cropped - only turned. The long
     *                             axis is still the 36mm one, so the number holds. (85mm reads
     *                             85mm both ways.)
     *
     * Anchoring on the WIDTH instead gets the first case right and the second wrong - it would
     * call that portrait 85mm a 127mm lens. The manufacturers' diagonal convention gets the second
     * right and the first wrong - it would call the 16:9 clip a 25.1mm lens. Only the long axis
     * gets both, because only it tracks what a crop actually removes.
     *
     * The one edge: "longer axis" flips at exactly square. Nothing real is shot that close to 1:1.
     */
    get focal35() {
        // Which angle spans the long axis of the frame as displayed.
        const angle = this.fovAspect >= 1 ? this.hfov : this.fov;
        if (!(angle > 0) || angle >= 180) return 0;
        const halfAngleTan = Math.tan(radians(angle) / 2);
        if (!(halfAngleTan > 0)) return 0;
        return (FULL_FRAME_LONG_MM / 2) / halfAngleTan;
    }

    set focal35(f) {
        if (!(f > 0)) return;
        const angle = 2 * degrees(Math.atan((FULL_FRAME_LONG_MM / 2) / f));
        if (this.fovAspect >= 1) {
            // Landscape: the long axis is horizontal, and hfov's setter already clamps the
            // vertical result into the same range the other two sliders stop at.
            this.hfov = angle;
        } else {
            // Portrait: the long axis IS the vertical one, so this is the stored angle directly.
            this.fov = Math.min(170, Math.max(0.0001, angle));
        }
    }

    /**
     * Grey out Lock Aspect while a video owns the aspect, and show it ticked, because that is
     * what is actually happening. A checkbox that stays unticked while the value it controls is
     * being overridden reads as the app ignoring it.
     *
     * Called every frame from apply(), so a video dropped in later takes effect; the controller
     * is only touched when the state actually changes.
     */
    updateAspectLockAvailability() {
        if (!this.lockAspectController) return;
        const forced = this.aspectForcedByVideo;
        if (forced === this._aspectLockForced) return;
        this._aspectLockForced = forced;
        if (forced) {
            // Remember what the user had, so unloading the video puts it back rather than
            // leaving the tick behind as a setting they never made.
            this._userLockAspect = this.lockAspect;
            this.lockAspect = true;
        } else if (this._userLockAspect !== undefined) {
            this.lockAspect = this._userLockAspect;
            this._userLockAspect = undefined;
        }
        this.lockAspectController.enable(!forced);
    }

    /**
     * Refresh the read-only lens readout from the loaded photo's EXIF, and show the row only
     * when there is something to show - a permanent "-" in a sitch with no photo is clutter.
     *
     * Called every frame from apply(), so the GUI is only touched when the text actually
     * changes; show()/hide() and a string write on every frame would be wasted layout work.
     */
    updateLensReadout() {
        const meta = NodeMan.get("video", false)?.videoData?.importMetadata;
        const focal = meta?.optics?.focalLengthMm;
        const model = meta?.camera?.lensModel;

        let text = "";
        if (focal > 0 && model) text = `${+focal.toFixed(1)} mm  (${model})`;
        else if (focal > 0) text = `${+focal.toFixed(1)} mm`;
        else if (model) text = model;

        if (text === this._lensText) return;
        this._lensText = text;
        this.lensDisplay = text || "-";
        if (this.lensController) {
            if (text) this.lensController.show(); else this.lensController.hide();
        }
    }

    /** Refresh the read-only readout: the ratio, plus what it is in human terms. */
    updateAspectReadout() {
        const a = this.fovAspect;
        if (!(a > 0)) { this.aspectDisplay = "-"; return; }
        const videoNode = NodeMan.get("video", false);
        const w = videoNode?.originalVideoWidth ?? 0;
        const h = videoNode?.originalVideoHeight ?? 0;
        // The video's own pixel dimensions say more than any named ratio, and say it exactly:
        // a clip that is 1440x1080 stretched to 16:9 is a thing that happens.
        const note = (this.aspectForcedByVideo && w > 0 && h > 0)
            ? `${w}×${h}` : nameAspect(a);
        this.aspectDisplay = note ? `${a.toFixed(4)}  (${note})` : a.toFixed(4);
    }

    modSerialize() {
        return {
            ...super.modSerialize(),
            az: this.az,
            el: this.el,
            fov: this.fov,
            lockAspect: this.lockAspect,
            lockedAspect: this.lockedAspect,
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
        this.lockAspect = v.lockAspect ?? false;
        this.lockedAspect = v.lockedAspect ?? 16 / 9;
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

        // Which camera node this is, so liveAspect can find the pane it renders into. Recorded
        // here rather than in the constructor because the controller is attached to the camera
        // after it is built.
        this._objectNode = objectNode;
        this.updateAspectLockAvailability();
        this.updateAspectReadout();
        this.updateLensReadout();
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
    // dragFov: the on-screen field the drag rate scales with — the pinhole fov by
    // default; the caller passes the fisheye's equivalent FOV when that render is on.
    applySatelliteMouseDelta(xRotate, yRotate, dragFov = this.fov) {
        if (this._satQuatDirty) {
            this.buildSatQuatFromAngles();
        }

        const fovScale = dragFov / 45;

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
                        let roll = -Math.atan2(sinAngle, cosAngle) * 180 / Math.PI;
                        // Snap float noise to a hard zero (see syncFromCamera).
                        if (Math.abs(roll) < 1e-6) roll = 0;
                        this.roll = roll;
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
                    let roll = -Math.atan2(sinAngle, cosAngle) * 180 / Math.PI;
                    // atan2 of near-parallel vectors returns float noise
                    // (~1e-13°) instead of 0, which then shows in — and saves
                    // from — the Roll slider. Below a micro-degree IS zero.
                    if (Math.abs(roll) < 1e-6) roll = 0;
                    this.roll = roll;
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
        // headingArray is only populated once setHeadingFile() has loaded a
        // file. Before that, fall back to the manual heading value (the
        // fallback input is jetHeadingManual, a GUIValue) so the data graph
        // still produces a valid number — otherwise readers like
        // CNodeJetTrack.recalculate crash on `undefined[0]`.
        if (this.headingArray) return this.headingArray[f];
        if (this.fallback) {
            return this.fallback.getValueFrame
                ? this.fallback.getValueFrame(f)
                : (this.fallback.value ?? 0);
        }
        return 0;
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
