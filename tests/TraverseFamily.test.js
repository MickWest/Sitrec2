/**
 * TraverseFamily.test.js — the range-conditioned family tracer.
 *
 * The properties that matter are about HONESTY, not numerics: a degenerate
 * scene must produce a wide band, a decisive one a collapsed band, a bimodal
 * one two SEPARATE intervals (never one filled span across a gap that was
 * tested and rejected), and a march that follows the wrong basin must be
 * caught by the basin probe rather than silently reporting a narrow family.
 */

import {
    buildRangeLadder, rangeConditionedFamily, contiguousIntervals, losRangeAt,
    losRangeEnvelope, envelopeCoverage, acceptanceDeg, familyBandSummary, gapDisclosure,
} from "../src/TraverseFamily";
import {METERS_PER_NM} from "../src/TraverseAnalysis";

// A minimal straight-and-level sensor with sightlines pointing due north.
function makeDataset(n = 40) {
    const S = new Float64Array(n * 3);
    const D = new Float64Array(n * 3);
    const W = new Float64Array(n * 3);
    for (let f = 0; f < n; f++) {
        S[f * 3] = f * 10;              // sensor slides east
        D[f * 3 + 1] = 1;               // looking north
    }
    return {n, fps: 10, S, D, W};
}

// A track sitting at a fixed range down each ray.
function trackAtRange(ds, rangeM) {
    const t = new Float64Array(ds.n * 3);
    for (let f = 0; f < ds.n; f++) {
        for (let k = 0; k < 3; k++) {
            t[f * 3 + k] = ds.S[f * 3 + k] + rangeM * ds.D[f * 3 + k];
        }
    }
    return t;
}

describe("buildRangeLadder", () => {
    test("spans the bracket and always contains the anchor", () => {
        const {ranges} = buildRangeLadder({loM: 1000, hiM: 50000, anchorM: 7777});
        expect(ranges[0]).toBeCloseTo(1000, 6);
        expect(ranges[ranges.length - 1]).toBeCloseTo(50000, 6);
        expect(ranges.some((r) => Math.abs(r - 7777) < 1e-6)).toBe(true);
        expect(ranges.every((r, i) => i === 0 || r > ranges[i - 1])).toBe(true);
    });

    test("clips to the model's own bounds and says it did", () => {
        // The sweep routinely spans 2-45 NM; the lantern's initialRange stops at
        // 30 km. Rungs beyond that are an ENVELOPE limit, not a data limit.
        const {ranges, clippedHigh} = buildRangeLadder({
            loM: 2000, hiM: 80000, anchorM: 5000, modelHiM: 30000,
        });
        expect(clippedHigh).toBe(true);
        expect(Math.max(...ranges)).toBeLessThanOrEqual(30000);
    });

    test("an anchor beyond the searched bracket EXTENDS the ladder", () => {
        // The headline solved 9 km while the bracket stops at 8 km. Dropping the
        // anchor here is how a 9 km track gets published as the nearest rung.
        const {ranges, anchorOnLadder, anchorOutsideBracket} = buildRangeLadder({
            loM: 1000, hiM: 8000, anchorM: 9000, modelHiM: 30000,
        });
        expect(anchorOnLadder).toBe(true);
        expect(anchorOutsideBracket).toBe(true);
        expect(ranges).toContain(9000);
    });

    test("a near-duplicate collision is resolved in the anchor's favour", () => {
        // A log rung within the 0.5% dedupe tolerance must not evict the anchor.
        const base = buildRangeLadder({loM: 1000, hiM: 50000, anchorM: 5000}).ranges;
        const nearRung = base.find((r) => r > 1000 && r < 50000);
        const {ranges, anchorOnLadder} = buildRangeLadder({
            loM: 1000, hiM: 50000, anchorM: nearRung * 1.001,
        });
        expect(anchorOnLadder).toBe(true);
        expect(ranges).toContain(nearRung * 1.001);
    });

    test("an anchor outside the MODEL's bounds is reported as not on the ladder", () => {
        // The one case that cannot be honoured: the model cannot be evaluated
        // there at all. Say so rather than silently substituting a nearby rung.
        const {ranges, anchorOnLadder} = buildRangeLadder({
            loM: 1000, hiM: 20000, anchorM: 90000, modelHiM: 30000,
        });
        expect(anchorOnLadder).toBe(false);
        expect(ranges).not.toContain(90000);
    });

    test("NO rung is ever emitted outside the model's bounds", () => {
        // Bracket 40-50 km against a model that stops at 30 km: no overlap at
        // all. An emitted rung would be passed straight through as a paramLocks
        // value — which fitPhysicsModel writes into the parameter vector
        // WITHOUT clamping, since a locked coordinate is removed from the search
        // and nothing else bounds it. The model would be integrated outside its
        // own envelope and the answer published as an admitted range.
        const {ranges, noModelOverlap} = buildRangeLadder({
            loM: 40000, hiM: 50000, anchorM: 90000, modelHiM: 30000,
        });
        expect(ranges).toEqual([]);
        expect(noModelOverlap).toBe(true);

        // Same non-overlap, but the anchor IS inside the model bounds: that one
        // rung is legitimate and must survive.
        const withAnchor = buildRangeLadder({
            loM: 40000, hiM: 50000, anchorM: 25000, modelHiM: 30000,
        });
        expect(withAnchor.ranges).toEqual([25000]);
        expect(withAnchor.noModelOverlap).toBe(false);
        expect(withAnchor.anchorOnLadder).toBe(true);

        // And across a spread of bracket/bound combinations, nothing escapes.
        for (const loM of [200, 5000, 40000]) {
            for (const hiM of [3000, 20000, 90000]) {
                for (const anchorM of [NaN, 1000, 25000, 90000]) {
                    const r = buildRangeLadder({loM, hiM, anchorM,
                        modelLoM: 500, modelHiM: 30000});
                    for (const rung of r.ranges) {
                        expect(rung).toBeGreaterThanOrEqual(500);
                        expect(rung).toBeLessThanOrEqual(30000);
                    }
                }
            }
        }
    });
});

describe("LOS range geometry", () => {
    test("losRangeAt recovers the range a track was built at", () => {
        const ds = makeDataset();
        const t = trackAtRange(ds, 4321);
        expect(losRangeAt(ds, t, 0)).toBeCloseTo(4321, 6);
        expect(losRangeAt(ds, t, ds.n - 1)).toBeCloseTo(4321, 6);
    });

    test("envelope coverage is exact at the band edges and outside them", () => {
        const ds = makeDataset();
        const members = [{track: trackAtRange(ds, 2000)}, {track: trackAtRange(ds, 6000)}];
        const env = losRangeEnvelope(ds, members);
        expect(envelopeCoverage(ds, env, trackAtRange(ds, 4000)).coverageFrac).toBe(1);
        expect(envelopeCoverage(ds, env, trackAtRange(ds, 9000)).coverageFrac).toBe(0);
    });

    test("coverage counts only the frames the caller marks scorable", () => {
        const ds = makeDataset();
        const env = losRangeEnvelope(ds, [{track: trackAtRange(ds, 2000)}]);
        const valid = new Uint8Array(ds.n);
        for (let f = 0; f < 10; f++) valid[f] = 1;
        const {coverageFrac, framesScored} = envelopeCoverage(ds, env, trackAtRange(ds, 2000), valid);
        expect(framesScored).toBe(10);
        expect(coverageFrac).toBe(1);
    });
});

describe("contiguousIntervals", () => {
    test("a tested-and-rejected gap splits the family in two", () => {
        const members = [1, 2, 3, 4, 5].map((i) => ({rangeM: i * 1000, screened: i !== 3}));
        const iv = contiguousIntervals(members, (m) => m.screened);
        expect(iv).toHaveLength(2);
        expect(iv[0].loM).toBe(1000);
        expect(iv[0].hiM).toBe(2000);
        expect(iv[1].loM).toBe(4000);
        expect(iv[1].hiM).toBe(5000);
    });
});

describe("acceptanceDeg", () => {
    test("never tightens below the absolute floor", () => {
        expect(acceptanceDeg(0.0001, 1.5)).toBeCloseTo(0.05, 9);
    });
    test("scales with the best fit once that is the binding term", () => {
        expect(acceptanceDeg(1.0, 2.0)).toBeCloseTo(2.0, 9);
    });
});

describe("rangeConditionedFamily", () => {
    const ds = makeDataset();
    const ranges = [1000, 2000, 4000, 8000, 16000];

    // A perfectly ray-riding fit at every range: the degenerate case, and the
    // one the gallery used to present as a single answer.
    const perfectFit = async (rangeM) => ({track: trackAtRange(ds, rangeM), errDeg: 0.01});

    test("a degenerate scene reports the whole ladder as one wide band", async () => {
        const fam = await rangeConditionedFamily({dataset: ds, ranges, anchorM: 4000,
            fitAt: perfectFit});
        expect(fam.band.screenedCount).toBe(ranges.length);
        expect(fam.intervals).toHaveLength(1);
        expect(fam.band.rangeLoM).toBe(1000);
        expect(fam.band.rangeHiM).toBe(16000);
        expect(fam.boundaryLimited).toBe(true);
    });

    test("a decisive scene collapses to one rung", async () => {
        // Only 4 km fits; everything else is far off the rays.
        const fam = await rangeConditionedFamily({dataset: ds, ranges, anchorM: 4000,
            fitAt: async (r) => ({track: trackAtRange(ds, r),
                errDeg: r === 4000 ? 0.01 : 2.0})});
        expect(fam.band.screenedCount).toBe(1);
        expect(fam.band.rangeLoM).toBe(4000);
        expect(fam.boundaryLimited).toBe(false);
        // Decisive for the ranges SAMPLED — which is all a ladder can be.
        expect(familyBandSummary(fam)).toMatch(/only sampled range admitted/);
    });

    test("a gap of REJECTED rungs excludes those samples", async () => {
        const fam = await rangeConditionedFamily({dataset: ds, ranges, anchorM: 1000,
            fitAt: async (r) => ({track: trackAtRange(ds, r),
                errDeg: r === 4000 ? 3.0 : 0.01})});
        expect(fam.intervals).toHaveLength(2);
        expect(fam.gaps).toHaveLength(1);
        expect(fam.gaps[0]).toMatchObject({rejectedCount: 1, unfittedCount: 0, fullyTested: true});
        expect(fam.gaps[0].loM).toBe(4000);
        expect(fam.gaps[0].hiM).toBe(4000);
    });

    test("a gap containing a FAILED rung is not an exclusion", async () => {
        // Intervals break on a failed fit as well as a rejection, but only the
        // second is evidence. A failure constrains nothing, so the gap is
        // untested and callers must not describe it as excluded.
        const fam = await rangeConditionedFamily({dataset: ds, ranges, anchorM: 1000,
            fitAt: async (r) => (r === 4000 ? null
                : {track: trackAtRange(ds, r), errDeg: 0.01})});
        expect(fam.intervals).toHaveLength(2);
        expect(fam.gaps).toHaveLength(1);
        expect(fam.gaps[0]).toMatchObject({rejectedCount: 0, unfittedCount: 1, fullyTested: false});
    });

    // The reason a single flag is not enough: with three bands there are two
    // gaps, and they can mean opposite things. One aggregate verdict would make
    // a genuinely excluded gap and an untested one indistinguishable.
    test("MULTIPLE gaps are reported separately, each with its own status", async () => {
        const fam = await rangeConditionedFamily({dataset: ds,
            ranges: [1000, 2000, 4000, 8000, 16000], anchorM: 1000,
            fitAt: async (r) => {
                if (r === 2000) return {track: trackAtRange(ds, r), errDeg: 3.0};   // rejected
                if (r === 8000) return null;                                        // failed
                return {track: trackAtRange(ds, r), errDeg: 0.01};                  // admitted
            }});
        expect(fam.intervals).toHaveLength(3);
        expect(fam.gaps).toHaveLength(2);
        // First gap: a genuine rejection. Second: no fit at all.
        expect(fam.gaps[0]).toMatchObject({loM: 2000, rejectedCount: 1, unfittedCount: 0,
            fullyTested: true});
        expect(fam.gaps[1]).toMatchObject({loM: 8000, rejectedCount: 0, unfittedCount: 1,
            fullyTested: false});
    });

    test("a gap that is part rejected, part unfitted is not fully tested", async () => {
        const fam = await rangeConditionedFamily({dataset: ds,
            ranges: [1000, 2000, 4000, 8000, 16000], anchorM: 1000,
            fitAt: async (r) => {
                if (r === 2000) return {track: trackAtRange(ds, r), errDeg: 3.0};  // rejected
                if (r === 4000) return null;                                        // failed
                if (r === 8000) return {track: trackAtRange(ds, r), errDeg: 3.0};  // rejected
                return {track: trackAtRange(ds, r), errDeg: 0.01};
            }});
        expect(fam.gaps).toHaveLength(1);
        expect(fam.gaps[0]).toMatchObject({rejectedCount: 2, unfittedCount: 1, fullyTested: false});
    });

    test("a bimodal scene reports two intervals, not one filled span", async () => {
        const fam = await rangeConditionedFamily({dataset: ds, ranges, anchorM: 1000,
            fitAt: async (r) => ({track: trackAtRange(ds, r),
                errDeg: r === 4000 ? 3.0 : 0.01})});
        expect(fam.intervals).toHaveLength(2);
        expect(familyBandSummary(fam)).toMatch(/disjoint bands/);
    });

    test("the physical screen narrows the band and the rejection is counted", async () => {
        const fam = await rangeConditionedFamily({dataset: ds, ranges, anchorM: 4000,
            fitAt: perfectFit,
            // Everything past 8 km would have to be underground.
            screen: (m) => ({ok: m.rangeM <= 8000, reason: "below the sampled terrain"})});
        expect(fam.band.screenedCount).toBe(4);
        expect(fam.band.residualCount).toBe(5);
        expect(fam.members.find((m) => m.rangeM === 16000).rejectReason)
            .toMatch(/below the sampled terrain/);
        expect(familyBandSummary(fam)).toMatch(/fail the physical screen/);
    });

    test("a fit that returns nothing at a rung is dropped, not counted as admissible", async () => {
        const fam = await rangeConditionedFamily({dataset: ds, ranges, anchorM: 4000,
            fitAt: async (r) => (r === 8000 ? null : {track: trackAtRange(ds, r), errDeg: 0.01})});
        expect(fam.band.fitted).toBe(4);
        expect(fam.band.total).toBe(5);
        expect(fam.members.some((m) => m.rangeM === 8000)).toBe(false);
    });

    test("a FAILED rung breaks the band — it must not splice its neighbours together", async () => {
        // The rung at 8 km produced no solution at all. Compacting it away
        // would leave 4 km and 16 km adjacent and report one band spanning
        // 1-16 km, claiming a model admits a range it was never shown to.
        const fam = await rangeConditionedFamily({dataset: ds, ranges, anchorM: 4000,
            fitAt: async (r) => (r === 8000 ? null : {track: trackAtRange(ds, r), errDeg: 0.01})});
        expect(fam.intervals).toHaveLength(2);
        expect(fam.intervals[0].hiM).toBe(4000);
        expect(fam.intervals[1].loM).toBe(16000);
        expect(familyBandSummary(fam)).toMatch(/disjoint bands/);
    });

    test("continuation seeds each rung from its solved neighbour", async () => {
        const seeds = [];
        await rangeConditionedFamily({dataset: ds, ranges, anchorM: 4000,
            fitAt: async (r, seed) => {
                seeds.push([r, seed ? seed.rangeM : null]);
                return {track: trackAtRange(ds, r), errDeg: 0.01, solved: {r}};
            }});
        // The anchor is fitted cold, then the march works outward from it.
        expect(seeds[0]).toEqual([4000, null]);
        expect(seeds[1]).toEqual([8000, 4000]);
        expect(seeds[2]).toEqual([16000, 8000]);
        expect(seeds[3]).toEqual([2000, 4000]);
        expect(seeds[4]).toEqual([1000, 2000]);
    });

    test("the basin probe catches a march that followed the wrong basin", async () => {
        // The march degrades away from the anchor, but a global search at the
        // far rung finds a far better solution — exactly the multimodal failure
        // that makes continuation alone unsafe.
        const marched = async (r) => ({track: trackAtRange(ds, r),
            errDeg: r === 16000 ? 4.0 : 0.02});
        const probe = async (r) => (r === 16000
            ? {track: trackAtRange(ds, r), errDeg: 0.02} : null);
        const fam = await rangeConditionedFamily({dataset: ds, ranges, anchorM: 1000,
            fitAt: marched, basinProbe: probe});
        expect(fam.basinCheck.probed).toBe(true);
        expect(fam.basinCheck.reseeded).toContain(16000);
        expect(fam.members.find((m) => m.rangeM === 16000).errDeg).toBeCloseTo(0.02, 9);
        expect(familyBandSummary(fam)).toMatch(/better solution basin/);
    });

    test("a basin re-march never overwrites the headline or reaches past it", async () => {
        // Measured on a live scene before this was bounded: a probe at the
        // 20 km rung re-marched all twelve rungs of a band whose anchor sat at
        // 6 km, discarding the headline and every solution on its far side.
        const headline = trackAtRange(ds, 4000);
        const fam = await rangeConditionedFamily({dataset: ds, ranges, anchorM: 4000,
            anchorFit: {track: headline, errDeg: 0.02, solved: {tag: "headline"}},
            // Everything the ordinary march produces is mediocre...
            fitAt: async (r) => ({track: trackAtRange(ds, r), errDeg: 1.0, solved: {tag: `march${r}`}}),
            // ...and a global probe at the top rung finds something far better,
            // which must propagate DOWN to but not through the anchor.
            basinProbe: async (r) => (r === 16000
                ? {track: trackAtRange(ds, r), errDeg: 0.03, solved: {tag: "probe"}} : null)});

        expect(fam.basinCheck.reseeded).toContain(16000);
        const at = (r) => fam.members.find((m) => m.rangeM === r);
        // The headline survives untouched.
        expect(at(4000).isHeadline).toBe(true);
        expect(at(4000).track).toBe(headline);
        expect(at(4000).errDeg).toBeCloseTo(0.02, 9);
        // Rungs BELOW the anchor were never reached by the inward re-march.
        expect(at(1000).solved.tag).toBe("march1000");
        expect(at(2000).solved.tag).toBe("march2000");
        // Exactly one headline member, still.
        expect(fam.members.filter((m) => m.isHeadline)).toHaveLength(1);
    });

    test("a re-march only replaces a rung it actually improves", async () => {
        // keepBetter: propagating a basin inward must be monotone, or a probe
        // that helps one end can quietly degrade rungs that were already right.
        const fam = await rangeConditionedFamily({dataset: ds, ranges, anchorM: 1000,
            fitAt: async (r) => ({track: trackAtRange(ds, r),
                // 8 km is already excellent; the re-march must not undo it.
                errDeg: r === 8000 ? 0.01 : 1.0}),
            basinProbe: async (r) => (r === 16000
                ? {track: trackAtRange(ds, r), errDeg: 0.02} : null)});
        expect(fam.basinCheck.reseeded).toContain(16000);
        expect(fam.members.find((m) => m.rangeM === 8000).errDeg).toBeCloseTo(0.01, 9);
    });

    test("the basin probe stays silent when the march was already right", async () => {
        const fam = await rangeConditionedFamily({dataset: ds, ranges, anchorM: 4000,
            fitAt: perfectFit,
            basinProbe: async (r) => ({track: trackAtRange(ds, r), errDeg: 0.01})});
        expect(fam.basinCheck.probed).toBe(true);
        expect(fam.basinCheck.reseeded).toHaveLength(0);
    });

    test("truth inside the traced band is reported as covered", async () => {
        const fam = await rangeConditionedFamily({dataset: ds, ranges, anchorM: 4000,
            fitAt: perfectFit});
        const env = fam.intervals[0].envelope;
        expect(envelopeCoverage(ds, env, trackAtRange(ds, 5000)).coverageFrac).toBe(1);
        expect(envelopeCoverage(ds, env, trackAtRange(ds, 40000)).coverageFrac).toBe(0);
    });

    test("the anchor rung IS the headline fit, not a re-fit from a geometric seed", async () => {
        // The gallery draws the headline track solid and the band faint around
        // it. If the anchor were re-solved from a different seed it could land
        // elsewhere, and the bundle would omit — or silently contradict — the
        // very track the tile is showing.
        const headline = trackAtRange(ds, 4000);
        let anchorRefitted = false;
        const fam = await rangeConditionedFamily({dataset: ds, ranges, anchorM: 4000,
            anchorFit: {track: headline, errDeg: 0.012, solved: {initialRange: 4000}},
            fitAt: async (r) => {
                if (r === 4000) anchorRefitted = true;
                return {track: trackAtRange(ds, r * 1.5), errDeg: 0.01};   // deliberately wrong
            }});
        expect(anchorRefitted).toBe(false);
        const anchor = fam.members.find((m) => m.rangeM === 4000);
        expect(anchor.isHeadline).toBe(true);
        expect(anchor.track).toBe(headline);
        expect(anchor.errDeg).toBeCloseTo(0.012, 9);
        // Exactly one member is the headline, so the drawing code cannot skip
        // the wrong one when it omits the solid track from the bundle.
        expect(fam.members.filter((m) => m.isHeadline)).toHaveLength(1);
    });

    test("a headline the ladder does not carry exactly is NOT attached to a nearby rung", async () => {
        // The ladder has no 9,000 m rung. Labelling the nearest one (8,000 m)
        // with a 9,000 m track publishes a distance that track does not have —
        // so the band must simply have no headline member.
        const headline = trackAtRange(ds, 9000);
        const fam = await rangeConditionedFamily({dataset: ds, ranges, anchorM: 9000,
            anchorFit: {track: headline, errDeg: 0.02},
            fitAt: async (r) => ({track: trackAtRange(ds, r), errDeg: 0.01})});
        expect(fam.headlineOnLadder).toBe(false);
        expect(fam.members.filter((m) => m.isHeadline)).toHaveLength(0);
        expect(fam.members.every((m) => m.track !== headline)).toBe(true);
    });

    test("a headline sitting ON a ladder end is not probed and survives", async () => {
        // stopBefore cannot protect an endpoint anchor: the march starts one
        // rung past it and never encounters it, so the probe would replace the
        // headline outright and then re-march the whole ladder.
        const headline = trackAtRange(ds, 1000);
        let probedAtAnchor = false;
        const fam = await rangeConditionedFamily({dataset: ds, ranges, anchorM: 1000,
            anchorFit: {track: headline, errDeg: 0.5, solved: {tag: "headline"}},
            fitAt: async (r) => ({track: trackAtRange(ds, r), errDeg: 1.0, solved: {tag: `m${r}`}}),
            basinProbe: async (r) => {
                if (r === 1000) probedAtAnchor = true;
                return {track: trackAtRange(ds, r), errDeg: 0.01, solved: {tag: "probe"}};
            }});
        expect(probedAtAnchor).toBe(false);
        expect(fam.basinCheck.skippedAtHeadline).toBe(true);
        const anchor = fam.members.find((m) => m.rangeM === 1000);
        expect(anchor.isHeadline).toBe(true);
        expect(anchor.track).toBe(headline);
        expect(fam.members.filter((m) => m.isHeadline)).toHaveLength(1);
        // The other end is still probed normally.
        expect(fam.basinCheck.reseeded).toContain(16000);
    });

    test("an empty ladder yields an empty band, never a fit at rung undefined", async () => {
        let called = false;
        const fam = await rangeConditionedFamily({dataset: ds, ranges: [], anchorM: 4000,
            fitAt: async () => { called = true; return null; }});
        expect(called).toBe(false);
        expect(fam.members).toEqual([]);
        expect(fam.band.screenedCount).toBe(0);
        expect(fam.band.total).toBe(0);
        expect(fam.headlineOnLadder).toBe(false);
    });

    test("cancellation propagates out of the march", async () => {
        await expect(rangeConditionedFamily({dataset: ds, ranges, anchorM: 4000,
            fitAt: perfectFit, shouldCancel: () => true})).rejects.toThrow("cancelled");
    });
});

describe("familyBandSummary", () => {
    test("a one-rung ladder says nothing about distance", async () => {
        // Reached in the app by pinning Min/Max Dist outside a model's own
        // envelope: the ladder collapses to the anchor alone. One rung that
        // passed out of one tried is not a measurement of anything.
        const ds2 = makeDataset();
        const fam = await rangeConditionedFamily({dataset: ds2, ranges: [4000], anchorM: 4000,
            fitAt: async (r) => ({track: trackAtRange(ds2, r), errDeg: 0.01})});
        expect(fam.band.screenedCount).toBe(1);
        expect(fam.band.total).toBe(1);
        const text = familyBandSummary(fam);
        expect(text).toMatch(/only .* could be tested/);
        expect(text).toMatch(/says nothing about the distance/);
    });

    // A LADDER IS A SAMPLE. Nothing this module emits may claim a resolved or
    // exact distance: an admitted rung shows that range works, never that the
    // untested ground between it and its rejected neighbour does not.
    test("a single survivor is reported as the only sampled range, not a resolved distance", async () => {
        const ds2 = makeDataset();
        const fam = await rangeConditionedFamily({dataset: ds2,
            ranges: [1000, 2000, 4000, 8000], anchorM: 4000,
            fitAt: async (r) => ({track: trackAtRange(ds2, r),
                errDeg: r === 4000 ? 0.01 : 3.0})});
        const text = familyBandSummary(fam);
        expect(text).toMatch(/only sampled range admitted/);
        expect(text).not.toMatch(/resolved/);
        // ...and it names the bracket the sampling actually established.
        expect(text).toMatch(/rejected below 1\.1 NM, above 4\.3 NM/);
        expect(text).toMatch(/resolution limit/);
    });

    test("a FAILED rung is not treated as a rejection when bracketing", async () => {
        // Fit failure establishes nothing about whether that range is
        // admissible, so an edge claim must not be anchored on it. The bracket
        // walks past it to the nearest range that was actually evaluated and
        // rejected.
        const ds2 = makeDataset();
        const fam = await rangeConditionedFamily({dataset: ds2,
            ranges: [1000, 2000, 4000, 8000, 16000], anchorM: 8000,
            fitAt: async (r) => {
                if (r === 4000) return null;                       // failed: tells us nothing
                if (r === 2000) return {track: trackAtRange(ds2, r), errDeg: 3.0};  // rejected
                if (r === 8000) return {track: trackAtRange(ds2, r), errDeg: 0.01}; // admitted
                return {track: trackAtRange(ds2, r), errDeg: 3.0};                  // rejected
            }});
        const iv = fam.intervals[0];
        expect([iv.loM, iv.hiM]).toEqual([8000, 8000]);
        // NOT 4000 — that rung failed and is no evidence of a boundary.
        expect(iv.outerLoM).toBe(2000);
        expect(iv.outerHiM).toBe(16000);
        const text = familyBandSummary(fam);
        expect(text).toMatch(/produced no fit and constrain nothing/);
    });

    test("a ONE-SIDED unbounded edge is disclosed in the prose, not just the data", async () => {
        // Every rung below the band failed, so nothing bounds that side. Naming
        // only the bracketed side leaves the other reading as bounded — and the
        // data field being null is no help if the sentence omits it.
        const ds2 = makeDataset();
        const fam = await rangeConditionedFamily({dataset: ds2,
            ranges: [1000, 2000, 4000, 8000], anchorM: 4000,
            fitAt: async (r) => (r < 4000 ? null
                : {track: trackAtRange(ds2, r), errDeg: r === 4000 ? 0.01 : 3.0})});
        const iv = fam.intervals[0];
        expect(iv.outerLoM).toBeNull();
        expect(iv.outerHiM).toBe(8000);
        const text = familyBandSummary(fam);
        expect(text).toMatch(/UNBOUNDED below/);
        expect(text).toMatch(/rejected above 4\.3 NM/);
        // The global note must not claim both edges are bracketed.
        expect(text).not.toMatch(/each band's true edges lie between it and its bracketing/);
        expect(text).toMatch(/where it is unbounded the band may extend further/);
    });

    test("a one-sided unbounded edge on the HIGH side is disclosed too", async () => {
        const ds2 = makeDataset();
        const fam = await rangeConditionedFamily({dataset: ds2,
            ranges: [1000, 2000, 4000, 8000], anchorM: 8000,
            fitAt: async (r) => (r > 4000 ? {track: trackAtRange(ds2, r), errDeg: 0.01}
                : (r === 4000 ? {track: trackAtRange(ds2, r), errDeg: 3.0} : null))});
        const text = familyBandSummary(fam);
        expect(text).toMatch(/UNBOUNDED above/);
        expect(text).toMatch(/rejected below 2\.2 NM/);
    });

    test("a band with no rejected sample on either side says so", async () => {
        const ds2 = makeDataset();
        const fam = await rangeConditionedFamily({dataset: ds2,
            ranges: [1000, 2000, 4000], anchorM: 2000,
            fitAt: async (r) => ({track: trackAtRange(ds2, r), errDeg: 0.01})});
        const text = familyBandSummary(fam);
        expect(text).toMatch(/UNBOUNDED both sides/);
        expect(text).toMatch(/may extend further in either direction/);
    });

    // Whatever the shape, an edge is either named with the rejected sample that
    // bounds it or explicitly called unbounded. Silence about a side is the bug.
    test("every interval edge is either bracketed or explicitly unbounded", async () => {
        const ds2 = makeDataset();
        const shapes = [
            (r) => 0.01,                                       // all pass: both sides open
            (r) => (r === 4000 ? 0.01 : 3),                     // middle only: both bracketed
            (r) => (r <= 2000 ? 0.01 : 3),                      // low end: open below
            (r) => (r >= 8000 ? 0.01 : 3),                      // high end: open above
        ];
        for (const fit of shapes) {
            const fam = await rangeConditionedFamily({dataset: ds2,
                ranges: [1000, 2000, 4000, 8000, 16000], anchorM: 4000,
                fitAt: async (r) => ({track: trackAtRange(ds2, r), errDeg: fit(r)})});
            const text = familyBandSummary(fam);
            for (const iv of fam.intervals) {
                const loStated = iv.outerLoM != null
                    ? text.includes(`below ${(iv.outerLoM / 1852).toFixed(1)} NM`)
                    : /UNBOUNDED below|UNBOUNDED both sides/.test(text);
                const hiStated = iv.outerHiM != null
                    ? text.includes(`above ${(iv.outerHiM / 1852).toFixed(1)} NM`)
                    : /UNBOUNDED above|UNBOUNDED both sides/.test(text);
                expect(loStated).toBe(true);
                expect(hiStated).toBe(true);
            }
        }
    });

    test("EVERY interval of a disjoint band gets its own bracket", async () => {
        // Quoting only the first interval's bracket leaves the rest reading as
        // exact — the same overstatement one level down.
        const ds2 = makeDataset();
        const fam = await rangeConditionedFamily({dataset: ds2,
            ranges: [1000, 2000, 4000, 8000, 16000, 32000], anchorM: 2000,
            fitAt: async (r) => ({track: trackAtRange(ds2, r),
                errDeg: (r === 2000 || r === 16000) ? 0.01 : 3.0})});
        expect(fam.intervals).toHaveLength(2);
        expect(fam.intervals[0].outerLoM).toBe(1000);
        expect(fam.intervals[0].outerHiM).toBe(4000);
        expect(fam.intervals[1].outerLoM).toBe(8000);
        expect(fam.intervals[1].outerHiM).toBe(32000);
        const text = familyBandSummary(fam);
        // BOTH brackets in the prose, not just the first interval's.
        expect(text).toMatch(/rejected below 0\.5 NM, above 2\.2 NM/);
        expect(text).toMatch(/rejected below 4\.3 NM, above 17\.3 NM/);
        expect(text).toMatch(/disjoint bands/);
    });

    test("intervals carry the outer bracket set by the nearest rejected samples", async () => {
        const ds2 = makeDataset();
        const fam = await rangeConditionedFamily({dataset: ds2,
            ranges: [1000, 2000, 4000, 8000, 16000], anchorM: 4000,
            fitAt: async (r) => ({track: trackAtRange(ds2, r),
                errDeg: (r === 2000 || r === 4000) ? 0.01 : 3.0})});
        const iv = fam.intervals[0];
        expect([iv.loM, iv.hiM]).toEqual([2000, 4000]);
        expect(iv.outerLoM).toBe(1000);
        expect(iv.outerHiM).toBe(8000);
    });

    test("an interval running off the ladder end has no outer bracket that side", async () => {
        const ds2 = makeDataset();
        const fam = await rangeConditionedFamily({dataset: ds2,
            ranges: [1000, 2000, 4000, 8000], anchorM: 1000,
            fitAt: async (r) => ({track: trackAtRange(ds2, r),
                errDeg: r <= 2000 ? 0.01 : 3.0})});
        const iv = fam.intervals[0];
        expect(iv.outerLoM).toBeNull();      // runs off the low end
        expect(iv.outerHiM).toBe(4000);
        expect(fam.boundaryLimited).toBe(true);
    });

    test("no summary anywhere claims a resolved or exact distance", async () => {
        const ds2 = makeDataset();
        const cases = [
            {ranges: [4000], fit: () => 0.01},                              // one rung
            {ranges: [1000, 2000, 4000, 8000], fit: (r) => (r === 4000 ? 0.01 : 3)},  // one survivor
            {ranges: [1000, 2000, 4000, 8000], fit: () => 0.01},            // all pass
            {ranges: [1000, 2000, 4000, 8000], fit: (r) => (r === 4000 ? 3 : 0.01)},  // disjoint
            {ranges: [1000, 2000, 4000, 8000], fit: () => 9},               // none pass
        ];
        for (const c of cases) {
            const fam = await rangeConditionedFamily({dataset: ds2, ranges: c.ranges,
                anchorM: c.ranges[0],
                fitAt: async (r) => ({track: trackAtRange(ds2, r), errDeg: c.fit(r)})});
            const text = familyBandSummary(fam) ?? "";
            expect(text).not.toMatch(/resolved/);
            expect(text).not.toMatch(/exactly/);
        }
    });

    // The overstatement always lives in the SENTENCE, not the counts, so these
    // assert the rendered prose.
    test("gap prose names the gap's own extent, never the admitted endpoints", async () => {
        const ds2 = makeDataset();
        // Admitted at 2 and 16 km; 4 and 8 km rejected. The gap is 4–8 km.
        // Labelling it "2.2–8.6 NM" would describe admitted rungs as rejected.
        const fam = await rangeConditionedFamily({dataset: ds2,
            ranges: [1000, 2000, 4000, 8000, 16000, 32000], anchorM: 2000,
            fitAt: async (r) => ({track: trackAtRange(ds2, r),
                errDeg: (r === 2000 || r === 16000) ? 0.01 : 3.0})});
        const text = gapDisclosure(fam);
        expect(fam.gaps[0]).toMatchObject({loM: 4000, hiM: 8000});
        expect(text).toMatch(/sampled ranges 2\.2–4\.3 NM/);      // 4 km – 8 km
        // The admitted endpoints (1.1 NM = 2 km, 8.6 NM = 16 km) must not
        // appear as part of the rejected span.
        expect(text).not.toMatch(/1\.1–/);
        expect(text).not.toMatch(/–8\.6 NM/);
    });

    test("a MULTI-rung rejected gap excludes its samples, not the ground between them", async () => {
        const ds2 = makeDataset();
        const fam = await rangeConditionedFamily({dataset: ds2,
            ranges: [1000, 2000, 4000, 8000, 16000], anchorM: 1000,
            fitAt: async (r) => ({track: trackAtRange(ds2, r),
                errDeg: (r === 2000 || r === 4000) ? 3.0 : 0.01})});
        expect(fam.gaps[0]).toMatchObject({rejectedCount: 2, unfittedCount: 0});
        const text = gapDisclosure(fam);
        expect(text).toMatch(/those samples are excluded/);
        expect(text).toMatch(/the unsampled ground between them is not/);
    });

    test("a SINGLE-rung rejected gap has no 'ground between' — it says so correctly", async () => {
        // One sample has no interior. The untested region is the unsampled
        // ranges either SIDE of it; the plural sentence would describe a
        // between-samples region that does not exist.
        const ds2 = makeDataset();
        const fam = await rangeConditionedFamily({dataset: ds2,
            ranges: [1000, 2000, 4000, 8000, 16000], anchorM: 1000,
            fitAt: async (r) => ({track: trackAtRange(ds2, r),
                errDeg: r === 4000 ? 3.0 : 0.01})});
        expect(fam.gaps[0]).toMatchObject({rejectedCount: 1, unfittedCount: 0});
        const text = gapDisclosure(fam);
        expect(text).toMatch(/the sampled range 2\.2 NM was rejected/);
        expect(text).toMatch(/that one sample is excluded/);
        expect(text).toMatch(/the unsampled ranges either side of it remain untested/);
        // No plural claim about a region that does not exist.
        expect(text).not.toMatch(/those samples/);
        expect(text).not.toMatch(/between them/);
    });

    test("an all-unfitted gap says nothing is excluded", async () => {
        const ds2 = makeDataset();
        const fam = await rangeConditionedFamily({dataset: ds2,
            ranges: [1000, 2000, 4000, 8000, 16000], anchorM: 1000,
            fitAt: async (r) => (r === 4000 ? null
                : {track: trackAtRange(ds2, r), errDeg: 0.01})});
        const text = gapDisclosure(fam);
        expect(text).toMatch(/produced no fit at all, so nothing there is excluded/);
        expect(text).toMatch(/untested, not ruled out/);
        expect(text).not.toMatch(/partly excluded/);
    });

    test("a MIXED gap excludes only the rejected samples, never a region", async () => {
        const ds2 = makeDataset();
        const fam = await rangeConditionedFamily({dataset: ds2,
            ranges: [1000, 2000, 4000, 8000, 16000], anchorM: 1000,
            fitAt: async (r) => {
                if (r === 2000) return {track: trackAtRange(ds2, r), errDeg: 3.0};  // rejected
                if (r === 4000) return null;                                        // failed
                if (r === 8000) return {track: trackAtRange(ds2, r), errDeg: 3.0};  // rejected
                return {track: trackAtRange(ds2, r), errDeg: 0.01};
            }});
        const text = gapDisclosure(fam);
        expect(text).toMatch(/only the rejected samples are excluded/);
        expect(text).toMatch(/unfitted ones plus the unsampled ground between them remain untested/);
        // "partly excluded" implies a continuous region is partly ruled out.
        expect(text).not.toMatch(/partly excluded/);
    });

    test("multiple gaps are numbered and described independently in the prose", async () => {
        const ds2 = makeDataset();
        const fam = await rangeConditionedFamily({dataset: ds2,
            ranges: [1000, 2000, 4000, 8000, 16000], anchorM: 1000,
            fitAt: async (r) => {
                if (r === 2000) return {track: trackAtRange(ds2, r), errDeg: 3.0};   // rejected
                if (r === 8000) return null;                                         // failed
                return {track: trackAtRange(ds2, r), errDeg: 0.01};
            }});
        const text = gapDisclosure(fam);
        expect(text).toMatch(/gap 1, the sampled range 1\.1 NM was rejected/);
        expect(text).toMatch(/gap 2, the sampled range 4\.3 NM produced no fit at all/);
    });

    test("contiguous bands produce no gap disclosure at all", async () => {
        const ds2 = makeDataset();
        const fam = await rangeConditionedFamily({dataset: ds2,
            ranges: [1000, 2000, 4000, 8000, 16000], anchorM: 4000,
            fitAt: async (r) => ({track: trackAtRange(ds2, r), errDeg: 0.01})});
        expect(fam.gaps).toEqual([]);
        expect(gapDisclosure(fam)).toBeNull();
    });

    test("no gap disclosure ever claims a continuous region is excluded", async () => {
        const ds2 = makeDataset();
        const shapes = [
            (r) => (r === 4000 ? 3 : 0.01),                              // rejected gap
            (r) => (r === 4000 ? null : 0.01),                           // unfitted gap
            (r) => (r === 2000 ? 3 : r === 4000 ? null : r === 8000 ? 3 : 0.01),  // mixed
        ];
        for (const shape of shapes) {
            const fam = await rangeConditionedFamily({dataset: ds2,
                ranges: [1000, 2000, 4000, 8000, 16000], anchorM: 1000,
                fitAt: async (r) => {
                    const e = shape(r);
                    return e === null ? null : {track: trackAtRange(ds2, r), errDeg: e};
                }});
            const text = gapDisclosure(fam) ?? "";
            expect(text).not.toMatch(/partly excluded/);
            expect(text).not.toMatch(/every range/);
            if (text) expect(text).toMatch(/sample|untested/);
        }
    });

    // A one-sample gap has no interior, so any "between them" / "those samples"
    // phrasing is describing a region that does not exist. Check every gap
    // shape, not just the one that was reported.
    test("no single-sample gap is ever described with plural or between-samples wording", async () => {
        const ds2 = makeDataset();
        const ladder = [1000, 2000, 4000, 8000, 16000];
        const shapes = [
            {label: "one rejected", fit: (r) => (r === 4000 ? 3 : 0.01)},
            {label: "one unfitted", fit: (r) => (r === 4000 ? null : 0.01)},
            {label: "two single-rung gaps",
                fit: (r) => (r === 2000 ? 3 : r === 8000 ? null : 0.01)},
        ];
        for (const {label, fit} of shapes) {
            const fam = await rangeConditionedFamily({dataset: ds2, ranges: ladder, anchorM: 1000,
                fitAt: async (r) => {
                    const e = fit(r);
                    return e === null ? null : {track: trackAtRange(ds2, r), errDeg: e};
                }});
            const text = gapDisclosure(fam) ?? "";
            const singleSampleGaps = fam.gaps.filter(
                (g) => g.rejectedCount + g.unfittedCount === 1);
            expect(singleSampleGaps.length).toBeGreaterThan(0);
            if (fam.gaps.every((g) => g.rejectedCount + g.unfittedCount === 1)) {
                expect(text).not.toMatch(/those samples/);
                expect(text).not.toMatch(/between them/);
                expect(text).not.toMatch(/were all rejected/);
            }
            expect(label).toBeTruthy();
        }
    });

    test("says plainly when nothing survived", async () => {
        const ds2 = makeDataset();
        const fam = await rangeConditionedFamily({dataset: ds2, ranges: [1000, 2000, 4000],
            anchorM: 2000,
            fitAt: async (r) => ({track: trackAtRange(ds2, r), errDeg: 5}),
            screen: () => ({ok: false, reason: "never plausible"})});
        expect(fam.band.screenedCount).toBe(0);
        expect(familyBandSummary(fam)).toMatch(/no tested range/);
    });

    test("reports NM units against the shared constant", () => {
        expect(METERS_PER_NM).toBe(1852);
    });
});
