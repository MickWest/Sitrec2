#!/usr/bin/env node
/**
 * run-rock-v3.mjs — worker_threads driver for the rock_v3 dataset.
 *
 *     npm run bench-bot-rock-v3
 *     node benchmarks/botbench/run-rock-v3.mjs [--concurrency N]
 *         [--durations 20,40] [--rungs 0.0deg,0.2deg] [--keep] [--out DIR] [--hz N]
 *
 * The 63 batch folders (7 clip lengths x 9 pointing-error rungs) are
 * independent, so each runs in its own worker thread. Batch generation lives in
 * lib/rockV3Batch.js and is deterministic per (spec, seed), so this driver's
 * output tree is byte-identical to a sequential run; only timing.json differs.
 *
 * Without --durations / --rungs the run is the whole set: the existing
 * results/rock_v3/ is renamed aside and deleted, and the set is written into a
 * new, empty folder. With a filter, only the requested folders are rewritten. After every run the master manifest.json is
 * rebuilt from what is ON DISK: every folder present, its track count, and the
 * definition hash its rows were written under, with any folder from an older
 * definition flagged stale and `complete` false. timing.json records the last
 * full run; a partial run writes timing-partial.json instead.
 *
 * The worker bundle is built once per run with esbuild; the lazy target
 * modules the set never uses (venus, capability, real segments, the maneuver
 * taxonomy) are stubbed, so pulling the app stack in by accident is a build
 * error rather than a silent slowdown.
 */

import {Worker} from "node:worker_threads";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createRequire} from "node:module";
import {execSync} from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
let RESULTS = path.join(__dirname, "results");
const ENTRY = path.join(__dirname, "lib", "rockV3Worker.js");

// ---- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
let conc = null, onlyDurations = null, onlyRungs = null, keep = false;
let hz = 10;
for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--concurrency") {
        conc = parseInt(argv[++i], 10);
        if (!(conc >= 1 && conc <= 32)) { console.error("--concurrency must be 1..32"); process.exit(1); }
    } else if (a === "--durations") {
        onlyDurations = argv[++i].split(",").map(Number);
    } else if (a === "--rungs") {
        onlyRungs = argv[++i].split(",");
    } else if (a === "--keep") {
        keep = true;
    } else if (a === "--hz") {
        hz = Number(argv[++i]);
        if (!Number.isSafeInteger(hz) || hz < 1) {
            console.error("--hz must be a positive whole number");
            process.exit(1);
        }
    } else if (a === "--out") {
        const dir = argv[++i];
        if (!dir || dir.startsWith("--")) {
            console.error("--out requires a directory");
            process.exit(1);
        }
        RESULTS = path.resolve(dir);
    } else {
        console.error(`unknown option: ${a}\nusage: run-rock-v3.mjs [--concurrency N] [--durations 20,40] [--rungs 0.0deg,0.2deg] [--keep] [--out DIR] [--hz N]`);
        process.exit(1);
    }
}

// ---- build the worker bundle ------------------------------------------------
async function buildWorkerBundle() {
    const esbuild = require("esbuild");
    const outfile = path.join(os.tmpdir(), `botbench-rock-v3-worker-${process.pid}.cjs`);
    const stub = {
        name: "rock-v3-stubs",
        setup(build) {
            build.onResolve({filter: /\.\/(venus|capabilityTargets|realSegments|maneuverTargets)$/},
                (args) => ({path: args.path, namespace: "rock-v3-stub"}));
            build.onLoad({filter: /.*/, namespace: "rock-v3-stub"}, (args) => ({
                contents: `module.exports = new Proxy({}, {get() {
                    throw new Error("module ${args.path} is stubbed in the rock_v3 worker bundle - "
                        + "this set only generates balloon and drone targets");
                }});`,
                loader: "js",
            }));
        },
    };
    await esbuild.build({entryPoints: [ENTRY], bundle: true, platform: "node", format: "cjs",
        outfile, plugins: [stub], logLevel: "silent"});
    return outfile;
}

function runBatch(bundle, task) {
    return new Promise((resolve, reject) => {
        const w = new Worker(bundle, {workerData: task});
        w.once("message", (m) => {
            if (m.ok) resolve(m.result);
            else reject(new Error(`batch ${task.durationSeconds}s/${task.errorLabel}: ${m.error}`));
        });
        w.once("error", reject);
        w.once("exit", (code) => { if (code !== 0) reject(new Error(`worker exited ${code}`)); });
    });
}

function gitHead() {
    try {
        const head = execSync("git rev-parse --short HEAD", {cwd: __dirname, encoding: "utf8"}).trim();
        const dirty = execSync("git status --porcelain -- benchmarks/botbench/lib src/BalloonPhysics.js", {cwd: path.join(__dirname, "..", ".."), encoding: "utf8"}).trim();
        return {head, generatorDirty: dirty ? dirty.split("\n") : []};
    } catch {
        return {head: "unknown", generatorDirty: []};
    }
}

async function main() {
    const t0 = Date.now();
    const bundle = await buildWorkerBundle();
    const buildMs = Date.now() - t0;
    const {AXES, DATASET, rockTrackTable, rockDefinitionHash} = require(bundle);

    const durations = AXES.durations.filter((d) => !onlyDurations || onlyDurations.includes(d));
    const rungs = AXES.errorLabels.filter((r) => !onlyRungs || onlyRungs.includes(r));
    if (!durations.length || !rungs.length) { console.error("nothing to do: check --durations / --rungs"); process.exit(1); }
    const partial = !!(onlyDurations || onlyRungs);
    const tasks = [];
    for (const durationSeconds of durations) {
        for (const errorLabel of rungs) tasks.push({durationSeconds, errorLabel, fps: hz, outRoot: RESULTS});
    }
    // Longest clips first, so the tail of the run is short.
    tasks.sort((a, b) => b.durationSeconds - a.durationSeconds);

    const conc2 = conc ?? Math.max(1, Math.min(tasks.length, (os.availableParallelism?.() ?? os.cpus().length) - 1));
    console.log(`[rock_v3] ${tasks.length} batch folders (${durations.length} lengths x ${rungs.length} rungs), `
        + `${hz} Hz, concurrency ${conc2}, worker bundle in ${buildMs} ms`);

    const setDir = path.join(RESULTS, AXES.dirName);
    if (!partial && !keep && fs.existsSync(setDir)) {
        // A full run starts from a clean slate. Deleting the old tree where it
        // stands fails under a syncing folder: the sync client, and the
        // .DS_Store files an open Finder window writes, re-create entries while
        // the delete runs, and it stops with ENOTEMPTY (on 2026-09-13 it stopped
        // with 270,000 files left after every retry). So the old tree is first
        // renamed aside, one atomic step that fails before anything is written,
        // and the set goes into a new folder that nothing else has open. The
        // renamed tree is then deleted with retries; if it still stands, the run
        // says where it is and carries on, since it is no longer part of the set.
        const aside = `${setDir}.old-${process.pid}`;
        fs.renameSync(setDir, aside);
        let lastError = null;
        for (let attempt = 1; attempt <= 6 && fs.existsSync(aside); attempt++) {
            try { fs.rmSync(aside, {recursive: true, force: true}); } catch (e) {
                lastError = e;
                await new Promise((r) => setTimeout(r, 500 * attempt));
            }
        }
        if (fs.existsSync(aside)) {
            console.warn(`[rock_v3] the previous tree is renamed to ${aside} but could not be deleted `
                + `(${lastError?.code ?? "still present"}); delete it once the folder is quiet`);
        }
    }
    fs.mkdirSync(setDir, {recursive: true});

    const results = [];
    const queue = [...tasks];
    const t1 = Date.now();
    await Promise.all(Array.from({length: conc2}, async () => {
        while (queue.length) {
            const task = queue.shift();
            const r = await runBatch(bundle, task);
            results.push(r);
            console.log(`[rock_v3] ${r.batch}: ${r.scenarios} scenarios in ${r.ms} ms`);
        }
    })).finally(() => { try { fs.unlinkSync(bundle); } catch { /* tmp only */ } });

    results.sort((a, b) => a.durationSeconds - b.durationSeconds || a.errorLabel.localeCompare(b.errorLabel));
    const wallMs = Date.now() - t1;
    const provenance = gitHead();
    const timing = {
        generatedAt: new Date().toISOString(), set: DATASET.name, fps: hz, ...provenance,
        scenarios: results.reduce((s, r) => s + r.scenarios, 0),
        files: results.reduce((s, r) => s + r.files, 0),
        totalMs: wallMs, cpuMs: results.reduce((s, r) => s + r.ms, 0),
        parallel: {concurrency: conc2}, partial,
        durations, rungs,
        batches: results.map((r) => ({batch: r.batch, scenarios: r.scenarios, ms: r.ms})),
    };
    // timing.json describes a FULL run of the set. A partial run records
    // itself beside it and leaves the full run's record alone.
    fs.writeFileSync(path.join(setDir, partial ? "timing-partial.json" : "timing.json"),
        JSON.stringify(timing, null, 2));

    // THE MASTER MANIFEST DESCRIBES WHAT IS ON DISK, never what this run
    // touched. It is rebuilt from the tree after every run: each folder that
    // exists is listed with its track count and the definition hash its rows
    // were written under, and a folder whose hash differs from the current
    // definition is flagged stale, so a partial run after a definition change
    // cannot present old files as members of the new set.
    const definitionHash = rockDefinitionHash(hz);
    const expectedTracks = DATASET.perClass * DATASET.classes.length;
    const folders = [];
    const onDiskBatches = fs.readdirSync(setDir).filter((d) => /^batch_\d+sec$/.test(d))
        .sort((a, b) => parseInt(a.slice(6)) - parseInt(b.slice(6)));
    const onDiskRungs = new Set();
    for (const batch of onDiskBatches) {
        for (const rung of fs.readdirSync(path.join(setDir, batch)).filter((r) => /deg$/.test(r)).sort()) {
            onDiskRungs.add(rung);
            const mf = path.join(setDir, batch, rung, "manifest.json");
            let rows = null;
            try { rows = JSON.parse(fs.readFileSync(mf, "utf8")); } catch { /* no manifest */ }
            const hash = rows?.[0]?.definitionHash ?? null;
            const allCount = fs.existsSync(path.join(setDir, batch, rung, "All"))
                ? fs.readdirSync(path.join(setDir, batch, rung, "All")).filter((n) => n.endsWith(".all.csv")).length : 0;
            folders.push({batch, rung, tracks: rows ? rows.length : 0, allFiles: allCount, definitionHash: hash,
                stale: hash !== definitionHash,
                complete: !!rows && rows.length === expectedTracks && allCount === expectedTracks && hash === definitionHash});
        }
    }
    const expectedFolders = AXES.durations.length * AXES.errorLabels.length;
    const staleFolders = folders.filter((f) => f.stale).map((f) => `${f.batch}/${f.rung}`);
    const incomplete = folders.filter((f) => !f.complete).map((f) => `${f.batch}/${f.rung}`);
    const complete = folders.length === expectedFolders && incomplete.length === 0;
    const tracks = rockTrackTable();
    // How many tracks of each class fly each turn level: 25 of 100 at every level.
    const tracksPerTurnLevel = Object.fromEntries(DATASET.platform.turnLevelsDeg.map((turnDeg) => [turnDeg,
        Object.fromEntries(DATASET.classes.map((c) => [c,
            tracks.filter((r) => r.class === c && r.platform.turnDeg === turnDeg).length]))]));
    const master = {
        dataset: DATASET.name,
        writtenAt: timing.generatedAt, ...provenance,
        generatorVersion: DATASET.generatorVersion, scenarioSeed: DATASET.seed,
        definitionHash,
        complete,
        staleFolders,
        incompleteFolders: incomplete,
        lastRun: {partial, durations, rungs, fps: hz, generatedAt: timing.generatedAt,
            record: partial ? "timing-partial.json" : "timing.json"},
        layout: {
            batchFolders: onDiskBatches,
            rungFolders: [...onDiskRungs].sort((a, b) => parseFloat(a) - parseFloat(b)),
            expected: {batchFolders: AXES.durations.map((d) => `batch_${d}sec`), rungFolders: AXES.errorLabels},
            perRungFolder: ["Input/<name>.input.csv", "Truth/<name>.truth.csv", "All/<name>.all.csv",
                "meta/<name>.scenario.json", "meta/<name>.truth.json", "manifest.json"],
            tracksPerFolder: expectedTracks,
            naming: DATASET.classes.map((c) => `${c}_001 ... ${c}_${String(DATASET.perClass).padStart(3, "0")}`),
            interchangeSpec: "benchmarks/botbench/BOT-Interchange-Format.html (v1.2)",
        },
        folders,
        design: {
            fps: hz, fovFullDeg: DATASET.fovFullDeg, epochISO: DATASET.epochISO,
            errorLadderDeg: AXES.errorLabels.map((l) => parseFloat(l)),
            platform: {...DATASET.platform, kind: "centered-turn",
                note: "level flight: straight for the first quarter of the clip, one constant-rate turn through the "
                    + "track's turn level over the middle half, straight for the last quarter, so a track flies the "
                    + "same shape at every clip length; one path per track number, turn level included, shared by "
                    + "the three classes; within each turn level the start headings are spread evenly around the "
                    + "first sightline and neighbouring headings turn opposite ways; the target starts due north at "
                    + "the drawn horizontal range"},
            tracksPerTurnLevel,
            rangeM: DATASET.rangeM,
            classes: {
                balloon: "party balloon, vertical rate -1.5 to +3.5 m/s, start height 150 to 3000 m, uniform wind 0 to 15 m/s",
                drone: "small fixed-wing drone on a racetrack, circle or square ground track, 15 to 30 m/s, 80 to 1200 m, turn radius from a 40 degree bank floor to 400 m",
                weather_balloon: "random segment of a sounding-balloon release: start height 300 m to 26 km, rise 4.2 to 6 m/s, sheared and veering wind 4 to 30 m/s",
            },
            nesting: "every track's spec is identical across clip lengths except durationSeconds and the observation "
                + "section, and the target flights are deterministic, so a shorter clip's target truth is the first "
                + "part of the longer one; a turning sensor path is not, because a longer clip flies the same shape "
                + "larger; each track draws one operator wobble per rung, shared by every clip length",
            firstVersion: "the targets, ranges, winds and wobble draws are those of the first rock_v3 (definition "
                + "b9c49c0c), which flew a holding pattern entered at a random point; only the sensor path changed",
        },
        tracks,
    };
    fs.writeFileSync(path.join(setDir, "manifest.json"), JSON.stringify(master, null, 2));

    console.log(`[rock_v3] done: ${timing.scenarios} scenarios, ${timing.files} files, `
        + `${(wallMs / 1000).toFixed(1)} s wall, ${(timing.cpuMs / 1000).toFixed(1)} s cpu, HEAD ${provenance.head}`
        + (provenance.generatorDirty.length ? ` (uncommitted generator changes)` : ""));
    console.log(`[rock_v3] on disk: ${folders.length} of ${expectedFolders} folders, definition ${definitionHash}, `
        + (complete ? "complete and consistent" : `INCOMPLETE: ${incomplete.length} folder(s) missing, short or stale`
            + (staleFolders.length ? `; stale (older definition): ${staleFolders.join(", ")}` : "")));
    if (!complete) process.exitCode = 2;
}

main().catch((e) => { console.error(e); process.exit(1); });
