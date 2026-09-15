/**
 * LanternCostKernel.js — the Sky Lantern physics fit's cost as a WGSL kernel.
 *
 * Mirrors what fitPhysicsModel minimises for a SkyLanternModel: RK4 integration
 * (integrateRK4, the same substep schedule) of the lantern ODE to every strided
 * cost frame, the mean angular LOS error over those frames divided by errSigma,
 * plus SkyLanternModel.extraCost (light-wind or measured-wind prior, negative
 * shear, wind variability, and the below-surface altitude profile).
 *
 * Not covered, so callers must use the CPU path for them: the ground-contact
 * prior (its end term integrates on a different substep schedule).
 *
 * f32 PRECISION. The state integrated is the displacement a = X - X0 from the
 * start point, not the absolute ENU position, and the geodetic height change is
 * expanded so that no two absolute coordinates are subtracted:
 *   h - h0 = a_z + (2 x0 a_x + a_x^2 + 2 y0 a_y + a_y^2) / 2R.
 * Sightline vectors are built from G(f) = S(0) - S(f) (formed in f64), and the
 * angle is atan2(|r x d|, r . d). See AircraftCostKernel.js for why.
 * Measured against the f64 cost: <= 1e-6 relative near an optimum on a 300 s clip.
 */

import {EARTH_R, MULT_MAX, MULT_MIN, SkyLanternModel, WIND_VARIATION_REF} from "../SkyLanternModel";

export const LANTERN_KERNEL_DIM = 12;

// Default GPU search for a physics fit: 4 instances x 1024 x 200 generations =
// 0.8M evaluations (the CPU default is 5.8k). Measured on an Apple M4 Pro: about
// 0.5 s for 3001 frames at 1200 RK4 substeps per evaluation.
export const GPU_PHYSICS_BUDGET = Object.freeze({instances: 4, pop: 1024, gens: 200});

const WGSL = /* wgsl */ `
const LN_DEG: f32 = 0.017453292519943295;
fn lnSq(x: f32) -> f32 { return x * x; }

fn lnAngle(r: vec3f, d: vec3f) -> f32 {
    if (length(r) < 1e-6) { return 3.14159265; }
    return atan2(length(cross(r, d)), dot(r, d));
}

fn lnDeriv(a: vec3f, x0: vec3f, p: Params, t: f32) -> vec3f {
    let R = kparams[8];
    let x = x0.x + a.x;
    let y = x0.y + a.y;
    let dh = a.z + (2.0 * x0.x * a.x + a.x * a.x + 2.0 * x0.y * a.y + a.y * a.y) / (2.0 * R);
    let mult = clamp(1.0 + p[3] * dh, kparams[17], kparams[18]);
    var wx = p[1];
    var wy = p[2];
    let clipT = kparams[10];
    if (clipT > 0.0) {
        let s = t / clipT;
        wx = p[1] + p[8] * s + p[10] * s * s;
        wy = p[2] + p[9] * s + p[11] * s * s;
    }
    wx = wx * mult;
    wy = wy * mult;
    var vz = p[4];
    if (t > p[6]) { vz = -p[5] + (p[4] + p[5]) * exp(max(-(t - p[6]) / p[7], -80.0)); }
    return vec3f(wx, wy, vz - (x * wx + y * wy) / R);
}

fn lnHAt(t: f32, p: Params, h0: f32) -> f32 {
    let vRise = p[4]; let vSink = p[5]; let tBurn = p[6]; let tau = p[7];
    if (tBurn >= 0.0) {
        if (t <= tBurn) { return h0 + vRise * t; }
        let u = t - tBurn;
        return h0 + vRise * tBurn + (-vSink * u + (vRise + vSink) * tau * (1.0 - exp(max(-u / tau, -80.0))));
    }
    let u1 = t - tBurn;
    let u0 = -tBurn;
    return h0 + (-vSink * u1 + (vRise + vSink) * tau * (1.0 - exp(max(-u1 / tau, -80.0))))
              - (-vSink * u0 + (vRise + vSink) * tau * (1.0 - exp(max(-u0 / tau, -80.0))));
}

fn cost(p: Params) -> f32 {
    let nSteps = u32(kparams[0]);
    let nSamples = kparams[1];
    let sOff = u32(kparams[19]);
    let s0 = vec3f(kparams[2], kparams[3], kparams[4]);
    let d0 = vec3f(kparams[5], kparams[6], kparams[7]);
    let R = kparams[8];
    let rd0 = p[0] * d0;
    let x0 = s0 + rd0;
    var a = vec3f(0.0);
    var sum = lnAngle(vec3f(ktable[sOff], ktable[sOff + 1u], ktable[sOff + 2u]) + rd0,
                      vec3f(ktable[sOff + 3u], ktable[sOff + 4u], ktable[sOff + 5u]));
    for (var k = 0u; k < nSteps; k++) {
        let o = k * 3u;
        let t = ktable[o];
        let dt = ktable[o + 1u];
        let k1 = lnDeriv(a, x0, p, t);
        let k2 = lnDeriv(a + 0.5 * dt * k1, x0, p, t + 0.5 * dt);
        let k3 = lnDeriv(a + 0.5 * dt * k2, x0, p, t + 0.5 * dt);
        let k4 = lnDeriv(a + dt * k3, x0, p, t + dt);
        a += (dt / 6.0) * (k1 + 2.0 * k2 + 2.0 * k3 + k4);
        if (abs(x0.x + a.x) > 1e8 || abs(x0.z + a.z) > 1e6) { return 3.0e38; }
        let si = ktable[o + 2u];
        if (si >= 0.0) {
            let so = sOff + u32(si) * 6u;
            sum += lnAngle(vec3f(ktable[so], ktable[so + 1u], ktable[so + 2u]) + rd0 + a,
                           vec3f(ktable[so + 3u], ktable[so + 4u], ktable[so + 5u]));
        }
    }
    var c = (sum / nSamples / LN_DEG) / kparams[9];
    if (kparams[12] > 0.5) {
        let dE = p[1] - kparams[13];
        let dN = p[2] - kparams[14];
        c += (dE * dE + dN * dN) / (kparams[15] * kparams[15]);
    } else {
        c += 0.5 * lnSq(length(vec2f(p[1], p[2])) / 10.0);
    }
    if (p[3] < 0.0) { c += 0.5 * lnSq(p[3] / 0.002); }
    let varE = p[8] * p[8] / 12.0 + p[8] * p[10] / 6.0 + 4.0 * p[10] * p[10] / 45.0;
    let varN = p[9] * p[9] / 12.0 + p[9] * p[11] / 6.0 + 4.0 * p[11] * p[11] / 45.0;
    c += (varE + varN) / (kparams[11] * kparams[11]);
    let h0 = x0.z + (x0.x * x0.x + x0.y * x0.y) / (2.0 * R);
    let T = kparams[16];
    for (var j = 0u; j <= 16u; j++) {
        let h = lnHAt(T * f32(j) / 16.0, p, h0);
        if (h < 0.0) { c += lnSq(h / 8.0) / 17.0; }
    }
    return min(c, 3.0e38);
}
`;

/** The integrateRK4 substep schedule for a list of sample times: [{t, dt, sample}]. */
function substepSchedule(sampleTimes, maxDt) {
    const steps = [];
    let t = sampleTimes[0];
    for (let k = 1; k < sampleTimes.length; k++) {
        const tNext = sampleTimes[k];
        let stepped = false;
        while (t < tNext - 1e-10) {
            const dt = Math.min(maxDt, tNext - t);
            steps.push({t, dt, sample: -1});
            t += dt;
            stepped = true;
        }
        t = tNext;
        // A sample reached without a substep (repeated time) is recorded by a
        // zero-length step, which leaves the state unchanged.
        if (!stepped) steps.push({t, dt: 0, sample: k});
        else steps[steps.length - 1].sample = k;
    }
    return steps;
}

/**
 * Build the kernel, or return null when the model or options are not covered.
 * @param {object} args
 *   model        the SkyLanternModel instance being fitted (windPrior*, clipDuration)
 *   dataset      LOSFitting dataset {sensorPos, losDir}
 *   costFrames   active strided frame indices; costTimes their clip-relative seconds
 *   maxDt        integration substep cap (fitMaxDt ?? model.maxDt)
 *   T            clip duration passed to extraCost
 *   errSigma, groundPrior
 */
export function buildLanternKernel({model, dataset, costFrames, costTimes, maxDt, T, errSigma, groundPrior = null}) {
    if (!(model instanceof SkyLanternModel) || groundPrior) return null;
    if (!(errSigma > 1e-4) || !(maxDt > 0) || costFrames.length < 2) return null;
    const {sensorPos: S, losDir: D} = dataset;
    const steps = substepSchedule(costTimes, maxDt);
    const nSamples = costFrames.length;
    const sOff = steps.length * 3;
    const table = new Float32Array(sOff + nSamples * 6);
    steps.forEach((s, k) => { table[k * 3] = s.t; table[k * 3 + 1] = s.dt; table[k * 3 + 2] = s.sample; });
    costFrames.forEach((f, k) => {
        const b = f * 3, o = sOff + k * 6;
        table[o] = S[0] - S[b]; table[o + 1] = S[1] - S[b + 1]; table[o + 2] = S[2] - S[b + 2];
        table[o + 3] = D[b]; table[o + 4] = D[b + 1]; table[o + 5] = D[b + 2];
    });
    const windPrior = model.windPriorE !== null && model.windPriorN !== null;
    const params = Float32Array.from([
        steps.length, nSamples, S[0], S[1], S[2], D[0], D[1], D[2], EARTH_R, errSigma,
        model.clipDuration > 0 ? model.clipDuration : 0, WIND_VARIATION_REF,
        windPrior ? 1 : 0, windPrior ? model.windPriorE : 0, windPrior ? model.windPriorN : 0,
        model.windPriorSigma, T, MULT_MIN, MULT_MAX, sOff,
    ]);
    return {key: "skyLantern", dim: LANTERN_KERNEL_DIM, wgsl: WGSL, params, table};
}

/**
 * The kernel's arithmetic in JavaScript doubles, over the same f32 tables, for
 * tests without a GPU. Keep it in step with the WGSL above.
 */
export function lanternKernelCostF64(kernel, p) {
    const k = kernel.params, tab = kernel.table;
    const DEG = Math.PI / 180;
    const R = k[8], sOff = k[19];
    const rd0 = [p[0] * k[5], p[0] * k[6], p[0] * k[7]];
    const x0 = [k[2] + rd0[0], k[3] + rd0[1], k[4] + rd0[2]];
    const angle = (r, d) => {
        if (Math.hypot(r[0], r[1], r[2]) < 1e-6) return Math.PI;
        const cx = r[1] * d[2] - r[2] * d[1], cy = r[2] * d[0] - r[0] * d[2], cz = r[0] * d[1] - r[1] * d[0];
        return Math.atan2(Math.hypot(cx, cy, cz), r[0] * d[0] + r[1] * d[1] + r[2] * d[2]);
    };
    const deriv = (a, t) => {
        const x = x0[0] + a[0], y = x0[1] + a[1];
        const dh = a[2] + (2 * x0[0] * a[0] + a[0] * a[0] + 2 * x0[1] * a[1] + a[1] * a[1]) / (2 * R);
        const mult = Math.min(k[18], Math.max(k[17], 1 + p[3] * dh));
        let wx = p[1], wy = p[2];
        if (k[10] > 0) {
            const s = t / k[10];
            wx = p[1] + p[8] * s + p[10] * s * s;
            wy = p[2] + p[9] * s + p[11] * s * s;
        }
        wx *= mult; wy *= mult;
        const vz = t > p[6] ? -p[5] + (p[4] + p[5]) * Math.exp(Math.max(-(t - p[6]) / p[7], -80)) : p[4];
        return [wx, wy, vz - (x * wx + y * wy) / R];
    };
    const add = (a, b, s) => [a[0] + s * b[0], a[1] + s * b[1], a[2] + s * b[2]];
    let a = [0, 0, 0];
    let sum = angle([tab[sOff] + rd0[0], tab[sOff + 1] + rd0[1], tab[sOff + 2] + rd0[2]],
        [tab[sOff + 3], tab[sOff + 4], tab[sOff + 5]]);
    for (let s = 0; s < k[0]; s++) {
        const t = tab[s * 3], dt = tab[s * 3 + 1];
        const k1 = deriv(a, t);
        const k2 = deriv(add(a, k1, 0.5 * dt), t + 0.5 * dt);
        const k3 = deriv(add(a, k2, 0.5 * dt), t + 0.5 * dt);
        const k4 = deriv(add(a, k3, dt), t + dt);
        a = [0, 1, 2].map((i) => a[i] + (dt / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]));
        if (Math.abs(x0[0] + a[0]) > 1e8 || Math.abs(x0[2] + a[2]) > 1e6) return 3e38;
        const si = tab[s * 3 + 2];
        if (si >= 0) {
            const o = sOff + si * 6;
            sum += angle([tab[o] + rd0[0] + a[0], tab[o + 1] + rd0[1] + a[1], tab[o + 2] + rd0[2] + a[2]],
                [tab[o + 3], tab[o + 4], tab[o + 5]]);
        }
    }
    let c = (sum / k[1] / DEG) / k[9];
    if (k[12] > 0.5) c += ((p[1] - k[13]) ** 2 + (p[2] - k[14]) ** 2) / (k[15] * k[15]);
    else c += 0.5 * (Math.hypot(p[1], p[2]) / 10) ** 2;
    if (p[3] < 0) c += 0.5 * (p[3] / 0.002) ** 2;
    const varOf = (A, B) => A * A / 12 + A * B / 6 + 4 * B * B / 45;
    c += (varOf(p[8], p[10]) + varOf(p[9], p[11])) / (k[11] * k[11]);
    const h0 = x0[2] + (x0[0] * x0[0] + x0[1] * x0[1]) / (2 * R);
    const T = k[16];
    const hAt = (t) => {
        const vRise = p[4], vSink = p[5], tBurn = p[6], tau = p[7];
        const decay = (u) => -vSink * u + (vRise + vSink) * tau * (1 - Math.exp(Math.max(-u / tau, -80)));
        if (tBurn >= 0) return t <= tBurn ? h0 + vRise * t : h0 + vRise * tBurn + decay(t - tBurn);
        return h0 + decay(t - tBurn) - decay(-tBurn);
    };
    for (let j = 0; j <= 16; j++) {
        const h = hAt(T * j / 16);
        if (h < 0) c += (h / 8) ** 2 / 17;
    }
    return c;
}
