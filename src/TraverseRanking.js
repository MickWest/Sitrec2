/**
 * DOM-free traversal ranking and explanation helpers.
 *
 * The gallery contains unlike questions: LOS-constrained trajectory families,
 * object-conditioned forward models, known-object catalogue checks, and
 * estimator diagnostics.  They must never be presented as one calibrated
 * object-probability ranking.  This module supplies one common screening
 * record, then ranks only within a comparison category.
 */

import {KNOTS_TO_MS, straightFlightScore} from "./TraverseAnalysis";

export const RAY_SOLVER_ALLOWANCE_DEG = 0.05;
export const DISPLAY_TIE_THRESHOLD = 0.05;

const COLORS = {
    pass: "#3fae72",
    moderate: "#c9b23a",
    low: "#d9862f",
    implausible: "#e0564e",
    invalid: "#8a5a2b",
};

export const RANKING_CATEGORIES = [
    {
        key: "trajectory",
        label: "Geometric and LOS-constrained trajectory families",
        shortLabel: "trajectory families",
        description: "Mathematical paths or geometric constraints. These describe motion the sightlines permit; they are not object types.",
    },
    {
        key: "forward",
        label: "Object-conditioned forward models",
        shortLabel: "forward models",
        description: "Aircraft, balloon/lantern, and multirotor models with their own dynamics, priors, wind freedom, and bounds.",
    },
    {
        key: "catalogue",
        label: "Known-object catalogue checks",
        shortLabel: "catalogue checks",
        description: "Named astronomical or satellite alignments, judged by angular offset and visibility rather than aircraft kinematics.",
    },
    {
        key: "diagnostic",
        label: "Estimator diagnostics",
        shortLabel: "estimator diagnostics",
        description: "Alternative fitting algorithms shown for comparison and exact application, not independent object hypotheses.",
    },
];

const FORWARD_KEYS = new Set(["aircraft", "lantern", "quadcopter"]);
const RAY_KEYS = new Set(["constAir", "constAlt", "plausible", "saddle", "groundVehicle"]);

export function hypothesisCategory(h) {
    const p = h?.params || {};
    if (p.object !== undefined || p.satellite !== undefined
        || h?.key === "astroNow" || h?.key === "astroTime" || h?.key === "satellite") {
        return RANKING_CATEGORIES[2];
    }
    if (FORWARD_KEYS.has(h?.key)) return RANKING_CATEGORIES[1];
    if (h?.key === "straightLine" || String(h?.key || "").startsWith("gf")) {
        return RANKING_CATEGORIES[3];
    }
    return RANKING_CATEGORIES[0];
}

export function hypothesisFitKind(h) {
    const category = hypothesisCategory(h).key;
    if (category === "catalogue") return "identity";
    // A generic point at infinity is a directional geometry check. Its finite
    // helper track exists only so the UI has something to draw; its speed and
    // acceleration must not affect screening or order.
    if (h?.atInfinity) return "directional-geometry";
    if (category === "forward") return "forward-model";
    if (RAY_KEYS.has(h?.key)) return "ray-constrained";
    return "fitted-trajectory";
}

// Ray-constrained tracks carry a small smoothing/solver residual.  Give that a
// fixed numerical allowance, not an allowance derived from the generic
// constant-acceleration reference (which is explicitly not sensor noise).
export function effectiveErrDeg(h) {
    const err = Number.isFinite(h?.errDeg) ? h.errDeg : Infinity;
    return hypothesisFitKind(h) === "ray-constrained"
        ? Math.max(0, err - RAY_SOLVER_ALLOWANCE_DEG)
        : err;
}

function tierForRank(rank) {
    if (rank >= 3) return {label: "Passes broad screen", rank: 3, color: COLORS.pass};
    if (rank === 2) return {label: "Moderate", rank: 2, color: COLORS.moderate};
    if (rank === 1) return {label: "Low", rank: 1, color: COLORS.low};
    if (rank === 0) return {label: "Implausible", rank: 0, color: COLORS.implausible};
    return {label: "Invalid", rank: -1, color: COLORS.invalid};
}

function activePins(h) {
    return Array.isArray(h?.boundPinned) ? Array.from(new Set(h.boundPinned)) : [];
}

function inactivePins(h) {
    return Array.isArray(h?.boundInactive) ? Array.from(new Set(h.boundInactive)) : [];
}

export function rankTieScore(h) {
    const kind = hypothesisFitKind(h);
    if (kind === "identity" || kind === "directional-geometry") {
        return Number.isFinite(h?.errDeg) ? h.errDeg : Infinity;
    }
    if (!h?.metricsFull) return Infinity;
    const score = straightFlightScore(h?.metricsFull) + effectiveErrDeg(h) / 0.05;
    return Number.isFinite(score) ? score : Infinity;
}

export function plausibilityRating(h) {
    if (h?.underground) {
        return {
            label: "Underground", rank: -1, color: "#7a4b8a", baseRank: -1,
            eligible: false, boundaryLimited: false, activePins: [], inactivePins: [],
            incomplete: false, secondaryScore: Infinity,
            reasons: ["trajectory passes below the sampled terrain"],
        };
    }
    if (h?.nonPhysical) {
        return {
            label: "Non-physical", rank: -1, color: COLORS.invalid, baseRank: -1,
            eligible: false, boundaryLimited: false, activePins: [], inactivePins: [],
            incomplete: false, secondaryScore: Infinity,
            reasons: ["source method produced non-physical endpoints or metrics"],
        };
    }
    if (h?.groundMismatch) {
        return {
            label: "Off-mode", rank: 0, color: "#a6642e", baseRank: 0,
            eligible: false, boundaryLimited: false, activePins: [], inactivePins: [],
            incomplete: false, secondaryScore: Infinity,
            reasons: ["trajectory does not satisfy the selected ground-contact mode"],
        };
    }

    const p = h?.params || {};
    const rawErr = Number.isFinite(h?.errDeg) ? h.errDeg : Infinity;
    const kind = hypothesisFitKind(h);
    const pins = activePins(h);
    const inactive = inactivePins(h);
    const modelClamps = Array.isArray(h?.modelClamps) ? Array.from(new Set(h.modelClamps)) : [];
    const optimizerWarnings = Array.isArray(h?.optimizerWarnings)
        ? Array.from(new Set(h.optimizerWarnings)) : [];
    const boundaryLimited = !!p.boundaryLimited;
    let result;
    const reasons = [];

    if (kind === "directional-geometry") {
        if (rawErr > 0.5) result = tierForRank(0);
        else if (rawErr > 0.15) result = tierForRank(1);
        else if (rawErr > 0.05) result = tierForRank(2);
        else result = tierForRank(3);
        if (rawErr > 0.05) reasons.push(`raw fixed-direction residual ${rawErr.toFixed(2)}°`);
    } else if (p.object !== undefined) {
        if (p.visible === false || rawErr > 2) result = tierForRank(0);
        else if (rawErr > 0.5) result = tierForRank(1);
        else if (rawErr > 0.1) result = tierForRank(2);
        else result = {label: "Close angular match", rank: 3, color: COLORS.pass};
        if (p.visible === false) reasons.push("catalogued object is too faint under the current FOV assumption");
        if (rawErr > 0.1) reasons.push(`raw angular offset ${rawErr.toFixed(2)}°`);
    } else if (p.satellite !== undefined) {
        if (p.sunlit === false || rawErr > 2) result = tierForRank(0);
        else if (rawErr > 0.5) result = tierForRank(1);
        else if (rawErr > 0.15) result = tierForRank(2);
        else result = {label: "Close angular match", rank: 3, color: COLORS.pass};
        if (p.sunlit === false) reasons.push("satellite is in shadow at the sampled time");
        if (rawErr > 0.15) reasons.push(`raw angular offset ${rawErr.toFixed(2)}°`);
    } else {
        const m = h?.metricsFull;
        const gMax = m?.gLoad?.max;
        const speedMaxKt = m?.airSpeed?.max / KNOTS_TO_MS;
        const err = effectiveErrDeg(h);
        const secondary = rankTieScore(h);
        if (![gMax, speedMaxKt, err, secondary].every(Number.isFinite)) {
            return {
                label: "Invalid metrics", rank: -1, color: COLORS.invalid, baseRank: -1,
                eligible: false, boundaryLimited, activePins: pins, inactivePins: inactive,
                incomplete: boundaryLimited || optimizerWarnings.length > 0,
                modelClamps,
                optimizerWarnings,
                rawErrDeg: rawErr, scoredErrDeg: err, secondaryScore: Infinity,
                reasons: ["one or more ranking metrics are missing or non-finite"], kind,
            };
        }
        if (gMax > 9 || speedMaxKt > 900 || err > 0.5) result = tierForRank(0);
        else if (gMax > 4 || speedMaxKt > 650 || err > 0.15) result = tierForRank(1);
        else if (gMax > 1.5 || err > 0.05) result = tierForRank(2);
        else result = tierForRank(3);

        if (gMax > 1.5) reasons.push(`maximum kinematic acceleration ${gMax.toFixed(2)} g`);
        if (speedMaxKt > 650) reasons.push(`peak air speed ${speedMaxKt.toFixed(0)} kt`);
        if (err > 0.05) {
            const label = kind === "ray-constrained" ? "solver-fidelity residual" : "raw LOS residual";
            reasons.push(`${label} ${rawErr.toFixed(2)}° (scored ${err.toFixed(2)}°)`);
        }
    }

    const baseRank = result.rank;
    if (pins.length) {
        const capRank = pins.length >= 2 ? 1 : 2;
        if (result.rank > capRank) result = tierForRank(capRank);
        reasons.push(`${pins.length} locally load-bearing model limit${pins.length === 1 ? "" : "s"}: ${pins.join(", ")}`);
    }
    if (optimizerWarnings.length) {
        if (result.rank > 1) result = tierForRank(1);
        reasons.push(`optimizer incomplete: an inward probe improved ${optimizerWarnings.join(", ")}`);
    }
    if (boundaryLimited) {
        const where = Array.isArray(h?.searchBounds) && h.searchBounds.length
            ? `: ${h.searchBounds.join(", ")}` : "";
        reasons.push(`supported solution family reaches a search boundary${where}`);
    }
    if (modelClamps.length) reasons.push(`internal model clamp reached: ${modelClamps.join(", ")}`);
    if (!reasons.length) {
        if (kind === "identity") reasons.push("angular match and visibility/illumination checks remain inside their displayed thresholds");
        else if (kind === "directional-geometry") reasons.push("fixed-direction residual remains inside its displayed threshold");
        else reasons.push("all broad screening quantities remain inside their displayed thresholds");
    }

    return {
        ...result,
        baseRank,
        eligible: !boundaryLimited && !optimizerWarnings.length && result.rank >= 3,
        incomplete: boundaryLimited || optimizerWarnings.length > 0,
        boundaryLimited,
        activePins: pins,
        inactivePins: inactive,
        modelClamps,
        optimizerWarnings,
        rawErrDeg: rawErr,
        scoredErrDeg: effectiveErrDeg(h),
        secondaryScore: rankTieScore(h),
        reasons,
        kind,
    };
}

export function rankHypotheses(hypotheses) {
    const ranked = (hypotheses || [])
        .filter((h) => h.track && h.metricsFull)
        .map((h) => ({h, r: plausibilityRating(h)}))
        .sort((a, b) => Number(b.r.eligible) - Number(a.r.eligible)
            || Number(a.r.incomplete) - Number(b.r.incomplete)
            || b.r.rank - a.r.rank
            || (a.r.activePins?.length || 0) - (b.r.activePins?.length || 0)
            || a.r.secondaryScore - b.r.secondaryScore
            || (Number.isFinite(a.h.errDeg) ? a.h.errDeg : Infinity)
                - (Number.isFinite(b.h.errDeg) ? b.h.errDeg : Infinity));

    // A display tie is intentionally narrow: same comparison category, both
    // complete, both passing the broad screen, and within the documented score
    // threshold. It is not a statistical statement that "the data can't decide."
    if (ranked.length > 1 && ranked[0].r.eligible && ranked[0].r.rank >= 3) {
        const top = ranked[0];
        for (const x of ranked) {
            x.tied = x.r.eligible && x.r.rank === top.r.rank
                && hypothesisCategory(x.h).key === hypothesisCategory(top.h).key
                && hypothesisFitKind(x.h) === hypothesisFitKind(top.h)
                && Math.abs(x.r.secondaryScore - top.r.secondaryScore) < DISPLAY_TIE_THRESHOLD;
        }
        if (ranked.filter((x) => x.tied).length < 2) {
            for (const x of ranked) x.tied = false;
        }
    }
    return ranked;
}

export function groupAndRankHypotheses(hypotheses) {
    return RANKING_CATEGORIES.map((category) => {
        const members = (hypotheses || []).filter((h) => hypothesisCategory(h).key === category.key);
        const items = rankHypotheses(members);
        items.forEach((item, index) => {
            item.category = category;
            item.groupIndex = index;
            item.groupSize = items.length;
        });
        return {...category, items};
    }).filter((group) => group.items.length);
}

export function formatRawLosResidual(h) {
    const err = h?.errDeg;
    if (!Number.isFinite(err)) return "unavailable";
    const kind = hypothesisFitKind(h);
    const raw = err < 0.1 ? `${err.toFixed(3)}°` : `${err.toFixed(2)}°`;
    if (!(err > 0)) return kind === "ray-constrained" ? "0° (constrained to LOS)" : "0°";
    const ref = h?.params?.errFloor;
    if (Number.isFinite(ref) && ref >= 0.02) {
        const shownRef = ref < 0.1 ? ref.toFixed(3) : ref.toFixed(2);
        return `${raw} (${(err / ref).toFixed(2)}× generic reference ${shownRef}°)`;
    }
    return raw;
}

export function rankingExplanation(h, rating = plausibilityRating(h)) {
    const score = Number.isFinite(rating.secondaryScore)
        ? ` Within-group score ${rating.secondaryScore.toFixed(2)} (lower is better within this category).`
        : "";
    const inactive = rating.inactivePins?.length
        ? ` Parameters at bounds but not locally load-bearing: ${rating.inactivePins.join(", ")}.`
        : "";
    return `${rating.label}: ${rating.reasons.join("; ")}.${inactive}${score}`;
}

export function tierBadge(rating) {
    return {label: rating.label, color: rating.color};
}

export function completenessBadges(rating) {
    const out = [];
    if (rating.boundaryLimited) out.push({label: "Search incomplete", color: "#d9862f"});
    if (rating.activePins?.length) out.push({label: "Model limit hit", color: "#d9862f"});
    if (rating.inactivePins?.length) out.push({label: "Unconstrained at bound", color: "#7b8490"});
    if (rating.modelClamps?.length) out.push({label: "Internal clamp reached", color: "#7b8490"});
    if (rating.optimizerWarnings?.length) out.push({label: "Optimizer incomplete", color: "#8a5a2b"});
    return out;
}
