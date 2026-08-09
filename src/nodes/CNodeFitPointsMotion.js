// The camera sources behind "Fit Keyframe Motion".
//
// When "Fit Camera to Points" holds two or more keyframes, each with a solved camera, these
// three thin nodes expose that solution set as ordinary camera sources: a position track for
// the Position dropdown, a heading controller for the Heading dropdown, and an FOV value node
// for the FOV dropdown — all reading interpolateFitCamera (FitKeyframeMotion) live, so a
// re-solve of any keyframe changes the motion with no rebake.
//
// They are deliberately three SEPARATE options rather than one bundle, because the switches are
// per-aspect: a user can fly the position between keyframes while keeping the FOV manual, or
// take just the heading. The "Fit Keyframe Motion" button selects all three at once.
//
// Lifecycle rules here are copied from the Star Track camera options, which solved the same
// problems first:
//
//   - The heading controller is attached DIRECTLY to lookCamera and gated by the Heading
//     switch. A lookCamera controller that is not a switch option is not gated by anything, and
//     an ungated absolute-pose controller silently clobbers whichever heading source is
//     selected (the documented customAzElController hazard) — so its enabled flag is set to the
//     truth explicitly at attach time rather than left to the next switch recalculate.
//
//   - Tracking Wobble must stay LAST in the apply order. This controller writes an absolute
//     orientation, and it is attached at runtime — after the wobble — so without the reorder
//     the wobble would land before it and be wiped every frame.
//
//   - Detaching selects the fallback option while ours is still an input. removeOption's own
//     fallback runs after removal, when the switch can no longer reach the removed controller
//     to disable it — which would leave it enabled, invisible, and applying forever.

import {CNode} from "./CNode";
import {CNodeControllerAzElZoom} from "./CNodeControllerPTZUI";
import {NodeMan, Sit} from "../Globals";
import {Vector3} from "three";
import {extractFOV} from "../FOVUtils";

/** Switch option keys. Position and FOV follow the camelCase key convention of their switches
 * ("fixedCamera", "userFOV") with a display label; the Heading switch uses human-readable keys
 * ("Manual", "To Target", "Star Track"), so there the key IS the label. */
export const FIT_POINTS_TRACK_OPTION = "fitPoints";
export const FIT_POINTS_HEADING_OPTION = "Fit Points";
export const FIT_POINTS_FOV_OPTION = "fitPoints";
const OPTION_LABEL = "Fit Points";

const TRACK_ID = "fitPointsPositionTrack";
const HEADING_ID = "fitPointsHeadingController";
const FOV_ID = "fitPointsFOV";

/** Camera position: the solved keyframe positions, linearly interpolated. */
class CNodeFitPointsPositionTrack extends CNode {
    constructor(v) {
        super(v);
        this.fitNode = v.fitNode;
        this.frames = Sit.frames;
        this.useSitFrames = true;
        // The camera-track smoother passes a lazy track through un-baked (see
        // CNodeSmoothedPositionTrack). Baking and filtering this path would round the corners
        // at the keyframes and shift the endpoints, and "constant speed between the solved
        // cameras" is the entire promise the Fit Keyframe Motion button makes.
        this.lazyInterpolated = true;
        this._lastGood = null;
    }

    recalculate() {
        this.frames = Sit.frames;
    }

    getValueFrame(f) {
        const s = this.fitNode?.interpolatedState(f);
        if (s) {
            this._lastGood = new Vector3(s.position[0], s.position[1], s.position[2]);
            return {position: this._lastGood.clone()};
        }
        if (this._lastGood) return {position: this._lastGood.clone()};
        // No keyframe carries a solution — the fit node's invariants keep this from happening
        // while the option is offered, but a track must still answer. Do no harm: hold the
        // camera where it already is.
        const cam = NodeMan.get("lookCamera", false)?.camera;
        return {position: cam ? cam.position.clone() : new Vector3()};
    }
}

/** Camera heading: solved az/el/roll interpolated, applied through the same basis construction
 * the solver fitted against (CNodeControllerAzElZoom — see localFrameAt in the fit node). */
class CNodeControllerFitPointsHeading extends CNodeControllerAzElZoom {
    constructor(v) {
        super(v);
        this.fitNode = v.fitNode;
        this.relative = false;
        this.fov = 30;      // AzElZoom.apply requires one; overwritten on every apply
        this.roll = 0;
    }

    apply(f, objectNode) {
        const s = this.fitNode?.interpolatedState(f);
        if (!s) return;
        // Absolute pose. In relative mode the base class applies az/el on top of the camera's
        // existing heading, which would compound the solution with itself.
        this.relative = false;
        this.az = s.azDeg;
        this.el = s.elDeg;
        this.roll = s.rollDeg;
        // FOV comes from whatever the FOV switch says — the PTZ controller's exact rule — so
        // heading and FOV stay independently selectable.
        const fovSwitch = NodeMan.get("fovSwitch", false);
        this.fov = fovSwitch ? extractFOV(fovSwitch.getValue(f)) : s.vfovDeg;
        super.apply(f, objectNode);
    }
}

/** Camera FOV: the solved vertical FOVs, linearly interpolated. */
class CNodeFitPointsFOV extends CNode {
    constructor(v) {
        super(v);
        this.fitNode = v.fitNode;
        this.frames = Sit.frames;
        this.useSitFrames = true;
        this._lastGood = null;
    }

    recalculate() {
        this.frames = Sit.frames;
    }

    getValueFrame(f) {
        const s = this.fitNode?.interpolatedState(f);
        if (s) this._lastGood = s.vfovDeg;
        if (this._lastGood !== null) return this._lastGood;
        // No fitted keyframe has ever supplied an FOV — the interpolator serves only real
        // solves, and every keyframe may still be provisional. Hold the MANUAL FOV rather
        // than inventing a number, so selecting this source early changes nothing on screen.
        // Deliberately not cached: it keeps tracking the manual value until a solve arrives.
        const manual = NodeMan.get("fovUI", false)?.value;
        return Number.isFinite(manual) && manual > 0 ? manual : 30;
    }
}

/**
 * Put the "Fit Points" options into the three camera dropdowns, creating the nodes on first
 * use. Idempotent, and shared by the interactive path (Add Fit Keyframe reaching 2, the Fit
 * Keyframe Motion button) and by the fit node's modDeserialize — so a reloaded sitch takes
 * exactly the path a freshly built one does, and the switches' saved choices resolve through
 * CNodeSwitch's pendingChoice once the options exist.
 *
 * @param fitNode the CNodeFitCameraPoints instance the sources read from
 * @param select  when true, select all three options (the Fit Keyframe Motion button); when
 *                false the options are only registered, leaving the current or saved choices
 *                in charge — a sitch saved on Manual must come back on Manual.
 */
export function attachFitPointsMotion(fitNode, select = false) {
    const lookCamera = NodeMan.get("lookCamera", false);
    const posSwitch = NodeMan.get("cameraTrackSwitch", false);
    const headingSwitch = NodeMan.get("CameraLOSController", false);
    const fovSwitch = NodeMan.get("fovSwitch", false);
    if (!lookCamera || !posSwitch || !headingSwitch || !fovSwitch) return false;

    const track = NodeMan.get(TRACK_ID, false)
        ?? new CNodeFitPointsPositionTrack({id: TRACK_ID, fitNode});
    const heading = NodeMan.get(HEADING_ID, false)
        ?? new CNodeControllerFitPointsHeading({id: HEADING_ID, fitNode});
    const fovNode = NodeMan.get(FOV_ID, false)
        ?? new CNodeFitPointsFOV({id: FOV_ID, fitNode});
    // Keep the references current even when the nodes already existed.
    track.fitNode = fitNode;
    heading.fitNode = fitNode;
    fovNode.fitNode = fitNode;

    if (!lookCamera.inputs[HEADING_ID]) {
        lookCamera.addControllerNode(heading);
        // An absolute pose applied after Tracking Wobble would wipe the wobble; keep it last.
        lookCamera.moveControllerToEnd?.("trackingWobbleController");
    }

    if (posSwitch.inputs[FIT_POINTS_TRACK_OPTION] === undefined) {
        posSwitch.addOption(FIT_POINTS_TRACK_OPTION, track, OPTION_LABEL);
    }
    if (headingSwitch.inputs[FIT_POINTS_HEADING_OPTION] === undefined) {
        headingSwitch.addOption(FIT_POINTS_HEADING_OPTION, heading);
    }
    if (fovSwitch.inputs[FIT_POINTS_FOV_OPTION] === undefined) {
        fovSwitch.addOption(FIT_POINTS_FOV_OPTION, fovNode, OPTION_LABEL);
    }

    // AFTER the addOptions: registering an option can resolve a switch's pendingChoice, and
    // that quiet selection updates the choice without recalculating controller enablement —
    // so ask the switch what the choice ENDED UP as and set the flag to match. Left stale,
    // an enabled non-selected controller clobbers the real heading source every frame.
    heading.enableController(headingSwitch.choice === FIT_POINTS_HEADING_OPTION);

    if (select) {
        posSwitch.selectOption(FIT_POINTS_TRACK_OPTION);
        headingSwitch.selectOption(FIT_POINTS_HEADING_OPTION);
        fovSwitch.selectOption(FIT_POINTS_FOV_OPTION);
    }
    return true;
}

/**
 * Take the "Fit Points" options back out of the dropdowns — when the keyframe count drops
 * below two. The nodes stay registered (they are stateless readers); only the switches and the
 * gating change.
 */
export function detachFitPointsMotion() {
    const entries = [
        [NodeMan.get("cameraTrackSwitch", false), FIT_POINTS_TRACK_OPTION, "fixedCamera"],
        [NodeMan.get("CameraLOSController", false), FIT_POINTS_HEADING_OPTION, "Manual"],
        [NodeMan.get("fovSwitch", false), FIT_POINTS_FOV_OPTION, "userFOV"],
    ];
    for (const [sw, key, fallback] of entries) {
        if (!sw || sw.inputs[key] === undefined) continue;
        // Select the fallback while ours is still an input — see the header.
        if (sw.choice === key) {
            if (sw.inputs[fallback] !== undefined) sw.selectOption(fallback);
            else sw.selectFirstOption();
        }
        sw.removeOption(key, true);
    }
    // removeOption stops the switch MANAGING the enabled flag; it does not clear it. A stale
    // enabled=true would sit dormant and silently override Manual the moment the controller
    // has data again (the Star Track detach records the same lesson).
    NodeMan.get(HEADING_ID, false)?.enableController(false);
}
