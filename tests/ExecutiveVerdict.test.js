/**
 * assessExecutiveVerdict — the corroboration-first executive headline.
 *
 * The invariants under test mirror the design rules:
 *  - "Probably" is licensed ONLY by independent corroboration (today: the
 *    free balloon fit's frozen wind rating being exactly "supports"), never
 *    by sole-survivorship or gallery position.
 *  - Wind tension weakens but NEVER excludes the balloon interpretation.
 *  - Provenance blockers (circular LOS, unobservable range) force abstention
 *    regardless of how good any fit looks.
 *  - No viable model yields "Unresolved" — explicitly NOT an anomaly claim.
 *  - The assessment never mutates the hypotheses and never changes ranking.
 */
import {
    assessExecutiveVerdict,
    aggregateInterpretationClasses,
    NOT_MODELLED_DISCLOSURE,
    rankAllHypotheses,
} from "../src/TraverseRanking";
import {KNOTS_TO_MS} from "../src/TraverseAnalysis";

function metrics({gMax = 0.1, speedMeanKt = 20, speedMaxKt = speedMeanKt,
    verticalMean = 1} = {}) {
    return {
        gLoad: {min: 0, max: gMax, mean: gMax / 2, rms: gMax / 2, std: 0},
        airSpeed: {min: speedMeanKt * KNOTS_TO_MS, max: speedMaxKt * KNOTS_TO_MS,
            mean: speedMeanKt * KNOTS_TO_MS, rms: speedMeanKt * KNOTS_TO_MS, std: 0},
        verticalSpeed: {min: verticalMean, max: verticalMean, mean: verticalMean,
            rms: Math.abs(verticalMean), std: 0},
        turnRate: {min: 0, max: 0, mean: 0, rms: 0, std: 0},
        altitude: {min: 5000, max: 5400, mean: 5200, rms: 5200, std: 100},
        range: {min: 8000, max: 9000, mean: 8500, rms: 8500, std: 200},
    };
}

// A textbook balloon path: monotonic climb, one-direction drift (consistency 1).
function driftTrack(n = 20) {
    const t = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) { t[i * 3] = i * 30; t[i * 3 + 1] = 0; t[i * 3 + 2] = 5000 + i * 20; }
    return t;
}

function hypothesis(key, opts = {}) {
    return {
        key,
        name: opts.name || key,
        track: opts.track ?? driftTrack(),
        metricsFull: opts.metrics || metrics(),
        errDeg: opts.errDeg ?? 0.02,
        params: opts.params || {},
        boundPinned: opts.boundPinned,
        optimizerWarnings: opts.optimizerWarnings,
        identity: opts.identity,
        windEvidenceRole: opts.windEvidenceRole,
        windEvidence: opts.windEvidence,
    };
}

const supportedBalloon = (windRating = "supports") => hypothesis("lantern", {
    name: "Sky Lantern / Balloon (free wind)",
    windEvidenceRole: "free",
    windEvidence: {role: "free", rating: windRating,
        why: "the free fit independently requires 22 kt from 260°, and the loaded wind shows "
            + "20 kt from 255° along the fitted path (vector RMSE 1.4 kt)"},
});

const poorAircraft = () => hypothesis("aircraft", {errDeg: 0.6, name: "Aircraft"});
const viableQuad = () => hypothesis("quadcopter", {errDeg: 0.03, name: "Quadcopter"});

describe("assessExecutiveVerdict", () => {

    test("independent wind support licenses 'Probably a wind-blown balloon'", () => {
        const v = assessExecutiveVerdict([supportedBalloon(), poorAircraft()], {provenance: {}});
        expect(v.code).toBe("probably-balloon");
        expect(v.headline).toBe("Probably a wind-blown balloon.");
        expect(v.detail).toContain("independent");
        expect(v.detail).toContain("not from a global object-probability ranking");
    });

    test("compatible wind is NOT enough — sole survivor reads 'Consistent with', not 'Probably'", () => {
        const v = assessExecutiveVerdict([supportedBalloon("compatible"), poorAircraft()],
            {provenance: {}});
        expect(v.code).toBe("consistent-one");
        expect(v.headline).toContain("Consistent with a wind-blown balloon");
        expect(v.headline).toContain("not identified");
        expect(v.detail).toContain("only compatible");
    });

    test("wind tension weakens but never excludes the balloon", () => {
        const v = assessExecutiveVerdict([supportedBalloon("tension"), poorAircraft()],
            {provenance: {}});
        expect(v.code).toBe("consistent-one");
        expect(v.detail).toContain("weakens but does not exclude");
    });

    test("two viable classes yield 'Consistent with several'", () => {
        const v = assessExecutiveVerdict([supportedBalloon("compatible"), viableQuad()],
            {provenance: {}});
        expect(v.code).toBe("consistent-several");
        expect(v.detail).toContain("wind-blown balloon");
        expect(v.detail).toContain("multirotor drone");
        expect(v.detail).toContain("No cross-category probability comparison");
    });

    test("a viable catalogue identification blocks 'Probably balloon'", () => {
        const sat = hypothesis("satellite", {identity: true, errDeg: 0.05,
            params: {satellite: "STARLINK-1234", sunlit: true}, metrics: null, track: null});
        const v = assessExecutiveVerdict([supportedBalloon(), sat], {provenance: {}});
        expect(v.code).not.toBe("probably-balloon");
        expect(v.code).toBe("consistent-several");
    });

    test("a sole viable catalogue match explains the missing calibration, not a missing match", () => {
        // The match IS what made the class viable — the wording must cite the
        // uncalibrated pointing uncertainty, never claim no match exists.
        const sat = hypothesis("satellite", {identity: true, errDeg: 0.05,
            params: {satellite: "STARLINK-1234", sunlit: true}, metrics: null, track: null});
        const v = assessExecutiveVerdict([sat, poorAircraft()], {provenance: {}});
        expect(v.code).toBe("consistent-one");
        expect(v.headline).toContain("catalogued satellite or astronomical object");
        expect(v.detail).toContain("pointing uncertainty is not calibrated");
        expect(v.detail).not.toContain("no independent corroborating evidence");
    });

    test("supporting wind with un-balloon-like motion acknowledges the support, never calls it inconclusive", () => {
        // vertical zig-zag: consistency ~0 — the wind may support drift, but
        // the motion itself is not balloon-like, so "Probably" is withheld
        // while the supporting evidence is still described as supporting
        const zigzag = new Float64Array(20 * 3);
        for (let i = 0; i < 20; i++) {
            zigzag[i * 3] = i * 30; zigzag[i * 3 + 1] = 0;
            zigzag[i * 3 + 2] = 5000 + (i % 2 ? 200 : -200);
        }
        const b = supportedBalloon();
        b.track = zigzag;
        const v = assessExecutiveVerdict([b, poorAircraft()], {provenance: {}});
        expect(v.code).toBe("consistent-one");
        expect(v.detail).toContain("supports passive drift");
        expect(v.detail).toContain("not distinctly balloon-like");
        expect(v.detail).not.toContain("inconclusive");
    });

    test("a direction-only geometric check can never make a class viable", () => {
        const atInf = hypothesis("fixedPoint", {errDeg: 0.01, atInfinity: true});
        atInf.atInfinity = true;
        const classes = aggregateInterpretationClasses([atInf]);
        const stationary = classes.find((c) => c.key === "stationary");
        expect(stationary.tested).toBe(true);
        expect(stationary.viable).toBe(false);
        expect(stationary.blocker).toContain("no physical motion is evaluated");
    });

    test("an off-mode ground fit reports its real blocker, not a fit-quality claim", () => {
        const offMode = hypothesis("ground", {errDeg: 0.02});
        offMode.groundMismatch = true;
        const classes = aggregateInterpretationClasses([offMode]);
        const stationary = classes.find((c) => c.key === "stationary");
        expect(stationary.viable).toBe(false);
        expect(stationary.blocker).toContain("ground-contact mode");
        expect(stationary.blocker).not.toContain("LOS fit not close");
    });

    test("a close but shadowed satellite is 'matched but ruled out', never 'no match'", () => {
        const shadowed = hypothesis("satellite", {identity: true, errDeg: 0.05,
            params: {satellite: "STARLINK-1234", sunlit: false}, metrics: null, track: null});
        const classes = aggregateInterpretationClasses([shadowed]);
        const known = classes.find((c) => c.key === "knownObject");
        expect(known.tested).toBe(true);
        expect(known.viable).toBe(false);            // shadow disqualifies the ID...
        expect(known.close).toBe(true);              // ...but the ANGULAR match stays true
        expect(known.blocker).toContain("close angular match");
        expect(known.blocker).toContain("shadow");
    });

    test("a genuinely distant catalogue candidate reports the offset, not a shadow excuse", () => {
        const far = hypothesis("satellite", {identity: true, errDeg: 1.2,
            params: {satellite: "STARLINK-9999", sunlit: true}, metrics: null, track: null});
        const classes = aggregateInterpretationClasses([far]);
        const known = classes.find((c) => c.key === "knownObject");
        expect(known.viable).toBe(false);
        expect(known.blocker).toContain("angular offset");
        expect(known.blocker).not.toContain("shadow");
    });

    test("circular LOS forces abstention even over a supported balloon", () => {
        const v = assessExecutiveVerdict([supportedBalloon()], {provenance: {circular: true}});
        expect(v.code).toBe("insufficient");
        expect(v.detail).toContain("internal consistency");
    });

    test("unobservable range forces abstention", () => {
        const v = assessExecutiveVerdict([supportedBalloon()],
            {provenance: {rangeUnobservable: true}});
        expect(v.code).toBe("insufficient");
        expect(v.detail).toContain("parallax");
    });

    test("an incomplete balloon fit cannot be 'Probably' even with supporting wind", () => {
        const pinned = supportedBalloon();
        pinned.boundPinned = ["windE (max)"];
        const v = assessExecutiveVerdict([pinned, poorAircraft()], {provenance: {}});
        expect(v.code).not.toBe("probably-balloon");
    });

    test("nothing viable yields 'Unresolved' — explicitly not an anomaly claim", () => {
        const v = assessExecutiveVerdict([poorAircraft(),
            hypothesis("lantern", {errDeg: 0.7, windEvidenceRole: "free"})], {provenance: {}});
        expect(v.code).toBe("unresolved");
        expect(v.headline).toContain("Unresolved");
        expect(v.detail).toContain("not, by itself, evidence of anomalous");
        expect(v.detail).toContain("catalogued satellite or astronomical object checks were not run");
        expect(v.notModelled).toEqual(NOT_MODELLED_DISCLOSURE);
    });

    test("astroTime (date-sweeping diagnostic) never counts as a catalogue check", () => {
        const sweep = hypothesis("astroTime", {identity: true, errDeg: 0.01,
            params: {object: "Venus"}, metrics: null, track: null});
        const classes = aggregateInterpretationClasses([sweep]);
        const known = classes.find((c) => c.key === "knownObject");
        expect(known.tested).toBe(false);
    });

    test("assessment mutates nothing and leaves ranking order byte-identical", () => {
        const fixtures = [supportedBalloon(), viableQuad(), poorAircraft()];
        const before = JSON.stringify(fixtures, (k, val) =>
            val instanceof Float64Array ? Array.from(val) : val);
        const orderBefore = rankAllHypotheses(fixtures).map((x) => x.h.name);
        assessExecutiveVerdict(fixtures, {provenance: {}});
        const orderAfter = rankAllHypotheses(fixtures).map((x) => x.h.name);
        const after = JSON.stringify(fixtures, (k, val) =>
            val instanceof Float64Array ? Array.from(val) : val);
        expect(orderAfter).toEqual(orderBefore);
        expect(after).toBe(before);
    });
});
