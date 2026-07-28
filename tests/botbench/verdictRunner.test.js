/**
 * verdictRunner.test.js — the headless bulk path.
 *
 * The point of this suite is that the bulk numbers come from the SHIPPING
 * analysis, not from a benchmark re-implementation of it: runVerdict must
 * reach buildHypotheses / rankAllHypotheses / assessExecutiveVerdict on a
 * generated scenario with no scene, no node graph and no three.js.
 *
 * It also locks the two things a coverage claim depends on: that truth is
 * scored AFTER the fact and never reaches the analysis, and that the signature
 * bins are stable and countable.
 */

import {setSit} from "../../src/Globals";
import {generateScenario} from "../../benchmarks/botbench/lib/generateScenario";
import {
    runVerdict, truthReference, familyCoverage, bandBucket, consistencyBucket,
    buildSignature, signatureKey, MAX_BACKOFF_LEVEL, ABSENT_HYPOTHESES,
} from "../../benchmarks/botbench/lib/verdictRunner";
import {toTraverseDataset} from "../../benchmarks/botbench/lib/adapters";

const BALLOON_SPEC = {
    epochISO: "2025-02-01T20:00:00Z", durationSeconds: 30, fps: 10,
    initialHorizontalRangeM: 5000, siteId: "ocean",
    platform: {kind: "orbit-point", speedMS: 70, altitudeAGL: 3000},
    target: {kind: "party-neutral", family: "balloon", parameters: {startAGL: 500}},
    wind: {kind: "fixed"},
    observation: {kind: "white", fovFullDeg: 0.5, gaussianSigmaDeg: 0.03},
};

beforeAll(() => {
    // The scenario GENERATOR needs Sit.lat (BalloonPhysics reaches
    // getLocalNorthVector). The analysis itself is handed nothing global.
    setSit({name: "headless", frames: 10000, fps: 10, simSpeed: 1, lat: 40, lon: -105});
});

describe("signature bins", () => {
    test("consistency buckets split at the documented gates", () => {
        expect(consistencyBucket(0.2)).toBe("low");
        expect(consistencyBucket(0.5)).toBe("mid");
        expect(consistencyBucket(0.9)).toBe("high");
        expect(consistencyBucket(NaN)).toBe("na");
    });

    test("band buckets describe determination as a RATIO, not an absolute width", () => {
        // A 2 km scene and a 40 km scene with the same relative spread must
        // land in the same bin, or the calibration would be pooling scenes
        // that are nothing alike.
        const mk = (loM, hiM) => ({band: {screenedCount: 3, rangeLoM: loM, rangeHiM: hiM},
            intervals: [{loM, hiM, count: 3}], boundaryLimited: false});
        expect(bandBucket(mk(2000, 2100))).toBe("collapsed");
        expect(bandBucket(mk(40000, 42000))).toBe("collapsed");
        expect(bandBucket(mk(2000, 4000))).toBe("moderate");
        expect(bandBucket(mk(2000, 20000))).toBe("wide");
    });

    test("a disjoint or boundary-limited band is its own bin, never 'wide'", () => {
        expect(bandBucket({band: {screenedCount: 4, rangeLoM: 1000, rangeHiM: 9000},
            intervals: [{loM: 1000, hiM: 2000}, {loM: 8000, hiM: 9000}],
            boundaryLimited: false})).toBe("disjoint");
        expect(bandBucket({band: {screenedCount: 4, rangeLoM: 1000, rangeHiM: 9000},
            intervals: [{loM: 1000, hiM: 9000}], boundaryLimited: true})).toBe("boundary");
        expect(bandBucket(null)).toBe("none");
    });

    test("backoff drops components in order and always terminates", () => {
        const sig = buildSignature({
            executive: {code: "consistent-several"},
            classes: [{key: "balloon", viable: true, consistency: 0.9},
                {key: "fixedWing", viable: false}],
            hypotheses: [], families: new Map(), provenance: {rangeUnobservable: false},
        });
        const keys = [];
        for (let l = 0; l <= MAX_BACKOFF_LEVEL; l++) keys.push(signatureKey(sig, l));
        // Strictly coarsening: each level is a prefix of the one before it.
        for (let i = 1; i < keys.length; i++) {
            expect(keys[i - 1].startsWith(keys[i])).toBe(true);
        }
        // The coarsest key still names the verdict and the viable classes —
        // below that there is nothing left to condition on.
        expect(keys[keys.length - 1]).toBe("code=consistent-several|viable=balloon");
    });
});

describe("truth handling", () => {
    test("scorable frames require BOTH truth validity and in-frame-ness", () => {
        const sc = generateScenario(BALLOON_SPEC, {scenarioSeed: 101});
        const truth = truthReference(sc);
        expect(truth.valid).toHaveLength(sc.n);
        for (let f = 0; f < sc.n; f++) {
            const expected = ((!sc.observation.inFov || sc.observation.inFov[f])
                && (!sc.target.valid || sc.target.valid[f])) ? 1 : 0;
            expect(truth.valid[f]).toBe(expected);
        }
    });

    test("coverage is measured against the band, and a wrong band is not covered", () => {
        const sc = generateScenario(BALLOON_SPEC, {scenarioSeed: 101});
        const dataset = toTraverseDataset(sc);
        const truth = truthReference(sc);
        const n = dataset.n;
        // Two synthetic bands: one built AROUND the truth ranges, one far off.
        const shift = (k) => {
            const t = new Float64Array(n * 3);
            for (let f = 0; f < n; f++) {
                for (let j = 0; j < 3; j++) {
                    const s = dataset.S[f * 3 + j], d = dataset.D[f * 3 + j];
                    const r = (sc.target.positionENU[f * 3] - dataset.S[f * 3]) * dataset.D[f * 3]
                        + (sc.target.positionENU[f * 3 + 1] - dataset.S[f * 3 + 1]) * dataset.D[f * 3 + 1]
                        + (sc.target.positionENU[f * 3 + 2] - dataset.S[f * 3 + 2]) * dataset.D[f * 3 + 2];
                    t[f * 3 + j] = s + d * (r * k);
                }
            }
            return t;
        };
        const band = (lo, hi) => {
            const members = [{screened: true, track: shift(lo)}, {screened: true, track: shift(hi)}];
            const env = new Float64Array(n * 2);
            for (let f = 0; f < n; f++) {
                const a = (members[0].track[f * 3] - dataset.S[f * 3]) * dataset.D[f * 3]
                    + (members[0].track[f * 3 + 1] - dataset.S[f * 3 + 1]) * dataset.D[f * 3 + 1]
                    + (members[0].track[f * 3 + 2] - dataset.S[f * 3 + 2]) * dataset.D[f * 3 + 2];
                const b = (members[1].track[f * 3] - dataset.S[f * 3]) * dataset.D[f * 3]
                    + (members[1].track[f * 3 + 1] - dataset.S[f * 3 + 1]) * dataset.D[f * 3 + 1]
                    + (members[1].track[f * 3 + 2] - dataset.S[f * 3 + 2]) * dataset.D[f * 3 + 2];
                env[f * 2] = Math.min(a, b); env[f * 2 + 1] = Math.max(a, b);
            }
            return {members, intervals: [{envelope: env}]};
        };
        const good = familyCoverage(dataset, new Map([["x", band(0.8, 1.2)]]), truth);
        const bad = familyCoverage(dataset, new Map([["x", band(3.0, 4.0)]]), truth);
        expect(good.perClass["x"].covered).toBe(true);
        expect(good.perClass["x"].coverageFrac).toBeCloseTo(1, 6);
        expect(bad.perClass["x"].covered).toBe(false);
        expect(bad.perClass["x"].coverageFrac).toBe(0);
    });
});

describe("runVerdict on a real scenario", () => {
    // The physics fits are the slow part; this is one scenario, not a sweep.
    test("produces a verdict, ranked hypotheses and bands from the shipping code", async () => {
        const sc = generateScenario(BALLOON_SPEC, {scenarioSeed: 101});
        const rec = await runVerdict(sc, {K: 1.5});

        expect(rec.truthFamily).toBe("balloon");
        expect(rec.hypotheses.length).toBeGreaterThan(5);
        expect(typeof rec.executive.code).toBe("string");
        expect(rec.signature.code).toBe(rec.executive.code);

        // The reduced profile is declared, not implied.
        expect(rec.absentHypotheses).toEqual(ABSENT_HYPOTHESES);

        // The balloon class can never claim "Probably" here: a generated wind
        // is a hand-set constant, so no independent corroboration exists. If
        // this ever passes, something started manufacturing that evidence.
        expect(rec.executive.code).not.toBe("probably-balloon");

        // At least one physics class produced a band, and every band names the
        // acceptance it was cut at.
        const banded = rec.hypotheses.filter((h) => h.band);
        expect(banded.length).toBeGreaterThan(0);
        for (const h of banded) {
            expect(Number.isFinite(h.band.acceptDeg)).toBe(true);
            expect(h.band.total).toBeGreaterThan(1);
            expect(h.band.screenedCount).toBeLessThanOrEqual(h.band.residualCount);
        }

        // Truth separation is reported per hypothesis but never used to order:
        // the ranking is the same one the gallery shows.
        expect(rec.hypotheses.some((h) => Number.isFinite(h.truthSepM))).toBe(true);
        expect(rec.familyCoverage).not.toBeNull();
    }, 600000);
});
