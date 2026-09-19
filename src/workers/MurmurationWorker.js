// MurmurationWorker.js - runs a murmuration simulation off the main thread.
//
// A flock of 2000 birds over a one-minute sitch is several seconds of work, which would
// freeze the page. The samples are sent back a chunk at a time, so the flock appears after
// the warm-up and the rest fills in while the page stays usable. See MurmurationSim.js.

import {runMurmuration} from "../MurmurationSim";

self.onmessage = (event) => {
    const {params} = event.data;
    runMurmuration(params, (first, chunk, info) => {
        self.postMessage({first, chunk, info}, [chunk.buffer]);
    });
    self.postMessage({done: true});
};
