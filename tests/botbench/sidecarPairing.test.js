/**
 * sidecarPairing.test.js — the directory-scoped pairing keys that attach a
 * scenario.json / truth.json to the CSV it describes.
 *
 * Two properties matter and neither is obvious from reading the caller:
 *
 *   1. A sidecar must never pair across batches. A swept tree repeats every
 *      basename in every batch folder, so a bare-name key would silently give a
 *      scenario another batch's frame origin — a wrong answer that looks right.
 *   2. Both on-disk layouts must resolve to the SAME key: sidecars beside their
 *      CSV (sealed releases) and sidecars gathered in a meta/ folder (the botset
 *      trees).
 */

import {botBenchPairingKeys} from "../../src/analysis/BotBenchIngest";

const AN = "botset_anomalies/batch_20s/5pct";

describe("BOT sidecar pairing keys", () => {

    test("meta/ sidecars index to the same key their sibling CSVs look up", () => {
        const csvAll = botBenchPairingKeys(`${AN}/All/x_s801.all.csv`);
        const csvIn = botBenchPairingKeys(`${AN}/Input/x_s801.input.csv`);
        const scenario = botBenchPairingKeys(`${AN}/meta/x_s801.scenario.json`);
        const truth = botBenchPairingKeys(`${AN}/meta/x_s801.truth.json`);

        expect(scenario.inMetaDir).toBe(true);
        expect(truth.inMetaDir).toBe(true);
        // The CSVs fall back to their parent; the sidecars index there.
        expect(csvAll.altKey).toBe(scenario.indexKey);
        expect(csvIn.altKey).toBe(truth.indexKey);
        expect(scenario.indexKey).toBe(`${AN}/x_s801`);
    });

    test("the sibling layout still pairs on the primary key", () => {
        const csv = botBenchPairingKeys("release/Input/bot-0001.input.csv");
        const side = botBenchPairingKeys("release/Input/bot-0001.scenario.json");
        expect(side.inMetaDir).toBe(false);
        expect(side.indexKey).toBe(csv.key);
        expect(csv.key).toBe("release/Input/bot-0001");
    });

    test("two batches with identical basenames never share a key", () => {
        const a = botBenchPairingKeys("botset_anomalies/batch_20s/5pct/meta/x.scenario.json");
        const b = botBenchPairingKeys("botset_anomalies/batch_20s/20pct/meta/x.scenario.json");
        const c = botBenchPairingKeys("botset_anomalies/batch_60s/5pct/meta/x.scenario.json");
        const d = botBenchPairingKeys("botset_mundane/batch_20s/5pct/meta/x.scenario.json");
        expect(new Set([a, b, c, d].map((k) => k.indexKey)).size).toBe(4);
    });

    test("a CSV never reaches a sibling batch through its altKey", () => {
        // batch_20s/5pct/All/x -> altKey batch_20s/5pct/x, which is where only
        // THIS batch's meta/ indexes. The 20pct meta indexes elsewhere.
        const csv = botBenchPairingKeys("botset_anomalies/batch_20s/5pct/All/x.all.csv");
        const otherRung = botBenchPairingKeys("botset_anomalies/batch_20s/20pct/meta/x.scenario.json");
        expect(csv.key).not.toBe(otherRung.indexKey);
        expect(csv.altKey).not.toBe(otherRung.indexKey);
    });

    test("a flat folder with no directory part still keys cleanly", () => {
        const k = botBenchPairingKeys("bot-0001.all.csv");
        expect(k.dir).toBe("");
        expect(k.key).toBe("bot-0001");
        expect(k.altKey).toBe("bot-0001");
    });
});
