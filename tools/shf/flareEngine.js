// flareEngine.js — standalone Starlink "horizon flare" scanner.
//
// Replicates Sitrec's flare physics (CSatellite.detectFlare / CNodeDisplayNightSky)
// without the Sitrec node-graph runtime. A Starlink satellite's flat phased-array
// panel points at nadir and acts as a mirror; when the panel reflects sunlight at
// an observer it produces a brief, bright "flare".
//
// The satellite.js library is INJECTED into createFlareEngine() — it is NOT imported
// here, so this module stays bundler-free and the same engine can run in a worker
// where satellite.js was loaded separately.
//
// Distances are in kilometres, angles in degrees, vectors are {x,y,z} ECEF objects.

// Versioned imports (see app.js): we are imported as `flareEngine.js?v=<stamp>`,
// so carry that query into geo.js / astro.js for consistent cache-busting.
const VERSION = new URL(import.meta.url).search;
const geo = await import("./geo.js" + VERSION);
const astro = await import("./astro.js" + VERSION);

// ---------------------------------------------------------------------------
// Defaults — merged-over by caller-supplied options in scan().
// ---------------------------------------------------------------------------
export const FLARE_DEFAULTS = {
    flareAngleDeg: 5,        // angular half-width of the flare cone (the "spread")
    flareModel: "geocentric",// panel-normal model: "geocentric" (default) | "geodetic"
    filterStepSec: 30,       // coarse step for PASS A (above-horizon filter)
    fineStepSec: 2,          // fine step for PASS B (flare refinement)
    minElevationDeg: 0,      // ignore flares below this elevation above the horizon
    // Productive band (Sun elevation at the observer). Outside it a flare is
    // impossible or invisible, so PASS A skips those coarse steps entirely:
    //   above maxSunElevationDeg -> daytime, the sky is too bright to see a flare;
    //   below minSunElevationDeg -> even low satellites toward the sunward limb are
    //     in Earth's shadow. Horizon flares persist deep into the night (a high
    //     ~550 km sat near the limb stays lit until the Sun is ~-47° at the observer,
    //     more from an aircraft), so this bound must be well below civil/nautical
    //     twilight — these are NOT a twilight-only phenomenon; they last most of the night.
    maxSunElevationDeg: 6,    // upper bound (~civil twilight)
    minSunElevationDeg: -56,  // lower bound (past the limb-sunlit limit, incl. aircraft)
};

// acos in degrees, input clamped to [-1,1] to survive rounding.
const RAD2DEG = 180 / Math.PI;
function acosDeg(x) {
    return Math.acos(x < -1 ? -1 : x > 1 ? 1 : x) * RAD2DEG;
}

// Geocentric-radius sanity band (km). SGP4 propagated far from a TLE's epoch can
// fling a stale satellite onto a decayed or escape trajectory; those phantom
// "satellites" sit at impossible altitudes yet still read as sunlit + above the
// horizon, so they manufacture bogus flares (e.g. a months-old TLE evaluated at a
// far-future date). Reject anything outside a generous LEO band: Starlink lives at
// ~330–600 km (geocentric ~6690–6980 km), so these bounds keep every real Starlink
// while discarding decayed (<~80 km) and escaped (>~2000 km) garbage.
const MIN_SAT_RADIUS_KM = geo.WGS84.b + 80;    // ~6437 km — below this is reentered/decayed
const MAX_SAT_RADIUS_KM = geo.WGS84.a + 2000;  // ~8378 km — above this is escape/garbage

// ---------------------------------------------------------------------------
// createFlareEngine(satellite) -> { parseTLE, scan }
// ---------------------------------------------------------------------------
export function createFlareEngine(satellite) {

    // -----------------------------------------------------------------------
    // parseTLE(text) -> [{ name, noradId, satrec }]
    //
    // Accepts a TLE text blob: an optional name line followed by a "1 ..." line
    // and a "2 ..." line, repeated. Robustly groups lines: whenever a line that
    // starts with "1 " is immediately followed by one starting with "2 ", those
    // two are the element-set lines and the preceding non-element line (if any)
    // is the satellite name. Skips any satrec with a non-zero error.
    // -----------------------------------------------------------------------
    function parseTLE(text) {
        // Normalise line endings, trim trailing whitespace, drop blank lines.
        const lines = String(text)
            .split(/\r\n|\r|\n/)
            .map((l) => l.replace(/\s+$/, ""))
            .filter((l) => l.length > 0);

        const out = [];
        let pendingName = null;

        for (let i = 0; i < lines.length; i++) {
            const l1 = lines[i];
            const l2 = lines[i + 1];

            if (l1.startsWith("1 ") && l2 && l2.startsWith("2 ")) {
                // Found an element-set pair.
                const satrec = satellite.twoline2satrec(l1, l2);
                if (satrec && satrec.error === 0) {
                    const noradId = parseInt(l1.slice(2, 7), 10);
                    out.push({
                        name: pendingName != null ? pendingName : "NORAD " + noradId,
                        noradId,
                        satrec,
                    });
                }
                pendingName = null;
                i++; // consume the "2 " line as well
            } else if (!l1.startsWith("1 ") && !l1.startsWith("2 ")) {
                // Not an element-set line — treat it as the (next) satellite's name.
                // (A stray "1 " not followed by "2 " is skipped without clobbering
                // a pending name; a stray "2 " is likewise ignored.)
                pendingName = l1.trim();
            }
            // A stray "2 " line with no preceding "1 " is ignored.
        }
        return out;
    }

    // -----------------------------------------------------------------------
    // Per-time frame: GMST and the unit ECEF direction toward the Sun.
    // Memoised on timeMs because adjacent sats at the same step share these.
    // -----------------------------------------------------------------------
    // Keyed by timeMs and reused across satellites (PASS B is satellite-major, so
    // many satellites re-visit the same instants). Cleared at the start of scan().
    const _frameCache = new Map();
    function frame(timeMs) {
        let v = _frameCache.get(timeMs);
        if (v !== undefined) return v;
        const date = new Date(timeMs);
        const gmst = satellite.gstime(date);
        // Sun is ~1 AU away, so its geocentric direction equals the observer's
        // to < 0.01°; one toSun vector serves every observer/sat at this instant.
        const toSun = geo.vnorm(satellite.eciToEcf(astro.sunEciDirection(date), gmst));
        v = { date, gmst, toSun };
        _frameCache.set(timeMs, v);
        return v;
    }

    // Propagate a satrec to ECEF (km). Returns null on SGP4 error / non-finite, or
    // when the satellite is outside the LEO sanity band (stale-TLE phantom orbits).
    function satEcef(satrec, date, gmst) {
        const pv = satellite.propagate(satrec, date);
        if (!pv || !pv.position) return null;
        const p = pv.position;
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return null;
        // Magnitude is rotation-invariant, so gate on the cheaper ECI radius before
        // converting — most stale-TLE garbage is discarded without the ECEF rotation.
        const r = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
        if (r < MIN_SAT_RADIUS_KM || r > MAX_SAT_RADIUS_KM) return null;
        return satellite.eciToEcf(p, gmst);
    }

    // -----------------------------------------------------------------------
    // scan(...) — two-pass flare search.
    // -----------------------------------------------------------------------
    function scan({ sats, observerAt, startMs, endMs, options, onProgress }) {
        const opt = Object.assign({}, FLARE_DEFAULTS, options || {});
        const filterStepMs = opt.filterStepSec * 1000;
        const fineStepMs = opt.fineStepSec * 1000;
        const spread = opt.flareAngleDeg;
        const ramp = spread * 0.25;          // outer falloff band width
        const middle = spread - ramp;        // glint < middle => full intensity
        const ramp2 = ramp * ramp || 1;      // avoid /0 if spread==0
        const geodetic = opt.flareModel === "geodetic";
        const minEl = opt.minElevationDeg;
        const maxSunEl = opt.maxSunElevationDeg;
        const minSunEl = opt.minSunElevationDeg;
        const nSats = sats.length;

        const report = typeof onProgress === "function" ? onProgress : null;
        _frameCache.clear();

        // Count coarse steps that actually fall inside the productive band,
        // so the PASS A progress total reflects the work really done.
        let bandSteps = 0;

        // ===================================================================
        // PASS A — FILTER. Coarse scan to find, per sat, the time intervals
        // during which it is above the observer's horizon. Most of the sky's
        // thousands of satellites are below the horizon at any moment, so this
        // cheaply discards them and yields a small set of candidate intervals.
        // ===================================================================

        // intervals[i] = array of [t0, t1] above-horizon windows for sat i.
        const intervals = new Array(nSats);
        // openStart[i] = start time of the currently-open window (or null).
        const openStart = new Array(nSats).fill(null);
        for (let i = 0; i < nSats; i++) intervals[i] = [];

        let coarseTotal = 0;
        for (let t = startMs; t <= endMs; t += filterStepMs) coarseTotal++;

        let coarseDone = 0;
        let lastObsLat = NaN, lastObsLon = NaN, lastObsAlt = NaN, obsE = null;

        for (let t = startMs; t <= endMs; t += filterStepMs) {
            coarseDone++;
            const f = frame(t);
            const lla = observerAt(t);

            // Productive-band gate: skip this whole step (all satellites) when the Sun
            // is too high (daytime — flares invisible) or too low (satellites in
            // shadow). Treat skipped steps like "all below horizon" so any open
            // above-horizon window is closed, segmenting candidate intervals to the
            // productive band. This is the main performance lever — daytime steps
            // cost one sun-elevation calc instead of nSats propagations.
            const sunEl = astro.sunElevationDeg(lla.lat, lla.lon, f.date);
            if (sunEl > maxSunEl || sunEl < minSunEl) {
                for (let i = 0; i < nSats; i++) {
                    if (openStart[i] !== null) {
                        intervals[i].push([openStart[i], t - filterStepMs]);
                        openStart[i] = null;
                    }
                }
                if (report && (coarseDone & 31) === 0) {
                    report({ phase: "filter", done: coarseDone, total: coarseTotal });
                }
                continue;
            }
            bandSteps++;

            // Observer ECEF — recompute only when the observer actually moves
            // (fixed-location scans keep the same obsE for the whole pass).
            if (lla.lat !== lastObsLat || lla.lon !== lastObsLon || lla.altKm !== lastObsAlt) {
                obsE = geo.llaToEcef(lla.lat, lla.lon, lla.altKm);
                lastObsLat = lla.lat; lastObsLon = lla.lon; lastObsAlt = lla.altKm;
            }

            for (let i = 0; i < nSats; i++) {
                const e = satEcef(sats[i].satrec, f.date, f.gmst);
                let above = false;
                if (e !== null) {
                    // Above the horizon iff the line of sight does NOT hit Earth.
                    above = !geo.rayHitsEllipsoid(obsE, geo.vsub(e, obsE));
                }
                if (above) {
                    if (openStart[i] === null) openStart[i] = t;
                } else if (openStart[i] !== null) {
                    // Window just closed at the previous step.
                    intervals[i].push([openStart[i], t - filterStepMs]);
                    openStart[i] = null;
                }
            }

            if (report && (coarseDone & 31) === 0) {
                report({ phase: "filter", done: coarseDone, total: coarseTotal });
            }
        }
        // Close any windows still open at the end of the scan.
        for (let i = 0; i < nSats; i++) {
            if (openStart[i] !== null) intervals[i].push([openStart[i], endMs]);
        }
        if (report) report({ phase: "filter", done: coarseTotal, total: coarseTotal });

        // Pad each interval by ±filterStepMs (a flare may begin/end between
        // coarse samples), clamp to the window, and merge any that now overlap.
        let satsCandidates = 0;
        for (let i = 0; i < nSats; i++) {
            const raw = intervals[i];
            if (raw.length === 0) continue;
            satsCandidates++;
            const merged = [];
            for (let k = 0; k < raw.length; k++) {
                let lo = raw[k][0] - filterStepMs;
                let hi = raw[k][1] + filterStepMs;
                if (lo < startMs) lo = startMs;
                if (hi > endMs) hi = endMs;
                if (merged.length && lo <= merged[merged.length - 1][1]) {
                    // Overlaps the previous interval — extend it.
                    if (hi > merged[merged.length - 1][1]) merged[merged.length - 1][1] = hi;
                } else {
                    merged.push([lo, hi]);
                }
            }
            intervals[i] = merged;
        }

        // ===================================================================
        // PASS B — REFINE. Step finely through ONLY the candidate intervals,
        // applying the full flare physics. Track contiguous "flaring" runs and
        // emit one flare event per run, with values taken at the peak (min glint).
        // ===================================================================

        const flares = [];
        const satsFlaringSet = new Set();

        // Estimate total fine steps for progress reporting.
        let fineTotal = 0;
        for (let i = 0; i < nSats; i++) {
            const ivs = intervals[i];
            for (let k = 0; k < ivs.length; k++) {
                fineTotal += Math.floor((ivs[k][1] - ivs[k][0]) / fineStepMs) + 1;
            }
        }
        let fineDone = 0;

        // Sample a satellite's apparent (az, el) as seen from the observer at a time.
        function sampleAzEl(satrec, atMs) {
            const fr = frame(atMs);
            const e = satEcef(satrec, fr.date, fr.gmst);
            if (e === null) return null;
            const lla = observerAt(atMs);
            return geo.azElFromObserver(geo.llaToEcef(lla.lat, lla.lon, lla.altKm), e);
        }
        // Apparent direction of motion on the sky at atMs: {dAzDeg, dElDeg} over dtMs,
        // for drawing the little "which way it's moving" arrows. Handles az wraparound.
        function apparentMotion(satrec, atMs, dtMs) {
            const a = sampleAzEl(satrec, atMs);
            const b = sampleAzEl(satrec, atMs + dtMs);
            if (!a || !b) return { dAzDeg: 0, dElDeg: 0 };
            let dAz = b.azDeg - a.azDeg;
            if (dAz > 180) dAz -= 360; else if (dAz < -180) dAz += 360;
            return { dAzDeg: dAz, dElDeg: b.elDeg - a.elDeg };
        }

        // Reusable run-state (reset between runs to stay allocation-light).
        let inRun = false;
        let runStartMs = 0, runEndMs = 0;
        let bestGlint = Infinity;
        let peakMs = 0, peakAz = 0, peakEl = 0, peakRange = 0, peakSatAlt = 0;
        let peakObsLat = 0, peakObsLon = 0;

        for (let i = 0; i < nSats; i++) {
            const ivs = intervals[i];
            if (ivs.length === 0) continue;

            const sat = sats[i];
            const satrec = sat.satrec;

            // Emit one flare event for the just-finished run, using its peak sample.
            const emit = () => {
                const mot = apparentMotion(satrec, peakMs, Math.max(2000, fineStepMs));
                flares.push(makeFlare(sat, runStartMs, peakMs, runEndMs, bestGlint,
                    peakAz, peakEl, peakRange, peakSatAlt, peakObsLat, peakObsLon,
                    mot.dAzDeg, mot.dElDeg, middle, ramp, ramp2));
                satsFlaringSet.add(i);
            };

            // Reset run state at the start of every satellite.
            inRun = false;
            bestGlint = Infinity;

            // Re-init observer cache per sat so the moving-observer fast-path
            // also works inside PASS B.
            lastObsLat = NaN; lastObsLon = NaN; lastObsAlt = NaN; obsE = null;

            for (let k = 0; k < ivs.length; k++) {
                const iv0 = ivs[k][0];
                const iv1 = ivs[k][1];

                for (let t = iv0; t <= iv1; t += fineStepMs) {
                    fineDone++;
                    if (report && (fineDone & 255) === 0) {
                        report({ phase: "refine", done: fineDone, total: fineTotal });
                    }

                    const f = frame(t);

                    const lla = observerAt(t);
                    if (lla.lat !== lastObsLat || lla.lon !== lastObsLon || lla.altKm !== lastObsAlt) {
                        obsE = geo.llaToEcef(lla.lat, lla.lon, lla.altKm);
                        lastObsLat = lla.lat; lastObsLon = lla.lon; lastObsAlt = lla.altKm;
                    }

                    const e = satEcef(satrec, f.date, f.gmst);
                    let flaring = false;
                    let glint = Infinity, azDeg = 0, elDeg = 0, rangeKm = 0;

                    if (e !== null) {
                        const camToSat = geo.vsub(e, obsE);
                        // Satellite must be sunlit (its ray to the Sun misses Earth)...
                        const sunlit = !geo.rayHitsEllipsoid(e, f.toSun);
                        // ...and above the observer's horizon.
                        const above = !geo.rayHitsEllipsoid(obsE, camToSat);

                        if (sunlit && above) {
                            // Panel normal points at nadir; reflect the view ray off it.
                            const satNormal = geodetic ? geo.localUp(e) : geo.geocentricUp(e);
                            const reflected = geo.vnorm(geo.vreflect(camToSat, satNormal));
                            glint = acosDeg(geo.vdot(reflected, f.toSun));

                            const ae = geo.azElFromObserver(obsE, e);
                            azDeg = ae.azDeg; elDeg = ae.elDeg; rangeKm = ae.rangeKm;

                            flaring = glint < spread && elDeg >= minEl;
                        }
                    }

                    if (flaring) {
                        if (!inRun) {
                            // Begin a new contiguous flaring run.
                            inRun = true;
                            runStartMs = t;
                            bestGlint = Infinity;
                        }
                        runEndMs = t;
                        if (glint < bestGlint) {
                            bestGlint = glint;
                            peakMs = t;
                            peakAz = azDeg;
                            peakEl = elDeg;
                            peakRange = rangeKm;
                            // Satellite altitude and observer position at the peak sample.
                            peakSatAlt = geo.ecefToLla(e).altKm;
                            peakObsLat = lla.lat;
                            peakObsLon = lla.lon;
                        }
                    } else if (inRun) {
                        // Run just ended — emit the flare event.
                        emit();
                        inRun = false;
                    }
                }
            }

            // Close a run still open at the end of the satellite's last interval.
            if (inRun) {
                emit();
                inRun = false;
            }
        }

        if (report) report({ phase: "refine", done: fineTotal, total: fineTotal });

        // Sort flares chronologically by peak time.
        flares.sort((a, b) => a.peakMs - b.peakMs);

        return {
            flares,
            stats: {
                satsTotal: nSats,
                satsCandidates,
                satsFlaring: satsFlaringSet.size,
                flares: flares.length,
                windowSec: (endMs - startMs) / 1000,
                // Coarse steps that fell inside the productive band. Zero
                // means the whole search window was daytime or deep night — the UI
                // can use this to explain why no flares were found.
                productiveSteps: bandSteps,
            },
        };
    }

    // Build a flare event object from a completed run's peak sample.
    // intensity is the Sitrec ramp value evaluated at the peak glint angle.
    function makeFlare(sat, startMs, peakMs, endMs, peakGlintDeg,
                       azDeg, elDeg, rangeKm, satAltKm, obsLat, obsLon,
                       dAzDeg, dElDeg, middle, ramp, ramp2) {
        let intensity;
        if (peakGlintDeg < middle) {
            intensity = 1;
        } else {
            const dd = peakGlintDeg - middle;
            const r = ramp - dd;
            intensity = (r * r) / ramp2;
            if (intensity < 0) intensity = 0;
        }
        return {
            satName: sat.name,
            noradId: sat.noradId,
            startMs,
            peakMs,
            endMs,
            peakGlintDeg,
            intensity,
            azDeg,
            elDeg,
            compass: geo.compass16(azDeg),
            rangeKm,
            satAltKm,
            obsLat,
            obsLon,
            // Apparent motion on the sky at the peak (deg over a few seconds) —
            // used to draw the direction-of-travel arrows on the horizon view.
            dAzDeg,
            dElDeg,
        };
    }

    // -----------------------------------------------------------------------
    // scanForward(...) — "when is the NEXT time flares are visible on or after
    // startMs?" Walks forward one productive-band session at a time, scanning each,
    // and returns the first session that actually produces flares. Time outside the
    // productive band costs only a cheap Sun-elevation probe, so a query
    // made in daylight skips ahead to the next dusk/dawn almost for free.
    //
    // Returns { flares, stats, foundSession } where stats adds:
    //   searchedFromMs, sessionStartMs/sessionEndMs (the winning productive band),
    //   scannedSessions, lookAheadSec, exhausted (true if none found in range).
    // -----------------------------------------------------------------------
    function scanForward({ sats, observerAt, startMs, maxLookAheadSec, options, onProgress }) {
        const opt = Object.assign({}, FLARE_DEFAULTS, options || {});
        const lookAheadSec = maxLookAheadSec || 3 * 86400; // default: search up to 3 days ahead
        const limitMs = startMs + lookAheadSec * 1000;
        const probeMs = 5 * 60 * 1000;   // 5-min probe for productive-band edges
        const report = typeof onProgress === "function" ? onProgress : null;

        const inBand = (t) => {
            const lla = observerAt(t);
            const el = astro.sunElevationDeg(lla.lat, lla.lon, new Date(t));
            return el <= opt.maxSunElevationDeg && el >= opt.minSunElevationDeg;
        };

        let cursor = startMs;
        let scannedSessions = 0;
        let totalSatsCandidates = 0;

        while (cursor < limitMs) {
            // Seek forward to the start of the next productive band.
            let bandStart = null;
            for (let t = cursor; t <= limitMs; t += probeMs) {
                if (inBand(t)) { bandStart = t; break; }
                if (report) report({ phase: "seek", fraction: (t - startMs) / (limitMs - startMs) });
            }
            if (bandStart === null) break;            // no productive band left (e.g. polar day/night)
            bandStart = Math.max(startMs, bandStart - probeMs); // back up so we don't clip the edge

            // Seek to the end of this band.
            let bandEnd = limitMs;
            for (let t = bandStart; t <= limitMs; t += probeMs) {
                if (!inBand(t)) { bandEnd = Math.min(limitMs, t + probeMs); break; }
            }

            // Full two-pass scan over just this productive-band session.
            const res = scan({
                sats, observerAt, startMs: bandStart, endMs: bandEnd, options: opt,
                onProgress: report ? (p) => report(Object.assign({ session: scannedSessions }, p)) : undefined,
            });
            scannedSessions++;
            totalSatsCandidates += res.stats.satsCandidates;

            if (res.flares.length > 0) {
                res.stats.searchedFromMs = startMs;
                res.stats.sessionStartMs = bandStart;
                res.stats.sessionEndMs = bandEnd;
                res.stats.scannedSessions = scannedSessions;
                res.stats.lookAheadSec = lookAheadSec;
                res.stats.exhausted = false;
                return Object.assign({ foundSession: true }, res);
            }
            cursor = bandEnd + probeMs;              // nothing this session — try the next dusk/dawn
        }

        return {
            foundSession: false,
            flares: [],
            stats: {
                satsTotal: sats.length,
                satsCandidates: totalSatsCandidates,
                satsFlaring: 0,
                flares: 0,
                scannedSessions,
                searchedFromMs: startMs,
                lookAheadSec,
                exhausted: true,
            },
        };
    }

    return { parseTLE, scan, scanForward };
}
