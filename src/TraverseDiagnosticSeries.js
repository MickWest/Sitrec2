import {trackMetrics} from "./TraverseAnalysis";

// Truth positions are independent evidence. Air-relative truth diagnostics are
// conditional on the wind in `dataset`, just like the candidate they accompany.
export function losErrorSeriesDeg(dataset, track, valid = null) {
    const {n, S, D} = dataset;
    const out = new Float64Array(n).fill(NaN);
    for (let f = 0; f < n; f++) {
        if (valid && !valid[f]) continue;
        const b = f * 3;
        const rx = track[b] - S[b], ry = track[b + 1] - S[b + 1], rz = track[b + 2] - S[b + 2];
        const rl = Math.hypot(rx, ry, rz);
        if (rl < 1e-9) { out[f] = 180; continue; }
        const dot = Math.min(1, Math.max(-1, (rx * D[b] + ry * D[b + 1] + rz * D[b + 2]) / rl));
        out[f] = Math.acos(dot) * 180 / Math.PI;
    }
    return out;
}

export function truthDiagnosticSeries(dataset, truth) {
    if (!truth?.usable || !truth.track || truth.valid?.length < dataset.n || !truth.valid) return null;
    const keys = ["gLoad", "horizontalAirSpeed", "verticalAirSpeed"];
    const out = Object.fromEntries(keys.map(k =>
        [k, new Float64Array(dataset.n).fill(NaN)]));
    out.losError = losErrorSeriesDeg(dataset, truth.track, truth.valid);
    // Differentiate each contiguous valid run separately. Never turn held
    // positions outside truth coverage into zero speeds or spikes at a gap.
    let lo = -1;
    for (let f = 0; f <= dataset.n; f++) {
        if (f < dataset.n && truth.valid[f]) {
            if (lo < 0) lo = f;
            continue;
        }
        if (lo >= 0 && f - lo >= 7) {
            const slice3 = a => a.slice(lo * 3, f * 3);
            const ds = {...dataset, n: f - lo, S: slice3(dataset.S), D: slice3(dataset.D), W: slice3(dataset.W)};
            const m = trackMetrics(ds, slice3(truth.track));
            for (const key of keys) {
                for (let k = m.sampleWindow.lo; k < m.sampleWindow.hi; k++) out[key][lo + k] = m.series[key][k];
            }
        }
        lo = -1;
    }
    return out;
}
