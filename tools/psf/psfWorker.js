// psfWorker.js — ES MODULE Web Worker.
//
// Holds the FFT off the UI thread. An in-focus 512^2 PSF is one transform plus 32 resamples
// (~0.5 s); a defocused one is 32 transforms (~5 s), and doing either inline would freeze
// every slider on the page for that long. Progress is streamed so the defocused case shows
// movement rather than looking hung.
//
// Cancellation is by terminate-and-respawn in app.js rather than a checked flag: the inner
// loop is a tight numeric kernel and a per-iteration abort test costs more than the restart.

// A module worker does not inherit the page's import map, so the cache-busting query has to
// be carried across by hand - otherwise the worker can keep running a stale engine while the
// main thread runs a fresh one, and the two disagree with no visible symptom.
const VERSION = new URL(import.meta.url).search;
const enginePromise = import("./psf.js" + VERSION);

self.onmessage = async (e) => {
    const { spec, id } = e.data;
    try {
        const { computePSF } = await enginePromise;
        const result = computePSF(spec, (p) => self.postMessage({ type: "progress", id, p }));
        // Transfer the buffers rather than structured-cloning them: a 512^2 RGB float array
        // is 3 MB, and the masks another 1 MB each.
        const transfer = [result.rgb.buffer, ...result.masks.map((m) => m.buffer)];
        self.postMessage({
            type: "done", id,
            n: result.n, rgb: result.rgb, masks: result.masks,
            peak: result.peak, sampling: result.sampling, ms: result.ms,
        }, transfer);
    } catch (err) {
        self.postMessage({ type: "error", id, message: String(err && err.message || err) });
    }
};
