// Camera + Auto Track - An LOS source that uses the Auto Tracking system (CObjectTracking)
// to modify the camera's LOS so it passes through the auto-tracked pixel in the video.
//
// This parallels CNodeTrackingOverlay.getValueFrame() but reads the pixel position from
// the auto tracker's trackedPositions (interpolated at non-keyframe frames) instead of
// from manually-placed keyframes. The angular offset math is identical: convert the video
// pixel to canvas coords, compute offset from canvas center, convert to angles via the
// video's vertical FOV, and rotate the camera's heading by those angles.

import {CNode} from "./CNode";
import {NodeMan, Sit} from "../Globals";
import {assert} from "../assert";
import {radians} from "../utils";
import {extractFOV} from "./CNodeControllerVarious";
import {getObjectTracker} from "../CObjectTracking";

export class CNodeAutoTrackLOS extends CNode {
    constructor(v) {
        super(v);
        this.input("cameraLOSNode");
        this.input("fovNode");
        // videoView is looked up at eval time (it's not in the compute graph),
        // so we just store its ID here.
        this.videoViewID = v.videoView ?? "video";
        // Must match Sit.frames so that a CNodeSwitch whose current choice is this node
        // reports a non-zero frame count to downstream traverse/display nodes. Without this,
        // the Switch would set its own frames to 0 when this input is selected, and traverse
        // nodes (which iterate 0..LOS.frames) would produce empty arrays.
        this.frames = Sit.frames;
        this.useSitFrames = true;
    }

    getVideoView() {
        return NodeMan.get(this.videoViewID, false);
    }

    hasTrackData() {
        const tracker = getObjectTracker();
        return !!(tracker && tracker.trackedPositions && tracker.trackedPositions.size > 0);
    }

    hasVideoGeometry() {
        const vv = this.getVideoView();
        if (!vv) return false;
        return vv.videoWidth > 0 &&
            vv.videoHeight > 0 &&
            vv.originalVideoWidth > 0 &&
            vv.originalVideoHeight > 0;
    }

    ensureVideoGeometryReady() {
        if (!this.hasVideoGeometry()) return false;
        const vv = this.getVideoView();
        // Lazily refresh fovCoverage if the video view hasn't rendered yet this frame.
        if ((!Number.isFinite(vv.fovCoverage) || vv.fovCoverage <= 0) &&
            vv.widthPx > 0 && vv.heightPx > 0 && vv.getSourceAndDestCoords) {
            vv.getSourceAndDestCoords();
        }
        return Number.isFinite(vv.fovCoverage) && vv.fovCoverage > 0;
    }

    getValueFrame(f) {
        const cameraLOSNode = this.in.cameraLOSNode;
        const fovNode = this.in.fovNode;
        const los = cameraLOSNode.getValueFrame(f);

        const videoView = this.getVideoView();
        const tracker = getObjectTracker();

        // Fall back to the plain camera LOS if prerequisites aren't met.
        // This keeps the option usable even before the user has started tracking.
        if (!tracker || !videoView || !this.ensureVideoGeometryReady()) {
            return los;
        }

        const pos = tracker.getInterpolatedPosition(Math.floor(f));
        if (!pos) return los;

        let vFOV = extractFOV(fovNode.getValueFrame(f));

        // Adjust vFOV for the video's letterbox/pillarbox coverage — matches CNodeTrackingOverlay.
        vFOV = 180 / Math.PI * 2 * Math.atan(Math.tan(vFOV * Math.PI / 360) / videoView.fovCoverage);

        // Auto tracker output stays in original source pixels, regardless of
        // the playback cap or analysis resolution.
        //
        // Zero pan offset during conversion so the LOS uses unadjusted camera geometry independent
        // of any user pan on the video view (matches CNodeTrackingOverlay's approach).
        const savedPanX = videoView.panOffsetX;
        const savedPanY = videoView.panOffsetY;
        videoView.panOffsetX = 0;
        videoView.panOffsetY = 0;

        const [x, y] = videoView.videoToCanvasCoordsOriginal(pos.x, pos.y);

        videoView.panOffsetX = savedPanX;
        videoView.panOffsetY = savedPanY;

        // Offset from the center of the video view's canvas.
        let yoff = y - videoView.heightPx / 2;
        let xoff = x - videoView.widthPx / 2;

        // Scale by zoom (pan was zeroed above, so we only need to undo zoom).
        const zoom = (videoView.in?.zoom?.v(f) ?? 100) / 100;
        yoff /= zoom;
        xoff /= zoom;

        // Focal length in pixels, assuming canvas height corresponds to vFOV.
        const fpx = videoView.heightPx / (2 * Math.tan(radians(vFOV) / 2));

        const yangle = -Math.atan(yoff / fpx);
        const xangle = -Math.atan(xoff / fpx);

        const up = los.up;
        const right = los.right;
        const heading = los.heading;

        // If the camera LOS didn't supply up/right (some LOS sources don't), we can't rotate.
        if (!up || !right || !heading) return los;

        // Rotate heading and right by xangle about up, then rotate heading by yangle about new right.
        const newHeading = heading.clone().applyAxisAngle(up, xangle);
        const newRight = right.clone().applyAxisAngle(up, xangle);
        newHeading.applyAxisAngle(newRight, yangle);

        los.heading = newHeading;
        // up and right are no longer valid after the tilted heading; downstream consumers only use heading.
        los.up = undefined;
        los.right = undefined;

        assert(!isNaN(los.heading.x) && !isNaN(los.heading.y) && !isNaN(los.heading.z),
            "CNodeAutoTrackLOS:getValueFrame: los.heading is NaN at frame " + f);

        return los;
    }
}
