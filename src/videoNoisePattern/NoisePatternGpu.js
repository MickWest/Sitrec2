// NoisePatternGpu - WebGPU compute for the blind strip assignment of Noise Pattern
// Detection. Imported only by src/workers/NoisePatternGpuWorker.js.
//
// The strip profiles of a plane live on the GPU as one storage buffer: frame-major, then
// column, then 48 Int8 band values packed 4 to a u32 (the CPU layout read as u32). One
// 64-thread workgroup handles one probe of one frame pair: each thread scores up to
// ceil((columns - 1) / 64) source positions with packed 4x8-bit integer dot products, and a
// workgroup reduction finds the best position (c1, s*) and the best position at least two
// columns away (c2). Only these three numbers per probe are read back; the pair statistics
// are then made by the same reducePair() the CPU path uses.

import {BAND_STRIDE, createMatchScratch, probeCount, reducePair} from "./NoisePatternMath";

const GPU_BUFFER = {MAP_READ: 0x0001, COPY_SRC: 0x0004, COPY_DST: 0x0008, UNIFORM: 0x0040, STORAGE: 0x0080};
const MAP_READ = 0x0001;
const WORKGROUP = 64;
const WORDS = BAND_STRIDE / 4;          // u32 words per column
const MAX_PAIRS_PER_DISPATCH = 4096;

export class GpuSearchError extends Error {
    constructor(message) { super(message); this.name = "GpuSearchError"; }
}

export function searchWGSL(columns, packedDot) {
    const ns = columns - 1;
    const perThread = Math.max(1, Math.ceil(ns / WORKGROUP));
    const probes = probeCount(columns);
    const dot = packedDot
        ? "dot4I8Packed(a, b)"
        : "dot4Unpacked(a, b)";
    return /* wgsl */ `
const WC: u32 = ${columns}u;
const NS: u32 = ${ns}u;
const OPT: u32 = ${perThread}u;
const PROBES: u32 = ${probes}u;
const WORDS: u32 = ${WORDS}u;
struct Params { count: u32, pad0: u32, pad1: u32, pad2: u32 };
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> strips: array<u32>;
@group(0) @binding(2) var<storage, read> energy: array<f32>;
@group(0) @binding(3) var<storage, read> pairs: array<vec2<u32>>;
@group(0) @binding(4) var<storage, read_write> outv: array<vec4<f32>>;
var<workgroup> redV: array<f32, ${WORKGROUP}>;
var<workgroup> redI: array<u32, ${WORKGROUP}>;

fn dot4Unpacked(a: u32, b: u32) -> i32 {
    let x = bitcast<i32>(a);
    let y = bitcast<i32>(b);
    return extractBits(x, 0u, 8u) * extractBits(y, 0u, 8u) + extractBits(x, 8u, 8u) * extractBits(y, 8u, 8u)
         + extractBits(x, 16u, 8u) * extractBits(y, 16u, 8u) + extractBits(x, 24u, 8u) * extractBits(y, 24u, 8u);
}

@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) li: u32) {
    let probe = wg.x;
    let pairIndex = wg.y;
    if (pairIndex >= params.count) { return; }
    let pr = pairs[pairIndex];
    let tCol = pr.x * WC + 2u * probe;
    var tv: array<u32, ${2 * WORDS}>;
    for (var k = 0u; k < ${2 * WORDS}u; k++) { tv[k] = strips[tCol * WORDS + k]; }
    let eT = energy[tCol] + energy[tCol + 1u];
    var vals: array<f32, ${perThread}>;
    var bestV = -3.0;
    var bestI = 0u;
    for (var j = 0u; j < OPT; j++) {
        let off = li + ${WORKGROUP}u * j;
        var v = -3.0;
        if (off < NS) {
            let sCol = pr.y * WC + off;
            var acc = 0i;
            for (var k = 0u; k < ${2 * WORDS}u; k++) {
                let a = tv[k];
                let b = strips[sCol * WORDS + k];
                acc += ${dot};
            }
            let den = eT * (energy[sCol] + energy[sCol + 1u]);
            v = select(0.0, f32(acc) / sqrt(den), den > 0.0);
        }
        vals[j] = v;
        if (v > bestV) { bestV = v; bestI = off; }
    }
    redV[li] = bestV;
    redI[li] = bestI;
    workgroupBarrier();
    for (var stride = ${WORKGROUP / 2}u; stride > 0u; stride = stride >> 1u) {
        if (li < stride) {
            let ov = redV[li + stride];
            let oi = redI[li + stride];
            if (ov > redV[li] || (ov == redV[li] && oi < redI[li])) { redV[li] = ov; redI[li] = oi; }
        }
        workgroupBarrier();
    }
    let c1 = redV[0];
    let sb = redI[0];
    workgroupBarrier();
    var second = -3.0;
    for (var j = 0u; j < OPT; j++) {
        let off = li + ${WORKGROUP}u * j;
        if (off < NS && (off + 2u <= sb || off >= sb + 2u)) { second = max(second, vals[j]); }
    }
    redV[li] = second;
    workgroupBarrier();
    for (var stride = ${WORKGROUP / 2}u; stride > 0u; stride = stride >> 1u) {
        if (li < stride) { redV[li] = max(redV[li], redV[li + stride]); }
        workgroupBarrier();
    }
    if (li == 0u) { outv[pairIndex * PROBES + probe] = vec4<f32>(c1, f32(sb), redV[0], 0.0); }
}
`;
}

export async function createGpuSearch() {
    if (typeof navigator === "undefined" || !navigator.gpu) throw new GpuSearchError("WebGPU is not available");
    const adapter = await navigator.gpu.requestAdapter({powerPreference: "high-performance"});
    if (!adapter) throw new GpuSearchError("No WebGPU adapter");
    const want = (name, cap) => Math.min(adapter.limits[name], cap);
    const device = await adapter.requestDevice({requiredLimits: {
        maxStorageBufferBindingSize: want("maxStorageBufferBindingSize", 1 << 30),
        maxBufferSize: want("maxBufferSize", 1 << 30),
    }});
    let lost = null;
    device.lost.then(info => { lost = info?.message || info?.reason || "device lost"; });
    const packedDot = !!navigator.gpu.wgslLanguageFeatures?.has?.("packed_4x8_integer_dot_product");
    const adapterInfo = adapter.info ?? {};
    const info = {vendor: adapterInfo.vendor ?? "", architecture: adapterInfo.architecture ?? "",
        description: adapterInfo.description ?? "", packedDot,
        maxBinding: device.limits.maxStorageBufferBindingSize};
    const planes = new Map();       // plane -> {columns, rows, strips, energy, cpuEnergy}
    const pipelines = new Map();

    async function pipelineFor(columns) {
        if (!pipelines.has(columns)) {
            const pending = (async () => {
                device.pushErrorScope("validation");
                const module = device.createShaderModule({code: searchWGSL(columns, packedDot), label: `noise pattern search ${columns}`});
                const compiled = await module.getCompilationInfo();
                const errors = compiled.messages.filter(m => m.type === "error");
                if (errors.length) {
                    await device.popErrorScope();
                    throw new GpuSearchError(errors.map(m => `${m.lineNum}: ${m.message}`).join("; "));
                }
                const pipeline = await device.createComputePipelineAsync({layout: "auto", compute: {module, entryPoint: "main"}});
                const error = await device.popErrorScope();
                if (error) throw new GpuSearchError(error.message);
                return pipeline;
            })();
            pipelines.set(columns, pending);
            pending.catch(() => pipelines.delete(columns));
        }
        return pipelines.get(columns);
    }

    function check() { if (lost) throw new GpuSearchError(`GPU device lost: ${lost}`); }

    // Creates the plane's buffers on the first slice (rows = total frames).
    async function upload(plane, columns, rows, offsetRow, strips, energies) {
        check();
        let entry = planes.get(plane);
        if (!entry || entry.columns !== columns || entry.rows !== rows) {
            entry?.strips.destroy(); entry?.energy.destroy();
            const stripBytes = rows * columns * BAND_STRIDE;
            if (stripBytes > device.limits.maxStorageBufferBindingSize) throw new GpuSearchError("The strip profiles do not fit in one GPU buffer");
            device.pushErrorScope("out-of-memory");
            device.pushErrorScope("validation");
            entry = {columns, rows,
                strips: device.createBuffer({size: stripBytes, usage: GPU_BUFFER.STORAGE | GPU_BUFFER.COPY_DST}),
                energy: device.createBuffer({size: Math.max(4, rows * columns * 4), usage: GPU_BUFFER.STORAGE | GPU_BUFFER.COPY_DST}),
                cpuEnergy: new Float32Array(rows * columns)};
            const errors = await Promise.all([device.popErrorScope(), device.popErrorScope()]);
            const error = errors.find(Boolean);
            if (error) throw new GpuSearchError(error.message);
            planes.set(plane, entry);
        }
        device.queue.writeBuffer(entry.strips, offsetRow * columns * BAND_STRIDE, strips.buffer, strips.byteOffset, strips.byteLength);
        device.queue.writeBuffer(entry.energy, offsetRow * columns * 4, energies.buffer, energies.byteOffset, energies.byteLength);
        entry.cpuEnergy.set(energies, offsetRow * columns);
    }

    // pairs: Int32Array [target, source, ...] (frame rows). Returns Float32Array(n * 4):
    // [Q, C, nValid, shift] per pair, reduced with the CPU code.
    async function search(plane, pairs, colWidth) {
        check();
        const entry = planes.get(plane);
        if (!entry) throw new GpuSearchError("Strip profiles were not uploaded");
        const {columns} = entry;
        const P = probeCount(columns);
        const pipeline = await pipelineFor(columns);
        const total = pairs.length / 2;
        const results = new Float32Array(total * 4);
        const scratch = createMatchScratch(columns);
        const c1 = new Float32Array(P), c2 = new Float32Array(P), sBest = new Int16Array(P), norm = new Float32Array(P);
        const slotCount = 2;
        const maxBatch = Math.min(MAX_PAIRS_PER_DISPATCH, total || 1);
        const created = [];
        const make = (size, usage) => { const b = device.createBuffer({size, usage}); created.push(b); return b; };
        device.pushErrorScope("out-of-memory");
        device.pushErrorScope("validation");
        const slots = [];
        for (let i = 0; i < slotCount; i++) {
            const params = make(16, GPU_BUFFER.UNIFORM | GPU_BUFFER.COPY_DST);
            const pairBuffer = make(maxBatch * 8, GPU_BUFFER.STORAGE | GPU_BUFFER.COPY_DST);
            const out = make(maxBatch * P * 16, GPU_BUFFER.STORAGE | GPU_BUFFER.COPY_SRC);
            const read = make(maxBatch * P * 16, GPU_BUFFER.MAP_READ | GPU_BUFFER.COPY_DST);
            const group = device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries: [
                {binding: 0, resource: {buffer: params}}, {binding: 1, resource: {buffer: entry.strips}},
                {binding: 2, resource: {buffer: entry.energy}}, {binding: 3, resource: {buffer: pairBuffer}},
                {binding: 4, resource: {buffer: out}}]});
            slots.push({params, pairBuffer, out, read, group, pending: null, start: 0, count: 0});
        }
        const setupErrors = await Promise.all([device.popErrorScope(), device.popErrorScope()]);
        const setupError = setupErrors.find(Boolean);
        try {
            if (setupError) throw new GpuSearchError(setupError.message);
            const finish = async (slot) => {
                await slot.pending;
                check();
                const bytes = slot.count * P * 16;
                const values = new Float32Array(slot.read.getMappedRange(0, bytes).slice(0));
                slot.read.unmap();
                for (let i = 0; i < slot.count; i++) {
                    const pairIndex = slot.start + i;
                    const t = pairs[2 * pairIndex];
                    for (let k = 0; k < P; k++) {
                        const o = (i * P + k) * 4;
                        c1[k] = values[o];
                        sBest[k] = values[o + 1];
                        c2[k] = values[o + 2] < -2 ? values[o] : values[o + 2];
                        norm[k] = Math.sqrt(entry.cpuEnergy[t * columns + 2 * k] + entry.cpuEnergy[t * columns + 2 * k + 1]);
                    }
                    reducePair(c1, c2, sBest, norm, P, colWidth, scratch, results, 4 * pairIndex);
                }
                slot.pending = null;
            };
            let slotIndex = 0;
            for (let start = 0; start < total; start += maxBatch) {
                const slot = slots[slotIndex];
                if (slot.pending) await finish(slot);
                const count = Math.min(maxBatch, total - start);
                const pairData = new Uint32Array(count * 2);
                for (let i = 0; i < count * 2; i++) pairData[i] = pairs[2 * start + i];
                device.pushErrorScope("validation");
                device.queue.writeBuffer(slot.params, 0, new Uint32Array([count, 0, 0, 0]));
                device.queue.writeBuffer(slot.pairBuffer, 0, pairData);
                const encoder = device.createCommandEncoder();
                const pass = encoder.beginComputePass();
                pass.setPipeline(pipeline);
                pass.setBindGroup(0, slot.group);
                pass.dispatchWorkgroups(P, count);
                pass.end();
                encoder.copyBufferToBuffer(slot.out, 0, slot.read, 0, count * P * 16);
                device.queue.submit([encoder.finish()]);
                const dispatchError = await device.popErrorScope();
                if (dispatchError) throw new GpuSearchError(dispatchError.message);
                slot.start = start;
                slot.count = count;
                slot.pending = slot.read.mapAsync(MAP_READ, 0, count * P * 16);
                slotIndex = (slotIndex + 1) % slotCount;
            }
            for (let i = 0; i < slotCount; i++) {
                const slot = slots[(slotIndex + i) % slotCount];
                if (slot.pending) await finish(slot);
            }
        } finally {
            for (const b of created) b.destroy();
        }
        return results;
    }

    function release() {
        for (const entry of planes.values()) { entry.strips.destroy(); entry.energy.destroy(); }
        planes.clear();
    }

    return {info, upload, search, release, device};
}
