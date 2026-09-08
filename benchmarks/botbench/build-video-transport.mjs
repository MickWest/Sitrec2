#!/usr/bin/env node
// Build capture-like TS variants from completed BotBench video recordings.
// No browser rendering is repeated, and the precise controls remain available.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";
import {execFileSync} from "node:child_process";
import {parseArgs} from "node:util";

const require = createRequire(import.meta.url);
// Two ways in. --in/--out name one source and one destination directly, which is
// what a clip-per-name set wants; --root/--profiles walks the older
// folder-per-profile layout. Both end in the same buildOne() below.
const {values: args} = parseArgs({options: {root: {type: "string"}, scenario: {type: "string"},
    in: {type: "string"}, out: {type: "string"},
    profiles: {type: "string", default: "low-wobble,tracking-wobble"}}});
const single = args.in !== undefined || args.out !== undefined;
if (single && (args.in === undefined || args.out === undefined)) throw new Error("Pass --in and --out together");
if (!single && !args.root) throw new Error("Pass --in/--out, or --root=<completed representative video folder>");
const profiles = single ? [] : args.profiles.split(",");
if (!single && (profiles.some(p => !/^[a-z0-9][a-z0-9-]*$/.test(p)) || new Set(profiles).size !== profiles.length)) {
    throw new Error("Pass unique profile folder names separated by commas");
}
const root = args.root ? path.resolve(args.root) : null, here = path.dirname(fileURLToPath(import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "botbench-transport-"));
try {
    const outfile = path.join(temp, "transport.cjs");
    await require("esbuild").build({stdin: {contents: "export {muxVideoKlv} from './lib/muxVideoKlv'; export {realisticVideoMetadata} from './lib/realisticVideoMetadata';",
        resolveDir: here}, bundle: true, platform: "node", format: "cjs", outfile, logLevel: "silent"});
    const {muxVideoKlv, realisticVideoMetadata} = require(outfile);
    const buildOne = (source, destination, profile) => {
        const name = path.basename(source);
        const plan = JSON.parse(fs.readFileSync(source + ".video.json"));
        const recording = JSON.parse(fs.readFileSync(source + ".recording.json"));
        if (recording.records.length !== plan.frames) throw new Error(`Incomplete source recording: ${source}`);
        const samples = realisticVideoMetadata(plan, recording.records);
        console.log(`Building ${profile}/${name}: ${plan.frames} video frames, ${samples.length} KLV samples`);
        // The render's MP4 is a byproduct and gets pruned in a TS-only set. Its
        // TS carries the SAME H.264 stream — the runner remuxes it with -c:v
        // copy — so fall back to that and the source stays rebuildable.
        const fromMP4 = fs.existsSync(source + ".mp4");
        const videoIn = fromMP4 ? source + ".mp4" : source + ".ts";
        if (!fs.existsSync(videoIn)) throw new Error(`No video to re-encode for ${source}`);
        // +genpts only on the TS path: that stream is muxed with -mpegts_copyts,
        // so its timestamps start at the transport origin rather than zero. An
        // MP4 input keeps the exact original invocation, byte for byte.
        execFileSync("ffmpeg", ["-v", "error", "-y", ...(fromMP4 ? [] : ["-fflags", "+genpts"]),
            "-i", videoIn, "-map", "0:v:0",
            "-c:v", "libx264", "-profile:v", "baseline", "-level:v", "3.1", "-pix_fmt", "yuv420p",
            "-b:v", "5M", "-maxrate", "5M", "-bufsize", "10M", "-g", "120", "-keyint_min", "120",
            "-sc_threshold", "0", "-bf", "0", "-preset", "veryfast", "-threads", "2", "-an",
            "-movflags", "+faststart", destination + ".mp4"]);
        const videoTS = path.join(temp, "video-audio.ts");
        execFileSync("ffmpeg", ["-v", "error", "-y", "-i", destination + ".mp4",
            "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-map", "0:v:0", "-map", "1:a:0",
            "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-t", String(plan.frames / plan.fps),
            "-output_ts_offset", "120", "-mpegts_copyts", "1", "-muxdelay", "0", "-pcr_period", "166",
            "-streamid", "0:256", "-streamid", "1:257", "-f", "mpegts", videoTS]);
        fs.writeFileSync(destination + ".ts", muxVideoKlv(fs.readFileSync(videoTS), recording.records, plan.fps,
            {klvPID: 0x102, metadataSamples: samples, allowAudio: true, sequenceCounter: false, tablePacketPeriod: 40}));
        fs.writeFileSync(destination + ".transport.json", JSON.stringify({
            name, profile, width: plan.width, height: plan.height, fps: plan.fps, frames: plan.frames,
            transportStartSeconds: 120, metadataProfile: "sparse-capture", audio: "silent AAC stereo 48 kHz",
            codecProfile: "H.264 Constrained Baseline", keyframeIntervalFrames: 120,
            utcMeaning: "acquisition time", ptsMeaning: "quantized presentation time with deterministic jitter",
            offscreenEvents: plan.offscreenEvents ?? [],
            zoomEvents: plan.zoomEvents ?? [],
            trackingSimulation: plan.trackingSimulation ?? null,
            trackingTransitions: recording.trackingTransitions ?? [],
            sourceRecording: path.relative(path.dirname(destination), source + ".recording.json"), samples,
        }, null, 2) + "\n");
        console.log(`Wrote ${destination}.ts`);
    };

    if (single) {
        const destination = path.resolve(args.out);
        fs.mkdirSync(path.dirname(destination), {recursive: true});
        buildOne(path.resolve(args.in), destination, "single");
    } else for (const profile of profiles) {
        const folder = path.join(root, profile), out = path.join(root, "realistic", profile);
        fs.mkdirSync(out, {recursive: true});
        for (const file of fs.readdirSync(folder).filter(f => f.endsWith(".recording.json")).sort()) {
            const name = file.replace(/\.recording\.json$/, "");
            if (args.scenario && name !== args.scenario) continue;
            buildOne(path.join(folder, name), path.join(out, name), profile);
        }
    }
} finally {fs.rmSync(temp, {recursive: true, force: true});}
