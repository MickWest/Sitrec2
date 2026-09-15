/**
 * GpuDifferentialEvolution.js — differential evolution that runs on the GPU.
 *
 * Mutation, crossover, bound reflection, the cost and selection all run in WGSL.
 * The host queues whole generations and reads the population back once, so an
 * evaluation costs no CPU time at all and a population of thousands is cheap.
 *
 * Several INDEPENDENT searches share the buffers: `instances` blocks of `pop`
 * members, each with its own bounds and optional seed vector, whose donors are
 * drawn only from inside their own block. Independent restarts, or one search per
 * held parameter value, therefore run in the same dispatches.
 *
 * DIFFERENCES FROM THE CPU differentialEvolution (DifferentialEvolution.js), which
 * make results differ from the CPU path by design:
 *   - Generation-synchronous: every trial is built from the population as it was
 *     at the start of the generation (the CPU version replaces members as it goes).
 *   - Random numbers come from a counter-based PCG hash of (seed, generation,
 *     member), not from mulberry32. The initial population does use mulberry32.
 *   - Costs are f32. The kernel is responsible for keeping them accurate (see the
 *     kernels' notes); callers must re-score anything they report in f64.
 * Repeatable for the same inputs on the same GPU and driver. Not guaranteed to be
 * bit-identical across GPUs, because f32 sin/exp/atan2 are not correctly rounded.
 *
 * A kernel supplies:
 *   {key, dim, wgsl, params: Float32Array, table: Float32Array}
 * where `wgsl` defines `fn cost(p: Params) -> f32` and may read
 *   @group(1) @binding(0) kparams: array<f32>   (small scalars)
 *   @group(1) @binding(1) ktable:  array<f32>   (per-frame data)
 * `Params` is `array<f32, dim>` and `DIM` is the dimension, both defined here.
 * The cost must stay finite (return a large sentinel such as 1e9 or 3e38 instead
 * of producing inf or NaN, whose handling is not portable across shader compilers).
 *
 * WGSL COMPILERS DIFFER. Chrome's compiler rejects some expressions others accept
 * (for example `a * b ^ c` needs parentheses in Chrome but not in Deno). Check any
 * WGSL change by compiling it in Chrome; a module that fails there makes every fit
 * quietly fall back to the CPU search, with only a console warning.
 */

import {mulberry32} from "../DifferentialEvolution";
import {
    getComputeDevice, GpuComputeError,
    GPU_BUFFER, GPU_MAP_MODE_READ, GPU_SHADER_STAGE_COMPUTE,
} from "./WebGPUCompute";

const WORKGROUP = 32;
const SEED_STRIDE = 0x9E3779;

function deWGSL(dim) {
    return /* wgsl */ `
const DIM: u32 = ${dim}u;
alias Params = array<f32, ${dim}>;

struct DECfg { popTotal: u32, block: u32, gen: u32, seed: u32, F: f32, CR: f32, _p0: f32, _p1: f32 };
@group(0) @binding(0) var<uniform> de: DECfg;
@group(0) @binding(1) var<storage, read> bounds: array<f32>;        // per instance: lo[DIM], hi[DIM]
@group(0) @binding(2) var<storage, read_write> pop: array<f32>;
@group(0) @binding(3) var<storage, read_write> popCost: array<f32>;
@group(0) @binding(4) var<storage, read_write> trial: array<f32>;
@group(0) @binding(5) var<storage, read_write> trialCost: array<f32>;
@group(1) @binding(0) var<storage, read> kparams: array<f32>;
@group(1) @binding(1) var<storage, read> ktable: array<f32>;

fn pcgHash(v: u32) -> u32 {
    let s = v * 747796405u + 2891336453u;
    let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
    return (w >> 22u) ^ w;
}
fn rand01(s: ptr<function, u32>) -> f32 { *s = pcgHash(*s); return f32(*s >> 8u) / 16777216.0; }
fn randBelow(s: ptr<function, u32>, m: u32) -> u32 { *s = pcgHash(*s); return (*s) % m; }

fn readMember(fromTrial: bool, i: u32) -> Params {
    var p: Params;
    for (var d = 0u; d < DIM; d++) { p[d] = select(pop[i * DIM + d], trial[i * DIM + d], fromTrial); }
    return p;
}

@compute @workgroup_size(${WORKGROUP})
fn evalPop(@builtin(global_invocation_id) gid: vec3u) {
    let i = gid.x;
    if (i >= de.popTotal) { return; }
    popCost[i] = cost(readMember(false, i));
}

// DE/rand/1/bin with the CPU version's bound reflection. The three donors are
// distinct, differ from the target, and come from the target's own instance.
@compute @workgroup_size(${WORKGROUP})
fn mutate(@builtin(global_invocation_id) gid: vec3u) {
    let i = gid.x;
    if (i >= de.popTotal) { return; }
    let M = de.block;
    let inst = i / M;
    let base = inst * M;
    let li = i - base;
    var s = pcgHash(de.seed ^ pcgHash((de.gen * 0x9E3779B9u) ^ pcgHash(i)));
    var a = randBelow(&s, M - 1u);
    if (a >= li) { a += 1u; }
    let lo1 = min(li, a);
    let hi1 = max(li, a);
    var b = randBelow(&s, M - 2u);
    if (b >= lo1) { b += 1u; }
    if (b >= hi1) { b += 1u; }
    var ex = array<u32, 3>(li, a, b);
    if (ex[0] > ex[1]) { let t = ex[0]; ex[0] = ex[1]; ex[1] = t; }
    if (ex[1] > ex[2]) { let t = ex[1]; ex[1] = ex[2]; ex[2] = t; }
    if (ex[0] > ex[1]) { let t = ex[0]; ex[0] = ex[1]; ex[1] = t; }
    var c = randBelow(&s, M - 3u);
    if (c >= ex[0]) { c += 1u; }
    if (c >= ex[1]) { c += 1u; }
    if (c >= ex[2]) { c += 1u; }
    let jr = randBelow(&s, DIM);
    let bo = inst * 2u * DIM;
    for (var d = 0u; d < DIM; d++) {
        var v = pop[i * DIM + d];
        if (d == jr || rand01(&s) < de.CR) {
            v = pop[(base + a) * DIM + d] + de.F * (pop[(base + b) * DIM + d] - pop[(base + c) * DIM + d]);
            let l = bounds[bo + d];
            let h = bounds[bo + DIM + d];
            if (v < l) { v = l + rand01(&s) * (h - l) * 0.1; }
            if (v > h) { v = h - rand01(&s) * (h - l) * 0.1; }
        }
        trial[i * DIM + d] = v;
    }
}

@compute @workgroup_size(${WORKGROUP})
fn evalTrial(@builtin(global_invocation_id) gid: vec3u) {
    let i = gid.x;
    if (i >= de.popTotal) { return; }
    trialCost[i] = cost(readMember(true, i));
}

@compute @workgroup_size(${WORKGROUP})
fn selectMembers(@builtin(global_invocation_id) gid: vec3u) {
    let i = gid.x;
    if (i >= de.popTotal) { return; }
    if (trialCost[i] <= popCost[i]) {
        for (var d = 0u; d < DIM; d++) { pop[i * DIM + d] = trial[i * DIM + d]; }
        popCost[i] = trialCost[i];
    }
}
`;
}

/**
 * Resolve a caller's `gpu` option (true, or {instances, pop, gens}) against a
 * kernel's default budget.
 */
export function resolveGpuBudget(option, defaults) {
    const o = option && typeof option === "object" ? option : {};
    const int = (v, fallback, min) => (Number.isFinite(v) ? Math.max(min, Math.floor(v)) : fallback);
    return {
        instances: int(o.instances, defaults.instances, 1),
        pop: int(o.pop, defaults.pop, 4),
        gens: int(o.gens, defaults.gens, 0),
    };
}

/** The full WGSL module for a kernel: the DE stages followed by the kernel's cost. */
export function composeDifferentialEvolutionWGSL(kernel) {
    return deWGSL(kernel.dim) + "\n" + kernel.wgsl;
}

const _pipelineCache = new WeakMap();

async function pipelinesFor(device, kernel) {
    let perDevice = _pipelineCache.get(device);
    if (!perDevice) { perDevice = new Map(); _pipelineCache.set(device, perDevice); }
    const cacheKey = `${kernel.key}:${kernel.dim}`;
    const hit = perDevice.get(cacheKey);
    if (hit) return hit;

    device.pushErrorScope("validation");
    const module = device.createShaderModule({code: composeDifferentialEvolutionWGSL(kernel), label: `DE ${cacheKey}`});
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === "error");
    const entry = (binding, type) => ({binding, visibility: GPU_SHADER_STAGE_COMPUTE, buffer: {type}});
    const bgl0 = device.createBindGroupLayout({entries: [
        entry(0, "uniform"), entry(1, "read-only-storage"),
        entry(2, "storage"), entry(3, "storage"), entry(4, "storage"), entry(5, "storage"),
    ]});
    const bgl1 = device.createBindGroupLayout({entries: [entry(0, "read-only-storage"), entry(1, "read-only-storage")]});
    const layout = device.createPipelineLayout({bindGroupLayouts: [bgl0, bgl1]});
    const make = (entryPoint) => device.createComputePipeline({layout, compute: {module, entryPoint}});
    const set = {
        bgl0, bgl1,
        evalPop: make("evalPop"), mutate: make("mutate"),
        evalTrial: make("evalTrial"), select: make("selectMembers"),
    };
    const scopeError = await device.popErrorScope();
    if (errors.length || scopeError) {
        const text = errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join("; ") || scopeError.message;
        throw new GpuComputeError(`WGSL pipeline for ${cacheKey} failed: ${text}`);
    }
    perDevice.set(cacheKey, set);
    return set;
}

/**
 * Run `instances.length` independent DE searches on the GPU.
 *
 * @param {object} args
 *   kernel        {key, dim, wgsl, params, table}
 *   instances     [{lo: number[], hi: number[], seedVector?: number[]}]
 *   pop, gens     members per instance (>= 4) and generations
 *   seed          base seed (initial populations and the in-shader hash)
 *   F, CR         DE weights (defaults 0.7, 0.9, as the CPU version)
 *   genChunk      generations queued between waits (cancel and progress granularity)
 *   shouldCancel  () => boolean; a true result throws Error("cancelled")
 *   onProgress    (frac) => void|Promise, called between chunks
 * @returns {Promise<null | {instances: [{params: number[], cost: number}], evaluations, generations}>}
 *   null when no GPU device is available. The costs are the kernel's f32 values.
 * @throws Error("cancelled"), or GpuComputeError on a GPU-side failure.
 */
export async function gpuDifferentialEvolution({
    kernel, instances, pop, gens, seed,
    F = 0.7, CR = 0.9, genChunk = 10, shouldCancel = null, onProgress = null,
}) {
    const device = await getComputeDevice();
    if (!device) return null;
    const dim = kernel.dim;
    if (!(pop >= 4) || !instances.length) throw new Error("gpuDifferentialEvolution: need pop >= 4 and one instance");
    const pipes = await pipelinesFor(device, kernel);
    const total = instances.length * pop;

    const created = [];
    const buffer = (size, usage) => {
        const b = device.createBuffer({size: Math.max(16, Math.ceil(size / 4) * 4), usage});
        created.push(b);
        return b;
    };
    const upload = (data, usage = GPU_BUFFER.STORAGE) => {
        const b = buffer(data.byteLength, usage | GPU_BUFFER.COPY_DST);
        device.queue.writeBuffer(b, 0, data);
        return b;
    };

    device.pushErrorScope("out-of-memory");
    device.pushErrorScope("validation");
    let scopesOpen = true;
    const closeScopes = async () => {
        scopesOpen = false;
        const validation = await device.popErrorScope();
        const oom = await device.popErrorScope();
        return validation ?? oom;
    };
    try {
        const boundsData = new Float32Array(instances.length * 2 * dim);
        const init = new Float32Array(total * dim);
        instances.forEach((inst, k) => {
            boundsData.set(inst.lo, k * 2 * dim);
            boundsData.set(inst.hi, k * 2 * dim + dim);
            const rng = mulberry32((seed + k * SEED_STRIDE) >>> 0);
            for (let i = 0; i < pop; i++) {
                for (let d = 0; d < dim; d++) {
                    init[(k * pop + i) * dim + d] = inst.lo[d] + rng() * (inst.hi[d] - inst.lo[d]);
                }
            }
            if (inst.seedVector) {
                for (let d = 0; d < dim; d++) {
                    init[k * pop * dim + d] = Math.min(inst.hi[d], Math.max(inst.lo[d], inst.seedVector[d]));
                }
            }
        });
        const rw = GPU_BUFFER.STORAGE | GPU_BUFFER.COPY_SRC | GPU_BUFFER.COPY_DST;
        const cfgBuf = buffer(32, GPU_BUFFER.UNIFORM | GPU_BUFFER.COPY_DST);
        const boundsBuf = upload(boundsData);
        const popBuf = upload(init, rw);
        const popCostBuf = buffer(total * 4, rw);
        const trialBuf = buffer(total * dim * 4, rw);
        const trialCostBuf = buffer(total * 4, rw);
        const kparamsBuf = upload(kernel.params);
        const ktableBuf = upload(kernel.table);
        const bg0 = device.createBindGroup({layout: pipes.bgl0, entries: [
            {binding: 0, resource: {buffer: cfgBuf}}, {binding: 1, resource: {buffer: boundsBuf}},
            {binding: 2, resource: {buffer: popBuf}}, {binding: 3, resource: {buffer: popCostBuf}},
            {binding: 4, resource: {buffer: trialBuf}}, {binding: 5, resource: {buffer: trialCostBuf}},
        ]});
        const bg1 = device.createBindGroup({layout: pipes.bgl1, entries: [
            {binding: 0, resource: {buffer: kparamsBuf}}, {binding: 1, resource: {buffer: ktableBuf}},
        ]});

        const cfg = new ArrayBuffer(32);
        const cfgU = new Uint32Array(cfg), cfgF = new Float32Array(cfg);
        cfgU[0] = total; cfgU[1] = pop; cfgU[3] = seed >>> 0;
        cfgF[4] = F; cfgF[5] = CR;
        const groups = Math.ceil(total / WORKGROUP);
        const pass = (encoder, pipeline) => {
            const p = encoder.beginComputePass();
            p.setPipeline(pipeline);
            p.setBindGroup(0, bg0);
            p.setBindGroup(1, bg1);
            p.dispatchWorkgroups(groups);
            p.end();
        };
        const checkCancel = () => {
            if (shouldCancel && shouldCancel()) throw new Error("cancelled");
        };

        // One command buffer per generation, each preceded by its own config
        // write: queue writes and submits are ordered on the queue timeline, so
        // nothing has to be awaited between generations.
        cfgU[2] = 0;
        device.queue.writeBuffer(cfgBuf, 0, cfg);
        let encoder = device.createCommandEncoder();
        pass(encoder, pipes.evalPop);
        device.queue.submit([encoder.finish()]);
        for (let g = 0; g < gens; g++) {
            cfgU[2] = g + 1;
            device.queue.writeBuffer(cfgBuf, 0, cfg);
            encoder = device.createCommandEncoder();
            pass(encoder, pipes.mutate);
            pass(encoder, pipes.evalTrial);
            pass(encoder, pipes.select);
            device.queue.submit([encoder.finish()]);
            if ((g + 1) % genChunk === 0 && g + 1 < gens) {
                await device.queue.onSubmittedWorkDone();
                checkCancel();
                if (onProgress) await onProgress((g + 1) / gens);
            }
        }

        const readPop = buffer(total * dim * 4, GPU_BUFFER.MAP_READ | GPU_BUFFER.COPY_DST);
        const readCost = buffer(total * 4, GPU_BUFFER.MAP_READ | GPU_BUFFER.COPY_DST);
        encoder = device.createCommandEncoder();
        encoder.copyBufferToBuffer(popBuf, 0, readPop, 0, total * dim * 4);
        encoder.copyBufferToBuffer(popCostBuf, 0, readCost, 0, total * 4);
        device.queue.submit([encoder.finish()]);
        await Promise.all([readPop.mapAsync(GPU_MAP_MODE_READ), readCost.mapAsync(GPU_MAP_MODE_READ)]);
        const popOut = new Float32Array(readPop.getMappedRange(0, total * dim * 4).slice(0));
        const costOut = new Float32Array(readCost.getMappedRange(0, total * 4).slice(0));
        readPop.unmap();
        readCost.unmap();

        const scopeError = await closeScopes();
        if (scopeError) throw new GpuComputeError(scopeError.message);
        checkCancel();

        const results = instances.map((_, k) => {
            let bi = k * pop;
            for (let i = k * pop + 1; i < (k + 1) * pop; i++) if (costOut[i] < costOut[bi]) bi = i;
            return {params: Array.from(popOut.subarray(bi * dim, bi * dim + dim)), cost: costOut[bi]};
        });
        return {instances: results, evaluations: total * (gens + 1), generations: gens};
    } catch (e) {
        // Leave the error scopes balanced whatever threw.
        if (scopesOpen) await closeScopes().catch(() => null);
        throw e;
    } finally {
        for (const b of created) b.destroy();
    }
}
