import {InundationWorkerCore} from "./InundationWorkerCore";
import {InundationRasterCache} from "./InundationRaster";

const yieldTask = () => new Promise(resolve => setTimeout(resolve, 0));

// Export the message handler so its cancellation/acknowledgement protocol can
// be exercised without starting a browser or a second calculation implementation.
export function createInundationWorkerHandler(core, postMessage) {
    let currentId = 0, queue = Promise.resolve(), unaccepted = null;
    const snapshotGeometry = () => ({
        records: core.records, barriers: core.barriers, domain: core.domain, geometryId: core.geometryId,
        // Raster grids and edge maps are immutable after publication. Its
        // object fields are replaced per build, so this shallow copy is enough.
        raster: Object.assign(Object.create(Object.getPrototypeOf(core.raster)), core.raster),
    });
    const rollback = () => {
        if (!unaccepted) return;
        Object.assign(core, unaccepted.before);
        unaccepted = null;
    };
    return ({data}) => {
        if (data.type === "accept") {
            if (unaccepted?.id === data.id && unaccepted.complete && currentId === data.id) unaccepted = null;
            return queue;
        }
        if (data.type === "cancel") {
            if (currentId === data.id) currentId = 0;
            // A running calculation may still be inside an async checkpoint.
            // Restore only after it stops writing, before the next queued job.
            queue = queue.catch(() => {}).then(() => {
                if (unaccepted?.id === data.id) rollback();
            });
            return queue;
        }
        if (data.type === "clearGeometry") {
            currentId = 0;
            queue = queue.catch(() => {}).then(() => {
                rollback();
                core.records = new Map();
                core.raster = new InundationRasterCache();
                core.barriers = null;
                core.domain = undefined;
                core.geometryId = undefined;
                // The shared worker can still fill terrain-only inundation.
                // Keep its terrain grid and geoid when disabling 3D geometry.
            });
            return queue;
        }
        const {id, type, payload} = data;
        currentId = id;
        // Serialize cache writes; discard queued obsolete jobs before touching data.
        queue = queue.catch(() => {}).then(async () => {
            if (id !== currentId) return;
            // A following job is never allowed to use an unaccepted edit,
            // including a tile that has since left the display cache.
            rollback();
            if (type === "geometry") unaccepted = {id, before: snapshotGeometry(), complete: false};
            let lastYield = performance.now(), lastProgress = -Infinity, lastStage;
            const checkpoint = async force => {
                if (id !== currentId) throw new Error("cancelled");
                if (force || performance.now() - lastYield >= 20) {
                    await yieldTask();
                    lastYield = performance.now();
                    if (id !== currentId) throw new Error("cancelled");
                }
            };
            const onProgress = (stage, done, total) => {
                const now = performance.now();
                if (stage !== lastStage || done === total || now - lastProgress >= 100) {
                    postMessage({id, progress: {stage, done, total, fraction: total ? done / total : 1}});
                    lastStage = stage; lastProgress = now;
                }
            };
            try {
                const start = performance.now();
                const result = await core[type](payload, checkpoint, onProgress);
                await checkpoint();
                result.elapsedMs = performance.now() - start;
                // Cached grids stay in the worker. Transfer a snapshot, never the
                // cache's backing buffers or any live Three.js vertex buffer.
                const output = type === "geometry" ? {...result, barriers: Object.fromEntries(
                    Object.entries(result.barriers).map(([key, value]) => [key, ArrayBuffer.isView(value) ? value.slice() : value]))} : result;
                const buffers = new Set();
                const collect = value => {
                    if (ArrayBuffer.isView(value)) buffers.add(value.buffer);
                    else if (value && typeof value === "object") for (const item of Object.values(value)) collect(item);
                };
                collect(output);
                if (type === "geometry") unaccepted.complete = true;
                postMessage({id, result: output}, [...buffers]);
            } catch (error) {
                if (unaccepted?.id === id) rollback();
                if (id === currentId) postMessage({id, error: error.message});
            }
        });
        return queue;
    };
}

if (typeof self !== "undefined") {
    self.onmessage = createInundationWorkerHandler(new InundationWorkerCore(), (message, transfer) => self.postMessage(message, transfer));
}
