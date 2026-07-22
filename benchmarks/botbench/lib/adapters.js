// adapters.js — the three dataset views (PLAN.md "Module API"). The first two
// ALIAS the scenario's canonical buffers (no copies); the third is the ONLY
// compacting adapter, used solely for fitFixedPoint / fitFixedDirection which
// accept no exclusion set. Ordinary track metrics are never compacted —
// skipped frames would desync W and the fixed fps.

// LOSFitting.js dataset: {sensorPos, losDir, times, count, maxRange, minRange}.
// Caller passes scenario.observation.excluded to the LOS fitters.
export function toLOSDataset(scenario, {los = "observed"} = {}) {
    return {
        sensorPos: scenario.platform.positionENU,
        losDir: los === "clean"
            ? scenario.observation.cleanDirectionENU
            : scenario.observation.observedDirectionENU,
        times: scenario.times,
        count: scenario.n,
        maxRange: scenario.constraints.maxRangeM,
        minRange: scenario.constraints.minRangeM ?? undefined,
    };
}

// TraverseAnalysis.js dataset: {n, fps, S, D, W}.
export function toTraverseDataset(scenario, {los = "observed"} = {}) {
    return {
        n: scenario.n,
        fps: scenario.fps,
        S: scenario.platform.positionENU,
        D: los === "clean"
            ? scenario.observation.cleanDirectionENU
            : scenario.observation.observedDirectionENU,
        W: scenario.wind.displacementPerFrameENU,
    };
}

// Compacted active-frames-only Traverse dataset + the original frame indices.
export function toActiveTraverseDataset(scenario, {los = "observed"} = {}) {
    const src = los === "clean"
        ? scenario.observation.cleanDirectionENU
        : scenario.observation.observedDirectionENU;
    const inFov = scenario.observation.inFov;
    let count = 0;
    for (let f = 0; f < scenario.n; f++) if (inFov[f]) count++;

    const S = new Float64Array(count * 3);
    const D = new Float64Array(count * 3);
    const W = new Float64Array(count * 3);
    const frameIndices = new Uint32Array(count);
    let i = 0;
    for (let f = 0; f < scenario.n; f++) {
        if (!inFov[f]) continue;
        frameIndices[i] = f;
        for (let k = 0; k < 3; k++) {
            S[i * 3 + k] = scenario.platform.positionENU[f * 3 + k];
            D[i * 3 + k] = src[f * 3 + k];
            W[i * 3 + k] = scenario.wind.displacementPerFrameENU[f * 3 + k];
        }
        i++;
    }
    return {
        dataset: {n: count, fps: scenario.fps, S, D, W},
        frameIndices,
    };
}
