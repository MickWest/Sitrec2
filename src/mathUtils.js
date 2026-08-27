export function sin(x) {return Math.sin(x)}
export function cos(x) {return Math.cos(x)}
export function tan(x) {return Math.tan(x)}
export function asin(x) {return Math.asin(x)}
export function acos(x) {return Math.acos(x)}
export function atan(x) {return Math.atan(x)}
export function atan2(y,x) {return Math.atan2(y,x)}
export function abs(x) { return Math.abs(x)}
export function floor(x) { return Math.floor(x)}

export function radians(Value) { return Value * Math.PI / 180; }
export function degrees(Value) { return Value / (Math.PI / 180); }

// ---------------------------------------------------------------------------
// Azimuth conventions
//
// An azimuth is an angle on a circle, so 270 and -90 name the SAME direction.
// Sitrec stores one of the two spellings - the signed one, -180..180 - so that
// code which compares, differences, smooths or fits azimuths never has to ask
// which convention a number arrived in. The 0..360 compass spelling exists only
// where a number is shown to (or typed by) the user, and these two functions are
// the only place it is produced or consumed.
// ---------------------------------------------------------------------------

/**
 * Fold an azimuth into the signed -180..180 convention used internally.
 *
 * Both endpoints are deliberately left where they are: 180 stays 180 and -180
 * stays -180. They are the same direction, and snapping one onto the other would
 * make a slider jump from one end of its track to the other the instant a drag
 * reached the end.
 */
export function normalizeAzSigned(deg) {
    if (!Number.isFinite(deg)) return deg;
    // The guard is what preserves the endpoints; anything genuinely outside the
    // range is folded with a modulo rather than a loop, so a wild value (a
    // runaway accumulation, a bad import) costs the same as a small one.
    if (deg > 180 || deg < -180) {
        deg = ((deg + 180) % 360 + 360) % 360 - 180;
        // The fold ends in a subtraction that can land next to zero, where the input's
        // own representation error stops being invisible: 359.99 folds to
        // -0.009999999999990905, which is what a slider would then print. An azimuth is
        // never meaningfully finer than a nano-degree - that is 7 microns of aim at
        // 400 km - so the tail is noise, and rounding it off is what makes the trip out
        // to 0..360 and back land exactly where it started.
        deg = Number(deg.toFixed(9));
    }
    return deg;
}

/** The same azimuth written in the 0..360 compass convention. */
export function azTo360(deg) {
    const signed = normalizeAzSigned(deg);
    if (!Number.isFinite(signed)) return signed;
    return signed < 0 ? signed + 360 : signed;
}
