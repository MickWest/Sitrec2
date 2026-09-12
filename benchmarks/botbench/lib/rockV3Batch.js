// rockV3Batch.js — generate ONE rock_v3 batch folder (a clip length x rung
// cell): all 300 tracks, integrity checks, interchange files and the folder
// manifest. Mirrors the botset batch writers so the sets stay legible side by
// side: the checks live here as throws, generation is deterministic for a
// given (spec, seed), and the sequential bench and the parallel driver
// produce byte-identical files.

import fs from "fs";
import path from "path";
import {generateScenario} from "./generateScenario";
import {writeInterchange} from "./exportInterchange";
import {SENSOR_PIXELS} from "./angularSize";
import {racetrackState, racetrackTurnFraction} from "./platforms";
import {
    ROCK_V3, ROCK_V3_ERROR_LEVELS, rockBatchLabel, rockBasename, rockSpec, rockDefinitionHash,
} from "./rockV3";

export const FILES_PER_SCENARIO = 5;
export const SIDECAR_DIR = "meta";

const DEG = 180 / Math.PI;
const round5 = (x) => Math.round(x * 1e5) / 1e5;
const at = (a, f) => [a[f * 3], a[f * 3 + 1], a[f * 3 + 2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (v) => Math.hypot(v[0], v[1], v[2]);

function angleBetween(u, v) {
    const lu = norm(u), lv = norm(v);
    if (!(lu > 0) || !(lv > 0)) return 0;
    const c = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (lu * lv);
    return Math.acos(Math.max(-1, Math.min(1, c))) * DEG;
}

/**
 * Generate one batch folder. Throws on any integrity violation.
 *
 * @param durationSeconds  one of ROCK_V3.durations
 * @param errorLabel       a ROCK_V3_ERROR_LEVELS label ("0.0deg" ... "2.0deg")
 * @param outRoot          the results root that holds rock_v3/
 * @returns {batch, dir, scenarios, files, ms}
 */
export function generateRockV3Batch({durationSeconds, errorLabel, outRoot}) {
    const err = ROCK_V3_ERROR_LEVELS.find((e) => e.label === errorLabel);
    if (!err) throw new Error(`rockV3Batch: unknown error level "${errorLabel}"`);
    if (!ROCK_V3.durations.includes(durationSeconds)) {
        throw new Error(`rockV3Batch: ${durationSeconds} s is not a rock_v3 clip length`);
    }
    const dir = path.join(outRoot, ROCK_V3.dirName, rockBatchLabel(durationSeconds), err.label);

    const t0 = Date.now();
    const manifest = [];
    const names = new Set();
    const definitionHash = rockDefinitionHash();

    for (const cls of ROCK_V3.classes) {
        for (let index = 1; index <= ROCK_V3.perClass; index++) {
            const basename = rockBasename(cls, index);
            const where = `${basename} ${durationSeconds}s ${err.label}`;
            const {spec, draws} = rockSpec(cls.key, index, durationSeconds, err);
            const scenario = generateScenario(spec, {scenarioSeed: ROCK_V3.seed});

            // Nothing in this set is anomalous and nothing injects an event.
            if (scenario.events.length || scenario.target.profile?.anomalous) {
                throw new Error(`rockV3Batch: ${where} carries an event or an anomalous flag`);
            }
            // The ladder promises the target stays in frame at every rung; a
            // masked frame would measure lost targets, not pointing error.
            if (scenario.observation.outOfFrameCount) {
                throw new Error(`rockV3Batch: ${where} has ${scenario.observation.outOfFrameCount} out-of-frame frame(s)`);
            }
            // The range convention: the target's frame-0 ground point is the
            // origin, so initialHorizontalRangeM means what it says.
            const t0p = at(scenario.target.positionENU, 0);
            if (Math.hypot(t0p[0], t0p[1]) > 1e-6) {
                throw new Error(`rockV3Batch: ${where} target does not start at the origin`);
            }
            const s0 = at(scenario.platform.positionENU, 0);
            if (Math.abs(s0[0]) > 1e-6 || Math.abs(s0[1] + spec.initialHorizontalRangeM) > 1e-6) {
                throw new Error(`rockV3Batch: ${where} platform does not start at [0, -R]`);
            }
            if (names.has(basename)) throw new Error(`rockV3Batch: duplicate basename ${basename}`);
            names.add(basename);

            const out = writeInterchange(scenario, dir, {
                basename,
                designIntent: `${ROCK_V3.name}-${cls.key}-${draws.info.pattern ?? draws.target.kind}`,
                sidecarDir: SIDECAR_DIR,
            });

            // Geometry a reader will want without recomputing it: slant range
            // at frame 0 and its mean, the depression angle at frame 0, the
            // parallax aperture (the angle the sensor sweeps as seen from the
            // mid-clip target), and how much of the clip the platform spent
            // turning.
            const n = scenario.n;
            const los0 = sub(t0p, s0);
            const slant0 = norm(los0);
            let sumRange = 0;
            for (let f = 0; f < n; f++) {
                sumRange += norm(sub(at(scenario.target.positionENU, f), at(scenario.platform.positionENU, f)));
            }
            const mid = at(scenario.target.positionENU, Math.floor(n / 2));
            const apertureDeg = angleBetween(
                sub(at(scenario.platform.positionENU, 0), mid),
                sub(at(scenario.platform.positionENU, n - 1), mid));
            const fov = spec.observation.fovFullDeg;
            const thetaDeg = (draws.target.diameterM / slant0) * DEG;
            const startState = racetrackState(spec.platform, spec.platform.phaseSeconds);
            const endState = racetrackState(spec.platform, spec.platform.phaseSeconds + durationSeconds);

            manifest.push({
                basename, class: cls.key, index, scenarioId: scenario.scenarioId,
                definitionHash,
                durationSeconds, frames: n, errorLevel: err.label, errorDeg: err.deg,
                rangeM: spec.initialHorizontalRangeM,
                trueRangeStartM: Math.round(slant0),
                trueRangeMeanM: Math.round(sumRange / n),
                depressionDeg: Math.round(Math.atan2(-los0[2], Math.hypot(los0[0], los0[1])) * DEG * 10) / 10,
                apertureDeg: Math.round(apertureDeg * 10) / 10,
                platform: {...spec.platform, ...draws.platformInfo,
                    segmentAtStart: startState.segment, segmentAtEnd: endState.segment,
                    turnFraction: Math.round(racetrackTurnFraction(spec.platform, durationSeconds) * 1000) / 1000},
                target: {kind: spec.target.kind, family: spec.target.family,
                    diameterM: spec.target.diameterM, ...spec.target.parameters},
                targetInfo: draws.info,
                wind: spec.wind,
                fovFullDeg: fov, familyFovFullDeg: ROCK_V3.fovFullDeg,
                angularDiameterDeg: round5(thetaDeg),
                sizeChannelLive: thetaDeg >= fov / SENSOR_PIXELS,
                realizedRmsDeg: round5(scenario.observation.realizedRmsDegAllFrames),
                realizedMaxDeg: round5(scenario.observation.realizedMaxDeg),
                outOfFrameFraction: scenario.observation.outOfFrameFraction,
                designIntent: `${ROCK_V3.name}-${cls.key}-${draws.info.pattern ?? draws.target.kind}`,
                files: {input: path.relative(dir, out.inputFile), truth: path.relative(dir, out.truthFile),
                    all: path.relative(dir, out.allFile), scenario: path.relative(dir, out.scenarioFile),
                    truthJson: path.relative(dir, out.truthJsonFile)},
            });
        }
    }
    const expected = ROCK_V3.classes.length * ROCK_V3.perClass;
    if (names.size !== expected) throw new Error(`rockV3Batch: ${names.size} names for ${expected} tracks`);
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));

    return {
        batch: `${ROCK_V3.dirName}/${rockBatchLabel(durationSeconds)}/${err.label}`,
        durationSeconds, errorLabel: err.label, definitionHash,
        dir, scenarios: expected, files: expected * FILES_PER_SCENARIO,
        ms: Date.now() - t0,
    };
}
