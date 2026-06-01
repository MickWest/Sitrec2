// flareWorker.js — ES MODULE Web Worker.
//
// Receives { req, tleText } from app.js, parses the TLE set, builds an observer-position
// function (fixed point or great-circle flight path), then runs a PROGRESSIVE flare scan
// that STREAMS results as it goes:
//
//   1. Find the productive band (Sun within the flare-window elevation range). Fixed-mode
//      seeks forward to the next band; flight-mode uses the flight window.
//   2. Find the "prime time" in that band — when the Sun is nearest the optimal flare
//      depression — and split the band into short chunks ORDERED by distance from prime.
//   3. Scan each chunk at full resolution, posting its flares as soon as they're found, so
//      the densest (prime) region appears first and the swarm fans out from there. Summed
//      over chunks the work equals one full scan, so the final set is identical — it just
//      arrives incrementally instead of all at the end.
//
// Message protocol (worker -> main):
//   { type:"flares", flares:[...] }   a batch of newly-found (deduped) flares
//   { type:"progress", fraction }     0..1 scan progress (drives the top bar)
//   { type:"result", flares, stats }  final authoritative (deduped, sorted) set + stats
//   { type:"error", message }

// Register the message handler SYNCHRONOUSLY, before the top-level await below, and buffer
// any message that arrives while the dynamic imports are still loading.
let handle = null;
const pending = [];
self.onmessage = (e) => { if (handle) handle(e); else pending.push(e); };

// app.js spawns us as `flareWorker.js?v=<build stamp>`; carry that query into our own
// imports so the worker's module graph is cache-busted by the same stamp.
const VERSION = new URL(import.meta.url).search;
const satellite = await import("./lib/satellite.es.js" + VERSION);
const { createFlareEngine, FLARE_DEFAULTS } = await import("./flareEngine.js" + VERSION);
const { greatCircleInterpolate } = await import("./geo.js" + VERSION);
const astro = await import("./astro.js" + VERSION);

// Optimal Sun depression (degrees below the horizon) for horizon flares — "prime time"
// is the moment in the band nearest this. ~40° below matches the nominal 550 km window.
const OPTIMAL_SUN_EL = -40;
const PROBE_MS = 5 * 60 * 1000;        // 5-min probe for band edges + prime-time search
const CHUNK_TARGET_MS = 4 * 60 * 1000; // aim for ~4-min chunks (bounded 1..60 per band)
const MAX_CHUNKS = 60;
const OVERLAP_MS = 8 * 1000;           // scan a hair past each chunk edge so a boundary-straddling flare isn't clipped

handle = (e) => {
    const { req, tleText } = e.data || {};
    try {
        const engine = createFlareEngine(satellite);
        const sats = engine.parseTLE(tleText);
        const opt = req.options || {};
        const maxSunEl = opt.maxSunElevationDeg ?? FLARE_DEFAULTS.maxSunElevationDeg;
        const minSunEl = opt.minSunElevationDeg ?? FLARE_DEFAULTS.minSunElevationDeg;
        const startMs = req.startMs;

        // Observer position at time t (fixed point, or moving along the great-circle flight).
        let observerAt;
        if (req.mode === "flight") {
            const durMs = req.durationSec * 1000;
            observerAt = (t) => {
                let f = (t - startMs) / durMs;
                if (f < 0) f = 0; else if (f > 1) f = 1;
                const gc = greatCircleInterpolate(req.origin.lat, req.origin.lon, req.dest.lat, req.dest.lon, f);
                return { lat: gc.lat, lon: gc.lon, altKm: req.cruiseAltKm };
            };
        } else {
            const fixed = { lat: req.lat, lon: req.lon, altKm: req.altKm || 0 };
            observerAt = () => fixed;
        }
        const inBand = (t) => {
            const lla = observerAt(t);
            const el = astro.sunElevationDeg(lla.lat, lla.lon, new Date(t));
            return el <= maxSunEl && el >= minSunEl;
        };

        // --- streaming dedup. Chunks overlap, so a flare run that crosses a chunk boundary
        // can be reported by two adjacent chunks (typically once in full, once as a short
        // boundary tail). A satellite flares once per pass, and the engine only splits
        // genuinely separate flares with a glint-above-cone gap between them — so two reports
        // of the SAME run always have OVERLAPPING time ranges, while two real flares do not.
        // Dedup by noradId + range overlap (keeping the lower-glint, i.e. better, peak); emit
        // only net-new flares. (A coarse peak-time bucket missed these: the split halves' peaks
        // can be tens of seconds apart even though their ranges overlap.)
        const allFlares = [];
        const byId = new Map();          // noradId -> [accepted flare refs in allFlares]
        const EPS = 3000;                // ms: near-touching ranges count as the same run
        const emit = (batch) => {
            const fresh = [];
            for (const f of batch) {
                const list = byId.get(f.noradId);
                let merged = false;
                if (list) {
                    for (const g of list) {
                        if (f.startMs <= g.endMs + EPS && g.startMs <= f.endMs + EPS) {
                            if (f.startMs < g.startMs) g.startMs = f.startMs;
                            if (f.endMs > g.endMs) g.endMs = f.endMs;
                            if (f.peakGlintDeg < g.peakGlintDeg) {   // adopt the better peak sample
                                g.peakMs = f.peakMs; g.peakGlintDeg = f.peakGlintDeg;
                                g.azDeg = f.azDeg; g.elDeg = f.elDeg; g.compass = f.compass;
                                g.rangeKm = f.rangeKm; g.satAltKm = f.satAltKm;
                                g.obsLat = f.obsLat; g.obsLon = f.obsLon;
                                g.intensity = f.intensity; g.dAzDeg = f.dAzDeg; g.dElDeg = f.dElDeg;
                            }
                            merged = true;
                            break;
                        }
                    }
                }
                if (merged) continue;
                allFlares.push(f);
                if (list) list.push(f); else byId.set(f.noradId, [f]);
                fresh.push(f);
            }
            if (fresh.length) self.postMessage({ type: "flares", flares: fresh });
        };

        // Prime time: the in-band sample whose Sun elevation is nearest OPTIMAL_SUN_EL.
        const findPrimeTime = (w0, w1) => {
            let best = null, bestErr = Infinity;
            for (let t = w0; t <= w1; t += PROBE_MS) {
                const lla = observerAt(t);
                const el = astro.sunElevationDeg(lla.lat, lla.lon, new Date(t));
                if (el > maxSunEl || el < minSunEl) continue;
                const err = Math.abs(el - OPTIMAL_SUN_EL);
                if (err < bestErr) { bestErr = err; best = t; }
            }
            return best;
        };

        // Scan a window [w0,w1] in short chunks ordered by distance from prime time tP,
        // streaming each chunk's flares. Returns the number of flares found in this window.
        const scanWindow = (w0, w1, tP) => {
            const span = w1 - w0;
            const nChunks = Math.max(1, Math.min(MAX_CHUNKS, Math.round(span / CHUNK_TARGET_MS)));
            const chunkMs = span / nChunks;
            const chunks = [];
            for (let i = 0; i < nChunks; i++) chunks.push([w0 + i * chunkMs, w0 + (i + 1) * chunkMs]);
            chunks.sort((a, b) => Math.abs((a[0] + a[1]) / 2 - tP) - Math.abs((b[0] + b[1]) / 2 - tP));
            const before = allFlares.length;
            for (let i = 0; i < chunks.length; i++) {
                engine.scan({
                    sats, observerAt,
                    startMs: Math.max(w0, chunks[i][0] - OVERLAP_MS),
                    endMs: Math.min(w1, chunks[i][1] + OVERLAP_MS),
                    options: opt,
                    onFlares: emit,
                });
                self.postMessage({ type: "progress", fraction: (i + 1) / chunks.length });
            }
            return allFlares.length - before;
        };

        let scannedSessions = 0;
        let bandStart = null, bandEnd = null;

        if (req.mode === "flight") {
            bandStart = startMs;
            bandEnd = startMs + req.durationSec * 1000;
            const tP = findPrimeTime(bandStart, bandEnd) ?? (bandStart + bandEnd) / 2;
            scannedSessions = 1;
            scanWindow(bandStart, bandEnd, tP);
        } else {
            // Fixed: seek forward to the next productive band and scan it; if it yields no
            // flares (rare for the dense constellation), advance to the next band.
            const lookAheadSec = req.maxLookAheadSec || 86400;
            const limitMs = startMs + lookAheadSec * 1000;
            let cursor = startMs;
            while (cursor < limitMs) {
                // Seek to the start of the next band.
                let bStart = null;
                for (let t = cursor; t <= limitMs; t += PROBE_MS) {
                    if (inBand(t)) { bStart = t; break; }
                    self.postMessage({ type: "progress", fraction: 0 });   // still searching for the window
                }
                if (bStart === null) break;
                bStart = Math.max(startMs, bStart - PROBE_MS);
                // Seek to the end of the band.
                let bEnd = limitMs;
                for (let t = bStart; t <= limitMs; t += PROBE_MS) {
                    if (!inBand(t)) { bEnd = Math.min(limitMs, t + PROBE_MS); break; }
                }
                scannedSessions++;
                const tP = findPrimeTime(bStart, bEnd) ?? (bStart + bEnd) / 2;
                const found = scanWindow(bStart, bEnd, tP);
                if (found > 0) { bandStart = bStart; bandEnd = bEnd; break; }
                cursor = bEnd + PROBE_MS;
            }
            if (bandStart === null) { bandStart = startMs; bandEnd = startMs; }   // none found
        }

        allFlares.sort((a, b) => a.peakMs - b.peakMs);
        const stats = {
            satsTotal: sats.length,
            satsCandidates: sats.length,
            satsFlaring: new Set(allFlares.map((f) => f.noradId)).size,
            flares: allFlares.length,
            windowSec: (bandEnd - bandStart) / 1000,
            productiveSteps: allFlares.length > 0 ? 1 : 0,
            scannedSessions,
            searchedFromMs: startMs,
            sessionStartMs: bandStart,
            sessionEndMs: bandEnd,
            lookAheadSec: req.maxLookAheadSec || 86400,
            exhausted: req.mode !== "flight" && allFlares.length === 0,
        };
        self.postMessage({ type: "result", flares: allFlares, stats });
    } catch (err) {
        self.postMessage({ type: "error", message: err && err.message ? err.message : String(err) });
    }
};

// Drain any message that arrived while the imports were still loading.
for (const e of pending) handle(e);
pending.length = 0;
