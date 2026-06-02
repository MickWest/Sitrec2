import {MISB, MISBFields} from "../src/MISBFields";
import {analyzeMisbTiming, analyzePtsSync, analyzeTimelineValues, summarizeTimingAnalysis} from "../src/analysis/MisbTimingStats";

function makeMisbFromIntervals(intervalsS) {
    const rows = [];
    let uts = 1_700_000_000_000_000;
    for (let i = 0; i <= intervalsS.length; i++) {
        const row = new Array(MISBFields).fill(null);
        row[MISB.UnixTimeStamp] = uts;
        rows.push(row);
        uts += (intervalsS[i] ?? 0) * 1e6;
    }
    return rows;
}

describe("MisbTimingStats", () => {
    test("analyzes a uniform MISB timeline without flags", () => {
        const misb = makeMisbFromIntervals([1, 1, 1, 1]);
        misb.pesPTSus = [0, 1e6, 2e6, 3e6, 4e6];
        const analysis = analyzeMisbTiming(misb, {
            sourceName: "uniform.ts",
            videoFramePTSus: [0, 1e6, 2e6, 3e6, 4e6],
        });

        expect(analysis.severity).toBe("ok");
        expect(analysis.timelines.uts.gapCount).toBe(0);
        expect(analysis.timelines.uts.spanS).toBe(4);
        expect(summarizeTimingAnalysis(analysis).recordCount).toBe(5);
        expect(summarizeTimingAnalysis(analysis).ptsAvailable).toBe(true);
        expect(summarizeTimingAnalysis(analysis).ptsRecordCoverage).toBe(1);
    });

    test("flags discrete UnixTimeStamp gaps", () => {
        const misb = makeMisbFromIntervals([1, 1, 10, 1]);
        const analysis = analyzeMisbTiming(misb, {sourceName: "gap.ts"});

        expect(analysis.severity).toBe("warn");
        expect(analysis.flags.map(flag => flag.id)).toContain("klv_uts_gaps");
        expect(analysis.timelines.uts.gapCount).toBe(1);
        expect(analysis.timelines.uts.maxGapS).toBe(10);
    });

    test("timeline analysis tracks reversed intervals", () => {
        const timeline = analyzeTimelineValues([0, 1e6, 500000, 2e6], {unitScale: 1e6});

        expect(timeline.negativeCount).toBe(1);
        expect(timeline.valid).toBe(true);
        expect(timeline.pointCount).toBe(4);
    });

    test("builds timing-only PTS sync rows", () => {
        const misb = makeMisbFromIntervals([1, 1, 1]);
        misb.pesPTSus = [0, 1e6, 2e6, 3e6];
        const ptsSync = analyzePtsSync(misb, [0, 1e6, 2e6, 3e6], {
            includeRows: true,
            sourceName: "rows.ts",
            videoPid: 256,
            klvPid: 512,
        });

        expect(ptsSync.stats.ptsAvailable).toBe(true);
        expect(ptsSync.stats.ptsRecordCoverage).toBe(1);
        expect(ptsSync.stats.exactFrameCoverage).toBe(1);
        expect(ptsSync.rows).toHaveLength(4);
        expect(ptsSync.rows[2]).toMatchObject({
            sourceName: "rows.ts",
            videoPid: 256,
            klvPid: 512,
            frameIndex: 2,
            klvRecordIndex: 2,
            deltaUs: 0,
            pairingMethod: "exact_pes",
            pairingQuality: "ok",
        });
    });
});
