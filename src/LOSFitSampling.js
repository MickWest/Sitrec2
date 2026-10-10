// Optimizer observations are selected in seconds, independently of source fps.
// Explicit frame strides remain available for reproducibility and diagnostics.
export const LOS_FIT_SAMPLE_INTERVAL_SEC = 0.5;

export function losFitCostFrames({count, times = null, fps = null}, excluded = new Set(),
    {sampleIntervalSec = 0, sampleStride = null} = {}) {
    const active = [];
    for (let f = 0; f < count; f++) if (!excluded.has(f)) active.push(f);
    const at = f => times ? times[f] - times[active[0]] : (f - active[0]) / fps;
    const frames = [];
    if (sampleStride !== null) {
        if (!Number.isFinite(sampleStride) || sampleStride < 1) throw new Error("Invalid fit sample stride");
        for (let k = 0; k < active.length; k += Math.floor(sampleStride)) frames.push(active[k]);
    } else {
        if (!Number.isFinite(sampleIntervalSec) || sampleIntervalSec < 0) throw new Error("Invalid fit sample interval");
        // First measured sample at or after each interval. At sparse cadences
        // every sample qualifies; no interpolation invents extra observations.
        for (const f of active) {
            if (!frames.length || at(f) - at(frames[frames.length - 1]) >= sampleIntervalSec - 1e-6) frames.push(f);
        }
    }
    const last = active[active.length - 1];
    if (active.length && frames[frames.length - 1] !== last) frames.push(last);
    let maxGapSec = 0;
    for (let i = 1; i < frames.length; i++) maxGapSec = Math.max(maxGapSec, at(frames[i]) - at(frames[i - 1]));
    return {frames, sampling: {
        policy: sampleStride !== null ? "frame-stride" : sampleIntervalSec > 0 ? "time-interval" : "all-active",
        sampleIntervalSec: sampleStride !== null ? null : sampleIntervalSec,
        sampleStride: sampleStride !== null ? Math.floor(sampleStride) : null,
        activeCount: active.length, objectiveCount: frames.length, maxGapSec, frameIndices: frames,
    }};
}
