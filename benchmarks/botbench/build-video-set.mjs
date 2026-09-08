#!/usr/bin/env node
// Build the delivered BotBench video set: render, mux the capture-style
// transport, place one copy of each clip, and write the single manifest.
//
// The set is a FUNCTIONAL TEST CORPUS, not a statistical instrument — the
// botsets are that. So it carries one clip per thing that can break, with a
// fixed reference geometry for every single-purpose axis, rather than a dense
// grid. See docs/BOTBenchScenarios.md.
//
// Two tables, deliberately separate: RENDERS is browser work (slow, ~2.5 min
// each), CLIPS is what ships. A dense and a sparse clip share ONE render, which
// only a split like this can express.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {fileURLToPath} from "node:url";
import {execFileSync} from "node:child_process";
import {parseArgs} from "node:util";

const here = path.dirname(fileURLToPath(import.meta.url));

// Every clip is 30 s / 900 frames at 640x480/30p, matching the existing corpus
// and satisfying the off-screen, tracking and zoom minimums.
const DURATION = ["--duration=30"];
// The operator model used by every wobbling clip. Absolute rates, so the drift
// and recentre speeds do not silently scale with the amplitude.
const OPERATOR = ["--drift-speed=0.1", "--recenter-speed=0.3"];

// parallax: the two geometry cells. `near` is the starter cell (5 km ground
// range, 25% slant depth); `far` doubles the ground range at the same depth, so
// the contrast is single-variable. The third historical cell (5 km / 50%) is
// cut — it varies depth instead, and this set is not a grid.
const GEOMETRIES = [
    {slug: "orbit-level", near: "01-party-neutral-orbit", far: "07-party-neutral-orbit-g10km-f25"},
    {slug: "orbit-rising", near: "02-party-rising-orbit", far: "08-party-rising-orbit-g10km-f25"},
    {slug: "straight-level", near: "03-party-neutral-straight", far: "09-party-neutral-straight-g10km-f25"},
];
const WOBBLES = [{slug: "wobble010", deg: "0.1"}, {slug: "wobble050", deg: "0.5"}];

const RENDERS = [];
for (const parallax of ["near", "far"]) {
    for (const geometry of GEOMETRIES) {
        for (const wobble of WOBBLES) {
            RENDERS.push({
                id: `${geometry.slug}-${parallax}-${wobble.slug}`,
                set: parallax === "near" ? "starter" : "extended",
                scenario: geometry[parallax],
                args: [...DURATION, `--wobble-deg=${wobble.deg}`, ...OPERATOR],
            });
        }
    }
}
// The reference geometry for every single-purpose axis below: level orbit, near
// parallax, 0.5 degrees of wobble — the best-conditioned case, so a one-axis
// test isolates that axis.
const REFERENCE = "orbit-level-near-wobble050";
RENDERS.push(
    // Clean pointing. --wobble (percent) is the historical low-wobble profile:
    // 0.1% of image width, about 0.003 degrees, i.e. effectively none. It takes
    // the model's derived drift/recentre rates, not the absolute ones.
    {id: "orbit-level-near-wobble003", set: "starter", scenario: "01-party-neutral-orbit",
        args: [...DURATION, "--wobble=0.1"]},
    {id: "orbit-level-near-wobble050-loss2", set: "offscreen", scenario: "11-party-neutral-orbit-loss-twice",
        args: [...DURATION, "--wobble-deg=0.5", ...OPERATOR]},
    {id: "orbit-level-near-wobble050-zoom2x", set: "starter", scenario: "01-party-neutral-orbit",
        args: [...DURATION, "--wobble-deg=0.5", ...OPERATOR, "--zoom-factor=2"]},
    // Signal degradation is baked in at render time, so each format costs a full
    // render — never cross this axis. rs170 is the plausible real-sensor case.
    {id: "orbit-level-near-wobble050-rs170", set: "starter", scenario: "01-party-neutral-orbit",
        args: [...DURATION, "--wobble-deg=0.5", ...OPERATOR, "--video-filter=rs170"]},
);
// Six distinct tracker state-machine branches. Each keeps its own geometry.
for (const [id, scenario] of [
    ["mq9-acquire-track-offset", "16-party-neutral-orbit-acquire-track-offset"],
    ["mq9-partial-acquisition", "17-party-rising-orbit-partial-acquisition"],
    ["mq9-coast-recover", "18-party-neutral-straight-coast-recover"],
    ["mq9-loss-ground-hold", "19-party-neutral-orbit-loss-ground-hold"],
    ["mq9-manual-takeover", "20-party-rising-orbit-manual-takeover"],
    ["mq9-gate-escape-retry", "21-party-neutral-straight-gate-escape-retry"],
]) RENDERS.push({id, set: "tracking", scenario, args: [...DURATION]});

// Numbers are allocated ONCE and never reused: deleting a clip leaves a gap
// rather than renumbering everything after it, so a reference to "clip 13"
// stays true. Ordering here is presentation only.
const CLIPS = [
    ...RENDERS.slice(0, 12).map((r, i) => ({n: i + 1, render: r.id, transport: "sparse"})),
    // Same render as the reference clip, muxed dense: isolates the sparse-KLV
    // interpolator from everything geometric.
    {n: 13, render: REFERENCE, transport: "dense"},
    {n: 14, render: "orbit-level-near-wobble003", transport: "sparse"},
    {n: 15, render: "orbit-level-near-wobble050-loss2", transport: "sparse"},
    {n: 16, render: "orbit-level-near-wobble050-zoom2x", transport: "sparse"},
    {n: 17, render: "orbit-level-near-wobble050-rs170", transport: "sparse"},
    ...RENDERS.slice(-6).map((r, i) => ({n: 18 + i, render: r.id, transport: "sparse"})),
];
const clipId = clip => `${String(clip.n).padStart(3, "0")}-${clip.render}-${clip.transport}`;

const {values: args} = parseArgs({options: {
    out: {type: "string"}, url: {type: "string"}, only: {type: "string"},
    'plans-only': {type: "boolean", default: false},
    'skip-render': {type: "boolean", default: false},
}});
const root = path.resolve(args.out || path.join(here, "results", "video"));
const renderDir = path.join(root, "render"), clipDir = path.join(root, "clips");
const wanted = args.only ? new Set(args.only.split(",")) : null;
const renders = RENDERS.filter(r => !wanted || wanted.has(r.id));
const clips = CLIPS.filter(c => !wanted || wanted.has(c.render));
if (wanted && renders.length === 0) throw new Error(`--only matched no render: ${args.only}`);
fs.mkdirSync(renderDir, {recursive: true});
fs.mkdirSync(clipDir, {recursive: true});

const run = (script, extra) => execFileSync("node", [path.join(here, script), ...extra],
    {stdio: "inherit", maxBuffer: 1 << 28});

if (!args['skip-render']) {
    if (!args['plans-only'] && !args.url && !process.env.BOTBENCH_URL) {
        throw new Error("Pass --url=https://local.metabunk.org/sitrec/?action=new or BOTBENCH_URL");
    }
    for (const [i, render] of renders.entries()) {
        console.log(`\n=== render ${i + 1}/${renders.length}: ${render.id}`);
        run("run-botset-video.mjs", [
            `--set=${render.set}`, `--scenario=${render.scenario}`, `--name=${render.id}`,
            ...render.args, `--out=${renderDir}`, "--resume",
            ...(args['plans-only'] ? [] : ["--video", `--url=${args.url ?? process.env.BOTBENCH_URL}`]),
        ]);
    }
}
if (args['plans-only']) {
    console.log(`\n${renders.length} plans in ${renderDir}`);
    process.exit(0);
}

for (const clip of clips) {
    const id = clipId(clip), source = path.join(renderDir, clip.render);
    const target = path.join(clipDir, `${id}.ts`);
    if (clip.transport === "dense") {
        // The runner's own frame-synchronous TS is the deliverable. Copied, not
        // moved, so --resume still sees a complete render.
        if (!fs.existsSync(source + ".ts")) throw new Error(`Missing render for ${id}: ${source}.ts`);
        fs.copyFileSync(source + ".ts", target);
    } else {
        const work = path.join(renderDir, `${id}`);
        run("build-video-transport.mjs", [`--in=${source}`, `--out=${work}`]);
        fs.renameSync(work + ".ts", target);
        // TS-only delivery: the transport's intermediate MP4 has done its job.
        fs.rmSync(work + ".mp4", {force: true});
    }
    console.log(`clip ${id}`);
}

// TS-only delivery: the renders' MP4s were only ever the transport's input, and
// build-video-transport falls back to the render TS, so nothing needs them now.
for (const render of renders) {
    const mp4 = path.join(renderDir, `${render.id}.mp4`);
    if (fs.existsSync(mp4)) { fs.rmSync(mp4); console.log(`pruned ${render.id}.mp4`); }
}

const sha = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const manifest = {
    format: "H.264 MPEG-TS with embedded ST 0601 KLV",
    built: new Date().toISOString().slice(0, 10),
    width: 640, height: 480, fps: 30, framesPerClip: 900, durationSeconds: 30,
    progressive: true, grayscale: true, overlay: "MQ9UI",
    targetDiameterMeters: 1, targetInitialDiameterPixels: 6,
    klv: {sensor: [13, 14, 15, 16, 17, 18, 19, 20], slantRange: 21,
        frameCentre: [23, 24, 25], targetLocation: [40, 41, 42]},
    importInstructions: "Import a TS into a new Sitrec custom sitch. No CSV is required. "
        + "Each builds a camera track, a Center_ ground track and a Target_ object track.",
    clips: clips.map(clip => {
        const id = clipId(clip), file = path.join(clipDir, `${id}.ts`);
        const plan = JSON.parse(fs.readFileSync(path.join(renderDir, `${clip.render}.video.json`)));
        const roundTripFile = path.join(renderDir, `${clip.render}.roundtrip.json`);
        const roundTrip = fs.existsSync(roundTripFile) ? JSON.parse(fs.readFileSync(roundTripFile)) : null;
        return {
            n: clip.n, id, file: path.relative(root, file), transport: clip.transport,
            render: clip.render, sourceScenario: plan.name === clip.render ? undefined : plan.name,
            sourceScenarioId: plan.sourceScenarioId, scenarioSeed: plan.scenarioSeed,
            frames: plan.frames, fps: plan.fps,
            wobbleDegrees: plan.wobbleDegrees ?? null, wobblePercent: plan.wobblePercent ?? null,
            driftSpeed: plan.driftSpeed ?? null, recenterSpeed: plan.recenterSpeed ?? null,
            wobbleSeed: plan.wobbleSeed,
            offscreenEvents: plan.offscreenEvents ?? [], zoomEvents: plan.zoomEvents ?? [],
            videoFilter: plan.videoFilter ?? null,
            trackingSimulation: plan.trackingSimulation ? plan.trackingSimulation.id ?? true : null,
            maxRenderedPointErrorPixels: roundTrip?.maxRenderedPointErrorPixels ?? null,
            maxHUDAlignmentErrorPixels: roundTrip?.maxHUDAlignmentErrorPixels ?? null,
            tsBytes: fs.statSync(file).size, sha256: sha(file),
        };
    }),
};
fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
const bytes = manifest.clips.reduce((n, c) => n + c.tsBytes, 0);
console.log(`\n${manifest.clips.length} clips, ${(bytes / 1e9).toFixed(2)} GB, manifest in ${root}`);
