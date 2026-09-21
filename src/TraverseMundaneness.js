/**
 * TraverseMundaneness.js — how ORDINARY is a candidate trajectory?
 *
 * Class compatibility is separate from the BOT Score. When angular-size
 * judging is enabled, a size conflict also feeds the separate ranking check.
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
 * UNITS. Cost is summed DECADES outside the measured size/speed/g envelope.
 * Zero does not identify a class: all passing classes are reported, unmeasured
 * quantities are disclosed, and a failed drift-shape check excludes a balloon
 * from the steady-drift interpretation even when its numeric cost is zero.
 */

import {KNOTS_TO_MS} from "./TraverseAnalysis";
import {balloonMotion} from "./TraverseMotion";
import {PHYSICAL_ENVELOPES, PHYSICAL_ENVELOPE_REVISION} from "./PhysicalEnvelopes";
import {assessAngularSize, angularSizeSummary, angularExtentFactor, angularSizeInventory} from "./AngularSize";

/**
 * Object classes as ENVELOPES, not points. Sizes are overall extent in metres,
 * speeds in knots, gMax manoeuvring acceleration (not structural load factor).
 *
 * Bands are deliberately GENEROUS. The score exists to identify the impossible,
 * not to enforce a preference, and a tight band would manufacture anomalies out
 * of unusual but entirely real aircraft.
 */
export const MUNDANE_CLASSES = PHYSICAL_ENVELOPES.map(c => ({
    ...c, speedKt: c.speedMS.map(v => v / KNOTS_TO_MS),
}));

/** How far x sits outside [lo, hi], in decades. Zero inside the band. */
function decadesOutside(x, [lo, hi]) {
    if (!Number.isFinite(x) || x < 0) return 0;    // unmeasured costs nothing
    if (x === 0) return lo > 0 ? Infinity : 0;
    if (x < lo) return Math.log10(lo / x);
    if (x > hi) return Math.log10(x / hi);
    return 0;
}

/** Legacy scalar upper bound. Sensor resolution cannot supply an unreported lower bound. */
export function impliedDiameter(rangeM, thetaMaxDeg) {
    if (!(rangeM > 0) || !(thetaMaxDeg > 0) || thetaMaxDeg >= 180) return null;
    return {lo: 0, hi: rangeM * angularExtentFactor(thetaMaxDeg), oneSided: true};
}

/**
 * Physical-class screens applied to the recovered path, regardless of solver.
 *
 * @param dataset  carries the angular measurement when the source file had one:
 *                 angularSize / angularSizeOptions when the angular-size
 *                 assessment is switched on, else the legacy scalar upper
 *                 bound angularDiameterMaxDeg. The sensor block the file may
 *                 also carry (fovFullDeg / pixelsAcross) is NOT used here —
 *                 resolution cannot supply an unreported lower bound.
 * @param h        the hypothesis; needs metricsFull
 * Returns all class checks, motion diagnostics and unmeasured quantities.
 */
export function physicalClassChecks(dataset, h) {
    const m = h?.metricsFull ? {...h.metricsFull, ...h.windConditionalMetrics} : null;
    if (!m || h.identity || h.atInfinity || h.nonPhysical || h.underground || h.groundMismatch) return null;
    const speedMinKt = (m.airSpeed?.min ?? m.airSpeed?.mean) / KNOTS_TO_MS;
    const speedMaxKt = (m.airSpeed?.max ?? m.airSpeed?.mean) / KNOTS_TO_MS;
    const gMax = m.gLoad?.max;
    const angularSize = dataset?.angularSizeOptions?.judge
        ? assessAngularSize(dataset, h, dataset.angularSizeOptions) : null;
    const sizeOff = !dataset?.angularSizeOptions?.judge
        && (angularSizeInventory(dataset?.angularSize).count > 0 || dataset?.angularSizeOptions?.judge === false);
    const implied = angularSize ? angularSize.impliedM : sizeOff ? null
        : impliedDiameter(m.range?.mean, dataset?.angularDiameterMaxDeg);
    const motion = balloonMotion(h.track);
    // This is a steady-drift screen, not a claim that no wind field could ever
    // carry a balloon around a bend. Substantial backtracking/circling needs a
    // changing-wind explanation; low speed and low g alone cannot supply it.
    // Use the same atypical-drift boundary as the existing balloon diagnostic.
    const balloonTurnsBack = motion && motion.horizontalPathM >= 20
        && motion.horizontalDirectness < 0.45;
    const unknown = [];
    if (!implied) unknown.push("size");
    if (!Number.isFinite(speedMinKt) || !Number.isFinite(speedMaxKt)) unknown.push("speed");
    if (!Number.isFinite(gMax)) unknown.push("acceleration");
    if (!motion) unknown.push("drift shape");

    const classes = MUNDANE_CLASSES.map(c => {
        // SIZE. The implied size is an interval, so it costs nothing if ANY part
        // of it overlaps the class band — the object could be anywhere inside
        // that interval, and only a fully disjoint interval is evidence. That
        // holds for the one-sided upper-bound interval too: it starts at zero,
        // so it overlaps every class ABOVE the break-even range and refutes
        // every class below it, which is exactly the range floor D_min/theta.
        const sizeIntervals = angularSize?.sizeIntervals?.length ? angularSize.sizeIntervals : implied ? [implied] : [];
        const sizeCost = sizeIntervals.reduce((worst, interval) => Math.max(worst,
            decadesOutside(Math.max(interval.lo, Math.min(interval.hi, c.sizeM[0])), c.sizeM)), 0);
        // Multirotor model speed is horizontal. Do not reject a climbing path
        // because its total speed exceeds the horizontal model limit.
        const horizontal = c.speedBasis === "horizontal" && m.horizontalAirSpeed;
        const speed = horizontal || m.airSpeed;
        const classSpeedMinKt = (speed?.min ?? speed?.mean) / KNOTS_TO_MS;
        const classSpeedMaxKt = (speed?.max ?? speed?.mean) / KNOTS_TO_MS;
        const speedCost = Math.max(decadesOutside(speed?.min ?? speed?.mean, c.speedMS),
            decadesOutside(speed?.max ?? speed?.mean, c.speedMS));
        // g has no lower bound: flying gently is never suspicious.
        const gCost = Number.isFinite(gMax) && gMax > c.gMax ? Math.log10(gMax / c.gMax) : 0;
        const total = sizeCost + speedCost + gCost;
        const motionRejected = c.key === "balloon" && !!balloonTurnsBack;
        return {total, key: c.key, label: c.label, cls: c, sizeCost, speedCost, gCost,
            speedMinKt: classSpeedMinKt, speedMaxKt: classSpeedMaxKt,
            speedBasis: horizontal ? "horizontal" : "total",
            motionRejected, compatible: total === 0 && !motionRejected && angularSize?.status !== "conflict",
            impliedM: implied};
    });
    return {classes, motion, unknown, speedMinKt, speedMaxKt, gMax, impliedM: implied, angularSize, sizeOff,
        envelopeRevision: PHYSICAL_ENVELOPE_REVISION};
}

export function angularSizeRankingCheck(dataset, h) {
    const checks = physicalClassChecks(dataset, h);
    const check = checks?.angularSize ?? assessAngularSize(dataset, h, dataset?.angularSizeOptions);
    if (check.status !== "compatible" || !check.absoluteCount || !checks) return check;
    // Size can reject the motion-compatible envelopes. Do not attribute a
    // pre-existing speed/g/drift failure to the newly supplied size evidence.
    const motionClasses = checks.classes.filter(c => !c.speedCost && !c.gCost && !c.motionRejected);
    if (motionClasses.length && motionClasses.every(c => c.sizeCost > 0)) {
        return {...check, status: "conflict", reason: "Implied size is outside every motion-compatible class envelope",
            maxFactor: Math.max(check.maxFactor ?? 1, 10 ** Math.min(...motionClasses.map(c => c.sizeCost)))};
    }
    return check;
}

export function mundanenessCost(dataset, h) {
    const checks = physicalClassChecks(dataset, h);
    if (!checks) return null;
    const candidates = checks.classes.filter(c => !c.motionRejected);
    const best = candidates.reduce((best, c) => !best || c.total < best.total ? c : best, null);
    return {...best, ...checks, compatibleClasses: checks.classes.filter(c => c.compatible)};
}

/**
 * Report the full compatible set, rather than assigning the first zero-cost
 * class as though it were an identification. Name missing data and exclusions.
 */
export function mundanenessSummary(cost) {
    if (!cost) return null;
    if (cost.angularSize?.status === "conflict") return angularSizeSummary(cost.angularSize) + ".";
    const c = cost.total;
    const unmeasured = (cost.unknown ?? []).filter(k => k !== "size" || !cost.sizeOff);
    const unknown = (unmeasured.length ? ` ${unmeasured.join(", ")} unmeasured.` : "")
        + (cost.sizeOff ? " Size not assessed: angular-size judging is off." : "");
    const drift = cost.classes?.find(c => c.key === "balloon");
    const balloon = drift?.motionRejected ? " Balloon fails the steady-drift check: the path circles or doubles back." : "";
    if (cost.compatibleClasses?.length) {
        return `Within tested limits: ${cost.compatibleClasses.map(c => c.label).join(", ")}.` + balloon + unknown;
    }
    // Name every quantity that carries the cost, not just the largest: saying
    // "too fast" about a solution that is also impossibly small would be a
    // half-truth.
    const parts = [];
    if (cost.sizeCost > 0.05) parts.push("size");
    if (cost.speedCost > 0.05) parts.push("speed");
    if (cost.gCost > 0.05) parts.push("acceleration");
    const why = parts.length ? parts.join(" and ") : "its combination of size, speed and acceleration";
    const factor = Math.pow(10, c);
    return `No class is within all tested limits. Closest envelope: ${cost.label}; `
        + `${Number.isFinite(factor) ? (factor < 10 ? factor.toFixed(1) : Math.round(factor)) + "× outside" : "outside"} on ${why}.`
        + balloon + unknown;
}

export function physicalCompatibilityDetails(cost) {
    if (!cost) return "No motion metrics available.";
    const rows = cost.classes.map(c => {
        const reasons = [];
        if (c.speedCost > 0) reasons.push(`${c.speedBasis} speed ${c.speedMinKt.toFixed(1)}–${c.speedMaxKt.toFixed(1)} kt outside ${c.cls.speedKt.map(v => v.toFixed(1)).join("–")} kt`);
        if (c.gCost > 0) reasons.push(`peak ${cost.gMax.toFixed(2)} g exceeds ${c.cls.gMax} g`);
        if (c.sizeCost > 0) reasons.push(`implied size outside ${c.cls.sizeM.join("–")} m`);
        if (cost.angularSize?.status === "conflict") reasons.push(angularSizeSummary(cost.angularSize));
        if (c.motionRejected) reasons.push(`net horizontal displacement is only ${(100 * cost.motion.horizontalDirectness).toFixed(1)}% of distance travelled (steady-drift minimum: 45%)`);
        return `${c.label}: ${reasons.length ? reasons.join("; ") : "within tested limits"}.`;
    });
    return rows.join(" ") + " These are motion/size screens applied to every trajectory, regardless of solver. "
        + "They are not a full dynamics fit or an identification. A balloon path that fails steady drift would need a changing-wind explanation; that has not been established by this check.";
}
