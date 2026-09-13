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
import {centeredTurnSchedule} from "./platforms";
import {
    ROCK_V3, ROCK_V3_ERROR_LEVELS, rockBatchLabel, rockBasename, rockSpec, rockDefinitionHash,
} from "./rockV3";

export const FILES_PER_SCENARIO = 5;
export const SIDECAR_DIR = "meta";

// How close the heading change measured from the sensor positions must come to
// the track's turn level, degrees.
export const HEADING_TOLERANCE_DEG = 0.5;

const DEG = 180 / Math.PI;
const round3 = (x) => Math.round(x * 1e3) / 1e3;
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
 * The sensor's heading change over a clip, from its positions alone: the compass
 * heading of each frame-to-frame chord, summed as absolute changes (totalDeg) and
 * as signed changes (netDeg), and the number of places the chord heading moved.
 */
export function measuredHeadingChange(S, n) {
    let total = 0, net = 0, changedChords = 0, previous = null;
    for (let f = 1; f < n; f++) {
        const heading = Math.atan2(S[f * 3] - S[(f - 1) * 3], S[f * 3 + 1] - S[(f - 1) * 3 + 1]);
        if (previous !== null) {
            let d = heading - previous;
            if (d > Math.PI) d -= 2 * Math.PI;
            else if (d < -Math.PI) d += 2 * Math.PI;
            total += Math.abs(d);
            net += d;
            if (Math.abs(d) > 1e-9) changedChords++;
        }
        previous = heading;
    }
    return {totalDeg: total * DEG, netDeg: net * DEG, changedChords};
}

/**
 * How far the sensor path departs from straight, steady flight, as seen from the
 * target: the RMS distance of the sensor from its best-fitting constant-velocity
 * line, perpendicular to the sightline, over the mean slant range, in degrees.
 * Zero for a straight clip of any length. It is reported, not held constant:
 * holding it constant would tie the sensor path to the target's range.
 */
export function maneuverStrengthDeg(S, T, n, fps) {
    let st = 0, stt = 0;
    const sp = [0, 0, 0], stp = [0, 0, 0];
    for (let f = 0; f < n; f++) {
        const t = f / fps;
        st += t;
        stt += t * t;
        for (let k = 0; k < 3; k++) {
            sp[k] += S[f * 3 + k];
            stp[k] += t * S[f * 3 + k];
        }
    }
    const det = n * stt - st * st;
    if (!(det > 0)) return 0;
    const b = sp.map((sum, k) => (n * stp[k] - st * sum) / det);
    const a = sp.map((sum, k) => (sum - b[k] * st) / n);
    let sumSq = 0, sumRange = 0, count = 0;
    for (let f = 0; f < n; f++) {
        const t = f / fps, i = f * 3;
        const rx = S[i] - (a[0] + b[0] * t), ry = S[i + 1] - (a[1] + b[1] * t), rz = S[i + 2] - (a[2] + b[2] * t);
        const lx = T[i] - S[i], ly = T[i + 1] - S[i + 1], lz = T[i + 2] - S[i + 2];
        const range = Math.hypot(lx, ly, lz);
        if (!(range > 0)) continue;
        const along = (rx * lx + ry * ly + rz * lz) / range;
        sumSq += Math.max(0, rx * rx + ry * ry + rz * rz - along * along);
        sumRange += range;
        count++;
    }
    return count ? (Math.sqrt(sumSq / count) / (sumRange / count)) * DEG : 0;
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
            const n = scenario.n;
            const S = scenario.platform.positionENU;
            const T = scenario.target.positionENU;
            const turnDeg = spec.platform.turnDeg;

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
            const t0p = at(T, 0);
            if (Math.hypot(t0p[0], t0p[1]) > 1e-6) {
                throw new Error(`rockV3Batch: ${where} target does not start at the origin`);
            }
            const s0 = at(S, 0);
            if (Math.abs(s0[0]) > 1e-6 || Math.abs(s0[1] + spec.initialHorizontalRangeM) > 1e-6) {
                throw new Error(`rockV3Batch: ${where} platform does not start at [0, -R]`);
            }
            // The sensor turns by the track's level and in its turn direction,
            // measured from the positions the files carry rather than taken from
            // the schedule that made them.
            const heading = measuredHeadingChange(S, n);
            const signedDeg = spec.platform.turnDir * turnDeg;
            if (Math.abs(heading.totalDeg - turnDeg) > HEADING_TOLERANCE_DEG
                || Math.abs(heading.netDeg - signedDeg) > HEADING_TOLERANCE_DEG) {
                throw new Error(`rockV3Batch: ${where} turns ${heading.totalDeg.toFixed(3)} deg `
                    + `(net ${heading.netDeg.toFixed(3)}), not ${signedDeg}`);
            }
            // ... and turns for half the clip: the chord heading moves on the
            // chords of the turn, plus a half step at each end.
            const turningSteps = turnDeg > 0 ? (n - 1) / 2 : 0;
            if (Math.abs(heading.changedChords - turningSteps) > 1) {
                throw new Error(`rockV3Batch: ${where} heading moves on ${heading.changedChords} chords, `
                    + `not ${turningSteps} within one`);
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
            // mid-clip target), how far the sensor flew for each metre of mean
            // range, and how far its path departs from straight, steady flight.
            const los0 = sub(t0p, s0);
            const slant0 = norm(los0);
            let sumRange = 0;
            for (let f = 0; f < n; f++) sumRange += norm(sub(at(T, f), at(S, f)));
            const meanRange = sumRange / n;
            const mid = at(T, Math.floor(n / 2));
            const apertureDeg = angleBetween(sub(at(S, 0), mid), sub(at(S, n - 1), mid));
            const fov = spec.observation.fovFullDeg;
            const thetaDeg = (draws.target.diameterM / slant0) * DEG;
            const schedule = centeredTurnSchedule(spec.platform, durationSeconds);

            manifest.push({
                basename, class: cls.key, index, scenarioId: scenario.scenarioId,
                definitionHash,
                turnDeg,
                durationSeconds, frames: n, errorLevel: err.label, errorDeg: err.deg,
                rangeM: spec.initialHorizontalRangeM,
                trueRangeStartM: Math.round(slant0),
                trueRangeMeanM: Math.round(meanRange),
                depressionDeg: Math.round(Math.atan2(-los0[2], Math.hypot(los0[0], los0[1])) * DEG * 10) / 10,
                apertureDeg: Math.round(apertureDeg * 10) / 10,
                pathOverRange: round3((spec.platform.speedMS * durationSeconds) / meanRange),
                maneuverStrengthDeg: round5(maneuverStrengthDeg(S, T, n, spec.fps)),
                platform: {...spec.platform, ...draws.platformInfo,
                    turnRateDegS: round5(schedule.psiDot * DEG),
                    bankDeg: Math.round(schedule.bankRad * DEG * 100) / 100,
                    turnRadiusM: Number.isFinite(schedule.radiusM) ? Math.round(schedule.radiusM) : null,
                    headingChangeDeg: round3(heading.totalDeg),
                    turnFraction: turnDeg > 0 ? round3((schedule.t2 - schedule.t1) / durationSeconds) : 0},
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
