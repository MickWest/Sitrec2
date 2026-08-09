// Interpolation between fit keyframes — the maths behind "Fit Keyframe Motion".
//
// "Fit Camera to Points" can hold more than one keyframe: the same 3D landmarks observed at
// several video frames, each keyframe carrying its own 2D pixel positions and the camera the
// solver recovered from them. This module turns that list of solved cameras into a camera for
// ANY frame, by linear interpolation between the bracketing keyframes — so two keyframes make
// the camera fly between the two solutions at constant speed, which is exactly the promise the
// "Fit Keyframe Motion" button makes.
//
// Deliberately pure: plain numbers and arrays in, plain numbers and arrays out, no three.js and
// no node graph. That is what makes it testable in jest without dragging the renderer in, and
// what lets the three thin motion nodes (CNodeFitPointsMotion) share one implementation.

/**
 * Shortest-arc interpolation between two angles in degrees.
 *
 * Both azimuth and roll live on a circle: the solver can report one keyframe at +179 and the
 * next at -179, which are 2 degrees apart, not 358. Interpolating the raw numbers would swing
 * the camera almost all the way round between them.
 */
export function lerpAngleDeg(a, b, t) {
    const delta = ((b - a + 540) % 360) - 180;
    return a + delta * t;
}

/**
 * The camera at frame f, from the solved keyframe cameras.
 *
 * @param {Array} keyframes [{frame, solved: {position:[x,y,z] ECEF, azDeg, elDeg, rollDeg,
 *                           vfovDeg, fitted} | null}] — any order.
 * @param {number} f        frame number (fractional is fine)
 * @returns {object|null}   {position:[x,y,z], azDeg, elDeg, rollDeg, vfovDeg}, or null when no
 *                          keyframe carries a solution. Always fresh objects — never a caller's.
 *
 * Only FITTED solutions participate. A keyframe whose camera is null, or merely seeded from
 * wherever the live camera happened to be when it was created (fitted === false), is a guess
 * about the camera, not a statement — flying the camera through a guess would present motion
 * the landmarks never supported. Such keyframes are skipped until a solve upgrades them, and a
 * keyframe demoted by a failed refit drops back out for the same reason.
 *
 * Before the first usable keyframe and after the last the camera HOLDS the end solution rather
 * than extrapolating: the keyframes are statements about where the camera was, and the frames
 * beyond them carry no such statement — continuing the motion would invent one.
 */
export function interpolateFitCamera(keyframes, f) {
    const usable = (keyframes ?? [])
        .filter((k) => k.solved && k.solved.fitted !== false && Number.isFinite(k.frame))
        .sort((a, b) => a.frame - b.frame);
    if (usable.length === 0) return null;

    const cloneOf = (k) => ({
        position: k.solved.position.slice(),
        azDeg: k.solved.azDeg,
        elDeg: k.solved.elDeg,
        rollDeg: k.solved.rollDeg,
        vfovDeg: k.solved.vfovDeg,
    });

    if (f <= usable[0].frame) return cloneOf(usable[0]);
    const last = usable[usable.length - 1];
    if (f >= last.frame) return cloneOf(last);

    // Find the bracketing pair. The list is a handful of entries, so a scan is the right tool.
    let i = 0;
    while (usable[i + 1].frame < f) i++;
    const k0 = usable[i], k1 = usable[i + 1];
    if (k1.frame === k0.frame) return cloneOf(k0);   // duplicate frames: take the earlier
    const t = (f - k0.frame) / (k1.frame - k0.frame);

    const s0 = k0.solved, s1 = k1.solved;
    return {
        // Componentwise in ECEF: a straight line traversed at constant speed. Over the scales a
        // video camera moves this is indistinguishable from a geodesic, and "constant speed
        // straight line" is the behaviour the feature promises.
        position: [
            s0.position[0] + (s1.position[0] - s0.position[0]) * t,
            s0.position[1] + (s1.position[1] - s0.position[1]) * t,
            s0.position[2] + (s1.position[2] - s0.position[2]) * t,
        ],
        azDeg: lerpAngleDeg(s0.azDeg, s1.azDeg, t),
        elDeg: s0.elDeg + (s1.elDeg - s0.elDeg) * t,
        rollDeg: lerpAngleDeg(s0.rollDeg, s1.rollDeg, t),
        vfovDeg: s0.vfovDeg + (s1.vfovDeg - s0.vfovDeg) * t,
    };
}
