// statsCore.mjs — one night's flare statistics for one latitude, shared by the
// flare-stats CLI (flare-stats.mjs) and its worker threads (statsWorker.mjs).
//
// The physics is NOT duplicated here: it is the SHF predictor's own engine
// (../flareEngine.js), synthetic constellation (../dummyTLE.js) and vendored
// satellite.js, so these statistics count exactly the flares the app would show.

import * as satellite from "../lib/satellite.es.js";
import { createFlareEngine } from "../flareEngine.js";
import { generateDummyTLE } from "../dummyTLE.js";

const DAY_MS = 86400000;
const HOUR_MS = 3600000;

// A "night" is local-mean-solar noon to the next noon, so one dark period is never
// split across two days. Local mean solar time = UTC + lon/15 h.
export function nightStartMs(dateStr, lonDeg) {
    const [y, m, d] = dateStr.split("-").map(Number);
    return Date.UTC(y, m - 1, d, 12) - (lonDeg / 15) * HOUR_MS;
}

// Local mean solar hour (0..23) of an instant at the given longitude.
export function solarHour(timeMs, lonDeg) {
    const h = ((timeMs + (lonDeg / 15) * HOUR_MS) % DAY_MS + DAY_MS) % DAY_MS;
    return Math.floor(h / HOUR_MS);
}

// ISO dates (YYYY-MM-DD) from `from` to `to` inclusive, every `stepDays`.
export function dateRange(from, to, stepDays = 1) {
    const out = [];
    const end = Date.parse(to + "T00:00:00Z");
    for (let t = Date.parse(from + "T00:00:00Z"); t <= end; t += stepDays * DAY_MS) {
        out.push(new Date(t).toISOString().slice(0, 10));
    }
    return out;
}

// Stateful per-thread scanner. With no TLE text it uses the synthetic constellation,
// re-epoched to each night (as the SHF app does); with TLE/OMM text it parses that
// set once and propagates it to every night.
export function createNightScanner({ tleText = null } = {}) {
    const engine = createFlareEngine(satellite);
    const fixedSats = tleText ? engine.parseTLE(tleText) : null;
    let synthDate = null, synthSats = null;

    function satsFor(startMs) {
        if (fixedSats) return fixedSats;
        const date = new Date(startMs).toISOString().slice(0, 10);
        if (date !== synthDate) {
            synthSats = engine.parseTLE(generateDummyTLE(new Date(startMs)));
            synthDate = date;
        }
        return synthSats;
    }

    // Scan one night. Returns flare counts in total and per local solar hour, for
    // all flares and for the subset the shared model marks visible.
    function scanNight({ date, lat, lon = 0, altKm = 0, minElevationDeg = 0 }) {
        const startMs = nightStartMs(date, lon);
        const res = engine.scan({
            sats: satsFor(startMs),
            observerAt: () => ({ lat, lon, altKm }),
            startMs,
            endMs: startMs + DAY_MS,
            options: { minElevationDeg },
        });
        const hourAll = new Array(24).fill(0);
        const hourVis = new Array(24).fill(0);
        let visible = 0;
        for (const flare of res.flares) {
            const hour = solarHour(flare.peakMs, lon);
            hourAll[hour]++;
            if (flare.visible) { hourVis[hour]++; visible++; }
        }
        return {
            date, lat, lon,
            all: res.flares.length,
            visible,
            hourAll,
            hourVis,
            productiveSteps: res.stats.productiveSteps,
        };
    }

    return { scanNight };
}
