// botsetManeuverBatch.js — generate ONE maneuver batch folder (a set x duration
// x error-level cell): every variant of that set, integrity checks, interchange
// files and the folder manifest. Shared by the sequential bench
// (botset-maneuvers.bench.test.js) and the parallel driver
// (run-botset-maneuvers.mjs), so the two can never drift: the bench's
// per-scenario assertions live here as throws, and generation is deterministic
// for a given (spec, seed), so the two runners produce byte-identical files.

import fs from "fs";
import path from "path";
import {generateScenario} from "./generateScenario";
import {writeInterchange} from "./exportInterchange";
import {botsetBatchLabel} from "./botsetErrors";
import {
    BOTSET_MANEUVER_ERROR_LEVELS, botsetManeuverSet, botsetManeuverVariants,
    botsetManeuverFov, botsetManeuverSpec,
} from "./botsetManeuvers";

export const BOTSET_MANEUVER_SEED = 801;

// Files writeInterchange emits per scenario under the shared-meta layout:
// Input/ input.csv; Truth/ truth.csv; All/ all.csv; meta/ scenario.json +
// truth.json. The default layout writes seven because it duplicates both
// sidecars into All/; the botset trees do not.
export const FILES_PER_SCENARIO = 5;

// One shared sidecar folder per batch, so the CSV folders hold only CSVs.
export const SIDECAR_DIR = "meta";

/**
 * Generate one batch folder. Throws on any integrity violation (flag mismatch,
 * missing event window, filename collision, wrong-set variant) — a runner
 * treats any throw as a failed batch.
 *
 * @param setKey           "anomalies" | "mundane"
 * @param durationSeconds  clip length for every scenario in the cell
 * @param errorLabel       a BOTSET_MANEUVER_ERROR_LEVELS label ("0pct" | "5pct" | "20pct")
 * @param outRoot          the results root that holds every botset_* directory
 * @returns {set, batch, dir, scenarios, files, ms}
 */
export function generateBotsetManeuverBatch({setKey, durationSeconds, errorLabel, outRoot}) {
    const set = botsetManeuverSet(setKey);
    const err = BOTSET_MANEUVER_ERROR_LEVELS.find((e) => e.label === errorLabel);
    if (!err) throw new Error(`botsetManeuverBatch: unknown error level "${errorLabel}"`);
    const variants = botsetManeuverVariants(setKey);
    if (!variants.length) {
        throw new Error(`botsetManeuverBatch: set "${setKey}" has no variants`);
    }
    const dir = path.join(outRoot, set.dirName,
        botsetBatchLabel(durationSeconds), err.label);

    const t0 = Date.now();
    const manifest = [];
    const names = new Set();

    for (const v of variants) {
        const spec = botsetManeuverSpec(v, durationSeconds, err);
        const scenario = generateScenario(spec, {scenarioSeed: BOTSET_MANEUVER_SEED});
        const profile = scenario.target.profile;

        // The set a variant lands in IS its anomalous flag, so a mismatch here
        // would publish an anomaly inside botset_mundane — the one error this
        // reorganisation must not be able to make.
        if (v.anomalous !== set.anomalous) {
            throw new Error(`botsetManeuverBatch: ${v.kind}/${v.variant} is `
                + `anomalous=${v.anomalous} but landed in set "${setKey}"`);
        }
        // The spec flag is what truth.json reads; it must match the generator's
        // resolved flag, and every anomalous variant must carry a scoring
        // window in events[].
        if (profile.anomalous !== v.anomalous) {
            throw new Error(`botsetManeuverBatch: ${v.kind}/${v.variant}: `
                + `profile.anomalous ${profile.anomalous} != spec ${v.anomalous}`);
        }
        if (v.anomalous) {
            if (!scenario.events.length) {
                throw new Error(`botsetManeuverBatch: anomalous ${v.kind}/${v.variant} has no events`);
            }
            if (!scenario.events.every((e) => e.anomalous)) {
                throw new Error(`botsetManeuverBatch: ${v.kind}/${v.variant} carries a non-anomalous event`);
            }
        }

        const out = writeInterchange(scenario, dir, {
            designIntent: `${set.dirName}-${v.kind}${v.variant ? `-${v.variant}` : ""}`,
            sidecarDir: SIDECAR_DIR,
        });
        // Two variants of one kind must never share a filename.
        if (names.has(out.basename)) {
            throw new Error(`botsetManeuverBatch: duplicate basename ${out.basename}`);
        }
        names.add(out.basename);

        // BOTH the rung and the angle it resolved to. The rung is the axis a
        // reader sweeps; the angle is what the sensor actually did, and it
        // differs per variant because the field of view does.
        const fovFullDeg = botsetManeuverFov(v);
        manifest.push({set: setKey, kind: v.kind, variant: v.variant,
            anomalous: v.anomalous, basename: out.basename,
            scenarioId: scenario.scenarioId, profile,
            rangeM: v.rangeM, durationSeconds,
            errorLevel: err.label, errorPctOfFov: err.pct,
            fovFullDeg, errorDeg: err.degreesFor(fovFullDeg)});
    }
    if (names.size !== variants.length) {
        throw new Error(`botsetManeuverBatch: ${names.size} names for ${variants.length} variants`);
    }
    fs.writeFileSync(path.join(dir, "manifest.json"),
        JSON.stringify(manifest, null, 2));

    return {
        set: setKey,
        batch: `${set.dirName}/${botsetBatchLabel(durationSeconds)}/${err.label}`,
        dir,
        scenarios: variants.length,
        files: variants.length * FILES_PER_SCENARIO,
        ms: Date.now() - t0,
    };
}
