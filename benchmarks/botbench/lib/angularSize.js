// angularSize.js — the target's physical size, the sensor's field of view, and
// the angular-diameter bound that connects them.
//
// WHY THIS EXISTS. Bearings alone cannot determine range: scaling a trajectory
// along its own sightlines leaves every bearing unchanged while scaling every
// speed and acceleration down with it. A fit scored on residual and kinematic
// mildness therefore has no reason not to collapse toward the sensor, and
// measurement on the maneuver botsets showed exactly that — the reported range of most
// candidates was whichever guard constant their fitter carried.
//
// Apparent angular size is the missing observable. For an object of physical
// diameter D at range R the subtended angle is about D/R, so an UPPER bound on
// the observed angle gives a LOWER bound on range once a minimum plausible size
// for the object class is assumed:
//
//     R >= D_min / theta_max
//
// That is a bound, never an answer: bigger objects only push R further out, so
// R_min holds for the whole class. Publishing theta_max rather than the exact
// D/R is deliberate — the exact value would let any consumer that assumes a
// diameter read range straight off, which would dissolve the benchmark instead
// of informing it.
//
// FOV IS SIZED FROM THE SCENARIO, not fixed by fiat: a scenario whose target is
// a sub-pixel speck cannot exercise this channel at all. Each set asks for the
// target to subtend about FRAME_FRACTION_TARGET of the frame width at its
// nominal range, subject to the FOV staying inside a real targeting pod's
// range. Where a set has its own reason for a fixed FOV (the balloon botsets' drift ladder
// needs the target to stay in frame through a 0.5 deg slide) that FOV wins and
// the framing is whatever the physics gives — a 0.35 m party balloon at 80 km
// really is a fraction of a pixel, and inventing a 63 m balloon to fill the
// frame would be a lie about the object, not a better test.

// Frame width in pixels. Cameras vary; this is the figure the derived numbers
// are stated against, and it is exported so a consumer can rescale rather than
// having to guess what was assumed.
export const SENSOR_PIXELS = 640;

// The share of frame width the target should subtend at its nominal range.
// 1.5% of 640 px is about 10 px: comfortably resolved, still small enough to
// read as a blob rather than a shape.
export const FRAME_FRACTION_TARGET = 0.015;

// A real narrow-field targeting pod. Outside this band the sensor stops being
// plausible, so `fovForFraction` clamps rather than emitting a 38 deg "pod".
export const POD_FOV_MIN_DEG = 0.35;
export const POD_FOV_MAX_DEG = 4.0;

const DEG = 180 / Math.PI;

/**
 * The FOV at which an object of diameter D at range R subtends `frac` of the
 * frame width, clamped to a plausible pod. Clamping is silent by design: the
 * per-set diameter tables below are chosen so it does not bind, and
 * `fovFramingFraction` reports what was actually achieved so a caller can
 * assert on it.
 */
export function fovForFraction(diameterM, rangeM, frac = FRAME_FRACTION_TARGET) {
    if (!(diameterM > 0) || !(rangeM > 0) || !(frac > 0)) return POD_FOV_MAX_DEG;
    const thetaDeg = (diameterM / rangeM) * DEG;
    return Math.min(POD_FOV_MAX_DEG, Math.max(POD_FOV_MIN_DEG, thetaDeg / frac));
}

/** What share of frame width the object actually subtends at this FOV. */
export function fovFramingFraction(diameterM, rangeM, fovFullDeg) {
    if (!(diameterM > 0) || !(rangeM > 0) || !(fovFullDeg > 0)) return 0;
    return ((diameterM / rangeM) * DEG) / fovFullDeg;
}

/**
 * The upper bound on angular diameter a real measurement of this frame could
 * assert, in degrees.
 *
 * Two terms, both of them honest limits rather than noise:
 *   - a sub-pixel object still reads as about one pixel, so the bound can never
 *     be tighter than the IFOV however far away the object is;
 *   - one more pixel of margin for the measurement itself. A bright unresolved
 *     source blooms across neighbouring pixels, so an apparent extent always
 *     OVERSTATES the true size — which is the safe direction here, since
 *     overstating theta_max only weakens the range floor it implies.
 *
 * Returns the bound for a target at `rangeM`; pass a non-finite or zero range
 * for an effectively-infinite target and the bound falls back to the sensor
 * resolution alone, which is the correct statement for a point at infinity.
 */
export function angularDiameterMaxDeg(diameterM, rangeM, fovFullDeg,
    pixels = SENSOR_PIXELS) {
    if (!(fovFullDeg > 0) || !(pixels > 0)) return null;
    const ifovDeg = fovFullDeg / pixels;
    const thetaDeg = (diameterM > 0 && rangeM > 0) ? (diameterM / rangeM) * DEG : 0;
    return Math.max(thetaDeg, ifovDeg) + ifovDeg;
}

/**
 * MINIMUM PLAUSIBLE DIAMETER per object class, in metres. The floor of the
 * class, not a typical example: it is what turns an observed theta_max into a
 * range floor, and a floor built from a typical size would refute solutions
 * that are merely unusual rather than impossible.
 */
export const MIN_CLASS_DIAMETER_M = {
    bird: 0.10,
    balloon: 0.20,
    quadcopter: 0.20,
    fixedWing: 0.50,
};

/** R >= D_min / theta_max, in metres. The whole point of the column. */
export function minRangeForClass(classKey, thetaMaxDeg) {
    const d = MIN_CLASS_DIAMETER_M[classKey];
    if (!(d > 0) || !(thetaMaxDeg > 0)) return null;
    return d / (thetaMaxDeg / DEG);
}

/**
 * TRUE physical diameter per maneuver kind, in metres — answer-key material.
 *
 * Chosen with each kind's nominal RANGE held fixed (changing the ranges would
 * invalidate every existing truth key), so these are "what object could
 * plausibly be flying this shape at this distance and still frame sensibly".
 * At 5 km a pod frames 0.46-5.2 m; at 20 km, 1.8-21 m; at 100 km, 9.2-105 m.
 *
 * Assigned PER KIND rather than per variant on purpose: the s-turn and the
 * impossible sine wave must differ only in the manoeuvre, or a comparison
 * between them is confounded by the object.
 */
export const MANEUVER_DIAMETER_M = {
    // 5 km. A hovering point is a balloon; the rest are light-aircraft shapes.
    "static-point": 2.0,
    "zigzag": 3.0,
    "sine-wave": 5.0,
    "corkscrew": 5.0,
    "vertical-loop": 5.0,
    "figure-eight": 5.0,
    // 20 km. Light-aircraft span.
    "straight-cv": 10.0,
    "straight-ca": 10.0,
    "slow-turn": 10.0,
    "accel-instant": 10.0,
    "turn90-instant": 10.0,
    "highg-turn": 10.0,
    // 100 km. A vehicle large enough to frame at all at that distance.
    "hypersonic-glide": 12.0,
};

/** Physical diameter for the buoyant balloon-botset targets: a latex party balloon. */
export const BALLOON_DIAMETER_M = 0.35;
