#!/usr/bin/env node
/**
 * run-botset-maneuvers.mjs — worker_threads driver for the maneuver botsets.
 *
 *     npm run bench-bot-maneuvers-par
 *     node benchmarks/botbench/run-botset-maneuvers.mjs [--concurrency N]
 *
 * The 24 batch folders (2 sets x 4 durations x 3 error levels) are independent
 * — no two touch the same file — so each runs in its own worker thread. Batch
 * generation lives in lib/botsetManeuverBatch.js, shared verbatim with the
 * sequential bench (botset-maneuvers.bench.test.js), and generation is
 * deterministic per (spec, seed),
 * so this driver's output tree is byte-identical to a sequential run; only
 * timing.json (wall times) differs.
 *
 * The generation chain is deliberately free of app globals (no Sit, no
 * Three.js), which is what makes true in-process workers possible here — the
 * physics bench, whose solvers need the app stack, shards Jest processes
 * instead (run-physics-parallel.mjs). The worker bundle is built once per run
 * with esbuild; the lazy non-maneuver target modules (venus, capability,
 * real-segments) are stubbed out, so pulling the app stack in by accident is
 * a build error here, not a silent slowdown.
 */

import {Worker} from "node:worker_threads";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createRequire} from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const RESULTS = path.join(__dirname, "results");
const ENTRY = path.join(__dirname, "lib", "botsetManeuverWorker.js");

// ---- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
let conc = null;
for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--concurrency") {
        const v = argv[++i];
        if (!/^[0-9]+$/.test(v ?? "")) {
            console.error(`--concurrency requires a whole number, got: ${v}`);
            process.exit(1);
        }
        conc = parseInt(v, 10);
        if (conc < 1 || conc > 32) {
            console.error("--concurrency out of range (1..32)");
            process.exit(1);
        }
    } else {
        console.error(`unknown option: ${argv[i]}\n`
            + "usage: run-botset-maneuvers.mjs [--concurrency N]");
        process.exit(1);
    }
}

// ---- build the worker bundle ------------------------------------------------
// Stub the target families the maneuver botsets never generate: they are lazy
// require()s in generateScenario/targets, and following them would drag the
// astronomy / vehicle-model / filesystem chains into the bundle. The stub
// throws on USE, so if the maneuver botsets ever grow one of these families the run
// fails loudly instead of silently producing wrong truth.
async function buildWorkerBundle() {
    const esbuild = require("esbuild");
    const outfile = path.join(os.tmpdir(),
        `botbench-maneuver-worker-${process.pid}.cjs`);
    const stub = {
        name: "botset-maneuver-stubs",
        setup(build) {
            build.onResolve({filter: /\.\/(venus|capabilityTargets|realSegments)$/},
                (args) => ({path: args.path, namespace: "botset-maneuver-stub"}));
            build.onLoad({filter: /.*/, namespace: "botset-maneuver-stub"}, (args) => ({
                contents: `module.exports = new Proxy({}, {get() {
                    throw new Error("module ${args.path} is stubbed in the maneuver botset worker bundle - "
                        + "these sets only generate maneuver targets");
                }});`,
                loader: "js",
            }));
        },
    };
    await esbuild.build({
        entryPoints: [ENTRY],
        bundle: true,
        platform: "node",
        format: "cjs",
        outfile,
        plugins: [stub],
        logLevel: "silent",
    });
    return outfile;
}

// ---- worker pool ------------------------------------------------------------
function runBatch(bundle, task) {
    return new Promise((resolve, reject) => {
        const w = new Worker(bundle, {workerData: task});
        w.once("message", (m) => {
            if (m.ok) resolve(m.result);
            else reject(new Error(`batch ${task.setKey}/${task.durationSeconds}s/${task.errorLabel}: ${m.error}`));
        });
        w.once("error", reject);
        w.once("exit", (code) => {
            if (code !== 0) reject(new Error(`worker exited ${code}`));
        });
    });
}

async function main() {
    const t0 = Date.now();
    const bundle = await buildWorkerBundle();
    const buildMs = Date.now() - t0;

    // The sweep axes come from the bundle itself (the entry exports them and
    // only runs a batch when parentPort exists), so the task list can never
    // drift from lib/botsetManeuvers.js.
    const {AXES} = require(bundle);
    const tasks = [];
    for (const set of AXES.sets) {
        for (const durationSeconds of AXES.durations) {
            for (const errorLabel of AXES.errorLabels) {
                tasks.push({setKey: set.key, durationSeconds, errorLabel,
                    outRoot: RESULTS});
            }
        }
    }

    const conc2 = conc ?? Math.max(1, Math.min(tasks.length,
        (os.availableParallelism?.() ?? os.cpus().length) - 1));
    console.log(`[botset-par] ${tasks.length} batches, concurrency ${conc2}, `
        + `worker bundle in ${buildMs} ms`);

    // Same clean-slate rule as the bench: names encode variant and flags, so a
    // rename would leave stale files behind. Only the botset directories go —
    // results/ holds many other generated trees.
    for (const set of AXES.sets) {
        fs.rmSync(path.join(RESULTS, set.dirName), {recursive: true, force: true});
    }

    const results = [];
    const queue = [...tasks];
    const t1 = Date.now();
    const workers = Array.from({length: conc2}, async () => {
        while (queue.length) {
            const task = queue.shift();
            const r = await runBatch(bundle, task);
            results.push(r);
            console.log(`[botset-par] ${r.batch}: ${r.scenarios} scenarios in ${r.ms} ms`);
        }
    });
    try {
        await Promise.all(workers);
    } finally {
        try { fs.unlinkSync(bundle); } catch { /* tmp cleanup only */ }
    }

    // Deterministic report order + the same timing.json shape as the bench.
    const order = new Map(tasks.map((t, i) => [`${t.setKey}|${t.durationSeconds}|${t.errorLabel}`, i]));
    const keyOf = (r) => `${r.set}|${r.batch.match(/batch_(\d+)s\//)[1]}|${r.batch.split("/").pop()}`;
    results.sort((a, b) => order.get(keyOf(a)) - order.get(keyOf(b)));
    const wallMs = Date.now() - t1;
    const cpuMs = results.reduce((s, r) => s + r.ms, 0);
    const filesTotal = results.reduce((s, r) => s + r.files, 0);
    // Per-SET timing files, matching the sequential bench: the set directory is
    // what vizBotBench takes, so its timing belongs inside it.
    for (const set of AXES.sets) {
        const mine = results.filter((r) => r.set === set.key);
        if (!mine.length) continue;
        fs.writeFileSync(path.join(RESULTS, set.dirName, "timing.json"), JSON.stringify({
            generatedAt: new Date().toISOString(),
            set: set.key,
            scenarios: mine.reduce((s2, r) => s2 + r.scenarios, 0),
            files: mine.reduce((s2, r) => s2 + r.files, 0),
            totalMs: wallMs,
            parallel: {concurrency: conc2},
            batches: mine.map((r) => ({batch: r.batch, scenarios: r.scenarios, ms: r.ms})),
        }, null, 2));
    }
    fs.writeFileSync(path.join(RESULTS, "botset_maneuvers-timing.json"), JSON.stringify({
        generatedAt: new Date().toISOString(),
        scenarios: results.reduce((s, r) => s + r.scenarios, 0),
        files: filesTotal,
        totalMs: wallMs,
        parallel: {concurrency: conc2, summedBatchMs: cpuMs,
            speedup: Number((cpuMs / wallMs).toFixed(2))},
        batches: results.map((r) => ({batch: r.batch,
            scenarios: r.scenarios, ms: r.ms})),
    }, null, 2));

    console.log(`[botset-par] total: ${results.reduce((s, r) => s + r.scenarios, 0)} scenarios, `
        + `${filesTotal} files | wall ${wallMs} ms, summed batch time ${cpuMs} ms `
        + `(~${(cpuMs / wallMs).toFixed(1)}x)`);
}

main().catch((e) => {
    console.error(`[botset-par] FAILED: ${e && e.stack || e}`);
    process.exit(1);
});
