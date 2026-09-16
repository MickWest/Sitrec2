/**
 * QuadcopterCostKernel.js — WebGPU cost kernel for the generic multirotor fit.
 *
 * The kernel mirrors fitPhysicsModel with QuadcopterModel: it integrates the
 * five-state kinematics on the same RK4 substep schedule, scores the strided
 * LOS observations, and adds the model's speed, turn, and wind priors. The
 * ground-contact prior is not covered and therefore stays on the CPU path.
 */

import {QuadcopterModel} from "../QuadcopterModel";

export const QUADCOPTER_KERNEL_DIM = 9;

const WGSL = /* wgsl */ `
const QD_DEG: f32 = 0.017453292519943295;

struct QDState { a: vec3f, psi: f32, v: f32 };
struct QDDeriv { a: vec3f, psi: f32, v: f32 };

fn qdSq(x: f32) -> f32 { return x * x; }

fn qdAngle(r: vec3f, d: vec3f) -> f32 {
    if (length(r) < 1e-6) { return 3.14159265; }
    return atan2(length(cross(r, d)), dot(r, d));
}

fn qdDeriv(s: QDState, x0: vec3f, p: Params, t: f32) -> QDDeriv {
    let vx = s.v * sin(s.psi) + p[7];
    let vy = s.v * cos(s.psi) + p[8];
    let x = x0.x + s.a.x;
    let y = x0.y + s.a.y;
    return QDDeriv(
        vec3f(vx, vy, p[6] - (x * vx + y * vy) / kparams[8]),
        (p[4] + p[5] * t) * QD_DEG,
        p[3]
    );
}

fn qdAdd(s: QDState, d: QDDeriv, scale: f32) -> QDState {
    return QDState(s.a + scale * d.a, s.psi + scale * d.psi, s.v + scale * d.v);
}

fn cost(p: Params) -> f32 {
    let nSteps = u32(kparams[0]);
    let nSamples = kparams[1];
    let sOff = u32(kparams[19]);
    let s0 = vec3f(kparams[2], kparams[3], kparams[4]);
    let d0 = vec3f(kparams[5], kparams[6], kparams[7]);
    let rd0 = p[0] * d0;
    let x0 = s0 + rd0;
    var s = QDState(vec3f(0.0), p[1] * QD_DEG, p[2]);
    var sum = qdAngle(vec3f(ktable[sOff], ktable[sOff + 1u], ktable[sOff + 2u]) + rd0,
                      vec3f(ktable[sOff + 3u], ktable[sOff + 4u], ktable[sOff + 5u]));
    for (var k = 0u; k < nSteps; k++) {
        let o = k * 3u;
        let t = ktable[o];
        let dt = ktable[o + 1u];
        let k1 = qdDeriv(s, x0, p, t);
        let k2 = qdDeriv(qdAdd(s, k1, 0.5 * dt), x0, p, t + 0.5 * dt);
        let k3 = qdDeriv(qdAdd(s, k2, 0.5 * dt), x0, p, t + 0.5 * dt);
        let k4 = qdDeriv(qdAdd(s, k3, dt), x0, p, t + dt);
        s.a += (dt / 6.0) * (k1.a + 2.0 * k2.a + 2.0 * k3.a + k4.a);
        s.psi += (dt / 6.0) * (k1.psi + 2.0 * k2.psi + 2.0 * k3.psi + k4.psi);
        s.v += (dt / 6.0) * (k1.v + 2.0 * k2.v + 2.0 * k3.v + k4.v);
        if (abs(x0.x + s.a.x) > 1e8 || abs(x0.z + s.a.z) > 1e6) { return 3.0e38; }
        let si = ktable[o + 2u];
        if (si >= 0.0) {
            let so = sOff + u32(si) * 6u;
            sum += qdAngle(vec3f(ktable[so], ktable[so + 1u], ktable[so + 2u]) + rd0 + s.a,
                           vec3f(ktable[so + 3u], ktable[so + 4u], ktable[so + 5u]));
        }
    }

    var c = (sum / nSamples / QD_DEG) / kparams[9];
    let T = kparams[10];
    let maxSpeed = kparams[11];
    for (var j = 0u; j <= 8u; j++) {
        let v = abs(p[2] + p[3] * T * f32(j) / 8.0);
        if (v > maxSpeed) { c += qdSq((v - maxSpeed) / 2.0) / 9.0; }
    }
    let rateStart = p[4];
    let rateEnd = p[4] + p[5] * T;
    c += (rateStart * rateStart + rateEnd * rateEnd + rateStart * rateEnd) / (3.0 * 400.0);
    c += 0.1 * qdSq(p[5] / 5.0);
    if (kparams[14] > 0.5) {
        c += qdSq((p[7] - kparams[15]) / kparams[17])
            + qdSq((p[8] - kparams[16]) / kparams[17]);
    } else {
        c += 0.3 * qdSq(length(vec2f(p[7], p[8])) / 6.0);
    }
    return min(c, 3.0e38);
}
`;

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
        if (!stepped) steps.push({t, dt: 0, sample: k});
        else steps[steps.length - 1].sample = k;
    }
    return steps;
}

/** Build the generic QuadcopterModel kernel, or null for unsupported options. */
export function buildQuadcopterKernel({
    model, dataset, costFrames, costTimes, maxDt, T, errSigma, groundPrior = null,
}) {
    if (!(model instanceof QuadcopterModel) || groundPrior) return null;
    if (!(errSigma > 1e-4) || !(maxDt > 0) || costFrames.length < 2) return null;
    const {sensorPos: S, losDir: D} = dataset;
    const steps = substepSchedule(costTimes, maxDt);
    const nSamples = costFrames.length;
    const sOff = steps.length * 3;
    const table = new Float32Array(sOff + nSamples * 6);
    steps.forEach((s, k) => {
        table[k * 3] = s.t;
        table[k * 3 + 1] = s.dt;
        table[k * 3 + 2] = s.sample;
    });
    costFrames.forEach((f, k) => {
        const b = f * 3, o = sOff + k * 6;
        table[o] = S[0] - S[b];
        table[o + 1] = S[1] - S[b + 1];
        table[o + 2] = S[2] - S[b + 2];
        table[o + 3] = D[b];
        table[o + 4] = D[b + 1];
        table[o + 5] = D[b + 2];
    });
    const windPrior = model.windPriorE !== null && model.windPriorN !== null;
    const params = Float32Array.from([
        steps.length, nSamples,
        S[0], S[1], S[2], D[0], D[1], D[2],
        6371000, errSigma, T, model._maxSpeed(), model._maxAscent(), model._maxDescent(),
        windPrior ? 1 : 0,
        windPrior ? model.windPriorE : 0,
        windPrior ? model.windPriorN : 0,
        model.windPriorSigma,
        20,
        sOff,
    ]);
    return {key: "quadcopter", dim: QUADCOPTER_KERNEL_DIM, wgsl: WGSL, params, table};
}

/** JavaScript-double mirror of the WGSL arithmetic over the same f32 tables. */
export function quadcopterKernelCostF64(kernel, p) {
    const k = kernel.params, tab = kernel.table;
    const DEG = Math.PI / 180;
    const sOff = k[19];
    const rd0 = [p[0] * k[5], p[0] * k[6], p[0] * k[7]];
    const x0 = [k[2] + rd0[0], k[3] + rd0[1], k[4] + rd0[2]];
    const angle = (r, d) => {
        if (Math.hypot(...r) < 1e-6) return Math.PI;
        const cx = r[1] * d[2] - r[2] * d[1];
        const cy = r[2] * d[0] - r[0] * d[2];
        const cz = r[0] * d[1] - r[1] * d[0];
        return Math.atan2(Math.hypot(cx, cy, cz), r[0] * d[0] + r[1] * d[1] + r[2] * d[2]);
    };
    const deriv = (s, t) => {
        const vx = s.v * Math.sin(s.psi) + p[7];
        const vy = s.v * Math.cos(s.psi) + p[8];
        return {a: [vx, vy, p[6] - ((x0[0] + s.a[0]) * vx + (x0[1] + s.a[1]) * vy) / k[8]],
            psi: (p[4] + p[5] * t) * DEG, v: p[3]};
    };
    const add = (s, d, scale) => ({
        a: s.a.map((value, i) => value + scale * d.a[i]),
        psi: s.psi + scale * d.psi,
        v: s.v + scale * d.v,
    });
    let s = {a: [0, 0, 0], psi: p[1] * DEG, v: p[2]};
    let sum = angle([tab[sOff] + rd0[0], tab[sOff + 1] + rd0[1], tab[sOff + 2] + rd0[2]],
        [tab[sOff + 3], tab[sOff + 4], tab[sOff + 5]]);
    for (let step = 0; step < k[0]; step++) {
        const t = tab[step * 3], dt = tab[step * 3 + 1];
        const k1 = deriv(s, t);
        const k2 = deriv(add(s, k1, 0.5 * dt), t + 0.5 * dt);
        const k3 = deriv(add(s, k2, 0.5 * dt), t + 0.5 * dt);
        const k4 = deriv(add(s, k3, dt), t + dt);
        s = {
            a: s.a.map((value, i) => value + dt / 6 * (k1.a[i] + 2 * k2.a[i] + 2 * k3.a[i] + k4.a[i])),
            psi: s.psi + dt / 6 * (k1.psi + 2 * k2.psi + 2 * k3.psi + k4.psi),
            v: s.v + dt / 6 * (k1.v + 2 * k2.v + 2 * k3.v + k4.v),
        };
        if (Math.abs(x0[0] + s.a[0]) > 1e8 || Math.abs(x0[2] + s.a[2]) > 1e6) return 3e38;
        const si = tab[step * 3 + 2];
        if (si >= 0) {
            const o = sOff + si * 6;
            sum += angle([tab[o] + rd0[0] + s.a[0], tab[o + 1] + rd0[1] + s.a[1],
                tab[o + 2] + rd0[2] + s.a[2]], [tab[o + 3], tab[o + 4], tab[o + 5]]);
        }
    }
    let cost = (sum / k[1] / DEG) / k[9];
    const T = k[10];
    for (let j = 0; j <= 8; j++) {
        const v = Math.abs(p[2] + p[3] * T * j / 8);
        if (v > k[11]) cost += ((v - k[11]) / 2) ** 2 / 9;
    }
    const rateEnd = p[4] + p[5] * T;
    cost += (p[4] * p[4] + rateEnd * rateEnd + p[4] * rateEnd) / (3 * 400);
    cost += 0.1 * (p[5] / 5) ** 2;
    if (k[14] > 0.5) cost += ((p[7] - k[15]) / k[17]) ** 2 + ((p[8] - k[16]) / k[17]) ** 2;
    else cost += 0.3 * (Math.hypot(p[7], p[8]) / 6) ** 2;
    return cost;
}
