// m1Batch.js — generate ONE M1 batch folder (a duration x error-level cell):
// all 23 variants, integrity checks, interchange trios and the folder
// manifest. Shared by the sequential bench (m1.bench.test.js) and the
// parallel driver (run-m1-parallel.mjs), so the two can never drift: the
// bench's per-scenario assertions live here as throws, and generation is
// deterministic for a given (spec, seed), so the two runners produce
// byte-identical files.

import fs from "fs";
import path from "path";
import {generateScenario} from "./generateScenario";
import {writeInterchange} from "./exportInterchange";
import {M1_VARIANTS, M1_ERROR_LEVELS, m1Spec} from "./m1Set";

export const M1_SEED = 801;

// Files writeInterchange emits per scenario: Input/ input.csv + scenario.json;
// Truth/ truth.csv + truth.json; All/ all.csv + scenario.json + truth.json.
export const FILES_PER_SCENARIO = 7;

/**
 * Generate one batch folder. Throws on any integrity violation (flag
 * mismatch, missing event window, filename collision) — a runner treats any
 * throw as a failed batch.
 *
 * @param durationSeconds  clip length for every scenario in the cell
 * @param errorLabel       an M1_ERROR_LEVELS label ("0.0deg" | "0.15deg" | ...)
 * @param outRoot          the m1 output root (results/m1)
 * @returns {batch, dir, scenarios, files, ms}
 */
export function generateM1Batch({durationSeconds, errorLabel, outRoot}) {
    const err = M1_ERROR_LEVELS.find((e) => e.label === errorLabel);
    if (!err) throw new Error(`m1Batch: unknown error level "${errorLabel}"`);
    const dir = path.join(outRoot, `batch_${durationSeconds}sec`, err.label);

    const t0 = Date.now();
    const manifest = [];
    const names = new Set();

    for (const v of M1_VARIANTS) {
        const spec = m1Spec(v, durationSeconds, err);
        const scenario = generateScenario(spec, {scenarioSeed: M1_SEED});
        const profile = scenario.target.profile;

        // The spec flag is what truth.json reads; it must match the
        // generator's resolved flag, and every anomalous variant must carry a
        // scoring window in events[].
        if (profile.anomalous !== v.anomalous) {
            throw new Error(`m1Batch: ${v.kind}/${v.variant}: profile.anomalous `
                + `${profile.anomalous} != spec ${v.anomalous}`);
        }
        if (v.anomalous) {
            if (!scenario.events.length) {
                throw new Error(`m1Batch: anomalous ${v.kind}/${v.variant} has no events`);
            }
            if (!scenario.events.every((e) => e.anomalous)) {
                throw new Error(`m1Batch: ${v.kind}/${v.variant} carries a non-anomalous event`);
            }
        }

        const out = writeInterchange(scenario, dir, {
            designIntent: `m1-${v.kind}${v.variant ? `-${v.variant}` : ""}`,
        });
        // Two variants of one kind must never share a filename.
        if (names.has(out.basename)) {
            throw new Error(`m1Batch: duplicate basename ${out.basename}`);
        }
        names.add(out.basename);

        manifest.push({kind: v.kind, variant: v.variant,
            anomalous: v.anomalous, basename: out.basename,
            scenarioId: scenario.scenarioId, profile,
            rangeM: v.rangeM, durationSeconds,
            errorLevel: err.label});
    }
    if (names.size !== M1_VARIANTS.length) {
        throw new Error(`m1Batch: ${names.size} names for ${M1_VARIANTS.length} variants`);
    }
    fs.writeFileSync(path.join(dir, "manifest.json"),
        JSON.stringify(manifest, null, 2));

    return {
        batch: `batch_${durationSeconds}sec/${err.label}`,
        dir,
        scenarios: M1_VARIANTS.length,
        files: M1_VARIANTS.length * FILES_PER_SCENARIO,
        ms: Date.now() - t0,
    };
}
