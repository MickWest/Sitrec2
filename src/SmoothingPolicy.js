// Shared effective settings for calculation and the analysis processing summary.
export function metricSmoothingWindow(n, fps, options = {}) {
    const frames = options.smoothFrames ?? Math.max(3, Math.round((options.smoothSeconds ?? 0.5) * fps));
    return Math.max(1, Math.min(Math.floor(frames / 2), Math.floor((n - 5) / 2)));
}

export function trajectorySmoothingSettings(n, fps, options = {}) {
    const spacing = options.spacing ?? 6;
    const maxK = options.maxK ?? 34;
    const requestedK = Math.max(6, Math.min(maxK, options.K ?? (Math.round(n / (spacing * fps)) + 4)));
    return {
        K: Math.max(4, Math.min(requestedK, n)),
        curvature: options.curvature ?? 0.02 * n / requestedK,
    };
}
