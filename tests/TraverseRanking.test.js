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
