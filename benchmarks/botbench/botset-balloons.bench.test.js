/**
 * botset-balloons.bench.test.js — generate the three balloon botsets: buoyant
 * targets seen from three platform paths, over four ranges and nine operator
 * pointing-error rungs:
 *
 *   results/botset_balloons_<straight|curve|orbit>/batch_20s/<E>deg/{Input,Truth,All,meta}/
 *   results/botset_balloons_<path>/batch_20s/<E>deg/manifest.json  per-folder inventory
 *   results/botset_balloons_<path>/timing.json                     per-batch generation times
 *
 *     npm run bench-bot-balloons
 *
 * 20 variants x 3 platform sets x 9 error rungs = 540 scenarios. Duration is
 * pinned at 20 s: geometry, not time, is this family's axis, which is why the
 * platform path separates the SETS rather than sitting inside one. Where this
 * differs from the maneuver family, and why, is documented in
 * lib/botsetBalloons.js.
 */

import fs from "fs";
import path from "path";
import {setSit} from "../../src/Globals";
import {resetOutDir} from "./lib/resetOutDir";
import {generateBotsetBalloonBatch, FILES_PER_SCENARIO} from "./lib/botsetBalloonBatch";
import {
    BOTSET_BALLOON_VARIANTS, BOTSET_BALLOON_SETS, BOTSET_BALLOON_ERROR_LEVELS,
} from "./lib/botsetBalloons";

const RESULTS = path.resolve(__dirname, "results");

describe("botset balloon generation", () => {
    jest.setTimeout(600000);

    beforeAll(() => {
        setSit({name: "botbench-balloons", frames: 10000, fps: 10,
            simSpeed: 1, lat: 40, lon: -105});
    });

    test("generates every platform set x error rung x variant, timed", () => {
        for (const s of BOTSET_BALLOON_SETS) resetOutDir(path.join(RESULTS, s.dirName));

        const timing = [];
        const rows = [];
        const t0All = Date.now();
        let filesTotal = 0;

        for (const set of BOTSET_BALLOON_SETS) {
            const setTiming = [];
            const setT0 = Date.now();
            for (const err of BOTSET_BALLOON_ERROR_LEVELS) {
                const r = generateBotsetBalloonBatch({setKey: set.key,
                    errorLabel: err.label, outRoot: RESULTS});
                expect(r.scenarios).toBe(BOTSET_BALLOON_VARIANTS.length);
                expect(fs.readdirSync(path.join(r.dir, "meta")).length)
                    .toBe(BOTSET_BALLOON_VARIANTS.length * 2);
                expect(fs.readdirSync(path.join(r.dir, "All"))
                    .every((n) => n.endsWith(".all.csv"))).toBe(true);
                filesTotal += r.files;
                const row = {batch: r.batch, scenarios: r.scenarios, ms: r.ms};
                timing.push(row);
                setTiming.push(row);
                rows.push([set.key, err.label, String(r.scenarios), `${r.ms} ms`]);
            }
            // Per-SET timing, in the set's own directory — see the maneuver
            // bench for why the results root is the wrong home for it.
            fs.writeFileSync(path.join(RESULTS, set.dirName, "timing.json"),
                JSON.stringify({
                    generatedAt: new Date().toISOString(),
                    set: set.key,
                    scenarios: setTiming.reduce((s, t) => s + t.scenarios, 0),
                    files: setTiming.reduce((s, t) => s + t.scenarios, 0) * FILES_PER_SCENARIO,
                    totalMs: Date.now() - setT0,
                    batches: setTiming,
                }, null, 2));
        }

        const scenarios = timing.reduce((s, t) => s + t.scenarios, 0);
        expect(scenarios).toBe(BOTSET_BALLOON_VARIANTS.length
            * BOTSET_BALLOON_SETS.length * BOTSET_BALLOON_ERROR_LEVELS.length);
        expect(filesTotal).toBe(scenarios * FILES_PER_SCENARIO);

        const totalMs = Date.now() - t0All;

        const header = ["set", "error", "scenarios", "time"];
        const w = header.map((h, i) => Math.max(h.length,
            ...rows.map((r) => r[i].length)));
        const line = (r) => r.map((c, i) => c.padStart(w[i])).join("  ");
        console.log(`[botbench] balloon botsets -> ${RESULTS}\n`
            + line(header) + "\n" + rows.map(line).join("\n")
            + `\ntotal: ${scenarios} scenarios, ${filesTotal} files, ${totalMs} ms`);
    });
});
