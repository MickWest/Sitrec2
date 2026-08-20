/**
 * botset-maneuvers.bench.test.js — generate the two maneuver botsets: the full
 * thirteen-type taxonomy (23 parameter variants), partitioned by anomaly, at
 * four clip durations and three operator error levels:
 *
 *   results/botset_anomalies/batch_<20|60|120|300>s/<0|5|20>pct/{Input,Truth,All,meta}/
 *   results/botset_mundane/  batch_<D>s/<E>pct/manifest.json   per-folder inventory
 *   results/botset_<set>/timing.json                           per-batch generation times
 *
 *     npm run bench-bot-maneuvers        # sequential (this file)
 *     npm run bench-bot-maneuvers-par    # worker_threads driver, same output tree
 *
 * (15 anomalous + 8 mundane) x 4 durations x 3 error levels = 276 scenarios.
 * The error level changes ONLY spec.observation, which is outside the truth key,
 * so the three error levels of a variant are the same flight observed three
 * ways. Batch generation and its integrity checks live in
 * lib/botsetManeuverBatch.js, shared with the parallel driver — generation is
 * deterministic, so the two runners produce byte-identical trees (timing aside).
 */

import fs from "fs";
import path from "path";
import {setSit} from "../../src/Globals";
import {resetOutDir} from "./lib/resetOutDir";
import {generateBotsetManeuverBatch, FILES_PER_SCENARIO} from "./lib/botsetManeuverBatch";
import {
    BOTSET_MANEUVER_VARIANTS, BOTSET_MANEUVER_SETS,
    BOTSET_MANEUVER_DURATIONS_SECONDS, BOTSET_MANEUVER_ERROR_LEVELS,
    botsetManeuverVariants,
} from "./lib/botsetManeuvers";

const RESULTS = path.resolve(__dirname, "results");

describe("botset maneuver generation", () => {
    jest.setTimeout(600000);

    beforeAll(() => {
        setSit({name: "botbench-maneuvers", frames: 10000, fps: 10,
            simSpeed: 1, lat: 40, lon: -105});
    });

    test("the two sets partition the taxonomy with nothing lost or shared", () => {
        const seen = BOTSET_MANEUVER_SETS.flatMap((s) => botsetManeuverVariants(s.key));
        expect(seen.length).toBe(BOTSET_MANEUVER_VARIANTS.length);
        expect(new Set(seen).size).toBe(BOTSET_MANEUVER_VARIANTS.length);
        expect(botsetManeuverVariants("anomalies").every((v) => v.anomalous)).toBe(true);
        expect(botsetManeuverVariants("mundane").every((v) => !v.anomalous)).toBe(true);
    });

    test("generates every set x duration x error x variant, timed", () => {
        // Names encode variant and flags, so a rename leaves stale files behind
        // — start each set from an empty tree. Only the botset directories are
        // reset: results/ holds many other generated trees.
        // resetOutDir, not rmSync: a .DS_Store recreated mid-walk makes the
        // plain call throw ENOTEMPTY with the tree already half deleted.
        for (const s of BOTSET_MANEUVER_SETS) resetOutDir(path.join(RESULTS, s.dirName));

        const timing = [];
        const rows = [];
        const t0All = Date.now();
        let filesTotal = 0;

        for (const set of BOTSET_MANEUVER_SETS) {
            const expected = botsetManeuverVariants(set.key).length;
            const setTiming = [];
            const setT0 = Date.now();
            for (const durationSeconds of BOTSET_MANEUVER_DURATIONS_SECONDS) {
                for (const err of BOTSET_MANEUVER_ERROR_LEVELS) {
                    const r = generateBotsetManeuverBatch({setKey: set.key,
                        durationSeconds, errorLabel: err.label, outRoot: RESULTS});
                    expect(r.scenarios).toBe(expected);
                    // The layout contract, asserted rather than assumed: CSVs in
                    // their own folders, both sidecars in meta/.
                    expect(fs.readdirSync(path.join(r.dir, "meta")).length)
                        .toBe(expected * 2);
                    expect(fs.readdirSync(path.join(r.dir, "All"))
                        .every((n) => n.endsWith(".all.csv"))).toBe(true);
                    filesTotal += r.files;
                    const row = {batch: r.batch, scenarios: r.scenarios, ms: r.ms};
                    timing.push(row);
                    setTiming.push(row);
                    rows.push([set.key, `${durationSeconds}s`, err.label,
                        String(r.scenarios), `${r.ms} ms`]);
                }
            }
            // Per-SET timing, written into the set's own directory: the set is
            // the unit a reader opens (and the unit vizBotBench takes), so a
            // combined file at the results root would belong to neither.
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
        expect(scenarios).toBe(BOTSET_MANEUVER_VARIANTS.length
            * BOTSET_MANEUVER_DURATIONS_SECONDS.length
            * BOTSET_MANEUVER_ERROR_LEVELS.length);
        expect(filesTotal).toBe(scenarios * FILES_PER_SCENARIO);

        const totalMs = Date.now() - t0All;

        const header = ["set", "duration", "error", "scenarios", "time"];
        const w = header.map((h, i) => Math.max(h.length,
            ...rows.map((r) => r[i].length)));
        const line = (r) => r.map((c, i) => c.padStart(w[i])).join("  ");
        console.log(`[botbench] maneuver botsets -> ${RESULTS}\n`
            + line(header) + "\n" + rows.map(line).join("\n")
            + `\ntotal: ${scenarios} scenarios, ${filesTotal} files, ${totalMs} ms`);
    });
});
