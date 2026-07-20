/**
 * Reconstruct the horizontal wind represented by a solved physics hypothesis.
 *
 * SkyLanternModel fits a quadratic change in each wind component across the
 * clip, then multiplies it by a clamped altitude-shear term. Keeping this pure
 * reconstruction in one place prevents metrics and disclosure UI from silently
 * describing different air masses.
 */
export function solvedHorizontalWindAt(solved, {
    modelKind = "lantern",
    normalizedTime = 0,
    altitudeM = 0,
    referenceAltitudeM = altitudeM,
} = {}) {
    if (!solved || !Number.isFinite(solved.windE) || !Number.isFinite(solved.windN)) {
        return null;
    }

    const finiteOrZero = (v) => Number.isFinite(v) ? v : 0;
    const s = Number.isFinite(normalizedTime) ? normalizedTime : 0;
    let u = solved.windE;
    let v = solved.windN;
    let multiplier = 1;

    if (modelKind === "lantern") {
        u += finiteOrZero(solved.windDriftE) * s
            + finiteOrZero(solved.windCurveE) * s * s;
        v += finiteOrZero(solved.windDriftN) * s
            + finiteOrZero(solved.windCurveN) * s * s;
        multiplier = 1 + finiteOrZero(solved.shearPerM)
            * (altitudeM - referenceAltitudeM);
        multiplier = Math.max(0.25, Math.min(3, multiplier));
    }

    return {u: u * multiplier, v: v * multiplier, multiplier};
}
