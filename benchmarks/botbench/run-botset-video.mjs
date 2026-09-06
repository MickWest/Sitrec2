#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createRequire} from "node:module";
import {execFileSync} from "node:child_process";
import {parseArgs} from "node:util";
import {chromium} from "playwright";

const require = createRequire(import.meta.url);
const root = path.dirname(fileURLToPath(import.meta.url));
const {values: args} = parseArgs({options: {
    video: {type: "boolean", default: false}, count: {type: "string", default: "3"},
    duration: {type: "string", default: "20"}, wobble: {type: "string"}, 'wobble-deg': {type: "string"},
    scenario: {type: "string"}, 'recenter-speed-scale': {type: "string", default: "1"},
    'drift-speed': {type: "string"}, 'recenter-speed': {type: "string"},
    url: {type: "string"}, out: {type: "string"}, headed: {type: "boolean", default: false},
    'verify-only': {type: "boolean", default: false},
}});
const outputDir = path.resolve(args.out || path.join(root, "results", "video"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "botbench-video-"));
let browser;
try {
    const outfile = path.join(tmp, "generator.cjs");
    await require("esbuild").build({stdin: {contents: `export {generateVideoScenarios} from './lib/videoScenarios'; export {muxVideoKlv} from './lib/muxVideoKlv'; export {setSit} from '../../src/Globals';`,
        resolveDir: root}, bundle: true, platform: "node", format: "cjs", outfile, logLevel: "silent",
        plugins: [{name: "unused-targets", setup(build) {
            build.onResolve({filter: /\.\/(venus|capabilityTargets|realSegments)$/}, a => ({path: a.path, namespace: "unused"}));
            build.onLoad({filter: /.*/, namespace: "unused"}, () => ({contents: 'module.exports = new Proxy({}, {get() { throw new Error("Unsupported video target family"); }});'}));
        }}]});
    const {generateVideoScenarios, muxVideoKlv, setSit} = require(outfile);
    setSit({name: "botbench-video", frames: 10000, fps: 10, simSpeed: 1, lat: 37.244358, lon: -120.738187});
    const scenarios = generateVideoScenarios({count: Number(args.count), durationSeconds: Number(args.duration),
        scenarioName: args.scenario, recenterSpeedScale: Number(args['recenter-speed-scale']),
        driftSpeed: args['drift-speed'] === undefined ? undefined : Number(args['drift-speed']),
        recenterSpeed: args['recenter-speed'] === undefined ? undefined : Number(args['recenter-speed']),
        wobblePercent: args.wobble === undefined ? undefined : Number(args.wobble),
        wobbleDegrees: args['wobble-deg'] === undefined ? undefined : Number(args['wobble-deg'])});
    fs.mkdirSync(outputDir, {recursive: true});
    if (!args['verify-only']) for (const scenario of scenarios) fs.writeFileSync(path.join(outputDir, `${scenario.name}.video.json`), JSON.stringify(scenario));
    if (args.video || args['verify-only']) {
        const url = args.url || process.env.BOTBENCH_URL;
        if (!url) throw new Error("Pass --url=https://local.metabunk.org/<worktree>/?action=new or BOTBENCH_URL");
        execFileSync("ffmpeg", ["-version"], {stdio: "ignore"});
        browser = await chromium.launch({headless: !args.headed, args: ["--enable-unsafe-swiftshader"]});
        for (const scenario of scenarios) {
            console.log(`${args['verify-only'] ? 'Verifying' : 'Recording'} ${scenario.name}: ${scenario.frames} frames at 640x480/30p`);
            const page = await browser.newPage({ignoreHTTPSErrors: true, viewport: {width: 1440, height: 1000}, deviceScaleFactor: 1});
            await page.addInitScript(() => { window._mcpDebug = true; });
            page.on("pageerror", error => console.error(error.message));
            page.on("dialog", dialog => dialog.type() === "beforeunload" ? dialog.accept() : dialog.dismiss());
            await page.goto(url);
            await page.waitForFunction(() => window.Sit?.isCustom && window.NodeMan?.exists("MQ9UI") && window._botBenchVideo, null, {timeout: 90000});
            await page.waitForFunction(() => document.querySelector('#sitrec-objects-ready')?.dataset.ready === 'complete', null, {timeout: 90000});
            let result;
            const tsFile = path.join(outputDir, `${scenario.name}.ts`);
            if (!args['verify-only']) {
                const setup = await page.evaluate(plan => window._botBenchVideo.prepare(plan), scenario);
                console.log(JSON.stringify(setup));
                const firstFrame = await page.evaluate(() => window._botBenchVideo.preview());
                fs.writeFileSync(path.join(outputDir, `${scenario.name}.first.jpg`), Buffer.from(firstFrame.split(",")[1], "base64"));
                const download = page.waitForEvent("download", {timeout: 900000});
                const render = page.evaluate(() => window._botBenchVideo.record());
                const progress = setInterval(async () => {
                    try { console.log(`${scenario.name}: frame ${await page.evaluate(() => window._botBenchVideo.progress)}/${scenario.frames}`); } catch {}
                }, 10000);
                try {
                    const [recording, artifact] = await Promise.all([render, download]);
                    result = recording;
                    await artifact.saveAs(path.join(outputDir, `${scenario.name}.mp4`));
                } finally { clearInterval(progress); }
                const jpeg = await page.evaluate(() => window._botBenchVideo.preview());
                fs.writeFileSync(path.join(outputDir, `${scenario.name}.jpg`), Buffer.from(jpeg.split(",")[1], "base64"));
                const videoTS = path.join(tmp, "video.ts");
                execFileSync("ffmpeg", ["-v", "error", "-y", "-i", path.join(outputDir, `${scenario.name}.mp4`), "-map", "0:v:0",
                    "-c:v", "copy", "-bsf:v", "h264_mp4toannexb", "-mpegts_copyts", "1", "-muxdelay", "0", "-f", "mpegts", videoTS]);
                fs.writeFileSync(tsFile, muxVideoKlv(fs.readFileSync(videoTS), result.records, scenario.fps));
                fs.writeFileSync(path.join(outputDir, `${scenario.name}.recording.json`), JSON.stringify(result));
                console.log(`Wrote ${tsFile}`);
            } else {
                result = JSON.parse(fs.readFileSync(path.join(outputDir, `${scenario.name}.recording.json`), 'utf8'));
            }
            // A fresh custom sitch and the normal File > Import picker exercise
            // TS sniffing, demux, KLV decoding, camera-track creation and video.
            await page.goto(url);
            await page.waitForFunction(() => document.querySelector('#sitrec-objects-ready')?.dataset.ready === 'complete', null, {timeout: 90000});
            const picker = page.waitForEvent("filechooser");
            await page.evaluate(() => window.FileManager.importFile());
            await (await picker).setFiles(tsFile);
            console.log(`Importing ${path.basename(tsFile)}`);
            try {
                await page.waitForFunction(n => window.NodeMan?.get("video", false)?.videoData?.frames === n
                    && Object.values(window.NodeMan.list).some(e => e.data.misb?.length === n), scenario.frames, {timeout: 90000});
            } catch (error) {
                const state = await page.evaluate(() => ({frames: window.NodeMan?.get("video", false)?.videoData?.frames,
                    tracks: Object.values(window.NodeMan.list).filter(e => e.data.misb).map(e => ({id: e.data.id, rows: e.data.misb.length}))}));
                throw new Error(`TS import did not finish: ${JSON.stringify(state)}`, {cause: error});
            }
            const verified = await page.evaluate(records => window._botBenchVideo.verifyImported(records), result.records);
            const {preview, ...roundTrip} = verified;
            fs.writeFileSync(path.join(outputDir, `${scenario.name}.roundtrip.jpg`), Buffer.from(preview.split(",")[1], "base64"));
            fs.writeFileSync(path.join(outputDir, `${scenario.name}.roundtrip.json`), JSON.stringify(roundTrip, null, 2));
            console.log(`Round trip: ${JSON.stringify(roundTrip)}`);
            // Exercise the cropped, zoomed and panned stacked layout too. In
            // this layout the recorded boresight is away from the pane center.
            await page.setViewportSize({width: 1900, height: 900});
            await page.evaluate(() => {
                window.LayoutMan.clearLayout();
                for (const [id, top, left, width, height] of [["video", 0, .5, .5, .5], ["lookView", .5, .5, .5, .5], ["mainView", 0, 0, .5, 1]]) {
                    const view = window.NodeMan.get(id);
                    Object.assign(view, {top, left, width, height});
                    view.updateWH();
                }
                window.NodeMan.get("videoZoom").setValue(194.41219762275512);
                const video = window.NodeMan.get("video");
                video.panOffsetX = 0.00048653345037489746;
                video.panOffsetY = -0.03910959069771094;
            });
            await page.waitForFunction(() => {
                const look = window.NodeMan.get("lookView"), video = window.NodeMan.get("video");
                return look.widthPx > 900 && look.heightPx < 500 && look.heightPx === video.heightPx;
            });
            const layoutReport = await page.evaluate(records => window._botBenchVideo.verifyImported(records), result.records);
            delete layoutReport.preview;
            fs.writeFileSync(path.join(outputDir, `${scenario.name}.roundtrip-layout.json`), JSON.stringify(layoutReport, null, 2));
            console.log(`Zoom/pan layout: ${JSON.stringify(layoutReport)}`);
            await page.close();
        }
    }
    console.log(`${scenarios.length} scenarios in ${outputDir}${args.video || args['verify-only'] ? " (MP4 + TS/KLV verified)" : " (add --video to record MP4 + TS/KLV)"}`);
} finally {
    await browser?.close();
    fs.rmSync(tmp, {recursive: true, force: true});
}
