// botsetBalloonBatch.js — generate ONE balloon batch folder (a platform set x
// drift-level cell): all 20 behaviour x range variants, integrity checks,
// interchange files and the folder manifest. Mirrors botsetManeuverBatch.js so
// the two families stay legible side by side, and for the same reason: the
// checks live here as throws, generation is deterministic for a given (spec,
// seed), and any runner produces identical files.

import fs from "fs";
import path from "path";
import {generateScenario} from "./generateScenario";
import {writeInterchange} from "./exportInterchange";
import {botsetBatchLabel} from "./botsetErrors";
import {
    BOTSET_BALLOON_VARIANTS, BOTSET_BALLOON_ERROR_LEVELS,
    BOTSET_BALLOON_DURATION_SECONDS, BOTSET_BALLOON_FOV_FULL_DEG,
    botsetBalloonSet, botsetBalloonSpec,
} from "./botsetBalloons";

// Deliberately NOT the maneuver sets' 801: a shared seed across two families
// would make their wind and target realizations correlated, and any cross-family
// comparison would quietly be comparing one draw with itself.
export const BOTSET_BALLOON_SEED = 802;

// Input/ input.csv; Truth/ truth.csv; All/ all.csv; meta/ scenario.json +
// truth.json.
export const FILES_PER_SCENARIO = 5;

export const SIDECAR_DIR = "meta";

/**
 * Generate one batch folder. Throws on any integrity violation — a runner
 * treats any throw as a failed batch.
 *
 * @param setKey      "straight" | "curve" | "orbit"
 * @param errorLabel  a BOTSET_BALLOON_ERROR_LEVELS label ("0pct" | "5pct" | "20pct")
 * @param outRoot     the results root that holds every botset_* directory
 * @returns {set, batch, dir, scenarios, files, ms}
 */
export function generateBotsetBalloonBatch({setKey, errorLabel, outRoot}) {
    const platform = botsetBalloonSet(setKey);
    const err = BOTSET_BALLOON_ERROR_LEVELS.find((e) => e.label === errorLabel);
    if (!err) throw new Error(`botsetBalloonBatch: unknown error level "${errorLabel}"`);
    const dir = path.join(outRoot, platform.dirName,
        botsetBatchLabel(BOTSET_BALLOON_DURATION_SECONDS), err.label);

    const t0 = Date.now();
    const manifest = [];
    const names = new Set();

    for (const v of BOTSET_BALLOON_VARIANTS) {
        const spec = botsetBalloonSpec(v, platform, err);
        const scenario = generateScenario(spec, {scenarioSeed: BOTSET_BALLOON_SEED});

        // A buoyant target is never an anomaly, and nothing in this family
        // injects an event. If either ever becomes true it is a generator change
        // nobody meant, and the family's whole premise — mundane objects, hard
        // geometry — is gone.
        //
        // `profile` is optional: only the maneuver taxonomy carries one, and a
        // balloon target has no shape parameters to describe. Absent is fine;
        // present-and-anomalous is not.
        if (scenario.target.profile?.anomalous) {
            throw new Error(`botsetBalloonBatch: ${v.behaviour} r${v.rangeMiles}mi came back anomalous`);
        }
        if (scenario.events.length) {
            throw new Error(`botsetBalloonBatch: ${v.behaviour} r${v.rangeMiles}mi carries `
                + `${scenario.events.length} event(s); this family injects none`);
        }

        const out = writeInterchange(scenario, dir, {
            designIntent: `${platform.dirName}-${v.behaviour}-r${v.rangeMiles}mi`,
            sidecarDir: SIDECAR_DIR,
        });
        // Two variants must never share a filename — the range and behaviour
        // both have to reach the name for the set to be readable on disk.
        if (names.has(out.basename)) {
            throw new Error(`botsetBalloonBatch: duplicate basename ${out.basename}`);
        }
        names.add(out.basename);

        // BOTH RANGES, because they are far apart here and the label is the
        // smaller one. rangeM is HORIZONTAL, which is what the generator takes
        // and what the filename quotes; the platform flies 5.5 km above the
        // balloon, so the actual sightline is much longer — 3.2 km horizontal
        // is a 6.4 km slant at a 60 degree depression, i.e. nearly overhead.
        // Reading "2 miles" as the distance to the target would be wrong by a
        // factor of two, and wrong about the geometry entirely.
        const s0 = scenario.platform.positionENU;
        const t0p = scenario.target.positionENU;
        const dx = t0p[0] - s0[0], dy = t0p[1] - s0[1], dz = t0p[2] - s0[2];
        const slantM = Math.hypot(dx, dy, dz);
        const depressionDeg = Math.atan2(-dz, Math.hypot(dx, dy)) * 180 / Math.PI;

        manifest.push({
            set: setKey,
            behaviour: v.behaviour,
            rangeMiles: v.rangeMiles, rangeM: v.rangeM,
            slantRangeM: Math.round(slantM),
            depressionDeg: Math.round(depressionDeg * 10) / 10,
            kind: v.kind, wind: v.wind,
            platform: platform.key,
            basename: out.basename,
            scenarioId: scenario.scenarioId,
            profile: scenario.target.profile ?? null,
            durationSeconds: spec.durationSeconds,
            errorLevel: err.label, errorPctOfFov: err.pct,
            fovFullDeg: BOTSET_BALLOON_FOV_FULL_DEG,
            errorDeg: err.degreesFor(BOTSET_BALLOON_FOV_FULL_DEG),
        });
    }
    if (names.size !== BOTSET_BALLOON_VARIANTS.length) {
        throw new Error(`botsetBalloonBatch: ${names.size} names for `
            + `${BOTSET_BALLOON_VARIANTS.length} variants`);
    }
    fs.writeFileSync(path.join(dir, "manifest.json"),
        JSON.stringify(manifest, null, 2));

    return {
        set: setKey,
        batch: `${platform.dirName}/${botsetBatchLabel(BOTSET_BALLOON_DURATION_SECONDS)}/${err.label}`,
        dir,
        scenarios: BOTSET_BALLOON_VARIANTS.length,
        files: BOTSET_BALLOON_VARIANTS.length * FILES_PER_SCENARIO,
        ms: Date.now() - t0,
    };
}
