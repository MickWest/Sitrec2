// BotBenchCacheCodec.test.js — comparing a fresh fit with a cached one.
//
// What prompted this file: the probe that decides whether an earlier build's
// cached fits can be reused compared the whole row, including elapsedMs, the
// wall-clock time the fit took. A fresh fit never takes exactly as long, so the
// probe reported "0 identical" on a folder whose fits had not changed, and every
// rebuild re-fitted every file.

import {packForCache, sameFittedRow} from "../src/analysis/BotBenchCacheCodec";

const fitted = (overrides = {}) => ({
    label: "0.01deg/All/balloon_001.all.csv",
    quality: {frames: 401, noiseEstDeg: 0.0000928, rcond: NaN},
    top: {key: "lantern", errDeg: 0.0045, rangeStartM: 3780.3},
    maxRangeViolations: null,
    truthScore: {topRelSep: 0.00245, bestRelSep: Infinity},
    elapsedMs: 2073,
    fileSha256: {csv: "1b38", sidecar: "86d9", truth: "388d"},
    ...overrides,
});

describe("sameFittedRow", () => {
    test("a second fit of the same file matches, although it took a different time", () => {
        expect(sameFittedRow(fitted({elapsedMs: 4979}), packForCache(fitted()))).toBe(true);
    });

    test("the whole-row comparison the probe used fails on that same pair", () => {
        const stored = packForCache(fitted());
        expect(JSON.stringify(packForCache(fitted({elapsedMs: 4979})))).not.toBe(JSON.stringify(stored));
    });

    test("any other difference is still a mismatch", () => {
        const stored = packForCache(fitted());
        expect(sameFittedRow(fitted({top: {key: "lantern", errDeg: 0.0046, rangeStartM: 3780.3}}), stored)).toBe(false);
        expect(sameFittedRow(fitted({fileSha256: {csv: "ffff", sidecar: "86d9", truth: "388d"}}), stored)).toBe(false);
    });

    test("NaN and Infinity compare as themselves, not as null", () => {
        const stored = packForCache(fitted());
        expect(sameFittedRow(fitted({quality: {frames: 401, noiseEstDeg: 0.0000928, rcond: null}}), stored)).toBe(false);
        expect(sameFittedRow(fitted({truthScore: {topRelSep: 0.00245, bestRelSep: null}}), stored)).toBe(false);
    });

    test("the row passed in is not changed", () => {
        const row = fitted({elapsedMs: 4979});
        sameFittedRow(row, packForCache(fitted()));
        expect(row.elapsedMs).toBe(4979);
    });

    test("nothing to compare is not a match", () => {
        expect(sameFittedRow(null, packForCache(fitted()))).toBe(false);
        expect(sameFittedRow(fitted(), null)).toBe(false);
    });
});
