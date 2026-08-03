// Worker half of the parallel spherical solve. See StarSphereSolvePool.js for the main-thread
// half and for the design; this file is deliberately a transport shim and nothing else.
//
// IT IMPORTS THE REAL KERNELS rather than carrying a copy of the maths, which is the whole point.
// A hand-inlined worker body - the pattern FastComputeVertexNormalsAsync.js uses - would be a
// second implementation of Wahba, the pixel-domain rotation refinement and the lens mapping, free
// to drift from the original the moment either is touched. The solve has to produce results
// IDENTICAL to the synchronous path, not equivalent ones, because rendered-pixel regression tests
// compare star overlays; running literally the same source is the only way to keep that true
// without a promise to remember. createChunkResponder is likewise shared with the in-process
// lanes, so the no-Worker fallback and the tests exercise this same logic.
//
// Webpack bundles this file and its imports into their own chunk from the `new Worker(new
// URL(...))` call site, in every build mode - the same mechanism ScriptRunnerWorker, ELAWorker,
// NoiseWorker and AudioSpectrumWorker already ship with. The dependency graph here
// (StarSolveSphere -> CameraLens, StarSphere, StarSolve, StarMatch) is pure maths: no THREE, no
// DOM, no Sitrec globals.
//
// PROTOCOL. Three message kinds, and the split exists to keep the per-chunk traffic tiny:
//
//   init   once per solve  - the static data: flattened observations, the anchor index, the lens.
//   round  once per phase  - what changed: the map and the per-frame states. No reply.
//   chunk  many per phase  - just a [lo, hi) range. Answered from the cached round.
//
// Every message carries the solve's `gen`. A message from a superseded solve is dropped rather
// than answered, so a late reply can never be mistaken for the current run's.

import {createChunkResponder} from "../starTrack/StarSolveSphere";

const responder = createChunkResponder();
let gen = null;

self.onmessage = (e) => {
    const msg = e.data;

    if (msg.type === "init") {
        gen = msg.gen;
        responder.init(msg);
        self.postMessage({type: "init", gen});
        return;
    }

    // Anything not belonging to the current solve is stale by definition - the main thread has
    // moved on and is not waiting for it.
    if (gen === null || msg.gen !== gen) return;

    if (msg.type === "round") {
        responder.round(msg);
        return;                                   // no reply: the chunks that follow are the reply
    }

    try {
        const {transfer, ...result} = responder.chunk(msg);
        self.postMessage({...result, gen}, transfer);
    } catch (err) {
        // Reported rather than thrown, so the pool can fall back to the synchronous solve with a
        // reason instead of seeing an opaque `onerror`.
        self.postMessage({type: "error", gen, lo: msg.lo, hi: msg.hi,
            message: (err && err.message) || String(err)});
    }
};
