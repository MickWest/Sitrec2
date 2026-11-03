#!/usr/bin/env node
// Run the browser addon's exact search model on a saved analysis. This is also
// the final scoring stage for candidate grids prepared from a large archive.
const fs = require("node:fs");
const path = require("node:path");
const {performance} = require("node:perf_hooks");
const {transformSync} = require("@babel/core");

const root = path.resolve(__dirname, "../src/doppler");
const originalLoader = require.extensions[".js"];
require.extensions[".js"] = (module, filename) => {
    if (path.dirname(filename) !== root) return originalLoader(module, filename);
    const compiled = transformSync(fs.readFileSync(filename, "utf8"), {
        filename, babelrc: false, configFile: false,
        plugins: [require.resolve("@babel/plugin-transform-modules-commonjs")],
    });
    module._compile(compiled.code, filename);
};
const {searchLocations, SEARCH_DEFAULTS} = require("../src/doppler/DopplerSearch");
require.extensions[".js"] = originalLoader;

async function main() {
    const [inputFile, outputFile] = process.argv.slice(2);
    if (!inputFile || !outputFile) throw new Error("Usage: node scripts/doppler-search.cjs Analysis.json Results.json");
    const analysis = JSON.parse(fs.readFileSync(inputFile, "utf8"));
    const settings = {...SEARCH_DEFAULTS, ...analysis.settings};
    const clock = settings.recordingStart;
    settings.recordingStart = clock === "" || clock === null ? null : typeof clock === "number" ? clock :
        /(?:Z|[+-]\d\d:\d\d)$/.test(clock) ? Date.parse(clock)/1000 : NaN;
    const started = performance.now();
    const result = await searchLocations({...analysis, settings}, {
        progress: ({done,total,combinations}) => {
            if (done % 1600 === 1 || done === total) process.stderr.write(`${done}/${total} points; ${combinations} combinations\n`);
        },
    });
    result.elapsedSeconds = (performance.now() - started)/1000;
    fs.writeFileSync(outputFile, JSON.stringify(result));
    console.log(JSON.stringify({elapsedSeconds:result.elapsedSeconds, stats:result.stats, best:result.results[0] ?? null}, null, 2));
}
main().catch(error => {console.error(error.message); process.exitCode = 1;});
