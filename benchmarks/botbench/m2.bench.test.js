/**
 * m2.bench.test.js — generate the M2-BALLOONS set: buoyant targets swept over
 * platform geometry, behaviour, range and operator DRIFT, into the same folder
 * tree shape M1 uses:
 *
 *   results/m2-balloons/batch_<straight|curve|orbit>/<0.0|0.1|0.5>deg/{Input,Truth,All}/
 *   results/m2-balloons/batch_<P>/<E>deg/manifest.json   per-folder inventory
 *   results/m2-balloons/timing.json                      per-batch generation times
 *
 *     npm run bench-bot-m2
 *
 * 20 variants (5 behaviours x 4 ranges) x 3 platforms x 3 drift levels = 180
 * scenarios. The drift level changes ONLY spec.observation, which is outside
 * the truth key, so the three levels of a variant are the same balloon observed
 * three ways. Batch generation and its integrity checks live in lib/m2Batch.js.
 *
 * Where this differs from M1, and why, is documented in lib/m2Set.js: the outer
 * axis is platform geometry rather than clip duration, because a balloon's
 * detectability is a question about how the SENSOR moves; and the error ladder
 * is one-way drift rather than recentring wobble, because zero-mean error is
 * the kind a fit absorbs and a slow slide is the kind it cannot.
 */

import fs from "fs";
import path from "path";
import {setSit} from "../../src/Globals";
import {resetOutDir} from "./lib/resetOutDir";
import {generateM2Batch} from "./lib/m2Batch";
import {M2_VARIANTS, M2_PLATFORMS, M2_ERROR_LEVELS} from "./lib/m2Set";

const OUT_DIR = path.resolve(__dirname, "results", "m2-balloons");

describe("M2 balloon batch generation", () => {
    jest.setTimeout(600000);

    beforeAll(() => {
        setSit({name: "botbench-m2", frames: 10000, fps: 10,
            simSpeed: 1, lat: 40, lon: -105});
    });

    test("generates every platform x drift x variant, timed", () => {
        // Names encode behaviour and range, so a rename leaves stale files
        // behind — start from an empty tree every run.
        // resetOutDir, not rmSync: a .DS_Store recreated mid-walk makes the
        // plain call throw ENOTEMPTY with the tree already half deleted.
        resetOutDir(OUT_DIR);

        const timing = [];
        const rows = [];
        const t0All = Date.now();
        let filesTotal = 0;

        for (const platform of M2_PLATFORMS) {
            for (const err of M2_ERROR_LEVELS) {
                const r = generateM2Batch({platformLabel: platform.label,
                    errorLabel: err.label, outRoot: OUT_DIR});
                expect(r.scenarios).toBe(M2_VARIANTS.length);
                filesTotal += r.files;
                timing.push({batch: r.batch, scenarios: r.scenarios, ms: r.ms});
                rows.push([platform.label, err.label,
                    String(r.scenarios), `${r.ms} ms`]);
            }
        }

        const totalMs = Date.now() - t0All;
        fs.writeFileSync(path.join(OUT_DIR, "timing.json"), JSON.stringify({
            generatedAt: new Date().toISOString(),
            scenarios: timing.reduce((s, t) => s + t.scenarios, 0),
            files: filesTotal,
            totalMs,
            batches: timing,
        }, null, 2));

        const header = ["platform", "drift", "scenarios", "time"];
        const w = header.map((h, i) => Math.max(h.length,
            ...rows.map((r) => r[i].length)));
        const line = (r) => r.map((c, i) => c.padStart(w[i])).join("  ");
        console.log(`[botbench] M2 balloons -> ${OUT_DIR}\n`
            + line(header) + "\n" + rows.map(line).join("\n")
            + `\ntotal: ${timing.reduce((s, t) => s + t.scenarios, 0)} scenarios, `
            + `${filesTotal} files, ${totalMs} ms`);
    });
});
