#!/usr/bin/env node
// build-rate-table.mjs — precompute the flare rate page's year curve: the expected flares
// per night for every night of the model's year span (rateModel.SPAN: 365 nights from the
// 1st of the month of the shell table's reference epoch), at every half degree of latitude
// (every position of the page's slider), for both kinds, from the flux-integral model
// (../rate/rateModel.js). The page fetches the result (../rate/rateTable.json) when it opens,
// so that moving the latitude slider is instant; the live model takes about 40 ms per night,
// 365 nights x 2 kinds = 30 s per slider move on a desktop, four times more on a phone.
//
//   node tools/shf/tools/build-rate-table.mjs [--lat-step 0.5] [--lats -90:90] [--workers 4]
//        [--out tools/shf/rate/rateTable.json]
//
// Run it again after ../starlinkShells.js is refreshed (the span moves with the table's
// reference epoch, and the dated planes with its measured planes) or the model changes: the
// page refuses a table built for another span or shell table, and the test
// tools/test-rate.mjs compares the table with the live model. About 18 minutes on 12
// workers at the half-degree step (361 latitudes x 365 nights x 2 kinds).
//
// Why every half degree, not interpolation between whole degrees: where the Sun's deepest
// point of the night just reaches a shell's window, the count changes by a factor of several
// within one degree of latitude (at 71.5°N on 11 February 2027 the whole-degree neighbours
// give 318 and 17 flares, the half degree between them 31, where interpolation would give
// 167), so a 1° table interpolated at the half degrees would be wrong by up to a factor of 5
// in such cells.
//
// Format (JSON): a header (with the span and the shell table's reference epoch), then one
// flat integer array per kind, latitude-major (nLat x days). Latitude i is latMin + i x
// latStep; night n starts at local noon on span.start + n days. Each value is flares per
// night x scale, rounded, then coded for size: along each latitude row the first night is
// stored as is and every later night as the difference from the night before; and the "all"
// rows hold the difference from the "visible" rows. rateModel.decodeRateTable undoes both.
// Measured on the 2026-09-30 table over 1 Sep 2026 - 31 Aug 2027 with dated planes: 828 KB
// raw, 237 KB with brotli and 261 KB with gzip on the wire (18 minutes on 12 workers). The
// dated planes make the curve uneven from night to night, so the differences code less well
// than with evenly spread planes (742 KB, 193 KB, 213 KB).

import { Worker, isMainThread, parentPort } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODEL_URL = pathToFileURL(path.resolve(HERE, "../rate/rateModel.js")).href;
export const SCALE = 10;                 // stored unit: 0.1 flares per night

if (!isMainThread) {
    const M = await import(MODEL_URL);
    parentPort.on("message", (lat) => {
        const out = {};
        for (const kind of M.KINDS) out[kind] = Array.from(M.yearTotals(lat, kind));
        parentPort.postMessage({ lat, out });
    });
} else {
    const a = process.argv.slice(2), opt = {};
    for (let i = 0; i < a.length; i++) opt[a[i].replace(/^--/, "")] = a[i + 1]?.startsWith("--") ? true : a[++i];
    const step = Number(opt["lat-step"] || 0.5);
    const [latMin, latMax] = String(opt.lats || "-90:90").split(":").map(Number);
    const workers = Math.max(1, Number(opt.workers || 4));
    const outFile = path.resolve(opt.out || path.resolve(HERE, "../rate/rateTable.json"));
    const M = await import(MODEL_URL);
    const lats = [];
    for (let v = latMin; v <= latMax + 1e-9; v += step) lats.push(Math.round(v * 1000) / 1000);
    console.log(`${lats.length} latitudes (${latMin}..${latMax} step ${step}) x ${M.DAYS} nights (${M.SPAN.start} to ${M.SPAN.end}) x ${M.KINDS.length} kinds on ${workers} workers; ` +
        `${M.SHELLS.length} model shells from ${M.STARLINK_SHELLS.source}, planes dated from ${M.STARLINK_SHELLS.refEpoch}`);
    const rows = new Map();
    const t0 = Date.now();
    await new Promise((resolve, reject) => {
        let next = 0, done = 0;
        const pool = [];
        for (let i = 0; i < Math.min(workers, lats.length); i++) {
            const w = new Worker(fileURLToPath(import.meta.url));
            pool.push(w);
            const feed = () => { if (next < lats.length) w.postMessage(lats[next++]); };
            w.on("message", (m) => {
                rows.set(m.lat, m.out);
                done++;
                const el = (Date.now() - t0) / 1000;
                console.log(`  ${done}/${lats.length}  lat ${m.lat}  ${el.toFixed(0)} s  ETA ${(el / done * (lats.length - done)).toFixed(0)} s`);
                if (done === lats.length) { pool.forEach((p) => p.terminate()); resolve(); } else feed();
            });
            w.on("error", (e) => { pool.forEach((p) => p.terminate()); reject(e); });
            feed();
        }
    });
    const table = {
        format: M.RATE_TABLE_FORMAT, built: new Date().toISOString(), source: M.STARLINK_SHELLS.source, refEpoch: M.STARLINK_SHELLS.refEpoch,
        span: { start: M.SPAN.start, end: M.SPAN.end }, days: M.DAYS, latMin, latStep: step, nLat: lats.length, scale: SCALE, kinds: M.KINDS,
    };
    let maxValue = 0;
    const quantized = {};
    for (const kind of M.KINDS) {
        const flat = [];
        for (const lat of lats) for (const v of rows.get(lat)[kind]) { maxValue = Math.max(maxValue, v); flat.push(Math.round(v * SCALE)); }
        quantized[kind] = flat;
    }
    // Coding for size: day-to-day differences along each row; "all" as the difference from "visible".
    for (const kind of M.KINDS) {
        const base = kind === "visible" ? null : quantized.visible, src = quantized[kind];
        const coded = new Array(src.length);
        for (let i = 0; i < lats.length; i++) for (let n = 0; n < M.DAYS; n++) {
            const k = i * M.DAYS + n, v = base ? src[k] - base[k] : src[k];
            coded[k] = n ? v - (base ? src[k - 1] - base[k - 1] : src[k - 1]) : v;
        }
        table[kind] = coded;
    }
    // Self-check: decoding gives the quantized values back.
    const decoded = M.decodeRateTable(table);
    for (const kind of M.KINDS) for (let k = 0; k < quantized[kind].length; k++) {
        if (Math.abs(decoded[kind][k] * SCALE - quantized[kind][k]) > 1e-6) throw new Error(`decode mismatch at ${kind} ${k}`);
    }
    // One row per latitude in the file, so a diff stays readable.
    const text = JSON.stringify(table, (k, v) => (M.KINDS.includes(k) ? "@@" + k + "@@" : v), 1)
        .replace(/"@@(\w+)@@"/g, (_, kind) => "[\n" + lats.map((_, i) => "  " + table[kind].slice(i * M.DAYS, (i + 1) * M.DAYS).join(",")).join(",\n") + "\n ]") + "\n";
    fs.writeFileSync(outFile, text);
    console.log(`wrote ${outFile}: ${(text.length / 1024).toFixed(0)} KB, max value ${maxValue.toFixed(1)} flares/night, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
