// rock_v3's exact target population on the shared 300-second platform paths.
import fs from "fs";
import path from "path";
import {setSit} from "../../../src/Globals";
import {ROCK_V3, ROCK_V3_ERROR_LEVELS, rockDraws, rockClass, rockBasename, rockSpec} from "./rockV3";
import {MOTION_FULL_V1_PLATFORMS, motionFullV1PlatformsMarkdown} from "./motionFullV1Platforms";
import {validateSingleCoverage, singleErrorLevel, MOTION_SINGLE_V1_DEFAULTS} from "./motionFullV1";
import {generateScenario, SITES} from "./generateScenario";
import {makeWind} from "./wind";
import {generateMundaneV1Truth, MUNDANE_MASTER_SECONDS} from "./mundaneV1Targets";
import {writeInterchange, invalidFrames} from "./exportInterchange";
import {botsetErrorLabel} from "./botsetErrors";

export const MUNDANE_V1_VERSION = "mundane-v1.0";

function selection({rates, single = false, durationSeconds, errorDeg}) {
    rates ??= single ? [MOTION_SINGLE_V1_DEFAULTS.fps] : [1, 10];
    if (!rates.length || rates.some(fps => ![1, 10].includes(fps)) || new Set(rates).size !== rates.length) {
        throw new Error("mundane-v1: select rates 1, 10, or 1,10");
    }
    if (single) {
        if (rates.length !== 1) throw new Error("mundane-v1: select one sample rate for a single set");
        durationSeconds ??= MOTION_SINGLE_V1_DEFAULTS.durationSeconds;
        errorDeg ??= MOTION_SINGLE_V1_DEFAULTS.errorDeg;
        validateSingleCoverage(durationSeconds, errorDeg);
    } else if (durationSeconds !== undefined || errorDeg !== undefined) {
        throw new Error("mundane-v1: --duration and --error require a single-set command or --single");
    }
    return {rates, single, durations: single ? [durationSeconds] : ROCK_V3.durations,
        errors: single ? [singleErrorLevel(errorDeg)] : ROCK_V3_ERROR_LEVELS,
        name: fps => single ? `mundane_single_v1_${durationSeconds}s_${botsetErrorLabel(errorDeg)}_${fps}Hz`
            : `mundane_v1_${fps}Hz`};
}

export function mundaneV1Platform(index) {
    if (!Number.isInteger(index) || index < 1 || index > ROCK_V3.perClass) throw new Error("mundane-v1: invalid track index");
    return MOTION_FULL_V1_PLATFORMS[(index - 1) % MOTION_FULL_V1_PLATFORMS.length];
}

export function mundaneV1Basename(clsKey, index, genericNames = false) {
    mundaneV1Platform(index);
    const cls = rockClass(clsKey);
    return genericNames
        ? `mundane${String(ROCK_V3.classes.indexOf(cls) * ROCK_V3.perClass + index).padStart(3, "0")}`
        : rockBasename(cls, index);
}

export function mundaneV1Spec(clsKey, index, duration, error, fps) {
    validateSingleCoverage(duration, error.deg);
    if (![1, 10].includes(fps)) throw new Error("mundane-v1: invalid sample rate");
    const {spec} = rockSpec(clsKey, index, duration, error, fps);
    const start = (MUNDANE_MASTER_SECONDS - duration) / 2;
    spec.blockId = `mundane_v1_${fps}Hz`;
    spec.epochISO = new Date(Date.parse(ROCK_V3.epochISO) + start * 1000).toISOString();
    spec.target.parameters.mundaneCoverage = {clipStartSeconds: start};
    spec.platform = {...mundaneV1Platform(index).spec, altitudeAGL: 7000,
        masterDurationSeconds: MUNDANE_MASTER_SECONDS, timeOffsetSeconds: start, centerSeconds: 150};
    spec.observation = {...spec.observation, sharedSeedKey: `mundane_v1|${clsKey}|${index}|${error.label}`,
        timeOffsetSeconds: start};
    return spec;
}

export function generateMundaneV1Scenario(clsKey, index, duration, error, fps, targetTruth) {
    const scenario = generateScenario(mundaneV1Spec(clsKey, index, duration, error, fps),
        {scenarioSeed: ROCK_V3.seed, generatorVersion: MUNDANE_V1_VERSION, targetTruth});
    if (!scenario.platform.feasibility.valid || scenario.observation.outOfFrameCount
        || ![scenario.platform.positionENU, scenario.target.positionENU,
            scenario.observation.observedDirectionENU].every(a => a.every(Number.isFinite))) {
        throw new Error(`mundane-v1: invalid geometry or field-of-view loss: ${clsKey}/${index}`);
    }
    return scenario;
}

export function mundaneV1Readme(manifest, sourceSnapshot) {
    const {set: name, fps, genericNames, selection: mode, durations, pointingErrorDeg} = manifest;
    const single = mode === "single";
    const publicationPending = !sourceSnapshot || sourceSnapshot.localChanges || !sourceSnapshot.published;
    const command = `npm run build-mundane-${single ? "single-v1" : "v1"} --`
        + (single ? ` --duration ${durations[0]} --error ${pointingErrorDeg[0]}` : "")
        + ` --fps ${fps}${genericNames ? " --generic-names" : ""} --out "$HOME/tracksFolder"`;
    return `# ${name}\n\n${manifest.scenarioCount} scenarios at ${fps} Hz, drawn from 300 target/platform pairs: 100 ordinary balloons, 100 drones, and 100 weather balloons.\n\n`
        + "## Build this dataset on a clean machine\n\nPrerequisites: Git and Node.js 22 with npm, internet access, and a POSIX shell (macOS, Linux, or WSL). No frontend build, server configuration, existing dataset, README, or patch is needed.\n\n"
        + (publicationPending ? "**Publication pending:** commit and push the generator changes to MickWest/Sitrec2 before using this recipe on a fresh clone. After publication, refresh this README to pin the published revision.\n\n" : "")
        + "```sh\nset -eu\nmkdir -p \"$HOME/tracksFolder\"\ncd \"$HOME/tracksFolder\"\ngit clone --filter=blob:none https://github.com/MickWest/Sitrec2.git sitrec\ncd sitrec\n"
        + (!publicationPending ? `git checkout --detach ${sourceSnapshot.revision}\n` : "")
        + "npm ci\n" + command + "\n```\n\nOutput: `$HOME/tracksFolder/" + name + "`. Nonempty output folders are protected.\n\n"
        + "## Target population\n\nThe exact 300 target definitions, dimensions, wind fields, and horizontal-range draws come from rock_v3 (seed 805). Each target is paired with one platform program; targets are not multiplied by ten. Index 1–100 cycles through the ten shared platform programs, giving each class 20 straight controls and 80 curved paths. The same index in all three classes shares its platform program.\n\n"
        + "| Class | Count | Motion |\n|---|---:|---|\n| Ordinary balloon | 100 | Wind drift, ascent or descent; vertical rates drawn from −1.5 to 3.5 m/s, wind from 0 to 15 m/s. |\n| Drone | 100 | Ground-referenced circles, racetracks, and rounded squares at 15–30 m/s and 80–1200 m altitude. |\n| Weather balloon | 100 | Ascent at 4.2–6.0 m/s from 300–26000 m, with wind shear and directional veer. |\n\n"
        + "All platforms are at 7000 m above the local ground plane and travel at 70 m/s. Ordinary balloons and drones stay below the platform. Weather balloons retain rock_v3's altitude distribution and may be above it. Wind moves balloon targets; drone paths and platform paths are ground-referenced.\n\n"
        + motionFullV1PlatformsMarkdown({population: true})
        + "## Coverage and files\n\n"
        + `Durations: ${durations.join(", ")} seconds. Pointing-error amplitudes: ${pointingErrorDeg.join(", ")} degrees. `
        + "Errors are operator deadband amplitudes, not Gaussian sigma or measured RMS. Field of view is 3 degrees, widened to four times the error amplitude when needed.\n\n"
        + "Each target is integrated once on the original 300-second, 10 Hz rock_v3 timeline. Shorter clips are centered crops, and 1 Hz samples select every tenth master sample. Platform positions and pointing error use the same crop. There is no retiming or restarting of the target at a crop boundary. Absolute timestamps agree across overlaps; relative CSV time restarts at zero. Single and full selections with matching settings and filenames have identical CSVs and sidecars.\n\n"
        + "Folders: `batch_<duration>sec/<error>deg/{Input,Truth,All,meta}`, plus cell/root manifests and this generated README. Select the root recursively in BOTBench or Track Browser. These are synthetic trajectories over a flat ground plane; terrain and sensor slew limits are not simulated.\n\n"
        + (genericNames ? "Filenames are mundane001.csv through mundane300.csv: 001–100 ordinary balloons, 101–200 drones, 201–300 weather balloons. Manifests retain the original rock_v3 identities.\n\n"
            : "Filenames use rock_v3 identities: balloon_001 through balloon_100, drone_001 through drone_100, and weather_balloon_001 through weather_balloon_100, with .input.csv, .truth.csv, and .all.csv role suffixes.\n\n")
        + "The full command `build-mundane-v1` defaults to both 1 and 10 Hz and all seven durations × nine error levels (18,900 scenarios per rate). `build-mundane-single-v1` defaults to `--duration 120 --error 0.01 --fps 10` (300 scenarios). Single durations must be whole seconds from 20 to 300; errors may be any amplitude from 0 to 2 degrees. Both commands accept `--generic-names`, `--out DIRECTORY`, and `--readme-only`.\n";
}

function writeDocumentation(dir, manifest, sourceSnapshot) {
    if (sourceSnapshot) manifest.source = {repository: "https://github.com/MickWest/Sitrec2.git", ...sourceSnapshot};
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    fs.writeFileSync(path.join(dir, "README.md"), mundaneV1Readme(manifest, sourceSnapshot));
}

export function refreshMundaneV1Readmes({outRoot, sourceSnapshot, ...options}) {
    const {rates, name: outputName, single} = selection(options);
    return rates.map(fps => {
        const name = outputName(fps), dir = path.join(outRoot, name);
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
        if (manifest.set !== name || manifest.generatorVersion !== MUNDANE_V1_VERSION
            || (manifest.selection === "single") !== single) throw new Error(`mundane-v1: unexpected manifest: ${dir}`);
        writeDocumentation(dir, manifest, sourceSnapshot);
        return {set: name, dir, fps, scenarios: manifest.scenarioCount};
    });
}

export function generateMundaneV1Sets({outRoot, genericNames = false, sourceSnapshot, onProgress = () => {}, ...options}) {
    const {rates, durations, errors, single, name: outputName} = selection(options);
    const outputs = rates.map(fps => {
        const name = outputName(fps), dir = path.join(outRoot, name);
        if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error(`mundane-v1: output already exists: ${dir}`);
        return {fps, name, dir, rows: [], started: Date.now()};
    });
    // Match the rock_v3 worker's context for the shared balloon integrator.
    setSit({name: "mundane-v1", frames: 10000, fps: 10, simSpeed: 1, lat: 40, lon: -105});
    let completed = 0;
    for (const cls of ROCK_V3.classes) for (let index = 1; index <= ROCK_V3.perClass; index++) {
        const draws = rockDraws(cls.key, index), platform = mundaneV1Platform(index);
        const basename = mundaneV1Basename(cls.key, index, genericNames), sourceBasename = rockBasename(cls, index);
        const masterSpec = mundaneV1Spec(cls.key, index, 300, errors[0], 10), site = SITES[masterSpec.siteId];
        const truthOptions = {site, seed: 0, windSeed: 0,
            wind: makeWind(masterSpec.wind, draws.target.parameters.startAGL + site.groundElevationMSL)};
        const master = generateMundaneV1Truth(masterSpec.target, {...truthOptions, n: 3001, fps: 10});
        for (const {fps, name, dir, rows} of outputs) for (const duration of durations) {
            const spec = mundaneV1Spec(cls.key, index, duration, errors[0], fps);
            const truth = generateMundaneV1Truth(spec.target, {...truthOptions, n: duration * fps + 1, fps}, master);
            for (const error of errors) {
                const scenario = generateMundaneV1Scenario(cls.key, index, duration, error, fps, truth);
                const cell = path.join(`batch_${duration}sec`, error.label);
                const written = writeInterchange(scenario, path.join(dir, cell), {basename, sidecarDir: "meta",
                    plainCsvNames: genericNames, designIntent: `mundane_v1_${fps}Hz: rock_v3 target ${sourceBasename}. Platform: ${platform.description}`});
                const files = Object.fromEntries(["inputFile", "scenarioFile", "truthFile", "truthJsonFile", "allFile"]
                    .map(key => [key, path.relative(dir, written[key])]));
                let below = 0;
                for (let f = 0; f < scenario.n; f++) if (scenario.target.positionENU[f * 3 + 2] < 7000) below++;
                rows.push({set: name, basename, sourceBasename, class: cls.key, index, kind: draws.target.kind,
                    platformVariant: platform.id, platformCategory: platform.category, platformAltitudeAGL: 7000,
                    targetBelowPlatformFraction: below / scenario.n, fps, durationSeconds: duration, frames: scenario.n,
                    pointingErrorDeg: error.deg, errorLabel: error.label, fovFullDeg: scenario.spec.observation.fovFullDeg,
                    scenarioId: scenario.scenarioId, scenarioGroupId: scenario.scenarioGroupId,
                    invalidFrames: invalidFrames(scenario), crop: truth.target.profile.mundaneCoverage,
                    files, digests: written.digests});
            }
        }
        completed++;
        if (completed % 10 === 0) onProgress({set: "mundane_v1", variant: sourceBasename, completed, total: 300});
    }
    return outputs.map(({fps, name, dir, rows, started}) => {
        for (const duration of durations) for (const error of errors) {
            const cellRows = rows.filter(r => r.durationSeconds === duration && r.errorLabel === error.label);
            fs.writeFileSync(path.join(dir, `batch_${duration}sec`, error.label, "manifest.json"), JSON.stringify(cellRows, null, 2) + "\n");
        }
        const manifest = {set: name, generatorVersion: MUNDANE_V1_VERSION, seed: ROCK_V3.seed, fps,
            ...(single ? {selection: "single"} : {}), durations, pointingErrorDeg: errors.map(e => e.deg),
            populationSource: "rock_v3", targetsPerClass: 100, platformAssignment: "(index - 1) modulo 10",
            masterDurationSeconds: 300, masterFps: 10, platformAltitudeAGL: 7000, genericNames,
            scenarioCount: rows.length, tracks: rows};
        writeDocumentation(dir, manifest, sourceSnapshot);
        fs.writeFileSync(path.join(dir, "timing.json"), JSON.stringify({elapsedSeconds: (Date.now() - started) / 1000}) + "\n");
        return {set: name, dir, fps, scenarios: rows.length};
    });
}
