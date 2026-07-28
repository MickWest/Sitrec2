/**
 * classProbability.js — turn the traverse analysis's categorical verdict into
 * calibrated per-class percentages ("Balloon 40%, Fixed-wing 10%, Unknown 50%").
 *
 * WHAT LICENSES THE NUMBERS. Sitrec deliberately computes no cross-model
 * likelihood — different models, different parameter counts, different priors,
 * so a softmax over residuals would be meaningless (see the header of
 * src/TraverseRanking.js). These percentages are not that. They are MEASURED
 * FREQUENCIES over labelled benchmark scenarios: "of the scenarios whose
 * analysis produced this same evidence signature, k of N actually were
 * balloons". Every percentage therefore ships with its N, its independent-group
 * count G, and an interval — and it is a statement about the BOT Bench
 * population, not a real-world prior.
 *
 * WHAT THE ESTIMAND IS. Scenarios are not independent: the block matrix repeats
 * the same truth content across seeds, durations and observation noise. Naive
 * frequencies would let a 16-member supergroup outvote a singleton. So each
 * truth-content GROUP (classifier.truthContentKey) carries equal weight, and
 * uncertainty comes from resampling GROUPS, not scenarios. A Jeffreys binomial
 * interval would be incoherent here — it assumes counts, and these are weighted
 * proportions.
 *
 * WHAT "UNKNOWN" MEANS. It is not a failure bucket. It absorbs every truth
 * label the analysis has no model for — birds, anomalous events, tethered
 * aerostats — plus bins too thin to say anything. How often a bird reads as a
 * balloon is a headline result of this exercise, not a rounding error.
 */

import {truthContentKey} from "./classifier";

// Sitrec's interpretation classes (TraverseRanking.INTERPRETATION_CLASS_DEFS)
// plus the explicit residual.
export const REPORT_CLASSES = ["balloon", "fixedWing", "multirotor", "stationary",
    "knownObject", "unknown"];

// Truth labels that map onto a Sitrec class. Everything absent from this map is
// deliberately unmapped and lands in "unknown" — see UNMAPPED_LABELS.
export const TRUTH_TO_CLASS = {
    balloon: "balloon",
    aircraft: "fixedWing",
    venus: "knownObject",
};

// Truth labels with NO Sitrec class, and why. These are not gaps to be closed
// by force-mapping; each one measures something real about the analysis.
export const UNMAPPED_LABELS = {
    bird: "birds are not modelled at all (they are named in the verdict's "
        + "not-modelled disclosure), so a bird SHOULD read as unknown — how often it "
        + "instead reads as a balloon is a headline result",
    aerostat: "a tethered aerostat is neither a free balloon nor a stationary object; "
        + "forcing it into either would manufacture an accuracy number",
    anomalous: "anomalous events and their ordinary controls are, by construction, "
        + "outside every tested conventional model",
};

// Classes the 855-scenario matrix cannot calibrate at all. Reported as
// "not calibrated", NEVER as 0% — a zero would read as "ruled out".
export const UNCALIBRATED_CLASSES = {
    multirotor: "BOT Bench has no multirotor target. Adding one needs independent "
        + "truth equations; generating it from QuadcopterModel would be an inverse "
        + "crime (PLAN.md design law 1).",
    stationary: "BOT Bench has no stationary or ground-bound target.",
};

/** The truth label for a scenario spec, as this calibration counts it. */
export function truthLabelOf(spec) {
    const t = spec?.target ?? {};
    if (t.family === "anomalous") {
        return t.parameters?.anomalous ? "anomalous" : "anomalous-control";
    }
    return t.family ?? "unknown";
}

/** The Sitrec class a truth label counts as, or null when it maps to none. */
export function classOfTruth(label) {
    return TRUTH_TO_CLASS[label] ?? null;
}

// Minimum independent GROUPS a bin needs before it may report a distribution.
// Groups, not scenarios: eight seeds of one truth content are one observation
// of how the analysis behaves on that content.
export const MIN_GROUPS = 8;

/**
 * Group records by truth content so repeats of the same underlying scenario
 * cannot vote more than once. Deterministic content merges across seeds;
 * stochastic content (gusty wind, bird meander, aerostat sway) does not.
 */
export function assignGroups(records) {
    return records.map((rec) => {
        const {key} = truthContentKey(rec.spec ?? {}, rec.spec?.scenarioSeed ?? 0);
        return {...rec, groupId: key, truthLabel: truthLabelOf(rec.spec)};
    });
}

/**
 * Deterministic train/test split BY GROUP, stratified on truth label so a rare
 * label cannot land entirely on one side. Splitting by scenario would leak: two
 * seeds of the same truth content would sit on both sides and the measured
 * accuracy would be of memorisation, not generalisation.
 */
export function splitByGroup(records, {testFraction = 0.3, seed = 0xB07B3C} = {}) {
    const byLabel = new Map();
    for (const r of records) {
        if (!byLabel.has(r.truthLabel)) byLabel.set(r.truthLabel, new Map());
        const g = byLabel.get(r.truthLabel);
        if (!g.has(r.groupId)) g.set(r.groupId, []);
        g.get(r.groupId).push(r);
    }
    const train = [], test = [];
    for (const [, groups] of [...byLabel].sort((a, b) => a[0].localeCompare(b[0]))) {
        const gids = [...groups.keys()].sort((a, b) => hash32(`${a}|${seed}`) - hash32(`${b}|${seed}`));
        gids.forEach((gid, i) => {
            const frac = (i + 0.5) / gids.length;
            (frac < 1 - testFraction ? train : test).push(...groups.get(gid));
        });
    }
    return {train, test};
}

function hash32(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h;
}

/**
 * Equal-weight-per-group class distribution over a set of records.
 * Returns {dist: {class: fraction}, n, groups}.
 */
export function weightedDistribution(records) {
    const byGroup = new Map();
    for (const r of records) {
        if (!byGroup.has(r.groupId)) byGroup.set(r.groupId, []);
        byGroup.get(r.groupId).push(r);
    }
    const dist = Object.fromEntries(REPORT_CLASSES.map((c) => [c, 0]));
    for (const [, members] of byGroup) {
        // Within a group every member counts equally, and the group as a whole
        // counts once.
        const share = 1 / members.length;
        for (const m of members) {
            dist[classOfTruth(m.truthLabel) ?? "unknown"] += share / byGroup.size;
        }
    }
    return {dist, n: records.length, groups: byGroup.size};
}

/**
 * Percentile interval from resampling GROUPS with replacement — the clustered
 * analogue of a bootstrap CI. Deterministic: the RNG is seeded from the bin key
 * so a report re-run reproduces its own intervals exactly.
 */
export function clusterBootstrap(records, {draws = 400, seedKey = "", alpha = 0.1} = {}) {
    const groups = new Map();
    for (const r of records) {
        if (!groups.has(r.groupId)) groups.set(r.groupId, []);
        groups.get(r.groupId).push(r);
    }
    const gids = [...groups.keys()];
    if (gids.length < 2) {
        return Object.fromEntries(REPORT_CLASSES.map((c) => [c, [null, null]]));
    }
    // Each group's OWN class distribution, computed once. A replicate is then
    // the mean of G of these drawn with replacement.
    //
    // This must not go back through weightedDistribution on a concatenated
    // record list: that regroups by groupId, so a group drawn three times
    // collapses to one and the replicate is identical to the point estimate.
    // The intervals it produced were degenerate — near-zero width regardless of
    // how little data stood behind them, which is the worst possible failure
    // for a number whose whole job is to express uncertainty.
    const perGroup = gids.map((gid) => {
        const members = groups.get(gid);
        const d = Object.fromEntries(REPORT_CLASSES.map((c) => [c, 0]));
        for (const m of members) d[classOfTruth(m.truthLabel) ?? "unknown"] += 1 / members.length;
        return d;
    });
    const rng = mulberry(hash32(seedKey || "bin"));
    const samples = Object.fromEntries(REPORT_CLASSES.map((c) => [c, []]));
    const G = perGroup.length;
    for (let d = 0; d < draws; d++) {
        const acc = Object.fromEntries(REPORT_CLASSES.map((c) => [c, 0]));
        for (let i = 0; i < G; i++) {
            const g = perGroup[Math.floor(rng() * G)];
            for (const c of REPORT_CLASSES) acc[c] += g[c];
        }
        for (const c of REPORT_CLASSES) samples[c].push(acc[c] / G);
    }
    const out = {};
    for (const c of REPORT_CLASSES) {
        const s = samples[c].sort((a, b) => a - b);
        out[c] = [quantile(s, alpha / 2), quantile(s, 1 - alpha / 2)];
    }
    return out;
}

function quantile(sorted, q) {
    if (!sorted.length) return null;
    const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
    return sorted[i];
}

function mulberry(a) {
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Build the lookup: for every signature bin seen in training, the class
 * distribution and its interval. Bins too thin at the finest level back off to
 * a coarser signature (a strict superset — see signatureKey), and a bin still
 * thin at the coarsest level reports nothing rather than a number built from
 * three scenarios.
 */
export function buildCalibration(trainRecords, {signatureKey, maxLevel = 3, draws = 400} = {}) {
    const levels = [];
    for (let level = 0; level <= maxLevel; level++) {
        const bins = new Map();
        for (const r of trainRecords) {
            const key = signatureKey(r.signature, level);
            if (!bins.has(key)) bins.set(key, []);
            bins.get(key).push(r);
        }
        const table = new Map();
        for (const [key, members] of bins) {
            const {dist, n, groups} = weightedDistribution(members);
            table.set(key, {dist, n, groups,
                interval: groups >= MIN_GROUPS
                    ? clusterBootstrap(members, {draws, seedKey: key}) : null});
        }
        levels.push(table);
    }
    return {levels, maxLevel, uncalibrated: UNCALIBRATED_CLASSES};
}

/**
 * Look up a record's class distribution, backing off until a bin has enough
 * independent groups. Always reports which level answered and how thin it was,
 * so a percentage can never be quoted without its support.
 */
export function predictDistribution(calibration, signature, {signatureKey}) {
    for (let level = 0; level <= calibration.maxLevel; level++) {
        const key = signatureKey(signature, level);
        const hit = calibration.levels[level].get(key);
        if (hit && hit.groups >= MIN_GROUPS) {
            return {...hit, key, level, backedOff: level > 0, calibrated: true};
        }
    }
    return {
        dist: Object.fromEntries(REPORT_CLASSES.map((c) => [c, c === "unknown" ? 1 : 0])),
        n: 0, groups: 0, interval: null,
        key: signatureKey(signature, calibration.maxLevel),
        level: calibration.maxLevel, backedOff: true, calibrated: false,
    };
}

/** "Balloon 40%, Unknown 50%, Fixed-wing 10%" — largest first, zeros dropped. */
export function formatDistribution(dist, {classLabels = DEFAULT_LABELS} = {}) {
    return REPORT_CLASSES
        .filter((c) => (dist[c] ?? 0) > 0.005)
        .sort((a, b) => dist[b] - dist[a])
        .map((c) => `${classLabels[c] ?? c} ${(dist[c] * 100).toFixed(0)}%`)
        .join(", ");
}

export const DEFAULT_LABELS = {
    balloon: "Balloon", fixedWing: "Fixed-wing", multirotor: "Multirotor",
    stationary: "Stationary", knownObject: "Known object", unknown: "Unknown",
};

// --- Band-width calibration -------------------------------------------------

export const COVERAGE_TARGET = 0.9;

/**
 * Choose the acceptance multiplier K per class: the SMALLEST K whose truth
 * coverage reaches the target on the training split. Smallest, not largest —
 * a band wide enough to contain everything is not evidence of anything, so the
 * calibration buys coverage at the least width that achieves it.
 *
 * coverageByK: {classId: {K: coverageFraction}}.
 * Returns {classId: {K, coverage, reachedTarget}} — reachedTarget false is a
 * FINDING (the band construction is missing a degree of freedom for that
 * class), not something to paper over by widening further.
 */
export function calibrateK(coverageByK, {target = COVERAGE_TARGET} = {}) {
    const out = {};
    for (const [classId, byK] of Object.entries(coverageByK)) {
        const ks = Object.keys(byK).map(Number).sort((a, b) => a - b);
        let chosen = null;
        for (const k of ks) {
            if (byK[k] >= target) { chosen = k; break; }
        }
        if (chosen !== null) {
            out[classId] = {K: chosen, coverage: byK[chosen], reachedTarget: true};
        } else {
            const best = ks.reduce((a, b) => (byK[b] > byK[a] ? b : a), ks[0]);
            out[classId] = {K: best, coverage: byK[best], reachedTarget: false};
        }
    }
    return out;
}

/**
 * A calibration artifact is only usable by the exact configuration that
 * produced it. Fail-closed, like the capability detector: a mismatch means the
 * report says "not calibrated", never that it quietly reuses stale numbers.
 */
export function isValidCalibration(artifact, runningConfigKey) {
    return !!(artifact
        && artifact.configKey === runningConfigKey
        && Number.isFinite(artifact.trainGroups)
        && artifact.trainGroups >= MIN_GROUPS
        && artifact.levels);
}

export function configKey({K, minGroups = MIN_GROUPS, classes = REPORT_CLASSES, version = 1}) {
    return `v${version}|K=${K}|minG=${minGroups}|classes=${classes.join(",")}`;
}
