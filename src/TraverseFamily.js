/**
 * TraverseFamily.js — range-conditioned solution families.
 *
 * A bearings-only clip does not generally determine one trajectory. For any
 * range function R(t) the path S(t) + R(t)·D(t) reproduces the sightlines
 * exactly, so range is pinned only once target dynamics are imposed — and then
 * only as far as those dynamics actually constrain it. The gallery has always
 * shown ONE representative track per interpretation, which reads as a confident
 * answer even when the evidence supports a wide family.
 *
 * This module traces that family the only way it can honestly be traced: hold
 * the start range at each rung of a ladder, refit everything else under the
 * SAME model, and keep the rungs whose fit stays acceptable. The result is
 * explicitly conditional on the model — a balloon band and a drone band answer
 * different questions and are never merged.
 *
 * DOM-free and node-graph-free, like TraverseHypotheses.js, so the same family
 * the gallery draws can be measured headless.
 */

import {trackMetrics, meanAngularError, METERS_PER_NM, KNOTS_TO_MS} from "./TraverseAnalysis";

// Ladder rungs. 11 is enough to see a band's shape without turning one fit into
// a dozen: the members are only ever read as an interval, never individually.
export const DEFAULT_LADDER_POINTS = 11;

/**
 * Log-spaced range ladder over [loM, hiM]. Rungs outside [modelLoM, modelHiM]
 * are dropped — a lantern cannot be fitted at 45 NM when its own initialRange
 * bound stops at 30 km, and pretending otherwise reports an envelope limit as a
 * data limit.
 *
 * `anchorM` (the headline fit's own solved range) is carried EXACTLY, and this
 * is load-bearing rather than a nicety. The caller labels the anchor rung with
 * the headline's track; if the ladder quietly moved the anchor — because it fell
 * outside the searched bracket, or because a log rung sat within the
 * near-duplicate tolerance and won — that track would be published under a
 * distance it does not have. So:
 *
 *   - an anchor beyond the bracket EXTENDS the ladder (the band must contain
 *     the answer the gallery is already showing), flagged as anchorOutsideBracket;
 *   - a near-duplicate collision is resolved in the ANCHOR's favour, never the
 *     evenly-spaced rung's.
 *
 * An anchor outside the MODEL's own bounds is the one case that cannot be
 * honoured — the model cannot be evaluated there at all — and is reported as
 * anchorOnLadder: false so the caller refuses to label any rung with it.
 */
export function buildRangeLadder({loM, hiM, anchorM, modelLoM = 0, modelHiM = Infinity,
    points = DEFAULT_LADDER_POINTS}) {
    const lo = Math.max(loM, modelLoM);
    const hi = Math.min(hiM, modelHiM);
    const clippedLow = lo > loM;
    const clippedHigh = hi < hiM;
    const anchorUsable = Number.isFinite(anchorM)
        && anchorM >= modelLoM && anchorM <= modelHiM && anchorM > 0;
    const anchorOutsideBracket = anchorUsable && (anchorM < lo || anchorM > hi);

    // The searched bracket and the model's own envelope do not overlap at all
    // (e.g. Min/Max Dist pinned to 25-30 NM against a quadcopter that stops at
    // 20 km). There is then no range at which this model can honestly be
    // evaluated, so the ladder is EMPTY and the caller skips the family.
    //
    // Emitting a rung anyway is the failure this guards: it would be passed
    // straight through as a paramLocks value, which fitPhysicsModel writes into
    // the parameter vector without clamping (the locked coordinate is removed
    // from the search, so nothing else bounds it). The model would be
    // integrated outside its own envelope and the result published as a valid
    // admitted range. The anchor is exempt only because anchorUsable already
    // requires it to lie inside the model bounds.
    if (!(hi > lo)) {
        return {ranges: anchorUsable ? [anchorM] : [], clippedLow, clippedHigh,
            anchorOnLadder: anchorUsable, anchorOutsideBracket,
            noModelOverlap: !anchorUsable};
    }

    const ranges = [];
    for (let i = 0; i < points; i++) {
        ranges.push(lo * Math.pow(hi / lo, i / (points - 1)));
    }
    if (anchorUsable) ranges.push(anchorM);
    ranges.sort((a, b) => a - b);

    // Collapse rungs the ladder cannot tell apart, keeping the anchor whenever
    // it collides with one — dropping it here is exactly how a headline track
    // ends up published under the wrong range.
    const isAnchor = (r) => anchorUsable && r === anchorM;
    const out = [];
    for (const r of ranges) {
        const prev = out.length ? out[out.length - 1] : null;
        if (prev === null || r > prev * 1.005) { out.push(r); continue; }
        if (isAnchor(r) && !isAnchor(prev)) out[out.length - 1] = r;   // anchor wins
    }
    return {ranges: out, clippedLow, clippedHigh,
        anchorOnLadder: anchorUsable && out.some(isAnchor),
        anchorOutsideBracket};
}

/**
 * Range along the sightline at frame f: how far down the ray this track sits.
 * Every family member rides essentially the same rays, so the whole family
 * collapses to a 1-D interval per frame — which is what makes containment
 * (does the truth track lie inside the band?) a cheap, exact test.
 */
export function losRangeAt(dataset, track, f) {
    const b = f * 3;
    return (track[b] - dataset.S[b]) * dataset.D[b]
        + (track[b + 1] - dataset.S[b + 1]) * dataset.D[b + 1]
        + (track[b + 2] - dataset.S[b + 2]) * dataset.D[b + 2];
}

/**
 * Per-frame min/max LOS range over a set of members, as a Float64Array(n*2)
 * laid out [min0, max0, min1, max1, ...].
 */
export function losRangeEnvelope(dataset, members) {
    const {n} = dataset;
    const env = new Float64Array(n * 2);
    for (let f = 0; f < n; f++) { env[f * 2] = Infinity; env[f * 2 + 1] = -Infinity; }
    for (const m of members) {
        for (let f = 0; f < n; f++) {
            const r = losRangeAt(dataset, m.track, f);
            if (!Number.isFinite(r)) continue;
            if (r < env[f * 2]) env[f * 2] = r;
            if (r > env[f * 2 + 1]) env[f * 2 + 1] = r;
        }
    }
    return env;
}

/**
 * Fraction of frames whose truth LOS range lies inside the envelope. `valid` is
 * the frame mask the caller considers scorable (truth coverage AND, for
 * benchmark data, in-frame-ness) — never all frames by default, because a
 * truth track that does not cover a frame would otherwise count as a miss.
 */
export function envelopeCoverage(dataset, env, truthTrack, valid = null, tolM = 0) {
    let inside = 0, total = 0;
    for (let f = 0; f < dataset.n; f++) {
        if (valid && !valid[f]) continue;
        const r = losRangeAt(dataset, truthTrack, f);
        if (!Number.isFinite(r)) continue;
        total++;
        if (r >= env[f * 2] - tolM && r <= env[f * 2 + 1] + tolM) inside++;
    }
    return {coverageFrac: total > 0 ? inside / total : NaN, framesScored: total};
}

/**
 * Maximal runs of consecutive admissible rungs. Reported as SEPARATE intervals
 * rather than one min/max span: a model that fits at 2 NM and again at 18 NM
 * but nowhere between is telling us something specific, and filling the gap
 * would invent solutions the search never found.
 *
 * A gap is NOT automatically an exclusion. It breaks on a rejected rung and
 * equally on one whose fit failed, and only the first is evidence — see
 * gapsFullyTested, which the caller must consult before describing a gap.
 */
export function contiguousIntervals(members, isAdmissible) {
    const out = [];
    let run = null;
    for (let i = 0; i < members.length; i++) {
        const m = members[i];
        if (isAdmissible(m)) {
            if (!run) {
                run = {loM: m.rangeM, hiM: m.rangeM, members: [m], loIndex: i, hiIndex: i};
                out.push(run);
            } else { run.hiM = m.rangeM; run.members.push(m); run.hiIndex = i; }
        } else {
            run = null;
        }
    }
    for (const r of out) r.count = r.members.length;
    return out;
}

/**
 * Attach each interval's OUTER bracket: the nearest range on either side that
 * was actually EVALUATED AND REJECTED.
 *
 * loM/hiM are the extent of the rungs that passed, and that is an inner bound.
 * The ladder samples discretely, so untested ranges between a passing rung and
 * a rejected one may pass too — the true edge lies somewhere in (outerLoM, loM]
 * and [hiM, outerHiM). Reporting loM/hiM as the boundary claims a precision the
 * sampling cannot support.
 *
 * A rung whose FIT FAILED is skipped over, not used as the bracket. Failure to
 * produce a solution is not a rejection: it establishes nothing about whether
 * that range is admissible, so anchoring an edge claim on it would assert a
 * boundary that was never measured. Walking past it to the nearest genuine
 * rejection stays sound — everything between that rejection and the band is
 * unconstrained either way, which is exactly what the bracket says.
 *
 * Null on a side means no rejected sample exists there at all: the interval
 * runs off the end of the ladder, or every rung beyond it failed to fit. Either
 * way that edge is unbracketed and must not be described as bounded.
 */
export function attachOuterBrackets(intervals, sortedRanges, members = null) {
    const rejectedAt = (i) => (members
        ? !!(members[i] && !members[i].screened)      // evaluated, and it failed the cut
        : true);                                     // no member info: every rung counts
    const nearestRejected = (from, step) => {
        for (let i = from; i >= 0 && i < sortedRanges.length; i += step) {
            if (rejectedAt(i)) return sortedRanges[i];
        }
        return null;
    };
    for (const iv of intervals) {
        iv.outerLoM = iv.loIndex > 0 ? nearestRejected(iv.loIndex - 1, -1) : null;
        iv.outerHiM = iv.hiIndex < sortedRanges.length - 1
            ? nearestRejected(iv.hiIndex + 1, +1) : null;
    }
    return intervals;
}

function spanOf(values) {
    const finite = values.filter(Number.isFinite);
    if (!finite.length) return {lo: NaN, hi: NaN};
    return {lo: Math.min(...finite), hi: Math.max(...finite)};
}

/** Range/altitude/speed extent of a member set, for the tile and report text. */
export function bandFromMembers(members) {
    const range = spanOf(members.map((m) => m.rangeM));
    const alt = spanOf(members.flatMap((m) => [m.metrics?.altitude?.min, m.metrics?.altitude?.max]));
    const speed = spanOf(members.flatMap((m) => [m.metrics?.airSpeed?.mean, m.metrics?.airSpeed?.max]));
    return {
        rangeLoM: range.lo, rangeHiM: range.hi,
        altLoM: alt.lo, altHiM: alt.hi,
        speedLoMS: speed.lo, speedHiMS: speed.hi,
    };
}

/**
 * Acceptance residual for a family, in degrees.
 *
 * There is no calibrated sightline noise floor in this analysis (params.errFloor
 * is a free constant-acceleration reference residual, explicitly NOT a noise
 * estimate), so the width cannot be DERIVED. It is set relative to the best fit
 * the model achieved, and the multiplier K is calibrated empirically against
 * benchmark truth coverage. Callers must record the K they used.
 */
export function acceptanceDeg(bestErrDeg, K) {
    if (!Number.isFinite(bestErrDeg)) return NaN;
    return Math.max(bestErrDeg * K, bestErrDeg + 0.02, 0.05);
}

/**
 * Trace a range-conditioned family.
 *
 * fitAt(rangeM, seedMember) -> {track, errDeg?, metrics?, solved?} | null
 *   The caller owns the model. seedMember is the previously solved neighbour
 *   (continuation) or null at the anchor and at a basin re-seed.
 *
 * screen(member) -> {ok, reason} | null
 *   Optional physical screen applied ON TOP of the residual test. A member can
 *   thread the sightlines beautifully and still be underground or require
 *   extreme kinematics; those are reported, not silently included.
 *
 * The search marches OUTWARD from the anchor in both directions, seeding each
 * rung from its solved neighbour. That is far cheaper than a global search per
 * rung, but it can follow one basin past the point where a better one takes
 * over — these landscapes are multimodal, which is why the production fits use
 * differential evolution in the first place. `basinProbe`, when supplied, is a
 * global (unseeded) fit used at each end of the ladder to check exactly that;
 * if it beats the marched solution by more than the acceptance margin, the
 * march is redone inward from it and the result says so.
 */
export async function rangeConditionedFamily({
    dataset, ranges, anchorM, fitAt, anchorFit = null, basinProbe = null, screen = null,
    K = 1.5, shouldCancel = null, progress = null,
}) {
    const sorted = (ranges || []).slice().sort((a, b) => a - b);
    // An empty ladder means the caller found no range this model may be
    // evaluated at. Return a well-formed empty band rather than fitting rung
    // `undefined`.
    if (!sorted.length) {
        return {
            members: [], intervals: [],
            band: {rangeLoM: NaN, rangeHiM: NaN, altLoM: NaN, altHiM: NaN,
                speedLoMS: NaN, speedHiMS: NaN,
                screenedCount: 0, residualCount: 0, total: 0, fitted: 0},
            bestErrDeg: Infinity, accept: NaN, K, boundaryLimited: false, gaps: [],
            basinCheck: {probed: false, reseeded: [], improvedDeg: null,
                skippedAtHeadline: false},
            headlineOnLadder: false, anchorM: NaN, ladderLoM: NaN, ladderHiM: NaN,
        };
    }
    let anchorIndex = 0;
    for (let i = 1; i < sorted.length; i++) {
        if (Math.abs(sorted[i] - anchorM) < Math.abs(sorted[anchorIndex] - anchorM)) anchorIndex = i;
    }
    // The headline may only be attached to the rung it ACTUALLY solved. If the
    // ladder does not carry the anchor exactly (an anchor outside the model's
    // own bounds, or a caller-built ladder that dropped it), the nearest rung is
    // a different range, and labelling a 9 km track as the 4 km rung publishes a
    // distance the solution does not have. Fail closed: fit that rung normally
    // and leave the band without a headline member rather than a wrong one.
    const anchorExact = Number.isFinite(anchorM) && sorted.length > 0
        && Math.abs(sorted[anchorIndex] - anchorM) <= Math.abs(anchorM) * 1e-9;
    const useAnchorFit = !!(anchorFit && anchorFit.track && anchorExact);

    const members = new Array(sorted.length).fill(null);
    let done = 0;
    const report = async () => {
        done++;
        if (progress) await progress(done / sorted.length);
    };
    const cancelled = () => shouldCancel && shouldCancel();

    const fitRung = async (i, seed) => {
        if (cancelled()) throw new Error("cancelled");
        const rangeM = sorted[i];
        let fit = null;
        try {
            fit = await fitAt(rangeM, seed);
        } catch (e) {
            if (e && e.message === "cancelled") throw e;
            fit = null;
        }
        await report();
        if (!fit || !fit.track) return null;
        const errDeg = Number.isFinite(fit.errDeg)
            ? fit.errDeg : meanAngularError(dataset, fit.track) * 180 / Math.PI;
        const metrics = fit.metrics ?? trackMetrics(dataset, fit.track);
        return {rangeM, track: fit.track, errDeg, metrics, solved: fit.solved ?? null};
    };

    // March outward from `from`, each rung seeded by its solved neighbour.
    //
    // `stopBefore` bounds the march. The basin re-march below MUST NOT run the
    // whole ladder: it starts at one end and would otherwise overwrite the
    // anchor — the headline solution the gallery draws solid — and every rung
    // beyond it, replacing solutions correctly marched outward from the
    // headline with ones marched in from the far edge. Measured on a live
    // scene: a probe at the 20 km rung re-marched all twelve rungs of a
    // quadcopter band whose anchor sat at 6 km.
    //
    // `keepBetter` makes a re-march monotone: a rung is only replaced when the
    // new solution actually fits better, so propagating a better basin inward
    // can never degrade a rung that was already right.
    const march = async (from, step, {stopBefore = null, keepBetter = false} = {}) => {
        let seed = members[from];
        for (let i = from + step; i >= 0 && i < sorted.length; i += step) {
            if (stopBefore !== null && i === stopBefore) break;
            const m = await fitRung(i, seed);
            if (m && (!keepBetter || !members[i] || m.errDeg < members[i].errDeg)) members[i] = m;
            if (m) seed = m;
        }
    };

    // The anchor rung IS the headline solution: the ladder always contains the
    // headline's own solved range, and locking a parameter at its free optimum
    // cannot improve on it. Re-fitting it from a geometric seed instead would
    // land somewhere else, so the band could omit — or quietly contradict — the
    // very track the gallery draws solid. Reuse it, and save a fit.
    if (useAnchorFit) {
        members[anchorIndex] = {
            rangeM: sorted[anchorIndex],
            track: anchorFit.track,
            errDeg: Number.isFinite(anchorFit.errDeg)
                ? anchorFit.errDeg : meanAngularError(dataset, anchorFit.track) * 180 / Math.PI,
            metrics: anchorFit.metrics ?? trackMetrics(dataset, anchorFit.track),
            solved: anchorFit.solved ?? null,
            isHeadline: true,
        };
        if (progress) await progress(1 / sorted.length);
        done++;
    } else {
        members[anchorIndex] = await fitRung(anchorIndex, null);
    }
    await march(anchorIndex, +1);
    await march(anchorIndex, -1);

    const finite = members.filter(Boolean);
    let bestErrDeg = Infinity;
    for (const m of finite) if (m.errDeg < bestErrDeg) bestErrDeg = m.errDeg;
    let accept = acceptanceDeg(bestErrDeg, K);

    // Basin check at both ends of the ladder.
    const basin = {probed: false, reseeded: [], improvedDeg: null, skippedAtHeadline: false};
    if (basinProbe && sorted.length > 2) {
        basin.probed = true;
        for (const end of [0, sorted.length - 1]) {
            if (cancelled()) throw new Error("cancelled");
            // A headline sitting ON an end is not probed at all. `stopBefore`
            // cannot protect it there — the march starts one rung past the
            // anchor and never encounters it — so the probe would both replace
            // the headline outright and then re-march the entire ladder. The
            // headline came from the production global search; a reduced-budget
            // probe at that same range is not a check on it.
            if (end === anchorIndex && members[end]?.isHeadline) {
                basin.skippedAtHeadline = true;
                continue;
            }
            let probe = null;
            try {
                probe = await basinProbe(sorted[end]);
            } catch (e) {
                if (e && e.message === "cancelled") throw e;
                probe = null;
            }
            if (!probe || !probe.track) continue;
            const probeErr = Number.isFinite(probe.errDeg)
                ? probe.errDeg : meanAngularError(dataset, probe.track) * 180 / Math.PI;
            const marched = members[end];
            const gain = marched ? marched.errDeg - probeErr : Infinity;
            if (!(gain > accept)) continue;
            // The march lost the better basin at this end. Adopt the probe and
            // re-march INWARD FROM IT, stopping at the anchor: the headline is
            // the model's own published answer and this reduced-budget probe is
            // not entitled to replace it, nor to reach past it and rewrite the
            // rungs on its far side.
            basin.reseeded.push(sorted[end]);
            basin.improvedDeg = Math.max(basin.improvedDeg ?? 0, gain);
            members[end] = {rangeM: sorted[end], track: probe.track, errDeg: probeErr,
                metrics: probe.metrics ?? trackMetrics(dataset, probe.track),
                solved: probe.solved ?? null};
            await march(end, end === 0 ? +1 : -1,
                {stopBefore: anchorIndex, keepBetter: true});
        }
        const refinished = members.filter(Boolean);
        bestErrDeg = Infinity;
        for (const m of refinished) if (m.errDeg < bestErrDeg) bestErrDeg = m.errDeg;
        accept = acceptanceDeg(bestErrDeg, K);
    }

    // Grade every rung: residual first, then the caller's physical screen.
    for (const m of members) {
        if (!m) continue;
        m.residualOk = m.errDeg <= accept;
        const s = m.residualOk && screen ? screen(m) : null;
        m.screened = m.residualOk && (!screen || (s && s.ok));
        m.rejectReason = m.residualOk
            ? (m.screened ? null : (s?.reason ?? "failed the physical screen"))
            : `LOS residual ${m.errDeg.toFixed(3)}° exceeds ${accept.toFixed(3)}°`;
    }

    const graded = members.filter(Boolean);
    const screenedMembers = graded.filter((m) => m.screened);
    const residualMembers = graded.filter((m) => m.residualOk);
    // Interval detection runs over the FULL ladder, nulls included. A rung
    // where the fit failed is a break, not an absence: compacting it away would
    // splice its neighbours together and report one continuous band across a
    // range the model was never shown to admit — the precise false claim
    // separate intervals exist to prevent.
    const intervals = attachOuterBrackets(
        contiguousIntervals(members, (m) => !!m && m.screened), sorted, members);
    for (const iv of intervals) iv.envelope = losRangeEnvelope(dataset, iv.members);

    // What actually separates the bands, recorded PER GAP.
    //
    // A gap whose sampled rungs were all evaluated and rejected excludes those
    // samples; a gap containing a rung whose fit failed is partly untested,
    // because a failure constrains nothing. Collapsing several gaps into one
    // flag makes those indistinguishable — with three intervals, one genuinely
    // excluded gap and one unfitted gap would share a single verdict and the
    // reader could not tell which was which. So each gap carries its own.
    //
    // Note what even a fully-rejected gap does NOT establish: the ladder sampled
    // discrete rungs, so the continuous ground between them was never tried.
    // The gap excludes its SAMPLES, not the region.
    const gaps = [];
    for (let g = 1; g < intervals.length; g++) {
        const from = intervals[g - 1].hiIndex + 1;
        const to = intervals[g].loIndex - 1;
        let rejected = 0, unfitted = 0;
        for (let i = from; i <= to; i++) {
            if (members[i]) rejected++; else unfitted++;
        }
        gaps.push({
            loM: sorted[from], hiM: sorted[to],
            afterM: intervals[g - 1].hiM, beforeM: intervals[g].loM,
            rejectedCount: rejected, unfittedCount: unfitted,
            fullyTested: unfitted === 0,
        });
    }

    const lo = sorted[0], hi = sorted[sorted.length - 1];
    const boundaryLimited = screenedMembers.some(
        (m) => m.rangeM <= lo * 1.001 || m.rangeM >= hi * 0.999);

    return {
        members: graded,
        intervals,
        band: {
            ...bandFromMembers(screenedMembers.length ? screenedMembers : residualMembers),
            screenedCount: screenedMembers.length,
            residualCount: residualMembers.length,
            total: sorted.length,
            fitted: graded.length,
        },
        bestErrDeg, accept, K, boundaryLimited,
        // One entry per gap between consecutive intervals, each with its own
        // rejected/unfitted counts. Deliberately NOT collapsed to a single flag.
        gaps,
        basinCheck: basin,
        // False when the ladder did not carry the headline's exact range, so no
        // rung is labelled with it. Consumers must not assume a headline member
        // exists.
        headlineOnLadder: useAnchorFit,
        anchorM: sorted[anchorIndex],
        ladderLoM: lo, ladderHiM: hi,
    };
}

const nm = (m) => (m / METERS_PER_NM).toFixed(1);
const kt = (v) => (v / KNOTS_TO_MS).toFixed(1);

/**
 * What separates the admitted bands, stated per gap. Null when the bands are
 * contiguous (or there is only one).
 *
 * Two things this must never do. It must not name the gap by the ADMITTED
 * endpoints either side of it — those rungs passed, so a span labelled
 * "rejected" that includes them is simply false; the gap's own extent is
 * loM–hiM. And it must not describe any continuous region as excluded: the
 * ladder sampled discrete rungs, so rejecting the rungs at 4 and 8 km says
 * nothing about 5.5 km, which was never tried.
 *
 * Lives here rather than in the gallery so the wording is unit-testable — the
 * overstatement always lives in the sentence, not in the counts.
 */
export function gapDisclosure(family) {
    const gaps = family?.gaps;
    if (!gaps || !gaps.length) return null;
    const samples = (n) => `${n} sampled range${n === 1 ? "" : "s"}`;
    const at = (g) => (g.loM === g.hiM
        ? `the sampled range ${nm(g.loM)} NM` : `sampled ranges ${nm(g.loM)}–${nm(g.hiM)} NM`);
    const describe = (g) => {
        if (g.unfittedCount === 0) {
            // A single rejected rung has no "ground between" it — the untested
            // region is the unsampled ranges either SIDE of it. Reusing the
            // plural sentence there describes a between-samples region that does
            // not exist, and understates how little was actually ruled out.
            if (g.rejectedCount === 1) {
                return `${at(g)} was rejected, so that one sample is excluded — the unsampled `
                    + `ranges either side of it remain untested`;
            }
            return `${at(g)} were all rejected, so those samples are excluded — the unsampled `
                + `ground between them is not`;
        }
        if (g.rejectedCount === 0) {
            return `${at(g)} produced no fit at all, so nothing there is excluded — this gap is `
                + `untested, not ruled out`;
        }
        return `of ${at(g)}, ${samples(g.rejectedCount)} were rejected and `
            + `${samples(g.unfittedCount)} produced no fit; only the rejected samples are `
            + `excluded, and the unfitted ones plus the unsampled ground between them remain `
            + `untested`;
    };
    const parts = gaps.length === 1
        ? describe(gaps[0])
        : gaps.map((g, i) => `gap ${i + 1}, ${describe(g)}`).join("; ");
    return `The admitted ranges are NOT contiguous — ${parts}.`;
}

/**
 * One sentence describing what the family means, for the tile subtitle and the
 * report. Deliberately says how many rungs were TESTED alongside how many were
 * admitted: "6 of 11" is a measurement, "2.1–7.4 NM" alone is not.
 */
export function familyBandSummary(family) {
    if (!family || !family.band) return null;
    const b = family.band;
    if (!b.screenedCount) {
        return `no tested range between ${nm(family.ladderLoM)} and ${nm(family.ladderHiM)} NM `
            + `produced a fit that both follows the sightlines and passes the physical screen `
            + `(${b.fitted} of ${b.total} ranges fitted at all)`;
    }
    // NOTHING here may claim a resolved distance. The ladder samples a handful
    // of discrete ranges, so an admitted rung establishes that THAT range works
    // — never that the untested ground beside it does not, and never that a
    // boundary sits where the last passing sample happened to fall. The honest
    // statement is always "of the ranges sampled", plus the bracket set by the
    // nearest range that was evaluated AND rejected.
    //
    // Every interval carries its OWN bracket. Quoting only the first one leaves
    // a disjoint band's remaining edges reading as exact, which is the same
    // overstatement one level down.
    // BOTH sides are always stated. Listing only the bracketed side leaves the
    // other reading as bounded, which is the same overstatement one side down:
    // an edge with no rejected sample beyond it may extend further, and that has
    // to be said, not merely omitted.
    const bracketOf = (iv) => {
        const lo = iv.outerLoM != null ? `below ${nm(iv.outerLoM)} NM` : null;
        const hi = iv.outerHiM != null ? `above ${nm(iv.outerHiM)} NM` : null;
        if (lo && hi) return ` (rejected ${lo}, ${hi})`;
        if (lo) return ` (rejected ${lo}; UNBOUNDED above — no rejected sample there)`;
        if (hi) return ` (rejected ${hi}; UNBOUNDED below — no rejected sample there)`;
        return " (UNBOUNDED both sides — no rejected sample beside it)";
    };
    const spans = family.intervals
        .map((iv) => `${nm(iv.loM)}–${nm(iv.hiM)} NM${bracketOf(iv)}`)
        .join(" and ");
    const disjoint = family.intervals.length > 1
        ? ` in ${family.intervals.length} disjoint bands` : "";
    const anyBounded = family.intervals.some(
        (iv) => iv.outerLoM != null || iv.outerHiM != null);
    const anyOpen = family.intervals.some(
        (iv) => iv.outerLoM == null || iv.outerHiM == null);
    const limitNote = anyBounded && anyOpen
        ? "; where a band is bracketed its true edge lies between it and that rejected sample, "
            + "and where it is unbounded the band may extend further — the ladder's spacing is "
            + "the resolution limit"
        : anyBounded
            ? "; each band's true edges lie between it and its bracketing rejected sample — the "
                + "ladder's spacing is the resolution limit"
            : "; no rejected sample bounds these bands, so they may extend further in either "
                + "direction";
    const untested = b.total <= 1;
    const collapsed = b.screenedCount === 1
        ? (untested
            ? `only ${nm(b.rangeLoM)} NM could be tested — the searched range bracket excludes `
                + `the rest of this model's envelope, so this says nothing about the distance`
            : `${nm(b.rangeLoM)} NM was the only sampled range admitted`
                + `${bracketOf(family.intervals[0])}${limitNote}`)
        : `ranges ${spans}${disjoint} fit within ${family.accept.toFixed(2)}°${limitNote}`;
    const extras = [];
    extras.push(`${b.screenedCount} of ${b.total} sampled`);
    // A rung that produced no solution constrains nothing in either direction,
    // so it must be visible rather than folded into the sampled count.
    if (b.total > b.fitted) {
        extras.push(`${b.total - b.fitted} sampled range${b.total - b.fitted === 1 ? "" : "s"} `
            + `produced no fit and constrain nothing`);
    }
    if (b.residualCount > b.screenedCount) {
        extras.push(`${b.residualCount - b.screenedCount} more follow the sightlines but fail the physical screen`);
    }
    if (Number.isFinite(b.speedLoMS) && Number.isFinite(b.speedHiMS)) {
        extras.push(`speed ${kt(b.speedLoMS)}–${kt(b.speedHiMS)} kt`);
    }
    if (family.boundaryLimited) extras.push("reaches the search edge — treat as a bound");
    if (family.basinCheck?.reseeded?.length) extras.push("a better solution basin was found at the ladder edge");
    return `${collapsed} (${extras.join("; ")})`;
}
