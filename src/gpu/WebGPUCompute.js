/**
 * WebGPUCompute.js — shared WebGPU device for compute work (fit searches).
 *
 * The device is requested lazily, on the first GPU fit, and shared by every
 * caller in this realm (the page, or one worker). Where WebGPU does not exist
 * (Node, Jest, older browsers, a software-only headless browser) getComputeDevice
 * resolves to null and callers use their CPU path. A lost device is forgotten, so
 * the next call requests a new one.
 */

// WebGPU flag values from the specification. Local constants, so this module
// loads (and lints) where the GPU* globals do not exist.
export const GPU_BUFFER = Object.freeze({
    MAP_READ: 0x0001, COPY_SRC: 0x0004, COPY_DST: 0x0008, UNIFORM: 0x0040, STORAGE: 0x0080,
});
export const GPU_SHADER_STAGE_COMPUTE = 0x4;
export const GPU_MAP_MODE_READ = 0x0001;

let _devicePromise = null;

/** True when this realm exposes the WebGPU API at all (an adapter may still be refused). */
export function webgpuAvailable() {
    return typeof navigator !== "undefined" && !!navigator.gpu;
}

/**
 * The shared compute device, or null when WebGPU or a GPU adapter is unavailable.
 * Never throws.
 */
export function getComputeDevice() {
    if (!webgpuAvailable()) return Promise.resolve(null);
    if (!_devicePromise) {
        _devicePromise = (async () => {
            const adapter = await navigator.gpu.requestAdapter({powerPreference: "high-performance"});
            if (!adapter) return null;
            const device = await adapter.requestDevice();
            device.lost.then((info) => {
                console.warn(`WebGPU compute device lost (${info?.reason ?? "unknown"}): ${info?.message ?? ""}`);
                _devicePromise = null;
            });
            return device;
        })().catch((e) => {
            console.warn("WebGPU compute device unavailable:", e);
            _devicePromise = null;
            return null;
        });
    }
    return _devicePromise;
}

/** Error for a GPU-side failure (validation, compilation, device loss): callers fall back to the CPU. */
export class GpuComputeError extends Error {
    constructor(message) {
        super(message);
        this.name = "GpuComputeError";
    }
}
