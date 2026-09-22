#!/usr/bin/env node
// Extreme_v1 and Anomalies_v1 target/platform combinations, at 10 Hz.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createRequire} from "node:module";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
    if (!["--out", "--sets"].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith("--") || options[args[i]]) {
        throw new Error("Usage: npm run bench-bot-motion-v1 [-- --out DIRECTORY --sets Extreme_v1,Anomalies_v1]");
    }
    options[args[i]] = args[i + 1];
}
const outRoot = options["--out"] ? path.resolve(options["--out"]) : path.join(here, "results");
const sets = options["--sets"]?.split(",");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "botbench-motion-v1-"));
try {
    const bundle = path.join(temp, "generator.cjs");
    await require("esbuild").build({
        entryPoints: [path.join(here, "lib/motionV1.js")], bundle: true,
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
    for (const result of require(bundle).generateMotionV1Sets({outRoot, sets})) {
        console.log(`${result.set}: ${result.scenarios} scenarios at ${result.fps} Hz, ${result.files} files\n${result.dir}`);
    }
} finally {
    fs.rmSync(temp, {recursive: true, force: true});
}
