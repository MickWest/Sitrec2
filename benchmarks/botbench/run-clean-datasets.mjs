#!/usr/bin/env node
/** Regenerate rock_v3 and Anomalies2 without analysis caches at a chosen sample rate. */
import {spawnSync} from "node:child_process";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {parseArgs} from "node:util";

const benchDir = path.dirname(fileURLToPath(import.meta.url));
const usage = "Usage: npm run bench-bot-clean -- [--hz N] [--concurrency N]\n"
    + "Regenerate rock_v3 and Anomalies2 at N Hz (a positive whole number, default 10).\n"
    + "Output: benchmarks/botbench/results/clean at 10 Hz, or clean_<N>hz at other rates.\n"
    + "Existing copies of these two datasets in that output folder are replaced, including their caches.";

try {
    const {values} = parseArgs({options: {
        concurrency: {type: "string"},
        hz: {type: "string", default: "10"},
        help: {type: "boolean", short: "h"},
    }});
    if (values.help) {
        console.log(usage);
        process.exit(0);
    }
    const hz = Number(values.hz);
    if (!Number.isSafeInteger(hz) || hz < 1) {
        throw new Error("--hz must be a positive whole number");
    }
    const outRoot = path.join(benchDir, "results", hz === 10 ? "clean" : `clean_${hz}hz`);
    const args = ["--out", outRoot, "--hz", String(hz)];
    if (values.concurrency !== undefined) {
        if (!/^[0-9]+$/.test(values.concurrency)
            || Number(values.concurrency) < 1 || Number(values.concurrency) > 32) {
            throw new Error("--concurrency must be a whole number from 1 to 32");
        }
        args.push("--concurrency", values.concurrency);
    }

    console.log(`[clean] Generating fresh datasets at ${hz} Hz in ${outRoot}`);
    for (const [script, selection] of [
        ["run-rock-v3.mjs", []],
        ["run-botset-maneuvers.mjs", ["--sets", "anomalies2"]],
    ]) {
        const result = spawnSync(process.execPath, [path.join(benchDir, script), ...selection, ...args],
            {stdio: "inherit"});
        if (result.error) throw result.error;
        if (result.signal) throw new Error(`${script} stopped by ${result.signal}`);
        if (result.status !== 0) process.exit(result.status ?? 1);
    }
    console.log(`[clean] Both datasets are ready in ${outRoot}`);
} catch (error) {
    console.error(`[clean] ${error.message}\n${usage}`);
    process.exitCode = 1;
}
