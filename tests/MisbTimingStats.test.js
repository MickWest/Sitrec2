import {MISB, MISBFields} from "../src/MISBFields";
import {
    analyzeMisbTiming, analyzePtsSync, analyzeTimelineValues, klvStreamLabels, localFieldValues,
    renderLocalFieldValues, renderSourceFiles, summarizeTimingAnalysis,
} from "../src/analysis/MisbTimingStats";
import {otherKLVPacketList} from "../src/MISBUtils";

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

    test("lists every field with local in its name and its first unique values", () => {
        const misb = makeMisbFromIntervals(new Array(7).fill(1));
        const security = [{key: 1, name: "Security Classification", value: "TEST//"}, {key: 22, name: "Version", value: 10}];
        misb.forEach((row, i) => {
            row[MISB.SecurityLocalSet] = security.map(item => ({...item}));
            row[MISB.Geo_RegistrationLocalSet] = `geo${i}`;
        });
        misb[3][MISB.Geo_RegistrationLocalSet] = "geo0";

        const fields = localFieldValues(misb);
        expect(fields.map(f => f.name)).toEqual(
            ["SecurityLocalSet", "RVTLocalSet", "VMTILocalSet", "Geo_RegistrationLocalSet"]);

        const byName = Object.fromEntries(fields.map(f => [f.name, f]));
        expect(byName.SecurityLocalSet).toMatchObject({tag: 48, recordCount: 8});
        expect(byName.SecurityLocalSet.values).toEqual(["Security Classification=TEST//; Version=10"]);
        expect(byName.RVTLocalSet).toMatchObject({recordCount: 0, values: []});
        expect(byName.Geo_RegistrationLocalSet.recordCount).toBe(8);
        expect(byName.Geo_RegistrationLocalSet.values).toEqual(
            ['"geo0"', '"geo1"', '"geo2"', '"geo4"', '"geo5"']);

        const lines = renderLocalFieldValues(fields);
        expect(lines).toContain("  RVTLocalSet (tag 73): empty");
        expect(lines).toContain("  Geo_RegistrationLocalSet (tag 98): 8 record(s) with a value");
        expect(lines.some(line => line.includes("not ST 0601"))).toBe(false);
    });

    test("lists the KLV packets that are not ST 0601, named when the key is known", () => {
        const vmti = "060e2b34020b01010e01030306000000";
        const unknown = "060e2b34020301010e01030302000000";
        const tally = new Map([[unknown, {count: 2, bytes: 120}], [vmti, {count: 5, bytes: 900}]]);
        const list = otherKLVPacketList(tally, new Map([[vmti, "ST 0903 VMTI"]]));
        expect(list).toEqual([
            {key: vmti, standard: "ST 0903 VMTI", count: 5, bytes: 900},
            {key: unknown, standard: null, count: 2, bytes: 120},
        ]);

        const fields = localFieldValues([]);
        expect(renderLocalFieldValues(fields, {otherPackets: []}))
            .toContain("  KLV packets that are not ST 0601: none");
        const lines = renderLocalFieldValues(fields, {otherPackets: list});
        expect(lines).toContain(`    key ${vmti} (ST 0903 VMTI): 5 packet(s), 900 bytes`);
        expect(lines).toContain(`    key ${unknown}: 2 packet(s), 120 bytes`);
    });

    test("names streams from the container ids, not from their place in the list", () => {
        const withIds = (props) => Object.assign([], props);
        const async = withIds({klvPid: 4096, klvStreamIndex: 1, klvStreamType: 0x06});
        const center = withIds({klvPid: 4096, klvStreamIndex: 1, klvStreamType: 0x06, derivedTrack: "center"});
        const sync = withIds({klvPid: 4098, klvStreamIndex: 3, klvStreamType: 0x15});
        const reloaded = withIds({klvPid: 4098});
        const odd = withIds({klvPid: 300, klvStreamIndex: 2, klvStreamType: 0x16});
        const file = withIds({});

        expect(klvStreamLabels([async, center, sync, reloaded, odd, file])).toEqual([
            "KLV #0:1 [0x1000 = PID 4096], async (stream_type 0x06)",
            "Center (derived from KLV #0:1 [0x1000], async)",
            "KLV #0:3 [0x1002 = PID 4098], sync (stream_type 0x15)",
            "KLV [0x1002 = PID 4098]",
            "KLV #0:2 [0x12c = PID 300], stream_type 0x16",
            "MISB file",
        ]);
        expect(klvStreamLabels([sync, file, withIds({})], {short: true})).toEqual([
            "KLV #0:3 [0x1002], sync", "MISB file 1", "MISB file 2",
        ]);
        expect(klvStreamLabels([sync, withIds({...sync})])).toEqual([
            "KLV #0:3 [0x1002 = PID 4098], sync (stream_type 0x15) (1 of 2)",
            "KLV #0:3 [0x1002 = PID 4098], sync (stream_type 0x15) (2 of 2)",
        ]);

        const lines = renderLocalFieldValues(localFieldValues([]), {stream: "KLV #0:3 [0x1002 = PID 4098]"});
        expect(lines[0]).toBe("LOCAL FIELDS — KLV #0:3 [0x1002 = PID 4098]");
    });

    test("names each source file one time, with its size", () => {
        const withIds = (props) => Object.assign([], props);
        const a = withIds({sourceFile: "falls.ts", sourceBytes: 38812345});
        const b = withIds({sourceFile: "falls.ts", sourceBytes: 38812345});
        const center = withIds({sourceFile: "falls.ts", sourceBytes: 38812345, derivedTrack: "center"});
        expect(renderSourceFiles([a, center, b])).toEqual(["FILE: falls.ts (38,812,345 bytes, 38.8 MB)"]);

        const url = withIds({sourceFile: "https://example.com/u/My%20Flight.ts_klv_4098.klv?v=2", sourceBytes: 1500});
        expect(renderSourceFiles([a, url, withIds({})])).toEqual([
            "FILES:",
            "  falls.ts (38,812,345 bytes, 38.8 MB)",
            "  My Flight.ts_klv_4098.klv (1,500 bytes)",
        ]);
        expect(renderSourceFiles([withIds({})])).toEqual([]);
    });
});
