/**
 * classProbability.test.js — the properties that make a percentage honest.
 *
 * The numbers this module produces will be read as "how likely is it that this
 * was a balloon". They are only defensible if: repeats of the same truth
 * content cannot outvote distinct content; the train/test split cannot leak;
 * a thin bin abstains instead of guessing; a class the benchmark cannot cover
 * reports "not calibrated" rather than 0%; and the band width is bought at the
 * least width that reaches the coverage target.
 */

import {
    REPORT_CLASSES, TRUTH_TO_CLASS, UNMAPPED_LABELS, UNCALIBRATED_CLASSES,
    truthLabelOf, classOfTruth, assignGroups, splitByGroup, weightedDistribution,
    clusterBootstrap, buildCalibration, predictDistribution, formatDistribution,
    calibrateK, isValidCalibration, configKey, MIN_GROUPS,
} from "../../benchmarks/botbench/lib/classProbability";
import {signatureKey} from "../../benchmarks/botbench/lib/verdictRunner";

const sig = (code, viable, cons = "high") => ({
    code, viable, consistency: cons, rangeUnobservable: false,
    bands: {"lantern|free": "collapsed", "quadcopter|": "wide", "aircraft|": "none"},
});

// A record as the bulk runner emits it, reduced to what calibration reads.
function rec(family, {code = "consistent-one", viable = "balloon", seed = 101,
    kind = "party-neutral", rangeM = 5000, anomalous = undefined} = {}) {
    return {
        signature: sig(code, viable),
        spec: {
            platform: {kind: "orbit-point", speedMS: 70},
            target: {kind, family, parameters: anomalous === undefined ? {} : {anomalous}},
            wind: {kind: "fixed"}, initialHorizontalRangeM: rangeM, scenarioSeed: seed,
        },
    };
}

describe("taxonomy", () => {
    test("only the three labels with a real Sitrec class are mapped", () => {
        expect(Object.keys(TRUTH_TO_CLASS).sort()).toEqual(["aircraft", "balloon", "venus"]);
        expect(classOfTruth("balloon")).toBe("balloon");
        expect(classOfTruth("aircraft")).toBe("fixedWing");
        expect(classOfTruth("venus")).toBe("knownObject");
    });

    test("unmapped labels stay unmapped and each says why", () => {
        for (const label of ["bird", "aerostat", "anomalous"]) {
            expect(classOfTruth(label)).toBeNull();
            expect(UNMAPPED_LABELS[label]).toBeTruthy();
        }
    });

    test("an anomaly CONTROL is a different label from the anomaly itself", () => {
        // Both carry family "anomalous" in the spec; only the flag separates
        // them, and pooling them would mix an ordinary trajectory with an
        // impossible one under one label.
        expect(truthLabelOf({target: {family: "anomalous", parameters: {anomalous: true}}}))
            .toBe("anomalous");
        expect(truthLabelOf({target: {family: "anomalous", parameters: {anomalous: false}}}))
            .toBe("anomalous-control");
    });

    test("classes the benchmark cannot cover are named, not silently zero", () => {
        expect(UNCALIBRATED_CLASSES.multirotor).toMatch(/no multirotor target/);
        expect(UNCALIBRATED_CLASSES.multirotor).toMatch(/inverse crime/);
        expect(REPORT_CLASSES).toContain("multirotor");
    });
});

describe("grouping and weighting", () => {
    test("seeds of the same deterministic truth content collapse to one group", () => {
        const grouped = assignGroups([rec("balloon", {seed: 101}), rec("balloon", {seed: 102}),
            rec("balloon", {seed: 103})]);
        expect(new Set(grouped.map((g) => g.groupId)).size).toBe(1);
    });

    test("different truth content does not collapse", () => {
        const grouped = assignGroups([rec("balloon", {rangeM: 2000}),
            rec("balloon", {rangeM: 20000})]);
        expect(new Set(grouped.map((g) => g.groupId)).size).toBe(2);
    });

    test("a large repeat group cannot outvote a single distinct one", () => {
        // 8 seeds of ONE balloon content vs 1 aircraft content. Counting
        // scenarios would say 89% balloon; counting truth content says 50/50.
        const many = [];
        for (let s = 0; s < 8; s++) many.push(rec("balloon", {seed: 100 + s}));
        const grouped = assignGroups([...many, rec("aircraft", {kind: "aircraft-cruise"})]);
        const {dist, n, groups} = weightedDistribution(grouped);
        expect(n).toBe(9);
        expect(groups).toBe(2);
        expect(dist.balloon).toBeCloseTo(0.5, 6);
        expect(dist.fixedWing).toBeCloseTo(0.5, 6);
    });

    test("unmapped truth is counted as unknown, not dropped", () => {
        const grouped = assignGroups([rec("bird", {kind: "bird"}),
            rec("balloon", {rangeM: 2000})]);
        const {dist} = weightedDistribution(grouped);
        expect(dist.unknown).toBeCloseTo(0.5, 6);
        expect(dist.balloon).toBeCloseTo(0.5, 6);
        // The distribution is a distribution.
        expect(Object.values(dist).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    });
});

describe("splitting", () => {
    test("no truth-content group appears on both sides", () => {
        const records = [];
        for (let r = 0; r < 20; r++) {
            for (let s = 0; s < 3; s++) {
                records.push(rec(r % 2 ? "balloon" : "aircraft",
                    {seed: 100 + s, rangeM: 1000 + r * 500,
                        kind: r % 2 ? "party-neutral" : "aircraft-cruise"}));
            }
        }
        const {train, test} = splitByGroup(assignGroups(records));
        const trainGroups = new Set(train.map((r) => r.groupId));
        const testGroups = new Set(test.map((r) => r.groupId));
        for (const g of testGroups) expect(trainGroups.has(g)).toBe(false);
        expect(train.length + test.length).toBe(records.length);
        expect(testGroups.size).toBeGreaterThan(0);
    });

    test("the split is deterministic", () => {
        const records = assignGroups(Array.from({length: 30}, (_, i) =>
            rec("balloon", {rangeM: 1000 + i * 100})));
        const a = splitByGroup(records).test.map((r) => r.groupId).sort();
        const b = splitByGroup(records).test.map((r) => r.groupId).sort();
        expect(a).toEqual(b);
    });
});

describe("calibration lookup", () => {
    // 12 distinct balloon contents that all analyse the same way, plus 4
    // birds that analyse the same way — the bin should say "mostly balloon,
    // some unknown", with real support behind it.
    const build = () => {
        const records = [];
        for (let i = 0; i < 12; i++) {
            records.push(rec("balloon", {rangeM: 1000 + i * 100}));
        }
        for (let i = 0; i < 4; i++) {
            records.push(rec("bird", {kind: "bird", rangeM: 9000 + i * 100}));
        }
        return assignGroups(records);
    };

    test("a well-supported bin reports a distribution with an interval", () => {
        const cal = buildCalibration(build(), {signatureKey, draws: 60});
        const p = predictDistribution(cal, sig("consistent-one", "balloon"), {signatureKey});
        expect(p.calibrated).toBe(true);
        expect(p.backedOff).toBe(false);
        expect(p.groups).toBeGreaterThanOrEqual(MIN_GROUPS);
        expect(p.dist.balloon).toBeCloseTo(0.75, 6);
        expect(p.dist.unknown).toBeCloseTo(0.25, 6);
        expect(p.interval.balloon[0]).toBeLessThanOrEqual(p.dist.balloon);
        expect(p.interval.balloon[1]).toBeGreaterThanOrEqual(p.dist.balloon);
    });

    test("an unseen signature abstains to Unknown rather than guessing", () => {
        const cal = buildCalibration(build(), {signatureKey, draws: 20});
        const p = predictDistribution(cal, sig("unresolved", "none", "low"), {signatureKey});
        expect(p.calibrated).toBe(false);
        expect(p.dist.unknown).toBe(1);
        expect(p.groups).toBe(0);
    });

    test("a thin fine bin backs off to a coarser one that is a strict superset", () => {
        // One record with a distinctive band signature: too thin on its own, so
        // the lookup must fall back to the level that pools it with the rest.
        const records = build();
        const odd = {...rec("balloon", {rangeM: 5555}),
            signature: {...sig("consistent-one", "balloon"),
                bands: {"lantern|free": "disjoint", "quadcopter|": "none", "aircraft|": "none"}}};
        const cal = buildCalibration(assignGroups([...records, odd]), {signatureKey, draws: 20});
        const p = predictDistribution(cal, odd.signature, {signatureKey});
        expect(p.calibrated).toBe(true);
        expect(p.backedOff).toBe(true);
        expect(p.level).toBeGreaterThan(0);
        expect(p.groups).toBeGreaterThanOrEqual(MIN_GROUPS);
    });

    test("the formatted line reads the way an analyst would say it", () => {
        expect(formatDistribution({balloon: 0.4, fixedWing: 0.1, unknown: 0.5,
            multirotor: 0, stationary: 0, knownObject: 0}))
            .toBe("Unknown 50%, Balloon 40%, Fixed-wing 10%");
    });
});

describe("bootstrap", () => {
    test("intervals are deterministic for the same bin", () => {
        const r = assignGroups(Array.from({length: 10}, (_, i) =>
            rec(i < 6 ? "balloon" : "bird", {kind: i < 6 ? "party-neutral" : "bird",
                rangeM: 1000 + i * 100})));
        const a = clusterBootstrap(r, {draws: 80, seedKey: "bin-x"});
        const b = clusterBootstrap(r, {draws: 80, seedKey: "bin-x"});
        expect(a).toEqual(b);
    });

    test("a single group cannot produce an interval", () => {
        const r = assignGroups([rec("balloon"), rec("balloon", {seed: 102})]);
        const iv = clusterBootstrap(r, {draws: 20, seedKey: "one"});
        expect(iv.balloon).toEqual([null, null]);
    });

    test("resampling actually varies — a duplicate draw must keep its multiplicity", () => {
        // The bug this locks: resampling groups, concatenating their records,
        // then re-grouping by id collapses duplicates, so every replicate equals
        // the point estimate and the interval is degenerate. A degenerate
        // interval is worse than none — it asserts certainty that was never
        // measured.
        const r = assignGroups(Array.from({length: 6}, (_, i) =>
            rec(i < 3 ? "balloon" : "bird", {kind: i < 3 ? "party-neutral" : "bird",
                rangeM: 1000 + i * 100})));
        const iv = clusterBootstrap(r, {draws: 300, seedKey: "vary"});
        expect(iv.balloon[1] - iv.balloon[0]).toBeGreaterThan(0.1);
        // ...and it must still bracket the point estimate.
        const {dist} = weightedDistribution(r);
        expect(iv.balloon[0]).toBeLessThanOrEqual(dist.balloon);
        expect(iv.balloon[1]).toBeGreaterThanOrEqual(dist.balloon);
    });

    test("more independent groups give a tighter interval", () => {
        const make = (count) => assignGroups(Array.from({length: count}, (_, i) =>
            rec(i % 2 ? "balloon" : "bird", {kind: i % 2 ? "party-neutral" : "bird",
                rangeM: 1000 + i * 37})));
        const width = (n) => {
            const iv = clusterBootstrap(make(n), {draws: 300, seedKey: `w${n}`});
            return iv.balloon[1] - iv.balloon[0];
        };
        expect(width(40)).toBeLessThan(width(8));
    });
});

describe("band-width calibration", () => {
    test("picks the SMALLEST K that reaches the coverage target", () => {
        const out = calibrateK({"lantern|free": {1.2: 0.5, 1.5: 0.92, 2.0: 0.97, 3.0: 0.99}});
        expect(out["lantern|free"].K).toBe(1.5);
        expect(out["lantern|free"].reachedTarget).toBe(true);
    });

    test("a class that never reaches the target says so instead of widening", () => {
        const out = calibrateK({"aircraft|": {1.2: 0.2, 1.5: 0.35, 2.0: 0.5, 3.0: 0.61}});
        expect(out["aircraft|"].reachedTarget).toBe(false);
        expect(out["aircraft|"].K).toBe(3.0);
        expect(out["aircraft|"].coverage).toBeCloseTo(0.61, 6);
    });
});

describe("fail-closed artifact", () => {
    const key = configKey({K: 1.5});

    test("an artifact only validates against the config that produced it", () => {
        const art = {configKey: key, trainGroups: 40, levels: []};
        expect(isValidCalibration(art, key)).toBe(true);
        expect(isValidCalibration(art, configKey({K: 2.0}))).toBe(false);
    });

    test("a missing or thin artifact never validates", () => {
        expect(isValidCalibration(null, key)).toBe(false);
        expect(isValidCalibration({configKey: key, trainGroups: 2, levels: []}, key)).toBe(false);
        expect(isValidCalibration({configKey: key, trainGroups: 40}, key)).toBe(false);
    });
});
