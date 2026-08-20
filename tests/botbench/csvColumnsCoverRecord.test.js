/**
 * csvColumnsCoverRecord.test.js — the BOT Bench CSV export drops any field its
 * column list does not name.
 *
 * `resultsToCsv` maps over `CSV_COLUMNS`, so `rowToCsvRecord` can populate a key
 * and the export will still omit it, with no error and no empty column — the
 * field simply is not there. It is a silent loss on the one artifact an offline
 * study actually consumes, and it has already happened once: the ten
 * ordinariness fields were populated and exported nowhere.
 *
 * The guard is a set comparison, so it catches the NEXT field too.
 */

import {CSV_COLUMNS, rowToCsvRecord} from "../../src/analysis/BotBenchUI";

/** An entry populated densely enough that every branch emits its key. */
function fullEntry() {
    return {
        relativePath: "a/b.input.csv",
        status: "done",
        options: {anchorM: 37040, solutionFamilies: true, mcOrderSweep: false},
        row: {
            displayName: "b", kind: "bot", trackId: "t",
            quality: {frames: 200, durationS: 20, fps: 10},
            verdictCode: "consistent-one", headline: "h", viableClasses: ["balloon"],
            mundaneness: {
                top: {total: 0.05, key: "balloon", label: "balloon",
                    sizeCost: 0.05, speedCost: 0, gCost: 0, sizeOneSided: false},
                mostOrdinary: {total: 0, key: "airliner", label: "airliner",
                    name: "Fixed-Wing Aircraft", errDeg: 0.2133},
            },
            top: {key: "k", name: "n", errDeg: 0.01, tier: "t"},
            truthScore: {label: "L", topSepM: 1, topRelSep: 0.1},
            separability: {floorDeg: 0.02},
        },
    };
}

test("every field rowToCsvRecord emits has a column in the export", () => {
    const record = rowToCsvRecord(fullEntry());
    const columns = new Set(CSV_COLUMNS);
    const missing = Object.keys(record).filter((k) => !columns.has(k));
    expect(missing).toEqual([]);
});

test("the ordinariness fields specifically survive the export", () => {
    // Named explicitly as well as covered by the sweep above, because these are
    // the fields the mundaneness study reads and a rename would otherwise pass
    // the generic check while silently changing the schema.
    for (const key of ["ordTop", "ordTopClass", "ordTopSize", "ordTopSpeed",
        "ordTopG", "ordTopSizeOneSided", "ordMin", "ordMinClass", "ordMinName",
        "ordMinErrDeg"]) {
        expect(CSV_COLUMNS).toContain(key);
    }
});

test("the record carries the values, not just the keys", () => {
    const record = rowToCsvRecord(fullEntry());
    expect(record.ordTop).toBe(0.05);
    expect(record.ordTopClass).toBe("balloon");
    expect(record.ordTopSizeOneSided).toBe(false);
    expect(record.ordMin).toBe(0);
    expect(record.ordMinName).toBe("Fixed-Wing Aircraft");
    expect(record.ordMinErrDeg).toBeCloseTo(0.2133, 6);
});

test("a row with no mundaneness leaves the fields empty rather than throwing", () => {
    const e = fullEntry();
    delete e.row.mundaneness;
    const record = rowToCsvRecord(e);
    expect(record.ordTop).toBeUndefined();
    expect(record.ordTopClass).toBe("");
});
