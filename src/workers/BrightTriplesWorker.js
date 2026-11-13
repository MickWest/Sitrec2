// Worker half of Bright Triples. See StarTriplesOffThread.js for the main-thread half.
//
// It imports the real matcher rather than carrying a copy, as StarSolveWorker does, so the answer
// is the same as on the main thread. The handler lives in StarTriples.js, so the tests can drive it
// without a Worker. Its imports (StarIdentify, StarManualFit, StarMatch) are pure: no DOM, no
// THREE, no Sitrec globals.
//
// PROTOCOL. One message in: {type: "run", args}. Out: any number of {type: "progress", stage,
// fraction}, then one {type: "done", result} or {type: "error", message}. One worker per run; the
// main thread terminates it afterwards.

import {handleBrightTriplesMessage} from "../starTrack/StarTriples";

self.onmessage = (e) => {
    handleBrightTriplesMessage(e.data, (msg) => self.postMessage(msg));
};
