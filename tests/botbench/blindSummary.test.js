import {summarizeRun} from "../../src/analysis/BotBenchRunner";
import {compareTrackToTruth, trackMetrics} from "../../src/TraverseAnalysis";
import {assessExecutiveVerdict} from "../../src/TraverseRanking";

test("benchmark selection stays blind when truth and attached comparisons change", () => {
    const n = 31;
    const dataset = {n, fps: 10, S: new Float64Array(n * 3), D: new Float64Array(n * 3),
        W: new Float64Array(n * 3)};
    const trackA = new Float64Array(n * 3), trackB = new Float64Array(n * 3);
    for (let f = 0; f < n; f++) {
        const a = [1000 + 2 * f, 10, 500];
        trackA.set(a, f * 3);
        trackB.set([1200 + 4 * f, 30, 700], f * 3);
        dataset.D.set(a.map(x => x / Math.hypot(...a)), f * 3);
    }
    const hypotheses = [
        {key: "constAir", name: "A", track: trackA, errDeg: 0.01},
        {key: "horizontalSpeed", name: "B", track: trackB, errDeg: 0.04},
    ].map(h => ({...h, params: {}, metricsFull: trackMetrics(dataset, h.track)}));
    const record = {label: "test", kind: "bot", quality: {frames: n}, warnings: []};
    const results = {dataset, hypotheses, provenance: {}, failures: [],
        executiveAssessment: assessExecutiveVerdict(hypotheses, {dataset})};
    const summarize = () => summarizeRun(record, results, {}, 0);
    const bare = summarize();
    expect(bare.top.name).toBe("A");
    expect(bare.truthScore).toBeNull();
    expect(bare.viableClasses).toEqual([]);
    expect(bare.pathCompatibleClasses).toContain("quadcopter");
    expect(bare.pathCompatibilityUnknown).toContain("size");

    for (const track of [trackB, trackA]) {
        results.truth = {label: "reference", track};
        for (const h of hypotheses) h.truthComparison = compareTrackToTruth(dataset, h.track, results.truth);
        const row = summarize();
        expect(row.top).toEqual(bare.top);
        expect(row.pathCompatibleClasses).toEqual(bare.pathCompatibleClasses);
        expect(row.truthScore.bestName).toBe(track === trackB ? "B" : "A");
        if (track === trackB) expect(row.truthScore.topSepM).toBeGreaterThan(200);
        else expect(row.truthScore.topSepM).toBe(0);
    }
    delete results.truth;
    // Even stale truth comparisons on cached hypotheses cannot select the top.
    hypotheses[0].truthComparison = {comparable: true, score: 1e9};
    hypotheses[1].truthComparison = {comparable: true, score: 0};
    expect(summarize().top).toEqual(bare.top);
});
