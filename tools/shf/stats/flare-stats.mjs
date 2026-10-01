#!/usr/bin/env node
// flare-stats.mjs — Starlink flare frequency through the year, by latitude.
//
// Scans every night in a date range at each requested latitude with the SHF flare
// engine, then writes CSV tables (flares per night, flares per local solar hour)
// and, when Python + openpyxl are available, an Excel workbook with line charts.
//
//   node tools/shf/stats/flare-stats.mjs --year 2026 --lats 0,20,35,45,55,65,-35
//
// Each scanned night is appended to <out>/nights.jsonl as soon as it finishes, so an
// interrupted run resumes where it stopped, and a run with more latitudes or a finer
// step only scans what is missing. See README.md for every option.

import { Worker } from "node:worker_threads";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { availableParallelism } from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dateRange } from "./statsCore.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// Hours in night order (noon to noon) so the dark period is one continuous run.
const NIGHT_HOURS = Array.from({ length: 24 }, (_, i) => (i + 12) % 24);

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------
const HELP = `Usage: node tools/shf/stats/flare-stats.mjs [options]

  --year YYYY          Scan every night of this year (default: current year)
  --from YYYY-MM-DD    First night (overrides --year)
  --to YYYY-MM-DD      Last night (default: 31 Dec of the --from year)
  --step-days N        Scan every Nth night (default 1; 7 gives a quick preview)
  --lats LIST          Comma-separated latitudes, south negative
                       (default 0,20,35,45,55,65,-35)
  --lon DEG            Observer longitude (default 0). Hours are local mean solar time.
  --alt-km KM          Observer altitude (default 0; 11.3 = a 37,000 ft cruise)
  --min-el DEG         Ignore flares below this elevation (default 0)
  --tle FILE           Use this TLE / OMM CSV file instead of the synthetic
                       constellation. Only realistic for dates near its epoch.
  --workers N          Worker threads (default: CPU count - 1)
  --out DIR            Output directory (default ./flare-stats-out)
  --aggregate-only     Do not scan; rebuild the tables from the cached nights
  --no-xlsx            Write CSV only
  --help`;

function parseArgs(argv) {
    const opt = {
        year: new Date().getUTCFullYear(),
        from: null, to: null, stepDays: 1,
        lats: [0, 20, 35, 45, 55, 65, -35],
        lon: 0, altKm: 0, minEl: 0, tle: null,
        workers: Math.max(1, availableParallelism() - 1),
        out: "flare-stats-out", aggregateOnly: false, xlsx: true,
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = () => {
            if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
            return argv[++i];
        };
        const num = () => {
            const v = Number(next());
            if (!Number.isFinite(v)) throw new Error(`${arg} needs a number`);
            return v;
        };
        switch (arg) {
            case "--year": opt.year = num(); break;
            case "--from": opt.from = next(); break;
            case "--to": opt.to = next(); break;
            case "--step-days": opt.stepDays = Math.max(1, Math.round(num())); break;
            case "--lats": opt.lats = next().split(",").map((s) => Number(s.trim()));
                if (opt.lats.some((v) => !Number.isFinite(v) || Math.abs(v) > 90)) throw new Error("bad --lats");
                break;
            case "--lon": opt.lon = num(); break;
            case "--alt-km": opt.altKm = num(); break;
            case "--min-el": opt.minEl = num(); break;
            case "--tle": opt.tle = next(); break;
            case "--workers": opt.workers = Math.max(1, Math.round(num())); break;
            case "--out": opt.out = next(); break;
            case "--aggregate-only": opt.aggregateOnly = true; break;
            case "--no-xlsx": opt.xlsx = false; break;
            case "--help": case "-h": console.log(HELP); process.exit(0);
            default: throw new Error(`unknown option ${arg}\n\n${HELP}`);
        }
    }
    opt.from = opt.from || `${opt.year}-01-01`;
    opt.to = opt.to || `${opt.from.slice(0, 4)}-12-31`;
    for (const d of [opt.from, opt.to]) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`bad date ${d} (want YYYY-MM-DD)`);
    }
    return opt;
}

// "45°N", "35°S", "0°"
function latLabel(lat) {
    if (lat === 0) return "0°";
    return `${Math.abs(lat)}°${lat > 0 ? "N" : "S"}`;
}

// ---------------------------------------------------------------------------
// Cache of scanned nights (JSON lines, one result per line)
// ---------------------------------------------------------------------------
// The key holds every input that changes the answer, so different sources,
// longitudes or altitudes can share one output directory without mixing.
function nightKey(r, source, model) {
    return [r.date, r.lat, r.lon, r.altKm, r.minEl, source, model].join("|");
}

// Version of the flare model: a hash of every source file that can change a count.
// A change to the physics or the synthetic constellation gives a new key, so a
// resumed run scans again rather than mixing old and new nights.
const MODEL_FILES = ["../flareEngine.js", "../flarePhysics.js", "../dummyTLE.js", "../starlinkShells.js",
    "../geo.js", "../astro.js", "../lib/satellite.es.js", "./statsCore.mjs", "./statsWorker.mjs"];
function modelVersion() {
    const hash = createHash("sha1");
    for (const file of MODEL_FILES) hash.update(fs.readFileSync(path.join(HERE, file)));
    return hash.digest("hex").slice(0, 12);
}

function loadCache(file) {
    const map = new Map();
    if (!fs.existsSync(file)) return map;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
            const rec = JSON.parse(line);
            map.set(rec.key, rec);
        } catch { /* a line cut off by an interrupted run */ }
    }
    return map;
}

// ---------------------------------------------------------------------------
// Worker pool
// ---------------------------------------------------------------------------
function runJobs(jobs, nWorkers, tleText, onResult) {
    return new Promise((resolve, reject) => {
        if (jobs.length === 0) { resolve(); return; }
        let next = 0, done = 0, failed = null;
        const workers = [];
        const count = Math.min(nWorkers, jobs.length);
        const finish = () => {
            for (const w of workers) w.terminate();
            failed ? reject(failed) : resolve();
        };
        for (let i = 0; i < count; i++) {
            const worker = new Worker(path.join(HERE, "statsWorker.mjs"), { workerData: { tleText } });
            workers.push(worker);
            const feed = () => {
                if (next < jobs.length && !failed) worker.postMessage(jobs[next++]);
            };
            worker.on("message", (msg) => {
                if (!msg.ok) failed = failed || new Error(`scan failed for ${JSON.stringify(msg.job)}:\n${msg.error}`);
                else onResult(msg.result);
                done++;
                if (done === jobs.length || (failed && done === next)) finish();
                else feed();
            });
            worker.on("error", (err) => { failed = failed || err; finish(); });
            feed();
        }
    });
}

function makeProgress(total) {
    const t0 = Date.now();
    let done = 0, lastPrint = 0;
    return (label) => {
        done++;
        const now = Date.now();
        if (now - lastPrint < 1000 && done < total) return;
        lastPrint = now;
        const elapsed = (now - t0) / 1000;
        const eta = done ? (elapsed / done) * (total - done) : 0;
        const fmt = (s) => `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, "0")}s`;
        const line = `  ${done}/${total} nights (${(100 * done / total).toFixed(1)}%)  last ${label}  elapsed ${fmt(elapsed)}  ETA ${fmt(eta)}`;
        if (process.stdout.isTTY) process.stdout.write("\r" + line.padEnd(100));
        else console.log(line);
        if (done === total && process.stdout.isTTY) process.stdout.write("\n");
    };
}

// ---------------------------------------------------------------------------
// Aggregation -> CSV
// ---------------------------------------------------------------------------
const round2 = (v) => Math.round(v * 100) / 100;

function writeCsv(file, header, rows) {
    // BOM so Excel reads the degree signs as UTF-8.
    const text = "﻿" + [header, ...rows].map((r) => r.join(",")).join("\n") + "\n";
    fs.writeFileSync(file, text);
}

function aggregate(opt, dates, lookup) {
    const labels = opt.lats.map(latLabel);
    const files = [];
    const csv = (name, header, rows) => {
        const file = path.join(opt.out, name);
        writeCsv(file, header, rows);
        files.push(name);
    };

    for (const kind of ["visible", "all"]) {
        const countOf = (rec) => (kind === "visible" ? rec.visible : rec.all);
        const hoursOf = (rec) => (kind === "visible" ? rec.hourVis : rec.hourAll);

        // Flares per night, one column per latitude.
        csv(`flares_per_night_${kind}.csv`, ["Night of", ...labels],
            dates.map((date) => [date, ...opt.lats.map((lat) => countOf(lookup(date, lat)))]));

        // Mean flares per night in each local solar hour, over all scanned nights.
        const hourMean = (recs, hour) => round2(recs.reduce((s, r) => s + hoursOf(r)[hour], 0) / recs.length);
        const recsByLat = opt.lats.map((lat) => dates.map((date) => lookup(date, lat)));
        csv(`flares_per_hour_year_${kind}.csv`, ["Local solar hour", ...labels],
            NIGHT_HOURS.map((h) => [`${String(h).padStart(2, "0")}:00`, ...recsByLat.map((recs) => hourMean(recs, h))]));

        // The same, for each calendar month separately (blocks of 24 rows).
        const rows = [];
        for (let m = 0; m < 12; m++) {
            const monthDates = dates.filter((d) => Number(d.slice(5, 7)) === m + 1);
            if (monthDates.length === 0) continue;
            const monthRecs = opt.lats.map((lat) => monthDates.map((date) => lookup(date, lat)));
            for (const h of NIGHT_HOURS) {
                rows.push([MONTHS[m], `${String(h).padStart(2, "0")}:00`, ...monthRecs.map((recs) => hourMean(recs, h))]);
            }
        }
        csv(`flares_per_hour_by_month_${kind}.csv`, ["Month", "Local solar hour", ...labels], rows);
    }

    // One summary row per latitude.
    const summary = opt.lats.map((lat, i) => {
        const recs = dates.map((date) => lookup(date, lat));
        const vis = recs.map((r) => r.visible);
        const maxI = vis.indexOf(Math.max(...vis));
        const total = vis.reduce((a, b) => a + b, 0);
        return [labels[i], lat, recs.length, total, round2(total / recs.length),
            vis[maxI], recs[maxI].date, vis.filter((v) => v === 0).length,
            recs.reduce((s, r) => s + r.all, 0)];
    });
    csv("summary.csv", ["Latitude", "Lat (deg)", "Nights scanned", "Visible flares",
        "Mean visible per night", "Max visible in a night", "Night of max",
        "Nights with no visible flares", "All flares (incl. faint)"], summary);

    return files;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
    const opt = parseArgs(process.argv.slice(2));
    fs.mkdirSync(opt.out, { recursive: true });

    const tleText = opt.tle ? fs.readFileSync(opt.tle, "utf8") : null;
    const source = tleText
        ? "tle:" + createHash("sha1").update(tleText).digest("hex").slice(0, 12)
        : "synthetic";
    const dates = dateRange(opt.from, opt.to, opt.stepDays);
    const cacheFile = path.join(opt.out, "nights.jsonl");
    const cache = loadCache(cacheFile);

    const base = { lon: opt.lon, altKm: opt.altKm, minEl: opt.minEl };
    const model = modelVersion();
    const keyOf = (date, lat) => nightKey({ date, lat, ...base }, source, model);
    const jobs = [];
    for (const date of dates) {
        for (const lat of opt.lats) {
            if (!cache.has(keyOf(date, lat))) {
                jobs.push({ date, lat, lon: opt.lon, altKm: opt.altKm, minElevationDeg: opt.minEl });
            }
        }
    }

    console.log(`Starlink flare statistics — ${source} constellation, model ${model}`);
    console.log(`  nights ${opt.from} .. ${opt.to} every ${opt.stepDays} day(s): ${dates.length}`);
    console.log(`  latitudes ${opt.lats.map(latLabel).join(", ")}  lon ${opt.lon}°  alt ${opt.altKm} km  min el ${opt.minEl}°`);
    console.log(`  cached ${dates.length * opt.lats.length - jobs.length}, to scan ${jobs.length}` +
        (opt.aggregateOnly ? " (skipped: --aggregate-only)" : ` on ${opt.workers} worker(s)`));

    if (!opt.aggregateOnly && jobs.length) {
        const out = fs.openSync(cacheFile, "a");
        const tick = makeProgress(jobs.length);
        try {
            await runJobs(jobs, opt.workers, tleText, (res) => {
                const rec = {
                    key: keyOf(res.date, res.lat), ...base, source, model,
                    date: res.date, lat: res.lat,
                    all: res.all, visible: res.visible, hourAll: res.hourAll, hourVis: res.hourVis,
                };
                fs.writeSync(out, JSON.stringify(rec) + "\n");
                cache.set(rec.key, rec);
                tick(`${res.date} ${latLabel(res.lat)} → ${res.visible}`);
            });
        } finally {
            fs.closeSync(out);
        }
    }

    const missing = [];
    const lookup = (date, lat) => {
        const rec = cache.get(keyOf(date, lat));
        if (!rec) missing.push(`${date} ${latLabel(lat)}`);
        return rec;
    };
    for (const date of dates) for (const lat of opt.lats) lookup(date, lat);
    if (missing.length) {
        console.error(`\n${missing.length} night(s) not scanned yet (e.g. ${missing[0]}). Run without --aggregate-only.`);
        process.exit(1);
    }

    // Remove the previous workbook first, so it cannot sit beside newer CSV files
    // when this run writes CSV only or the workbook step fails.
    fs.rmSync(path.join(opt.out, "FlareStats.xlsx"), { force: true });
    const files = aggregate(opt, dates, lookup);
    fs.writeFileSync(path.join(opt.out, "run.json"), JSON.stringify({
        source, model, tle: opt.tle ? path.basename(opt.tle) : null,
        from: opt.from, to: opt.to, stepDays: opt.stepDays, nights: dates.length,
        lats: opt.lats, labels: opt.lats.map(latLabel),
        lon: opt.lon, altKm: opt.altKm, minElevationDeg: opt.minEl,
        generated: new Date().toISOString(),
    }, null, 2));
    console.log(`\nWrote ${files.length} CSV files to ${path.resolve(opt.out)}`);

    if (opt.xlsx) {
        const py = spawnSync("python3", [path.join(HERE, "make-xlsx.py"), opt.out], { stdio: "inherit" });
        if (py.error || py.status !== 0) {
            console.warn("Excel workbook not written (needs python3 with openpyxl: pip3 install openpyxl). The CSV files are complete.");
        }
    }
}

main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
});
