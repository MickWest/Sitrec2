/**
 * AircraftCostKernel.js — the fixed-wing fit's optimizer cost as a WGSL kernel.
 *
 * Mirrors TraverseAnalysis.aircraftCostErrDeg (block-midpoint integration over
 * the strided cost frames) plus fitAircraft's soft priors and optional ground
 * prior, so the GPU search minimises the same objective as the CPU search.
 *
 * f32 PRECISION. WGSL has no f64, and the f64 code works in absolute ENU
 * coordinates, which f32 cannot hold to the metre over tens of kilometres. The
 * kernel therefore never subtracts two absolute positions:
 *   - r = X(f) - S(f) is built from G(f) = S(0) - S(f), formed here in f64, plus
 *     R0 * D(0), plus the displacement flown since frame 0;
 *   - the heading at each block start is the closed form of the CPU's running
 *     sum of block headings, not a running sum;
 *   - the angle is atan2(|r x d|, r . d). acos of a near-unit dot product cannot
 *     resolve angles below ~0.03 degrees in f32; this form resolves ~1e-7 rad.
 * Measured against the f64 cost: <= 2e-6 relative near an optimum.
 */

import {WIND_PRIOR_SIGMA_MS} from "../TraverseWind";

export const AIRCRAFT_KERNEL_DIM = 6;

// Default GPU search for fitAircraft: 8 independent instances x 1024 x 300
// generations = 2.5M evaluations (the CPU default is 27k). Measured on an Apple
// M4 Pro on a 3001-frame clip: 125 ms, and every instance reached the basin the
// CPU search only found with its escalation run.
export const GPU_AIRCRAFT_BUDGET = Object.freeze({instances: 8, pop: 1024, gens: 300});
const TABLE_STRIDE = 11;

function aircraftWGSL(freeWind) { return /* wgsl */ `
const AC_DEG: f32 = 0.017453292519943295;
fn acSq(x: f32) -> f32 { return x * x; }

fn cost(p: Params) -> f32 {
    let nc = u32(kparams[0]);
    let s0 = vec3f(kparams[1], kparams[2], kparams[3]);
    let d0 = vec3f(kparams[4], kparams[5], kparams[6]);
    let earthR = kparams[7];
    let R0 = p[0]; let h0 = p[1]; let V = p[2]; let w0 = p[3]; let wd = p[4]; let climb = p[5];
    let rd0 = R0 * d0;
    let start = s0 + rd0;
    var a = vec3f(0.0);
    var sum: f32 = 0.0;
    var count: f32 = 1.0;
    for (var ci = 0u; ci < nc; ci++) {
        let o = ci * ${TABLE_STRIDE}u;
        let ta = ktable[o + 9u];
        let tb = ktable[o + 10u];
        let dPsi = (w0 * (tb - ta) + 0.5 * wd * (tb * tb - ta * ta)) * AC_DEG;
        let psiMid = h0 * AC_DEG + (w0 * ta + 0.5 * wd * ta * ta) * AC_DEG + 0.5 * dPsi;
        let dtB = tb - ta;
        let vx = V * sin(psiMid)${freeWind ? " + p[6]" : ""};
        let vy = V * cos(psiMid)${freeWind ? " + p[7]" : ""};
        let px = start.x + a.x;
        let py = start.y + a.y;
        a += vec3f(vx * dtB + ktable[o + 6u],
                   vy * dtB + ktable[o + 7u],
                   (climb - (px * vx + py * vy) / earthR) * dtB + ktable[o + 8u]);
        let r = vec3f(ktable[o], ktable[o + 1u], ktable[o + 2u]) + rd0 + a;
        if (length(r) < 1.0) { return 1e9; }
        let d = vec3f(ktable[o + 3u], ktable[o + 4u], ktable[o + 5u]);
        sum += atan2(length(cross(r, d)), dot(r, d));
        count += 1.0;
    }
    let e = sum / count / AC_DEG;
    let T = kparams[13];
    let wEnd = w0 + wd * T;
    var c = e / kparams[8]
        + acSq(w0 / kparams[9]) + acSq(wEnd / kparams[9])
        + acSq(climb / kparams[10])
        + acSq((V - kparams[11]) / kparams[12]);
    ${freeWind ? `c += (p[6] * p[6] + p[7] * p[7]) / ${WIND_PRIOR_SIGMA_MS ** 2}.0;` : ""}
    if (kparams[14] > 0.5 || kparams[16] > 0.5) {
        let gh0 = start.z + (start.x * start.x + start.y * start.y) / (2.0 * earthR);
        if (kparams[14] > 0.5) { c += acSq((gh0 - kparams[15]) / kparams[18]); }
        if (kparams[16] > 0.5) { c += acSq((gh0 + climb * T - kparams[17]) / kparams[18]); }
    }
    return min(c, 3.0e38);
}
`; }

/**
 * Build the kernel for one dataset and one set of fitAircraft objective settings.
 * @param {object} args
 *   dataset       {n, fps, S, D}
 *   costFrames    the strided frame list fitAircraft scores (first entry 0)
 *   cumW          cumulative per-frame wind displacement (cumulativeWind)
 *   T, errSigma, turnSigma, climbSigma, tasTarget, tasSigma, groundPrior, earthRadius
 */
export function buildAircraftKernel({dataset, costFrames, cumW, T, errSigma, turnSigma, climbSigma,
    tasTarget, tasSigma, groundPrior = null, earthRadius, freeWind = false}) {
    const {S, D, fps} = dataset;
    const nc = costFrames.length - 1;
    const table = new Float32Array(Math.max(1, nc) * TABLE_STRIDE);
    for (let ci = 1; ci < costFrames.length; ci++) {
        const f = costFrames[ci], prevF = costFrames[ci - 1], o = (ci - 1) * TABLE_STRIDE, b = f * 3, pb = prevF * 3;
        table[o] = S[0] - S[b];
        table[o + 1] = S[1] - S[b + 1];
        table[o + 2] = S[2] - S[b + 2];
        table[o + 3] = D[b]; table[o + 4] = D[b + 1]; table[o + 5] = D[b + 2];
        table[o + 6] = freeWind ? 0 : cumW[b] - cumW[pb];
        table[o + 7] = freeWind ? 0 : cumW[b + 1] - cumW[pb + 1];
        table[o + 8] = freeWind ? 0 : cumW[b + 2] - cumW[pb + 2];
        table[o + 9] = prevF / fps;
        table[o + 10] = f / fps;
    }
    const hasStart = !!groundPrior && groundPrior.startZ !== undefined && groundPrior.startZ !== null;
    const hasEnd = !!groundPrior && groundPrior.endZ !== undefined && groundPrior.endZ !== null;
    const params = Float32Array.from([
        nc, S[0], S[1], S[2], D[0], D[1], D[2], earthRadius,
        errSigma, turnSigma, climbSigma, tasTarget, tasSigma, T,
        hasStart ? 1 : 0, hasStart ? groundPrior.startZ : 0,
        hasEnd ? 1 : 0, hasEnd ? groundPrior.endZ : 0,
        groundPrior ? (groundPrior.sigma ?? 40) : 40,
    ]);
    return {key: freeWind ? "aircraft-free-wind" : "aircraft", dim: freeWind ? 8 : AIRCRAFT_KERNEL_DIM,
        wgsl: aircraftWGSL(freeWind), params, table};
}

/**
 * The kernel's arithmetic in JavaScript doubles, over the same f32 tables. It
 * exists so tests can check the table layout and the reformulation against the
 * CPU objective without a GPU; keep it in step with the WGSL above.
 */
export function aircraftKernelCostF64(kernel, p) {
    const k = kernel.params, tab = kernel.table;
    const DEG = Math.PI / 180;
    const [R0, h0, V, w0, wd, climb] = p;
    const nc = k[0], earthR = k[7];
    const rd0 = [R0 * k[4], R0 * k[5], R0 * k[6]];
    const start = [k[1] + rd0[0], k[2] + rd0[1], k[3] + rd0[2]];
    const a = [0, 0, 0];
    let sum = 0, count = 1;
    for (let ci = 0; ci < nc; ci++) {
        const o = ci * TABLE_STRIDE;
        const ta = tab[o + 9], tb = tab[o + 10];
        const dPsi = (w0 * (tb - ta) + 0.5 * wd * (tb * tb - ta * ta)) * DEG;
        const psiMid = h0 * DEG + (w0 * ta + 0.5 * wd * ta * ta) * DEG + 0.5 * dPsi;
        const dtB = tb - ta;
        const vx = V * Math.sin(psiMid) + (kernel.dim === 8 ? p[6] : 0);
        const vy = V * Math.cos(psiMid) + (kernel.dim === 8 ? p[7] : 0);
        const px = start[0] + a[0], py = start[1] + a[1];
        a[0] += vx * dtB + tab[o + 6];
        a[1] += vy * dtB + tab[o + 7];
        a[2] += (climb - (px * vx + py * vy) / earthR) * dtB + tab[o + 8];
        const r = [tab[o] + rd0[0] + a[0], tab[o + 1] + rd0[1] + a[1], tab[o + 2] + rd0[2] + a[2]];
        if (Math.hypot(r[0], r[1], r[2]) < 1) return 1e9;
        const d = [tab[o + 3], tab[o + 4], tab[o + 5]];
        const cx = r[1] * d[2] - r[2] * d[1], cy = r[2] * d[0] - r[0] * d[2], cz = r[0] * d[1] - r[1] * d[0];
        sum += Math.atan2(Math.hypot(cx, cy, cz), r[0] * d[0] + r[1] * d[1] + r[2] * d[2]);
        count++;
    }
    const e = sum / count / DEG;
    const T = k[13];
    const wEnd = w0 + wd * T;
    let c = e / k[8] + (w0 / k[9]) ** 2 + (wEnd / k[9]) ** 2 + (climb / k[10]) ** 2 + ((V - k[11]) / k[12]) ** 2;
    if (kernel.dim === 8) c += (p[6] ** 2 + p[7] ** 2) / WIND_PRIOR_SIGMA_MS ** 2;
    if (k[14] > 0.5 || k[16] > 0.5) {
        const gh0 = start[2] + (start[0] * start[0] + start[1] * start[1]) / (2 * earthR);
        if (k[14] > 0.5) c += ((gh0 - k[15]) / k[18]) ** 2;
        if (k[16] > 0.5) c += ((gh0 + climb * T - k[17]) / k[18]) ** 2;
    }
    return c;
}
