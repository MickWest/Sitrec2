/**
 * compareWindVectorSeries — the pure wind-agreement metric behind the
 * balloon-evidence verdict. Each test targets a specific trap the metric was
 * designed to avoid (see the function comment in TraverseAnalysis.js):
 * opposite-direction winds with equal speeds, time-varying mismatches that
 * cancel into a matching mean, calm winds generating meaningless direction
 * penalties, and a static reference masquerading as temporal agreement.
 */
import {compareWindVectorSeries} from "../src/TraverseAnalysis";

const series = (pairs) => pairs.map((p) => (p ? {u: p[0], v: p[1]} : null));
const constant = (u, v, n) => series(Array.from({length: n}, () => [u, v]));

describe("compareWindVectorSeries", () => {

    test("identical series agree perfectly", () => {
        const w = constant(10, 5, 8);
        const m = compareWindVectorSeries(w, w);
        expect(m).not.toBeNull();
        expect(m.count).toBe(8);
        expect(m.coverage).toBeCloseTo(1);
        expect(m.vectorRMSE).toBeCloseTo(0);
        expect(m.speedBias).toBeCloseTo(0);
        expect(m.alignment).toBeCloseTo(1);
        expect(m.meanAbsDirDiffDeg).toBeCloseTo(0);
        expect(m.dirSamples).toBe(8);
        expect(m.bothMeanCalm).toBe(false);
    });

    test("equal speeds in opposite directions FAIL (the mean-speed trap)", () => {
        const req = constant(10, 0, 8);      // 10 m/s from the west
        const obs = constant(-10, 0, 8);     // 10 m/s from the east
        const m = compareWindVectorSeries(req, obs);
        // mean speeds are identical — the vector metrics must still condemn it
        expect(m.speedBias).toBeCloseTo(0);
        expect(m.vectorRMSE).toBeCloseTo(20);
        expect(m.alignment).toBeCloseTo(-1);
        expect(m.meanAbsDirDiffDeg).toBeCloseTo(180);
    });

    test("time-varying mismatch cannot cancel into a good mean", () => {
        // required is a steady 10 m/s easterly; observed alternates 0 / 20 —
        // the same MEAN speed and direction, but never actually agreeing.
        const req = constant(10, 0, 8);
        const obs = series([[0, 0], [20, 0], [0, 0], [20, 0], [0, 0], [20, 0], [0, 0], [20, 0]]);
        const m = compareWindVectorSeries(req, obs);
        expect(m.meanObservedSpeed).toBeCloseTo(m.meanRequiredSpeed);
        expect(m.vectorRMSE).toBeCloseTo(10);
        // required is constant, so temporal correlation must be withheld —
        // NOT reported as some spurious number
        expect(m.requiredVaries).toBe(false);
        expect(m.temporalCorrelation).toBeNull();
    });

    test("calm winds generate no direction statistic — and no alignment claim", () => {
        const req = constant(0.5, 0.3, 6);
        const obs = constant(-0.4, 0.2, 6);
        const m = compareWindVectorSeries(req, obs);
        expect(m.dirSamples).toBe(0);
        expect(m.meanAbsDirDiffDeg).toBeNull();
        // calm pairs must NOT be allowed to claim directional agreement
        expect(m.alignment).toBeNull();
        expect(m.bothMeanCalm).toBe(true);
        // and the vector error is honestly small — near-calm vs near-calm
        expect(m.vectorRMSE).toBeLessThan(1.2);
    });

    test("one calm side skips direction AND alignment but keeps the vector error", () => {
        const req = constant(15, 0, 6);      // strong required wind
        const obs = constant(0.5, 0, 6);     // near-calm observed
        const m = compareWindVectorSeries(req, obs);
        expect(m.dirSamples).toBe(0);        // direction undefined on the calm side
        expect(m.alignment).toBeNull();      // so alignment must not read as agreement
        expect(m.vectorRMSE).toBeCloseTo(14.5);
        expect(m.bothMeanCalm).toBe(false);
    });

    test("coincident gusts inside calm means still register direction samples", () => {
        // means are calm but one frame has a real above-calm pair —
        // bothMeanCalm alone must not be read as "both stayed calm"
        const req = series([[6, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0]]);
        const obs = series([[6, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0]]);
        const m = compareWindVectorSeries(req, obs);
        expect(m.bothMeanCalm).toBe(true);       // means are 1 m/s
        expect(m.dirSamples).toBe(1);            // but a real above-calm pair exists
        expect(m.alignment).toBeCloseTo(1);
    });

    test("OFFSET gusts hide from means and direction pairs — the RMSE must expose them", () => {
        // gusts on DIFFERENT frames: calm means, zero direction pairs (no
        // frame has both sides above threshold), yet the winds never agree.
        // The vector RMSE is the only statistic left standing — the rating
        // must consult it before calling a calm comparison "compatible".
        const req = series([[12, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0]]);
        const obs = series([[0, 0], [12, 0], [0, 0], [0, 0], [0, 0], [0, 0]]);
        const m = compareWindVectorSeries(req, obs);
        expect(m.bothMeanCalm).toBe(true);              // means are 2 m/s
        expect(m.dirSamples).toBe(0);                   // never both strong at once
        expect(m.vectorRMSE).toBeCloseTo(Math.sqrt(288 / 6), 1);  // ≈ 6.9 m/s
    });

    test("missing samples reduce coverage; too few pairs is structured, not null", () => {
        const req = series([[10, 0], null, [10, 0], null, [10, 0], null]);
        const obs = constant(10, 0, 6);
        const m = compareWindVectorSeries(req, obs);
        expect(m.comparable).toBe(true);
        expect(m.count).toBe(3);
        expect(m.coverage).toBeCloseTo(0.5);

        // the failure path keeps the bookkeeping an "inconclusive" verdict needs
        const tooFew = compareWindVectorSeries(series([[10, 0], [10, 0]]), constant(10, 0, 2));
        expect(tooFew.comparable).toBe(false);
        expect(tooFew.reason).toBe("insufficient-pairs");
        expect(tooFew.count).toBe(2);
        expect(tooFew.total).toBe(2);
        expect(compareWindVectorSeries([], []).comparable).toBe(false);
        expect(compareWindVectorSeries(null, null).comparable).toBe(false);
    });

    test("unequal lengths compare the overlap, count the longer as total", () => {
        const m = compareWindVectorSeries(constant(10, 0, 4), constant(10, 0, 8));
        expect(m.count).toBe(4);
        expect(m.total).toBe(8);
        expect(m.coverage).toBeCloseTo(0.5);
    });

    test("direction difference wraps correctly across north", () => {
        // 359° vs 1° must be 2°, not 358°
        const d = (deg) => [10 * Math.sin(deg * Math.PI / 180), 10 * Math.cos(deg * Math.PI / 180)];
        const m = compareWindVectorSeries(
            series([d(359), d(359), d(359)]), series([d(1), d(1), d(1)]));
        expect(m.meanAbsDirDiffDeg).toBeCloseTo(2);
    });

    test("degenerate options are clamped, not honored", () => {
        // minPairs 0 must not admit an empty comparison full of NaN
        const empty = compareWindVectorSeries([], [], {minPairs: 0});
        expect(empty.comparable).toBe(false);
        // a negative variance floor must not make constants "vary"
        const m = compareWindVectorSeries(constant(10, 0, 6), constant(10, 0, 6),
            {varianceFloorMs: -1});
        expect(m.requiredVaries).toBe(false);
        expect(m.temporalCorrelation).toBeNull();
    });

    test("temporal correlation reported only when BOTH series vary", () => {
        // both vary, in phase: correlation near 1
        const ramp = series(Array.from({length: 10}, (_, i) => [5 + i, 0]));
        const inPhase = compareWindVectorSeries(ramp, ramp);
        expect(inPhase.requiredVaries).toBe(true);
        expect(inPhase.observedVaries).toBe(true);
        expect(inPhase.temporalCorrelation).toBeCloseTo(1);

        // both vary, in antiphase: correlation near -1 even though means match
        const rampDown = series(Array.from({length: 10}, (_, i) => [5 + (9 - i), 0]));
        const anti = compareWindVectorSeries(ramp, rampDown);
        expect(anti.temporalCorrelation).toBeLessThan(-0.9);

        // static observed (a single sounding profile): correlation withheld
        const staticObs = compareWindVectorSeries(ramp, constant(9.5, 0, 10));
        expect(staticObs.observedVaries).toBe(false);
        expect(staticObs.temporalCorrelation).toBeNull();
    });

    test("alignment is magnitude-weighted (a strong disagreeing sample dominates)", () => {
        // five weak agreeing samples, one strong opposing one
        const req = series([[3, 0], [3, 0], [3, 0], [3, 0], [3, 0], [30, 0]]);
        const obs = series([[3, 0], [3, 0], [3, 0], [3, 0], [3, 0], [-30, 0]]);
        const m = compareWindVectorSeries(req, obs);
        expect(m.alignment).toBeLessThan(0);   // the big opposing pair outweighs the small agreements
    });
});
