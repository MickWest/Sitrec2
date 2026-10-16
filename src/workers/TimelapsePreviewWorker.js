// Worker half of the timelapse preview (TimelapsePreview.js has the main-thread
// half and the design). A transport shim: the calculations are the kernels in
// TimelapsePreviewKernels.js, imported, not copied, so a worker and the
// main-thread fallback produce the same trails.
//
// PROTOCOL. Static data is sent once and kept; a job carries only what changed.
//
//   catalog   the star catalog (RA, Dec, magnitude). No reply.
//   satrecs   orbit records for this worker's satellites, keyed; `version`
//             changes when the TLE set changes and clears the cache. No reply.
//   job       the job, this worker's share of the stars (offset, stride) and its
//             satellites (keys). Answered with the trails, as transferable arrays.

import {computeSatelliteTrails, computeStarTrails, makeSink, packSink, prepareJob} from "../TimelapsePreviewKernels";

let catalog = null;
let satrecVersion = null;
const satrecs = new Map();   // key -> {satrec, name, number}

self.onmessage = (e) => {
    const msg = e.data;
    try {
        if (msg.type === "catalog") {
            catalog = msg.catalog;
            return;
        }
        if (msg.type === "satrecs") {
            if (msg.version !== satrecVersion) {
                satrecs.clear();
                satrecVersion = msg.version;
            }
            for (const entry of msg.entries) satrecs.set(entry.key, entry);
            return;
        }
        if (msg.type === "job") {
            const started = performance.now();
            const job = prepareJob(msg.job);
            const sky = makeSink(), world = makeSink();
            let starsDrawn = 0, satStats = null;
            if (msg.stars && catalog) starsDrawn = computeStarTrails(job, catalog, msg.stars.offset, msg.stars.stride, sky);
            const starsMs = performance.now() - started;
            if (msg.sats?.length) {
                const list = [];
                for (const {key, filter} of msg.sats) {
                    const entry = satrecs.get(key);
                    if (entry) list.push({satrec: entry.satrec, name: entry.name, number: entry.number, filter});
                }
                satStats = computeSatelliteTrails(job, list, world);
            }
            const skyOut = packSink(sky), worldOut = packSink(world);
            self.postMessage({type: "result", gen: msg.gen, sky: skyOut, world: worldOut, starsDrawn, satStats,
                ms: performance.now() - started, starsMs},
                [skyOut.pos.buffer, skyOut.col.buffer, worldOut.pos.buffer, worldOut.col.buffer]);
        }
    } catch (err) {
        self.postMessage({type: "error", gen: msg.gen, message: err?.message || String(err)});
    }
};
