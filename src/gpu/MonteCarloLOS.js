/**
 * GPU implementation of blind Monte Carlo LOS fitting. Each invocation samples,
 * interpolates and scores one complete trial. Only scores leave the GPU; no
 * trials-by-frames position tensor is allocated. Batches bound memory and allow
 * cancellation. The best 64 f32 trials are regenerated and ranked in f64.
 *
 * This preserves the CLI algorithm, not NumPy's PRNG or bitwise results. GPU
 * arithmetic can change the shortlist, particularly for ill-conditioned higher
 * orders. No confidence estimate is inferred from the small finalist set.
 */
import {prepareMonteCarloLOS, monteCarloTrial, scoreMonteCarloTrial, monteCarloResult} from "../MonteCarloLOS";
import {getComputeDevice, GpuComputeError, GPU_BUFFER, GPU_MAP_MODE_READ} from "./WebGPUCompute";

const WORKGROUP = 64;
const FINALISTS = 64;
const INVALID_SCORE = 1e30;
const pipelines = new WeakMap();

export function monteCarloWGSL(order) {
    const needed = order + 1;
    return /* wgsl */ `
const N: u32 = ${needed}u;
struct Config { frames: u32, trials: u32, offset: u32, seed: u32, uncertainty: f32, padding: vec3f };
struct Ray { sensor: vec3f, time: f32, direction: vec3f, range: f32 };
@group(0) @binding(0) var<uniform> cfg: Config;
@group(0) @binding(1) var<storage, read> rays: array<Ray>;
@group(0) @binding(2) var<storage, read_write> scores: array<f32>;

fn pcg(v: u32) -> u32 {
    let s = v * 747796405u + 2891336453u;
    let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
    return (w >> 22u) ^ w;
}
fn random(s: ptr<function, u32>) -> f32 {
    *s = pcg(*s);
    return f32(*s >> 8u) / 16777216.0;
}

@compute @workgroup_size(${WORKGROUP})
fn search(@builtin(global_invocation_id) gid: vec3u) {
    let trial = gid.x;
    if (trial >= cfg.trials) { return; }
    var state = pcg(cfg.seed ^ pcg(cfg.offset + trial));
    var selected: array<u32, ${needed}>;
    var times: array<f32, ${needed}>;
    var coeffs: array<vec3f, ${needed}>;
    for (var k = 0u; k < N; k++) {
        state = pcg(state);
        var rank = state % (cfg.frames - k);
        for (var j = 0u; j < k; j++) { if (rank >= selected[j]) { rank++; } }
        var insert = k;
        while (insert > 0u) {
            if (selected[insert - 1u] <= rank) { break; }
            selected[insert] = selected[insert - 1u];
            insert--;
        }
        selected[insert] = rank;
        let ray = rays[rank];
        let d = ray.direction;
        var perturbed = d;
        if (cfg.uncertainty > 1e-10) {
            let theta = random(&state) * cfg.uncertainty;
            let phi = random(&state) * 6.283185307179586;
            let a = abs(d);
            var basis = vec3f(0, 0, 1);
            if (a.x <= a.y && a.x <= a.z) { basis = vec3f(1, 0, 0); }
            else if (a.y <= a.z) { basis = vec3f(0, 1, 0); }
            let perp = normalize(cross(d, basis));
            let axis = normalize(perp * cos(phi) + cross(d, perp) * sin(phi));
            perturbed = d * cos(theta) + cross(axis, d) * sin(theta);
        }
        times[k] = ray.time;
        coeffs[k] = ray.sensor + (random(&state) * ray.range) * perturbed;
    }
    for (var j = 1u; j < N; j++) {
        for (var k = i32(N) - 1; k >= i32(j); k--) {
            coeffs[k] = (coeffs[k] - coeffs[k - 1]) / (times[k] - times[k - i32(j)]);
            if (any(abs(coeffs[k]) > vec3f(1e25))) { scores[trial] = 1e30; return; }
        }
    }
    var sum = 0.0;
    for (var fi = 0u; fi < cfg.frames; fi++) {
        let ray = rays[fi];
        var v = coeffs[N - 1u];
        for (var k = i32(N) - 2; k >= 0; k--) { v = v * (ray.time - times[k]) + coeffs[k]; }
        let r = v - ray.sensor;
        var angle = 1.5707963267948966;
        let scale = max(max(abs(r.x), abs(r.y)), abs(r.z));
        if (scale > 1e-12) {
            // Normalize first to avoid squaring very large extrapolated paths.
            let u = normalize(r / scale);
            angle = atan2(length(cross(u, ray.direction)), dot(u, ray.direction));
        }
        sum += angle;
    }
    scores[trial] = sum / f32(cfg.frames);
}
`;
}

async function pipelineFor(device, order) {
    let cache = pipelines.get(device);
    if (!cache) { cache = new Map(); pipelines.set(device, cache); }
    if (!cache.has(order)) {
        const pending = (async () => {
            const module = device.createShaderModule({code: monteCarloWGSL(order), label: `Monte Carlo order ${order}`});
            const info = await module.getCompilationInfo();
            const errors = info.messages.filter(m => m.type === "error");
            if (errors.length) throw new GpuComputeError(errors.map(m => `${m.lineNum}: ${m.message}`).join("; "));
            return device.createComputePipelineAsync({layout: "auto", compute: {module, entryPoint: "search"}});
        })();
        cache.set(order, pending);
        pending.catch(() => cache.delete(order));
    }
    return cache.get(order);
}

/**
 * Same inputs/results as LOSFitting, async. Options: preset or numTrials, order,
 * losUncertaintyDeg, seed, maxDistance, batchSize, shouldCancel, onProgress.
 * Returns null only for too few observations. Throws GpuComputeError if GPU
 * compute is unavailable or fails: callers must explicitly choose any fallback.
 * Timing is elapsed wall time including transfers and f64 refinement, not a
 * shader timestamp. Concurrent GPU workloads affect it.
 */
export async function fitMonteCarloGPU(dataset, excluded = new Set(), options = {}) {
    const start = performance.now();
    const checkCancel = () => { if (options.shouldCancel?.()) throw new Error("cancelled"); };
    checkCancel();
    const p = prepareMonteCarloLOS(dataset, excluded, options);
    if (!p) return null;
    const device = await getComputeDevice();
    if (!device) throw new GpuComputeError("WebGPU is unavailable for Monte Carlo fitting");
    const pipeline = await pipelineFor(device, p.order);
    checkCancel();
    // Bound each dispatch to about 32 million frame evaluations on long clips.
    const defaultBatch = Math.max(64, Math.min(65536, Math.floor(32000000 / p.active.length)));
    const requested = options.batchSize ?? defaultBatch;
    if (!Number.isInteger(requested) || requested < 1) throw new Error("Monte Carlo batchSize must be a positive integer");
    const batch = Math.min(requested, p.numTrials, device.limits.maxComputeWorkgroupsPerDimension * WORKGROUP,
        Math.floor(device.limits.maxStorageBufferBindingSize / 4));
    if (p.table.byteLength > device.limits.maxStorageBufferBindingSize) throw new GpuComputeError("Too many Monte Carlo observations for this GPU");
    const created = [];
    const buffer = (size, usage) => {
        const b = device.createBuffer({size, usage}); created.push(b); return b;
    };
    const finalists = [];
    let threshold = Infinity, valid = 0, batches = 0;
    try {
        // Pop each scope before yielding so concurrent fits sharing this device
        // cannot accidentally consume one another's validation scopes.
        device.pushErrorScope("out-of-memory");
        device.pushErrorScope("validation");
        let cfg, rays, scores, read, group;
        let setupErrors;
        // Config's vec3 padding aligns to 16 bytes, making its size 48 bytes.
        const config = new ArrayBuffer(48), cfgU = new Uint32Array(config), cfgF = new Float32Array(config);
        cfgU[0] = p.active.length; cfgU[3] = p.seed; cfgF[4] = p.uncertainty;
        try {
            cfg = buffer(48, GPU_BUFFER.UNIFORM | GPU_BUFFER.COPY_DST);
            rays = buffer(p.table.byteLength, GPU_BUFFER.STORAGE | GPU_BUFFER.COPY_DST);
            scores = buffer(batch * 4, GPU_BUFFER.STORAGE | GPU_BUFFER.COPY_SRC);
            read = buffer(batch * 4, GPU_BUFFER.COPY_DST | GPU_BUFFER.MAP_READ);
            device.queue.writeBuffer(rays, 0, p.table);
            group = device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries:
                [cfg, rays, scores].map((b, binding) => ({binding, resource: {buffer: b}}))});
        } finally {
            setupErrors = Promise.all([device.popErrorScope(), device.popErrorScope()]);
        }
        const setupError = (await setupErrors).find(Boolean);
        if (setupError) throw new GpuComputeError(setupError.message);
        const ready = performance.now();
        for (let offset = 0; offset < p.numTrials; offset += batch) {
            checkCancel();
            const n = Math.min(batch, p.numTrials - offset);
            cfgU[1] = n; cfgU[2] = offset;
            device.pushErrorScope("validation");
            let dispatchError;
            try {
                device.queue.writeBuffer(cfg, 0, config);
                const encoder = device.createCommandEncoder();
                const pass = encoder.beginComputePass();
                pass.setPipeline(pipeline); pass.setBindGroup(0, group);
                pass.dispatchWorkgroups(Math.ceil(n / WORKGROUP)); pass.end();
                encoder.copyBufferToBuffer(scores, 0, read, 0, n * 4);
                device.queue.submit([encoder.finish()]);
            } finally {
                dispatchError = device.popErrorScope();
            }
            const error = await dispatchError;
            if (error) throw new GpuComputeError(error.message);
            await read.mapAsync(GPU_MAP_MODE_READ, 0, n * 4);
            const values = new Float32Array(read.getMappedRange(0, n * 4));
            for (let i = 0; i < n; i++) {
                const score = values[i];
                if (!Number.isFinite(score) || score >= INVALID_SCORE) continue;
                valid++;
                if (score >= threshold) continue;
                finalists.push({trial: offset + i, score});
                finalists.sort((a, b) => a.score - b.score || a.trial - b.trial);
                if (finalists.length > FINALISTS) finalists.pop();
                if (finalists.length === FINALISTS) threshold = finalists[FINALISTS - 1].score;
            }
            read.unmap();
            batches++;
            if (options.onProgress) await options.onProgress((offset + n) / p.numTrials);
        }
        checkCancel();
        const searched = performance.now();
        let best = null, bestScore = Infinity;
        for (const finalist of finalists) {
            const candidate = monteCarloTrial(p, finalist.trial), score = scoreMonteCarloTrial(p, candidate);
            if (score < bestScore || (score === bestScore && candidate.trial < best.trial)) {
                best = candidate; bestScore = score;
            }
        }
        if (!best) throw new GpuComputeError("Monte Carlo GPU search produced no finite candidate");
        const result = monteCarloResult(p, best, {backend: "webgpu", numValid: valid, refinedTrials: finalists.length,
            gpuBestScore: finalists[0].score, batches, bufferBytes: p.table.byteLength + batch * 8 + 48});
        const end = performance.now();
        result.params.timing = {setupMs: ready - start, searchMs: searched - ready, refineMs: end - searched, totalMs: end - start};
        return result;
    } catch (e) {
        if (e.message === "cancelled" || e instanceof GpuComputeError) throw e;
        throw new GpuComputeError(`Monte Carlo GPU search failed: ${e.message}`);
    } finally {
        for (const b of created) b.destroy();
    }
}
