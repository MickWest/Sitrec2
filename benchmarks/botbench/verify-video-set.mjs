#!/usr/bin/env node
// Validate a built BotBench video set against its manifest.
//
// This exists because the LAST batch's checks lived in one-off probes that were
// deleted the moment they passed, so the next person to touch a clip had no way
// to say whether it was still good. Everything here is committed and runs in one
// command.
//
//   node benchmarks/botbench/verify-video-set.mjs --root=benchmarks/botbench/results/video
//   ... --url=https://local.metabunk.org/sitrec/?action=new   also imports each clip
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";
import {execFileSync} from "node:child_process";
import {parseArgs} from "node:util";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const {values: args} = parseArgs({options: {
    root: {type: "string"}, url: {type: "string"}, only: {type: "string"},
    'skip-klv': {type: "boolean", default: false},
}});
const root = path.resolve(args.root || path.join(here, "results", "video"));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json")));

// Gates. The render-time round trip already measured these; re-asserting them
// here means a stale or hand-edited manifest cannot quietly pass.
const MAX_RENDERED_POINT_ERROR_PIXELS = 0.5;
const MAX_HUD_ALIGNMENT_ERROR_PIXELS = 1e-6;
const REQUIRED_TAGS = [2, 13, 14, 15, 16, 17, 18, 19, 20, 21, 40, 41, 42];

const failures = [];
const fail = (clip, message) => { failures.push(`${clip}: ${message}`); console.log(`  FAIL ${message}`); };
const ffprobe = (file, entries, extra = []) => execFileSync("ffprobe",
    ["-v", "error", "-show_entries", entries, "-of", "json", ...extra, file]).toString();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "verify-video-"));
let parseKLVFile = null;
try {
    if (!args['skip-klv']) {
        const outfile = path.join(tmp, "misb.cjs");
        await require("esbuild").build({
            stdin: {contents: 'export {parseKLVFile} from "./src/MISBUtils";', resolveDir: repo},
            bundle: true, platform: "node", format: "cjs", outfile, logLevel: "silent"});
        ({parseKLVFile} = require(outfile));
    }

    const clips = manifest.clips.filter(c => !args.only || args.only.split(",").includes(c.id));
    if (args.only && clips.length === 0) throw new Error(`--only matched no clip: ${args.only}`);
    for (const clip of clips) {
        console.log(`\n${clip.id}`);
        const file = path.join(root, clip.file);
        if (!fs.existsSync(file)) { fail(clip.id, `missing ${clip.file}`); continue; }

        // Bytes match the manifest.
        const size = fs.statSync(file).size;
        if (size !== clip.tsBytes) fail(clip.id, `size ${size} != manifest ${clip.tsBytes}`);
        const sha = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
        if (sha !== clip.sha256) fail(clip.id, `sha256 ${sha.slice(0, 12)} != manifest ${clip.sha256.slice(0, 12)}`);

        // The video is what the manifest says it is, counting every frame.
        const streams = JSON.parse(ffprobe(file, "stream=index,codec_type,codec_name,width,height,nb_read_frames",
            ["-count_frames", "-select_streams", "v"])).streams;
        const video = streams.find(s => s.codec_type === "video");
        if (!video) fail(clip.id, "no video stream");
        else {
            if (video.codec_name !== "h264") fail(clip.id, `codec ${video.codec_name}`);
            if (video.width !== manifest.width || video.height !== manifest.height) {
                fail(clip.id, `${video.width}x${video.height} != ${manifest.width}x${manifest.height}`);
            }
            const frames = Number(video.nb_read_frames);
            if (frames !== clip.frames) fail(clip.id, `${frames} video frames != ${clip.frames}`);
        }

        // The KLV decodes, and carries the sensor, range and target fields the
        // manifest advertises. A dense clip has one record per video frame; a
        // sparse one is deliberately fewer.
        if (parseKLVFile) {
            const klvFile = path.join(tmp, "meta.klv");
            try {
                execFileSync("ffmpeg", ["-v", "error", "-y", "-i", file, "-map", "0:d:0", "-c", "copy", "-f", "data", klvFile]);
            } catch { fail(clip.id, "no KLV data stream"); continue; }
            const rows = parseKLVFile(fs.readFileSync(klvFile));
            if (rows.length === 0) fail(clip.id, "KLV decoded to nothing");
            if (clip.transport === "dense" && rows.length !== clip.frames) {
                fail(clip.id, `dense KLV has ${rows.length} records, expected ${clip.frames}`);
            }
            if (clip.transport === "sparse" && rows.length >= clip.frames) {
                fail(clip.id, `sparse KLV has ${rows.length} records, not fewer than ${clip.frames}`);
            }
            for (const tag of REQUIRED_TAGS) {
                const present = rows.filter(r => r[tag] !== null && r[tag] !== undefined).length;
                // Frame centre is legitimately absent when the boresight misses
                // the ground, so it is not in REQUIRED_TAGS; these must be total.
                if (present !== rows.length) fail(clip.id, `tag ${tag} present in only ${present}/${rows.length} records`);
            }
            // The target must not sit on the frame centre: one is the object,
            // the other is the ground under the boresight.
            const withCentre = rows.filter(r => r[23] !== null && r[23] !== undefined);
            if (withCentre.length) {
                const worst = Math.min(...withCentre.map(r => Math.abs(r[42] - r[25])));
                if (!(worst > 1)) fail(clip.id, `target and frame centre within ${worst.toFixed(2)} m in height`);
            }
        }

        // Render-time round-trip gates, re-asserted.
        if (clip.maxRenderedPointErrorPixels !== null
            && !(clip.maxRenderedPointErrorPixels <= MAX_RENDERED_POINT_ERROR_PIXELS)) {
            fail(clip.id, `rendered point error ${clip.maxRenderedPointErrorPixels} px`);
        }
        if (clip.maxHUDAlignmentErrorPixels !== null
            && !(clip.maxHUDAlignmentErrorPixels < MAX_HUD_ALIGNMENT_ERROR_PIXELS)) {
            fail(clip.id, `HUD alignment error ${clip.maxHUDAlignmentErrorPixels} px`);
        }
        if (failures.every(f => !f.startsWith(clip.id))) console.log("  ok");
    }

    // No two clips may be the same clip. Three of them deliberately SHARE a
    // camera motion — the signal and zoom variants are single-axis changes to the
    // reference geometry — so "every camera path is unique" is the wrong
    // assertion for this set. What must hold is that each clip differs from every
    // other in at least one axis: pointing, lens, signal, or transport.
    const axisKey = clip => {
        const file = path.join(root, "render", `${clip.render}.recording.json`);
        if (!fs.existsSync(file)) return null;
        const records = JSON.parse(fs.readFileSync(file)).records;
        const hash = crypto.createHash("sha256");
        for (const record of records) {
            hash.update(Buffer.from(Float64Array.from(record.directionECEF).buffer));
            hash.update(String(record.values[17]));   // vertical FOV: the zoom axis
        }
        return [hash.digest("hex"), clip.transport, JSON.stringify(clip.videoFilter ?? null)].join("/");
    };
    const seenAxes = new Map(), seenHashes = new Map();
    for (const clip of manifest.clips) {
        const key = axisKey(clip);
        if (key !== null) {
            if (seenAxes.has(key)) failures.push(`${clip.id} is indistinguishable from ${seenAxes.get(key)}`);
            seenAxes.set(key, clip.id);
        }
        if (seenHashes.has(clip.sha256)) failures.push(`${clip.id} is byte-identical to ${seenHashes.get(clip.sha256)}`);
        seenHashes.set(clip.sha256, clip.id);
    }

    // Clip identities must be unique, and numbers must never be reused.
    const ids = new Set(), numbers = new Set();
    for (const clip of manifest.clips) {
        if (ids.has(clip.id)) failures.push(`duplicate clip id ${clip.id}`);
        if (numbers.has(clip.n)) failures.push(`reused clip number ${clip.n}`);
        ids.add(clip.id); numbers.add(clip.n);
    }
    // Nothing in clips/ that the manifest does not know about.
    for (const name of fs.readdirSync(path.join(root, "clips"))) {
        if (!manifest.clips.some(c => path.basename(c.file) === name)) failures.push(`unlisted file clips/${name}`);
    }

    if (args.url) {
        console.log("\nimporting each clip");
        for (const clip of clips) {
            const out = execFileSync("node", [path.join(repo, "private/probes/ImportTargetTrackCheck.mjs"),
                `--ts=${path.join(root, clip.file)}`, `--url=${args.url}`], {maxBuffer: 1 << 28}).toString();
            const line = out.split("\n").find(l => l.startsWith("RESULT "));
            if (!line) { failures.push(`${clip.id}: import produced no result`); continue; }
            const {switches, tracks} = JSON.parse(line.slice(7));
            const camera = tracks.find(t => t.index === 0);
            const target = tracks.find(t => /^Target_/.test(t.shortName ?? ""));
            const problems = [];
            if (switches.camera !== camera?.shortName) problems.push(`camera switch is ${switches.camera}`);
            if (!target) problems.push("no Target track");
            else if (!target.marker?.visible) problems.push("Target track is not drawn");
            console.log(`  ${clip.id}: ${problems.length ? "FAIL " + problems.join("; ") : "ok"}`);
            for (const p of problems) failures.push(`${clip.id}: ${p}`);
        }
    }
} finally { fs.rmSync(tmp, {recursive: true, force: true}); }

console.log(`\n${manifest.clips.length} clips checked`);
if (failures.length) {
    console.error(`\n${failures.length} FAILURES:`);
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
}
console.log("all checks passed");
