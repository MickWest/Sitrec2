#!/usr/bin/env node
// render-charts.mjs — write the BOT Bench result figures to image files.
//
//     npm run bot-charts -- --input private/notes/data/rock-v3-results.jsonl \
//                           --out-dir private/notes/RockV3ChartsJS
//
// This is the OPTIONAL half of the charting. The main path is the app: open
// File > File Analysis > Result Charts..., which draws the same figures from the
// same specs and exports SVG or a 300 dpi PNG with no automation at all. Reach
// for this one when a script has to produce the figures unattended, in a build
// or over a directory of result sets.
//
// WHY THIS NEEDS A BROWSER. Plotly has no server-side renderer. Its only static
// export paths are a real browser or Kaleido, which is Python and itself needs
// Chrome. So this drives the Playwright Chromium the repository already carries
// for the regression tests. Nothing else here needs it, and the app does not.
//
// Options:
//   --input <file>     joined results JSONL (required)
//   --out-dir <dir>    where the images go (default private/notes/RockV3ChartsJS)
//   --format <fmt>     svg (default), png, or both
//   --scale <n>        PNG pixel multiplier (default 3, so ~4500px wide)
//   --only <keys>      comma-separated figure keys; default all
//   --turn <deg>       limit the figures to one sensor-turn level (the sensor-turn
//                      figures always use every level), as the window's Turn level does
//   --marks <list>     dot marks, comma-separated: area (by clip length), straight (as red squares)
//   --suffix <text>    added to every file name, so variants of one figure can sit side by side
//   --index            also write an index.html that shows them all
//   --list             print the figure keys and exit
import fs from "fs";
import path from "path";
import {fileURLToPath} from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
    const at = args.indexOf(`--${name}`);
    return at >= 0 && args[at + 1] && !args[at + 1].startsWith("--") ? args[at + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const input = flag("input");
const outDir = path.resolve(ROOT, flag("out-dir", "private/notes/RockV3ChartsJS"));
const format = flag("format", "svg");
const scale = Number(flag("scale", "3"));
const only = flag("only") ? flag("only").split(",").map((s) => s.trim()) : null;

// The specs are browser ES6 with extensionless imports, so they are bundled
// before import. esbuild is already a dependency of the other bench drivers.
const {build} = await import("esbuild");
const bundled = await build({
    entryPoints: [path.join(ROOT, "src/analysis/charts/RockV3ChartSpecs.js")],
    bundle: true, format: "esm", write: false, platform: "neutral", logLevel: "silent",
});
const specSource = bundled.outputFiles[0].text;
const specs = await import("data:text/javascript;base64," + Buffer.from(specSource).toString("base64"));

if (has("list")) {
    for (const figure of specs.FIGURES) console.log(`${figure.key.padEnd(20)} ${figure.group}: ${figure.name}`);
    process.exit(0);
}
if (!input) { console.error("--input <joined results JSONL> is required; --list shows the figure keys"); process.exit(1); }
const inputPath = path.resolve(ROOT, input);
if (!fs.existsSync(inputPath)) { console.error(`no such file: ${inputPath}`); process.exit(1); }

const rows = fs.readFileSync(inputPath, "utf8").split("\n").filter(Boolean)
    .map((line) => JSON.parse(line)).filter((r) => !r.header);
const turnDeg = flag("turn") !== null ? Number(flag("turn")) : null;
const markList = (flag("marks") ?? "").split(",").map((s) => s.trim());
const marks = {sizeByLength: markList.includes("area"), markStraight: markList.includes("straight")};
const suffix = flag("suffix", "");
const figures = specs.buildAllFigures(rows, {only, turnDeg, marks}).filter((f) => !f.error);
if (!figures.length) { console.error("no figure could be built from those rows"); process.exit(1); }
console.log(`${rows.length} rows -> ${figures.length} figure(s): ${figures.map((f) => f.key).join(", ")}`);

fs.mkdirSync(outDir, {recursive: true});

const {chromium} = await import("playwright");
const browser = await chromium.launch();
const page = await browser.newPage({viewport: {width: 1600, height: 1000}});
// The library is loaded from the installed package, not from a CDN: the render
// must not depend on the network, and it must be the same version the app uses.
const plotlySource = fs.readFileSync(
    path.join(ROOT, "node_modules/plotly.js-cartesian-dist-min/plotly-cartesian.min.js"), "utf8");
await page.setContent("<!doctype html><body style='margin:0'><div id='plot'></div></body>");
await page.addScriptTag({content: plotlySource});

const formats = format === "both" ? ["svg", "png"] : [format];
const written = [];
for (const figure of figures) {
    for (const fmt of formats) {
        const dataUrl = await page.evaluate(async ({data, layout, config, fmt: f, scale: s}) => {
            const holder = document.getElementById("plot");
            await window.Plotly.newPlot(holder, data, layout, {...config, staticPlot: true});
            const url = await window.Plotly.toImage(holder, {
                format: f, width: layout.width ?? 1500, height: layout.height ?? 900,
                scale: f === "svg" ? 1 : s,
            });
            window.Plotly.purge(holder);
            return url;
        }, {data: figure.data, layout: figure.layout, config: figure.config, fmt, scale});

        const file = path.join(outDir, `${figure.key}${suffix}.${fmt}`);
        if (fmt === "svg") {
            // Plotly hands SVG back as a percent-encoded data URL, not base64.
            fs.writeFileSync(file, decodeURIComponent(dataUrl.replace(/^data:image\/svg\+xml,/, "")));
        } else {
            fs.writeFileSync(file, Buffer.from(dataUrl.split(",")[1], "base64"));
        }
        written.push(path.basename(file));
        console.log(`  wrote ${path.relative(ROOT, file)} (${(fs.statSync(file).size / 1024).toFixed(0)} kB)`);
    }
}
await browser.close();

if (has("index")) {
    const ext = formats.includes("svg") ? "svg" : formats[0];
    const items = figures.map((f) =>
        `<figure><figcaption><b>${f.key}${suffix}</b> — ${f.title}</figcaption>`
        + `<img src="${f.key}${suffix}.${ext}" alt="${f.key}${suffix}"></figure>`).join("\n");
    fs.writeFileSync(path.join(outDir, "index.html"),
        `<meta charset="utf-8"><title>BOT Bench result charts</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:24px;max-width:1560px}
img{max-width:100%;border:1px solid #e1e0d9}figure{margin:0 0 28px}
figcaption{color:#52514e;font-size:13px;margin-bottom:6px}</style>
<h1>BOT Bench result charts</h1><p>${rows.length} rows from ${path.basename(inputPath)}.
Rendered by benchmarks/botbench/render-charts.mjs from src/analysis/charts/RockV3ChartSpecs.js.</p>
${items}`);
    console.log(`  wrote ${path.relative(ROOT, path.join(outDir, "index.html"))}`);
}
console.log(`done: ${written.length} file(s) in ${path.relative(ROOT, outDir)}`);
