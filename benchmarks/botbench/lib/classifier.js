// classifier.js — M3: the Q4 regime/solver-selection protocol
// (PLAN.md "Q4 classifier protocol" + "Post-audit amendments" 10, corrected
// per the Codex M3 audit of 2026-07-22).
//
// Audit corrections implemented here:
//  - UNION supergroups: all noise variants AND all seed-duplicates of
//    deterministic content (gust-free wind, non-bird target — the truth is
//    then seed-independent) share one group, so identical truth can never
//    straddle the train/val/test split.
//  - `activeNoiseRmsDeg` removed from features (derived from injected error —
//    not observable); residual-coverage and non-finite features added.
//  - Evaluation is group-weighted THROUGHOUT (confusion, macro-F1 over the
//    UNION of true and predicted labels, regret quantiles, catastrophic and
//    direction rates). Predicting fixed-direction on track truth counts as
//    infinite regret and catastrophic — never excluded.
//  - The rcond stump is a BINARY regime detector (CV-unrecoverable), not a
//    multiclass action picker. Abstention is a distinct concept, never
//    encoded as fixed-direction.
//  - Models: preregistered class-BALANCED CART (sensitivity), an UNBALANCED
//    group-weighted CART, a COST-SENSITIVE tree minimizing expected clamped
//    normalized loss (the operational rule), a multinomial L2 logistic
//    sensitivity model, and the contract baselines.
//  - Oracle catastrophic floor reported alongside policy rates.
//
// Deterministic throughout (split seed 0xB07B3C, fixed streams). Data unit =
// one scenario; features observable only; MC2 excluded.

import {fnv1a32, makeStream} from "./rng";

export const ELIGIBLE_SOLVERS = ["cv", "ca", "ks-default", "ks-q1e-5", "ks-q1e-3",
    "alsq2", "fixed-point"];
export const ACTIONS = [...ELIGIBLE_SOLVERS, "fixed-direction"];
export const SIMPLICITY_ORDER = ["cv", "fixed-point", "ca", "alsq2",
    "ks-default", "ks-q1e-5", "ks-q1e-3"];
export const SPLIT_SEED = 0xB07B3C;
const SENTINEL_BLOCKS = new Set(["RATE-30HZ", "DURATION-120S", "SITE-PROXY"]);

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

function lossOf(rec) {
    if (!rec || rec.status !== "ok") return Infinity;
    if (rec.failureFlags?.nonFinite) return Infinity;   // contracted explicitly
    const t = rec.metrics?.truth;
    if (!t || t.kind !== "track" || !t.comparable) return Infinity;
    if (!(t.meanTruthRangeM > 0) || !Number.isFinite(t.meanSeparationM)) return Infinity;
    return t.meanSeparationM / t.meanTruthRangeM;
}

// Unified normalized action loss for cost-sensitive fitting and regret:
// track truth: finite solvers use relSep clamped to 1 (collapse-equivalent);
// fixed-direction on a track is a wrong-regime call: loss 1. Direction truth:
// fixed-direction is right (0), any finite solver is wrong-regime (1).
export function actionLoss(u, action) {
    if (u.truthKind === "direction") return action === "fixed-direction" ? 0 : 1;
    if (action === "fixed-direction") return 1;
    const l = u.lossBySolver[action];
    return Number.isFinite(l) ? Math.min(1, l) : 1;
}

// Canonical truth-content key (audit round 2): built from the COMPLETE
// generating spec — platform, target (minus the anomalous flag; tupleId
// stays), wind, range — never from pairId/blockId, which carry seeds and
// block prefixes. Duration/fps/site/observation are excluded per the group
// contract. The seed is appended ONLY for stochastic generators (gusty wind,
// bird, aerostat sway); deterministic content merges across seeds.
export function truthContentKey(spec, scenarioSeed) {
    const t = spec.target ?? {};
    const params = {...(t.parameters ?? {})};
    delete params.anomalous;
    const deterministic = ["zero", "fixed", "hab-steady"].includes(spec.wind?.kind)
        && !["bird", "tethered-aerostat"].includes(t.kind);
    const body = JSON.stringify({
        platform: spec.platform,
        targetKind: t.kind,
        params,
        wind: spec.wind,
        rangeM: spec.initialHorizontalRangeM ?? null,
    });
    return {
        deterministic,
        key: `tc-${fnv1a32(body + (deterministic ? "" : `|seed:${scenarioSeed}`)).toString(16)}`,
    };
}

export function buildUnits(records, specsById = null) {
    const byScenario = new Map();
    for (const r of records) {
        if (r.solver.id === "mc2-sentinel") continue;
        if (!byScenario.has(r.scenarioId)) byScenario.set(r.scenarioId, []);
        byScenario.get(r.scenarioId).push(r);
    }

    const units = [];
    for (const [scenarioId, recs] of byScenario) {
        const by = {};
        for (const r of recs) by[r.solver.id] = r;
        const any = recs[0];
        const truthKind = any.axes.truthKind;

        let oracle, oracleLoss = null;
        if (truthKind === "direction") {
            oracle = "fixed-direction";
            oracleLoss = 0;
        } else {
            const losses = ELIGIBLE_SOLVERS.map((id) => ({id, loss: lossOf(by[id])}));
            let best = Infinity;
            for (const l of losses) if (l.loss < best) best = l.loss;
            if (!Number.isFinite(best)) {
                oracle = null;
            } else {
                const tieBand = Math.max(1e-4, 0.01 * best);
                const tied = new Set(losses.filter((l) => l.loss <= best + tieBand).map((l) => l.id));
                oracle = SIMPLICITY_ORDER.find((id) => tied.has(id));
                oracleLoss = best;
            }
        }

        const d = any.scenarioDiagnostics;
        const resid = (id) => by[id]?.metrics?.angular?.observedMeanDeg ?? null;
        const gap = (a, b) => (resid(a) !== null && resid(b) !== null)
            ? resid(a) - resid(b) : null;
        const est = (id) => by[id]?.estimateSummary ?? null;
        const cvE = est("cv"), ksE = est("ks-default");
        const kin = (id, path) => {
            const k = by[id]?.metrics?.kinematics;
            if (!k) return null;
            const [a, b] = path.split(".");
            return k[a]?.[b] ?? null;
        };
        const features = {
            durationSeconds: any.axes.durationSeconds,
            fps: any.axes.fps,
            fovFullDeg: any.axes.fovFullDeg,
            activeFraction: any.samples ? any.samples.activeFrames / any.samples.totalFrames : null,
            sensorPathLengthM: d.sensorPathLengthM,
            sensorSpanM: d.sensorSpanM,
            log10Rcond: d.cvDesignLog10RcondObserved,
            effectiveRank: d.cvDesignEffectiveRank,
            losSweepDeg: d.losSweepDeg ?? null,
            losMeanRateDegPerS: d.losMeanRateDegPerS ?? null,
            losLag1Autocorr: d.losLag1Autocorr ?? null,
            residCv: resid("cv"),
            residCa: resid("ca"),
            residKs: resid("ks-default"),
            residAlsq2: resid("alsq2"),
            residFixedPoint: resid("fixed-point"),
            residFixedDirection: resid("fixed-direction"),
            gapCvCa: gap("cv", "ca"),
            gapCvKs: gap("cv", "ks-default"),
            gapFpCv: gap("fixed-point", "cv"),
            gapFdCv: gap("fixed-direction", "cv"),
            cvRangeMidLog10: cvE?.rangeMidM > 0 ? Math.log10(cvE.rangeMidM) : null,
            cvRangeInstability: (cvE && cvE.rangeMidM > 1 && cvE.rangeStartM !== null
                && cvE.rangeEndM !== null)
                ? Math.abs(cvE.rangeEndM - cvE.rangeStartM) / cvE.rangeMidM : null,
            cvBehindFrac: cvE?.behindSensorFraction ?? null,
            cvOnSensorFrac: cvE?.onSensorFraction ?? null,
            ksOnSensorFrac: ksE?.onSensorFraction ?? null,
            cvCollapsed: by["cv"]?.failureFlags?.collapsedOnSensor ? 1 : 0,
            ksCollapsed: by["ks-default"]?.failureFlags?.collapsedOnSensor ? 1 : 0,
            // residual coverage / non-finite (audit): observable output health.
            cvFiniteFrameFraction: cvE?.finiteFrameFraction ?? null,
            anyNonFinite: recs.some((r) => r.failureFlags?.nonFinite) ? 1 : 0,
            cvGMax: kin("cv", "gLoad.max"),
            cvTurnStd: kin("cv", "turnRate.std"),
        };

        // UNION supergroup from the canonical truth-content key (audit round 2:
        // pairId-based keys retained seeds/block prefixes and still leaked).
        // Requires the scenario specs (scenarios.jsonl); falls back to
        // scenarioGroupId only when specs are unavailable.
        const spec = specsById?.get(scenarioId) ?? null;
        const groupId = spec
            ? truthContentKey(spec, any.scenarioSeed).key
            : any.scenarioGroupId;

        units.push({
            scenarioId,
            groupId,
            blockId: any.blockId,
            sentinel: SENTINEL_BLOCKS.has(any.blockId),
            truthKind,
            platformFamily: any.axes.platformKind.startsWith("orbit") ? "orbit"
                : any.axes.platformKind === "straight" ? "straight" : "curve",
            targetMotionFamily: any.axes.targetFamily,
            oracle,
            oracleLoss,
            lossBySolver: Object.fromEntries(
                ELIGIBLE_SOLVERS.map((id) => [id, lossOf(by[id])])),
            features,
            residuals: Object.fromEntries(
                ACTIONS.map((id) => [id, resid(id)])),
        });
    }
    return units;
}


// ---------------------------------------------------------------------------
// Split (unchanged logic; operates on the repaired groups)
// ---------------------------------------------------------------------------

export function splitUnits(units) {
    const core = units.filter((u) => !u.sentinel && u.oracle !== null);
    const sentinels = units.filter((u) => u.sentinel);
    const unrecoverable = units.filter((u) => !u.sentinel && u.oracle === null);

    const groups = new Map();
    for (const u of core) {
        if (!groups.has(u.groupId)) groups.set(u.groupId, []);
        groups.get(u.groupId).push(u);
    }
    const strata = new Map();
    for (const [gid, members] of groups) {
        const s = `${members[0].truthKind}|${members[0].targetMotionFamily}|${members[0].platformFamily}`;
        if (!strata.has(s)) strata.set(s, []);
        strata.get(s).push(gid);
    }
    const assign = new Map();
    for (const [, gids] of [...strata].sort((a, b) => a[0].localeCompare(b[0]))) {
        gids.sort((a, b) => fnv1a32(`${a}|${SPLIT_SEED}`) - fnv1a32(`${b}|${SPLIT_SEED}`));
        gids.forEach((gid, i) => {
            const frac = (i + 0.5) / gids.length;
            assign.set(gid, frac < 0.70 ? "train" : frac < 0.85 ? "val" : "test");
        });
    }
    const pick = (name) => core.filter((u) => assign.get(u.groupId) === name);
    return {
        train: pick("train"), val: pick("val"), test: pick("test"),
        sentinels, unrecoverable, groupAssign: assign,
    };
}

export function unitWeights(units) {
    const count = new Map();
    for (const u of units) count.set(u.groupId, (count.get(u.groupId) ?? 0) + 1);
    return (u) => 1 / count.get(u.groupId);
}

// ---------------------------------------------------------------------------
// Feature plumbing
// ---------------------------------------------------------------------------

export function featureNames(units) {
    return Object.keys(units[0].features);
}

export function fitImputer(train, names) {
    const med = {};
    for (const f of names) {
        const v = train.map((u) => u.features[f]).filter(Number.isFinite).sort((a, b) => a - b);
        med[f] = v.length ? v[v.length >> 1] : 0;
    }
    return med;
}

export function vectorize(u, names, imputer) {
    const x = {};
    for (const f of names) {
        const v = u.features[f];
        x[f] = Number.isFinite(v) ? v : imputer[f];
        x[`${f}__missing`] = Number.isFinite(v) ? 0 : 1;
    }
    return x;
}

// ---------------------------------------------------------------------------
// Trees
// ---------------------------------------------------------------------------

function classWeights(units, weightFn) {
    const w = new Map();
    for (const u of units) w.set(u.oracle, (w.get(u.oracle) ?? 0) + weightFn(u));
    const total = [...w.values()].reduce((a, b) => a + b, 0);
    const k = w.size;
    const cw = new Map();
    for (const [c, v] of w) cw.set(c, total / (k * v));
    return cw;
}

// mode: "balanced" (contract sensitivity model) | "unbalanced" (operational,
// group weights only) | "cost" (leaves and splits minimize expected
// actionLoss — the recommended operational rule).
export function fitTree(train, names, imputer, weightFn,
    {maxDepth = 3, minLeafGroups = 20, mode = "balanced"} = {}) {
    const cw = mode === "balanced" ? classWeights(train, weightFn) : null;
    const allNames = [...names, ...names.map((f) => `${f}__missing`)];
    const rows = train.map((u) => ({
        x: vectorize(u, names, imputer), u,
        y: u.oracle,
        w: weightFn(u) * (cw ? cw.get(u.oracle) : 1),
        groupId: u.groupId,
    }));

    const leafOf = (rs) => {
        if (mode === "cost") {
            let bestA = null, bestL = Infinity;
            const perAction = {};
            for (const a of ACTIONS) {
                let s = 0, wt = 0;
                for (const r of rs) { s += r.w * actionLoss(r.u, a); wt += r.w; }
                const el = wt ? s / wt : 1;
                perAction[a] = el;
                if (el < bestL - 1e-12
                    || (Math.abs(el - bestL) <= 1e-12
                        && SIMPLICITY_ORDER.indexOf(a) !== -1
                        && SIMPLICITY_ORDER.indexOf(a) < SIMPLICITY_ORDER.indexOf(bestA))) {
                    bestL = el; bestA = a;
                }
            }
            const ranked = Object.entries(perAction).sort((a, b) => a[1] - b[1]);
            return {leaf: true, predict: bestA, top2: ranked.slice(0, 2).map((r) => r[0]),
                expectedLoss: bestL, n: rs.length,
                groups: new Set(rs.map((r) => r.groupId)).size};
        }
        const dist = new Map();
        for (const r of rs) dist.set(r.y, (dist.get(r.y) ?? 0) + r.w);
        const sorted = [...dist].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
        return {leaf: true, predict: sorted[0]?.[0] ?? null,
            top2: sorted.slice(0, 2).map((s) => s[0]),
            dist: Object.fromEntries(sorted), n: rs.length,
            groups: new Set(rs.map((r) => r.groupId)).size};
    };

    const impurity = (rs) => {
        if (mode === "cost") {
            // total (unnormalized) best achievable expected loss
            let best = Infinity;
            for (const a of ACTIONS) {
                let s = 0;
                for (const r of rs) s += r.w * actionLoss(r.u, a);
                if (s < best) best = s;
            }
            return best;
        }
        let total = 0;
        const dist = new Map();
        for (const r of rs) { total += r.w; dist.set(r.y, (dist.get(r.y) ?? 0) + r.w); }
        if (total <= 0) return 0;
        let g = 1;
        for (const [, v] of dist) g -= (v / total) ** 2;
        return g * total;
    };

    function build(rs, depth) {
        const uniqueGroups = new Set(rs.map((r) => r.groupId)).size;
        const classes = new Set(rs.map((r) => r.y));
        if (depth >= maxDepth || (mode !== "cost" && classes.size <= 1)
            || uniqueGroups < 2 * minLeafGroups) {
            return leafOf(rs);
        }
        let best = null;
        const parent = impurity(rs);
        for (const f of allNames) {
            const vals = [...new Set(rs.map((r) => r.x[f]))].sort((a, b) => a - b);
            if (vals.length < 2) continue;
            for (let i = 0; i + 1 < vals.length; i++) {
                const thr = (vals[i] + vals[i + 1]) / 2;
                const L = rs.filter((r) => r.x[f] <= thr);
                const R = rs.filter((r) => r.x[f] > thr);
                const gl = new Set(L.map((r) => r.groupId)).size;
                const gr = new Set(R.map((r) => r.groupId)).size;
                if (gl < minLeafGroups || gr < minLeafGroups) continue;
                const score = parent - impurity(L) - impurity(R);
                if (!best || score > best.score + 1e-12
                    || (Math.abs(score - best.score) <= 1e-12 && f < best.f)) {
                    best = {f, thr, score, L, R};
                }
            }
        }
        if (!best || best.score <= 1e-9) return leafOf(rs);
        return {
            leaf: false, f: best.f, thr: best.thr,
            left: build(best.L, depth + 1),
            right: build(best.R, depth + 1),
        };
    }
    return build(rows, 0);
}

export function predictTree(tree, x) {
    let node = tree;
    while (!node.leaf) node = x[node.f] <= node.thr ? node.left : node.right;
    return node;
}

// ---------------------------------------------------------------------------
// Binary rcond regime detector (audit: the stump's proper job). Target:
// "CV-unrecoverable" = cv loss > 0.10 (or non-finite). Learns the threshold
// on train by weighted accuracy; also reports the threshold-free AUC.
// ---------------------------------------------------------------------------

// Audit round 2: WEIGHTED ROC-AUC and PR-AUC; TWO operating points — Youden J
// (the paper-facing point; prevalence-robust) and accuracy-optimal (reported
// as the high-recall/prevalence-sensitive alternative — with ~0.87 test
// prevalence, raw accuracy barely beats "always unrecoverable").
export function fitRegimeDetector(train, weightFn) {
    const rows = train
        .filter((u) => u.truthKind === "track")
        .map((u) => ({
            score: u.features.log10Rcond ?? -99,
            y: !(u.lossBySolver.cv <= 0.10),
            w: weightFn(u),
        }))
        .sort((a, b) => a.score - b.score);
    if (!rows.length) return null;

    const pos = rows.filter((r) => r.y), neg = rows.filter((r) => !r.y);
    let wins = 0, total = 0;
    for (const p of pos) for (const n of neg) {
        const w = p.w * n.w;
        total += w;
        wins += p.score < n.score ? w : (p.score === n.score ? 0.5 * w : 0);
    }
    const auc = total ? wins / total : null;   // weighted; low rcond => positive

    // Weighted PR-AUC: sweep "positive iff score <= thr" from most to least
    // confident; trapezoid over recall.
    const posW = pos.reduce((a, r) => a + r.w, 0);
    let prAuc = null;
    if (posW > 0 && neg.length) {
        let tp = 0, fp = 0, prevRecall = 0, prevPrec = 1, area = 0;
        for (const r of rows) {   // ascending score = descending confidence
            if (r.y) tp += r.w; else fp += r.w;
            const recall = tp / posW;
            const prec = tp / (tp + fp);
            area += (recall - prevRecall) * (prec + prevPrec) / 2;
            prevRecall = recall; prevPrec = prec;
        }
        prAuc = area;
    }

    const operatingPoint = (objective) => {
        let bestThr = -Infinity, bestScore = -Infinity;
        const cand = [...new Set(rows.map((r) => r.score))];
        for (let i = 0; i < cand.length - 1; i++) {
            const thr = (cand[i] + cand[i + 1]) / 2;
            let tp = 0, fp = 0, fn = 0, tn = 0;
            for (const r of rows) {
                const pred = r.score <= thr;
                if (pred && r.y) tp += r.w;
                else if (pred) fp += r.w;
                else if (r.y) fn += r.w;
                else tn += r.w;
            }
            const score = objective(tp, fp, fn, tn);
            if (score > bestScore + 1e-12) { bestScore = score; bestThr = thr; }
        }
        return bestThr;
    };
    return {
        auc, prAuc,
        thresholdYouden: operatingPoint((tp, fp, fn, tn) =>
            (tp + fn ? tp / (tp + fn) : 0) - (fp + tn ? fp / (fp + tn) : 0)),
        thresholdAccuracy: operatingPoint((tp, fp, fn, tn) =>
            (tp + tn) / (tp + fp + fn + tn)),
    };
}

export function evaluateRegimeDetector(threshold, units, weightFn) {
    const rows = units.filter((u) => u.truthKind === "track");
    if (!rows.length || !Number.isFinite(threshold)) return null;
    let tp = 0, fp = 0, fn = 0, tn = 0;
    for (const u of rows) {
        const w = weightFn(u);
        const pred = (u.features.log10Rcond ?? -99) <= threshold;
        const truth = !(u.lossBySolver.cv <= 0.10);
        if (pred && truth) tp += w;
        else if (pred) fp += w;
        else if (truth) fn += w;
        else tn += w;
    }
    return {
        threshold,
        accuracy: (tp + tn) / (tp + fp + fn + tn),
        balancedAccuracy: 0.5 * ((tp + fn ? tp / (tp + fn) : 0)
            + (tn + fp ? tn / (tn + fp) : 0)),
        precision: tp + fp ? tp / (tp + fp) : null,
        recall: tp + fn ? tp / (tp + fn) : null,
        fpr: fp + tn ? fp / (fp + tn) : null,
        prevalence: (tp + fn) / (tp + fp + fn + tn),
    };
}

// ---------------------------------------------------------------------------
// Multinomial L2 logistic regression (contract sensitivity model).
// Standardization learned on train; deterministic full-batch gradient descent.
// ---------------------------------------------------------------------------

export function fitLogistic(train, names, imputer, weightFn, {l2 = 1, iterations = 400} = {}) {
    const allNames = [...names, ...names.map((f) => `${f}__missing`)];
    const classes = [...new Set(train.map((u) => u.oracle))].sort();
    const X = train.map((u) => vectorize(u, names, imputer));
    const mean = {}, std = {};
    for (const f of allNames) {
        const vs = X.map((x) => x[f]);
        const m = vs.reduce((a, b) => a + b, 0) / vs.length;
        const s = Math.sqrt(vs.reduce((a, b) => a + (b - m) ** 2, 0) / vs.length) || 1;
        mean[f] = m; std[f] = s;
    }
    const rows = train.map((u, i) => ({
        z: allNames.map((f) => (X[i][f] - mean[f]) / std[f]),
        yi: classes.indexOf(u.oracle),
        w: weightFn(u),
    }));
    const K = classes.length, D = allNames.length;
    const W = Array.from({length: K}, () => new Float64Array(D + 1));   // +bias
    const lr = 0.5;
    const wSum = rows.reduce((a, r) => a + r.w, 0);
    for (let it = 0; it < iterations; it++) {
        const grad = Array.from({length: K}, () => new Float64Array(D + 1));
        for (const r of rows) {
            const logits = new Float64Array(K);
            for (let k = 0; k < K; k++) {
                let s = W[k][D];
                for (let j = 0; j < D; j++) s += W[k][j] * r.z[j];
                logits[k] = s;
            }
            const mx = Math.max(...logits);
            let Z = 0;
            const p = new Float64Array(K);
            for (let k = 0; k < K; k++) { p[k] = Math.exp(logits[k] - mx); Z += p[k]; }
            for (let k = 0; k < K; k++) {
                const g = (p[k] / Z - (k === r.yi ? 1 : 0)) * r.w / wSum;
                for (let j = 0; j < D; j++) grad[k][j] += g * r.z[j];
                grad[k][D] += g;
            }
        }
        for (let k = 0; k < K; k++) {
            for (let j = 0; j < D; j++) {
                W[k][j] -= lr * (grad[k][j] + (l2 / rows.length) * W[k][j]);
            }
            W[k][D] -= lr * grad[k][D];
        }
    }
    return {classes, allNames, mean, std, W,
        predict(x) {
            const z = this.allNames.map((f) => (x[f] - this.mean[f]) / this.std[f]);
            let bestK = 0, bestS = -Infinity, secondK = 0, secondS = -Infinity;
            for (let k = 0; k < this.classes.length; k++) {
                let s = this.W[k][z.length];
                for (let j = 0; j < z.length; j++) s += this.W[k][j] * z[j];
                if (s > bestS) { secondS = bestS; secondK = bestK; bestS = s; bestK = k; }
                else if (s > secondS) { secondS = s; secondK = k; }
            }
            return {predict: this.classes[bestK],
                top2: [this.classes[bestK], this.classes[secondK]]};
        }};
}

// ---------------------------------------------------------------------------
// Evaluation — fully group-weighted (audit)
// ---------------------------------------------------------------------------

function weightedQuantile(pairs, q) {
    // pairs: [value, weight], finite values only, presorted by value
    const total = pairs.reduce((a, p) => a + p[1], 0);
    if (!total) return null;
    let acc = 0;
    for (const [v, w] of pairs) {
        acc += w;
        if (acc >= q * total) return v;
    }
    return pairs[pairs.length - 1][0];
}

export function evaluate(units, names, imputer, predictFn, weightFn) {
    if (!units.length) return null;
    const conf = {};   // conf[true][pred] += w
    let acc = 0, top2 = 0, wTotal = 0;
    const regretPairs = [];
    let regretInfW = 0;
    let cat = 0, catW = 0, floorCat = 0;
    let dirTP = 0, dirFP = 0, dirFN = 0, dirTN = 0;

    for (const u of units) {
        const w = weightFn(u);
        const node = predictFn(vectorize(u, names, imputer), u);
        const chosen = node.predict;
        wTotal += w;
        if (chosen === u.oracle) acc += w;
        if ((node.top2 ?? [chosen]).includes(u.oracle)) top2 += w;
        conf[u.oracle] = conf[u.oracle] ?? {};
        conf[u.oracle][chosen] = (conf[u.oracle][chosen] ?? 0) + w;

        if (u.truthKind === "direction" && chosen === "fixed-direction") dirTP += w;
        else if (u.truthKind === "direction") dirFN += w;
        else if (chosen === "fixed-direction") dirFP += w;
        else dirTN += w;

        if (u.truthKind === "track" && u.oracleLoss !== null) {
            catW += w;
            if (u.oracleLoss > 0.10) floorCat += w;
            if (chosen === "fixed-direction") {
                // wrong-regime call on a track: infinite regret, catastrophic
                regretInfW += w;
                cat += w;
            } else {
                const loss = u.lossBySolver[chosen];
                if (Number.isFinite(loss)) {
                    regretPairs.push([loss - u.oracleLoss, w]);
                    if (loss > 0.10) cat += w;
                } else {
                    regretInfW += w;
                    cat += w;
                }
            }
        }
    }

    // Macro-F1 over the UNION of true and predicted labels, from the weighted
    // confusion matrix (audit).
    const labels = new Set();
    for (const t of Object.keys(conf)) {
        labels.add(t);
        for (const p of Object.keys(conf[t])) labels.add(p);
    }
    const f1s = [...labels].sort().map((c) => {
        let tp = 0, fp = 0, fn = 0;
        for (const t of Object.keys(conf)) {
            for (const [p, v] of Object.entries(conf[t])) {
                if (t === c && p === c) tp += v;
                else if (p === c) fp += v;
                else if (t === c) fn += v;
            }
        }
        const prec = tp + fp ? tp / (tp + fp) : 0;
        const rec = tp + fn ? tp / (tp + fn) : 0;
        return prec + rec ? 2 * prec * rec / (prec + rec) : 0;
    });

    regretPairs.sort((a, b) => a[0] - b[0]);
    return {
        n: units.length,
        accuracy: acc / wTotal,
        top2Accuracy: top2 / wTotal,
        macroF1: f1s.reduce((a, b) => a + b, 0) / (f1s.length || 1),
        confusion: conf,
        regretMedian: weightedQuantile(regretPairs, 0.5),
        regretP90: weightedQuantile(regretPairs, 0.9),
        regretInfiniteWeight: catW ? regretInfW / catW : null,
        catastrophicRate: catW ? cat / catW : null,
        oracleCatastrophicFloor: catW ? floorCat / catW : null,
        excessCatastrophic: catW ? (cat - floorCat) / catW : null,
        direction: {
            precision: dirTP + dirFP ? dirTP / (dirTP + dirFP) : null,
            recall: dirTP + dirFN ? dirTP / (dirTP + dirFN) : null,
            fpr: dirFP + dirTN ? dirFP / (dirFP + dirTN) : null,
        },
    };
}

export function baselinePredictors(train, weightFn) {
    const dist = new Map();
    for (const u of train) dist.set(u.oracle, (dist.get(u.oracle) ?? 0) + weightFn(u));
    const mostCommon = [...dist].sort((a, b) => b[1] - a[1])[0][0];
    return {
        "always-cv": () => ({predict: "cv", top2: ["cv"]}),
        "lowest-residual": (u) => {
            let best = null, bestV = Infinity;
            for (const [id, v] of Object.entries(u.residuals)) {
                if (Number.isFinite(v) && v < bestV) { bestV = v; best = id; }
            }
            return {predict: best ?? "cv", top2: [best ?? "cv"]};
        },
        "most-common": () => ({predict: mostCommon, top2: [mostCommon]}),
    };
}

export function bootstrapCI(units, names, imputer, predictFn, weightFn,
    metric = "accuracy", iterations = 500) {
    const groups = new Map();
    for (const u of units) {
        if (!groups.has(u.groupId)) groups.set(u.groupId, []);
        groups.get(u.groupId).push(u);
    }
    const gids = [...groups.keys()].sort();
    if (gids.length < 2) return {lo: null, hi: null};
    const stream = makeStream(0xB07B3C ^ 0x5eed);
    const vals = [];
    for (let it = 0; it < iterations; it++) {
        const sample = [];
        for (let i = 0; i < gids.length; i++) {
            const gid = gids[Math.floor(stream.uniform() * gids.length)];
            sample.push(...groups.get(gid));
        }
        // Audit round 2: weights come from the ORIGINAL set. Recomputing
        // unitWeights(sample) halves twice-drawn clusters and cancels the
        // resampling multiplicity — the CI collapses to the point estimate.
        const ev = evaluate(sample, names, imputer, predictFn, weightFn);
        if (ev && Number.isFinite(ev[metric])) vals.push(ev[metric]);
    }
    vals.sort((a, b) => a - b);
    return {
        lo: vals[Math.floor(0.025 * vals.length)] ?? null,
        hi: vals[Math.floor(0.975 * vals.length)] ?? null,
    };
}

// Abstain sensitivity: group-WEIGHTED coverage (audit); abstention is its own
// outcome, applied via the rcond floor before the selection rule runs.
export function abstainCurve(units, names, imputer, predictFn, weightFn) {
    const thresholds = [-Infinity, -4, -3.5, -3, -2.5, -2, -1.5, -1];
    const totalW = units.reduce((a, u) => a + weightFn(u), 0);
    return thresholds.map((thr) => {
        const answered = units.filter((u) =>
            (u.features.log10Rcond ?? -99) > thr);
        const answeredW = answered.reduce((a, u) => a + weightFn(u), 0);
        const ev = answered.length
            ? evaluate(answered, names, imputer, predictFn, weightFn) : null;
        return {
            rcondThreshold: thr,
            coverage: totalW ? answeredW / totalW : 0,
            accuracy: ev?.accuracy ?? null,
            catastrophicRate: ev?.catastrophicRate ?? null,
            oracleCatastrophicFloor: ev?.oracleCatastrophicFloor ?? null,
            excessCatastrophic: ev?.excessCatastrophic ?? null,
        };
    });
}

// Regime stratification for reporting (truth-side, allowed in ANALYSIS only):
// recoverable (oracleLoss <= 0.10), intermediate, structurally-collapsed
// (oracleLoss > 0.5). Direction truth reported as its own stratum.
export function regimeOf(u) {
    if (u.truthKind === "direction") return "direction";
    if (u.oracleLoss === null) return "structurally-collapsed";
    if (u.oracleLoss <= 0.10) return "recoverable";
    if (u.oracleLoss > 0.5) return "structurally-collapsed";
    return "intermediate";
}
