// Main-thread half of the parallel detection pass: detectSources across a worker pool.
//
// WHY. The Analyze scan runs detectSources once per frame, and on real clips that is nearly the
// whole pass: each frame costs tens to hundreds of milliseconds of pure computation (background
// mesh, matched-filter blur, flood fill, aperture photometry), serialized on the UI thread behind
// the decode of the frame before it. Every frame is independent of every other, which is the
// easiest parallelism there is - the decode stays sequential on the main thread (the decoder,
// the canvas readback and par.frame all live there) and feeds frames to this pool, so decode and
// detection overlap AND detection uses all the cores.
//
// DETERMINISM. The workers run the SAME detector, imported from StarDetect.js, not a copy - the
// StarSphereWorker argument, and the same stakes: rendered-pixel regression tests compare star
// overlays, so the parallel pass must return what the synchronous pass returns exactly. Each
// frame is a single indivisible job, so there is no chunk boundary to move a value across; the
// caller finalizes results in frame order whatever order they complete in.
//
// FALLBACK. No Worker (Jest, non-browser), a spawn failure, or a worker error all fall back to
// running the detector on the main thread. Same code, same answer, just slower - the caller owns
// that path because it also owns re-decoding the frame (the pixel buffer was transferred away).

// Workers idle between Analyze runs hold no frame data - the buffers are transient per job - so
// the pool is kept briefly for the next run rather than torn down and respawned per click.
const IDLE_TERMINATE_MS = 60000;

let pool = null;            // {count, slots: [...], queue: [...]}
let idleTimer = null;

export function detectWorkersAvailable() {
    return typeof Worker !== "undefined";
}

function workerCountFor(W, H) {
    // One core left for the UI thread, which still decodes frames, renders the progress bar and
    // stays responsive to the abort button while this runs.
    const n = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4;
    const byCores = Math.max(1, Math.min(8, n - 1));
    // detectSources' transient working set is ~48 bytes per pixel (the RGBA in, luma and
    // smoothed planes, per-pixel background and sigma, labels and the flood-fill stack), so on
    // large frames the pool is bounded by memory rather than cores: eight workers on a
    // 12-megapixel image would peak around 4 GB at once, which is how a tab dies. A ~1.5 GB
    // budget across the pool leaves 1080p-class footage at the full core count.
    const byMemory = Math.max(1, Math.floor(1.5e9 / (48 * W * H)));
    return Math.min(byCores, byMemory);
}

function startJob(slot, job) {
    slot.busy = true;
    slot.resolve = job.resolve;
    slot.reject = job.reject;
    slot.w.postMessage(job.msg, job.transfer);
}

/** A slot's job has ended (either way): start the next queued one, or arm the idle teardown. */
function finishSlot(slot) {
    slot.busy = false;
    slot.resolve = null;
    slot.reject = null;
    if (!pool) return;                       // torn down while the reply was in flight
    const next = pool.queue.shift();
    if (next) { startJob(slot, next); return; }
    if (pool.slots.every((s) => !s.busy)) scheduleIdleTerminate();
}

function makeSlot() {
    const slot = {
        w: new Worker(new URL("../workers/StarDetectWorker.js", import.meta.url)),
        busy: false, resolve: null, reject: null,
    };
    slot.w.onmessage = (e) => {
        const done = slot.resolve, fail = slot.reject;
        finishSlot(slot);
        if (e.data && e.data.error) {
            if (fail) fail(new Error(`star detect worker: ${e.data.error}`));
            return;
        }
        if (done) done(e.data.sources);
    };
    slot.w.onerror = (err) => {
        const fail = slot.reject;
        finishSlot(slot);
        if (fail) fail(err instanceof Error ? err : new Error(String((err && err.message) || err)));
    };
    return slot;
}

function scheduleIdleTerminate() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { idleTimer = null; terminateDetectWorkers(); }, IDLE_TERMINATE_MS);
}

/**
 * Build (or keep) a pool sized for frames of W x H. Returns the worker count, which the caller
 * uses to bound how far its decode runs ahead of its detections.
 */
export function ensureDetectPool(W, H) {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    const count = workerCountFor(W, H);
    if (pool && pool.count === count) return count;
    terminateDetectWorkers();
    pool = {count, slots: [], queue: []};
    for (let i = 0; i < count; i++) pool.slots.push(makeSlot());
    return count;
}

/**
 * Detect sources in one frame on the pool. TAKES OWNERSHIP of rgba: the underlying buffer is
 * transferred to the worker, so the caller's view is detached the moment this is called.
 * Resolves to the detector's `sources` array.
 */
export function detectInPool(rgba, W, H, opts) {
    return new Promise((resolve, reject) => {
        if (!pool) { reject(new Error("star detect pool not built")); return; }
        // A fresh job disarms the idle teardown: it is armed whenever every slot goes quiet,
        // which on a decode-bound clip can happen repeatedly in the middle of a run.
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
        const job = {msg: {rgba: rgba.buffer, W, H, opts}, transfer: [rgba.buffer], resolve, reject};
        const slot = pool.slots.find((s) => !s.busy);
        if (slot) startJob(slot, job);
        else pool.queue.push(job);
    });
}

export function terminateDetectWorkers() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (!pool) return;
    const {slots, queue} = pool;
    // Nulled FIRST, so the rejections below cannot make finishSlot restart queued jobs onto
    // workers that are being terminated.
    pool = null;
    for (const slot of slots) {
        slot.w.onmessage = null;
        slot.w.onerror = null;
        // Terminate, not a polite flag: a frame already inside detectSources cannot be
        // interrupted any other way, and an abort has to stop burning the cores immediately.
        slot.w.terminate();
        // A terminated worker will never answer, so anything waiting on it has to be failed here
        // or it waits forever - a hung analysis with no error, which is the worst way to lose.
        const fail = slot.reject;
        slot.busy = false;
        slot.resolve = slot.reject = null;
        if (fail) fail(new Error("star detect worker terminated"));
    }
    // Unlike the sphere pool this one queues jobs beyond the slot count, and a queued job holds
    // a transferred frame nobody else can finish - it must be failed, not leaked.
    for (const job of queue) job.reject(new Error("star detect worker terminated"));
}
