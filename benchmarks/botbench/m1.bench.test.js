/**
 * m1.bench.test.js — generate the M1 batch: the full thirteen-type maneuver
 * taxonomy (23 parameter variants), at four clip durations and three operator
 * error levels, into a per-batch folder tree:
 *
 *   results/m1/batch_<20|60|120|300>sec/<0.0|0.15|0.3>deg/{Input,Truth,All}/
 *   results/m1/batch_<D>sec/<E>deg/manifest.json     per-folder inventory
 *   results/m1/timing.json                           per-batch generation times
 *
 *     npm run bench-bot-m1          # sequential (this file)
 *     npm run bench-bot-m1-par      # worker_threads driver, same output tree
 *
 * 23 variants x 4 durations x 3 error levels = 276 scenarios. The error level
 * changes ONLY spec.observation, which is outside the truth key, so the three
 * error levels of a variant are the same flight observed three ways. Batch
 * generation and its integrity checks live in lib/m1Batch.js, shared with the
 * parallel driver — generation is deterministic, so the two runners produce
 * byte-identical trees (timing.json aside). The run is timed per batch folder
 * and in total; the numbers land in timing.json and on the console.
 */

import fs from "fs";
import path from "path";
import {setSit} from "../../src/Globals";
import {resetOutDir} from "./lib/resetOutDir";
import {generateM1Batch} from "./lib/m1Batch";
import {M1_VARIANTS, M1_DURATIONS_SECONDS, M1_ERROR_LEVELS} from "./lib/m1Set";

const OUT_DIR = path.resolve(__dirname, "results", "m1");

describe("M1 batch generation", () => {
    jest.setTimeout(600000);

    beforeAll(() => {
        setSit({name: "botbench-m1", frames: 10000, fps: 10,
            simSpeed: 1, lat: 40, lon: -105});
    });

    test("generates every duration x error x variant, timed", () => {
        // Names encode variant and flags, so a rename leaves stale files
        // behind — start from an empty tree every run.
        // resetOutDir, not rmSync: a .DS_Store recreated mid-walk makes the
        // plain call throw ENOTEMPTY with the tree already half deleted.
        resetOutDir(OUT_DIR);

        const timing = [];
        const rows = [];
        const t0All = Date.now();
        let filesTotal = 0;

        for (const durationSeconds of M1_DURATIONS_SECONDS) {
            for (const err of M1_ERROR_LEVELS) {
                const r = generateM1Batch({durationSeconds,
                    errorLabel: err.label, outRoot: OUT_DIR});
                expect(r.scenarios).toBe(M1_VARIANTS.length);
                filesTotal += r.files;
                timing.push({batch: r.batch, scenarios: r.scenarios, ms: r.ms});
                rows.push([`${durationSeconds}s`, err.label,
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

        const header = ["duration", "error", "scenarios", "time"];
        const w = header.map((h, i) => Math.max(h.length,
            ...rows.map((r) => r[i].length)));
        const line = (r) => r.map((c, i) => c.padStart(w[i])).join("  ");
        console.log(`[botbench] M1 batch -> ${OUT_DIR}\n`
            + line(header) + "\n" + rows.map(line).join("\n")
            + `\ntotal: ${timing.reduce((s, t) => s + t.scenarios, 0)} scenarios, `
            + `${filesTotal} files, ${totalMs} ms`);
    });
});
