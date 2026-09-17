// Anomalies2 keeps the maneuver taxonomy and adds downward starting views.
// The three long-range hypersonic cases retain their original ranges. Of
// the other twelve, six start at 45 degrees down and six at 75 degrees down.
import {fovForFraction} from "./angularSize";

export function anomalies2Depression(v) {
    if (v.kind === "hypersonic-glide") return null;
    const nearNadir = v.kind === "zigzag" || v.kind === "sine-wave"
        || v.kind === "figure-eight"
        || (v.kind === "highg-turn" && !v.parameters.leadIn)
        || (v.kind === "vertical-loop" && v.variant === "tooslow");
    return nearNadir ? 75 : 45;
}

export function anomalies2Spec(base, depressionDeg, errorLevel) {
    const platform = {...base.platform, altitudeAGL: 7000};
    if (depressionDeg === null) return {...base, platform};
    // Explicit altitudes match the existing maneuver defaults. Keeping them in
    // the spec makes the intended view reproducible if those defaults change.
    const targetAltitude = base.target.parameters.altitudeAGL
        ?? (["sine-wave", "figure-eight"].includes(base.target.kind) ? 1000
            : base.target.kind === "vertical-loop" ? 2000 : 3000);
    const height = platform.altitudeAGL - targetAltitude;
    const rangeM = height / Math.tan(depressionDeg * Math.PI / 180);
    const target = {...base.target, parameters: {...base.target.parameters, altitudeAGL: targetAltitude}};
    const fovFullDeg = fovForFraction(target.diameterM, Math.hypot(rangeM, height));
    return {...base, initialHorizontalRangeM: rangeM, platform, target,
        observation: errorLevel.observation(fovFullDeg)};
}

// Positive depression is down. Use clean truth geometry so the pointing-error
// rungs remain repeat observations of exactly the same view and target path.
export function anomalyViewStats(scenario) {
    const S = scenario.platform.positionENU, T = scenario.target.positionENU;
    const angles = [];
    for (let f = 0; f < scenario.n; f++) {
        const b = 3 * f;
        angles.push(Math.atan2(S[b + 2] - T[b + 2],
            Math.hypot(T[b] - S[b], T[b + 1] - S[b + 1])) * 180 / Math.PI);
    }
    const initialDeg = angles[0];
    const fractionAtLeast45 = angles.filter(a => a >= 45).length / angles.length;
    angles.sort((a, b) => a - b);
    return {initialDeg, minDeg: angles[0], medianDeg: angles[Math.floor(angles.length / 2)],
        maxDeg: angles[angles.length - 1], fractionAtLeast45};
}
