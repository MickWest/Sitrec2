/**
 * Blind Monte Carlo polynomial search using the LoS Tool CLI sampling model.
 * Unlike the existing CV-seeded MC traverses, ranges are uniform from zero to
 * min(MaxRange, maxDistance). The objective is mean angular error in radians,
 * over EVERY active observation. Range limits constrain samples, not the whole
 * fitted polynomial. No seed fit, optimizer polish, or frame subsampling.
 *
 * The per-trial PCG stream is shared with the GPU implementation. It has the
 * CLI's distributions, but does not reproduce NumPy's random sequence. Time
 * normalization and Newton interpolation represent the same polynomial as its
 * Vandermonde solve. Returned positions and residuals use double precision.
 */

export const MONTE_CARLO_PRESETS = Object.freeze(Object.fromEntries([
    ["mc_50k", 50000], ["mc_100k", 100000], ["mc_150k", 150000],
    ["mc_200k", 200000], ["mc_250k", 250000], ["mc_1M", 1000000],
].map(([id, numTrials]) => [id, Object.freeze({order: 1, losUncertaintyDeg: 0.1, numTrials})])));

export const MONTE_CARLO_IDS = Object.freeze(Object.keys(MONTE_CARLO_PRESETS));
export const MONTE_CARLO_SEED = 0x5eed1234;
export const monteCarloName = id => `Monte Carlo ${id.slice(3)} (GPU)`;

export function pcgHash(v) {
    const s = (Math.imul(v, 747796405) + 2891336453) >>> 0;
    const w = Math.imul((s >>> ((s >>> 28) + 4)) ^ s, 277803737) >>> 0;
    return ((w >>> 22) ^ w) >>> 0;
}

/** Accept either LOSFitting's dataset or BOTBench's {S,D,n,fps} dataset. */
export function prepareMonteCarloLOS(dataset, excluded = new Set(), options = {}) {
    const {preset} = options;
    if (preset !== undefined && !MONTE_CARLO_PRESETS[preset]) throw new Error(`Unknown Monte Carlo preset: ${preset}`);
    const opts = {...MONTE_CARLO_PRESETS.mc_50k, ...(preset ? MONTE_CARLO_PRESETS[preset] : {}), ...options};
    const {order, numTrials, losUncertaintyDeg} = opts;
    if (!Number.isInteger(order) || order < 1 || order > 5) throw new Error("Monte Carlo order must be 1 to 5");
    if (!Number.isInteger(numTrials) || numTrials < 1 || numTrials > 0xffffffff) {
        throw new Error("Monte Carlo numTrials must be a positive 32-bit integer");
    }
    if (!Number.isFinite(losUncertaintyDeg) || losUncertaintyDeg < 0 || losUncertaintyDeg > 180) {
        throw new Error("Monte Carlo LOS uncertainty must be 0 to 180 degrees");
    }
    if (opts.rangeEstimates != null) throw new Error("Blind Monte Carlo does not use range estimates");
    const count = dataset.count ?? dataset.n;
    const sensorPos = dataset.sensorPos ?? dataset.S, losDir = dataset.losDir ?? dataset.D;
    if (!Number.isInteger(count) || count < 0 || sensorPos?.length !== count * 3 || losDir?.length !== count * 3) {
        throw new Error("Invalid Monte Carlo dataset dimensions");
    }
    let times = dataset.times;
    if (!times && dataset.fps > 0) times = Float64Array.from({length: count}, (_, i) => i / dataset.fps);
    if (times?.length !== count || (dataset.maxRange && dataset.maxRange.length !== count)) {
        throw new Error("Invalid Monte Carlo times or ranges");
    }
    const active = [];
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < count; i++) {
        if (!Number.isFinite(times[i])) throw new Error("Monte Carlo times must be finite");
        for (let k = 0; k < 3; k++) {
            const v = sensorPos[i * 3 + k];
            if (!Number.isFinite(v)) throw new Error("Monte Carlo sensor positions must be finite");
            lo[k] = Math.min(lo[k], v); hi[k] = Math.max(hi[k], v);
        }
        if (excluded.has(i)) continue;
        const length = Math.hypot(losDir[i * 3], losDir[i * 3 + 1], losDir[i * 3 + 2]);
        if (!Number.isFinite(length) || Math.abs(length - 1) > 1e-4) throw new Error("Monte Carlo requires unit sightlines");
        if (active.length && times[i] <= times[active[active.length - 1]]) throw new Error("Monte Carlo active times must increase");
        active.push(i);
    }
    if (active.length < order + 1) return null;
    const maxDistance = opts.maxDistance ?? 10 * Math.max(1, ...hi.map((h, k) => h - lo[k]));
    if (!Number.isFinite(maxDistance) || maxDistance <= 0) throw new Error("Monte Carlo maxDistance must be positive and finite");
    const origin = Array.from(sensorPos.slice(active[0] * 3, active[0] * 3 + 3));
    const t0 = times[active[0]], span = times[active[active.length - 1]] - t0;
    // Local coordinates and dimensionless times keep f32 useful even for ECEF
    // positions and epoch timestamps. Keep the original f64 data for refinement.
    const table = new Float32Array(active.length * 8);
    active.forEach((fi, j) => {
        const mr = dataset.maxRange?.[fi];
        if (mr !== undefined && !Number.isFinite(mr)) throw new Error("Monte Carlo MaxRange must be finite");
        const b = j * 8;
        for (let k = 0; k < 3; k++) {
            table[b + k] = sensorPos[fi * 3 + k] - origin[k];
            table[b + 4 + k] = losDir[fi * 3 + k];
        }
        table[b + 3] = (times[fi] - t0) / span;
        table[b + 7] = mr > 0 ? Math.min(maxDistance, mr) : maxDistance;
        if (j && table[b + 3] <= table[b - 5]) throw new Error("Monte Carlo times are too close for GPU precision");
    });
    if (!table.every(Number.isFinite)) throw new Error("Monte Carlo data exceeds GPU precision");
    return {sensorPos, losDir, times, count, maxRange: dataset.maxRange, active, table, origin, t0, span,
        maxDistance, order, numTrials, losUncertaintyDeg, uncertainty: losUncertaintyDeg * Math.PI / 180,
        seed: (opts.seed ?? MONTE_CARLO_SEED) >>> 0};
}

function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function unit(a) { const r = Math.hypot(...a); return a.map(v => v / r); }

/** Reconstruct one trial in f64. Also used to refine GPU finalists. */
export function monteCarloTrial(prepared, trial) {
    const p = prepared, needed = p.order + 1;
    let state = pcgHash(p.seed ^ pcgHash(trial));
    const next = () => (state = pcgHash(state));
    const random = () => (next() >>> 8) / 16777216;
    const selected = [], ts = [], coeffs = [];
    for (let k = 0; k < needed; k++) {
        let rank = next() % (p.active.length - k);
        for (const prev of selected) if (rank >= prev) rank++;
        selected.push(rank); selected.sort((a, b) => a - b);
        const fi = p.active[rank], b = fi * 3;
        const d = Array.from(p.losDir.slice(b, b + 3));
        let perturbed = d;
        if (p.uncertainty > 1e-10) {
            const theta = random() * p.uncertainty, phi = random() * 2 * Math.PI;
            const abs = d.map(Math.abs), axis = [0, 0, 0];
            axis[abs.indexOf(Math.min(...abs))] = 1;
            const perp = unit(cross(d, axis)), dp = cross(d, perp);
            const rotated = unit(perp.map((v, j) => v * Math.cos(phi) + dp[j] * Math.sin(phi)));
            const tilt = cross(rotated, d);
            perturbed = d.map((v, j) => v * Math.cos(theta) + tilt[j] * Math.sin(theta));
        }
        const mr = p.maxRange?.[fi], limit = mr > 0 ? Math.min(mr, p.maxDistance) : p.maxDistance;
        const range = random() * limit;
        ts.push((p.times[fi] - p.t0) / p.span);
        coeffs.push(perturbed.map((v, j) => p.sensorPos[b + j] - p.origin[j] + range * v));
    }
    for (let j = 1; j < needed; j++) {
        for (let k = needed - 1; k >= j; k--) {
            coeffs[k] = coeffs[k].map((v, axis) => (v - coeffs[k - 1][axis]) / (ts[k] - ts[k - j]));
        }
    }
    return {trial, ts, coeffs};
}

export function evaluateMonteCarloTrial(candidate, tau) {
    const {coeffs, ts} = candidate;
    const v = coeffs[coeffs.length - 1].slice();
    for (let k = coeffs.length - 2; k >= 0; k--) {
        for (let j = 0; j < 3; j++) v[j] = v[j] * (tau - ts[k]) + coeffs[k][j];
    }
    return v;
}

function residualAt(p, candidate, fi) {
    // This runs for every frame of every finalist. Avoid transient vectors here:
    // otherwise allocation and collection can take longer than the GPU search.
    const {coeffs, ts} = candidate, last = coeffs.length - 1;
    const tau = (p.times[fi] - p.t0) / p.span;
    let x = coeffs[last][0], y = coeffs[last][1], z = coeffs[last][2];
    for (let k = last - 1; k >= 0; k--) {
        const t = tau - ts[k];
        x = x * t + coeffs[k][0]; y = y * t + coeffs[k][1]; z = z * t + coeffs[k][2];
    }
    const b = fi * 3;
    const rx = x - (p.sensorPos[b] - p.origin[0]);
    const ry = y - (p.sensorPos[b + 1] - p.origin[1]);
    const rz = z - (p.sensorPos[b + 2] - p.origin[2]);
    const dx = p.losDir[b], dy = p.losDir[b + 1], dz = p.losDir[b + 2];
    // atan2(cross,dot) is the unit-vector acos objective without its small-angle
    // cancellation. Match the CLI's zero-range convention (acos(0) = pi/2).
    if (Math.hypot(rx, ry, rz) < 1e-12) return Math.PI / 2;
    return Math.atan2(Math.hypot(ry * dz - rz * dy, rz * dx - rx * dz, rx * dy - ry * dx),
        rx * dx + ry * dy + rz * dz);
}

export function scoreMonteCarloTrial(p, candidate) {
    let sum = 0;
    for (const fi of p.active) sum += residualAt(p, candidate, fi);
    return sum / p.active.length;
}

export function monteCarloResult(p, candidate, metadata = {}) {
    const positions = new Float64Array(p.count * 3), residuals = new Float64Array(p.count).fill(NaN);
    for (let i = 0; i < p.count; i++) {
        const v = evaluateMonteCarloTrial(candidate, (p.times[i] - p.t0) / p.span);
        for (let k = 0; k < 3; k++) positions[i * 3 + k] = v[k] + p.origin[k];
    }
    for (const fi of p.active) residuals[fi] = residualAt(p, candidate, fi);
    return {positions, residuals, activeCount: p.active.length, params: {
        order: p.order, numTrials: p.numTrials, seed: p.seed, losUncertaintyDeg: p.losUncertaintyDeg,
        maxDistance: p.maxDistance, bestTrial: candidate.trial, bestScore: scoreMonteCarloTrial(p, candidate),
        ...metadata,
    }};
}

/** Small-budget f64 reference for validation; never a silent GPU fallback. */
export function fitMonteCarloReference(dataset, excluded = new Set(), options = {}) {
    const start = performance.now(), p = prepareMonteCarloLOS(dataset, excluded, options);
    if (!p) return null;
    let best = null, score = Infinity;
    for (let i = 0; i < p.numTrials; i++) {
        if (options.shouldCancel?.()) throw new Error("cancelled");
        const candidate = monteCarloTrial(p, i), value = scoreMonteCarloTrial(p, candidate);
        if (value < score) { best = candidate; score = value; }
    }
    if (!best) return null;
    const result = monteCarloResult(p, best, {backend: "cpu-reference"});
    result.params.timing = {totalMs: performance.now() - start};
    return result;
}
