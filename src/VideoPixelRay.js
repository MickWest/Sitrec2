// Video pixel -> line of sight.
//
// Shared by the two video tracking LOS sources: Manual Tracking
// (CNodeTrackingOverlay, "Camera + Object Track") and Point Track
// (CNodeAutoTrackLOS, "Camera + Point Track"). Both store tracked positions in
// ORIGINAL-video pixels, so both turn a pixel into a ray the same way, here.
//
// Deliberately a leaf module, like AngularSizeMath: it imports nothing that
// reaches three or three/addons, so it stays Jest-testable. It works on the
// THREE.Vector3 objects a camera LOS carries through their own methods.

import {focalLengthPixels} from "./AngularSizeMath";

// Unit direction of the ray through original-video pixel (vx, vy), for a camera
// LOS carrying orthonormal heading/up/right and a vertical FOV in degrees.
// originalWidth/originalHeight are the dimensions of the original video, the
// pixel space that (vx, vy) is in, and rotation is the video's effective
// rotation (0, 90, 180 or 270). Returns a new vector; los is not modified.
//
// Angles are computed from the original-video pixel position and the shown
// frame's shape, never from the live canvas. The older paths round-tripped
// through it (letterbox fovCoverage, widthPx/heightPx from div.clientWidth, zoom,
// and a panOffset zero/restore hack that wrote to the video view during graph
// evaluation) purely to invert the display mapping. That made the physical LOS
// depend on window/layout state down to float rounding — and it mixed zoom.v0
// (inside the mapping) with zoom.v(f) (in the unscale).
//
// "Original-video pixels" are the SHOWN frame scaled per axis into the coded
// width x height (CNodeVideoView.videoToCanvasCoordsOriginal). For a video
// rotated 90 or 270 degrees the shown frame is coded-height wide and coded-width
// high, so that scaling is anisotropic and those pixels are not square. Map back
// to the shown frame first: its width is originalHeight and its height is
// originalWidth. The camera's vertical FOV spans the shown height, so the focal
// length is shownHeight / (2 tan(vFOV/2)). Without rotation both scale factors
// are exactly 1 and the result is unchanged to the bit.
//
// The ray itself is a true rectilinear pinhole projection. This replaced a
// yaw-then-pitch Euler construction — rotate heading by atan(dx/fpx) about up,
// then by atan(dy/fpx) about the new right — which is an EQUIRECTANGULAR
// mapping, not a pinhole one. Under it a vertical pixel step subtended the same
// angle everywhere in the frame, because the pitch was applied about the already
// yawed axis by an angle depending only on dy. A real lens compresses that step
// away from the vertical centre line, since the ray to an off-axis pixel is
// longer: the effective focal length in that plane is hypot(fpx, dx). At a 22.8°
// vertical FOV on a 1920x1080 frame the old mapping overstated a small vertical
// angle by 2.8% 640 pixels from the vertical centre line and by 6.2% at the side
// edge. At a 30° vertical FOV it put the corner pixels of a 1920x1080 frame
// 1.40° too far from the horizontal centre line. That error was invisible for a
// single tracked point near the centre but scales the whole LOS near the edges,
// and it directly corrupts angular-size ranging, which reads the local scale of
// the mapping rather than just a position.
export function videoPixelRay(los, vFOVDegrees, vx, vy, originalWidth, originalHeight, rotation = 0) {
    const swap = rotation === 90 || rotation === 270;
    // The shown frame, in original-video pixel units.
    const w = swap ? originalHeight : originalWidth;
    const h = swap ? originalWidth : originalHeight;
    const fpx = focalLengthPixels(vFOVDegrees, h);

    const dx = vx * (w / originalWidth) - w / 2;
    const dy = vy * (h / originalHeight) - h / 2;   // downward, as in image coordinates

    return los.heading.clone().multiplyScalar(fpx)
        .addScaledVector(los.right, dx)
        .addScaledVector(los.up, -dy)
        .normalize();
}
