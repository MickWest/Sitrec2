/**
 * DOM-free traversal ranking and explanation helpers.
 *
 * The gallery contains unlike questions: physically-based object models,
 * LOS-constrained trajectory families, fixed-geometry interpretations, curve
 * fits, and known-object catalogue checks. They must never be presented as one
 * calibrated object-probability ranking, and they are not: there is no
 * cross-model likelihood here and no claim of one.
 *
 * The gallery nonetheless shows them in ONE flat, best-first order, with each
 * tile carrying its category as a coloured label. Sections used to bury the
 * answer an analyst actually wants — "looks like a balloon" — below whichever
 * mathematical family happened to sort first. What makes the flat order sound
 * is that it is decided by keys which ARE comparable across categories (truth
 * separation when a truth track is selected; otherwise screen pass,
 * eligibility, completeness, tier, bound-pin count) before it ever reaches a
 * score that is not. See makeComparator.
 *
 * Each item still reports its standing WITHIN its own category
 * (groupIndex/groupSize), which is the only place a score comparison is sound.
 */

import {KNOTS_TO_MS, METERS_PER_NM, straightFlightScore} from "./TraverseAnalysis";

export const RAY_SOLVER_ALLOWANCE_DEG = 0.05;
export const DISPLAY_TIE_THRESHOLD = 0.05;

const COLORS = {
    pass: "#3fae72",
    moderate: "#c9b23a",
    low: "#d9862f",
    implausible: "#e0564e",
    invalid: "#8a5a2b",
};

// The comparison categories, IN DISPLAY-PRIORITY ORDER. Array order is the
// tiebreak used when two candidates are otherwise equally rated, so
// "Physically based" leading is deliberate: an answer like "looks like a
// balloon" is what an analyst is actually after, and it should not sit below a
// mathematical curve that merely threads the same sightlines.
//
// These are NOT ranked classes of truth — a Geometric fit is not "worse
// evidence" than a physical model. They answer different questions, and the
// colour label on each tile exists so the reader can see which question a tile
// is answering at a glance.
export const RANKING_CATEGORIES = [
    {
        key: "forward",
        label: "Physically based",
        shortLabel: "physically based",
        color: "#4db6a0",
        description: "Real object types with their own dynamics, priors, wind freedom and performance limits — balloon, multirotor, aircraft. These answer \"what could it actually be?\"",
    },
    {
        key: "los",
        label: "LOS Constrained",
        shortLabel: "LOS constrained",
        color: "#5b9bd5",
        description: "Trajectories solved to follow the sightlines under a motion constraint (constant air speed, constant altitude, minimum acceleration). They describe motion the sightlines permit; they are not object types.",
    },
    {
        key: "geometric",
        label: "Geometric",
        shortLabel: "geometric",
        color: "#b07fd0",
        description: "Fixed-geometry interpretations: a stationary object, a light on the ground, or a distant point effectively at infinity.",
    },
    {
        key: "approximation",
        label: "Geometric Approximations",
        shortLabel: "geometric approximations",
        color: "#d09a5b",
        description: "Curve fits to the sightlines — polynomial, Kalman, least-squares, straight line. Shown for comparison and exact application, not as independent object hypotheses.",
    },
    {
        key: "catalogue",
        label: "Known Object",
        shortLabel: "known object",
        color: "#c9738f",
        description: "Named astronomical or satellite alignments, judged by angular offset and visibility rather than by kinematics.",
    },
];

const CATEGORY_BY_KEY = Object.fromEntries(RANKING_CATEGORIES.map((c) => [c.key, c]));

// Display priority of a category, used only as a tiebreak between otherwise
// equally-rated candidates.
const CATEGORY_PRIORITY = Object.fromEntries(RANKING_CATEGORIES.map((c, i) => [c.key, i]));

// Object-conditioned forward models. "droneControl" is the control-input drone
// fit — same object class as "quadcopter" but asking whether a FLOWN path fits,
// not whether any path inside the envelope does, so the two belong in the same
// comparison group and are meant to be read against each other.
const FORWARD_KEYS = new Set(["aircraft", "lantern", "quadcopter", "droneControl"]);

// Buoyant-object hypotheses whose ranking gets the balloon-consistency nudge
// below. Both the free-wind and measured-wind Sky Lantern / Balloon variants use
// key "lantern".
const BUOYANT_KEYS = new Set(["lantern"]);

// How far the balloon-consistency of the fitted motion may move a buoyant
// hypothesis in secondaryScore. secondaryScore counts ~0.05° of LOS residual per
// unit (it includes err/0.05), so 6 ≈ 0.3° of residual-equivalent: a textbook-
// balloon motion can overcome up to ~0.3° of residual disadvantage against a
// same-tier competitor, and an un-balloon-like "balloon" is pushed the same
// amount the other way. It CANNOT cross a fit-quality tier — secondaryScore is
// only consulted once the tier (rank) ties — so this can reorder a balloon and a
// drone that fit about equally, never lift a balloon over a clearly-better fit.
const BALLOON_CONSISTENCY_NUDGE = 6;

// Balloon kinematic signature. A passive wind tracer moves on a SINGLE steady
// vertical trend — rising (constant lift), level (neutral buoyancy) or descending
// (leak/cooling) — and drifts in essentially ONE direction (the wind, which may
// slowly veer with altitude). Vertical oscillation (up then down) and circling
// are strong evidence AGAINST a balloon; a drone can do either, a balloon cannot.
//
// Returns C in [0,1]: 1 = textbook balloon motion, 0 = the opposite. Measured
// self-contained from the solved track as net displacement / path length per
// axis group — 1 when monotonic/straight, → 0 when the path doubles back on
// itself. Complements straightFlightScore (already in secondaryScore), which
// prices horizontal manoeuvring but NOT vertical monotonicity — the distinctive
// balloon tell. A near-level or near-hovering axis is treated as neutral, not
// penalised: calm-wind and neutrally-buoyant balloons are ordinary.
export function balloonConsistency(track) {
    if (!track || track.length < 6) return 0.5;
    const n = Math.floor(track.length / 3);
    let vPath = 0, hPath = 0;
    let prevX = track[0], prevY = track[1], prevZ = track[2];
    for (let f = 1; f < n; f++) {
        const x = track[f * 3], y = track[f * 3 + 1], z = track[f * 3 + 2];
        vPath += Math.abs(z - prevZ);
        hPath += Math.hypot(x - prevX, y - prevY);
        prevX = x; prevY = y; prevZ = z;
    }
    const vNet = Math.abs(track[(n - 1) * 3 + 2] - track[2]);
    const hNet = Math.hypot(track[(n - 1) * 3] - track[0], track[(n - 1) * 3 + 1] - track[1]);
    // Below this total travel an axis has essentially not moved: level flight,
    // or a hover. Neither is un-balloon-like, so score it neutral rather than
    // letting 0/0 noise decide.
    const LEVEL_EPS = 20; // metres
    const vDir = vPath < LEVEL_EPS ? 1.0 : vNet / vPath;     // level or monotonic → 1
    const hDir = hPath < LEVEL_EPS ? 0.5 : hNet / hPath;     // straight drift → 1, circling → 0
    // A balloon needs BOTH: a steady vertical trend AND a one-direction drift.
    // Take the weaker of the two, not their average — a monotonic climb does not
    // excuse a circling ground track, nor a straight drift a vertical yo-yo.
    return Math.max(0, Math.min(1, Math.min(vDir, hDir)));
}
const RAY_KEYS = new Set(["constAir", "constAlt", "plausible", "saddle", "groundVehicle"]);
const GEOMETRIC_KEYS = new Set(["fixedPoint", "ground"]);

export function hypothesisCategory(h) {
    const p = h?.params || {};
    if (p.object !== undefined || p.satellite !== undefined
        || h?.key === "astroNow" || h?.key === "astroTime" || h?.key === "satellite") {
        return CATEGORY_BY_KEY.catalogue;
    }
    if (FORWARD_KEYS.has(h?.key)) return CATEGORY_BY_KEY.forward;
    if (h?.key === "straightLine" || String(h?.key || "").startsWith("gf")) {
        return CATEGORY_BY_KEY.approximation;
    }
    if (GEOMETRIC_KEYS.has(h?.key) || h?.atInfinity) return CATEGORY_BY_KEY.geometric;
    return CATEGORY_BY_KEY.los;
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

// Tier when ORDINARINESS is the binding judgement — these words are about the
// motion the candidate requires, which is what "implausible" can honestly name.
function tierForRank(rank) {
    if (rank >= 3) return {label: "Passes broad screen", rank: 3, color: COLORS.pass};
    if (rank === 2) return {label: "Moderate", rank: 2, color: COLORS.moderate};
    if (rank === 1) return {label: "Low", rank: 1, color: COLORS.low};
    if (rank === 0) return {label: "Kinematically extreme", rank: 0, color: COLORS.implausible};
    return {label: "Invalid", rank: -1, color: COLORS.invalid};
}

// Tier when FIT QUALITY is the binding judgement. Same ranks, so ordering and
// eligibility are untouched — only the wording changes, to say what the
// evidence actually supports: this MODEL reproduces the sightlines poorly. It
// makes no claim about whether the object is plausible.
function tierForFitRank(rank) {
    if (rank >= 3) return {label: "Passes broad screen", rank: 3, color: COLORS.pass};
    if (rank === 2) return {label: "Fair fit", rank: 2, color: COLORS.moderate};
    if (rank === 1) return {label: "Weak fit", rank: 1, color: COLORS.low};
    if (rank === 0) return {label: "Poor fit", rank: 0, color: COLORS.implausible};
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
    // Set by the kinematic branch below. fitRank judges only how well the model
    // reproduces the sightlines; kinematicRank judges only how ordinary the
    // motion is. Kept separate on the record so callers can say which one is
    // binding rather than inferring it from a single collapsed tier.
    let fitRank = null;
    let kinematicRank = null;

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
        // FIT QUALITY and ORDINARINESS are separate judgements and must not be
        // collapsed into one word. They were, and it produced verdicts that were
        // simply false: a quadcopter drifting downwind at 6 kt and 0.09 g —
        // about as ordinary as an object gets, and the closest of five to the
        // truth track — was labelled "Implausible" because its residual missed
        // an absolute 0.5° threshold. That word names the OBJECT; the evidence
        // was about the FIT.
        //
        // The failure runs the other way too: a 12 g solution that reproduces
        // the sightlines exactly is a GOOD fit describing extraordinary motion,
        // and it used to share both a badge and a sort position with a fit that
        // simply diverged. That is how a real finding gets lost.
        //
        // So the tier is still the worse of the two (ordering and eligibility
        // are unchanged), but the LABEL now names whichever dimension is
        // actually binding.
        fitRank = err > 0.5 ? 0 : err > 0.15 ? 1 : err > 0.05 ? 2 : 3;
        kinematicRank = (gMax > 9 || speedMaxKt > 900) ? 0
            : (gMax > 4 || speedMaxKt > 650) ? 1
            : (gMax > 1.5) ? 2 : 3;
        result = fitRank < kinematicRank
            ? tierForFitRank(fitRank)
            : tierForRank(kinematicRank);

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

    // Balloon-consistency nudge (buoyant hypotheses only). A balloon is
    // physically constrained to a steady vertical trend and one-direction drift;
    // when the fitted motion matches that, it is the parsimonious reading of a
    // balloon-like path and earns a bounded promotion, and when it does NOT
    // (vertical reversals, a curved/circling drift the model had to invoke), it
    // is demoted the same amount — an internally strained "balloon". This only
    // ever reorders same-tier candidates (secondaryScore is consulted after the
    // tier ties), so a genuinely better-fitting drone still wins and nothing
    // mundane is forced. See balloonConsistency and BALLOON_CONSISTENCY_NUDGE.
    const buoyant = BUOYANT_KEYS.has(h?.key);
    const balloonC = buoyant ? balloonConsistency(h?.track) : null;
    const balloonAdj = balloonC === null ? 0 : BALLOON_CONSISTENCY_NUDGE * (1 - 2 * balloonC);
    if (balloonC !== null) {
        if (balloonC >= 0.75) {
            reasons.push(`steady vertical trend and one-direction drift — characteristic balloon motion (consistency ${balloonC.toFixed(2)})`);
        } else if (balloonC <= 0.45) {
            reasons.push(`the fitted motion reverses vertically or curves back on itself — atypical for a balloon (consistency ${balloonC.toFixed(2)})`);
        }
    }

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
        fitRank,
        kinematicRank,
        balloonConsistency: balloonC,
        secondaryScore: rankTieScore(h) + balloonAdj,
        reasons,
        kind,
    };
}

// Truth-mode primary sort key: mean 3D separation from the selected truth
// track (meters, lower is better). null = no truth track selected for this
// hypothesis; Infinity = truth selected but not comparable (direction-only
// hypothesis, or no time overlap) — those fall to the end of the group and
// keep the normal screening order among themselves.
function truthSortScore(x) {
    const tc = x?.h?.truthComparison;
    if (tc === undefined || tc === null) return null;
    return tc.comparable && Number.isFinite(tc.score) ? tc.score : Infinity;
}

// Ordering comparator shared by the per-category ranking and the flat gallery
// ordering. `crossCategory` inserts the category-priority tiebreak, which must
// NOT apply when sorting within a single category (there it would be a no-op
// anyway) and which exists to keep the flat order sound — see rankAllHypotheses.
function makeComparator(crossCategory) {
    return (a, b) => {
        // With a truth track selected, closeness to it IS the score — it
        // overrides the screening tiers; they remain the tiebreak. This is the
        // one key that IS soundly comparable across every category, which is
        // why truth mode gives a genuinely quality-led flat order.
        const ta = truthSortScore(a), tb = truthSortScore(b);
        if (ta !== null || tb !== null) {
            const va = ta ?? Infinity, vb = tb ?? Infinity;
            if (va !== vb) return va - vb;
        }
        // Failing the broad screen outright is decided BEFORE completeness;
        // everything finer is decided after it.
        //
        // Completeness leading is deliberate and mostly right: a search that
        // ran off its own edge has not demonstrated its optimum, so its
        // residual should not be led with. But taken absolutely it inverts
        // in one damaging case — a candidate the screen rated *Implausible*
        // (900 kt, 12 g) that merely finished cleanly would outrank a
        // kinematically mild candidate whose only flaw is honestly
        // reporting that its family touched a search edge. That penalises
        // honesty hardest exactly where the mundane answer lives, because
        // broad, weakly-constrained slow families are the ones that reach
        // search edges. Gating on "passed the screen at all" fixes that case
        // without disturbing the finer ordering the design intends (an
        // incomplete Moderate still sorts behind a complete Low). The effect
        // is symmetric: the far/fast Minimum Acceleration tile gains equally.
        const passedScreen = (x) => (x.r.rank >= 1 ? 1 : 0);
        // Category priority sits ABOVE secondaryScore, and only in the flat
        // ordering. secondaryScore is not commensurable across fit kinds:
        // rankTieScore returns raw DEGREES for identity/directional hypotheses
        // but straightFlightScore + err/0.05 (a composite, typically an order of
        // magnitude larger) for everything else. Compared directly, a catalogued
        // planet at 0.5 would outrank every physical model on the board purely
        // because its score is measured in different units. Everything above
        // this line — screen pass, eligibility, completeness, tier, pin count —
        // IS comparable across categories, so the flat order is decided by
        // those first and is genuinely quality-led; category only breaks
        // what would otherwise be an unsound comparison.
        const priority = (x) => CATEGORY_PRIORITY[hypothesisCategory(x.h).key] ?? 99;
        return passedScreen(b) - passedScreen(a)
            || Number(b.r.eligible) - Number(a.r.eligible)
            || Number(a.r.incomplete) - Number(b.r.incomplete)
            || b.r.rank - a.r.rank
            || (a.r.activePins?.length || 0) - (b.r.activePins?.length || 0)
            || (crossCategory ? priority(a) - priority(b) : 0)
            || a.r.secondaryScore - b.r.secondaryScore
            || (Number.isFinite(a.h.errDeg) ? a.h.errDeg : Infinity)
                - (Number.isFinite(b.h.errDeg) ? b.h.errDeg : Infinity);
    };
}

const compareWithinCategory = makeComparator(false);
const compareAcrossCategories = makeComparator(true);

export function rankHypotheses(hypotheses) {
    const ranked = (hypotheses || [])
        .filter((h) => h.track && h.metricsFull)
        .map((h) => ({h, r: plausibilityRating(h)}))
        .sort(compareWithinCategory);

    // A display tie is intentionally narrow: same comparison category, both
    // complete, both passing the broad screen, and within the documented score
    // threshold. It is not a statistical statement that "the data can't decide."
    // Truth mode has its own explicit metric (meters of separation), so the
    // secondary-score tie flag does not apply there.
    if (ranked.length > 1 && ranked[0].r.eligible && ranked[0].r.rank >= 3
        && truthSortScore(ranked[0]) === null) {
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

/**
 * One flat, best-first ordering across every category, for the gallery.
 *
 * The gallery no longer breaks the tiles into labelled sections — each tile
 * carries its category as a coloured corner label instead — because sections
 * buried the answer an analyst actually wants ("looks like a balloon") below
 * whichever mathematical family happened to sort first.
 *
 * Each item keeps `category`, plus `groupIndex`/`groupSize` describing its rank
 * WITHIN its own category, so a tile can still say "#1 of 4 physically based"
 * even though its neighbours on screen come from other categories. Those
 * ordinals are computed from the per-category sort, which is the only place a
 * within-category score comparison is sound.
 */
export function rankAllHypotheses(hypotheses) {
    const items = [];
    for (const group of groupAndRankHypotheses(hypotheses)) items.push(...group.items);
    items.sort(compareAcrossCategories);
    return items;
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
    // Prefer the MEASURED floor when a truth track is loaded: the residual the
    // truth track itself scores against these rays is what a perfect answer
    // gets. The "generic reference" below is only a free constant-acceleration
    // fit — not a floor, and routinely beaten (a balloon reaches 0.61× of it on
    // GoFast) or far worse than achievable (0.58° where truth scores 0.051°).
    // Quoting it can make a 10x-off fit read as "0.93× reference".
    const truthRes = h?.truthResidualDeg;
    if (Number.isFinite(truthRes) && truthRes >= 0) {
        const shown = truthRes < 0.1 ? truthRes.toFixed(3) : truthRes.toFixed(2);
        const ratio = truthRes > 0 ? `${(err / truthRes).toFixed(1)}× ` : "";
        return `${raw} (${ratio}the ${shown}° a perfect answer scores)`;
    }
    const ref = h?.params?.errFloor;
    if (Number.isFinite(ref) && ref >= 0.02) {
        const shownRef = ref < 0.1 ? ref.toFixed(3) : ref.toFixed(2);
        return `${raw} (${(err / ref).toFixed(2)}× generic reference ${shownRef}°)`;
    }
    return raw;
}

// --- Truth-track comparison prose ------------------------------------------

function fmtMeters(m) {
    if (!Number.isFinite(m)) return "n/a";
    if (m >= METERS_PER_NM) {
        const nm = m / METERS_PER_NM;
        return `${nm >= 10 ? nm.toFixed(0) : nm.toFixed(1)} NM`;
    }
    return `${Math.round(m)} m`;
}

// Classify one comparison aspect as concur / partial / diverge.
// relLimits/absFloors: concur below, diverge above; between = partial.
function aspectVerdict(rel, abs, relConcur, relDiverge, absConcur, absDiverge) {
    if (rel < relConcur || abs < absConcur) return "concur";
    if (rel > relDiverge && abs > absDiverge) return "diverge";
    return "partial";
}

/**
 * One-or-two-sentence summary of how a hypothesis compares to the selected
 * truth track: the mean 3D separation that drives its rank, then the aspects
 * where it concurs with / diverges from the truth (location, altitude,
 * speed, heading). Returns null when no truth comparison is attached.
 */
export function truthComparisonSummary(tc) {
    if (tc === undefined || tc === null) return null;
    if (!tc.comparable) {
        return `Truth track: not comparable — ${tc.note || "insufficient overlap"}.`;
    }

    const range = Math.max(1, tc.meanTruthRange);
    const concur = [], partial = [], diverge = [];
    const put = (verdict, text) => {
        (verdict === "concur" ? concur : verdict === "diverge" ? diverge : partial).push(text);
    };

    const horiz = tc.horizontal.mean;
    put(aspectVerdict(horiz / range, horiz, 0.03, 0.12, 30, 100),
        `location (mean horizontal offset ${fmtMeters(horiz)})`);

    const altAbs = tc.altitude.meanAbs;
    const altSigned = tc.altitude.meanSigned;
    const altSide = Math.abs(altSigned) > 0.5 * altAbs
        ? (altSigned > 0 ? ", mostly above truth" : ", mostly below truth") : "";
    put(aspectVerdict(altAbs / range, altAbs, 0.02, 0.08, 30, 100),
        `altitude (mean Δ ${fmtMeters(altAbs)}${altSide})`);

    if (tc.speed) {
        const dv = tc.speed.meanAbsDiff;
        const rel = dv / Math.max(tc.speed.truthMean, 2);
        put(aspectVerdict(rel, dv, 0.15, 0.4, 1, 5),
            `speed (mean Δ ${(dv / KNOTS_TO_MS).toFixed(0)} kt, truth ~${(tc.speed.truthMean / KNOTS_TO_MS).toFixed(0)} kt)`);
    }
    if (tc.heading) {
        const dh = tc.heading.meanAbsDiff;
        put(dh < 10 ? "concur" : dh > 35 ? "diverge" : "partial",
            `heading (mean Δ ${dh.toFixed(0)}°)`);
    } else {
        partial.push("heading (not comparable — hover or stationary motion)");
    }

    let text = `Truth track: mean 3D separation ${fmtMeters(tc.sep3D.mean)} ` +
        `(max ${fmtMeters(tc.sep3D.max)}) at ~${fmtMeters(range)} mean truth range, ` +
        `over ${tc.framesUsed} frames — methods are ordered by this separation.`;
    if (concur.length) text += ` Concurs on ${concur.join("; ")}.`;
    if (partial.length) text += ` Roughly tracks ${partial.join("; ")}.`;
    if (diverge.length) text += ` Diverges on ${diverge.join("; ")}.`;
    return text;
}

export function rankingExplanation(h, rating = plausibilityRating(h)) {
    const score = Number.isFinite(rating.secondaryScore)
        ? ` Within-group score ${rating.secondaryScore.toFixed(2)} (lower is better within this category).`
        : "";
    const inactive = rating.inactivePins?.length
        ? ` Parameters at bounds but not locally load-bearing: ${rating.inactivePins.join(", ")}.`
        : "";
    // With a truth track selected, the truth comparison leads: it is the
    // actual rank driver; the broad screen remains as context.
    const truth = truthComparisonSummary(h?.truthComparison);
    const truthText = truth ? `${truth} Broad screen: ` : "";
    return `${truthText}${rating.label}: ${rating.reasons.join("; ")}.${inactive}${score}`;
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
