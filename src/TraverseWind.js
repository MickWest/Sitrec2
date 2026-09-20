// Shared environmental assumptions, separate from vehicle performance limits.
// Sigma is a regularization scale, not measured weather uncertainty.
export const WIND_SEARCH_LIMIT_MS = 40;
export const WIND_PRIOR_SIGMA_MS = 20;
export const DEFAULT_WIND_CORRECTION_SIGMA_MS = 7.71666; // 15 kt, analyst assumption
export const windPriorCost = (u, v) => (u * u + v * v) / WIND_PRIOR_SIGMA_MS ** 2;

export function datasetWithWindCorrection(dataset, u, v) {
    const W = Float64Array.from(dataset.W);
    for (let f = 0; f < dataset.n; f++) {
        W[f * 3] += u / dataset.fps;
        W[f * 3 + 1] += v / dataset.fps;
    }
    return {...dataset, W};
}

export function formatWind(w) {
    if (!w || !Number.isFinite(w.u) || !Number.isFinite(w.v)) return "Not determined";
    const speed = Math.hypot(w.u, w.v) / 0.514444;
    if (speed < 0.05) return "Calm";
    const from = (Math.atan2(-w.u, -w.v) * 180 / Math.PI + 360) % 360;
    return `${speed.toFixed(1)} kt from ${Math.round(from) % 360}°`;
}

/** Return a snapshot with constant east/north wind velocity, in m/s. */
export function datasetWithConstantWind(dataset, windE, windN) {
    const W = new Float64Array(dataset.n * 3);
    for (let f = 0; f < dataset.n; f++) {
        W[f * 3] = windE / dataset.fps;
        W[f * 3 + 1] = windN / dataset.fps;
    }
    return {...dataset, W};
}

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
