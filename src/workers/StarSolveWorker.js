// Worker half of the post-detection solve. See StarSolveOffThread.js for the main-thread half and
// StarSolveJob.js for the design; this file is deliberately a transport shim and nothing else.
//
// IT IMPORTS THE REAL SOLVER rather than carrying a copy, for the reason StarDetectWorker and
// StarSphereWorker do: the answer must be IDENTICAL to the synchronous path's, and running
// literally the same source is the only way to keep that true. The handler itself lives in
// StarSolveJob.js, so the tests can drive it without a Worker. Its graph (StarMatch, StarSolve,
// SafeArrays) is pure: no DOM, no THREE, no Sitrec globals.
//
// PROTOCOL. One message in: {type: "solve", perFrame, opts}. Out: any number of
// {type: "progress", stage, fraction}, then one {type: "done", result, relink} or
// {type: "error", message}. One worker per solve; the main thread terminates it afterwards.

import {handleStarSolveMessage} from "../starTrack/StarSolveJob";

self.onmessage = (e) => {
    handleStarSolveMessage(e.data, (msg, transfer) => self.postMessage(msg, transfer || []));
};
