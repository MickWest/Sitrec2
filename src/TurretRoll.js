// Image-plane roll for a camera on an IDEALISED TWO-AXIS AZIMUTH-ELEVATION mount.
//
// *** READ THIS BEFORE ASSUMING IT MODELS A REAL TURRET ***
// This is the pure two-axis geometry: azimuth about the aircraft's vertical, then
// elevation. Real WESCAM MX-series turrets are NOT two-axis — the MX-10 is an
// actively stabilised FOUR-axis system, and many such turrets roll-stabilise their
// image to a level horizon by design. So:
//   - what this computes is the UN-DEROTATED BASELINE that stabilisation is
//     measured against, not the output of a stabilised MX turret;
//   - if the footage you are matching has a level horizon while the aircraft
//     manoeuvres, the turret is stabilising and this roll should be scaled down or
//     off, not applied raw;
//   - a partially stabilised system is somewhere in between, which is why the
//     controller driving this exposes a scale factor rather than hard-wiring it.
// Match the result against the actual video before trusting it.
//
// WHY THIS EXISTS
// Sitrec already models a Raytheon ATFLIR, which is a ROLL-NOD gimbal: its first
// axis is the aircraft's LONGITUDINAL (nose-tail) axis. A WESCAM ball turret is an
// AZ-EL gimbal instead: its first axis is the aircraft's VERTICAL (yaw) axis, which
// tilts with the aircraft's bank and pitch. Because the camera is mounted on the
// aircraft, the rotations compound — turret angles are applied on top of the
// aircraft's attitude, exactly as the ATFLIR chain does.
//
// THE GEOMETRY, AND WHY IT IS ONLY THREE CROSS PRODUCTS
// The two gimbal types differ in which plane they trap the image's horizontal axis:
//
//   roll-nod : camera-right has zero component along the aircraft's LONGITUDINAL axis
//   az-el    : camera-right has zero component along the aircraft's VERTICAL axis
//
// For az-el that means the camera's "up" is always in the plane containing the line
// of sight and the aircraft's vertical. Slewing in azimuth then elevating is exactly
// what someone in the cockpit does when they turn their head while keeping it aligned
// with the aircraft — so the turret's image roll is identical to the "human horizon"
// angle, for every azimuth and elevation. Verified against the roll-nod chain, against
// Sitrec's own getHumanHorizonFromPitchRollAzEl, and against two independent
// derivations: agreement to ~1e-6 degrees (acos noise) over hundreds of attitudes.
//
// Consequences worth knowing, all verified numerically:
//   - wings level and level pitch  -> roll is exactly 0 at EVERY azimuth/elevation.
//     A ball turret in level flight needs no derotation at all; a roll-nod pod does.
//   - looking abeam (az = +/-90) AT ZERO ELEVATION -> roll is exactly 0 whatever the
//     bank, because the world-up tilt then lies along the line of sight and cannot
//     project into the image. This does NOT extend to all elevations: depress far
//     enough and the line of sight sweeps through world-nadir, where the level-up
//     reference inverts and the roll flips to 180 degrees. Measured at bank 30 /
//     az 90: 0 deg down to el -59, null exactly at el -60 (the LOS is world-vertical
//     there), then 180 deg beyond. That is correct - the image really is inverted
//     once you look past straight down - but do not quote the "abeam is zero" rule
//     without the elevation qualifier.
//   - looking straight ahead (az=0) -> az-el and roll-nod agree exactly.
//     They diverge to +/-90 degrees abeam.
//
// WHY NOT REUSE THE EXISTING CODE
// getHumanHorizonFromPitchRollAzEl and extractRollFromMatrix both hard-code world up
// as (0,1,0). That is valid only in the legacy flat local frame the Jet* code runs in.
// The custom sitch renders in ECEF, where up is getLocalUpVector(position). So the
// same geometry is done here coordinate-free with vectors: correct in ECEF, and with
// no Euler-angle singularities of its own.

import {Vector3} from "three";

// Reused scratch vectors — this runs per rendered frame.
const _right = new Vector3();
const _up = new Vector3();
const _levelRight = new Vector3();
const _levelUp = new Vector3();
// Separate scratch for aircraftUpVector so it can never clobber the roll calculation.
const _acRight = new Vector3();
const _bankAxis = new Vector3();

// Below this the two vectors are effectively parallel and the cross product is noise
// rather than a direction. sin(0.05 deg) ~ 8.7e-4.
export const PARALLEL_EPSILON = 8.7e-4;

// A vector length is usable only if it is finite AND non-zero. Both halves matter:
// zero slips through the parallel tests below (their threshold is scaled by these
// same lengths, so it becomes zero too), and Infinity passes any `> 0` test while
// normalising to NaN.
const usableLength = len => Number.isFinite(len) && len > 0;

/**
 * Signed image roll, in RADIANS, of an az-el turret's camera.
 *
 * Positive follows Sitrec's existing horizon convention (extractRollFromMatrix,
 * horizonAngle, getHumanHorizonFromPitchRollAzEl all agree): positive means the
 * horizon appears rotated counter-clockwise in the image, i.e. the aircraft is
 * banked right.
 *
 * @param {Vector3} los         line of sight, camera -> target (need not be unit)
 * @param {Vector3} aircraftUp  the aircraft's own up axis, i.e. world up at the
 *                              aircraft rotated by its bank about its forward axis
 * @param {Vector3} worldUp     local vertical at the camera (ECEF: getLocalUpVector)
 * @returns {number|null} roll in radians, or null where it is undefined —
 *          the turret's nadir/zenith keyhole (los parallel to aircraftUp) or the
 *          horizon degeneracy (los parallel to worldUp). Callers should leave the
 *          camera as they found it — at these look angles the roll is genuinely
 *          undefined, and there is no horizon to align to.
 */
export function azElTurretImageRoll(los, aircraftUp, worldUp) {
    // Reject degenerate inputs BEFORE the parallel tests below. Those tests scale
    // their threshold by the input lengths, so a zero-length input makes the
    // threshold zero too and `0 < 0` lets it through — the guard cannot detect its
    // own degeneracy. NaN slips past for the same reason (every comparison false).
    // `!(x > 0)` catches both zero and NaN. This matters in practice: duplicate
    // track samples give a zero velocity, which would otherwise be reported as a
    // roll of 0 — i.e. indistinguishable from level flight.
    const losLen = los.length();
    const acUpLen = aircraftUp.length();
    const worldUpLen = worldUp.length();
    if (!usableLength(losLen) || !usableLength(acUpLen) || !usableLength(worldUpLen)) {
        return null;
    }

    // The turret's image right: perpendicular to the LOS, lying in the aircraft's
    // horizontal plane. Undefined when looking straight up or down the turret's
    // azimuth axis — the ball-turret "nadir keyhole", a real limitation of this
    // gimbal type, not an artefact of the maths.
    _right.crossVectors(los, aircraftUp);
    if (_right.length() < PARALLEL_EPSILON * losLen * acUpLen) {
        return null;
    }
    _right.normalize();
    _up.crossVectors(_right, los).normalize();

    // The level reference: what the image up would be with the horizon flat.
    // Undefined when looking straight up or down in the WORLD, where "the horizon"
    // has no orientation. Distinct from the keyhole above.
    _levelRight.crossVectors(los, worldUp);
    if (_levelRight.length() < PARALLEL_EPSILON * losLen * worldUpLen) {
        return null;
    }
    _levelRight.normalize();
    _levelUp.crossVectors(_levelRight, los).normalize();

    // Signed angle from the level up to the turret's up, measured about the LOS.
    // atan2 of (component along levelRight, component along levelUp) is stable
    // everywhere, unlike acos which loses precision near zero.
    const y = _up.dot(_levelUp);
    const x = _up.dot(_levelRight);
    const angle = Math.atan2(x, y);

    // Sign: los x worldUp points to the camera's screen RIGHT (note this is the
    // opposite of extractRollFromMatrix's misleadingly-named `right`, which is built
    // from +zBasis, i.e. BACKWARD, and so points screen-left). A turret-up leaning
    // toward screen right is a right bank, giving positive — matching the convention
    // shared by extractRollFromMatrix, horizonAngle and
    // getHumanHorizonFromPitchRollAzEl. Verified by the "straight ahead" test, where
    // the roll must come out equal to the bank.
    return angle;
}

/**
 * The aircraft's own up axis: world up rotated about the aircraft's forward axis by
 * the bank angle. Pitch needs no separate treatment — it is already carried by the
 * forward vector, and the level-up is built perpendicular to it.
 *
 * @param {Vector3} forward   aircraft forward (velocity direction), need not be unit
 * @param {Vector3} worldUp   local vertical at the aircraft
 * @param {number}  bankRad   bank angle in radians, positive = right wing down
 * @param {Vector3} [out]     optional target
 * @returns {Vector3|null} unit aircraft-up, or null if forward is parallel to worldUp
 *          (vertical flight), where bank about the vertical is meaningless.
 */
export function aircraftUpVector(forward, worldUp, bankRad, out = new Vector3()) {
    // Same reasoning as azElTurretImageRoll: reject zero-length / NaN first, because
    // the parallel test below scales its threshold by these very lengths.
    const fwdLen = forward.length();
    const worldUpLen = worldUp.length();
    if (!usableLength(fwdLen) || !usableLength(worldUpLen) || !Number.isFinite(bankRad)) {
        return null;
    }

    // Capture the bank axis NOW, before anything writes to `out`. A caller may pass
    // out === forward (in-place update), and `out.crossVectors(...)` below would then
    // destroy `forward` before we could read it — silently producing an unbanked
    // up vector.
    _bankAxis.copy(forward).normalize();

    const right = _acRight.crossVectors(forward, worldUp);
    if (right.length() < PARALLEL_EPSILON * fwdLen * worldUpLen) {
        return null;
    }
    right.normalize();
    // Level up: perpendicular to forward, in the vertical plane through it. This is
    // where pitch enters — no explicit pitch angle is needed.
    out.crossVectors(right, forward).normalize();
    // Bank: rotate that up about the forward axis. Positive bank = right wing down,
    // so the up vector leans toward the aircraft's RIGHT.
    //
    // Sign check against the legacy convention (SphericalMath.js:32 does
    // `jetUp.applyAxisAngle(V3(0,0,1), -radians(jetRoll))`, where +Z is BACKWARD
    // since forward is -Z): rotating by -roll about backward is the same as
    // rotating by +roll about forward. Hence +bankRad here, not -bankRad.
    out.applyAxisAngle(_bankAxis, bankRad);
    return out;
}
