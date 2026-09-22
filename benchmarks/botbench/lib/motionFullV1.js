// Full duration/error coverage over shared physical timelines, sampled at 1 or 10 Hz.
import fs from "fs";
import path from "path";
import {MOTION_V1_SETS, MOTION_V1_SEED, motionV1Spec, validateMotionV1Scenario} from "./motionV1";
import {MOTION_V1_PLATFORMS} from "./motionV1Platforms";
import {motionV1CoveragePlan, generateMotionV1Truth} from "./motionV1Targets";
import {generateScenario} from "./generateScenario";
import {ROCK_V3, ROCK_V3_ERROR_LEVELS} from "./rockV3";
import {writeInterchange, invalidFrames} from "./exportInterchange";
import {extremeV1ReferencesMarkdown} from "./extremeV1";

export const MOTION_FULL_V1_VERSION = "motion-full-v1.0";
export const MOTION_FULL_V1_DURATIONS = ROCK_V3.durations;
export const MOTION_FULL_V1_ERRORS = ROCK_V3_ERROR_LEVELS;
export const MOTION_FULL_V1_RATES = [1, 10];
const MASTER_SECONDS = Math.max(...MOTION_FULL_V1_DURATIONS);
const SETS = {Extreme_full_v1: "Extreme_v1", Anomalies_full_v1: "Anomalies_v1"};
const batchLabel = duration => `batch_${duration}sec`;

export function motionFullV1Name(set, fps) {
    if (!SETS[set] || !MOTION_FULL_V1_RATES.includes(fps)) throw new Error("motion-full-v1: invalid set or rate");
    return `${set}_${fps}Hz`;
}

export function motionFullV1Basename(set, variant, platform, genericNames = false) {
    const variants = MOTION_V1_SETS[SETS[set]];
    const v = variants?.indexOf(variant), p = MOTION_V1_PLATFORMS.indexOf(platform);
    if (v == null || v < 0 || p < 0) throw new Error("motion-full-v1: unknown target/platform");
    return genericNames
        ? `${set === "Extreme_full_v1" ? "extreme" : "anomaly"}${String(v * MOTION_V1_PLATFORMS.length + p + 1).padStart(3, "0")}`
        : `${variant.kind}__plat-${platform.id}`;
}

export function motionFullV1Spec(set, variant, platform, duration, error, fps) {
    const name = motionFullV1Name(set, fps);
    if (!MOTION_FULL_V1_DURATIONS.includes(duration) || !MOTION_FULL_V1_ERRORS.includes(error)) {
        throw new Error("motion-full-v1: duration/error outside rock_v3 coverage");
    }
    const spec = motionV1Spec(SETS[set], variant, fps, platform);
    const start = (MASTER_SECONDS - duration) / 2;
    const plan = motionV1CoveragePlan(spec.target, spec.durationSeconds, MASTER_SECONDS);
    spec.target.parameters.fullCoverage = {...plan, clipStartSeconds: start, altitudePolicy: "prefer-below-platform"};
    spec.durationSeconds = duration;
    spec.blockId = name;
    spec.epochISO = new Date(Date.parse(ROCK_V3.epochISO) + start * 1000).toISOString();
    const segments = platform.spec.segments;
    const total = segments.reduce((sum, s) => sum + s.fraction, 0);
    // All turns of an S-turn/random program lie inside the shortest crop.
    // Longer crops add straight flight before/after that identical program.
    spec.platform = {...spec.platform, altitudeAGL: 7000, masterDurationSeconds: MASTER_SECONDS,
        timeOffsetSeconds: start, centerSeconds: MASTER_SECONDS / 2,
        segments: ["s-turn", "random"].includes(platform.category)
            ? [{fraction: 140, turnRateDegS: 0},
                ...segments.map(s => ({...s, fraction: 20 * s.fraction / total})),
                {fraction: 140, turnRateDegS: 0}]
            : segments};
    spec.observation = {...error.observation(ROCK_V3.fovFullDeg, fps),
        sharedSeedKey: `${set}|${variant.kind}|${platform.id}|${error.label}`,
        timeOffsetSeconds: start,
        ...(variant.kind === "transmedium" ? {visibility: "opaque-water"} : {})};
    return spec;
}

export function generateMotionFullV1Scenario(set, variant, platform, duration, error, fps, targetTruth) {
    const spec = motionFullV1Spec(set, variant, platform, duration, error, fps);
    const scenario = generateScenario(spec, {scenarioSeed: MOTION_V1_SEED,
        generatorVersion: MOTION_FULL_V1_VERSION, targetTruth});
    validateMotionV1Scenario(scenario, {allowPartialEvents: true});
    if (!scenario.events.length) throw new Error("motion-full-v1: representative crop contains no event");
    return scenario;
}

function cleanMachineInstructions(set, fps, genericNames, sourceSnapshot) {
    const target = set === "Extreme_full_v1" ? "extreme" : "anomalies";
    const name = motionFullV1Name(set, fps);
    const publicationPending = sourceSnapshot && (sourceSnapshot.localChanges || !sourceSnapshot.published);
    const commands = [
        "set -eu",
        'mkdir -p "$HOME/tracksFolder"',
        'cd "$HOME/tracksFolder"',
        "git clone --filter=blob:none https://github.com/MickWest/Sitrec2.git sitrec",
        "cd sitrec",
        ...(sourceSnapshot?.revision && !publicationPending ? [`git checkout --detach ${sourceSnapshot.revision}`] : []),
        "npm ci",
        `npm run build-${target}-full-v1 -- --fps ${fps}${genericNames ? " --generic-names" : ""} --out "$HOME/tracksFolder"`,
    ];
    return "## Build this exact dataset on a clean machine\n\n"
        + "Prerequisites: Git and Node.js 22 with npm, an internet connection, and enough disk space for the source checkout and generated tracks. These commands use a POSIX shell (macOS, Linux, or WSL). No server configuration or frontend build is needed.\n\n"
        + (publicationPending ? "**Publication pending:** the generator changes must be committed and pushed to MickWest/Sitrec2 before these commands work from a fresh clone. After publication, refresh this README to pin the published revision.\n\n" : "Run the following commands in a terminal. Everything needed to generate the dataset is obtained from the repository and npm.\n\n")
        + "```sh\n" + commands.join("\n") + "\n```\n\n"
        + `The generated dataset will be at \`$HOME/tracksFolder/${name}\`. This command builds only the ${fps} Hz version, with ${genericNames ? "numbered" : "descriptive"} filenames, matching this dataset. An existing nonempty output directory is protected; use another \`--out\` location for another run.\n\n`;
}

export function motionFullV1Readme(set, fps, count, genericNames, sourceSnapshot) {
    const extreme = set === "Extreme_full_v1";
    return `# ${motionFullV1Name(set, fps)}\n\n`
        + `${count} scenarios at ${fps} Hz: ${extreme ? 20 : 8} target variants × 10 platform programs × 7 durations × 9 pointing-error levels.\n\n`
        + cleanMachineInstructions(set, fps, genericNames, sourceSnapshot)
        + "## Target maneuvers\n\n| Variant | Motion |\n|---|---|\n"
        + MOTION_V1_SETS[SETS[set]].map(v => `| ${v.kind} | ${v.description} |`).join("\n") + "\n\n## Coverage and interpretation\n\n"
        + "Durations: 20, 40, 60, 120, 180, 240, 300 seconds. Pointing-error amplitudes: 0, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2 degrees. These are rock_v3's operator deadband amplitudes, not Gaussian sigma or measured RMS. The field of view is 3 degrees, widened to four times the error amplitude where needed.\n\n"
        + "Each target/platform pair has one 300-second physical timeline. Shorter clips are centered crops around a representative active maneuver phase, not retimed motion. The 1 Hz coordinates and bearings are exact subsamples of the 10 Hz version. Pointing error runs on a shared 10 Hz timeline and is cropped with the truth. Absolute timestamps match across overlapping windows; relative CSV time starts at zero for each clip. Partial event windows are explicitly marked.\n\n"
        + "Every target has 2 constant-velocity, 3 standard-rate-turn, 1 S-turn, and 4 seeded random straight/turn platforms at every duration. The S-turn and complete random programs occupy the central 20 seconds; longer clips extend their straight approaches/departures. Standard-rate platforms turn continuously at 3 degrees per second. All platforms are at 7000 m above the local ground plane. Propeller drones and anomalies are below the platform. Jet/fast-aircraft paths are translated vertically toward a 3000 m baseline and 6000 m ceiling where their excursion permits, with a 1000 m minimum clearance. Larger vertical excursions can pass above 7000 m. Hypersonic tracks retain their high-altitude profile. Profiles record the actual altitude range and applied translation.\n\n"
        + "Physical speed and acceleration remain unchanged by cropping or translation. Residual vertical velocity after an extreme maneuver is smoothly removed within its g limit to avoid extending a descent through the ground. Descending hypersonic tracks also have a level approach and smooth descent entry before the original motion. Leading/trailing constant motion can dominate long clips. Peaks are evaluated at 1000 Hz; short events can be undersampled at 1 Hz even though the truth profile records their physical peaks.\n\n"
        + "These are prescribed synthetic flat-plane trajectories. Earth curvature, atmosphere, propulsion, heating, terrain occlusion and sensor slew limits are not simulated. In particular, 300-second hypersonic tracks span thousands of kilometres and are not geographically realistic flight simulations. Anomaly trajectories are hypothetical, not evidence of reported events. Underwater truth is retained but transmedium bearings are blank while submerged.\n\n"
        + "Folders follow rock_v3: `batch_<duration>sec/<error>deg/{Input,Truth,All,meta}`. Select the dataset root recursively in BOTBench/Track Browser so the matching sidecars are included. Filenames are "
        + (genericNames ? "generic; manifests and truth sidecars retain the target/platform mapping. This naming option does not blind the dataset."
            : "descriptive; use `--generic-names` when generating to obtain extreme001.csv or anomaly001.csv and following numbers.")
        + "\n\nBuild both rates with `npm run build-" + (extreme ? "extreme" : "anomalies")
        + "-full-v1`. Append `-- --fps 1` or `-- --fps 10` to select one rate, `--generic-names` for numbered filenames, and `--out <directory>` for another output root. Nonempty output folders are protected.\n\n"
        + (extreme ? extremeV1ReferencesMarkdown() : "");
}

function writeDocumentation(dir, manifest, set, sourceSnapshot) {
    if (sourceSnapshot) {
        manifest.source = {repository: "https://github.com/MickWest/Sitrec2.git", ...sourceSnapshot};
    }
    fs.rmSync(path.join(dir, "generator.patch"), {force: true});
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    fs.writeFileSync(path.join(dir, "README.md"), motionFullV1Readme(set, manifest.fps,
        manifest.scenarioCount, manifest.genericNames, sourceSnapshot));
}

export function refreshMotionFullV1Readmes({outRoot, set, rates = MOTION_FULL_V1_RATES, sourceSnapshot}) {
    return rates.map(fps => {
        const name = motionFullV1Name(set, fps), dir = path.join(outRoot, name);
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
        if (manifest.set !== name || manifest.generatorVersion !== MOTION_FULL_V1_VERSION) {
            throw new Error(`motion-full-v1: unexpected dataset manifest: ${dir}`);
        }
        writeDocumentation(dir, manifest, set, sourceSnapshot);
        return {set: name, dir, fps, scenarios: manifest.scenarioCount};
    });
}

export function generateMotionFullV1Sets({outRoot, set, rates = MOTION_FULL_V1_RATES, genericNames = false, sourceSnapshot,
    onProgress = () => {}}) {
    if (!SETS[set] || !rates.length || new Set(rates).size !== rates.length) throw new Error("motion-full-v1: invalid selection");
    const outputs = rates.map(fps => {
        const name = motionFullV1Name(set, fps), dir = path.join(outRoot, name);
        if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error(`motion-full-v1: output already exists: ${dir}`);
        return {fps, name, dir, rows: [], started: Date.now()};
    });
    const variants = MOTION_V1_SETS[SETS[set]];
    for (const [variantIndex, variant] of variants.entries()) {
        for (const output of outputs) {
            const {fps, dir, name, rows} = output;
            for (const duration of MOTION_FULL_V1_DURATIONS) {
                const base = motionFullV1Spec(set, variant, MOTION_V1_PLATFORMS[0], duration, MOTION_FULL_V1_ERRORS[0], fps);
                const targetTruth = generateMotionV1Truth(base.target, {n: duration * fps + 1, fps});
                for (const platform of MOTION_V1_PLATFORMS) {
                    const basename = motionFullV1Basename(set, variant, platform, genericNames);
                    for (const error of MOTION_FULL_V1_ERRORS) {
                        const scenario = generateMotionFullV1Scenario(set, variant, platform, duration, error, fps, targetTruth);
                        const cell = path.join(batchLabel(duration), error.label);
                        const written = writeInterchange(scenario, path.join(dir, cell), {basename, sidecarDir: "meta", plainCsvNames: genericNames,
                            designIntent: `${name}: ${variant.description} Platform: ${platform.description}`});
                        const files = Object.fromEntries(["inputFile", "scenarioFile", "truthFile", "truthJsonFile", "allFile"]
                            .map(key => [key, path.relative(dir, written[key])]));
                        let below = 0;
                        for (let f = 0; f < scenario.n; f++) if (scenario.target.positionENU[f * 3 + 2] < 7000) below++;
                        rows.push({set: name, basename, kind: variant.kind, description: variant.description,
                            platformVariant: platform.id, platformCategory: platform.category, platformAltitudeAGL: 7000,
                            targetBelowPlatformFraction: below / scenario.n, fps, durationSeconds: duration, frames: scenario.n,
                            pointingErrorDeg: error.deg, errorLabel: error.label, fovFullDeg: scenario.spec.observation.fovFullDeg,
                            scenarioId: scenario.scenarioId, scenarioGroupId: scenario.scenarioGroupId,
                            invalidFrames: invalidFrames(scenario), metrics: scenario.target.profile.metrics,
                            crop: scenario.target.profile.fullCoverage, events: scenario.events,
                            files, digests: written.digests});
                    }
                }
            }
        }
        onProgress({set, variant: variant.kind, completed: variantIndex + 1, total: variants.length});
    }
    return outputs.map(({fps, name, dir, rows, started}) => {
        for (const duration of MOTION_FULL_V1_DURATIONS) for (const error of MOTION_FULL_V1_ERRORS) {
            const cellRows = rows.filter(r => r.durationSeconds === duration && r.errorLabel === error.label);
            const cell = path.join(dir, batchLabel(duration), error.label);
            fs.writeFileSync(path.join(cell, "manifest.json"), JSON.stringify(cellRows, null, 2) + "\n");
        }
        const manifest = {set: name, generatorVersion: MOTION_FULL_V1_VERSION, seed: MOTION_V1_SEED, fps,
            durations: MOTION_FULL_V1_DURATIONS, pointingErrorDeg: MOTION_FULL_V1_ERRORS.map(e => e.deg),
            masterDurationSeconds: MASTER_SECONDS, platformAltitudeAGL: 7000, genericNames,
            scenarioCount: rows.length, tracks: rows};
        writeDocumentation(dir, manifest, set, sourceSnapshot);
        fs.writeFileSync(path.join(dir, "timing.json"), JSON.stringify({elapsedSeconds: (Date.now() - started) / 1000}) + "\n");
        return {set: name, dir, fps, scenarios: rows.length};
    });
}
