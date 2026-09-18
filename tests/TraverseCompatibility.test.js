import {meanAngularError, trackMetrics} from "../src/TraverseAnalysis";
import {physicalClassChecks} from "../src/TraverseMundaneness";
import {assessExecutiveVerdict, assessPathCompatibility, plausibilityRating} from "../src/TraverseRanking";

// Measure a real sampled path rather than inventing the metrics that caused the
// bug: the generic 1.50 g ranking gate hid a path inside several class envelopes.
function circularPath(nominalG = 1.65) {
    const n = 600, fps = 10, speed = 25;
    const radius = speed * speed / (nominalG * 9.81);
    const track = new Float64Array(3 * n);
    const dataset = {n, fps, S: new Float64Array(3 * n),
        D: new Float64Array(3 * n), W: new Float64Array(3 * n)};
    for (let f = 0; f < n; f++) {
        const b = f * 3, t = f / fps, angle = speed * t / radius;
        track.set([radius * Math.cos(angle), radius * Math.sin(angle), 500], b);
        dataset.S.set([1000 * Math.cos(t / 30), -5000 + 1000 * Math.sin(t / 30), 1000], b);
        const delta = [0, 1, 2].map(c => track[b + c] - dataset.S[b + c]);
        dataset.D.set(delta.map(v => v / Math.hypot(...delta)), b);
    }
    return {dataset, h: {key: "horizontalSpeed", name: "Circular path", track,
        metricsFull: trackMetrics(dataset, track),
        errDeg: meanAngularError(dataset, track) * 180 / Math.PI,
        fitScaleDeg: 0.2, params: {}}};
}

test("a measured path above the broad g gate retains its physical alternatives", () => {
    const {dataset, h} = circularPath();
    expect(h.metricsFull.gLoad.max).toBeGreaterThan(1.5);
    expect(h.metricsFull.gLoad.max).toBeLessThan(2);
    const before = plausibilityRating(h);
    expect(before.eligible).toBe(false);
    const expected = physicalClassChecks(dataset, h).classes.filter(c => c.compatible).map(c => c.key);
    expect(expected).toEqual(["bird", "quadcopter", "smallUAS"]);
    for (const key of ["horizontalSpeed", "quadcopter", "gfPolyALS"]) {
        const result = assessPathCompatibility([{...h, key}], dataset);
        expect(result.classes.map(c => c.key)).toEqual(expected);
        expect(result.unknown).toContain("size");
    }
    const assessment = assessExecutiveVerdict([h], {dataset});
    expect(assessment.headline).toContain("Object type unresolved");
    expect(assessment.pathCompatibility.classes.map(c => c.key)).toEqual(expected);
    expect(assessment.classes.some(c => c.viable)).toBe(false);
    expect(plausibilityRating(h)).toEqual(before);
});

test("camera mirroring is disclosed by ranking, not used to reject class limits", () => {
    const {dataset, h} = circularPath();
    h.platformMirror = {share: 0.99, beta: 1, mirroredM: 100, independentM: 1,
        rmsPlatform: 100, rmsTrack: 100, snr: 100};
    expect(plausibilityRating(h).mirrorRank).toBeLessThan(3);
    expect(assessPathCompatibility([h], dataset).classes.map(c => c.key)).toContain("quadcopter");
});

test("the class-specific acceleration limit still rejects the multirotor", () => {
    const {dataset, h} = circularPath(2.5);
    expect(h.metricsFull.gLoad.max).toBeGreaterThan(2);
    expect(h.metricsFull.gLoad.max).toBeLessThan(3);
    expect(assessPathCompatibility([h], dataset).classes.map(c => c.key)).toEqual(["bird", "smallUAS"]);
});

test.each([
    {errDeg: 0.3}, {underground: true}, {nonPhysical: true}, {groundMismatch: true},
    {atInfinity: true}, {identity: true, params: {object: "star"}},
    {params: {boundaryLimited: true}}, {boundPinned: ["initialRange"]},
    {modelClamps: ["speed"]}, {optimizerWarnings: ["iteration budget reached"]},
])("invalid, angular-only or unfinished paths are not promoted: %j", changes => {
    const {dataset, h} = circularPath();
    expect(assessPathCompatibility([{...h, ...changes}], dataset).classes).toEqual([]);
});
