// Camera + Point Track - An LOS source that uses the Point Track system (CObjectTracking,
// still "auto tracking" internally) to modify the camera's LOS so it passes through the
// tracked pixel in the video.
//
// This parallels CNodeTrackingOverlay.getValueFrame() (Manual Tracking, "Camera + Object
// Track") but reads the pixel position from the point tracker's trackedPositions
// (interpolated at non-keyframe frames) instead of from manually-placed keyframes. Both
// keep positions in original-video pixels, and both turn a pixel into a ray with the same
// function, videoPixelRay() in VideoPixelRay.js: a rectilinear pinhole whose focal length
// comes from the video's vertical FOV across the height of the frame as shown (after any
// rotation). The live canvas (its size, letterbox, zoom and pan) plays no part in the LOS.

import {CNode} from "./CNode";
import {NodeMan, Sit} from "../Globals";
import {assert} from "../assert";
import {extractFOV} from "./CNodeControllerVarious";
import {getObjectTracker} from "../CObjectTracking";
import {videoPixelRay} from "../VideoPixelRay";

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

    // The ray needs only the original video's pixel space, which is where the tracker
    // keeps its positions. Nothing about the video view's layout has to be ready.
    hasVideoGeometry() {
        const vv = this.getVideoView();
        if (!vv) return false;
        return vv.originalVideoWidth > 0 && vv.originalVideoHeight > 0;
    }

    getValueFrame(f) {
        const cameraLOSNode = this.in.cameraLOSNode;
        const fovNode = this.in.fovNode;
        const los = cameraLOSNode.getValueFrame(f);

        const videoView = this.getVideoView();
        const tracker = getObjectTracker();

        // Fall back to the plain camera LOS if prerequisites aren't met.
        // This keeps the option usable even before the user has started tracking.
        if (!tracker || !videoView || !this.hasVideoGeometry()) {
            return los;
        }

        // Auto tracker output stays in original source pixels, regardless of
        // the playback cap or analysis resolution.
        const pos = tracker.getInterpolatedPosition(Math.floor(f));
        if (!pos) return los;

        const vFOV = extractFOV(fovNode.getValueFrame(f));

        // If the camera LOS didn't supply up/right (some LOS sources don't), we can't build the ray.
        if (!los.up || !los.right || !los.heading) return los;

        los.heading = videoPixelRay(los, vFOV, pos.x, pos.y,
            videoView.originalVideoWidth, videoView.originalVideoHeight,
            videoView.videoData?.effectiveRotation ?? 0);
        // A tracked pixel can be a different object from the recorded
        // centreline target. It needs its own size observation.
        los.angularSize = null;
        // up and right are no longer valid after the tilted heading; downstream consumers only use heading.
        los.up = undefined;
        los.right = undefined;

        assert(!isNaN(los.heading.x) && !isNaN(los.heading.y) && !isNaN(los.heading.z),
            "CNodeAutoTrackLOS:getValueFrame: los.heading is NaN at frame " + f);

        return los;
    }
}
