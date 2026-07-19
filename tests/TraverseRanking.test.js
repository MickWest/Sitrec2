import {
    balloonConsistency,
    completenessBadges,
    effectiveErrDeg,
    formatRawLosResidual,
    groupAndRankHypotheses,
    hypothesisCategory,
    plausibilityRating,
    rankingExplanation,
    rankAllHypotheses,
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

    test("hypotheses land in the five display categories", () => {
        const groups = groupAndRankHypotheses([
            hypothesis("constAlt", {name: "Constant Altitude", errDeg: 0.01}),
            hypothesis("lantern", {name: "Balloon", errDeg: 0.01}),
            hypothesis("gfCA", {name: "Global CA", errDeg: 0.01}),
            hypothesis("fixedPoint", {name: "Stationary Point", errDeg: 0.01}),
            hypothesis("satellite", {name: "Satellite", errDeg: 0.01,
                params: {satellite: "X", sunlit: true}, identity: true}),
        ]);
        // Array order is display priority: physical explanations lead.
        expect(groups.map((g) => g.key))
            .toEqual(["forward", "los", "geometric", "approximation", "catalogue"]);
        expect(groups.map((g) => g.label)).toEqual([
            "Physically based", "LOS Constrained", "Geometric",
            "Geometric Approximations", "Known Object",
        ]);
        expect(groups.map((g) => g.items[0].groupIndex)).toEqual([0, 0, 0, 0, 0]);
        // Every category needs a colour — it is the tile's only category cue
        // now that the section headings are gone.
        expect(groups.every((g) => /^#[0-9a-f]{6}$/i.test(g.color))).toBe(true);
    });

    test("the gallery order is flat and best-first, not grouped", () => {
        // A strong physical model, a weaker LOS-constrained one. Grouped
        // ordering could only ever interleave by section; the flat order must
        // put the better candidate first wherever it comes from.
        const items = rankAllHypotheses([
            hypothesis("constAlt", {name: "Constant Altitude", errDeg: 0.01}),
            hypothesis("lantern", {name: "Balloon", errDeg: 0.01}),
            hypothesis("gfCA", {name: "Global CA", errDeg: 0.4,
                metrics: metrics({gMax: 5})}),
        ]);
        expect(items.map((x) => x.h.name)).toEqual(["Balloon", "Constant Altitude", "Global CA"]);
        // Each tile still reports its standing WITHIN its own category, which is
        // the only place a score comparison is sound.
        expect(items.map((x) => `${x.groupIndex + 1}/${x.groupSize}`)).toEqual(["1/1", "1/1", "1/1"]);
    });

    test("a catalogue identity cannot leapfrog on an incommensurable score", () => {
        // rankTieScore returns raw DEGREES for an identity hypothesis but a
        // composite (straightFlightScore + err/0.05) for a forward model. Sorted
        // on that number directly, the satellite's 0.05 beats the balloon's
        // larger composite and a planet would head the gallery on units alone.
        // Category priority must break the tie before secondaryScore is reached.
        const items = rankAllHypotheses([
            hypothesis("satellite", {name: "Satellite", errDeg: 0.05,
                params: {satellite: "X", sunlit: true}, identity: true}),
            hypothesis("lantern", {name: "Balloon", errDeg: 0.01}),
        ]);
        expect(items.map((x) => x.h.name)).toEqual(["Balloon", "Satellite"]);
        // Guard the premise: the scores really are on different scales, so this
        // test would fail without the priority tiebreak rather than pass by luck.
        const sat = items.find((x) => x.h.name === "Satellite");
        const balloon = items.find((x) => x.h.name === "Balloon");
        expect(sat.r.secondaryScore).toBeLessThan(balloon.r.secondaryScore);
    });

    test("a truth track overrides category priority in the flat order", () => {
        // Truth separation in metres IS comparable across categories, so it
        // must beat the priority tiebreak: a closer LOS-constrained fit outranks
        // a more distant physical one.
        const near = hypothesis("constAlt", {name: "Constant Altitude", errDeg: 0.01});
        near.truthComparison = {comparable: true, score: 40};
        const far = hypothesis("lantern", {name: "Balloon", errDeg: 0.01});
        far.truthComparison = {comparable: true, score: 900};
        expect(rankAllHypotheses([far, near]).map((x) => x.h.name))
            .toEqual(["Constant Altitude", "Balloon"]);
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

    test("completeness does NOT rescue a candidate that failed the broad screen", () => {
        // The companion to the test above, and the boundary between them.
        // Completeness outranking plausibility is intended for FINE distinctions
        // (an incomplete Moderate really should sit behind a complete Low), but
        // it must not let a candidate the screen rejected outright lead over one
        // that passed. Slow, weakly-constrained families are the ones that reach
        // search edges, so an absolute completeness-first rule buries the mundane
        // answer precisely where it is most likely to be correct.
        const implausibleButComplete = hypothesis("constAlt", {
            name: "implausible", errDeg: 0.02,
            metrics: metrics({gMax: 12, speedMaxKt: 1400}),
        });
        const plausibleButIncomplete = hypothesis("constAir", {
            name: "mild", errDeg: 0.02, params: {boundaryLimited: 1},
            metrics: metrics({gMax: 0.4}),
        });
        expect(plausibilityRating(implausibleButComplete).rank).toBe(0);
        expect(plausibilityRating(plausibleButIncomplete).rank).toBeGreaterThanOrEqual(1);

        const ranked = rankHypotheses([implausibleButComplete, plausibleButIncomplete]);
        expect(ranked[0].h.name).toBe("mild");
        // It leads, but it must still say why it is provisional.
        expect(completenessBadges(plausibilityRating(plausibleButIncomplete))[0].label)
            .toBe("Search incomplete");
    });

    test("the badge names whichever of fit or kinematics is binding", () => {
        // Ordinary motion (0 g, 100 kt), poor residual. The evidence is about
        // the FIT, so the badge must not say something about the object. This
        // is the real case that motivated the split: a quadcopter drifting at
        // 6 kt / 0.09 g — closest of five to truth — read as "Implausible".
        const poorFit = plausibilityRating(hypothesis("lantern", {errDeg: 0.9}));
        expect(poorFit.label).toBe("Poor fit");
        expect(poorFit.rank).toBe(0);
        expect(poorFit.fitRank).toBe(0);
        expect(poorFit.kinematicRank).toBe(3);

        // Exact fit, extraordinary motion. Now the badge SHOULD talk about the
        // motion — and it must be distinguishable from a fit that diverged,
        // which previously shared both this badge and this sort position.
        const extreme = plausibilityRating(hypothesis("lantern", {
            errDeg: 0.01, metrics: metrics({gMax: 12}),
        }));
        expect(extreme.label).toBe("Kinematically extreme");
        expect(extreme.fitRank).toBe(3);
        expect(extreme.kinematicRank).toBe(0);
        expect(extreme.label).not.toBe(poorFit.label);

        // The tier itself is still the worse of the two, so ordering and
        // eligibility are unchanged by the relabelling.
        expect(extreme.rank).toBe(0);

        const low = plausibilityRating(hypothesis("lantern", {errDeg: 0.3}));
        const moderate = plausibilityRating(hypothesis("lantern", {errDeg: 0.1}));
        expect(tierBadge(low).label).toBe("Weak fit");
        expect(tierBadge(moderate).label).toBe("Fair fit");
        expect(low.rank).toBe(1);
        expect(moderate.rank).toBe(2);

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

// A balloon is physically constrained to a steady vertical trend and a
// one-direction drift; a drone is not. When two physical fits are otherwise
// close, that signature is evidence for the balloon, so it earns a bounded
// promotion — and an un-balloon-like "balloon" (vertical reversal, curved drift)
// is demoted the same amount. The nudge lives in secondaryScore, which the
// comparator only consults after the tier ties, so it can reorder equally-good
// fits but never lift a balloon over a clearly-better one.
describe("balloon-consistency scoring", () => {
    // Flat [x,y,z]*n track in the shapes the metric must tell apart.
    function shapeTrack(mode, n = 80) {
        const t = new Float64Array(n * 3);
        for (let f = 0; f < n; f++) {
            const s = n === 1 ? 0 : f / (n - 1);
            if (mode === "balloon") { t[f * 3] = 1200 * s; t[f * 3 + 1] = 0; t[f * 3 + 2] = 300 + 120 * s; }
            else if (mode === "level") { t[f * 3] = 1200 * s; t[f * 3 + 1] = 0; t[f * 3 + 2] = 300; }
            else if (mode === "oscillate") { t[f * 3] = 1200 * s; t[f * 3 + 1] = 0; t[f * 3 + 2] = 300 + 200 * Math.sin(4 * Math.PI * s); }
            else if (mode === "circle") { const a = 2 * Math.PI * s; t[f * 3] = 500 * Math.cos(a); t[f * 3 + 1] = 500 * Math.sin(a); t[f * 3 + 2] = 300 + 120 * s; }
            else if (mode === "hover") { t[f * 3] = 0; t[f * 3 + 1] = 0; t[f * 3 + 2] = 300; }
        }
        return t;
    }

    // Slow, gentle metrics so the kinematic tier is always "passes" and the fit
    // residual (errDeg) is what sets the tier — isolating the nudge.
    const gentle = () => metrics({gRms: 0.02, gMax: 0.1, speedMeanKt: 8, speedMaxKt: 12});

    function buoyant(mode, errDeg) {
        const h = hypothesis("lantern", {errDeg, metrics: gentle()});
        h.track = shapeTrack(mode);
        return h;
    }

    test("scores a steady rise + one-direction drift high, oscillation and circling low", () => {
        expect(balloonConsistency(shapeTrack("balloon"))).toBeGreaterThan(0.9);
        expect(balloonConsistency(shapeTrack("level"))).toBeGreaterThan(0.9);   // level is balloon-like
        expect(balloonConsistency(shapeTrack("oscillate"))).toBeLessThan(0.5);  // up-and-down is not
        expect(balloonConsistency(shapeTrack("circle"))).toBeLessThan(0.5);     // circling is not
    });

    test("a balloon-like buoyant fit is promoted and an un-balloon-like one demoted, symmetrically", () => {
        const like = plausibilityRating(buoyant("balloon", 0.3)).secondaryScore;
        const notLike = plausibilityRating(buoyant("oscillate", 0.3)).secondaryScore;
        // Same fit, same kinematics — only the shape differs. The promotion and
        // demotion straddle the un-nudged base by the full nudge each way.
        const base = plausibilityRating({...buoyant("balloon", 0.3), key: "quadcopter"}).secondaryScore;
        expect(like).toBeLessThan(base);
        expect(notLike).toBeGreaterThan(base);
        // C=1 gives -6, C=0 gives +6: the two straddle the base by the full nudge.
        expect(base - like).toBeCloseTo(6, 5);
        expect(notLike - base).toBeCloseTo(6, 5);
    });

    test("the nudge overturns a modest residual edge between same-tier physical fits", () => {
        // Balloon fits a little worse (0.42°) but its motion is textbook; the
        // drone fits better (0.22°) but both are the same fit tier. The balloon
        // should lead once the signature is weighed.
        const balloon = buoyant("balloon", 0.42);
        const drone = hypothesis("droneControl", {errDeg: 0.22, metrics: gentle()});
        drone.track = shapeTrack("balloon");   // drone flew the same path; it just isn't credited for looking like a balloon
        const order = rankAllHypotheses([drone, balloon]);
        expect(order[0].h.key).toBe("lantern");
        expect(order[1].h.key).toBe("droneControl");
    });

    test("but it cannot lift a balloon over a drone that fits a whole tier better", () => {
        const balloon = buoyant("balloon", 0.42);         // fitRank 1
        const drone = hypothesis("droneControl", {errDeg: 0.09, metrics: gentle()}); // fitRank 2 — better tier
        drone.track = shapeTrack("balloon");
        const order = rankAllHypotheses([balloon, drone]);
        expect(order[0].h.key).toBe("droneControl");      // tier gate wins; nudge can't cross it
    });

    test("a near-hover track is treated as neutral, not penalised", () => {
        // A calm-wind, neutrally-buoyant balloon barely moves: holds altitude and
        // barely drifts. Not distinctively balloon, but certainly not un-balloon,
        // so it scores neutral (0.5) rather than being pushed either way.
        expect(balloonConsistency(shapeTrack("hover"))).toBeCloseTo(0.5, 5);
        // A level track that DOES drift one way is fully balloon-like.
        expect(balloonConsistency(shapeTrack("level"))).toBeGreaterThan(0.9);
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
