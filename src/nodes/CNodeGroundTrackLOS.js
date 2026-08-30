// Camera + Ground Track — a line-of-sight source built from the camera's position and a point
// on the ground, rather than from the camera's pointing and a pixel.
//
// The other two video-derived LOS sources (CNodeTrackingOverlay's "Camera + Object Track" and
// CNodeAutoTrackLOS's "Camera + Point Track") both start from the camera's centreline and rotate
// it by the angle a tracked PIXEL sits off centre — so both need the field of view AND where the
// camera was aimed, and are only as good as those.
//
// This one needs neither. Look at what getValueFrame below actually reads from the camera LOS: the
// POSITION, and nothing else. The ground point is a place, so the line of sight is the line from
// the camera to it, and no lens model or pointing solution can corrupt it. That dependency has not
// vanished, it has moved earlier — deciding WHICH piece of ground is behind the object is done by
// eye against the render, which does use both. But it is a judgement the analyst makes and can
// re-examine, not a calibration number hiding inside the arithmetic.
//
// One honest caveat, shared with every other LOS source here: the line is geometric, while the
// render (and the video) show a world bent by terrestrial refraction. The pick that produced the
// ground point already undid that bend — groundUnderCanvasPoint iterates until the point lands
// under the cursor ON SCREEN — so the stored place is right. Treating the ray onward from the
// camera as straight is the same simplification CNodeLOSFromCamera makes, and it is what the
// traverse machinery downstream expects.

import {CNode} from "./CNode";
import {Sit} from "../Globals";
import {assert} from "../assert";

export class CNodeGroundTrackLOS extends CNode {
    constructor(v) {
        super(v);
        this.input("cameraLOSNode");
        this.input("groundTrack");

        // LOS nodes always return {position, heading}, so CNode.getValue can skip its frame-0
        // probe — which for a camera LOS means a full controller pass per call.
        this.returnsPosition = true;

        // Must match Sit.frames so that a CNodeSwitch selecting this node reports a non-zero
        // frame count to the traverse nodes downstream, which iterate 0..LOS.frames.
        this.frames = Sit.frames;
        this.useSitFrames = true;
    }

    getValueFrame(f) {
        const los = this.in.cameraLOSNode.getValueFrame(f);

        // No points placed yet: fall back to the plain camera line of sight, so the option is
        // usable (and selectable) before the user has drawn anything. Same courtesy the point
        // tracker's adapter extends.
        const ground = this.in.groundTrack.getGroundPosition(f);
        if (!ground) return los;

        const heading = ground.clone().sub(los.position);
        const length = heading.length();
        // Degenerate only if the camera is sitting exactly on the ground point.
        if (!(length > 0)) return los;
        heading.divideScalar(length);

        assert(!isNaN(heading.x) && !isNaN(heading.y) && !isNaN(heading.z),
            "CNodeGroundTrackLOS:getValueFrame: heading is NaN at frame " + f);

        // up/right deliberately dropped: they described the camera's roll about its centreline,
        // which this heading is no longer along. Downstream consumers only use heading.
        return {position: los.position, heading, vFOV: los.vFOV};
    }
}
