// runner.js — generate scenarios from the block matrix, run every solver
// configuration against each, and emit compact BotBenchRunRecords plus
// aggregate tables (PLAN.md "Module API" / "File layout & execution").
//
// Two generation passes: wobble members first (recording realized RMS under
// entry.rmsKey), then matched-white members whose spec receives that value
// (entry.matchedRmsFrom). MATCHED-NOISE wobble members must produce ZERO FOV
// exclusions (asserted, never regenerated — contract).

import {generateScenario, GENERATOR_VERSION} from "./generateScenario";
import {SOLVERS, mc2Solver} from "./solvers";
import {computeMetrics} from "./metrics";

const now = () => (globalThis.performance?.now?.() ?? Date.now());

// JSON-safe deep copy: NaN/Infinity -> null (JSON.stringify would silently
// null them ANYWAY inside numbers, but be explicit), typed arrays dropped.
export function sanitize(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (value === null || typeof value !== "object") return value;
    if (ArrayBuffer.isView(value)) return undefined;
    if (value instanceof Set) return undefined;
    if (Array.isArray(value)) return value.map((v) => sanitize(v) ?? null);
    const out = {};
    for (const [k, v] of Object.entries(value)) {
        const s = sanitize(v);
        if (s !== undefined) out[k] = s;
    }
    return out;
}

export function axesOf(scenario) {
    const spec = scenario.spec;
    const p = spec.platform;
    const platformKind = p.kind === "orbit-direction"
        ? `orbit-direction-${p.rangeErrorFactor}` : p.kind;
    return {
        platformKind,
        targetFamily: spec.target.family,
        targetKind: spec.target.kind,
        truthKind: scenario.target.kind,
        windKind: spec.wind.kind,
        noiseKind: spec.observation.kind === "white" && spec.observation.matchedRealizedRmsDeg != null
            ? "matched-white" : spec.observation.kind,
        durationSeconds: spec.durationSeconds,
        fps: spec.fps,
        initialHorizontalRangeM: spec.initialHorizontalRangeM ?? null,
        siteId: spec.siteId,
        fovFullDeg: spec.observation.fovFullDeg,
        eventFamily: scenario.events[0]?.family ?? null,
        anomalous: scenario.events.length ? scenario.events[0].anomalous : null,
    };
}

export function runSolver(scenario, solver) {
    const recordBase = {
        schemaVersion: 1,
        generatorVersion: scenario.generatorVersion,
        runId: `${scenario.scenarioId}--${solver.id}`,
        scenarioId: scenario.scenarioId,
        scenarioGroupId: scenario.scenarioGroupId,
        blockId: scenario.blockId,
        pairId: scenario.pairId,
        scenarioSeed: scenario.scenarioSeed,
        axes: axesOf(scenario),
        solver: {id: solver.id, family: solver.family, options: solver.options,
            outputKind: solver.outputKind},
        scenarioDiagnostics: {
            sensorPathLengthM: scenario.diagnostics.sensorPathLengthM,
            sensorSpanM: scenario.diagnostics.sensorSpanM,
            cvDesignRcondObserved: scenario.diagnostics.cvDesignRcondObserved,
            cvDesignLog10RcondObserved: scenario.diagnostics.cvDesignLog10RcondObserved,
            cvDesignEffectiveRank: scenario.diagnostics.cvDesignEffectiveRank,
            cvDesignRcondCleanOracle: scenario.diagnostics.cvDesignRcondCleanOracle,
            losSweepDeg: scenario.diagnostics.losSweepDeg,
            losMeanRateDegPerS: scenario.diagnostics.losMeanRateDegPerS,
            losLag1Autocorr: scenario.diagnostics.losLag1Autocorr,
            observedNoiseRmsDeg: scenario.observation.realizedRmsDegAllFrames,
            activeNoiseRmsDeg: scenario.observation.realizedRmsDegActiveFrames,
        },
    };

    const activeFrames = scenario.n - scenario.observation.outOfFrameCount;
    if (activeFrames < 2) {
        return {...recordBase, status: "insufficient-active-frames", error: null,
            timing: {wallMs: 0},
            samples: {totalFrames: scenario.n, activeFrames,
                excludedFrames: scenario.observation.outOfFrameCount,
                outOfFrameFraction: scenario.observation.outOfFrameFraction,
                analysisMask: "native-fov"},
            estimateSummary: null, metrics: null,
            failureFlags: {solverFailed: true, nonFinite: false, behindSensor: false,
                activeCoverageBelow50Pct: true, relativeRangeErrorAbove50Pct: null}};
    }

    const t0 = now();
    let estimate = null, error = null, status = "ok";
    try {
        estimate = solver.run(scenario);
        if (!estimate) status = "null-result";
    } catch (e) {
        status = "exception";
        error = {name: e?.name ?? "Error", message: String(e?.message ?? e)};
    }
    const wallMs = now() - t0;

    if (status !== "ok") {
        return {...recordBase, status, error, timing: {wallMs},
            samples: {totalFrames: scenario.n, activeFrames,
                excludedFrames: scenario.observation.outOfFrameCount,
                outOfFrameFraction: scenario.observation.outOfFrameFraction,
                analysisMask: "native-fov"},
            estimateSummary: null, metrics: null,
            failureFlags: {solverFailed: true, nonFinite: false, behindSensor: false,
                activeCoverageBelow50Pct: activeFrames / scenario.n < 0.5,
                relativeRangeErrorAbove50Pct: null}};
    }

    const m = computeMetrics(scenario, estimate);
    if (m.failureFlags.nonFinite && m.estimateSummary?.kind === "track"
        && m.estimateSummary.finiteFrameFraction < 0.5) {
        status = "non-finite-result";
    }
    return {...recordBase, status, error: null, timing: {wallMs}, ...m};
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

// entries: from buildAllScenarioEntries(); options.blockFilter: Set|null.
export function generateAllScenarios(entries, {blockFilter = null, generatorVersion = GENERATOR_VERSION, log = () => {}} = {}) {
    const rmsByKey = new Map();
    const scenarios = [];
    const deferred = [];

    for (const e of entries) {
        if (blockFilter && !blockFilter.has(e.blockId)) continue;
        if (e.matchedRmsFrom) { deferred.push(e); continue; }
        const scenario = generateScenario(e.spec, {scenarioSeed: e.scenarioSeed, generatorVersion});
        if (e.rmsKey) rmsByKey.set(e.rmsKey, scenario.observation.realizedRmsDegAllFrames);
        if (e.assertNoFovExclusions && scenario.observation.outOfFrameCount !== 0) {
            throw new Error(`botbench: MATCHED-NOISE wobble member ${scenario.scenarioId} `
                + `has ${scenario.observation.outOfFrameCount} FOV exclusions — the isolation `
                + `block requires zero (assertion, not grounds for seed regeneration)`);
        }
        scenarios.push(scenario);
    }
    for (const e of deferred) {
        const rms = rmsByKey.get(e.matchedRmsFrom);
        if (!(rms > 0)) {
            throw new Error(`botbench: no realized RMS recorded under key "${e.matchedRmsFrom}"`);
        }
        const spec = {...e.spec,
            observation: {...e.spec.observation, matchedRealizedRmsDeg: rms}};
        scenarios.push(generateScenario(spec, {scenarioSeed: e.scenarioSeed, generatorVersion}));
    }
    log(`generated ${scenarios.length} scenarios`);
    return scenarios;
}

// MC2 sentinel selection (8 named scenarios — contract).
export function selectMc2Sentinels(scenarios) {
    const firstWhere = (pred) => scenarios.find(pred) ?? null;
    const picks = [
        firstWhere((s) => s.blockId === "TARGET-WIND" && s.spec.target.kind === "aircraft-cruise"
            && s.spec.platform.kind === "orbit-point" && s.scenarioSeed === 201),
        firstWhere((s) => s.blockId === "TARGET-WIND" && s.spec.target.kind === "aircraft-cruise"
            && s.spec.platform.kind === "straight" && s.scenarioSeed === 201),
        firstWhere((s) => s.blockId === "GEO-DURATION" && s.spec.platform.kind === "orbit-point"
            && s.spec.durationSeconds === 15 && s.spec.initialHorizontalRangeM === 5000
            && s.scenarioSeed === 101),
        firstWhere((s) => s.blockId === "GEO-DURATION" && s.spec.platform.kind === "straight"
            && s.spec.durationSeconds === 15 && s.spec.initialHorizontalRangeM === 5000
            && s.scenarioSeed === 101),
        firstWhere((s) => s.blockId === "MATCHED-NOISE" && s.spec.observation.kind === "white"
            && s.spec.platform.kind === "orbit-point" && s.spec.durationSeconds === 15
            && s.spec.target.kind === "party-neutral" && s.scenarioSeed === 301),
        firstWhere((s) => s.blockId === "MATCHED-NOISE" && s.spec.observation.kind === "wobble"
            && s.spec.platform.kind === "orbit-point" && s.spec.durationSeconds === 15
            && s.spec.target.kind === "party-neutral" && s.scenarioSeed === 301),
        firstWhere((s) => s.blockId === "HAB-LONG-RANGE" && s.spec.platform.kind === "orbit-point"
            && s.spec.initialHorizontalRangeM === 50000
            && s.spec.target.parameters.mslKm === 18 && s.scenarioSeed === 211),
        firstWhere((s) => s.blockId === "ANOMALY-CONTROL" && s.spec.observation.kind === "wobble"
            && s.spec.platform.kind === "orbit-point"
            && s.spec.target.parameters.tupleId === "pulse-20g"
            && s.spec.target.parameters.anomalous === true && s.scenarioSeed === 401),
    ].filter(Boolean);
    return picks;
}

export function runSweep(scenarios, {log = () => {}, mc2 = true} = {}) {
    const records = [];
    let done = 0;
    for (const scenario of scenarios) {
        for (const solver of SOLVERS) {
            records.push(runSolver(scenario, solver));
        }
        done++;
        if (done % 50 === 0) log(`${done}/${scenarios.length} scenarios solved`);
    }
    if (mc2) {
        for (const scenario of selectMc2Sentinels(scenarios)) {
            records.push(runSolver(scenario,
                mc2Solver(scenario.observation.realizedRmsDegAllFrames)));
        }
    }
    return records;
}

// ---------------------------------------------------------------------------
// Aggregation (M2: descriptive tables; the classifier is M3)
// ---------------------------------------------------------------------------

function median(vals) {
    const v = vals.filter(Number.isFinite).sort((a, b) => a - b);
    if (!v.length) return null;
    const m = v.length >> 1;
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
function quartiles(vals) {
    const v = vals.filter(Number.isFinite).sort((a, b) => a - b);
    if (!v.length) return {q1: null, med: null, q3: null, n: 0};
    const at = (p) => {
        const idx = (v.length - 1) * p;
        const lo = Math.floor(idx), hi = Math.ceil(idx);
        return v[lo] + (v[hi] - v[lo]) * (idx - lo);
    };
    return {q1: at(0.25), med: at(0.5), q3: at(0.75), n: v.length};
}

// Mann-Whitney AUC: P(score_anomalous > score_control) + 0.5 ties.
export function rocAuc(anomScores, ctrlScores) {
    const a = anomScores.filter(Number.isFinite);
    const c = ctrlScores.filter(Number.isFinite);
    if (!a.length || !c.length) return null;
    let wins = 0;
    for (const x of a) for (const y of c) wins += x > y ? 1 : (x === y ? 0.5 : 0);
    return wins / (a.length * c.length);
}

export function aggregate(records) {
    const ok = records.filter((r) => r.status === "ok" && r.solver.id !== "mc2-sentinel");

    const groupBy = (rows, keyFn) => {
        const m = new Map();
        for (const r of rows) {
            const k = keyFn(r);
            if (!m.has(k)) m.set(k, []);
            m.get(k).push(r);
        }
        return m;
    };

    // A run is a FAILURE for Q1/Q2 purposes when it never produced a usable
    // range: non-ok status, on-sensor collapse, or median relative range
    // error above 50% (the predeclared statistic; never applies to direction
    // truth). Computed over ALL group records, not just the comparable ones.
    const isFailure = (r) => r.status !== "ok"
        || r.failureFlags?.collapsedOnSensor === true
        || r.failureFlags?.relativeRangeErrorAbove50Pct === true;

    // Q1/Q2: per (platform, RANGE, duration, solver) — the audit showed the
    // apparent 15 s "bimodality" was mostly range strata, so range is a
    // first-class grouping key.
    const geoAll = records.filter((r) => r.blockId === "GEO-DURATION"
        && r.solver.id !== "mc2-sentinel");
    const q12 = [];
    for (const [k, rows] of groupBy(geoAll, (r) =>
        `${r.axes.platformKind}|${r.axes.initialHorizontalRangeM}|${r.axes.durationSeconds}|${r.solver.id}`)) {
        const [platformKind, rangeM, durationSeconds, solverId] = k.split("|");
        const good = rows.filter((r) => r.status === "ok"
            && r.metrics.truth?.kind === "track" && r.metrics.truth.comparable);
        q12.push({
            platformKind, rangeM: +rangeM, durationSeconds: +durationSeconds, solverId,
            relSep: quartiles(good.map((r) =>
                r.metrics.truth.meanSeparationM / r.metrics.truth.meanTruthRangeM)),
            cleanResidualDeg: median(good.map((r) => r.metrics.angular.cleanMeanDeg)),
            observedResidualDeg: median(good.map((r) => r.metrics.angular.observedMeanDeg)),
            medianRelRangeErr: median(good.map((r) => r.metrics.truth.medianRelativeRangeError)),
            failRate: rows.filter(isFailure).length / rows.length,
            n: rows.length,
        });
    }

    // Q3: PAIRED wobble-vs-matched-white contrasts per pairId (audit R2: a
    // ratio of independently pooled medians is not a paired design). Collapsed
    // members stay in as explicit outcomes via pairsFailed.
    const noiseBlocks = ok.filter((r) =>
        (r.blockId === "MATCHED-NOISE" || r.blockId === "RECOVERABLE-NOISE")
        && r.metrics.truth?.kind === "track");
    // Clean-recoverability gate (audit): a solver's noise contrast only means
    // "noise did this" when the SAME solver on the SAME truth recovers under
    // clean observation (paired clean relSep <= 0.10). Clean members share the
    // scenarioGroupId (group key strips the noise variant). MATCHED-NOISE has
    // no clean members, so its rows carry gated:false — an observability-loss
    // statement, never an accuracy comparison.
    const cleanRelSep = new Map();
    for (const r of noiseBlocks) {
        if (r.axes.noiseKind !== "clean" || !r.metrics.truth.comparable) continue;
        if (!(r.metrics.truth.meanTruthRangeM > 0)) continue;
        cleanRelSep.set(`${r.scenarioGroupId}|${r.solver.id}`,
            r.metrics.truth.meanSeparationM / r.metrics.truth.meanTruthRangeM);
    }
    const q3 = [];
    {
        const byCell = groupBy(noiseBlocks, (r) =>
            `${r.blockId}|${r.axes.platformKind}|${r.axes.targetFamily}|${r.axes.durationSeconds}|${r.solver.id}`);
        for (const [k, rows] of byCell) {
            const [blockId, platformKind, targetFamily, durationSeconds, solverId] = k.split("|");
            const byPair = groupBy(rows.filter((r) => r.axes.noiseKind !== "clean"),
                (r) => r.pairId ?? r.scenarioGroupId);
            const deltas = [], ratios = [];
            let pairs = 0, pairsFailed = 0, pairsCleanUnrecoverable = 0;
            const wobSeps = [], whtSeps = [];
            const gateApplicable = blockId === "RECOVERABLE-NOISE";
            for (const [, members] of byPair) {
                const wob = members.find((r) => r.axes.noiseKind === "wobble");
                const wht = members.find((r) => r.axes.noiseKind === "matched-white");
                if (!wob || !wht) continue;
                pairs++;
                if (gateApplicable) {
                    const cg = cleanRelSep.get(`${wob.scenarioGroupId}|${solverId}`);
                    if (!(cg <= 0.10)) { pairsCleanUnrecoverable++; continue; }
                }
                if (isFailure(wob) || isFailure(wht)
                    || !wob.metrics.truth.comparable || !wht.metrics.truth.comparable) {
                    pairsFailed++;
                    continue;
                }
                const dw = wob.metrics.truth.meanSeparationM;
                const dg = wht.metrics.truth.meanSeparationM;
                deltas.push(dw - dg);
                wobSeps.push(dw);
                whtSeps.push(dg);
                if (dg > 1) ratios.push(dw / dg);   // guarded ratio
            }
            if (!pairs) continue;
            q3.push({
                blockId, platformKind, targetFamily,
                durationSeconds: +durationSeconds, solverId,
                gated: gateApplicable,
                pairs, pairsFailed, pairsCleanUnrecoverable,
                pairedDeltaM: quartiles(deltas),
                guardedRatio: quartiles(ratios),
                wobbleSepM: median(wobSeps), whiteSepM: median(whtSeps),
            });
        }
    }

    // Q5: event-blind anomaly-vs-control AUC per solver (all noise kinds pooled
    // and per noise kind), using globalPeakRobustZ.
    const ac = records.filter((r) => r.blockId === "ANOMALY-CONTROL"
        && r.status === "ok" && r.metrics.anomaly?.global);
    const q5 = [];
    for (const [solverId, rows] of groupBy(ac, (r) => r.solver.id)) {
        const anom = rows.filter((r) => r.axes.anomalous === true)
            .map((r) => r.metrics.anomaly.global.globalPeakRobustZ);
        const ctrl = rows.filter((r) => r.axes.anomalous === false)
            .map((r) => r.metrics.anomaly.global.globalPeakRobustZ);
        const perNoise = {};
        for (const noise of ["clean", "matched-white", "wobble"]) {
            const nr = rows.filter((r) => r.axes.noiseKind === noise);
            perNoise[noise] = rocAuc(
                nr.filter((r) => r.axes.anomalous === true)
                    .map((r) => r.metrics.anomaly.global.globalPeakRobustZ),
                nr.filter((r) => r.axes.anomalous === false)
                    .map((r) => r.metrics.anomaly.global.globalPeakRobustZ));
        }
        // PAIRED anomaly-minus-control event-local excess-area differences
        // (contract): same platform/onset/direction/seed/pointing realization.
        const byPair = groupBy(rows, (r) => r.pairId);
        const pairedExcess = [];
        for (const [, members] of byPair) {
            const a = members.find((r) => r.axes.anomalous === true);
            const c = members.find((r) => r.axes.anomalous === false);
            const ex = (r) => r?.metrics?.anomaly?.events?.[0]
                ?.observedResidualDeg?.excessAreaDegSeconds;
            if (a && c && Number.isFinite(ex(a)) && Number.isFinite(ex(c))) {
                pairedExcess.push(ex(a) - ex(c));
            }
        }
        q5.push({solverId, aucAll: rocAuc(anom, ctrl), perNoise,
            nAnom: anom.length, nCtrl: ctrl.length,
            pairedExcessDelta: quartiles(pairedExcess),
            collapsedRate: rows.filter((r) => r.failureFlags?.collapsedOnSensor).length
                / rows.length});
    }

    // Failure/status table per (block, solver).
    const statusTable = [];
    for (const [k, rows] of groupBy(records.filter((r) => r.solver.id !== "mc2-sentinel"),
        (r) => `${r.blockId}|${r.solver.id}`)) {
        const [blockId, solverId] = k.split("|");
        const counts = {};
        for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
        const divergent = rows.filter((r) => r.status === "ok"
            && r.metrics.truth?.comparable
            && r.metrics.angular.observedMeanDeg !== null).length;
        statusTable.push({blockId, solverId, total: rows.length, counts, comparable: divergent});
    }

    // TARGET-WIND: per (target kind, wind, solver) — relSep + failure rate.
    const twAll = records.filter((r) => r.blockId === "TARGET-WIND"
        && r.solver.id !== "mc2-sentinel" && r.axes.truthKind === "track");
    const targetWind = [];
    for (const [k, rows] of groupBy(twAll, (r) =>
        `${r.axes.targetKind ?? r.axes.targetFamily}|${r.axes.windKind}|${r.solver.id}`)) {
        const [targetKind, windKind, solverId] = k.split("|");
        const good = rows.filter((r) => r.status === "ok"
            && r.metrics.truth?.comparable);
        targetWind.push({
            targetKind, windKind, solverId,
            relSep: quartiles(good.map((r) =>
                r.metrics.truth.meanSeparationM / r.metrics.truth.meanTruthRangeM)),
            failRate: rows.filter(isFailure).length / rows.length,
            n: rows.length,
        });
    }

    // HAB-LONG-RANGE: per (platform, range, solver).
    const habAll = records.filter((r) => r.blockId === "HAB-LONG-RANGE"
        && r.solver.id !== "mc2-sentinel");
    const hab = [];
    for (const [k, rows] of groupBy(habAll, (r) =>
        `${r.axes.platformKind}|${r.axes.initialHorizontalRangeM}|${r.solver.id}`)) {
        const [platformKind, rangeM, solverId] = k.split("|");
        const good = rows.filter((r) => r.status === "ok"
            && r.metrics.truth?.kind === "track" && r.metrics.truth.comparable);
        hab.push({
            platformKind, rangeM: +rangeM, solverId,
            relSep: quartiles(good.map((r) =>
                r.metrics.truth.meanSeparationM / r.metrics.truth.meanTruthRangeM)),
            failRate: rows.filter(isFailure).length / rows.length,
            n: rows.length,
        });
    }

    // Venus: fitted-range instability of finite solvers (per solver).
    const venus = ok.filter((r) => r.axes.targetFamily === "venus"
        && r.metrics.truth?.kind === "direction");
    const venusTable = [];
    for (const [solverId, rows] of groupBy(venus, (r) => r.solver.id)) {
        venusTable.push({
            solverId,
            meanDirErrDeg: median(rows.map((r) => r.metrics.truth.meanDirectionErrorDeg)),
            fittedRangeMeanM: quartiles(rows.map((r) => r.metrics.truth.fittedRange?.meanM ?? NaN)),
            behindSensorRate: rows.filter((r) => r.failureFlags.behindSensor).length / rows.length,
            n: rows.length,
        });
    }

    return {q12, q3, q5, targetWind, hab, statusTable, venusTable};
}
