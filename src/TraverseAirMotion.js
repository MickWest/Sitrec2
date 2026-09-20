import {KNOTS_TO_MS, trackMetrics} from "./TraverseAnalysis";
import {datasetForSolvedModelWind} from "./TraverseHypotheses";
import {datasetWithWindCorrection} from "./TraverseWind";

export const AIR_MOTION_BASIS = "Horizontal air speed is motion relative to the wind in the local horizontal plane. "
    + "Vertical air speed is signed motion through the air: + up, − down, in ft/min. "
    + "Both use the analysis frame and this candidate’s wind assumption, including any supplied vertical wind. "
    + "Fitted wind models assume zero vertical wind.";

export function candidateWindDataset(dataset, h) {
    if (h.windMode === "corrected") return datasetWithWindCorrection(dataset,
        h.params.windCorrectionE, h.params.windCorrectionN);
    if (h.windMode === "fitted") return datasetForSolvedModelWind(dataset, h.track, h.params, h.key);
    return dataset;
}

// Ground-frame fits do not infer wind. Condition their displayed air motion on
// the supplied wind, without changing the fit or its ground-frame judging.
// Recompute older cached metrics when the component series were not retained.
export function candidateAirMetrics(dataset, h) {
    if (h.atInfinity) return null;
    const m = h.metricsFull;
    if (h.params?.motionFrame !== "ground" && m?.verticalAirSpeed && m?.horizontalAirSpeed
        && m.series?.horizontalAirSpeed && m.series?.verticalAirSpeed) return m;
    if (!(dataset?.n >= 7 && dataset.fps > 0) || !dataset.S || !dataset.W
        || h.track?.length !== dataset.n * 3) return null;
    return trackMetrics(candidateWindDataset(dataset, h), h.track);
}

export const horizontalAirText = v => Number.isFinite(v) ? `${(v / KNOTS_TO_MS).toFixed(1)} kt` : "Unavailable";
export const verticalAirText = v => {
    if (!Number.isFinite(v)) return "Unavailable";
    const fpm = Math.round(v / 0.3048 * 60);
    return `${fpm > 0 ? "+" : ""}${fpm === 0 ? 0 : fpm} fpm`;
};

export function airMotionRows(dataset, h) {
    const m = candidateAirMetrics(dataset, h);
    const horizontal = m?.horizontalAirSpeed, vertical = m?.verticalAirSpeed;
    return [
        ["Horizontal air speed (mean / max)", horizontal && [horizontal.mean, horizontal.max].every(Number.isFinite)
            ? `${(horizontal.mean / KNOTS_TO_MS).toFixed(1)} / ${(horizontal.max / KNOTS_TO_MS).toFixed(1)} kt` : "Unavailable"],
        ["Vertical air speed (mean / range)", vertical && [vertical.mean, vertical.min, vertical.max].every(Number.isFinite)
            ? `${verticalAirText(vertical.mean)} / ${verticalAirText(vertical.min).replace(" fpm", "")} to ${verticalAirText(vertical.max)}` : "Unavailable"],
    ];
}
