// CNodeControllerTrackingWobble.js
//
// "Tracking Wobble": simulates a human operator manually keeping a target
// centered. The camera's pointing error wanders off-center (a smooth seeded
// random walk in pan/tilt); when it crosses the amplitude threshold the
// operator notices, and after a reaction delay slews the camera back toward
// center — imperfectly — then the drift resumes. Attached to the look camera
// after the pose controllers, so it layers on the final pointing (To Target,
// PTZ, etc.) and is a no-op when disabled.
//
// Deterministic: per-frame offsets are precomputed in recalculate() from a
// seeded PRNG — no Math.random(), so scrubbing, offline renders, and the
// LOS/MISB CSV export (CNodeLOSFromCamera re-runs the whole controller stack
// at arbitrary frames) all see identical camera poses, and the exported
// FrameCenter ground track matches the rendered video exactly.
//
// The apply() contract copies CNodeControllerCameraNudge: an un-apply guard
// so multiple applyControllers passes per frame can never accumulate the
// offset, then intrinsic rotateY(pan) followed by rotateX(tilt) in
// camera-local space.

import {CNodeController} from "./CNodeController";
import {guiMenus, Sit, setRenderOne} from "../Globals";
import {radians} from "../utils";
import {t} from "../i18n";
import {generateWobbleOffsets} from "../TrackingWobbleMath";

export class CNodeControllerTrackingWobble extends CNodeController {
    constructor(v) {
        super(v);

        // "wobbleEnabled" (not "enabled") — the base CNode "enabled" flag is
        // the applyControllers gate, and it must stay true so the un-apply
        // guard below always runs even while the wobble itself is off.
        this.wobbleEnabled = v.wobbleEnabled ?? false;
        this.amplitude = v.amplitude ?? 0.5;           // degrees off-center before the operator reacts
        this.driftSpeed = v.driftSpeed ?? 0.3;         // deg/s random drift
        this.reactionTime = v.reactionTime ?? 0.4;     // seconds
        this.correctionSpeed = v.correctionSpeed ?? 2; // deg/s recenter slew
        this.accuracy = v.accuracy ?? 0.7;             // 0..1 — how close a correction gets to center
        this.seed = v.seed ?? 1;
        this.simpleSerials.push("wobbleEnabled", "amplitude", "driftSpeed",
            "reactionTime", "correctionSpeed", "accuracy", "seed");

        // last quaternion we left the camera with (see apply)
        this._preQuat = null;
        this._postQuat = null;

        this.offsets = [];

        if (v.gui !== false && guiMenus.camera) {
            this.addGUI();
        }

        this.recalculate();
    }

    addGUI() {
        const folder = guiMenus.camera.addFolder(
            t("trackingWobble.folder", {defaultValue: "Tracking Wobble"})).close();
        this.guiFolder = folder;
        const onChange = () => {
            this.recalculate();
            setRenderOne(true);
        };
        folder.add(this, "wobbleEnabled").listen().onChange(onChange)
            .name(t("trackingWobble.enabled.label", {defaultValue: "Tracking Wobble"}))
            .tooltip(t("trackingWobble.enabled.tooltip", {defaultValue:
                "Simulate manual tracking: the camera drifts off the target and is imperfectly re-centered"}));
        folder.add(this, "amplitude", 0, 5, 0.01).listen().onChange(onChange)
            .name(t("trackingWobble.amplitude.label", {defaultValue: "Amplitude (deg)"}))
            .tooltip(t("trackingWobble.amplitude.tooltip", {defaultValue:
                "How far off-center (degrees) the drift gets before the operator reacts"}));
        folder.add(this, "driftSpeed", 0, 3, 0.01).listen().onChange(onChange)
            .name(t("trackingWobble.driftSpeed.label", {defaultValue: "Drift Speed (deg/s)"}))
            .tooltip(t("trackingWobble.driftSpeed.tooltip", {defaultValue:
                "Random drift rate away from the target"}));
        folder.add(this, "reactionTime", 0, 2, 0.05).listen().onChange(onChange)
            .name(t("trackingWobble.reactionTime.label", {defaultValue: "Reaction Time (s)"}))
            .tooltip(t("trackingWobble.reactionTime.tooltip", {defaultValue:
                "Operator delay between noticing the drift and starting the correction"}));
        folder.add(this, "correctionSpeed", 0.1, 10, 0.1).listen().onChange(onChange)
            .name(t("trackingWobble.correctionSpeed.label", {defaultValue: "Recenter Speed (deg/s)"}))
            .tooltip(t("trackingWobble.correctionSpeed.tooltip", {defaultValue:
                "How fast the operator slews back toward the target"}));
        folder.add(this, "accuracy", 0, 1, 0.01).listen().onChange(onChange)
            .name(t("trackingWobble.accuracy.label", {defaultValue: "Recenter Accuracy"}))
            .tooltip(t("trackingWobble.accuracy.tooltip", {defaultValue:
                "1 = corrections stop dead-center; lower values leave residual error"}));
        folder.add(this, "seed", 1, 9999, 1).listen().onChange(onChange)
            .name(t("trackingWobble.seed.label", {defaultValue: "Random Seed"}))
            .tooltip(t("trackingWobble.seed.tooltip", {defaultValue:
                "Change for a different (but still repeatable) wobble pattern"}));
    }

    recalculate() {
        this.frames = Sit.frames;
        this.offsets = this.wobbleEnabled
            ? generateWobbleOffsets(this, Sit.frames, Sit.fps)
            : [];
    }

    modDeserialize(v) {
        super.modDeserialize(v);
        // simpleSerials restored the params; rebuild the offset series (the
        // .listen() GUI controllers refresh their displays automatically)
        this.recalculate();
    }

    apply(f, objectNode) {
        const camera = objectNode.camera ?? objectNode._object;
        if (!camera) return;

        // applyControllers can run several times per frame (CNodeLOSFromCamera,
        // re-applies on deserialize, etc.). If the camera quaternion is exactly
        // what we left it at, nothing reset the pose since our last apply —
        // un-apply the previous offset first so it can never accumulate.
        if (this._postQuat && camera.quaternion.equals(this._postQuat)) {
            camera.quaternion.copy(this._preQuat);
        }
        this._postQuat = null;

        if (!this.wobbleEnabled) return;

        // Pose probes (e.g. the ground-track-switch target computation) want
        // the CLEAN boresight without tracking noise — skip the offset there
        // so the probed/cached result is independent of wobble parameters.
        if (objectNode._poseProbe) return;

        f = Math.max(0, Math.floor(f));
        if (f >= this.offsets.length) {
            // Sit.frames grew since the last recalculate (e.g. Sync Duration)
            this.recalculate();
            if (f >= this.offsets.length) return;
        }
        const o = this.offsets[f];
        if (!o) return;

        this._preQuat = camera.quaternion.clone();
        camera.rotateY(radians(o.pan));
        camera.rotateX(radians(o.tilt));
        camera.updateMatrix();
        this._postQuat = camera.quaternion.clone();
    }

    dispose() {
        if (this.guiFolder) {
            this.guiFolder.destroy();
            this.guiFolder = null;
        }
        super.dispose();
    }
}
