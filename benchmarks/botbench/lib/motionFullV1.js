// Full duration/error coverage over shared physical timelines, sampled at 1 or 10 Hz.
import fs from "fs";
import path from "path";
import {MOTION_V1_SETS, MOTION_V1_SEED, motionV1Spec, validateMotionV1Scenario} from "./motionV1";
import {motionV1CoveragePlan, generateMotionV1Truth} from "./motionV1Targets";
import {generateScenario} from "./generateScenario";
import {ROCK_V3, ROCK_V3_ERROR_LEVELS} from "./rockV3";
import {writeInterchange, invalidFrames} from "./exportInterchange";
import {extremeV1ReferencesMarkdown} from "./extremeV1";
import {botsetErrorLabel, botsetFovForRung, botsetWobbleParams} from "./botsetErrors";
import {MOTION_FULL_V1_PLATFORMS, motionFullV1PlatformsMarkdown} from "./motionFullV1Platforms";

export const MOTION_FULL_V1_VERSION = "motion-full-v1.1";
export const MOTION_FULL_V1_DURATIONS = ROCK_V3.durations;
export const MOTION_FULL_V1_ERRORS = ROCK_V3_ERROR_LEVELS;
export const MOTION_FULL_V1_RATES = [1, 10];
export const MOTION_SINGLE_V1_DEFAULTS = {durationSeconds: 120, errorDeg: 0.01, fps: 10};
const MASTER_SECONDS = Math.max(...MOTION_FULL_V1_DURATIONS);
const SETS = {Extreme_full_v1: "Extreme_v1", Anomalies_full_v1: "Anomalies_v1"};
const batchLabel = duration => `batch_${duration}sec`;

export function motionFullV1Name(set, fps) {
    if (!SETS[set] || !MOTION_FULL_V1_RATES.includes(fps)) throw new Error("motion-full-v1: invalid set or rate");
    return `${set}_${fps}Hz`;
}

export function validateSingleCoverage(durationSeconds, errorDeg) {
    if (!Number.isInteger(durationSeconds) || durationSeconds < 20 || durationSeconds > MASTER_SECONDS) {
        throw new Error("motion-single-v1: duration must be a whole number from 20 to 300 seconds");
    }
    if (!Number.isFinite(errorDeg) || errorDeg < 0 || errorDeg > 2) {
        throw new Error("motion-single-v1: error must be from 0 to 2 degrees");
    }
}

export function motionSingleV1Name(set, fps, durationSeconds = MOTION_SINGLE_V1_DEFAULTS.durationSeconds,
    errorDeg = MOTION_SINGLE_V1_DEFAULTS.errorDeg) {
    motionFullV1Name(set, fps);
    validateSingleCoverage(durationSeconds, errorDeg);
    return `${set.replace("_full_", "_single_")}_${durationSeconds}s_${botsetErrorLabel(errorDeg)}_${fps}Hz`;
}

export function singleErrorLevel(deg) {
    return MOTION_FULL_V1_ERRORS.find(e => e.deg === deg) ?? {
        deg, label: botsetErrorLabel(deg),
        observation: (fov, fps) => ({kind: "wobble", fovFullDeg: botsetFovForRung(fov, deg),
            wobble: botsetWobbleParams(deg), ...(fps < 10 ? {wobbleFps: 10} : {})}),
    };
}

function coverageSelection({set, rates, single = false, durationSeconds, errorDeg}) {
    rates ??= single ? [MOTION_SINGLE_V1_DEFAULTS.fps] : MOTION_FULL_V1_RATES;
    if (!SETS[set] || !rates.length || new Set(rates).size !== rates.length) {
        throw new Error("motion-full-v1: invalid selection");
    }
    if (single) {
        if (rates.length !== 1) throw new Error("motion-single-v1: select one sample rate, 1 or 10 Hz");
        durationSeconds ??= MOTION_SINGLE_V1_DEFAULTS.durationSeconds;
        errorDeg ??= MOTION_SINGLE_V1_DEFAULTS.errorDeg;
        validateSingleCoverage(durationSeconds, errorDeg);
    } else if (durationSeconds !== undefined || errorDeg !== undefined) {
        throw new Error("motion-full-v1: --duration and --error require a single-set command or --single");
    }
    return {rates, single, durations: single ? [durationSeconds] : MOTION_FULL_V1_DURATIONS,
        errors: single ? [singleErrorLevel(errorDeg)] : MOTION_FULL_V1_ERRORS,
        name: fps => single ? motionSingleV1Name(set, fps, durationSeconds, errorDeg) : motionFullV1Name(set, fps)};
}

export function motionFullV1Basename(set, variant, platform, genericNames = false) {
    const variants = MOTION_V1_SETS[SETS[set]];
    const platforms = MOTION_FULL_V1_PLATFORMS;
    const v = variants?.indexOf(variant), p = platforms.indexOf(platform);
    if (v == null || v < 0 || p < 0) throw new Error("motion-full-v1: unknown target/platform");
    return genericNames
        ? `${set === "Extreme_full_v1" ? "extreme" : "anomaly"}${String(v * platforms.length + p + 1).padStart(3, "0")}`
        : `${variant.kind}__plat-${platform.id}`;
}

export function motionFullV1Spec(set, variant, platform, duration, error, fps) {
    const name = motionFullV1Name(set, fps);
    validateSingleCoverage(duration, error.deg);
    if (!MOTION_FULL_V1_PLATFORMS.includes(platform)) {
        throw new Error("motion-full-v1: unknown platform variant");
    }
    const spec = motionV1Spec(SETS[set], variant, fps);
    const start = (MASTER_SECONDS - duration) / 2;
    const plan = motionV1CoveragePlan(spec.target, spec.durationSeconds, MASTER_SECONDS);
    spec.target.parameters.fullCoverage = {...plan, clipStartSeconds: start, altitudePolicy: "prefer-below-platform"};
    spec.durationSeconds = duration;
    spec.blockId = name;
    spec.epochISO = new Date(Date.parse(ROCK_V3.epochISO) + start * 1000).toISOString();
    // Every platform already defines the complete 300-second path. Only the
    // crop offset changes; longer clips reveal more of the same turns.
    spec.platform = {...platform.spec, altitudeAGL: 7000, masterDurationSeconds: MASTER_SECONDS,
        timeOffsetSeconds: start, centerSeconds: MASTER_SECONDS / 2};
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

function cleanMachineInstructions(set, fps, genericNames, sourceSnapshot, single) {
    const target = set === "Extreme_full_v1" ? "extreme" : "anomalies";
    const name = single ? motionSingleV1Name(set, fps, single.durationSeconds, single.errorDeg) : motionFullV1Name(set, fps);
    const selectionArgs = single ? ` --duration ${single.durationSeconds} --error ${single.errorDeg}` : "";
    const publicationPending = sourceSnapshot && (sourceSnapshot.localChanges || !sourceSnapshot.published);
    const commands = [
        "set -eu",
        'mkdir -p "$HOME/tracksFolder"',
        'cd "$HOME/tracksFolder"',
        "git clone --filter=blob:none https://github.com/MickWest/Sitrec2.git sitrec",
        "cd sitrec",
        ...(sourceSnapshot?.revision && !publicationPending ? [`git checkout --detach ${sourceSnapshot.revision}`] : []),
        "npm ci",
        `npm run build-${target}-${single ? "single" : "full"}-v1 --${selectionArgs} --fps ${fps}${genericNames ? " --generic-names" : ""} --out "$HOME/tracksFolder"`,
    ];
    return "## Build this exact dataset on a clean machine\n\n"
        + "Prerequisites: Git and Node.js 22 with npm, an internet connection, and enough disk space for the source checkout and generated tracks. These commands use a POSIX shell (macOS, Linux, or WSL). No server configuration or frontend build is needed.\n\n"
        + (publicationPending ? "**Publication pending:** the generator changes must be committed and pushed to MickWest/Sitrec2 before these commands work from a fresh clone. After publication, refresh this README to pin the published revision.\n\n" : "Run the following commands in a terminal. Everything needed to generate the dataset is obtained from the repository and npm.\n\n")
        + "```sh\n" + commands.join("\n") + "\n```\n\n"
        + `The generated dataset will be at \`$HOME/tracksFolder/${name}\`. This command builds only the ${fps} Hz version, with ${genericNames ? "numbered" : "descriptive"} filenames, matching this dataset. An existing nonempty output directory is protected; use another \`--out\` location for another run.\n\n`;
}

export function motionFullV1Readme(set, fps, count, genericNames, sourceSnapshot, single) {
    const extreme = set === "Extreme_full_v1";
    const name = single ? motionSingleV1Name(set, fps, single.durationSeconds, single.errorDeg) : motionFullV1Name(set, fps);
    return `# ${name}\n\n`
        + `${count} scenarios at ${fps} Hz: ${extreme ? 20 : 8} target variants × 10 platform programs × ${single ? "1 duration × 1 pointing-error level" : "7 durations × 9 pointing-error levels"}.\n\n`
        + cleanMachineInstructions(set, fps, genericNames, sourceSnapshot, single)
        + "## Target maneuvers\n\n| Variant | Motion |\n|---|---|\n"
        + MOTION_V1_SETS[SETS[set]].map(v => `| ${v.kind} | ${v.description} |`).join("\n") + "\n\n"
        + motionFullV1PlatformsMarkdown()
        + "## Coverage and interpretation\n\n"
        + (single ? `Duration: ${single.durationSeconds} seconds. Pointing-error amplitude: ${single.errorDeg} degrees. `
            + "This selection uses the same master tracks and observation model as the full sets; matching settings and filename style produce identical CSVs and sidecars. "
            : "Durations: 20, 40, 60, 120, 180, 240, 300 seconds. Pointing-error amplitudes: 0, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2 degrees. ")
        + "These are rock_v3's operator deadband amplitudes, not Gaussian sigma or measured RMS. The field of view is 3 degrees, widened to four times the error amplitude where needed.\n\n"
        + "Each target/platform pair has one 300-second physical timeline. Shorter clips are centered crops around a representative active maneuver phase, not retimed motion. The 1 Hz coordinates and bearings are exact subsamples of the 10 Hz version. Pointing error runs on a shared 10 Hz timeline and is cropped with the truth. Absolute timestamps match across overlapping windows; relative CSV time starts at zero for each clip. Partial event windows are explicitly marked.\n\n"
        + "Every target has two straight controls and eight curved platform variants, shared by the Extreme and Anomalies full and single sets. "
        + "All platforms are at 7000 m above the local ground plane. Propeller drones and anomalies are below the platform. Jet/fast-aircraft paths are translated vertically toward a 3000 m baseline and 6000 m ceiling where their excursion permits, with a 1000 m minimum clearance. Larger vertical excursions can pass above 7000 m. Hypersonic tracks retain their high-altitude profile. Profiles record the actual altitude range and applied translation.\n\n"
        + "Physical speed and acceleration remain unchanged by cropping or translation. Residual vertical velocity after an extreme maneuver is smoothly removed within its g limit to avoid extending a descent through the ground. Descending hypersonic tracks also have a level approach and smooth descent entry before the original motion. Leading/trailing constant motion can dominate long clips. Peaks are evaluated at 1000 Hz; short events can be undersampled at 1 Hz even though the truth profile records their physical peaks.\n\n"
        + "These are prescribed synthetic flat-plane trajectories. Earth curvature, atmosphere, propulsion, heating, terrain occlusion and sensor slew limits are not simulated. In particular, 300-second hypersonic tracks span thousands of kilometres and are not geographically realistic flight simulations. Anomaly trajectories are hypothetical, not evidence of reported events. Underwater truth is retained but transmedium bearings are blank while submerged.\n\n"
        + "Folders follow rock_v3: `batch_<duration>sec/<error>deg/{Input,Truth,All,meta}`. Select the dataset root recursively in BOTBench/Track Browser so the matching sidecars are included. Filenames are "
        + (genericNames ? "generic; manifests and truth sidecars retain the target/platform mapping. This naming option does not blind the dataset."
            : "descriptive; use `--generic-names` when generating to obtain extreme001.csv or anomaly001.csv and following numbers.")
        + (single ? "\n\nUse `--duration` for a whole number of seconds from 20 to 300, `--error` for an amplitude from 0 to 2 degrees, and `--fps 1` or `--fps 10` for one sample rate. Defaults are 120 seconds, 0.01 degrees, and 10 Hz. Add `--generic-names` for numbered filenames and `--out <directory>` for another output root. Nonempty output folders are protected.\n\n"
            : "\n\nBuild both rates with `npm run build-" + (extreme ? "extreme" : "anomalies")
                + "-full-v1`. Append `-- --fps 1` or `-- --fps 10` to select one rate, `--generic-names` for numbered filenames, and `--out <directory>` for another output root. Nonempty output folders are protected.\n\n")
        + (extreme ? extremeV1ReferencesMarkdown() : "");
}

function writeDocumentation(dir, manifest, set, sourceSnapshot) {
    if (sourceSnapshot) {
        manifest.source = {repository: "https://github.com/MickWest/Sitrec2.git", ...sourceSnapshot};
    }
    fs.rmSync(path.join(dir, "generator.patch"), {force: true});
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    fs.writeFileSync(path.join(dir, "README.md"), motionFullV1Readme(set, manifest.fps,
        manifest.scenarioCount, manifest.genericNames, sourceSnapshot,
        manifest.selection === "single" ? {durationSeconds: manifest.durations[0], errorDeg: manifest.pointingErrorDeg[0]} : undefined));
}

export function refreshMotionFullV1Readmes({outRoot, set, sourceSnapshot, ...options}) {
    const {rates, name: outputName, single} = coverageSelection({set, ...options});
    return rates.map(fps => {
        const name = outputName(fps), dir = path.join(outRoot, name);
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
        if (manifest.set !== name || manifest.generatorVersion !== MOTION_FULL_V1_VERSION
            || (manifest.selection === "single") !== single) {
            throw new Error(`motion-full-v1: unexpected dataset manifest: ${dir}`);
        }
        writeDocumentation(dir, manifest, set, sourceSnapshot);
        return {set: name, dir, fps, scenarios: manifest.scenarioCount};
    });
}

export function generateMotionFullV1Sets({outRoot, set, genericNames = false, sourceSnapshot,
    onProgress = () => {}, ...options}) {
    const {rates, durations, errors, single, name: outputName} = coverageSelection({set, ...options});
    const platformVariants = MOTION_FULL_V1_PLATFORMS;
    const outputs = rates.map(fps => {
        const name = outputName(fps), dir = path.join(outRoot, name);
        if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error(`motion-full-v1: output already exists: ${dir}`);
        return {fps, name, dir, rows: [], started: Date.now()};
    });
    const variants = MOTION_V1_SETS[SETS[set]];
    for (const [variantIndex, variant] of variants.entries()) {
        for (const output of outputs) {
            const {fps, dir, name, rows} = output;
            for (const duration of durations) {
                const base = motionFullV1Spec(set, variant, platformVariants[0], duration, errors[0], fps);
                const targetTruth = generateMotionV1Truth(base.target, {n: duration * fps + 1, fps});
                for (const platform of platformVariants) {
                    const basename = motionFullV1Basename(set, variant, platform, genericNames);
                    for (const error of errors) {
                        const scenario = generateMotionFullV1Scenario(set, variant, platform, duration, error, fps, targetTruth);
                        const cell = path.join(batchLabel(duration), error.label);
                        const written = writeInterchange(scenario, path.join(dir, cell), {basename, sidecarDir: "meta", plainCsvNames: genericNames,
                            designIntent: `${motionFullV1Name(set, fps)}: ${variant.description} Platform: ${platform.description}`});
                        const files = Object.fromEntries(["inputFile", "scenarioFile", "truthFile", "truthJsonFile", "allFile"]
                            .map(key => [key, path.relative(dir, written[key])]));
                        let below = 0;
                        for (let f = 0; f < scenario.n; f++) if (scenario.target.positionENU[f * 3 + 2] < 7000) below++;
                        rows.push({set: name, basename, kind: variant.kind, description: variant.description,
                            platformVariant: platform.id, platformCategory: platform.category, platformAltitudeAGL: 7000,
                            ...(platform.turnAnglesDeg ? {platformTurnAnglesDeg: platform.turnAnglesDeg, platformTurnRatesDegS: platform.turnRatesDegS} : {}),
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
        for (const duration of durations) for (const error of errors) {
            const cellRows = rows.filter(r => r.durationSeconds === duration && r.errorLabel === error.label);
            const cell = path.join(dir, batchLabel(duration), error.label);
            fs.writeFileSync(path.join(cell, "manifest.json"), JSON.stringify(cellRows, null, 2) + "\n");
        }
        const manifest = {set: name, generatorVersion: MOTION_FULL_V1_VERSION, seed: MOTION_V1_SEED, fps,
            ...(single ? {selection: "single"} : {}),
            durations, pointingErrorDeg: errors.map(e => e.deg),
            masterDurationSeconds: MASTER_SECONDS, platformAltitudeAGL: 7000, genericNames,
            scenarioCount: rows.length, tracks: rows};
        writeDocumentation(dir, manifest, set, sourceSnapshot);
        fs.writeFileSync(path.join(dir, "timing.json"), JSON.stringify({elapsedSeconds: (Date.now() - started) / 1000}) + "\n");
        return {set: name, dir, fps, scenarios: rows.length};
    });
}
