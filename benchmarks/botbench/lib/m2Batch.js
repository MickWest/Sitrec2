// m2Batch.js — generate ONE M2-BALLOONS batch folder (a platform x drift-level
// cell): all 20 behaviour x range variants, integrity checks, interchange trios
// and the folder manifest. Mirrors m1Batch.js so the two sets stay legible side
// by side, and for the same reason: the checks live here as throws, generation
// is deterministic for a given (spec, seed), and any runner produces identical
// files.

import fs from "fs";
import path from "path";
import {generateScenario} from "./generateScenario";
import {writeInterchange} from "./exportInterchange";
import {M2_VARIANTS, M2_PLATFORMS, M2_ERROR_LEVELS, m2Spec} from "./m2Set";

// Deliberately NOT M1's 801: a shared seed across two sets would make their
// wind and target realizations correlated, and any cross-set comparison would
// quietly be comparing one draw with itself.
export const M2_SEED = 802;

// Files writeInterchange emits per scenario: Input/ input.csv + scenario.json;
// Truth/ truth.csv + truth.json; All/ all.csv + scenario.json + truth.json.
export const FILES_PER_SCENARIO = 7;

/**
 * Generate one batch folder. Throws on any integrity violation — a runner
 * treats any throw as a failed batch.
 *
 * @param platformLabel  an M2_PLATFORMS label ("straight" | "curve" | "orbit")
 * @param errorLabel     an M2_ERROR_LEVELS label ("0.0deg" | "0.1deg" | "0.5deg")
 * @param outRoot        the m2 output root (results/m2-balloons)
 * @returns {batch, dir, scenarios, files, ms}
 */
export function generateM2Batch({platformLabel, errorLabel, outRoot}) {
    const platform = M2_PLATFORMS.find((p) => p.label === platformLabel);
    if (!platform) throw new Error(`m2Batch: unknown platform "${platformLabel}"`);
    const err = M2_ERROR_LEVELS.find((e) => e.label === errorLabel);
    if (!err) throw new Error(`m2Batch: unknown error level "${errorLabel}"`);
    const dir = path.join(outRoot, `batch_${platform.label}`, err.label);

    const t0 = Date.now();
    const manifest = [];
    const names = new Set();

    for (const v of M2_VARIANTS) {
        const spec = m2Spec(v, platform, err);
        const scenario = generateScenario(spec, {scenarioSeed: M2_SEED});

        // A buoyant target is never an anomaly, and nothing in this set injects
        // an event. If either ever becomes true it is a generator change nobody
        // meant, and the set's whole premise — mundane objects, hard geometry —
        // is gone.
        //
        // `profile` is optional: only the maneuver taxonomy carries one, and a
        // balloon target has no shape parameters to describe. Absent is fine;
        // present-and-anomalous is not.
        if (scenario.target.profile?.anomalous) {
            throw new Error(`m2Batch: ${v.behaviour} r${v.rangeMiles}mi came back anomalous`);
        }
        if (scenario.events.length) {
            throw new Error(`m2Batch: ${v.behaviour} r${v.rangeMiles}mi carries `
                + `${scenario.events.length} event(s); this set injects none`);
        }

        const out = writeInterchange(scenario, dir, {
            designIntent: `m2-balloon-${v.behaviour}-r${v.rangeMiles}mi`,
        });
        // Two variants must never share a filename — the range and behaviour
        // both have to reach the name for the set to be readable on disk.
        if (names.has(out.basename)) {
            throw new Error(`m2Batch: duplicate basename ${out.basename}`);
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
            behaviour: v.behaviour,
            rangeMiles: v.rangeMiles, rangeM: v.rangeM,
            slantRangeM: Math.round(slantM),
            depressionDeg: Math.round(depressionDeg * 10) / 10,
            kind: v.kind, wind: v.wind,
            platform: platform.label,
            driftDeg: err.driftDeg,
            basename: out.basename,
            scenarioId: scenario.scenarioId,
            profile: scenario.target.profile ?? null,
            durationSeconds: spec.durationSeconds,
            errorLevel: err.label,
        });
    }
    if (names.size !== M2_VARIANTS.length) {
        throw new Error(`m2Batch: ${names.size} names for ${M2_VARIANTS.length} variants`);
    }
    fs.writeFileSync(path.join(dir, "manifest.json"),
        JSON.stringify(manifest, null, 2));

    return {
        batch: `batch_${platform.label}/${err.label}`,
        dir,
        scenarios: M2_VARIANTS.length,
        files: M2_VARIANTS.length * FILES_PER_SCENARIO,
        ms: Date.now() - t0,
    };
}
