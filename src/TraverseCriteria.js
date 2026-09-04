/**
 * TraverseCriteria.js — the per-tile criteria ribbon.
 *
 * A row of small squares, one per criterion, each green / yellow / red / grey,
 * so a reader can see at a glance WHICH quantity is carrying a tile's verdict
 * instead of reading six stat lines and a rank basis to find out. Every square
 * carries its own sentence on hover; nothing here is a summary that replaces
 * the numbers, and nothing here feeds the ranking.
 *
 * JUDGED AGAINST THE RIGHT ENVELOPE, which is the whole point. 0.48 g is
 * unremarkable for a multirotor and self-refuting for a balloon, so a single
 * absolute threshold per quantity would be wrong for almost every tile. Each
 * quantity is therefore graded against an object class:
 *
 *   - A FORWARD MODEL is graded against the class it claims to be. A "balloon"
 *     fit that needs 0.48 g must be judged as a balloon, because that is the
 *     contradiction worth seeing; letting it be re-judged as the multirotor
 *     that would admit the number is how the contradiction gets hidden.
 *   - EVERYTHING ELSE — an LOS-constrained family, a curve fit, a geometric
 *     check — claims no object type, so it is graded against the most ordinary
 *     class that admits it, and the tooltip names that class. This is the same
 *     "as mundane as the most ordinary object that could have produced it"
 *     rule TraverseMundaneness uses, and for the same reason.
 *
 * WHY THE RIBBON CANNOT BE GREENER THAN THE SCREEN. Speed and acceleration are
 * also checked against the absolute kinematic screen in TraverseRanking, and
 * the worse of the two verdicts wins. Without that, a 5 g solution graded
 * against the jet envelope would show a green square beside a tile badged
 * "Low", and two surfaces of the same analysis would be contradicting each
 * other on the same screen.
 *
 * GREY IS NOT A PASS. It covers two cases — a criterion that could not run (no
 * angular size in the file, no truth track loaded, no wind evidence for a
 * non-buoyant model) and one that ran and settled nothing (an inconclusive wind
 * comparison) — and every grey tooltip says which. Reading grey as "fine" is
 * the failure mode this module is most likely to cause, so no grey tooltip
 * states a finding it does not have.
 *
 * ONE WHITE LETTER PER SQUARE, so the ribbon can be read without hovering:
 * P physically admissible, L line-of-sight fit, S speed, A acceleration,
 * Z size, M mirroring, C convergence, W wind, T truth. Z rather than S for
 * size because speed already has it. The letters must stay unique — a repeat
 * would make two squares indistinguishable, which is worse than no letter at
 * all — and `criteriaLetters` is asserted unique in the tests.
 *
 * The first square is the exception that makes the rest safe: a candidate
 * rejected outright carries no ranks at all, so its ribbon would otherwise be
 * mostly grey and read as unobjectionable. "Physically admissible" fails loudly
 * instead, and says that the greys behind it never ran.
 */

import {KNOTS_TO_MS} from "./TraverseAnalysis";
import {MUNDANE_CLASSES, impliedDiameter} from "./TraverseMundaneness";

export const CRITERION_COLORS = {
    pass: "#3fae72",
    caution: "#c9b23a",
    fail: "#e0564e",
    na: "#5b636d",
};

// How far outside a class band a value may sit before the square stops being
// green, then yellow. In decades, the same unit TraverseMundaneness reports,
// so 0.3 is "within about a factor of two of the envelope".
const CAUTION_DECADES = 0.0;
const FAIL_DECADES = 0.3;

// The object classes a declared forward model is held to. `aircraft` is a
// GENERIC fixed-wing prior rather than a specific airframe, so it is judged
// against the best-fitting member of the fixed-wing family instead of one
// arbitrary pick; the others name a single class each.
const DECLARED_CLASSES = {
    lantern: ["balloon"],
    quadcopter: ["quadcopter"],
    droneControl: ["quadcopter"],
    aircraft: ["smallUAS", "lightAir", "jet", "airliner"],
};

/** How far x sits outside [lo, hi], in decades. Zero inside the band. */
function decadesOutside(x, [lo, hi]) {
    if (!Number.isFinite(x) || x <= 0) return 0;
    if (x < lo) return Math.log10(lo / x);
    if (x > hi) return Math.log10(x / hi);
    return 0;
}

function statusForDecades(d) {
    if (!(d > CAUTION_DECADES)) return "pass";
    return d >= FAIL_DECADES ? "fail" : "caution";
}

const WORSE = {pass: 0, caution: 1, fail: 2, na: -1};
function worst(a, b) {
    if (a === "na") return b;
    if (b === "na") return a;
    return WORSE[a] >= WORSE[b] ? a : b;
}

/**
 * The object class a candidate's envelope criteria are judged against, plus
 * whether that class was DECLARED by the model or merely the best available.
 * Returns null when there are no metrics to judge.
 */
export function judgingClass(h, dataset = null) {
    const m = h?.metricsFull;
    if (!m) return null;
    const declaredKeys = DECLARED_CLASSES[h?.key];
    const pool = declaredKeys
        ? MUNDANE_CLASSES.filter((c) => declaredKeys.includes(c.key))
        : MUNDANE_CLASSES;
    if (!pool.length) return null;
    const speedKt = Number.isFinite(m.airSpeed?.mean) ? m.airSpeed.mean / KNOTS_TO_MS : NaN;
    const gMax = m.gLoad?.max;
    const implied = impliedDiameter(m.range?.mean, dataset?.angularDiameterMaxDeg,
        dataset?.fovFullDeg, dataset?.pixelsAcross);
    let best = null;
    for (const c of pool) {
        const sizeCost = implied
            ? decadesOutside(Math.max(implied.lo, Math.min(implied.hi, c.sizeM[0])), c.sizeM) : 0;
        const speedCost = decadesOutside(speedKt, c.speedKt);
        const gCost = Number.isFinite(gMax) && gMax > c.gMax ? Math.log10(gMax / c.gMax) : 0;
        const total = sizeCost + speedCost + gCost;
        if (!best || total < best.total) {
            best = {total, cls: c, sizeCost, speedCost, gCost, implied};
        }
    }
    // A declared class is a claim the model is making, and it holds even when
    // the numbers embarrass it — that is the point of grading against it. Only
    // an undeclared candidate is "the most ordinary class that admits it".
    return {...best, declared: !!declaredKeys};
}

function fmtBand([lo, hi], unit) {
    return lo > 0 ? `${lo}–${hi} ${unit}` : `up to ${hi} ${unit}`;
}

/**
 * The ribbon for one candidate: an ordered list of
 * {key, label, status, value, why}.
 *
 * @param h        the hypothesis
 * @param rating   its plausibilityRating (fit / kinematic / mirror ranks, pins)
 * @param opts     dataset (for the angular size bound) and useTruth
 */
export function candidateCriteria(h, rating, {dataset = null, useTruth = true} = {}) {
    const out = [];
    const m = h?.metricsFull;
    const jc = judgingClass(h, dataset);
    const clsName = jc ? jc.cls.label : null;
    const how = jc && jc.declared ? "the class this model claims to be"
        : "the most ordinary class that admits it";

    // --- validity, first, because a rejection outranks every other square ---
    //
    // A candidate rejected outright — underground, non-physical endpoints, the
    // wrong ground-contact mode — takes an early return in plausibilityRating
    // and so carries no fit or kinematic rank. Without this square its ribbon
    // read as three greens and five greys, which on the Aguadilla file made the
    // Underground-badged Ground Object look BETTER than a tile whose only fault
    // was mirroring the platform. Grey is "not evaluated", and "rejected" is
    // very much an evaluation.
    const rejected = rating && rating.rank < 0;
    const offMode = !!h?.groundMismatch;
    out.push({
        key: "valid", label: "Physically admissible", letter: "P",
        status: (rejected || offMode) ? "fail" : "pass",
        value: (rejected || offMode) ? (rating?.label ?? "rejected") : "ok",
        why: (rejected || offMode)
            ? `Rejected before any other criterion could be applied: `
              + `${rating?.reasons?.[0] ?? rating?.label ?? "not an admissible trajectory"}. `
              + "The greys further along this ribbon are checks that never ran, not checks it passed."
            : "The trajectory stays above the sampled terrain, has finite endpoints and metrics, "
              + "and satisfies the selected ground-contact mode.",
    });

    // --- fit -------------------------------------------------------------
    if (rating?.fitRank == null) {
        out.push({key: "fit", label: "LOS fit", letter: "L", status: "na", value: "—",
            why: (rejected || offMode)
                ? "not graded: this candidate was rejected before its residual was scored."
                : "this candidate is not graded on a sightline residual (a catalogue "
                  + "identification or a direction-only check)."});
    } else {
        const scale = Number.isFinite(rating.fitScaleDeg)
            ? ` (${(rating.scoredErrDeg / rating.fitScaleDeg).toFixed(2)}× this clip's `
              + `${rating.fitScaleDeg.toFixed(2)}° reference)` : "";
        out.push({
            key: "fit", label: "LOS fit", letter: "L",
            status: rating.fitRank === 3 ? "pass" : rating.fitRank === 2 ? "caution" : "fail",
            value: `${rating.scoredErrDeg?.toFixed(2) ?? "?"}°`,
            why: `Scored sightline residual ${rating.scoredErrDeg?.toFixed(3) ?? "?"}°${scale}. `
                + "Graded against what ordinary smooth motion leaves on this clip, not an "
                + "absolute threshold.",
        });
    }

    // --- speed and acceleration, against the class envelope --------------
    if (!m || !jc) {
        out.push({key: "speed", label: "Speed", letter: "S", status: "na", value: "—",
            why: "no metrics to judge."});
        out.push({key: "accel", label: "Acceleration", letter: "A", status: "na", value: "—",
            why: "no metrics to judge."});
    } else {
        const speedKt = m.airSpeed?.mean / KNOTS_TO_MS;
        const speedStatus = worst(statusForDecades(jc.speedCost),
            m.airSpeed?.max / KNOTS_TO_MS > 900 ? "fail"
                : m.airSpeed?.max / KNOTS_TO_MS > 650 ? "caution" : "pass");
        out.push({
            key: "speed", label: "Speed", letter: "S", status: speedStatus,
            value: `${speedKt.toFixed(1)} kt`,
            why: `Mean air speed ${speedKt.toFixed(1)} kt against a ${clsName}'s `
                + `${fmtBand(jc.cls.speedKt, "kt")} — ${how}.`
                + (jc.speedCost > 0
                    ? ` Outside it by a factor of ${Math.pow(10, jc.speedCost).toFixed(1)}.`
                    : " Inside it."),
        });

        const gMax = m.gLoad?.max;
        // The absolute screen wins when it is harsher: a 5 g solution must not
        // show green merely because the jet envelope would admit it.
        const gStatus = worst(statusForDecades(jc.gCost),
            gMax > 4 ? "fail" : gMax > 1.5 ? "caution" : "pass");
        out.push({
            key: "accel", label: "Acceleration", letter: "A", status: gStatus,
            value: `${Number.isFinite(gMax) ? gMax.toFixed(2) : "?"} g`,
            why: `Peak kinematic acceleration ${Number.isFinite(gMax) ? gMax.toFixed(2) : "?"} g `
                + `against a ${clsName}'s sustained limit of ${jc.cls.gMax} g — ${how}.`
                + (jc.gCost > 0
                    ? ` Over it by a factor of ${Math.pow(10, jc.gCost).toFixed(1)}.`
                    : " Inside it.")
                + (gMax > 4 ? " Above 4 g it is graded on the absolute screen whatever the class."
                    : ""),
        });
    }

    // --- implied physical size -------------------------------------------
    if (!jc || !jc.implied) {
        out.push({key: "size", label: "Implied size", letter: "Z", status: "na", value: "—",
            why: "this file carries no angular-size measurement, so nothing constrains how "
                + "big the object would have to be at this range. Not a pass — unmeasured."});
    } else {
        const {lo, hi, oneSided} = jc.implied;
        out.push({
            key: "size", label: "Implied size", letter: "Z", status: statusForDecades(jc.sizeCost),
            value: oneSided ? `<${hi.toFixed(2)} m` : `${lo.toFixed(2)}–${hi.toFixed(2)} m`,
            why: (oneSided
                ? `The target is sub-pixel, so the bound is an upper one only: under ${hi.toFixed(2)} m `
                : `Implied ${lo.toFixed(2)}–${hi.toFixed(2)} m `)
                + `at this range, against a ${clsName}'s ${fmtBand(jc.cls.sizeM, "m")} — ${how}.`
                + (jc.sizeCost > 0
                    ? ` Outside it by a factor of ${Math.pow(10, jc.sizeCost).toFixed(1)}.`
                    : " Overlapping it."),
        });
    }

    // --- platform mirroring ----------------------------------------------
    const pm = h?.platformMirror;
    if (rating?.mirrorRank == null) {
        out.push({key: "mirror", label: "Platform mirroring", letter: "M", status: "na", value: "—",
            why: "not evaluated for this kind of candidate."});
    } else if (!pm) {
        out.push({key: "mirror", label: "Platform mirroring", letter: "M", status: "na", value: "—",
            why: "the platform does not manoeuvre enough on this clip for the test to say "
                + "anything: with no manoeuvre there is no parallax to reason from."});
    } else {
        out.push({
            key: "mirror", label: "Platform mirroring", letter: "M",
            status: rating.mirrorRank === 3 ? "pass" : rating.mirrorRank === 2 ? "caution" : "fail",
            value: `${Math.round(pm.share * 100)}%`,
            why: `${Math.round(pm.share * 100)}% of this candidate's manoeuvring is a `
                + `${Math.abs(pm.beta).toFixed(2)}× copy of the platform's own path. An object can `
                + "pace the camera, but a wrong range produces the same signature — so the higher "
                + "this is, the more the solved motion belongs to the camera rather than the object.",
        });
    }

    // --- search completeness ---------------------------------------------
    const pins = rating?.activePins?.length ?? 0;
    const clamps = rating?.modelClamps?.length ?? 0;
    const warns = rating?.optimizerWarnings?.length ?? 0;
    const convergenceStatus = (warns || pins >= 2) ? "fail"
        : (pins || clamps || rating?.boundaryLimited) ? "caution" : "pass";
    const convergenceBits = [];
    if (warns) convergenceBits.push(`optimizer incomplete (${rating.optimizerWarnings.join("; ")})`);
    if (pins) convergenceBits.push(`${pins} load-bearing model limit${pins === 1 ? "" : "s"}: ${rating.activePins.join(", ")}`);
    if (clamps) convergenceBits.push(`internal clamp reached: ${rating.modelClamps.join(", ")}`);
    if (rating?.boundaryLimited) convergenceBits.push("the supported solution family reaches a search boundary");
    out.push({
        key: "convergence", label: "Convergence", letter: "C", status: convergenceStatus,
        value: convergenceBits.length ? `${convergenceBits.length} issue${convergenceBits.length === 1 ? "" : "s"}` : "clean",
        why: convergenceBits.length
            ? `The search did not finish cleanly: ${convergenceBits.join("; ")}. A fit pressed against its `
              + "own limits has not demonstrated its optimum."
            : "The search converged without pinning a bound, tripping an internal clamp, or "
              + "exhausting its optimizer budget.",
    });

    // --- independent wind evidence (buoyant models only) -----------------
    const ev = h?.windEvidence;
    if (!ev || ev.role !== "free") {
        out.push({key: "wind", label: "Wind evidence", letter: "W", status: "na", value: "—",
            why: h?.key === "lantern"
                ? "only the free-wind balloon fit can be compared against the loaded winds "
                  + "independently; a wind-pinned fit was given the answer."
                : "independent wind agreement is a balloon-specific check and does not apply "
                  + "to this candidate."});
    } else {
        const map = {supports: "pass", compatible: "caution", tension: "fail", inconclusive: "na"};
        out.push({
            key: "wind", label: "Wind evidence", letter: "W", status: map[ev.rating] ?? "na",
            value: ev.rating ?? "—",
            why: `Independent wind check: ${ev.rating}${ev.why ? ` — ${ev.why}` : ""}.`,
        });
    }

    // --- truth separation, when a truth track is applied ------------------
    const tc = h?.truthComparison;
    if (!useTruth || !tc) {
        out.push({key: "truth", label: "Truth separation", letter: "T", status: "na", value: "—",
            why: useTruth
                ? "no truth track is selected for this run, so nothing scores this candidate "
                  + "against a known answer."
                : "a truth track is selected but not applied, so it does not grade this candidate."});
    } else if (!tc.comparable) {
        out.push({key: "truth", label: "Truth separation", letter: "T", status: "na", value: "—",
            why: `not comparable — ${tc.note || "insufficient overlap"}.`});
    } else {
        const rel = tc.sep3D.mean / Math.max(1, tc.meanTruthRange);
        out.push({
            key: "truth", label: "Truth separation", letter: "T",
            status: rel < 0.03 ? "pass" : rel < 0.12 ? "caution" : "fail",
            value: tc.sep3D.mean >= 1000
                ? `${(tc.sep3D.mean / 1000).toFixed(1)} km` : `${Math.round(tc.sep3D.mean)} m`,
            why: `Mean 3D separation from the selected truth track is `
                + `${Math.round(tc.sep3D.mean)} m at about ${Math.round(tc.meanTruthRange)} m mean `
                + `truth range — ${(rel * 100).toFixed(1)}% of it.`,
        });
    }

    return out;
}

/** The ribbon's one-line summary, for a container tooltip and the report. */
export function criteriaSummary(criteria) {
    const n = (s) => criteria.filter((c) => c.status === s).length;
    const parts = [];
    if (n("fail")) parts.push(`${n("fail")} failing`);
    if (n("caution")) parts.push(`${n("caution")} marginal`);
    if (n("pass")) parts.push(`${n("pass")} passing`);
    if (n("na")) parts.push(`${n("na")} not evaluated`);
    return parts.join(", ");
}
