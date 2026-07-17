import {
    completenessBadges,
    effectiveErrDeg,
    formatRawLosResidual,
    groupAndRankHypotheses,
    hypothesisCategory,
    plausibilityRating,
    rankingExplanation,
    rankHypotheses,
    rankTieScore,
    tierBadge,
} from "../src/TraverseRanking";
import {KNOTS_TO_MS} from "../src/TraverseAnalysis";

function metrics({gRms = 0, gMax = 0, speedMeanKt = 100, speedMaxKt = speedMeanKt,
    turnStd = 0, verticalMean = 0} = {}) {
    return {
        gLoad: {min: 0, max: gMax, mean: gRms, rms: gRms, std: 0},
        airSpeed: {min: speedMeanKt * KNOTS_TO_MS, max: speedMaxKt * KNOTS_TO_MS,
            mean: speedMeanKt * KNOTS_TO_MS, rms: speedMeanKt * KNOTS_TO_MS, std: 0},
        verticalSpeed: {min: verticalMean, max: verticalMean, mean: verticalMean,
            rms: Math.abs(verticalMean), std: 0},
        turnRate: {min: 0, max: 0, mean: 0, rms: turnStd, std: turnStd},
        altitude: {min: 0, max: 0, mean: 0, rms: 0, std: 0},
        range: {min: 1000, max: 1000, mean: 1000, rms: 1000, std: 0},
    };
}

function hypothesis(key, opts = {}) {
    return {
        key,
        name: opts.name || key,
        track: new Float64Array([1, 2, 3]),
        metricsFull: opts.metrics || metrics(),
        errDeg: opts.errDeg ?? 0,
        params: opts.params || {},
        boundPinned: opts.boundPinned,
        boundInactive: opts.boundInactive,
        optimizerWarnings: opts.optimizerWarnings,
        identity: opts.identity,
    };
}

describe("Traverse ranking", () => {
    test("GoFast Constant Altitude passes the broad screen without using the generic reference as noise", () => {
        const h = hypothesis("constAlt", {
            errDeg: 0.0709515043,
            params: {errFloor: 0.4882653377},
            metrics: metrics({gRms: 0.19163989, gMax: 0.34959397,
                speedMeanKt: 233.6, speedMaxKt: 244.6, turnStd: 0.2359295}),
        });
        const first = plausibilityRating(h);
        expect(first.rank).toBe(3);
        expect(effectiveErrDeg(h)).toBeCloseTo(0.0209515043, 9);
        expect(formatRawLosResidual(h)).toContain("0.071°");

        // The generic CA residual is context only: changing it cannot alter the
        // screened residual, tier, or order score.
        h.params.errFloor = 20;
        const changed = plausibilityRating(h);
        expect(changed.rank).toBe(first.rank);
        expect(changed.scoredErrDeg).toBeCloseTo(first.scoredErrDeg, 12);
        expect(changed.secondaryScore).toBeCloseTo(first.secondaryScore, 12);
    });

    test("GoFast Balloon exposes and scores its raw residual; 250 fpm adds no climb penalty", () => {
        const h = hypothesis("lantern", {
            errDeg: 0.2973009753,
            params: {errFloor: 0.4882653377},
            metrics: metrics({gRms: 0.000003616, gMax: 0.000003937,
                speedMeanKt: 2.462, speedMaxKt: 2.463, turnStd: 0.000001338,
                verticalMean: 1.269052232}),
            boundPinned: ["shearPerM (max)"],
            boundInactive: ["vSink (max)"],
        });
        const r = plausibilityRating(h);
        expect(r.rank).toBe(1);                    // raw 0.297° > the 0.15° Low threshold
        expect(r.scoredErrDeg).toBeCloseTo(0.2973009753, 9);
        expect(rankTieScore(h)).toBeCloseTo(0.2973009753 / 0.05, 3);
        expect(formatRawLosResidual(h)).toBe("0.30° (0.61× generic reference 0.49°)");
        expect(rankingExplanation(h, r)).toContain("raw LOS residual 0.30°");
        expect(rankingExplanation(h, r)).toContain("vSink (max)");
    });

    test("inactive pins do not cap a tier, active unique constraints do", () => {
        const inactive = hypothesis("lantern", {boundInactive: ["vSink (max)"], errDeg: 0.01});
        expect(plausibilityRating(inactive).rank).toBe(3);

        const one = hypothesis("lantern", {boundPinned: ["wind shear (max)"], errDeg: 0.01});
        expect(plausibilityRating(one).rank).toBe(2);

        const two = hypothesis("lantern", {
            boundPinned: ["wind shear (max)", "vRise (max)"], errDeg: 0.01,
        });
        expect(plausibilityRating(two).rank).toBe(1);

        const unstable = hypothesis("lantern", {
            optimizerWarnings: ["wind shear (max)"], errDeg: 0.01,
        });
        const unstableRating = plausibilityRating(unstable);
        expect(unstableRating.rank).toBe(1);
        expect(unstableRating.incomplete).toBe(true);
        expect(completenessBadges(unstableRating).map((b) => b.label)).toContain("Optimizer incomplete");
    });

    test("peak rather than mean speed controls the broad screen", () => {
        const h = hypothesis("constAlt", {
            metrics: metrics({speedMeanKt: 100, speedMaxKt: 700}), errDeg: 0,
        });
        expect(plausibilityRating(h).rank).toBe(1);
        expect(rankingExplanation(h)).toContain("peak air speed 700 kt");
    });

    test("identity ordering ignores arbitrary display-track kinematics", () => {
        const clean = hypothesis("astroNow", {
            errDeg: 0.04, params: {object: "Moon", visible: true}, identity: true,
            metrics: metrics({gRms: 500, gMax: 900, speedMeanKt: 50000, turnStd: 1000}),
        });
        const gentle = {...clean, metricsFull: metrics()};
        expect(rankTieScore(clean)).toBeCloseTo(0.04, 12);
        expect(rankTieScore(gentle)).toBeCloseTo(0.04, 12);
        expect(plausibilityRating(clean).rank).toBe(3);
    });

    test("a fixed direction ignores the arbitrary finite helper-track kinematics", () => {
        const h = hypothesis("fixedPoint", {
            errDeg: 0.04,
            metrics: metrics({gRms: 500, gMax: 900, speedMeanKt: 50000, turnStd: 1000}),
        });
        h.atInfinity = true;
        const r = plausibilityRating(h);
        expect(r.rank).toBe(3);
        expect(r.kind).toBe("directional-geometry");
        expect(rankTieScore(h)).toBeCloseTo(0.04, 12);
    });

    test("results are grouped before ordering; no trajectory can globally outrank a forward model", () => {
        const groups = groupAndRankHypotheses([
            hypothesis("constAlt", {name: "Constant Altitude", errDeg: 0.01}),
            hypothesis("lantern", {name: "Balloon", errDeg: 0.01}),
            hypothesis("gfCA", {name: "Global CA", errDeg: 0.01}),
            hypothesis("satellite", {name: "Satellite", errDeg: 0.01,
                params: {satellite: "X", sunlit: true}, identity: true}),
        ]);
        expect(groups.map((g) => g.key)).toEqual(["trajectory", "forward", "catalogue", "diagnostic"]);
        expect(groups.map((g) => g.items[0].groupIndex)).toEqual([0, 0, 0, 0]);
        expect(hypothesisCategory(groups[1].items[0].h).key).toBe("forward");
    });

    test("incomplete search sorts behind a complete peer and never becomes eligible", () => {
        const incomplete = hypothesis("constAir", {
            name: "edge", errDeg: 0, params: {boundaryLimited: 1},
        });
        const complete = hypothesis("constAlt", {
            name: "resolved", errDeg: 0.3, metrics: metrics({gMax: 2}),
        });
        const ranked = rankHypotheses([incomplete, complete]);
        expect(ranked[0].h.name).toBe("resolved");
        expect(plausibilityRating(incomplete).eligible).toBe(false);
        expect(completenessBadges(plausibilityRating(incomplete))[0].label).toBe("Search incomplete");
    });

    test("Low and Moderate keep distinct badges; nonpassing sets receive no positive tie", () => {
        const low = plausibilityRating(hypothesis("lantern", {errDeg: 0.3}));
        const moderate = plausibilityRating(hypothesis("lantern", {errDeg: 0.1}));
        expect(tierBadge(low).label).toBe("Low");
        expect(tierBadge(moderate).label).toBe("Moderate");

        const ranked = rankHypotheses([
            hypothesis("lantern", {errDeg: 0.3}),
            hypothesis("aircraft", {errDeg: 0.301}),
        ]);
        expect(ranked.every((item) => !item.tied)).toBe(true);
        expect(ranked.every((item) => !item.r.eligible)).toBe(true);
    });

    test("different fit kinds cannot receive a shared display tie", () => {
        const direction = hypothesis("fixedPoint", {errDeg: 0.01});
        direction.atInfinity = true;
        const ray = hypothesis("constAlt", {errDeg: 0.0495});
        const ranked = rankHypotheses([direction, ray]);
        expect(ranked.every((item) => !item.tied)).toBe(true);
    });

    test("non-finite secondary metrics produce a stable invalid result", () => {
        const bad = hypothesis("constAlt", {metrics: metrics()});
        bad.metricsFull.gLoad.rms = NaN;
        const r = plausibilityRating(bad);
        expect(r.rank).toBe(-1);
        expect(r.secondaryScore).toBe(Infinity);
    });
});

describe("Truth-track mode", () => {
    // minimal comparable truthComparison record (as compareTrackToTruth returns)
    function comparison(scoreM, overrides = {}) {
        return {
            comparable: true,
            framesUsed: 300,
            frames: 300,
            score: scoreM,
            sep3D: {mean: scoreM, max: scoreM * 2},
            horizontal: {mean: scoreM * 0.8},
            altitude: {meanAbs: scoreM * 0.5, meanSigned: scoreM * 0.5},
            speed: {meanAbsDiff: 5, truthMean: 100},
            heading: {meanAbsDiff: 4, frames: 280},
            meanTruthRange: 10000,
            ...overrides,
        };
    }

    test("closeness to the truth track overrides the screening tiers", () => {
        // hClean passes the broad screen but sits far from truth; hUgly fails
        // the screen (high g) but matches truth closely — truth mode must put
        // hUgly first.
        const hClean = hypothesis("constAir", {errDeg: 0.01});
        hClean.truthComparison = comparison(5000);
        const hUgly = hypothesis("plausible", {
            errDeg: 0.01,
            metrics: metrics({gMax: 6}),   // Low tier on the broad screen
        });
        hUgly.truthComparison = comparison(120);
        const ranked = rankHypotheses([hClean, hUgly]);
        expect(ranked[0].h).toBe(hUgly);
        expect(ranked[1].h).toBe(hClean);
        expect(ranked.every((item) => !item.tied)).toBe(true);
    });

    test("not-comparable hypotheses fall to the end in truth mode", () => {
        const near = hypothesis("constAir", {errDeg: 0.01});
        near.truthComparison = comparison(300);
        const noOverlap = hypothesis("constAlt", {errDeg: 0.005});
        noOverlap.truthComparison = {comparable: false, note: "no overlap"};
        const ranked = rankHypotheses([noOverlap, near]);
        expect(ranked[0].h).toBe(near);
        expect(ranked[1].h).toBe(noOverlap);
    });

    test("without truth comparisons the ordering is unchanged (screen-driven)", () => {
        const good = hypothesis("constAir", {errDeg: 0.01});
        const bad = hypothesis("plausible", {errDeg: 0.01, metrics: metrics({gMax: 6})});
        const ranked = rankHypotheses([bad, good]);
        expect(ranked[0].h).toBe(good);
    });

    test("rank basis leads with the truth comparison and notes divergences", () => {
        const h = hypothesis("constAir", {errDeg: 0.01});
        // location tight, altitude way off (mostly above), speed close, heading close
        h.truthComparison = comparison(900, {
            sep3D: {mean: 900, max: 1500},
            horizontal: {mean: 40},
            altitude: {meanAbs: 880, meanSigned: 860},
            speed: {meanAbsDiff: 2, truthMean: 100},
            heading: {meanAbsDiff: 3, frames: 280},
        });
        const text = rankingExplanation(h);
        expect(text).toMatch(/^Truth track: mean 3D separation 900 m/);
        expect(text).toContain("ordered by this separation");
        expect(text).toContain("Concurs on location");
        expect(text).toContain("heading (mean Δ 3°)");
        expect(text).toContain("Diverges on altitude");
        expect(text).toContain("mostly above truth");
        expect(text).toContain("Broad screen:");
    });

    test("rank basis reports a not-comparable truth cleanly", () => {
        const h = hypothesis("fixedPoint", {errDeg: 0.01});
        h.truthComparison = {comparable: false, note: "direction-only hypothesis (at infinity); 3D separation is not meaningful"};
        const text = rankingExplanation(h);
        expect(text).toContain("Truth track: not comparable");
        expect(text).toContain("direction-only");
    });

    test("hover truth (no heading) is reported as not comparable for heading", () => {
        const h = hypothesis("quadcopter", {errDeg: 0.01});
        h.truthComparison = comparison(50, {heading: null});
        const text = rankingExplanation(h);
        expect(text).toContain("heading (not comparable — hover or stationary motion)");
    });

    test("NM formatting engages for large separations", () => {
        const h = hypothesis("constAir", {errDeg: 0.01});
        h.truthComparison = comparison(9260, {   // 5 NM
            sep3D: {mean: 9260, max: 18520},
            horizontal: {mean: 9000},
            altitude: {meanAbs: 200, meanSigned: -180},
            meanTruthRange: 20000,
        });
        const text = rankingExplanation(h);
        expect(text).toContain("mean 3D separation 5.0 NM");
        expect(text).toContain("max 10 NM");
    });
});
