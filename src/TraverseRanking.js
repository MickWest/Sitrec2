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
import {
    platformMirrorRank,
    platformMirrorSignificant,
    platformMirrorSummary,
} from "./TraversePlatformMirror";

export const RAY_SOLVER_ALLOWANCE_DEG = 0.05;
export const DISPLAY_TIE_THRESHOLD = 0.05;

// --- Scene-relative fit tiers ----------------------------------------------
//
// The fit thresholds used to be absolute degrees (0.05 / 0.15 / 0.5). That
// silently assumed every scene resolves equally well, and it does not. On the
// Aguadilla ground-track sitch EVERY fitted candidate lands between 0.07 deg
// and 0.19 deg while a free constant-acceleration trajectory — no object
// assumption, nine parameters, not tied to the rays — leaves 0.14 deg. Fit
// quality is therefore not discriminating anything there: the absolute ladder
// was sorting noise, and it dropped the balloon a whole tier below a candidate
// it cannot actually be distinguished from.
//
// So the ladder is expressed in multiples of a per-scene scale: how much of the
// sightline data ordinary smooth motion cannot explain (pointing error, real
// target manoeuvre, and model mismatch together). A model that leaves less than
// that has explained everything a generic trajectory could, and differences
// below it are not evidence about the object.
//
// THE SCALE IS CLAMPED AT BOTH ENDS and that is load-bearing, not tidiness. Too
// small and a noiseless synthetic file (truth threads its own rays to 1e-7 deg)
// would fail every real model; too large and a scene whose generic reference is
// poor would excuse a fit that misses by half a degree — the scale must never
// become an alibi. At the cap the broad-screen boundary sits at 0.24 deg, still
// well inside the old 0.5 deg "Low" boundary. Measured effect on GoFast, whose
// reference is 0.49 deg: the balloon at 0.297 deg moves from "Low" to "Fair
// fit" — it is genuinely better than a generic trajectory manages there — and
// does NOT reach the broad screen.
//
// DELIBERATELY NOT THE TRUTH TRACK'S RESIDUAL, even though that is the real
// measured floor where one is loaded. Blind evaluation (useTruth false, and the
// whole BOT Bench blind ranking) has to see exactly the tiers a real analyst
// sees, and a scale that moved when a truth track was selected would not be
// blind.
export const FIT_SCALE_MIN_DEG = 0.02;
export const FIT_SCALE_MAX_DEG = 0.20;
// Multiples of the scale at which a fit stops being tier 3 / 2 / 1.
export const FIT_SCALE_TIERS = [1.2, 2, 5];

/**
 * The clamped per-scene residual scale for one hypothesis, or null when the
 * analysis did not attach one — in which case the ORIGINAL absolute ladder is
 * used unchanged, so every caller that has not opted in keeps its behaviour.
 */
export function fitScaleDeg(h) {
    const s = h?.fitScaleDeg;
    if (!Number.isFinite(s) || !(s > 0)) return null;
    return Math.min(FIT_SCALE_MAX_DEG, Math.max(FIT_SCALE_MIN_DEG, s));
}

// The fit tier for a scored residual: relative to the scene scale when there is
// one, else the historical absolute boundaries.
function fitRankFor(errDeg, scaleDeg) {
    if (scaleDeg === null) {
        return errDeg > 0.5 ? 0 : errDeg > 0.15 ? 1 : errDeg > 0.05 ? 2 : 3;
    }
    const ratio = errDeg / scaleDeg;
    const [t3, t2, t1] = FIT_SCALE_TIERS;
    return ratio >= t1 ? 0 : ratio >= t2 ? 1 : ratio >= t3 ? 2 : 3;
}

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
    // letting 0/0 noise decide. The vertical threshold scales with the horizontal
    // extent (min 20 m) so a 19 m vs 21 m path does not straddle a fixed boundary
    // and a long, far-drifting clip is judged on the same relative footing (TA-18);
    // a true hover (tiny horizontal travel) still uses the absolute floor.
    const LEVEL_EPS = 20; // metres — absolute floor
    const vLevelEps = Math.max(LEVEL_EPS, 0.02 * hPath);
    const vDir = vPath < vLevelEps ? 1.0 : vNet / vPath;     // level or monotonic → 1
    const hDir = hPath < LEVEL_EPS ? 0.5 : hNet / hPath;     // straight drift → 1, circling → 0
    // A balloon needs BOTH: a steady vertical trend AND a one-direction drift.
    // Take the weaker of the two, not their average — a monotonic climb does not
    // excuse a circling ground track, nor a straight drift a vertical yo-yo.
    return Math.max(0, Math.min(1, Math.min(vDir, hDir)));
}

// A capped local optimizer may return a useful provisional path, but reaching
// its iteration budget is not convergence. Keep that path visible while making
// it ineligible to lead a completed alternative. The normalized simplex spread
// tells the analyst how unresolved the parameter basin still is.
export function localFitCompletionWarnings(optimizer) {
    if (!optimizer || optimizer.stopReason !== "iteration_limit") return [];

    // A COLLAPSED SIMPLEX IS CONVERGENCE, even when the cost tolerance was never
    // met. Nelder-Mead here stops only on BOTH a flat objective and a collapsed
    // simplex, so a fit can exhaust its budget with the simplex already at xTol
    // while costSpread sits above tol. No further iteration can help: there is
    // no x-movement left to shrink the cost spread with. Calling that "budget
    // exhausted before convergence" is a false negative, not a cautious one.
    //
    // It penalised PRECISION, which is the wrong way round. Measured on a
    // benchmark balloon (botset_balloons_orbit, r3.219 km, habsteady wind): the
    // fit that recovered truth to relSep 0.00015 drove its simplex to a full
    // collapse ("spans 0.00% of parameter bounds"), was stamped incomplete, lost
    // the balloon class its viability, and the file reported "Unresolved". A
    // deliberately sloppier fit of the same file — residual 100x worse, range
    // 200 m out, relSep 0.032 — landed in a broad flat basin, met the cost
    // tolerance, and was stamped complete, so THAT one resolved. The better the
    // answer, the likelier it was refused.
    //
    // The complement of settledButUnidentifiable below: that one handles "cost
    // settled, some parameters still wide"; this handles "all parameters
    // collapsed, cost not settled". Between them the only remaining
    // iteration_limit stop is a search that really was still moving.
    const xTol = Number.isFinite(optimizer.xTol) ? optimizer.xTol : 1e-6;
    const spreads = Array.isArray(optimizer.parameterSpreads)
        ? optimizer.parameterSpreads : null;
    // Prefer the per-parameter array: the scalar is a summary, and one wide
    // dimension is what "still moving" means. Missing metadata keeps the
    // warning — silence is never assumed from an absent measurement.
    const collapsed = spreads
        ? spreads.length > 0 && spreads.every((s) => Number.isFinite(s) && s < xTol)
        : (Number.isFinite(optimizer.parameterSpread) && optimizer.parameterSpread < xTol);
    if (collapsed) return [];

    const spread = Number.isFinite(optimizer.parameterSpread)
        ? `; simplex still spans ${(optimizer.parameterSpread * 100).toFixed(2)}% of parameter bounds`
        : "";
    return [`local refinement reached its ${optimizer.iterations ?? "configured"}-iteration budget before convergence${spread}`];
}

// An "iteration_limit" stop is NOT always an unfinished search. Nelder-Mead
// here requires BOTH a flat objective AND a collapsed simplex (cost-only
// stopping is unsafe on LOS fits — see NelderMead.js), so a model parameter
// with no effect on the trajectory over this particular clip legitimately
// holds the simplex wide forever: a lantern whose solved flame-out lies
// beyond the clip never exercises its sink/cool-down parameters, so their
// spread carries no information about the FIT being unfinished. Measured
// case: a genuine easy balloon (recovered by Constant Altitude to the exact
// range and drift speed) was badged "Optimizer incomplete" for exactly this.
//
// This classifies that case: returns a note string when the objective is
// settled (final cost spread within tolerance) and every dimension still
// wide is one the CALLER declares unobservable for this clip; else null
// (keep the ordinary incomplete warning). The note must be presented as an
// identifiability statement — those parameters were NOT measured — never as
// a convergence success for them.
export function settledButUnidentifiable(optimizer, allowedWideNames, requireMinAtLeast = null) {
    if (!optimizer || optimizer.stopReason !== "iteration_limit") return null;
    if (!Array.isArray(optimizer.parameterSpreads) || !Array.isArray(optimizer.paramNames)) return null;
    if (!allowedWideNames || !allowedWideNames.length) return null;
    const tol = Number.isFinite(optimizer.tol) ? optimizer.tol : 1e-8;
    const xTol = Number.isFinite(optimizer.xTol) ? optimizer.xTol : 1e-6;
    if (!(Number.isFinite(optimizer.costSpread) && optimizer.costSpread < tol)) return null;
    const allowed = new Set(allowedWideNames);
    const wide = [];
    for (let j = 0; j < optimizer.parameterSpreads.length; j++) {
        if (optimizer.parameterSpreads[j] >= xTol) {
            wide.push(optimizer.paramNames[j] ?? `param${j}`);
        }
    }
    if (!wide.length) return null;              // nothing wide: not this case
    if (wide.some((name) => !allowed.has(name))) return null;
    // The WHOLE simplex must sit in the unobservable region, not just the
    // best vertex: a lantern tBurn simplex straddling the clip end is a real
    // ambiguity between "still burning" and "already cooling" — that stays an
    // incomplete search. requireMinAtLeast = {paramName: minValue} demands
    // the simplex's minimum for each named parameter be at/above the value;
    // missing minima metadata refuses conservatively.
    if (requireMinAtLeast) {
        if (!Array.isArray(optimizer.parameterMins)) return null;
        for (const [name, minValue] of Object.entries(requireMinAtLeast)) {
            const j = optimizer.paramNames.indexOf(name);
            if (j < 0) return null;
            const lo = optimizer.parameterMins[j];
            if (!Number.isFinite(lo) || lo < minValue) return null;
        }
    }
    return `objective settled; ${wide.join(", ")} unconstrained by this clip `
        + `(not measured — an identifiability limit, not an optimizer failure)`;
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

// Tier when PLATFORM MIRRORING is the binding judgement. A third dimension
// beside fit quality and kinematic ordinariness, and it needed its own words
// for the same reason pins did: a candidate whose manoeuvre is the camera's
// manoeuvre is not fitting badly (it follows the sightlines perfectly) and is
// not kinematically extreme (0.48 g and 51 kt are unremarkable numbers). Called
// "Moderate" it says nothing; called this, it names the finding.
//
// It never reaches rank 0. An object CAN pace the observing platform — a chase
// aircraft, a drone flown to follow the camera — so the reading stays available
// and stays in the gallery. It is only extraordinary, which is what the tier
// now says and what costing nothing at all did not.
function tierForMirrorRank(rank) {
    if (rank >= 3) return {label: "Passes broad screen", rank: 3, color: COLORS.pass};
    if (rank === 2) return {label: "Partly mirrors the platform", rank: 2, color: COLORS.moderate};
    return {label: "Mirrors the platform", rank: 1, color: COLORS.low};
}

// How far platform mirroring may move a candidate in secondaryScore, in the
// same residual-equivalent units as BALLOON_CONSISTENCY_NUDGE (~0.3 deg at the
// full value). ASYMMETRIC BY DESIGN: it only ever demotes. Not mirroring the
// platform is the ordinary expectation, not an achievement to be rewarded, and
// a promotion here would be a thumb on the scale for far solutions.
const PLATFORM_MIRROR_NUDGE = 6;

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
    // Never null once the kinematic branch runs: 3 means "measured, and this
    // candidate's motion is its own", which is a different statement from the
    // null that means "not evaluated for this kind of hypothesis".
    let mirrorRank = null;
    const scaleDeg = fitScaleDeg(h);

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
        fitRank = fitRankFor(err, scaleDeg);
        kinematicRank = (gMax > 9 || speedMaxKt > 900) ? 0
            : (gMax > 4 || speedMaxKt > 650) ? 1
            : (gMax > 1.5) ? 2 : 3;
        // THE THIRD BINDING DIMENSION. Fit quality asks whether the model
        // reproduces the sightlines; kinematic ordinariness asks whether the
        // motion is extreme; this asks whether the motion is the OBSERVER's.
        // A wrong range injects the platform's own manoeuvre into the solved
        // path (see TraversePlatformMirror.js), and neither of the other two
        // can see it: such a candidate follows the rays perfectly and its
        // speeds and g-loads are unremarkable. Measured on Aguadilla, the
        // gallery leader required an object flying a 0.23x copy of the camera
        // aircraft's path — 270 m of mirroring against 56 m of motion of its
        // own — and was rated exactly as ordinary as a drifting balloon.
        mirrorRank = platformMirrorRank(h?.platformMirror);
        // The MIRROR ONLY GETS TO NAME THE TIER WHEN IT IS STRICTLY THE WORST.
        // On a tie the measured failure keeps the stronger word: a model that
        // reproduces the sightlines poorly AND mirrors should be reported as
        // fitting poorly. The mirroring still appears in the reasons either
        // way, so the fact is never hidden by the label it did not win.
        result = (mirrorRank < fitRank && mirrorRank < kinematicRank)
            ? tierForMirrorRank(mirrorRank)
            : fitRank < kinematicRank
                ? tierForFitRank(fitRank)
                : tierForRank(kinematicRank);

        if (gMax > 1.5) reasons.push(`maximum kinematic acceleration ${gMax.toFixed(2)} g`);
        if (speedMaxKt > 650) reasons.push(`peak air speed ${speedMaxKt.toFixed(0)} kt`);
        const mirrorWhy = platformMirrorSummary(h?.platformMirror);
        if (mirrorWhy) {
            reasons.push(`the platform's own manoeuvre explains this path — ${mirrorWhy}`
                + "; an object can pace the camera, but that is an extraordinary thing "
                + "for one to do, and a wrong range produces the same signature");
        }
        if (err > 0.05) {
            const label = kind === "ray-constrained" ? "solver-fidelity residual" : "raw LOS residual";
            reasons.push(`${label} ${rawErr.toFixed(2)}° (scored ${err.toFixed(2)}°)`);
        }
    }

    const baseRank = result.rank;
    if (pins.length) {
        const capRank = pins.length >= 2 ? 1 : 2;
        // The RANK cap stays (ordering and eligibility are unchanged), but when
        // the PIN is what binds, the label must not come from tierForRank, whose
        // words — "Moderate", "Low" — describe how ordinary the OBJECT's motion
        // is. A pinned fit has not been judged on its motion at all; its search
        // hit one of the model's own limits and stopped. Naming that "Low" is
        // the fit-vs-ordinariness confusion the comment above exists to prevent,
        // with pins as a third binding dimension that had no vocabulary.
        //
        // Measured: bot-0009's balloon — closest to truth on that scenario at
        // 0.037 deg — was badged "Moderate"; bot-0006's genuine high-altitude
        // balloon was badged "Low".
        //
        // ONLY WHEN THE PIN IS BINDING. If the fit or the kinematics is already
        // at or below the cap, that is a real, measured failure and its label is
        // the stronger statement — a model that reproduces the sightlines poorly
        // AND pins should be reported as fitting poorly, not as merely untested.
        // Relabelling unconditionally (as a first version of this did) would
        // overwrite "Poor fit" and "Kinematically extreme" and hide them.
        if (result.rank > capRank) {
            result = {...tierForRank(capRank), label: "Not fully tested"};
        }
        reasons.push(`${pins.length} locally load-bearing model limit${pins.length === 1 ? "" : "s"}: ${pins.join(", ")}`);
    }
    if (optimizerWarnings.length) {
        if (result.rank > 1) result = tierForRank(1);
        result = {...result, label: "Provisional fit"};
        reasons.push(`optimizer incomplete: ${optimizerWarnings.join("; ")}`);
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
        // Disclose the nudge's MAGNITUDE in residual-equivalent (secondaryScore
        // counts 0.05 deg of LOS residual per unit), so the reader can see exactly
        // how strong this object-class prior is and that it only reorders within a
        // fit-quality tier — it never crosses one (TA-18).
        const nudgeDeg = (Math.abs(balloonAdj) * 0.05).toFixed(2);
        if (balloonC >= 0.75) {
            reasons.push(`steady vertical trend and one-direction drift — characteristic balloon motion (consistency ${balloonC.toFixed(2)}); this promotes it by up to ${nudgeDeg}° of residual-equivalent within its fit tier, so it leads a drone or geometric fit only when they sit inside that margin`);
        } else if (balloonC <= 0.45) {
            reasons.push(`the fitted motion reverses vertically or curves back on itself — atypical for a balloon (consistency ${balloonC.toFixed(2)}); this demotes it by up to ${nudgeDeg}° of residual-equivalent within its fit tier`);
        }
    }

    // Within-tier demotion for a mirroring candidate, on the same
    // residual-equivalent scale as the balloon nudge. Consulted only once the
    // tier ties, so it reorders candidates the screen could not separate and
    // never lifts one over a better-rated fit.
    const mirrorAdj = platformMirrorSignificant(h?.platformMirror)
        ? PLATFORM_MIRROR_NUDGE * h.platformMirror.share : 0;

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
        mirrorRank,
        fitScaleDeg: scaleDeg,
        platformMirror: h?.platformMirror ?? null,
        balloonConsistency: balloonC,
        secondaryScore: rankTieScore(h) + balloonAdj + mirrorAdj,
        reasons,
        kind,
    };
}

// --- Executive interpretation-class assessment ------------------------------
//
// The executive verdict ("Probably a wind-blown balloon", "Consistent with
// several conventional interpretations", ...) is CORROBORATION-FIRST: a
// "Probably" headline is licensed by independent class-specific evidence
// (today: the free balloon fit's frozen wind agreement), never by gallery
// position or by being the sole surviving fit. This preserves the
// no-global-winner rule — the ranking comparator above is untouched and the
// assessment must never feed back into ordering.
//
// Interpretation CLASSES are not the gallery display categories: the free and
// wind-pinned balloon fits are one class, as are the two drone fits. Geometric
// and curve fits (constAir, plausible, gf*, sweeps) are compatibility screens,
// not object classes, and do not appear here.
//
// Everything below is pure data-in/data-out (no DOM, no NodeMan) so it is
// unit-testable and so the gallery, verdict, and report all render the SAME
// frozen record instead of reclassifying separately.

// Mundane causes the analysis has NO model for. The verdict must disclose
// these — "does not fit any tested model" is meaningless without them — and
// the list is deliberately static so it cannot silently drift out of sync
// with a claim of coverage.
export const NOT_MODELLED_DISCLOSURE = [
    "birds and insects",
    "airborne debris",
    "helicopters and rockets",
    "reflections, glare, and bokeh",
    "video-processing artefacts",
];

const INTERPRETATION_CLASS_DEFS = [
    // "astroTime" is the date-SWEEPING diagnostic and must never support an
    // event-time identification, so it is deliberately absent from knownObject.
    {key: "balloon", label: "wind-blown balloon", keys: ["lantern"]},
    {key: "fixedWing", label: "conventional fixed-wing aircraft", keys: ["aircraft"]},
    {key: "multirotor", label: "multirotor drone", keys: ["quadcopter", "droneControl"]},
    {key: "stationary", label: "stationary or ground-bound object",
        keys: ["fixedPoint", "ground", "groundVehicle"]},
    {key: "knownObject", label: "catalogued satellite or astronomical object",
        keys: ["satellite", "astroNow"]},
];

// One representative hypothesis, judged. The predicates are deliberately
// STRICTER than gallery eligibility: "complete" also rejects load-bearing
// bound pins and internal model clamps — a fit that only works pressed
// against its own limits cannot carry an executive conclusion.
function judgeRepresentative(h) {
    const r = plausibilityRating(h);
    const kind = hypothesisFitKind(h);
    if (kind === "identity") {
        // Catalogue identification: rank 3 is the close-angular-match screen.
        // Kinematic ordinariness does not apply to an identification, so it is
        // null (not true) — the matrix must not show a ✓ for a predicate that
        // was never evaluated.
        //
        // The ANGULAR match and the VISIBILITY/illumination check are separate
        // facts and must be reported separately: a satellite 0.05° away but in
        // Earth's shadow was matched-and-ruled-out, which is the opposite of
        // "no close catalogue match".
        const p = h.params || {};
        const err = Number.isFinite(h.errDeg) ? h.errDeg : Infinity;
        const angularClose = err <= (p.satellite !== undefined ? 0.15 : 0.1);
        const notVisible = p.visible === false || p.sunlit === false;
        // "close" states the ANGULAR fact alone — the matrix column must agree
        // with prose that says "close angular match". Viability additionally
        // requires the object to be visible/sunlit (rank 3 folds both in).
        const close = angularClose;
        const viable = r.rank === 3;
        let blocker = null;
        if (!viable) {
            blocker = (angularClose && notVisible)
                ? (p.satellite !== undefined
                    ? `close angular match (${err.toFixed(2)}°), but the satellite is in Earth's `
                        + "shadow at this time"
                    : `close angular match (${err.toFixed(2)}°), but the object is too faint under `
                        + "the current field-of-view assumption")
                : (r.reasons?.[0] ?? "no close angular match");
        }
        return {r, complete: true, close, ordinary: null, viable, blocker,
            angularClose, notVisible};
    }
    if (kind === "directional-geometry" || h.atInfinity) {
        // A direction-only geometric check (e.g. a point at infinity) fits
        // angles but evaluates NO physical motion — it must never make an
        // object class "viable", however small its residual.
        return {r, complete: false, close: false, ordinary: false, viable: false,
            blocker: "direction-only geometric check — no physical motion is evaluated"};
    }
    // Early-return ratings (underground, non-physical, off-mode, invalid
    // metrics) carry no fitRank; their first reason is the honest blocker.
    if (!h.track || r.rank < 0 || r.fitRank == null) {
        return {r, complete: false, close: false, ordinary: false, viable: false,
            blocker: h.track ? (r.reasons?.[0] ?? r.label) : "fit failed or returned no solution"};
    }
    const complete = !r.incomplete
        && !(r.activePins && r.activePins.length)
        && !(r.modelClamps && r.modelClamps.length);
    const close = r.fitRank === 3;
    // ORDINARY covers both ways the motion can be extraordinary. A fit that
    // requires the object to fly the observing platform's own path must not
    // make its class "viable" and so must not reach an executive conclusion:
    // the wording there ("consistent with a conventional fixed-wing aircraft")
    // would be asserting the ordinary reading of a candidate whose whole
    // manoeuvre is the camera's.
    const mirrored = (r.mirrorRank ?? 3) < 3;
    const ordinary = r.kinematicRank === 3 && !mirrored;
    let blocker = null;
    if (!complete) blocker = "search incomplete (bound pins, clamps, or an unconverged optimizer)";
    else if (!close) blocker = `LOS fit not close (${Number.isFinite(r.scoredErrDeg)
        ? r.scoredErrDeg.toFixed(2) : "?"}° scored residual)`;
    else if (mirrored && r.kinematicRank === 3) {
        blocker = "the platform's own manoeuvre explains the solved path "
            + `(${Math.round((r.platformMirror?.share ?? 0) * 100)}% of it), so the fit `
            + "requires an object pacing the camera or a wrong range";
    } else if (!ordinary) blocker = "requires non-ordinary kinematics";
    return {r, complete, close, ordinary, viable: complete && close && ordinary, blocker};
}

/**
 * Aggregate the hypothesis list into interpretation classes with the
 * executive predicates: tested, complete/close/ordinary, viable, and (for the
 * balloon class) the independent wind evidence carried by the free fit.
 */
export function aggregateInterpretationClasses(hypotheses) {
    const list = hypotheses || [];
    return INTERPRETATION_CLASS_DEFS.map((def) => {
        const reps = list.filter((h) => def.keys.includes(h.key));
        const judged = reps.map((h) => ({h, ...judgeRepresentative(h)}));
        const viableRep = judged.find((j) => j.viable) ?? null;
        const best = viableRep ?? judged.slice().sort((a, b) =>
            (a.r.scoredErrDeg ?? Infinity) - (b.r.scoredErrDeg ?? Infinity))[0] ?? null;
        const cls = {
            key: def.key,
            label: def.label,
            tested: judged.length > 0,
            viable: !!viableRep,
            complete: !!best?.complete,
            close: !!best?.close,
            ordinary: !!best?.ordinary,
            blocker: viableRep ? null : (best?.blocker ?? "not tested in this run"),
            bestName: best?.h?.name ?? null,
            bestErrDeg: Number.isFinite(best?.r?.scoredErrDeg) ? best.r.scoredErrDeg : null,
            supported: false,
            supportNote: null,
        };
        if (def.key === "balloon") {
            const free = reps.find((h) => h.windEvidenceRole === "free");
            const freeJudged = judged.find((j) => j.h === free) ?? null;
            const ev = free?.windEvidence ?? null;
            cls.windRating = (ev && ev.role === "free") ? (ev.rating ?? null) : null;
            cls.windWhy = ev?.why ?? null;
            cls.windSource = ev?.source ?? null;
            cls.consistency = freeJudged?.r?.balloonConsistency
                ?? (free?.track ? balloonConsistency(free.track) : null);
            // Only the free fit's agreement is independent — and "supports"
            // already carries every capture-time quality cap (source class,
            // sounding distance at contributing altitudes, measured tops,
            // completeness, observable range).
            cls.supported = !!(freeJudged?.viable && cls.windRating === "supports");
            cls.supportNote = cls.windRating
                ? `independent wind evidence: ${cls.windRating}` : null;
        }
        return cls;
    });
}

// Corroboration wording for a sole viable class that CANNOT claim "Probably".
function noCorroborationReason(cls) {
    if (cls.key === "balloon" && cls.windRating) {
        if (cls.windRating === "supports") {
            // Reachable when the wind supports passive drift but the motion
            // itself is not distinctly balloon-like (consistency below the
            // "Probably" gate) — the supporting evidence must be acknowledged,
            // never misdescribed as inconclusive.
            const c = Number.isFinite(cls.consistency) ? cls.consistency.toFixed(2) : "low";
            return `although the independent wind evidence supports passive drift (${cls.windWhy}), `
                + `the fitted motion is not distinctly balloon-like (consistency ${c}), so `
                + `"probably" is not claimed`;
        }
        if (cls.windRating === "tension") {
            return `the independent wind evidence is in tension — ${cls.windWhy} — which `
                + "weakens but does not exclude the balloon interpretation";
        }
        if (cls.windRating === "compatible") {
            return `the independent wind evidence is only compatible, not supporting — ${cls.windWhy}`;
        }
        return `the independent wind evidence is inconclusive — ${cls.windWhy}`;
    }
    if (cls.key === "knownObject") {
        // The catalogue match IS what made this class viable — the missing
        // piece is a calibrated pointing uncertainty, without which a close
        // angular offset cannot be promoted to a positive identification.
        return "although the catalogued object's angular match is close, the sightline pointing "
            + "uncertainty is not calibrated in this analysis, so a positive identification "
            + "is not claimed";
    }
    return "no independent corroborating evidence (an ADS-B/radar track, a catalogue match, "
        + "or a supporting wind comparison) is available for it";
}

/**
 * The frozen executive assessment: a verdict code, a one-sentence plain-text
 * headline, a supporting detail paragraph, and the per-class audit trail. The
 * caller freezes this into the analysis results; gallery, verdict, and report
 * all render THIS record. Plain text throughout — renderers escape.
 *
 * Deliberately asymmetric and conservative: "Probably" needs independent
 * corroboration; a sole survivor is only "Consistent with"; and the absence
 * of any passing model yields "Unresolved" — never an anomaly claim, because
 * this release has no calibrated LOS noise floor and no envelope-wide
 * exclusion certificates (see the design notes; the strict negative verdict
 * lands only once those exist).
 */
export function assessExecutiveVerdict(hypotheses, context = {}) {
    const prov = context.provenance || {};
    const classes = aggregateInterpretationClasses(hypotheses);
    const notRun = classes.filter((c) => !c.tested).map((c) => c.label);
    const base = {classes, notRun, notModelled: NOT_MODELLED_DISCLOSURE,
        gates: {circular: !!prov.circular, rangeUnobservable: !!prov.rangeUnobservable}};

    if (prov.circular) {
        return {...base, code: "insufficient",
            headline: "Insufficient independent evidence to discriminate.",
            detail: "The sightlines are constructed from the target being tested, so these results "
                + "validate the scene's internal consistency only and cannot identify the object."};
    }
    if (prov.rangeUnobservable) {
        return {...base, code: "insufficient",
            headline: "Insufficient evidence to discriminate.",
            detail: "Range is not determined by this evidence — the sensor's motion provides no "
                + "usable parallax, so every model's distance reflects its own priors and "
                + "range-dependent classification is not possible."};
    }

    const viable = classes.filter((c) => c.viable);
    const balloon = classes.find((c) => c.key === "balloon");
    const knownObject = classes.find((c) => c.key === "knownObject");

    if (balloon && balloon.viable && balloon.supported
        && Number.isFinite(balloon.consistency) && balloon.consistency >= 0.75
        && !(knownObject && knownObject.viable)) {
        return {...base, code: "probably-balloon",
            headline: "Probably a wind-blown balloon.",
            detail: "The complete free-wind balloon model reproduces the sightlines with ordinary, "
                + `balloon-like motion (consistency ${balloon.consistency.toFixed(2)}), and the wind `
                + `it requires independently agrees with the loaded winds aloft — ${balloon.windWhy}. `
                + "Other displayed candidates remain compatibility screens; this conclusion comes "
                + "from independent wind corroboration, not from a global object-probability ranking."};
    }

    if (viable.length === 1) {
        const c = viable[0];
        return {...base, code: "consistent-one",
            headline: `Consistent with a ${c.label}, but not identified.`,
            detail: `The ${c.label} interpretation gives a complete, ordinary, close fit, but `
                + `${noCorroborationReason(c)}. The sightlines alone do not establish the object type.`};
    }

    if (viable.length >= 2) {
        return {...base, code: "consistent-several",
            headline: "Consistent with several conventional interpretations.",
            detail: `Complete, ordinary, close fits were found for: ${viable.map((c) => c.label).join("; ")}. `
                + "The available sightline and external evidence does not distinguish among them. "
                + "No cross-category probability comparison has been made."};
    }

    // Nothing viable. This is the safety valve, not an anomaly claim.
    const reasons = [];
    for (const c of classes) {
        // "not run or did not complete": coverage is inferred from hypothesis
        // presence, and a check that ran but errored also leaves no record —
        // the failures banner carries the specifics.
        if (!c.tested) reasons.push(`the ${c.label} checks were not run or did not complete`);
        else if (!c.viable) reasons.push(`${c.label}: ${c.blocker}`);
    }
    reasons.push("the sightline noise floor is not calibrated and model envelopes were not "
        + "exhaustively excluded, so a strict exclusion audit has not been performed");
    return {...base, code: "unresolved",
        headline: "Unresolved — no completed tested conventional model passes the current screen.",
        detail: "This is not, by itself, evidence of anomalous motion or an anomalous object. A "
            + "negative conventional-model conclusion is not licensed here because: "
            + `${reasons.join("; ")}.`};
}

// Truth-mode primary sort key: mean 3D separation from the selected truth
// track (meters, lower is better). null = no truth track selected for this
// hypothesis; Infinity = truth selected but not comparable (direction-only
// hypothesis, or no time overlap) — those fall to the end of the group and
// keep the normal screening order among themselves.
//
// useTruth = false presents the SAME already-computed results blind: the
// comparisons stay attached to the hypotheses (the report and the tiles still
// show them) but they no longer decide the order. That is what the gallery's
// "Use Truth Track" toggle switches, without re-running anything.
function truthSortScore(x, useTruth = true) {
    if (!useTruth) return null;
    const tc = x?.h?.truthComparison;
    if (tc === undefined || tc === null) return null;
    return tc.comparable && Number.isFinite(tc.score) ? tc.score : Infinity;
}

// Ordering comparator shared by the per-category ranking and the flat gallery
// ordering. `crossCategory` inserts the category-priority tiebreak, which must
// NOT apply when sorting within a single category (there it would be a no-op
// anyway) and which exists to keep the flat order sound — see rankAllHypotheses.
function makeComparator(crossCategory, useTruth = true) {
    return (a, b) => {
        // With a truth track selected, closeness to it IS the score — it
        // overrides the screening tiers; they remain the tiebreak. This is the
        // one key that IS soundly comparable across every category, which is
        // why truth mode gives a genuinely quality-led flat order.
        const ta = truthSortScore(a, useTruth), tb = truthSortScore(b, useTruth);
        if (ta !== null || tb !== null) {
            // Truth separation compares completed solutions. A provisional fit
            // that stopped before convergence must not lead merely because its
            // current iterate happens to sit closer to the known answer.
            const completeness = Number(a.r.incomplete) - Number(b.r.incomplete);
            if (completeness) return completeness;
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
// Blind variants: identical except that a truth comparison never decides order.
const compareWithinCategoryBlind = makeComparator(false, false);
const compareAcrossCategoriesBlind = makeComparator(true, false);

export function rankHypotheses(hypotheses, {useTruth = true} = {}) {
    const ranked = (hypotheses || [])
        .filter((h) => h.track && h.metricsFull)
        .map((h) => ({h, r: plausibilityRating(h)}))
        .sort(useTruth ? compareWithinCategory : compareWithinCategoryBlind);

    // A display tie is intentionally narrow: same comparison category, both
    // complete, both passing the broad screen, and within the documented score
    // threshold. It is not a statistical statement that "the data can't decide."
    // Truth mode has its own explicit metric (meters of separation), so the
    // secondary-score tie flag does not apply there.
    if (ranked.length > 1 && ranked[0].r.eligible && ranked[0].r.rank >= 3
        && truthSortScore(ranked[0], useTruth) === null) {
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
export function rankAllHypotheses(hypotheses, opts = {}) {
    const items = [];
    // Co-leader marks are applied inside groupAndRankHypotheses (on the flat
    // order), so both this path and the report's direct grouping see them.
    for (const group of groupAndRankHypotheses(hypotheses, opts)) items.push(...group.items);
    items.sort(opts.useTruth === false ? compareAcrossCategoriesBlind : compareAcrossCategories);
    return items;
}

// CO-LEADERS. Everything the flat comparator decides ABOVE the tie-breakers
// — screen pass, eligibility, completeness, fit tier, bound-pin count — is
// sound and comparable across categories. Everything BELOW that line is
// heuristic: category priority, a secondaryScore that is not commensurable
// across fit kinds, raw residual. So a candidate that matches the leader on
// every discrete key is not "second place" — the analysis genuinely cannot
// order it against the leader, and BOT Bench measured what treating the
// first tile as the answer costs (the blind ranking picked the closest
// available candidate on 3 of 18 scenarios whose galleries contained one).
// Marking is on the RATING (item.r.coLeader) so every badge/report surface
// that already carries the rating can disclose it. A lone leader gets no
// mark: co-leadership is only meaningful as a tie. With a truth track
// SELECTED, truth separation is a sound cross-category key that genuinely
// orders candidates (it leads the comparator) — so differing truth scores
// break co-leadership too; claiming "cannot order" while truth just ordered
// them would be false.
export function markCoLeaders(items, opts = {}) {
    if (!items || !items.length) return items;
    const useTruth = opts.useTruth !== false;
    const key = (x) => [
        x.r.rank >= 1 ? 1 : 0,
        Number(x.r.eligible),
        Number(x.r.incomplete),
        x.r.rank,
        x.r.activePins?.length || 0,
    ].join("|");
    const lead = items[0];
    const leadKey = key(lead);
    const leadTruth = truthSortScore(lead, useTruth);
    const co = items.filter((x) => key(x) === leadKey
        && Object.is(truthSortScore(x, useTruth), leadTruth));
    for (const x of items) x.r.coLeader = false;
    if (co.length > 1) for (const x of co) x.r.coLeader = true;
    return items;
}

// Badge for a co-leading candidate, in the {label, color} shape the gallery
// renders. Returned as an array so call sites can spread it like the other
// conditional badge sets.
export function coLeaderBadge(rating) {
    return rating.coLeader ? [{label: "Co-leader", color: "#3c6d9e"}] : [];
}

export function groupAndRankHypotheses(hypotheses, opts = {}) {
    const groups = RANKING_CATEGORIES.map((category) => {
        const members = (hypotheses || []).filter((h) => hypothesisCategory(h).key === category.key);
        const items = rankHypotheses(members, opts);
        items.forEach((item, index) => {
            item.category = category;
            item.groupIndex = index;
            item.groupSize = items.length;
        });
        return {...category, items};
    }).filter((group) => group.items.length);
    // Mark co-leaders HERE, on the flat cross-category order, so every caller
    // gets marked ratings — the gallery ranks through rankAllHypotheses, but
    // the report re-groups FRESH ratings directly through this function, and
    // marking only the other path left the report's badges permanently blank.
    const flat = groups.flatMap((g) => g.items).sort(
        opts.useTruth === false ? compareAcrossCategoriesBlind : compareAcrossCategories);
    markCoLeaders(flat, opts);
    return groups;
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
        `over ${tc.framesUsed} frames — completed methods are ordered by this separation; ` +
        `incomplete searches follow them.`;
    if (concur.length) text += ` Concurs on ${concur.join("; ")}.`;
    if (partial.length) text += ` Roughly tracks ${partial.join("; ")}.`;
    if (diverge.length) text += ` Diverges on ${diverge.join("; ")}.`;
    return text;
}

export function rankingExplanation(h, rating = plausibilityRating(h), {useTruth = true} = {}) {
    const score = Number.isFinite(rating.secondaryScore)
        ? ` Within-group score ${rating.secondaryScore.toFixed(2)} (lower is better within this category).`
        : "";
    const inactive = rating.inactivePins?.length
        ? ` Parameters at bounds but not locally load-bearing: ${rating.inactivePins.join(", ")}.`
        : "";
    // With a truth track selected AND applied, completeness gates the truth
    // comparison, which then drives rank; the broad screen remains as context.
    // With it merely selected (gallery "Use Truth Track" off), the order is the
    // ordinary screening order, so the basis must not claim otherwise.
    const truth = useTruth ? truthComparisonSummary(h?.truthComparison) : null;
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
