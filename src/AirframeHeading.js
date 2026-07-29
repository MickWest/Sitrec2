// Deriving an airframe heading from a track's motion.
//
// Split out of CNodeWescamMXUI so it can be unit tested: the node itself pulls
// in three/addons via threeExt, which Jest can't load.

import {degrees} from "./utils";
import {getCompassHeading, getLocalUpVector} from "./SphericalMath";

// Squared metres-per-frame below which a track counts as not moving. 0.001 is
// 0.03 m/frame, under 2 knots at 30fps — no usable direction of travel.
export const MIN_HORIZONTAL_SPEED_SQ = 0.001;

// The component of v in the local horizontal plane.
function horizontal(v, up) {
    return v.clone().sub(up.clone().multiplyScalar(v.dot(up)));
}

// Heading in degrees true that the airframe is pointing, or null when the track
// gives us no usable direction of travel.
//
// Everything here works on the HORIZONTAL component of the velocity, because
// heading is a horizontal quantity. Testing the full 3D speed instead would let
// a purely vertical track (a balloon going straight up) through the guard, and
// getCompassHeading projects its forward vector onto the horizontal plane — so a
// vertical vector projects to zero and atan2(0,0) hands back a fabricated 000.
//
// windVector is optional; when given, heading is taken from the air velocity
// (ground velocity - wind), which is the direction the airframe actually points.
export function airframeHeadingFromVelocity(position, groundVelocity, windVector = null) {
    const up = getLocalUpVector(position);

    // Deliberately tested BEFORE the wind is removed. A fixed camera and an
    // aircraft holding station in wind produce identical track data — both are
    // stationary over the ground — so the wind-corrected direction cannot tell
    // them apart. The Custom sitch's default camera is a fixed one, and
    // reporting the wind direction as its heading is worse than reporting
    // nothing, so the ambiguous case resolves to "unknown".
    const groundHorizontal = horizontal(groundVelocity, up);
    if (groundHorizontal.lengthSq() <= MIN_HORIZONTAL_SPEED_SQ) return null;

    const airHorizontal = windVector
        ? groundHorizontal.sub(horizontal(windVector, up))
        : groundHorizontal;
    // wind can cancel the ground track exactly, leaving no direction again
    if (airHorizontal.lengthSq() <= MIN_HORIZONTAL_SPEED_SQ) return null;

    const headingRad = getCompassHeading(position, airHorizontal.normalize(), null);
    return ((degrees(headingRad) % 360) + 360) % 360;
}
