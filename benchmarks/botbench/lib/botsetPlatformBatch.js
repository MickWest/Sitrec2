// botsetPlatformBatch.js — generate ONE platform batch folder (a sensor-path set x
// rung): all 128 geometry-cell x object rows, integrity checks, interchange
// files and the folder manifest. Mirrors botsetBalloonBatch.js and
// botsetManeuverBatch.js so the three families stay legible side by side, and
// for the same reason: the checks live here as throws, generation is
// deterministic for a given (spec, seed), and any runner produces identical
// files.

import fs from "fs";
import path from "path";
import {generateScenario} from "./generateScenario";
import {writeInterchange, scenarioBaseName} from "./exportInterchange";
import {botsetBatchLabel} from "./botsetErrors";
import {SENSOR_PIXELS} from "./angularSize";
import {
    PLATFORM_VARIANTS, PLATFORM_ERROR_LEVELS, PLATFORM_DURATION_SECONDS, PLATFORM_FOV_FULL_DEG,
    PLATFORM_SEED, platformSet, platformSpec,
} from "./botsetPlatform";

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
 * The name a row is stored under. The house basename (scenarioBaseName) already
 * carries the target, the platform, the object's horizontal range and the
 * noise — but NOT the cell, and this family's cells are the whole point. Two
 * cells can share a horizontal range (10 km at f=0.25 and 20 km at f=0.50 are
 * both 5 km out), so the cell tag goes in immediately after the target, where a
 * directory listing sorts on it.
 */
function platformBasename(spec, cell) {
    const parts = scenarioBaseName(spec, PLATFORM_SEED).split("_");
    return [parts[0], `g${cell.gKm}km-f${cell.depthPct}`, ...parts.slice(1)].join("_");
}

/**
 * Generate one batch folder. Throws on any integrity violation — a runner
 * treats any throw as a failed batch.
 *
 * @param setKey      "orbit" | "straight"
 * @param errorLabel  an PLATFORM_ERROR_LEVELS label ("0.0deg" ... "2.0deg")
 * @param outRoot     the results root that holds every botset_* directory
 * @returns {set, batch, dir, scenarios, files, ms}
 */
export function generateBotsetPlatformBatch({setKey, errorLabel, outRoot}) {
    const set = platformSet(setKey);
    const err = PLATFORM_ERROR_LEVELS.find((e) => e.label === errorLabel);
    if (!err) throw new Error(`botsetPlatformBatch: unknown error level "${errorLabel}"`);
    const dir = path.join(outRoot, set.dirName,
        botsetBatchLabel(PLATFORM_DURATION_SECONDS), err.label);

    const t0 = Date.now();
    const manifest = [];
    const names = new Set();

    for (const variant of PLATFORM_VARIANTS) {
        const {cell, obj} = variant;
        const where = `${obj.tag} g${cell.gKm}km-f${cell.depthPct} ${set.key} ${err.label}`;
        const spec = platformSpec(variant, set, err);
        const scenario = generateScenario(spec, {scenarioSeed: PLATFORM_SEED});

        const s0 = at(scenario.platform.positionENU, 0);
        const t0p = at(scenario.target.positionENU, 0);
        const los0 = sub(t0p, s0);
        const slantM = norm(los0);

        // THE FAMILY'S CENTRAL CLAIM, checked rather than asserted in a
        // comment: the object sits at f of the way down a sightline whose
        // ground intercept is at ground range G. Extend frame 0's sightline to
        // z = 0 and the horizontal distance from the sensor must be G. A
        // platform-placement slip would otherwise produce a plausible-looking
        // set that measures a different geometry than the one it documents.
        // 1% covers integer rounding of the range and altitude, and the bird's
        // +-5 m porpoise at frame 0.
        const k = -s0[2] / los0[2];
        const groundIntersectM = k * Math.hypot(los0[0], los0[1]);
        const gErr = Math.abs(groundIntersectM - cell.groundRangeM) / cell.groundRangeM;
        if (!(gErr < 0.01)) {
            throw new Error(`botsetPlatformBatch: ${where} sightline meets the ground at `
                + `${Math.round(groundIntersectM)} m, not the declared `
                + `${cell.groundRangeM} m (${(gErr * 100).toFixed(2)}% off)`);
        }
        if (Math.abs(slantM - cell.objectSlantM) > 10) {
            throw new Error(`botsetPlatformBatch: ${where} object slant ${Math.round(slantM)} m `
                + `!= declared ${Math.round(cell.objectSlantM)} m`);
        }

        // The anomalous flag is truth, and it is what the two sets of this
        // family's impulse pair differ by. A silent flip would put an anomaly
        // in the control slot and score every run against the wrong key.
        const wantAnomalous = obj.parameters?.anomalous === true;
        const gotAnomalous = scenario.events.some((e) => e.anomalous);
        if (gotAnomalous !== wantAnomalous) {
            throw new Error(`botsetPlatformBatch: ${where} anomalous=${gotAnomalous}, `
                + `declared ${wantAnomalous}`);
        }
        // The ladder promises the target stays in frame at every rung (the
        // field widens with the amplitude, botsetErrors.js); a masked frame
        // means the rung would measure lost targets, not pointing error.
        if (scenario.observation.outOfFrameCount) {
            throw new Error(`botsetPlatformBatch: ${where} has `
                + `${scenario.observation.outOfFrameCount} out-of-frame frame(s)`);
        }

        const basename = platformBasename(spec, cell);
        if (names.has(basename)) throw new Error(`botsetPlatformBatch: duplicate basename ${basename}`);
        names.add(basename);

        const out = writeInterchange(scenario, dir, {
            basename,
            designIntent: `${set.dirName}-${obj.tag}-g${cell.gKm}km-f${cell.depthPct}`,
            sidecarDir: SIDECAR_DIR,
        });

        // Parallax aperture: the angle the sensor sweeps as seen from the
        // object at mid-clip. This is the number the family was built to raise,
        // so it belongs in the manifest rather than in a note somewhere.
        const n = scenario.n;
        const mid = at(scenario.target.positionENU, Math.floor(n / 2));
        const apertureDeg = angleBetween(
            sub(at(scenario.platform.positionENU, 0), mid),
            sub(at(scenario.platform.positionENU, n - 1), mid));

        // Whether the apparent-size channel carries any range information here.
        // Below one pixel the published bound pins to the sensor resolution and
        // is the same number at every range, so it implies one fixed floor and
        // discriminates nothing. That is a true property of a small object seen
        // from far away, not a defect — but a reader must be able to see which
        // cells it applies to without recomputing it.
        const fov = spec.observation.fovFullDeg;
        const ifovDeg = fov / SENSOR_PIXELS;
        const thetaDeg = (obj.diameterM / slantM) * DEG;

        manifest.push({
            set: setKey,
            object: obj.tag,
            kind: obj.kind,
            family: obj.family,
            anomalous: wantAnomalous,
            pairId: scenario.pairId,
            groundRangeKm: cell.gKm,
            groundRangeM: cell.groundRangeM,
            depthFraction: cell.f,
            // Both distances, because they are far apart and confusing them is
            // the standing trap in this family: objectHorizM is what the
            // generator takes and what the filename quotes, objectSlantM is how
            // far away the thing actually is, and slantToGroundM is how far the
            // sightline runs before it hits the ground.
            objectHorizM: Math.round(cell.objectHorizM),
            objectSlantM: Math.round(slantM),
            slantToGroundM: Math.round(cell.slantToGroundM),
            objectAltAGL: Math.round(cell.objectAltAGL),
            depressionDeg: Math.round(cell.depressionDeg * 10) / 10,
            apertureDeg: Math.round(apertureDeg * 10) / 10,
            platform: set.key,
            platformAltAGL: spec.platform.altitudeAGL,
            platformSpeedMS: spec.platform.speedMS,
            wind: obj.wind,
            basename: out.basename,
            scenarioId: scenario.scenarioId,
            profile: scenario.target.profile ?? null,
            durationSeconds: spec.durationSeconds,
            errorLevel: err.label, errorDeg: err.deg,
            fovFullDeg: fov,
            familyFovFullDeg: PLATFORM_FOV_FULL_DEG,
            angularDiameterDeg: round5(thetaDeg),
            sizeChannelLive: thetaDeg >= ifovDeg,
            realizedRmsDeg: round5(scenario.observation.realizedRmsDegAllFrames),
            realizedMaxDeg: round5(scenario.observation.realizedMaxDeg),
            outOfFrameFraction: scenario.observation.outOfFrameFraction,
        });
    }

    if (names.size !== PLATFORM_VARIANTS.length) {
        throw new Error(`botsetPlatformBatch: ${names.size} names for ${PLATFORM_VARIANTS.length} variants`);
    }

    // A MATCHED PAIR MUST ACTUALLY BE MATCHED. Both members share one
    // sharedSeedKey (botsetPlatform.platformPairIds), so at any rung they must draw the
    // IDENTICAL pointing-error realization — the whole value of the pair is
    // that the anomaly is the only difference between them. Checked rather
    // than trusted: a member that quietly lost its key would still generate,
    // still look right, and silently confound every comparison made with it.
    const pairs = new Map();
    for (const r of manifest) {
        if (!r.pairId) continue;
        if (!pairs.has(r.pairId)) pairs.set(r.pairId, []);
        pairs.get(r.pairId).push(r);
    }
    for (const [pairId, members] of pairs) {
        if (members.length !== 2) {
            throw new Error(`botsetPlatformBatch: pair ${pairId} has ${members.length} members, not 2`);
        }
        const [a, b] = members;
        if (a.anomalous === b.anomalous) {
            throw new Error(`botsetPlatformBatch: pair ${pairId} members are both `
                + `anomalous=${a.anomalous}; a pair is one of each`);
        }
        if (a.realizedRmsDeg !== b.realizedRmsDeg || a.realizedMaxDeg !== b.realizedMaxDeg) {
            throw new Error(`botsetPlatformBatch: pair ${pairId} members drew DIFFERENT `
                + `pointing error (rms ${a.realizedRmsDeg} vs ${b.realizedRmsDeg}, `
                + `max ${a.realizedMaxDeg} vs ${b.realizedMaxDeg}) — the shared `
                + `observation seed is not reaching both members`);
        }
    }
    if (pairs.size !== 16) {
        throw new Error(`botsetPlatformBatch: ${pairs.size} matched pairs, expected one per `
            + `geometry cell (16)`);
    }
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));

    return {
        set: setKey,
        batch: `${set.dirName}/${botsetBatchLabel(PLATFORM_DURATION_SECONDS)}/${err.label}`,
        dir,
        scenarios: PLATFORM_VARIANTS.length,
        files: PLATFORM_VARIANTS.length * FILES_PER_SCENARIO,
        ms: Date.now() - t0,
    };
}
