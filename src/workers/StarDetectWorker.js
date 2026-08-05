// Worker half of the parallel star detection pass. See StarDetectPool.js for the main-thread
// half and for the design; this file is deliberately a transport shim and nothing else.
//
// IT IMPORTS THE REAL DETECTOR rather than carrying a copy, for the same reason StarSphereWorker
// does: the analysis must produce results IDENTICAL to the synchronous path, not equivalent ones,
// and running literally the same source on the same bytes is the only way to keep that true
// without a promise to remember. StarDetect is pure - no DOM, no THREE, no Sitrec globals - which
// is what makes this a one-line body.
//
// PROTOCOL. One message in: {rgba: ArrayBuffer, W, H, opts}, the pixel buffer TRANSFERRED by the
// pool so a frame is never copied. One message out: {sources} on success, {error} on failure.
// Only the sources go back - the background model detectSources also returns is several
// Float32Array planes the analysis loop never reads, and cloning them per frame would be most of
// the reply's cost for nothing.

import {detectSources} from "../starTrack/StarDetect";

self.onmessage = (e) => {
    const {rgba, W, H, opts} = e.data;
    try {
        const {sources} = detectSources(new Uint8ClampedArray(rgba), W, H, opts);
        self.postMessage({sources});
    } catch (err) {
        // Reported rather than thrown, so the pool can re-run the frame on the main thread with
        // a reason instead of seeing an opaque `onerror`.
        self.postMessage({error: (err && err.message) || String(err)});
    }
};
