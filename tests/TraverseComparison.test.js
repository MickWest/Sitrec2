import {buildTraverseComparison, comparisonCandidates, comparisonGates, traverseComparisonHTML} from "../src/TraverseComparison";
import {botScoreBreakdown, plausibilityRating} from "../src/TraverseRanking";
import {KNOTS_TO_MS} from "../src/TraverseAnalysis";

function candidate(key, changes = {}) {
    return {
        key, name: key, errDeg: 0.079, fitScaleDeg: 0.2,
        track: new Float64Array([0, 0, 500, 100, 0, 500, 100, 100, 500, 0, 100, 500, 0, 0, 500]),
        metricsFull: {
            gLoad: {rms: 0.25, max: 0.27},
            airSpeed: {min: 49 * KNOTS_TO_MS, mean: 50 * KNOTS_TO_MS, max: 50 * KNOTS_TO_MS},
            turnRate: {std: 1}, verticalSpeed: {mean: 0}, range: {mean: 10000},
        },
        groundStats: {minAGL: 500, fracBelow: 0},
        platformMirror: {method: "acceleration-pattern-v2", assessable: true, scaleStable: true, temporalMatch: true, beta: 0.25, share: 0.1, snr: 4},
        ...changes,
    };
}
const item = h => ({h, r: plausibilityRating(h)});

test("score contributions reconcile with ranking for every solver, including mirroring", () => {
    for (const key of ["quadcopter", "horizontalSpeed", "lantern", "gfCV", "constAlt"]) {
        const h = candidate(key, {platformMirror: {method: "acceleration-pattern-v2", assessable: true, scaleStable: true, temporalMatch: true, beta: 0.25, share: 0.75, snr: 4}});
        const score = botScoreBreakdown(h);
        expect(score.total).toBeCloseTo(plausibilityRating(h).secondaryScore, 12);
        expect(score.terms.find(t => t.key === "mirror").contribution).toBe(4.5);
    }
});

test("a changed peak explains the exact gap while LOS and the other terms stay equal", () => {
    const q = candidate("quadcopter"), hsv = candidate("horizontalSpeed");
    hsv.metricsFull.gLoad.max = 1.43;
    const comparison = buildTraverseComparison(item(q), item(hsv));
    expect(comparison.delta).toBeCloseTo(1.16, 12);
    expect(comparison.decision.key).toBe("score");
    const qG = comparison.gates.find(g => g.key === "g");
    expect(qG.cells.map(c => c.status)).toEqual(["pass", "pass"]);
    expect(qG.cells[0].detail).toContain("1.23 g below limit");
    expect(qG.cells[1].detail).toContain("0.07 g below limit");
    const html = traverseComparisonHTML(comparison);
    expect(html).toContain("lower BOT Score by 1.160");
    expect(html).toContain("+1.160");
});

test("gate boundaries match the ranker: relative LOS is strict, g and speed are inclusive", () => {
    const h = candidate("horizontalSpeed", {errDeg: 0.24});
    h.metricsFull.gLoad.max = 1.5;
    h.metricsFull.airSpeed.max = 650 * KNOTS_TO_MS;
    const gates = comparisonGates(item(h));
    expect(gates.find(g => g.key === "los").cell.status).toBe("fail");
    expect(gates.find(g => g.key === "g").cell.status).toBe("pass");
    expect(gates.find(g => g.key === "speed").cell.status).toBe("pass");
    delete h.fitScaleDeg;
    h.errDeg = 0.05;
    expect(comparisonGates(item(h)).find(g => g.key === "los").cell.status).toBe("pass");
});

test("missing checks stay unassessed; pins and incomplete searches name their failures", () => {
    const h = candidate("quadcopter", {platformMirror: null, groundStats: null,
        boundPinned: ["speed", "speed"], optimizerWarnings: ["iteration budget"], params: {boundaryLimited: true}});
    const gates = Object.fromEntries(comparisonGates(item(h)).map(g => [g.key, g.cell]));
    expect(gates.terrain.status).toBe("unknown");
    expect(gates.mirror.status).toBe("unknown");
    expect(gates.pins.value).toBe("1 reached");
    expect(gates.optimizer.detail).toBe("iteration budget");
    expect(gates.bounds.status).toBe("fail");
});

test("terrain and ground-contact rows expose the saved screening limits", () => {
    const h = candidate("horizontalSpeed", {groundStats: {minAGL: -20, maxAGL: 180, fracBelow: 0},
        groundMismatch: {mode: "On the ground", reason: "airborne (not a ground vehicle)"}});
    const gates = Object.fromEntries(comparisonGates(item(h), {groundMode: "On the ground"}).map(g => [g.key, g.cell]));
    expect(gates.terrain.status).toBe("pass");
    expect(gates.terrain.detail).toContain("5% of samples are more than 40 m below");
    expect(gates.ground.status).toBe("fail");
    expect(gates.ground.detail).toContain("30.0 m above limit");
    expect(gates.los.status).toBe("unknown");
});

test("physical checks reject a looping balloon and disclose missing size for both solvers", () => {
    const comparison = buildTraverseComparison(item(candidate("quadcopter")), item(candidate("horizontalSpeed")));
    expect(comparison.physical.find(c => c.key === "balloon").cells.map(c => c.status)).toEqual(["fail", "fail"]);
    expect(comparison.physical.find(c => c.key === "balloon").cells[0].value).toContain("steady drift");
    const multirotors = comparison.physical.find(c => c.key === "quadcopter").cells;
    expect(multirotors.map(c => c.status)).toEqual(["partial", "partial"]);
    expect(multirotors[0].value).toBe("Passes measured checks · size unknown");
    expect(multirotors[0].detail).toContain("Unassessed: size");
    const measured = buildTraverseComparison(item(candidate("quadcopter")), item(candidate("horizontalSpeed")),
        {angularDiameterMaxDeg: 0.005, fovFullDeg: 1, pixelsAcross: 2000});
    expect(measured.physical.find(c => c.key === "quadcopter").cells.map(c => c.status)).toEqual(["pass", "pass"]);
});

test("truth cannot affect default leaders or their comparison; angular-only candidates are excluded", () => {
    const q = candidate("quadcopter", {truthComparison: {comparable: true, score: 1000}});
    const hsv = candidate("horizontalSpeed", {errDeg: 0.08, truthComparison: {comparable: true, score: 1}});
    const candidates = comparisonCandidates([hsv, candidate("infinity", {atInfinity: true, errDeg: 0}), q,
        candidate("astro", {identity: true, params: {object: "Mars"}, errDeg: 0})]);
    expect(candidates.map(c => c.h.key)).toEqual(["quadcopter", "horizontalSpeed"]);
    expect(buildTraverseComparison(...candidates).decision.key).toBe("score");
});

test("rejected candidates do not show passed gates or a score; names are escaped", () => {
    const comparison = buildTraverseComparison(item(candidate("quadcopter", {name: '<img src=x onerror="bad()">', underground: true})),
        item(candidate("horizontalSpeed")));
    expect(comparison.scores[0]).toBeNull();
    expect(comparison.delta).toBeNull();
    expect(comparison.gates.find(g => g.key === "los").cells[0].status).toBe("unknown");
    const html = traverseComparisonHTML(comparison);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("NaN");
});
