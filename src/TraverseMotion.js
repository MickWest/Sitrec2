// Balloon kinematic signature. A passive wind tracer moves on a SINGLE steady
// vertical trend — rising (constant lift), level (neutral buoyancy) or descending
// (leak/cooling) — and drifts in essentially ONE direction (the wind, which may
// slowly veer with altitude). Vertical oscillation (up then down) and circling
// are strong evidence AGAINST a balloon; a drone can do either, a balloon cannot.
//
// Returns C in [0,1]: 1 = textbook balloon motion, 0 = the opposite. Measured
// self-contained from the solved track as net displacement / path length per
// axis group — 1 when monotonic/straight, → 0 when the path doubles back on
// itself. Complements straightFlightScore (already in secondaryScore), which
// prices horizontal manoeuvring but NOT vertical monotonicity — the distinctive
// balloon tell. A near-level or near-hovering axis is treated as neutral, not
// penalised: calm-wind and neutrally-buoyant balloons are ordinary.
export function balloonMotion(track) {
    if (!track || track.length < 6) return null;
    const n = Math.floor(track.length / 3);
    let vPath = 0, hPath = 0;
    let prevX = track[0], prevY = track[1], prevZ = track[2];
    for (let f = 1; f < n; f++) {
        const x = track[f * 3], y = track[f * 3 + 1], z = track[f * 3 + 2];
        vPath += Math.abs(z - prevZ);
        hPath += Math.hypot(x - prevX, y - prevY);
        prevX = x; prevY = y; prevZ = z;
    }
    const vNet = Math.abs(track[(n - 1) * 3 + 2] - track[2]);
    const hNet = Math.hypot(track[(n - 1) * 3] - track[0], track[(n - 1) * 3 + 1] - track[1]);
    // Below this total travel an axis has essentially not moved: level flight,
    // or a hover. Neither is un-balloon-like, so score it neutral rather than
    // letting 0/0 noise decide. The vertical threshold scales with the horizontal
    // extent (min 20 m) so a 19 m vs 21 m path does not straddle a fixed boundary
    // and a long, far-drifting clip is judged on the same relative footing (TA-18);
    // a true hover (tiny horizontal travel) still uses the absolute floor.
    const LEVEL_EPS = 20; // metres — absolute floor
    const vLevelEps = Math.max(LEVEL_EPS, 0.02 * hPath);
    const vDir = vPath < vLevelEps ? 1.0 : vNet / vPath;     // level or monotonic → 1
    const hDir = hPath < LEVEL_EPS ? 0.5 : hNet / hPath;     // straight drift → 1, circling → 0
    // A balloon needs BOTH: a steady vertical trend AND a one-direction drift.
    // Take the weaker of the two, not their average — a monotonic climb does not
    // excuse a circling ground track, nor a straight drift a vertical yo-yo.
    return {horizontalPathM: hPath, horizontalNetM: hNet, horizontalDirectness: hDir,
        verticalPathM: vPath, verticalNetM: vNet, verticalDirectness: vDir,
        consistency: Math.max(0, Math.min(1, Math.min(vDir, hDir)))};
}

export function balloonConsistency(track) {
    return balloonMotion(track)?.consistency ?? 0.5;
}

// Frame numbers are relative to the analysis window. Truth metrics can cover
// a shorter valid run, so its first sample may belong to a later frame.
export function accelerationAtFrame(metrics, frame) {
    const index = frame - (metrics?.sampleWindow?.frameOffset ?? 0);
    const value = Number.isInteger(index) && index >= 0 ? metrics?.series?.gLoad?.[index] : null;
    return Number.isFinite(value) ? value : null;
}

// Local acceleration maxima, largest first, using the same trimmed samples
// as Max g-Force. Collapse a flat peak to its midpoint and suppress nearby
// maxima so one manoeuvre cannot supply all three chart labels. The renderer
// also checks separation after projection and chooses at most three per path.
export function accelerationPeaks(metrics, fps) {
    const values = metrics?.series?.gLoad;
    if (!values?.length) return [];
    const {lo = 0, hi = values.length, frameOffset = 0} = metrics.sampleWindow ?? {};
    const candidates = [];
    for (let f = lo; f < hi; f++) {
        const value = values[f];
        if (!Number.isFinite(value) || value <= 0) continue;
        let end = f;
        while (end + 1 < hi && values[end + 1] === value) end++;
        const before = f > lo && Number.isFinite(values[f - 1]) ? values[f - 1] : -Infinity;
        const after = end + 1 < hi && Number.isFinite(values[end + 1]) ? values[end + 1] : -Infinity;
        if (value > before && value > after) {
            candidates.push({frame: Math.floor((f + end) / 2) + frameOffset, value});
        }
        f = end;
    }
    candidates.sort((a, b) => b.value - a.value || a.frame - b.frame);
    const separation = Math.max(Number.isFinite(fps) ? fps : 1, (hi - lo) * 0.05);
    const peaks = [];
    for (const peak of candidates) {
        if (peaks.every(other => Math.abs(other.frame - peak.frame) >= separation)) peaks.push(peak);
    }
    return peaks;
}
