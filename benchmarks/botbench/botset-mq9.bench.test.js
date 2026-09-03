/**
 * botset-mq9.bench.test.js — generate the two mq9 botsets: an endurance
 * surveillance platform at 20000 ft staring down one sightline, with the object
 * at four depths along it, over two sensor paths and nine operator
 * pointing-error rungs:
 *
 *   results/botset_mq9_<orbit|straight>/batch_90s/<E>deg/{Input,Truth,All,meta}/
 *   results/botset_mq9_<path>/batch_90s/<E>deg/manifest.json  per-folder inventory
 *   results/botset_mq9_<path>/timing.json                     per-batch generation times
 *
 *     npm run bench-bot-mq9
 *
 * 16 geometry cells x 8 objects x 2 sensor paths x 9 error rungs = 2304
 * scenarios. Duration is pinned at 90 s: DEPTH along a fixed sightline is this
 * family's axis, which is why the sensor path separates the SETS rather than
 * sitting inside one. Why the family exists, and how it differs from the
 * balloon and maneuver families, is documented in lib/botsetMq9.js.
 */

import fs from "fs";
import path from "path";
import {setSit} from "../../src/Globals";
import {resetOutDir} from "./lib/resetOutDir";
import {generateBotsetMq9Batch, FILES_PER_SCENARIO} from "./lib/botsetMq9Batch";
import {MQ9_VARIANTS, MQ9_SETS, MQ9_ERROR_LEVELS} from "./lib/botsetMq9";

const RESULTS = path.resolve(__dirname, "results");

describe("botset mq9 generation", () => {
    jest.setTimeout(3600000);

    beforeAll(() => {
        setSit({name: "botbench-mq9", frames: 10000, fps: 10,
            simSpeed: 1, lat: 40, lon: -105});
    });

    test("generates every sensor path x error rung x cell x object, timed", () => {
        for (const s of MQ9_SETS) resetOutDir(path.join(RESULTS, s.dirName));

        const timing = [];
        const rows = [];
        const t0All = Date.now();
        let filesTotal = 0;

        for (const set of MQ9_SETS) {
            const setTiming = [];
            const setT0 = Date.now();
            for (const err of MQ9_ERROR_LEVELS) {
                const r = generateBotsetMq9Batch({setKey: set.key,
                    errorLabel: err.label, outRoot: RESULTS});
                expect(r.scenarios).toBe(MQ9_VARIANTS.length);
                expect(fs.readdirSync(path.join(r.dir, "meta")).length)
                    .toBe(MQ9_VARIANTS.length * 2);
                expect(fs.readdirSync(path.join(r.dir, "All"))
                    .every((n) => n.endsWith(".all.csv"))).toBe(true);
                filesTotal += r.files;
                const row = {batch: r.batch, scenarios: r.scenarios, ms: r.ms};
                timing.push(row);
                setTiming.push(row);
                rows.push([set.key, err.label, String(r.scenarios), `${r.ms} ms`]);
            }
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
        expect(scenarios).toBe(MQ9_VARIANTS.length * MQ9_SETS.length * MQ9_ERROR_LEVELS.length);
        expect(filesTotal).toBe(scenarios * FILES_PER_SCENARIO);

        const totalMs = Date.now() - t0All;
        const header = ["set", "error", "scenarios", "time"];
        const w = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
        const line = (r) => r.map((c, i) => c.padStart(w[i])).join("  ");
        console.log(`[botbench] mq9 botsets -> ${RESULTS}\n`
            + line(header) + "\n" + rows.map(line).join("\n")
            + `\ntotal: ${scenarios} scenarios, ${filesTotal} files, ${totalMs} ms`);
    });
});
