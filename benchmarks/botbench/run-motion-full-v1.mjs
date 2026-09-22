#!/usr/bin/env node
// Full duration/error coverage for each motion family, at both sample rates.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createRequire} from "node:module";
import {motionFullV1SourceSnapshot} from "./motion-full-v1-source.mjs";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (Object.hasOwn(options, key)) throw new Error(`Duplicate option: ${key}`);
    if (["--generic-names", "--readme-only"].includes(key)) { options[key] = true; continue; }
    if (!["--out", "--set", "--fps"].includes(key) || !args[i + 1] || args[i + 1].startsWith("--")) {
        throw new Error("Usage: node run-motion-full-v1.mjs --set Extreme_full_v1|Anomalies_full_v1 [--fps 1,10] [--generic-names] [--out DIRECTORY] [--readme-only]");
    }
    options[key] = args[++i];
}
const outRoot = options["--out"] ? path.resolve(options["--out"]) : path.join(here, "results");
const set = options["--set"];
const rates = options["--fps"]?.split(",").map(Number);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "botbench-motion-full-v1-"));
try {
    const bundle = path.join(temp, "generator.cjs");
    const buildResult = await require("esbuild").build({
        absWorkingDir: repoRoot, metafile: true,
        entryPoints: [path.join(here, "lib/motionFullV1.js")], bundle: true,
        platform: "node", format: "cjs", outfile: bundle, logLevel: "silent",
        plugins: [{name: "unused-targets", setup(build) {
            build.onResolve({filter: /\.\/(venus|capabilityTargets|realSegments)$/},
                args => ({path: args.path, namespace: "unused-target"}));
            build.onLoad({filter: /.*/, namespace: "unused-target"}, args => ({
                contents: `module.exports = new Proxy({}, {get() { throw new Error(${JSON.stringify(`Unused target module: ${args.path}`)}); }});`,
                loader: "js",
            }));
        }}],
    });
    const sourceSnapshot = motionFullV1SourceSnapshot(repoRoot, buildResult.metafile.inputs);
    const generator = require(bundle);
    const run = options["--readme-only"] ? generator.refreshMotionFullV1Readmes : generator.generateMotionFullV1Sets;
    for (const result of run({outRoot, set, rates, sourceSnapshot, genericNames: options["--generic-names"] ?? false,
        onProgress: p => console.log(`${p.set}: ${p.completed}/${p.total} target variants written (${p.variant})`)})) {
        console.log(`${result.set}: ${result.scenarios} scenarios at ${result.fps} Hz, ${options["--readme-only"] ? "README updated" : "completed"}\n${result.dir}`);
    }
} finally {
    fs.rmSync(temp, {recursive: true, force: true});
}
