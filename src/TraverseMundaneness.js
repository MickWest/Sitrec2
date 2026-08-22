/**
 * TraverseMundaneness.js — how ORDINARY is a candidate trajectory?
 *
 * DISCLOSURE ONLY. Nothing here feeds the ranking. The gallery order is decided
 * by TraverseRanking's comparator exactly as before; this module produces a
 * number a reader can see beside each tile, so the score can be judged against
 * real files before it is ever allowed to move anything.
 *
 * WHAT IT IS NOT. This is not a search for mundane explanations at the expense
 * of anomalous ones, and it must never be presented as one. An anomalous
 * explanation that fits the sightlines perfectly ALWAYS exists — the exact-ray
 * track is one — so finding one proves nothing. The falsifiable question is
 * whether a MUNDANE explanation exists anywhere in the solution space. A high
 * cost here is a POSITIVE finding about the object, not a failure to explain it
 * away, and the wording on every surface should read that way to a hostile
 * reader.
 *
 * WHY JOINT AND NOT MARGINAL. A size test alone cannot refute a collapsed
 * solution: a candidate at 500 m implies an object 0.28 m across, and 0.28 m is
 * a perfectly ordinary size. What refutes it is the PAIR — 0.28 m sustaining
 * 300 knots. A bird is the right size and impossibly fast; a fixed-wing is the
 * right speed and impossibly small. Every class fails, each for its own reason,
 * and none fails on size alone. So each class is judged on all of its
 * quantities at once and the candidate keeps the BEST class it can find, which
 * is Occam's razor made mechanical: a candidate is as mundane as the most
 * ordinary object that could have produced it.
 *
 * A measured dead end, recorded so it is not rebuilt: a one-sided range floor
 * at D_min / theta_max cannot work. With the target framed at a fixed fraction
 * f of frame width on an N-pixel sensor, the floor reduces to
 * [f/(f + 1/N)] * (D_min/D_true) * R_true — the field of view cancels — so it is
 * capped at about 1% of the true range when a 0.1 m bird floors a 10 m
 * aircraft. Measured over 23 benchmark scenarios it cut 39 of 345 candidates
 * and moved the median result not at all.
 *
 * UNITS. Cost is DECADES outside an envelope, so it reads directly: 0 means
 * every quantity sits inside some real object's envelope; 1 means the best
 * available class is off by a factor of ten somewhere.
 */

import {KNOTS_TO_MS} from "./TraverseAnalysis";

const DEG = 180 / Math.PI;

/**
 * Object classes as ENVELOPES, not points. Sizes are overall extent in metres,
 * speeds sustained cruise in knots, gMax sustained manoeuvring load.
 *
 * Bands are deliberately GENEROUS. The score exists to identify the impossible,
 * not to enforce a preference, and a tight band would manufacture anomalies out
 * of unusual but entirely real aircraft.
 */
export const MUNDANE_CLASSES = [
    // The strictest and most useful case: a balloon cannot manoeuvre at all, so
    // a "balloon" solution that turns hard is self-refuting.
    {key: "balloon",    label: "balloon",          sizeM: [0.20, 8.0],  speedKt: [0, 80],    gMax: 0.5},
    {key: "bird",       label: "bird",             sizeM: [0.10, 2.5],  speedKt: [0, 60],    gMax: 3.0},
    {key: "quadcopter", label: "multirotor",       sizeM: [0.20, 2.0],  speedKt: [0, 60],    gMax: 2.0},
    {key: "smallUAS",   label: "small fixed-wing", sizeM: [0.50, 4.0],  speedKt: [20, 120],  gMax: 4.0},
    {key: "lightAir",   label: "light aircraft",   sizeM: [5.0,  20.0], speedKt: [60, 250],  gMax: 3.0},
    {key: "jet",        label: "jet",              sizeM: [10.0, 25.0], speedKt: [150, 600], gMax: 9.0},
    {key: "airliner",   label: "airliner",         sizeM: [25.0, 80.0], speedKt: [200, 500], gMax: 2.5},
];

/** How far x sits outside [lo, hi], in decades. Zero inside the band. */
function decadesOutside(x, [lo, hi]) {
    if (!Number.isFinite(x) || x <= 0) return 0;    // unmeasured costs nothing
    if (x < lo) return Math.log10(lo / x);
    if (x > hi) return Math.log10(x / hi);
    return 0;
}

/**
 * Implied physical size of an object at range R, from the published angular
 * bound. TWO-SIDED: the bound is `max(theta, IFOV) + IFOV`, so the true angle
 * lies within two instantaneous fields of view below it.
 *
 * Returns null when the file carries no angular measurement, which is the
 * common case — only BOT interchange v1.2 files declare one. The size term is
 * then skipped entirely and the cost is carried by speed and acceleration.
 *
 * `oneSided` MARKS THE SUB-PIXEL CASE, and it was measured rather than assumed.
 * When the target is under a pixel the published bound sits at its floor of
 * exactly 2*IFOV, so `lo` collapses to zero and the interval becomes an UPPER
 * BOUND ONLY: the object is smaller than `hi` at this range, and nothing is
 * known about how much smaller. Measured over the 20 straight-balloon scenarios
 * (a 0.35 m party balloon at 6-81 km, 0.05-0.67 px across) the bound was at
 * that floor in all 20.
 *
 * That upper bound is still REAL EVIDENCE and still costs a collapsed candidate
 * — an object under one pixel at 500 m is under 0.082 m, which no object class
 * admits — so the cost below uses the interval exactly as it always has. What
 * changes is only what a reader is told: "0.00-2.11 m" reads as a measurement
 * and it is half of one, so the flag is carried out of here rather than leaving
 * every caller to notice that `lo === 0` means "sub-pixel".
 */
export function impliedDiameter(rangeM, thetaMaxDeg, fovFullDeg, pixels) {
    if (!(rangeM > 0) || !(thetaMaxDeg > 0)) return null;
    // NO SENSOR GEOMETRY MEANS NO LOWER END. The published quantity is an UPPER
    // bound on the angle, and without the IFOV there is no way to know how much
    // of it is resolution rather than object. Treating it as exact would invent
    // a lower bound — and a wrong one in both directions, since it also pins the
    // implied size ABOVE a class ceiling that a true interval would overlap.
    // Reachable whenever a BOT CSV is imported without its sidecar: the angular
    // column rides on the CSV, the sensor block only on scenario.json.
    const haveIfov = fovFullDeg > 0 && pixels > 0;
    const ifovDeg = haveIfov ? fovFullDeg / pixels : 0;
    const lo = haveIfov ? rangeM * Math.max(0, thetaMaxDeg - 2 * ifovDeg) / DEG : 0;
    return {
        lo,
        hi: rangeM * thetaMaxDeg / DEG,
        // A lower bound of zero is no lower bound. Equivalent to the condition
        // theta_max <= 2*IFOV, written in the units the caller already has.
        oneSided: !(lo > 0),
    };
}

/**
 * The mundaneness cost of one candidate, plus the class that achieved it.
 *
 * @param dataset  carries the angular measurement when the source file had one
 *                 (angularDiameterMaxDeg / fovFullDeg / pixelsAcross)
 * @param h        the hypothesis; needs metricsFull
 * @returns {{total, key, label, sizeCost, speedCost, gCost, impliedM}} or null
 *          when the candidate has no metrics to judge.
 */
export function mundanenessCost(dataset, h) {
    const m = h?.metricsFull;
    if (!m) return null;
    const speedKt = Number.isFinite(m.airSpeed?.mean) ? m.airSpeed.mean / KNOTS_TO_MS : NaN;
    const gMax = m.gLoad?.max;
    const implied = impliedDiameter(m.range?.mean, dataset?.angularDiameterMaxDeg,
        dataset?.fovFullDeg, dataset?.pixelsAcross);

    let best = null;
    for (const c of MUNDANE_CLASSES) {
        // SIZE. The implied size is an interval, so it costs nothing if ANY part
        // of it overlaps the class band — the object could be anywhere inside
        // that interval, and only a fully disjoint interval is evidence. That
        // holds for the one-sided (sub-pixel) interval too: it starts at zero,
        // so it overlaps every class ABOVE the break-even range and refutes
        // every class below it, which is exactly the range floor D_min/theta.
        const sizeCost = implied
            ? decadesOutside(Math.max(implied.lo, Math.min(implied.hi, c.sizeM[0])), c.sizeM)
            : 0;
        const speedCost = decadesOutside(speedKt, c.speedKt);
        // g has no lower bound: flying gently is never suspicious.
        const gCost = Number.isFinite(gMax) && gMax > c.gMax ? Math.log10(gMax / c.gMax) : 0;
        const total = sizeCost + speedCost + gCost;
        if (!best || total < best.total) {
            best = {total, key: c.key, label: c.label, sizeCost, speedCost, gCost,
                impliedM: implied};
        }
    }
    return best;
}

/**
 * One line of plain English for the tile. Says what the best available ordinary
 * explanation is and, when nothing ordinary fits, WHICH quantity is the problem
 * — because "anomalous" without a reason is not a finding.
 */
export function mundanenessSummary(cost) {
    if (!cost) return null;
    const c = cost.total;
    if (c < 0.05) return `consistent with an ordinary ${cost.label}`;
    // Name every quantity that carries the cost, not just the largest: saying
    // "too fast" about a solution that is also impossibly small would be a
    // half-truth.
    const parts = [];
    if (cost.sizeCost > 0.05) parts.push("size");
    if (cost.speedCost > 0.05) parts.push("speed");
    if (cost.gCost > 0.05) parts.push("acceleration");
    const why = parts.length ? parts.join(" and ") : "its combination of size, speed and acceleration";
    const factor = Math.pow(10, c);
    return `nearest ordinary object is a ${cost.label}, and this misses that `
        + `envelope by ${factor < 10 ? factor.toFixed(1) : Math.round(factor)}x on ${why}`;
}
