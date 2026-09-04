/**
 * The platform-mirror (Coryat curve) statistic.
 *
 * The scenarios here are built from the mechanism itself: put a candidate at
 * the wrong range along the same sightlines and its track becomes the affine
 * blend k*truth + (1-k)*platform, so the platform's manoeuvre appears in the
 * solved path scaled by (1-k). Every expectation below is that identity read
 * back out of the statistic.
 */

import {
    detrendUniformMotion,
    platformMirrorStat,
    platformMirrorRank,
    platformMirrorSignificant,
    platformMirrorSummary,
    gradeHypotheses,
    MIRROR_MIN_SNR,
} from "../src/TraversePlatformMirror";
import {hypothesisFitKind, plausibilityRating, assessExecutiveVerdict} from "../src/TraverseRanking";

const N = 200;

// A platform that translates AND manoeuvres: without the manoeuvre there is no
// parallax, and the statistic correctly refuses to say anything.
function platformPath(n = N, turnAmp = 600) {
    const S = new Float64Array(n * 3);
    for (let f = 0; f < n; f++) {
        const t = f / (n - 1);
        S[f * 3] = 4000 - 7000 * t;                       // uniform translation
        S[f * 3 + 1] = -500 - 3400 * t + turnAmp * Math.sin(Math.PI * t);   // + a turn
        S[f * 3 + 2] = 600 + 150 * t;
    }
    return S;
}

// A true object on a straight, constant-velocity path — nothing for the
// detrended regression to find.
function truthPath(n = N) {
    const X = new Float64Array(n * 3);
    for (let f = 0; f < n; f++) {
        const t = f / (n - 1);
        X[f * 3] = 500 + 60 * t;
        X[f * 3 + 1] = 2400 + 30 * t;
        X[f * 3 + 2] = 250;
    }
    return X;
}

/** The candidate a range guess of k*R_true produces on the same sightlines. */
function blend(truth, platform, k, n = N) {
    const out = new Float64Array(n * 3);
    for (let i = 0; i < n * 3; i++) out[i] = k * truth[i] + (1 - k) * platform[i];
    return out;
}

function meanRange(track, platform, n = N) {
    let sum = 0;
    for (let f = 0; f < n; f++) {
        sum += Math.hypot(track[f * 3] - platform[f * 3],
            track[f * 3 + 1] - platform[f * 3 + 1],
            track[f * 3 + 2] - platform[f * 3 + 2]);
    }
    return sum / n;
}

describe("detrendUniformMotion", () => {
    test("a straight constant-velocity path detrends to exactly nothing", () => {
        const straight = truthPath();
        const r = detrendUniformMotion(straight, N);
        for (let i = 0; i < N * 3; i++) expect(Math.abs(r[i])).toBeLessThan(1e-9);
    });

    test("a turn survives detrending, and its mean is removed", () => {
        const r = detrendUniformMotion(platformPath(), N);
        let sum = 0, peak = 0;
        for (let f = 0; f < N; f++) {
            sum += r[f * 3 + 1];
            peak = Math.max(peak, Math.abs(r[f * 3 + 1]));
        }
        expect(Math.abs(sum / N)).toBeLessThan(1e-6);
        expect(peak).toBeGreaterThan(100);
    });

    test("a non-finite sample refuses rather than inventing a fit", () => {
        const bad = truthPath();
        bad[30] = NaN;
        const r = detrendUniformMotion(bad, N);
        for (let i = 0; i < N * 3; i++) expect(r[i]).toBe(0);
    });
});

describe("platformMirrorStat", () => {
    const S = platformPath();
    const truth = truthPath();

    test("the truth track itself mirrors nothing", () => {
        const stat = platformMirrorStat(truth, S, N,
            {rangeM: meanRange(truth, S), errDeg: 0.05});
        expect(stat.share).toBeLessThan(0.01);
        expect(platformMirrorRank(stat)).toBe(3);
    });

    test("beta recovers 1 - k, and the reference range recovers the true range", () => {
        // A candidate placed at 30% of the true range: badly collapsed.
        const k = 0.3;
        const cand = blend(truth, S, k);
        const rangeM = meanRange(cand, S);
        const stat = platformMirrorStat(cand, S, N, {rangeM, errDeg: 0.05});
        expect(stat.beta).toBeCloseTo(1 - k, 6);
        expect(stat.share).toBeGreaterThan(0.99);
        // R_ref = R_c / (1 - beta) must land back on the true mean range.
        expect(stat.referenceRangeM).toBeCloseTo(meanRange(truth, S), 0);
        expect(platformMirrorRank(stat)).toBe(1);
    });

    test("an over-ranged candidate mirrors with the opposite sign", () => {
        const cand = blend(truth, S, 2.5);
        const stat = platformMirrorStat(cand, S, N,
            {rangeM: meanRange(cand, S), errDeg: 0.05});
        expect(stat.beta).toBeCloseTo(-1.5, 6);
        expect(stat.share).toBeGreaterThan(0.99);
        expect(platformMirrorRank(stat)).toBe(1);
        expect(platformMirrorSummary(stat)).toContain("mirrored");
    });

    test("an object with a manoeuvre of its own is reported as partial, not full", () => {
        // Half the manoeuvre is genuinely the object's, half the platform's.
        const own = truthPath();
        for (let f = 0; f < N; f++) {
            own[f * 3] += 245 * Math.sin(3 * Math.PI * (f / (N - 1)));   // its own wiggle
        }
        const cand = blend(own, S, 0.5);
        const stat = platformMirrorStat(cand, S, N,
            {rangeM: meanRange(cand, S), errDeg: 0.05});
        expect(stat.share).toBeGreaterThan(0.5);
        expect(stat.share).toBeLessThan(0.85);
        expect(platformMirrorRank(stat)).toBe(2);
        // The independent manoeuvre does not bias the coefficient: beta still
        // reads the range error, which is what makes the reference range usable
        // on a real object rather than only on a collapsed one.
        expect(stat.beta).toBeCloseTo(0.5, 6);
        expect(stat.independentM).toBeGreaterThan(50);
    });

    test("a straight-flying platform gives no parallax and no verdict", () => {
        const straightS = platformPath(N, 0);      // translation only, no turn
        const cand = blend(truth, straightS, 0.3);
        const stat = platformMirrorStat(cand, straightS, N,
            {rangeM: meanRange(cand, straightS), errDeg: 0.05});
        expect(stat).toBeNull();
    });

    test("mirrored motion below what the residual can resolve is not evidence", () => {
        // The measured false positive this gate exists for: a drone fit whose
        // ENTIRE manoeuvre is a few metres of platform-shaped wander. The share
        // is high, the amount is nothing, and it must not be demoted for it.
        const cand = blend(truth, S, 0.995);
        const stat = platformMirrorStat(cand, S, N,
            {rangeM: meanRange(cand, S), errDeg: 0.15});
        expect(stat.share).toBeGreaterThan(0.99);      // shape says "the platform"
        expect(stat.snr).toBeLessThan(MIRROR_MIN_SNR); // scale says "nothing there"
        expect(platformMirrorRank(stat)).toBe(3);
        expect(platformMirrorSignificant(stat)).toBe(false);
        expect(platformMirrorSummary(stat)).toBeNull();
    });

    test("a degenerate near-zero residual cannot make any metre significant", () => {
        // The exact-ray "Straight Line" candidate reaches ~3e-7 deg by
        // construction; without the angle floor its resolving scale is zero.
        const cand = blend(truth, S, 0.9999);
        const stat = platformMirrorStat(cand, S, N,
            {rangeM: meanRange(cand, S), errDeg: 3e-7});
        expect(Number.isFinite(stat.snr)).toBe(true);
        expect(platformMirrorRank(stat)).toBe(3);
    });

    test("a candidate that does not manoeuvre at all is not mirroring anything", () => {
        const still = new Float64Array(N * 3);
        for (let f = 0; f < N; f++) { still[f * 3] = 500; still[f * 3 + 1] = 2400; still[f * 3 + 2] = 250; }
        const stat = platformMirrorStat(still, S, N, {rangeM: meanRange(still, S), errDeg: 0.1});
        expect(stat.share).toBeLessThan(1e-3);
        expect(platformMirrorRank(stat)).toBe(3);
    });

    test("too few frames, or a missing track, returns null rather than a guess", () => {
        expect(platformMirrorStat(null, S, N, {})).toBeNull();
        expect(platformMirrorStat(truth, S, 4, {})).toBeNull();
        expect(platformMirrorStat(truth, S, N + 50, {})).toBeNull();
    });

    test("the summary states the share, the scale, the metres and the honest range", () => {
        const cand = blend(truth, S, 0.3);
        const stat = platformMirrorStat(cand, S, N,
            {rangeM: meanRange(cand, S), errDeg: 0.05});
        const text = platformMirrorSummary(stat);
        expect(text).toMatch(/^\d+% of its manoeuvring is a [\d.]+× copy of the platform's own path/);
        expect(text).toContain("of independent motion");
        expect(text).toContain("the mirroring vanishes at about");
    });
});

describe("gradeHypotheses", () => {
    // The bug this exists to prevent: the grading was attached by ONE caller,
    // after runTraverseBattery had already frozen the executive assessment —
    // so the headline could declare a class viable while its own tile rejected
    // it — and the benchmark's verdict runner, which builds hypotheses without
    // the battery, never got the grading at all.
    const S = platformPath();
    const truth = truthPath();

    function hyp(key, track, errFloor = 0.1403) {
        return {
            key, name: key, track, errDeg: 0.05,
            params: {errFloor},
            metricsFull: {
                range: {min: 1, max: 1, mean: meanRange(track, S), rms: 1, std: 0},
                gLoad: {min: 0, max: 0.4, mean: 0.2, rms: 0.2, std: 0},
                airSpeed: {min: 0, max: 30, mean: 25, rms: 25, std: 0},
                verticalSpeed: {min: 0, max: 0, mean: 0, rms: 0, std: 0},
                turnRate: {min: 0, max: 0, mean: 0, rms: 0, std: 0},
                altitude: {min: 0, max: 0, mean: 0, rms: 0, std: 0},
            },
        };
    }

    test("attaches the scene scale and the mirror record to every fitted candidate", () => {
        const mirroring = hyp("constAlt", blend(truth, S, 0.3));
        const clean = hyp("lantern", truth);
        gradeHypotheses([mirroring, clean], {S, n: N}, hypothesisFitKind);

        expect(mirroring.fitScaleDeg).toBeCloseTo(0.1403, 6);
        expect(clean.fitScaleDeg).toBeCloseTo(0.1403, 6);
        expect(mirroring.platformMirror.share).toBeGreaterThan(0.99);
        expect(clean.platformMirror.share).toBeLessThan(0.01);
    });

    test("the grading is what makes the tier and the executive verdict agree", () => {
        // Ungraded, both readers see an ordinary, close-fitting aircraft.
        const aircraft = hyp("aircraft", blend(truth, S, 0.3));
        expect(plausibilityRating(aircraft).rank).toBe(3);
        expect(assessExecutiveVerdict([aircraft]).classes
            .find((c) => c.key === "fixedWing").viable).toBe(true);

        // Graded, both reject it — and they must move together: a headline
        // calling a class viable while its own tile is badged "Mirrors the
        // platform" is the inconsistency this ordering exists to prevent.
        gradeHypotheses([aircraft], {S, n: N}, hypothesisFitKind);
        expect(plausibilityRating(aircraft).label).toBe("Mirrors the platform");
        expect(assessExecutiveVerdict([aircraft]).classes
            .find((c) => c.key === "fixedWing").viable).toBe(false);
    });

    test("a catalogue identification is judged on angle alone and is never graded", () => {
        const sat = hyp("satellite", blend(truth, S, 0.3));
        sat.params = {...sat.params, satellite: "STARLINK-1", sunlit: true};
        gradeHypotheses([sat], {S, n: N}, hypothesisFitKind);
        expect(sat.platformMirror).toBeUndefined();
    });

    test("an at-infinity check carries an arbitrary helper range and is never graded", () => {
        const inf = hyp("fixedPoint", blend(truth, S, 0.3));
        inf.atInfinity = true;
        gradeHypotheses([inf], {S, n: N}, hypothesisFitKind);
        expect(inf.platformMirror).toBeUndefined();
    });

    test("no reference residual leaves the absolute ladder in charge", () => {
        const h = hyp("lantern", truth, NaN);
        gradeHypotheses([h], {S, n: N}, hypothesisFitKind);
        expect(h.fitScaleDeg).toBeUndefined();
    });
});
