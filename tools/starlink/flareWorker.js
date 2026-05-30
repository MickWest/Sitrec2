// flareWorker.js — ES MODULE Web Worker.
//
// Receives { req, tleText } from app.js, parses the TLE set, builds an
// observer-position function (fixed point or great-circle flight path), then
// runs the flare-physics scan in flareEngine.js. Progress and the final result
// are posted back to the main thread.
//
// Message protocol (worker -> main):
//   { type:"progress", ... }   forwarded straight from engine.scan onProgress
//   { type:"result", flares, stats }
//   { type:"error", message }

// Register the message handler SYNCHRONOUSLY, before the top-level await below.
// app.js posts { req, tleText } immediately after `new Worker(...)`, which can
// arrive while we are still awaiting our dynamic imports; if onmessage were set
// only after the await, that first message would be dropped. So we buffer until
// the modules are ready, then drain.
let handle = null;
const pending = [];
self.onmessage = (e) => { if (handle) handle(e); else pending.push(e); };

// app.js spawns us as `flareWorker.js?v=<build stamp>`; carry that query into our
// own imports so the worker's module graph is cache-busted by the same stamp.
const VERSION = new URL(import.meta.url).search;
const satellite = await import("./lib/satellite.es.js" + VERSION);
const { createFlareEngine } = await import("./flareEngine.js" + VERSION);
const { greatCircleInterpolate } = await import("./geo.js" + VERSION);

handle = (e) => {
  const { req, tleText } = e.data || {};
  try {
    const engine = createFlareEngine(satellite);
    const sats = engine.parseTLE(tleText);
    const startMs = req.startMs;
    const onProgress = (p) => self.postMessage(Object.assign({ type: "progress" }, p));

    let result;
    if (req.mode === "fixed") {
      // Fixed location: search FORWARD from startMs to the next dark window (the
      // productive band) that actually produces flares ("when will I next see a flare
      // from here?"). Flares persist most of the night, not just at twilight.
      const fixed = { lat: req.lat, lon: req.lon, altKm: req.altKm || 0 };
      result = engine.scanForward({
        sats,
        observerAt: () => fixed,
        startMs,
        maxLookAheadSec: req.maxLookAheadSec,
        options: req.options,
        onProgress,
      });
    } else {
      // Flight: fixed departure + duration; observer moves along the great circle.
      const endMs = startMs + req.durationSec * 1000;
      const durMs = req.durationSec * 1000;
      const observerAt = (t) => {
        let f = (t - startMs) / durMs;
        if (f < 0) f = 0;
        if (f > 1) f = 1;
        const gc = greatCircleInterpolate(
          req.origin.lat, req.origin.lon, req.dest.lat, req.dest.lon, f);
        return { lat: gc.lat, lon: gc.lon, altKm: req.cruiseAltKm };
      };
      result = engine.scan({ sats, observerAt, startMs, endMs, options: req.options, onProgress });
    }

    self.postMessage({ type: "result", flares: result.flares, stats: result.stats });
  } catch (err) {
    self.postMessage({
      type: "error",
      message: err && err.message ? err.message : String(err),
    });
  }
};

// Drain any message that arrived while the imports were still loading.
for (const e of pending) handle(e);
pending.length = 0;
