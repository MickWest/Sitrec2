/**
 * verdictRunner.js — run the SHIPPING traverse analysis headless over a BOT
 * Bench scenario and return one record: the hypothesis set the gallery ranks,
 * the executive verdict, the per-class evidence, the range bands, and (scored
 * separately, never fed back in) how the bands compare against truth.
 *
 * This is what TraverseHypotheses.js was extracted for. A benchmark that
 * re-implements the analysis measures the re-implementation; this one calls
 * buildHypotheses / rankAllHypotheses / assessExecutiveVerdict directly, so a
 * change to the shipping analysis shows up in the numbers.
 *
 * REDUCED PROFILE — what is deliberately absent, and why. The report must say
 * this; a coverage claim that quietly omits half the analysis is worse than no
 * claim at all.
 *
 *   - The wind-pinned balloon variant and the drone-control fit. Both need
 *     inputs this harness does not have (an external wind field; a GUI knot
 *     count tied to clip length).
 *   - Live LOS-fit method nodes, which are read off the node graph.
 *   - Independent balloon WIND evidence. This one is a judgement, not a gap:
 *     a scenario's generating wind is a hand-set constant, which the shipping
 *     rating already classifies as an assumption and rates "inconclusive"
 *     (see rateBalloonWindEvidence). Feeding it in as though it were a
 *     measured sounding would MANUFACTURE the corroboration that licenses
 *     "Probably a wind-blown balloon". So the benchmark cannot reach that
 *     verdict at all, and the balloon class tops out at "consistent with".
 *     That is a real limit on what these scenarios can calibrate.
 *   - The astronomy/satellite catalogue searches, unless the caller injects
 *     one through `extraHypotheses` (Venus scenarios need this to be
 *     classifiable at all).
 */

import {
    sweepConstAirSpeed, rangeProfile, fitAircraft, fitConstAltitude,
    fitPlausibleBestRange, compareTrackToTruth, trackMetrics,
    sensorMotionStats, isRangeUnobservable,
    KNOTS_TO_MS, METERS_PER_NM,
} from "../../../src/TraverseAnalysis";
import {fitKalmanFilter, fitPhysicsModel} from "../../../src/LOSFitting";
import {SkyLanternModel} from "../../../src/SkyLanternModel";
import {QuadcopterModel} from "../../../src/QuadcopterModel";
import {buildHypotheses, flatTerrainProbes} from "../../../src/TraverseHypotheses";
import {rankAllHypotheses, assessExecutiveVerdict, plausibilityRating,
    aggregateInterpretationClasses, balloonConsistency} from "../../../src/TraverseRanking";
import {buildRangeLadder, rangeConditionedFamily, losRangeAt, losRangeEnvelope,
    envelopeCoverage} from "../../../src/TraverseFamily";
import {toTraverseDataset} from "./adapters";

// The hypotheses this runner can produce, named so the report can state the
// reduced profile as data rather than prose that drifts.
export const ABSENT_HYPOTHESES = [
    "Sky Lantern / Balloon (measured wind)",
    "Drone (flown inputs)",
    "live LOS-fit method nodes",
    "independent balloon wind evidence",
];

// Production defaults, held here so a drift in either place is visible.
const SPEED_TARGET_MS = 380 * KNOTS_TO_MS;
const SLOW_OPTS = {vTarget: 5 * KNOTS_TO_MS, vSigma: 20 * KNOTS_TO_MS, scoreSpeedWeight: 0.2};
const KS_SEED_MIN_RANGE = 500;

/**
 * The production range bracket, transcribed from AnalyzeTraverse.adaptiveRangeList.
 *
 * 44 rungs LINEARLY spaced from 0.1c to max(8, 2c) nautical miles, clamped to
 * [0.3, 90] NM. It is not exported from AnalyzeTraverse (which is GUI-coupled and
 * cannot be imported here — it pulls in three/addons, which breaks under Jest), so
 * it is duplicated. Unifying the two is the right fix; until then, any edit to the
 * production function must be mirrored here or the benchmark stops measuring the
 * shipping analysis.
 *
 * This previously read `lo = max(200, c/12)`, `hi = 4c`, LOG-spaced — a bracket
 * production never uses, wider on both sides and differently distributed. Every
 * result taken with it was measuring a search the app does not perform.
 */
function adaptiveRangeList(centerMeters, count = 44) {
    const cNM = Math.max(0.5, centerMeters / METERS_PER_NM);
    const loNM = Math.max(0.3, 0.1 * cNM);
    const hiNM = Math.min(90, Math.max(8, 2 * cNM));
    const out = [];
    for (let i = 0; i < count; i++) {
        out.push((loNM + (hiNM - loNM) * i / (count - 1)) * METERS_PER_NM);
    }
    return out;
}

/**
 * Truth, as the analysis-frame track plus the frames on which comparing to it
 * is meaningful: the target must be in frame (the sensor's FOV excluded the
 * rest, so a solver never saw them) and inside the truth track's own validity.
 *
 * Returns null for a DIRECTION-ONLY target. Venus has a per-frame direction and
 * no position — deliberately, since it has no finite range to be right or wrong
 * about (PLAN.md: "No pseudo-track is ever created"). Positional truth scoring
 * and band containment are therefore undefined for it, which is not the same as
 * scoring zero: a band cannot fail to contain a point that does not exist.
 */
export function truthReference(scenario) {
    const track = scenario.target?.positionENU;
    if (!track) return null;
    const n = scenario.n;
    const valid = new Uint8Array(n);
    const inFov = scenario.observation?.inFov;
    const tv = scenario.target?.valid;
    for (let f = 0; f < n; f++) {
        valid[f] = ((!inFov || inFov[f]) && (!tv || tv[f])) ? 1 : 0;
    }
    return {track, valid};
}

/**
 * How much of the truth trajectory a hypothesis's range band contains.
 *
 * Every band member rides essentially the same rays, so this reduces to a 1-D
 * containment test per frame (see TraverseFamily.losRangeAt). Reported per
 * class AND as the union across classes — the union is what an analyst reading
 * the whole gallery would take as the reported uncertainty.
 *
 * A FRAME IS CONTAINED IF SOME SINGLE INTERVAL CONTAINS IT. That rule holds for
 * the union exactly as it holds within one class, and it is the whole reason
 * this function cannot use losRangeEnvelope for the union.
 *
 * It previously did, and the number that came out was not a coverage figure.
 * losRangeEnvelope collapses every member it is given to ONE min/max per frame,
 * so handing it every admitted member of every class produced a single hull from
 * the global minimum to the global maximum. That hull spans the gaps between a
 * class's own disjoint intervals AND the gaps between classes. With balloon
 * admitting 1-2 km and multirotor admitting 8-9 km, the hull claims 1-9 km and
 * counts a truth at 5 km as "contained" when no model admits 5 km at all.
 *
 * The per-class loop below already had the rule, and a comment explaining it.
 * The union broke it three lines later, which is how the headline
 * band-containment result came to be computed from a span nothing admitted.
 */
export function familyCoverage(dataset, families, truth) {
    if (!truth) return null;      // direction-only truth: no range to contain
    const perClass = {};
    // Every admitted interval from every class, kept SEPARATE. Merging is the bug.
    const allIntervals = [];
    let unionMembers = 0;
    for (const [id, fam] of families) {
        const admitted = fam.members.filter((m) => m.screened);
        if (!admitted.length) { perClass[id] = {coverageFrac: null, covered: false, members: 0}; continue; }
        unionMembers += admitted.length;
        allIntervals.push(...fam.intervals);
        // A band with disjoint intervals contains a frame if ANY interval does.
        // Merging them into one min/max would claim coverage across a gap no
        // interval actually admits.
        const frac = intervalCoverage(dataset, fam.intervals, truth);
        perClass[id] = {coverageFrac: frac, covered: frac !== null && frac >= 0.95,
            members: admitted.length};
    }
    const unionFrac = allIntervals.length ? intervalCoverage(dataset, allIntervals, truth) : null;
    return {
        perClass,
        union: {
            coverageFrac: unionFrac,
            covered: Number.isFinite(unionFrac) && unionFrac >= 0.95,
            members: unionMembers,
            intervals: allIntervals.length,
        },
    };
}

/**
 * Fraction of scorable frames whose truth range falls inside AT LEAST ONE of the
 * given intervals. The intervals are never merged, so a gap between them is a
 * gap in coverage — which is what a gap means.
 *
 * A ONE-MEMBER INTERVAL HAS ZERO WIDTH, and without a tolerance it can only
 * "contain" a truth range that matches it to the last bit of a double. Such a
 * band therefore scores 0 by construction no matter how close it lands, which
 * is a property of the metric and not of the band. `envelopeCoverage` has always
 * taken a `tolM` for this; the first version of this function dropped it, and
 * bot-0015's headline 0.00 was partly that artefact rather than a real miss.
 *
 * The tolerance is NOT a fudge factor to make bands look better: it is the width
 * below which "inside" is not a meaningful question. Callers must state it, and
 * a zero-width band should be reported as a single sample rather than scored as
 * a range at all (see the report's F6).
 */
function intervalCoverage(dataset, intervals, truth, tolM = 0) {
    let inside = 0, total = 0;
    for (let f = 0; f < dataset.n; f++) {
        if (!truth.valid[f]) continue;
        total++;
        const r = losRangeAt(dataset, truth.track, f);
        if (!Number.isFinite(r)) continue;
        for (const iv of intervals) {
            if (r >= iv.envelope[f * 2] - tolM && r <= iv.envelope[f * 2 + 1] + tolM) {
                inside++;
                break;
            }
        }
    }
    return total ? inside / total : null;
}

/** True when every interval given is a single point (no width to contain anything). */
function allZeroWidth(dataset, intervals) {
    for (const iv of intervals) {
        for (let f = 0; f < dataset.n; f++) {
            if (iv.envelope[f * 2 + 1] > iv.envelope[f * 2]) return false;
        }
    }
    return true;
}

/**
 * Run the analysis on one scenario.
 *
 * `truth` is carried on the returned record and used ONLY for scoring after
 * the fact. It is never passed to buildHypotheses, never reaches the family
 * construction, and never enters the signature.
 */
export async function runVerdict(scenario, {
    K = 1.5, families: wantFamilies = true, extraHypotheses = null,
    anchorM: anchorOverrideM = null, ranges: rangesOverride = null,
    expand: expandOverride = null,
} = {}) {
    const t0 = Date.now();
    const dataset = toTraverseDataset(scenario);
    const truth = truthReference(scenario);
    const failures = [];

    // The range-ladder anchor. `spec.initialHorizontalRangeM` is a GENERATING
    // parameter — the target's true starting range — so anchoring on it hands the
    // search a bracket centred on the answer, which no analyst has. It is kept as
    // the fallback only because the in-repo generator path has nothing else; a
    // caller measuring honestly (e.g. from the interchange release, whose sidecar
    // deliberately withholds the spec) must pass anchorM explicitly, and the same
    // value for every scenario.
    const anchorM = anchorOverrideM ?? scenario.spec?.initialHorizontalRangeM ?? 5000;
    // `ranges` mirrors production's two branches: left null this is the adaptive
    // bracket around the anchor (GUI Min/Max Dist at their defaults); supplied, it
    // is the uniform list production builds when the user pins a band.
    const ranges = rangesOverride ?? adaptiveRangeList(anchorM);

    // Production expands the bracket ONLY when the user has not pinned a band:
    // `expand: rangeIsDefault` (AnalyzeTraverse.js:2442). Expansion is not a
    // detail — it extends the grid geometrically by up to two rounds of x2.5,
    // so a 0.3-8 NM default bracket can reach ~50 NM. Hard-coding `true` here
    // meant this runner could never model the pinned branch at all, and a
    // caller that passed an explicit band had it silently widened underneath.
    const expand = expandOverride ?? (rangesOverride === null);

    const sweep = await sweepConstAirSpeed(dataset, {ranges, speedTarget: SPEED_TARGET_MS, expand});
    const resolvedRanges = sweep.ranges;
    const rLo = resolvedRanges[0], rHi = resolvedRanges[resolvedRanges.length - 1];

    const fastProfile = await rangeProfile(dataset, {
        ranges: resolvedRanges, vTarget: SPEED_TARGET_MS, vSigma: 60 * KNOTS_TO_MS});
    const slowProfile = await rangeProfile(dataset, {...SLOW_OPTS, ranges: resolvedRanges});

    let aircraft = null;
    try {
        aircraft = await fitAircraft(dataset, {tasTarget: SPEED_TARGET_MS,
            rangeMin: rLo, rangeMax: rHi, runs: 3});
    } catch (e) {
        failures.push({method: "Fixed-Wing Aircraft", error: String(e?.message || e)});
    }

    const ca = fitConstAltitude(dataset, {rangeMin: rLo, rangeMax: rHi});
    const plausible = fitPlausibleBestRange(dataset, {
        vTarget: SPEED_TARGET_MS, vSigma: 60 * KNOTS_TO_MS, rangeMin: rLo, rangeMax: rHi});

    const times = new Float64Array(dataset.n);
    for (let f = 0; f < dataset.n; f++) times[f] = f / dataset.fps;
    const physicsDS = {sensorPos: dataset.S, losDir: dataset.D, times,
        count: dataset.n, maxRange: null};
    const clipDurationSec = (dataset.n - 1) / dataset.fps;
    const physicsOpts = {optimizer: "de", sampleStride: 5, dePop: 48, deGens: 120};

    // Geometric seed: the Kalman smoother with an explicit range floor, exactly
    // as production does. NOT "whichever track fits best" — an LOS fit is
    // degenerate along range, and the lowest-residual track collapses toward
    // the sensor.
    let seedTrack = null;
    try {
        const ks = fitKalmanFilter({...physicsDS, minRange: KS_SEED_MIN_RANGE}, new Set(), {});
        if (ks && ks.positions) seedTrack = ks.positions;
    } catch (e) { /* falls back below */ }
    if (!seedTrack && plausible?.track) seedTrack = plausible.track;

    const seededOverrides = (model) => {
        const v = model.seedParams();
        if (!v) return null;
        const o = {};
        model.getParameterDefs().forEach((d, i) => { o[d.name] = v[i]; });
        return o;
    };

    let lantern = null;
    try {
        const m = new SkyLanternModel();
        m.clipDuration = clipDurationSec;
        let opts = physicsOpts;
        if (seedTrack) {
            m.seedFromTrack(seedTrack, physicsDS);
            const ov = seededOverrides(m);
            if (ov) opts = {...physicsOpts, paramOverrides: ov};
        }
        lantern = await fitPhysicsModel(physicsDS, new Set(), m, opts);
    } catch (e) {
        failures.push({method: "Sky Lantern / Balloon (free wind)", error: String(e?.message || e)});
    }

    let quad = null;
    try {
        quad = await fitPhysicsModel(physicsDS, new Set(), new QuadcopterModel(),
            {...physicsOpts, fitMaxDt: 0.5});
    } catch (e) {
        failures.push({method: "Quadcopter", error: String(e?.message || e)});
    }

    // Range bands. Flat-plane scenarios, so the screen's terrain probe is the
    // exact flat-ground one — supplying only one probe is the bug the
    // both-or-neither guard in buildHypotheses exists to prevent.
    const groundZ = 0;
    const families = new Map();
    if (wantFamilies) {
        for (const spec of familySpecs({physicsDS, physicsOpts, clipDurationSec, seedTrack,
            lantern, quad, aircraft, dataset, rLo, rHi, seededOverrides})) {
            try {
                const {ranges: ladder, noModelOverlap} = buildRangeLadder({
                    loM: rLo, hiM: rHi, anchorM: spec.anchorM,
                    modelLoM: spec.modelLoM, modelHiM: spec.modelHiM});
                // No overlap between the searched bracket and this model's own
                // envelope: no band, rather than one traced outside it.
                if (!ladder.length || noModelOverlap) continue;
                families.set(spec.id, await rangeConditionedFamily({
                    dataset, ranges: ladder, anchorM: spec.anchorM, anchorFit: spec.anchorFit, K,
                    fitAt: spec.fitAt, basinProbe: spec.basinProbe,
                    screen: makeScreen(dataset, groundZ),
                }));
            } catch (e) {
                failures.push({method: `${spec.id} range band`, error: String(e?.message || e)});
            }
        }
    }

    const stats = sensorMotionStats(dataset);
    const provenance = {
        circular: false,          // the sightlines are generated, not target-derived
        rangeUnobservable: isRangeUnobservable(stats, anchorM),
        sensorSpan: stats.span,
    };

    const hypotheses = buildHypotheses({
        dataset, sweep, ca, plausible, aircraft, lantern, quad,
        slowProfile, slowOpts: SLOW_OPTS,
        originLat: (scenario.site?.latDeg ?? 40) * Math.PI / 180,
        originLon: (scenario.site?.lonDeg ?? -105) * Math.PI / 180,
        provenance, failures,
        clipStartMs: Date.parse(scenario.site?.epochISO ?? "2025-02-01T20:00:00Z"),
        ...flatTerrainProbes(groundZ),
        extraHypotheses,
    });

    for (const h of hypotheses) {
        const fam = families.get(`${h.key}|${h.windEvidenceRole ?? ""}`);
        if (fam) h.family = fam;
    }

    const ranked = rankAllHypotheses(hypotheses);
    const executive = assessExecutiveVerdict(hypotheses, {provenance});
    const classes = aggregateInterpretationClasses(hypotheses);

    return {
        scenarioId: scenario.scenarioId ?? scenario.id ?? null,
        spec: scenario.spec ?? null,
        truthFamily: scenario.target?.family ?? null,
        truthKind: scenario.spec?.target?.kind ?? null,
        n: dataset.n, fps: dataset.fps,
        // The bracket ASKED FOR and the bracket actually searched. They differ
        // whenever expansion fires, and reporting only the first makes a
        // configuration look controlled when it was not.
        requestedRangeLoM: ranges[0],
        requestedRangeHiM: ranges[ranges.length - 1],
        resolvedRangeLoM: resolvedRanges[0],
        resolvedRangeHiM: resolvedRanges[resolvedRanges.length - 1],
        expandEnabled: expand,
        provenance,
        absentHypotheses: ABSENT_HYPOTHESES,
        failures,
        hypotheses: ranked.map(({h, r}) => ({
            key: h.key, name: h.name,
            errDeg: Number.isFinite(h.errDeg) ? h.errDeg : null,
            tier: r.label, rank: r.rank, eligible: r.eligible,
            fitRank: r.fitRank, kinematicRank: r.kinematicRank,
            // WHICH limit the search ran into. The class-level blocker collapses
            // this to "search incomplete (bound pins, clamps, or an unconverged
            // optimizer)", which names the symptom and hides the cause — so a
            // pinned model cannot be diagnosed without re-running.
            activePins: r.activePins ?? null,
            modelClamps: r.modelClamps ?? null,
            incomplete: r.incomplete ?? null,
            optimizerWarnings: r.optimizerWarnings ?? null,
            truthSepM: truthSeparation(dataset, h, truth),
            band: h.family ? bandRecord(h.family) : null,
        })),
        executive: {code: executive.code, headline: executive.headline},
        classes: classes.map((c) => ({key: c.key, tested: c.tested, viable: c.viable,
            complete: c.complete, close: c.close, ordinary: c.ordinary,
            bestErrDeg: c.bestErrDeg, blocker: c.blocker,
            ...(c.key === "balloon" ? {consistency: c.consistency ?? null} : {})})),
        truthIsDirectionOnly: truth === null,
        familyCoverage: wantFamilies ? familyCoverage(dataset, families, truth) : null,
        signature: buildSignature({executive, classes, hypotheses, families, provenance}),
        timingMs: Date.now() - t0,
    };
}

function bandRecord(f) {
    return {
        acceptDeg: f.accept, K: f.K, bestErrDeg: f.bestErrDeg,
        intervals: f.intervals.map((iv) => ({loM: iv.loM, hiM: iv.hiM, count: iv.count})),
        screenedCount: f.band.screenedCount, residualCount: f.band.residualCount,
        fitted: f.band.fitted, total: f.band.total,
        rangeLoM: f.band.rangeLoM, rangeHiM: f.band.rangeHiM,
        boundaryLimited: f.boundaryLimited,
        basinReseeded: f.basinCheck?.reseeded?.length ?? 0,
    };
}

function truthSeparation(dataset, h, truth) {
    if (!truth || !h.track || h.atInfinity) return null;
    const tc = compareTrackToTruth(dataset, h.track, truth);
    return tc && tc.comparable && Number.isFinite(tc.score) ? tc.score : null;
}

function makeScreen(dataset, groundZ) {
    const {signedAGL} = flatTerrainProbes(groundZ);
    return (member) => {
        const m = member.metrics;
        const gMax = m?.gLoad?.max;
        const vKt = m?.airSpeed?.max / KNOTS_TO_MS;
        if (!Number.isFinite(gMax) || !Number.isFinite(vKt)) {
            return {ok: false, reason: "metrics are not finite"};
        }
        if (gMax > 9) return {ok: false, reason: `requires ${gMax.toFixed(1)} g`};
        if (vKt > 900) return {ok: false, reason: `requires ${vKt.toFixed(0)} kt`};
        for (let f = 0; f < dataset.n; f++) {
            if (signedAGL(null, member.track[f * 3 + 2]) < -40) {
                return {ok: false, reason: "passes below the ground plane"};
            }
        }
        return {ok: true, reason: null};
    };
}

function familySpecs({physicsDS, physicsOpts, clipDurationSec, seedTrack,
    lantern, quad, aircraft, dataset, rLo, rHi, seededOverrides}) {
    const specs = [];
    const toFit = (fit) => (fit && fit.positions
        ? {track: fit.positions, errDeg: fit.params?.errDeg, solved: fit.params?.solved ?? null}
        : null);

    if (lantern && Number.isFinite(lantern.params?.solved?.initialRange)) {
        const rd = new SkyLanternModel().getParameterDefs().find((d) => d.name === "initialRange");
        const mk = () => {
            const m = new SkyLanternModel();
            m.clipDuration = clipDurationSec;
            if (seedTrack) m.seedFromTrack(seedTrack, physicsDS);
            return m;
        };
        specs.push({
            id: "lantern|free", anchorM: lantern.params.solved.initialRange,
            anchorFit: toFit(lantern),
            modelLoM: rd.min, modelHiM: rd.max,
            fitAt: async (rangeM, seed) => {
                const m = mk();
                const ov = seed?.solved ? {...seed.solved} : (seedTrack ? seededOverrides(m) : null);
                return toFit(await fitPhysicsModel(physicsDS, new Set(), m, {
                    ...physicsOpts, optimizer: "nm", maxIter: 600,
                    ...(ov ? {paramOverrides: ov} : {}),
                    paramLocks: {initialRange: rangeM}}));
            },
            basinProbe: async (rangeM) => toFit(await fitPhysicsModel(physicsDS, new Set(), mk(), {
                ...physicsOpts, dePop: 24, deGens: 40, paramLocks: {initialRange: rangeM}})),
        });
    }

    if (quad && Number.isFinite(quad.params?.solved?.initialRange)) {
        const rd = new QuadcopterModel().getParameterDefs().find((d) => d.name === "initialRange");
        specs.push({
            id: "quadcopter|", anchorM: quad.params.solved.initialRange,
            anchorFit: toFit(quad),
            modelLoM: rd.min, modelHiM: rd.max,
            fitAt: async (rangeM, seed) => toFit(await fitPhysicsModel(physicsDS, new Set(),
                new QuadcopterModel(), {...physicsOpts, optimizer: "nm", maxIter: 600, fitMaxDt: 0.5,
                    ...(seed?.solved ? {paramOverrides: {...seed.solved}} : {}),
                    paramLocks: {initialRange: rangeM}})),
            basinProbe: async (rangeM) => toFit(await fitPhysicsModel(physicsDS, new Set(),
                new QuadcopterModel(), {...physicsOpts, dePop: 24, deGens: 40, fitMaxDt: 0.5,
                    paramLocks: {initialRange: rangeM}})),
        });
    }

    if (aircraft && Number.isFinite(aircraft.params?.startDist)) {
        // fitAircraft's bounds ARE its lock: DE and pattern search both take a
        // zero-width dimension safely, and assessBoundPins skips zero-span
        // coordinates so the lock is never read as a capability limit.
        const at = async (rangeM, runs) => {
            const fit = await fitAircraft(dataset, {tasTarget: SPEED_TARGET_MS,
                rangeMin: rangeM, rangeMax: rangeM, runs});
            return fit ? {track: fit.track, errDeg: fit.errDeg, solved: fit.params} : null;
        };
        specs.push({
            id: "aircraft|", anchorM: aircraft.params.startDist,
            anchorFit: {track: aircraft.track, errDeg: aircraft.errDeg, solved: aircraft.params},
            modelLoM: 0, modelHiM: Infinity,
            fitAt: (rangeM) => at(rangeM, 1),
            basinProbe: (rangeM) => at(rangeM, 2),
        });
    }
    return specs;
}

// --- Evidence signature -----------------------------------------------------
//
// Discrete and small ON PURPOSE. Each percentage the calibration reports must
// trace to "N benchmark scenarios landed in this bin, k of them were X", which
// only works if bins are countable and stable. Everything here is read off the
// analysis; nothing is read off truth.

export const CONSISTENCY_BUCKETS = ["low", "mid", "high"];
export const BAND_BUCKETS = ["none", "collapsed", "moderate", "wide", "disjoint", "boundary"];

export function consistencyBucket(c) {
    if (!Number.isFinite(c)) return "na";
    return c < 0.45 ? "low" : c < 0.75 ? "mid" : "high";
}

/**
 * How determined a class's range is, as a word. Ratio-based (hi/lo), not
 * absolute, so a 2 km and a 40 km scene are described on the same footing.
 */
export function bandBucket(family) {
    if (!family || !family.band || !family.band.screenedCount) return "none";
    if (family.boundaryLimited) return "boundary";
    if (family.intervals.length > 1) return "disjoint";
    const {rangeLoM, rangeHiM} = family.band;
    if (!(rangeLoM > 0) || !Number.isFinite(rangeHiM)) return "none";
    const ratio = rangeHiM / rangeLoM;
    return ratio < 1.25 ? "collapsed" : ratio < 2.5 ? "moderate" : "wide";
}

export function buildSignature({executive, classes, hypotheses, families, provenance}) {
    const viable = classes.filter((c) => c.viable).map((c) => c.key).sort();
    const balloon = classes.find((c) => c.key === "balloon");
    const free = (hypotheses || []).find((h) => h.key === "lantern"
        && h.windEvidenceRole === "free" && h.track);
    const consistency = Number.isFinite(balloon?.consistency)
        ? balloon.consistency
        : (free?.track ? balloonConsistency(free.track) : NaN);
    return {
        code: executive.code,
        viable: viable.join("+") || "none",
        consistency: consistencyBucket(consistency),
        rangeUnobservable: !!provenance.rangeUnobservable,
        bands: Object.fromEntries(["lantern|free", "quadcopter|", "aircraft|"]
            .map((id) => [id, bandBucket(families?.get(id))])),
    };
}

/**
 * Flatten a signature to a single stable bin key.
 *
 * Components are ordered MOST stable first, so backing off is always dropping
 * from the tail and every coarser key is a prefix of the finer one. That is
 * not cosmetic: it means a thin bin's fallback is a strict superset of it, so
 * the counts a percentage is built from can never double-count a scenario
 * across levels, and a reader can see the nesting in the key itself.
 *
 * Least stable last: bands depend on a K that is still being calibrated,
 * observability is a continuous quantity forced into a boolean, and the
 * consistency bucket is a threshold on a measured score. The verdict code and
 * the viable-class set are the most stable, so they survive to the end.
 */
export function signatureKey(sig, level = 0) {
    const parts = [`code=${sig.code}`, `viable=${sig.viable}`];
    if (level < 3) parts.push(`cons=${sig.consistency}`);
    if (level < 2) parts.push(`unobs=${sig.rangeUnobservable ? 1 : 0}`);
    if (level < 1) parts.push(`bands=${Object.values(sig.bands).join(",")}`);
    return parts.join("|");
}

export const MAX_BACKOFF_LEVEL = 3;
