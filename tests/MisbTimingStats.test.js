import {MISB, MISBFields} from "../src/MISBFields";
import {
    analyzeMisbTiming, analyzePtsSync, analyzeTimelineValues, klvStreamLabels, localFieldValues,
    chooseAnalyzedStream, renderSourceFiles, renderStreams, renderTracks, streamOfDataNode, streamsOnSitchClock, streamTiming,
    summarizeTimingAnalysis,
} from "../src/analysis/MisbTimingStats";
import {otherKLVPacketList, undecodedTagValues} from "../src/MISBUtils";
import {auCellServiceId, metadataServiceId} from "../src/TSParser";

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
    });

    test("orders the KLV packets that are not ST 0601, and names a key it knows", () => {
        const vmti = "060e2b34020b01010e01030306000000";
        const unknown = "060e2b34020301010e01030302000000";
        const tally = new Map([[unknown, {count: 2, bytes: 120}], [vmti, {count: 5, bytes: 900}]]);
        expect(otherKLVPacketList(tally, new Map([[vmti, "ST 0903 VMTI"]]))).toEqual([
            {key: vmti, standard: "ST 0903 VMTI", count: 5, bytes: 900},
            {key: unknown, standard: null, count: 2, bytes: 120},
        ]);
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
            "KLV #0:1 [0x1000], async",
            "Center (derived from KLV #0:1 [0x1000], async)",
            "KLV #0:3 [0x1002], sync",
            "KLV [0x1002]",
            "KLV #0:2 [0x12c]",
            "MISB file",
        ]);
        expect(klvStreamLabels([sync, file, withIds({})])).toEqual([
            "KLV #0:3 [0x1002], sync", "MISB file 1", "MISB file 2",
        ]);
        expect(klvStreamLabels([sync, withIds({...sync})])).toEqual([
            "KLV #0:3 [0x1002], sync (1 of 2)",
            "KLV #0:3 [0x1002], sync (2 of 2)",
        ]);
    });

    describe("stream timing", () => {
        // A MISB data node with times in ms, where a null time is an invalid record.
        const node = (timesMs, hasPTS = true) => ({
            misb: timesMs.map(() => []),
            hasRecordPTS: () => hasPTS,
            isValid: i => timesMs[i] !== null,
            getTime: i => timesMs[i],
        });
        const every100ms = count => Array.from({length: count}, (_, i) => i * 100);

        test("counts the gaps, and finds the mean and longest interval", () => {
            const times = [0, 100, 200, 300, 900, 1000, 1000, 1100, 1200, 1300];
            expect(streamTiming(node(times))).toEqual({
                records: 10,
                hasRecordPTS: true,
                alignment: null,
                firstTimeMs: 0,
                error: null,
                gaps: {
                    count: 1, tested: true, thresholdMs: 1300 / 9 * 3, meanMs: 1300 / 9, newValueMeanMs: 1300 / 8,
                    maxIntervalMs: 600, repeats: 1,
                },
            });
            expect(streamTiming(node(times, false)).hasRecordPTS).toBe(false);
        });

        test("uses a threshold of at least 100 ms", () => {
            expect(streamTiming(node([0, 10, 20, 30])).gaps).toMatchObject({count: 0, thresholdMs: 100, maxIntervalMs: 10});
        });

        test("does not trust a gap test on a sparse stream", () => {
            expect(streamTiming(node([0, 1, 2, 3, 4, 100])).gaps.tested).toBe(false);
            expect(streamTiming(node(every100ms(10))).gaps.tested).toBe(true);
        });

        test("does not measure across an invalid record", () => {
            const {gaps, records} = streamTiming(node([null, 0, 100, null, 900, 1000, null]));
            expect(records).toBe(7);
            expect(gaps.maxIntervalMs).toBe(100);
            expect(gaps.count).toBe(0);
        });

        test("has no gaps to report with fewer than two valid records", () => {
            expect(streamTiming(node([0])).gaps).toBeNull();
            expect(streamTiming(node([null, 5, null]))).toMatchObject({gaps: null, firstTimeMs: 5});
            expect(streamTiming({misb: null})).toEqual({
                records: 0, hasRecordPTS: false, alignment: null, firstTimeMs: null, gaps: null, error: null,
            });
        });

        test("reports a failed survey without stopping the report", () => {
            const broken = {...node([0, 100, 200]), getTime: () => { throw new Error("no time"); }};
            expect(streamTiming(broken)).toMatchObject({records: 3, gaps: null, error: "no time"});
        });

        test("measures PES PTS against the video frames, only with both", () => {
            const misb = Object.assign([[], [], []], {pesPTSus: [0, 33366, 66733]});
            const onFrames = {misb, hasRecordPTS: () => true, isValid: () => false};
            const video = [0, 33366, 66733, 100100];
            expect(streamTiming(onFrames, video).alignment).toMatchObject({
                firstRecordOffsetUs: 0, recordsOnFrame: 3, klvPtsNonNull: 3, recordsOutsideVideo: 0,
                recordMeanAbsUs: 0, recordMaxAbsUs: 0,
            });
            expect(streamTiming(onFrames).alignment).toBeNull();
            expect(streamTiming({...onFrames, hasRecordPTS: () => false}, video).alignment).toBeNull();
        });

        test("compares with the first video frame, as the video keeps its file's clock origin", () => {
            const misb = Object.assign([[], []], {pesPTSus: [0, 33366]});
            const node = {misb, hasRecordPTS: () => true, isValid: () => false};
            const raw = [49773814633, 49773848000].map(ptsUs => ptsUs - 1);
            expect(streamTiming(node, raw).alignment).toMatchObject({
                firstRecordOffsetUs: 0, recordsOnFrame: 2, recordsOutsideVideo: 0,
            });
        });

        test("finds a constant lead, and records outside the video", () => {
            const misb = Object.assign([[], [], []], {pesPTSus: [-2000000, 14000, 500000]});
            const {stats} = analyzePtsSync(misb, [0, 33366, 66733]);
            expect(stats.firstRecordOffsetUs).toBe(-2000000);
            expect(stats.recordsOnFrame).toBe(0);
            expect(stats.recordsOutsideVideo).toBe(2);
            // Only the record inside the video has a nearest frame worth measuring.
            expect(stats.recordMeanAbsUs).toBe(14000);
            expect(stats.recordMaxAbsUs).toBe(14000);
        });

        test("has no comparison to give when no record has a PES PTS", () => {
            const misb = Object.assign([[], []], {pesPTSus: [null, null]});
            const node = {misb, hasRecordPTS: () => true, isValid: () => false};
            expect(streamTiming(node, [0, 33366]).alignment).toBeNull();
            const allOutside = Object.assign([[], []], {pesPTSus: [9e6, 10e6]});
            expect(streamTiming({...node, misb: allOutside}, [0, 33366]).alignment).toMatchObject({
                recordMeanAbsUs: null, recordMaxAbsUs: null, recordsOutsideVideo: 2,
            });
        });
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

    describe("streams table", () => {
        const stream = (tags, props = {}, records = 3) => {
            const rows = [];
            for (let i = 0; i < records; i++) {
                const row = new Array(MISBFields).fill(null);
                for (const [tag, value] of Object.entries(tags)) {
                    row[tag] = Array.isArray(value) ? value[i % value.length] : value;
                }
                rows.push(row);
            }
            return Object.assign(rows, props);
        };
        const asyncIds = {
            klvPid: 4096, klvStreamIndex: 1, klvStreamType: 0x06,
            tsIds: {pesStreamIds: [0xBD], pmtName: "KLV_ASYNC", continuityErrors: 0, otherStreams: []},
        };
        const syncIds = {
            klvPid: 4098, klvStreamIndex: 3, klvStreamType: 0x15,
            tsIds: {pesStreamIds: [0xFC], pmtName: "KLV_SYNC", continuityErrors: 2, otherStreams: []},
        };
        const labels = ["KLV #0:1 [0x1000], async", "KLV #0:3 [0x1002], sync"];
        // The cells of the table row for a field, and whether it is marked.
        const tableRow = (lines, field) => {
            const line = lines.find(text => text.split("│")[0].replace("≠", "").trim() === field);
            if (!line) return null;
            return {cells: line.split("│").slice(1).map(cell => cell.trim()), differs: line.split("│")[0].includes("≠")};
        };
        const cells = (lines, field) => tableRow(lines, field)?.cells;
        const noTiming = {records: 3, hasRecordPTS: true, alignment: null, firstTimeMs: null, gaps: null, error: null, analyzed: null};

        test("lays out a table with a column for each stream", () => {
            const lines = renderStreams([
                stream({[MISB.UASDatalinkLSVersionNumber]: 4}, asyncIds),
                stream({[MISB.UASDatalinkLSVersionNumber]: 7}, syncIds),
            ], labels);
            const at = lines.findIndex(line => line.startsWith("  Field "));

            expect(lines.slice(0, 2)).toEqual(["STREAMS", "─".repeat(60)]);
            expect(lines[at]).toBe(`  ${"Field".padEnd(37)} │ KLV #0:1 [0x1000], async │ KLV #0:3 [0x1002], sync`);
            expect(lines[at + 1]).toBe(`  ${"─".repeat(37)}─┼─${"─".repeat(24)}─┼─${"─".repeat(23)}`);
            expect(lines[at + 2]).toBe(`  ${"In the TS file".padEnd(37)} │                          │`);
            expect(lines[at + 3]).toBe(`  ${"  ffprobe stream no (#0:N)".padEnd(37)} │ 1                        │ 3`);
            expect(lines).toContain(`  ${"≠ UASDatalinkLSVersionNumber (tag 65)".padEnd(37)} │ 4                        │ 7`);

            const table = lines.slice(at).filter(line => line.includes("│"));
            const barColumns = line => [...line].flatMap((char, i) => (char === "│" ? [i] : []));
            for (const line of table) expect(barColumns(line)).toEqual(barColumns(table[0]));
        });

        test("marks a tag row that differs, in the Field column, and not an id or a measurement", () => {
            const lines = renderStreams([
                stream({[MISB.UASDatalinkLSVersionNumber]: 5, [MISB.PlatformDesignation]: "Turret"}, asyncIds),
                stream({[MISB.UASDatalinkLSVersionNumber]: 7, [MISB.MissionID]: "N/A"}, syncIds),
            ], labels, {timing: [{...noTiming, records: 3}, {...noTiming, records: 4}]});

            expect(tableRow(lines, "ffprobe stream no (#0:N)")).toEqual({cells: ["1", "3"], differs: false});
            expect(tableRow(lines, "PID")).toEqual({cells: ["4096 (0x1000)", "4098 (0x1002)"], differs: false});
            expect(tableRow(lines, "stream_type")).toEqual({cells: ["0x06", "0x15"], differs: false});
            expect(tableRow(lines, "PES stream_id")).toEqual({cells: ["0xbd", "0xfc"], differs: false});
            expect(tableRow(lines, "Name in the PMT")).toEqual({cells: ["KLV_ASYNC", "KLV_SYNC"], differs: false});
            expect(tableRow(lines, "Records")).toEqual({cells: ["3", "4"], differs: false});
            expect(tableRow(lines, "UASDatalinkLSVersionNumber (tag 65)")).toEqual({cells: ["5", "7"], differs: true});
            expect(tableRow(lines, "MissionID (tag 3)")).toEqual({cells: ["none", '"N/A"'], differs: true});
            expect(tableRow(lines, "PlatformDesignation (tag 10)")).toEqual({cells: ['"Turret"', "none"], differs: true});
            expect(lines.join("\n")).toContain("≠ = the streams have different values");
            expect(lines.some(line => line.includes("not saved"))).toBe(false);
        });

        test("shows the tag rows for every file, so that the table has one shape", () => {
            const lines = renderStreams([stream({})], ["MISB file"]);
            for (const name of ["UASDatalinkLSVersionNumber (tag 65)", "MissionID (tag 3)", "PlatformTailNumber (tag 4)",
                "PlatformCallSign / TrackID (tag 59)", "PlatformDesignation (tag 10)", "ImageSourceSensor (tag 11)",
                "SecurityLocalSet (tag 48)"]) {
                expect(cells(lines, name)).toEqual(["none"]);
            }
            expect(lines.some(line => line.startsWith("  Empty in"))).toBe(false);
        });

        test("has one stream column for one stream, and shows every value of a mixed stream", () => {
            const lines = renderStreams(
                [stream({[MISB.UASDatalinkLSVersionNumber]: [5, 7]}, syncIds)], ["KLV #0:3 [0x1002], sync"]);
            expect(lines[0]).toBe("STREAMS");
            expect(tableRow(lines, "Field")).toEqual({cells: ["KLV #0:3 [0x1002], sync"], differs: false});
            expect(cells(lines, "UASDatalinkLSVersionNumber (tag 65)")).toEqual(["5 / 7"]);
            expect(cells(lines, "PID")).toEqual(["4098 (0x1002)"]);
            expect(lines.join("\n")).not.toContain("≠");
        });

        test("marks a true difference, not a difference in what the cell shows", () => {
            const values = last => ["A", "B", "C", "D", "E", last];
            const cut = renderStreams([stream({[MISB.MissionID]: values("Z")}, {}, 6), stream({[MISB.MissionID]: values("Y")}, {}, 6)],
                ["MISB file 1", "MISB file 2"]);
            expect(tableRow(cut, "MissionID (tag 3)").differs).toBe(true);

            const sameValue = stream({[MISB.MissionID]: "A"}, {}, 2);
            const lessOften = stream({}, {}, 2);
            lessOften[0][MISB.MissionID] = "A";
            const coverage = renderStreams([sameValue, lessOften], ["MISB file 1", "MISB file 2"]);
            expect(tableRow(coverage, "MissionID (tag 3)")).toEqual({cells: ['"A"', '"A" (in 1 of 2)'], differs: false});
        });

        test("counts the tags that have a value, and says how many only one stream has", () => {
            const first = stream({[MISB.MissionID]: "A", [MISB.PlatformTailNumber]: "", [MISB.PlatformHeadingAngle]: 90});
            const second = stream({[MISB.MissionID]: "A", [MISB.PlatformRollAngle]: 1, [MISB.PlatformPitchAngle]: 2});
            const lines = renderStreams([first, second], ["MISB file 1", "MISB file 2"]);
            expect(cells(lines, "Tags in the stream")).toEqual(["2 (1 only here)", "3 (2 only here)"]);
        });

        test("says when a cell was cut, and when only some records have the tag", () => {
            const rows = stream({[MISB.MissionID]: ["a", "b", "c", "d", "e", "f", "g"]}, {}, 7);
            const lines = renderStreams([rows], ["MISB file"]);
            const start = lines.findIndex(line => line.includes("MissionID (tag 3)"));
            expect(lines.slice(start, start + 2).map(line => line.split("│")[1].trim()).join(" "))
                .toBe('"a" / "b" / "c" / "d" / "e" +2 more');
            const partial = stream({}, {}, 4);
            partial[2][MISB.MissionID] = "x";
            expect(cells(renderStreams([partial], ["MISB file"]), "MissionID (tag 3)")).toEqual(['"x" (in 1 of 4)']);
        });

        test("wraps a long value inside its cell, and keeps the columns in line", () => {
            const long = "a very long platform designation with many words in it";
            const lines = renderStreams([
                stream({[MISB.PlatformDesignation]: long}, asyncIds),
                stream({[MISB.PlatformDesignation]: "short"}, syncIds),
            ], labels);
            const start = lines.findIndex(line => line.includes("PlatformDesignation (tag 10)"));
            const table = lines.filter(line => line.includes("│"));
            const bars = table[0].indexOf("│");
            for (const line of table) expect(line.indexOf("│")).toBe(bars);

            const firstCell = line => line.split("│")[1].trim();
            expect(firstCell(lines[start])).toBe('"a very long platform');
            expect(firstCell(lines[start + 1])).toBe("designation with many words in");
            expect(firstCell(lines[start + 2])).toBe('it"');
            expect(lines[start]).toContain("≠");
            expect(lines[start + 1]).not.toContain("≠");
            expect(lines[start + 1].split("│")[0].trim()).toBe("");
        });

        test("cuts a long value with no spaces at the column width", () => {
            const lines = renderStreams([stream({[MISB.MissionID]: "x".repeat(70)})], ["MISB file"]);
            const start = lines.findIndex(line => line.startsWith("    MissionID (tag 3)"));
            expect(lines[start].split("│")[1].trim()).toBe(`"${"x".repeat(29)}`);
            expect(lines[start + 1].split("│")[1].trim()).toBe("x".repeat(30));
            expect(lines[start + 2].split("│")[1].trim()).toBe(`${"x".repeat(11)}"`);
        });

        test("gives each stream its timing as rows, on the clock that it really reads", () => {
            const timing = [
                {records: 1500, hasRecordPTS: false, alignment: null, firstTimeMs: 1460546075637, error: null, analyzed: null,
                    gaps: {count: 2, tested: true, thresholdMs: 300, meanMs: 100, maxIntervalMs: 1234.4, repeats: 866}},
                {records: 900, hasRecordPTS: true, firstTimeMs: 1460571274819, gaps: null, error: null, analyzed: "platform track",
                    alignment: {firstRecordOffsetUs: 14344, recordsOnFrame: 1, klvPtsNonNull: 900, recordMeanAbsUs: 2033,
                        recordMaxAbsUs: 14033, recordsOutsideVideo: 0}},
            ];
            const lines = renderStreams([stream({}, asyncIds), stream({}, syncIds)], labels, {timing, derivedCount: 3});

            expect(cells(lines, "Records")).toEqual(["1500", "900"]);
            expect(cells(lines, "hasRecordPTS")).toEqual(["no", "yes"]);
            expect(cells(lines, "First valid time (tag 2)")).toEqual(["2016-04-13T11:14:35.637Z", "2016-04-13T18:14:34.819Z"]);
            expect(cells(lines, "Clock offset from KLV #0:1")).toEqual(["—", "+7 h -0.82 s (first times)"]);
            expect(lines.join("\n")).not.toContain("clocks");
            expect(cells(lines, "Mean interval (tag 2)")).toEqual(["100 ms", "n/a"]);
            expect(cells(lines, "Max interval (tag 2)")).toEqual(["1234 ms", "n/a"]);
            expect(cells(lines, "Repeated times (tag 2)")).toEqual(["866", "n/a"]);
            expect(cells(lines, "Gaps (tag 2)")).toEqual(["2 (> 300 ms)", "n/a"]);
            expect(cells(lines, "First PTS minus first frame PTS")).toEqual(["n/a", "+14.344 ms"]);
            expect(cells(lines, "PTS equal to a frame PTS")).toEqual(["n/a", "1 of 900"]);
            expect(cells(lines, "Offset to nearest frame")[1]).toBe("mean 2.03 ms, max 14.03 ms");
            expect(cells(lines, "Records outside the video")).toEqual(["n/a", "0"]);
            expect(cells(lines, "Analyzed below")).toEqual(["no", "yes: platform track"]);
            expect(lines.join("\n")).toContain("hasRecordPTS = no: Sitrec times these records by UnixTimeStamp");
            expect(lines).toContain("  3 derived track(s) not listed: their rows hold only time and position.");

            const one = renderStreams([stream({}, syncIds)], ["KLV #0:3 [0x1002], sync"], {timing: [timing[1]]}).join("\n");
            expect(one).not.toContain("Clock offset");
            expect(one).not.toContain("hasRecordPTS = no");
            expect(one).not.toContain("derived track");
            expect(one).not.toContain("clocks do not agree");
        });

        test("reads two clocks at the same moment when both streams have PES PTS", () => {
            const clockGapUs = 7 * 3600e6 - 816000;
            const base = stream({[MISB.UnixTimeStamp]: [1e15, 1e15 + 40e3, 1e15 + 80e3]}, {...asyncIds, pesPTSus: [0, 40e3, 80e3]});
            // This stream starts one record later, so its first time is not a fair test.
            const other = stream({[MISB.UnixTimeStamp]: [1e15 + 40e3 + clockGapUs, 1e15 + 80e3 + clockGapUs]},
                {...syncIds, pesPTSus: [40e3, 80e3]}, 2);
            const timing = [{...noTiming, firstTimeMs: 1e12}, {...noTiming, firstTimeMs: 1e12 + 7 * 3600e3 + 39184}];
            const lines = renderStreams([base, other], labels, {timing});
            expect(cells(lines, "Clock offset from KLV #0:1")).toEqual(["—", "+7 h -0.82 s"]);
        });

        describe("two clocks read at the same moment", () => {
            const pair = (offsetUs) => [
                stream({[MISB.UnixTimeStamp]: [1e15, 1e15 + 40e3, 1e15 + 80e3]}, {...asyncIds, pesPTSus: [0, 40e3, 80e3]}),
                stream({[MISB.UnixTimeStamp]: [1e15 + offsetUs, 1e15 + 40e3 + offsetUs, 1e15 + 80e3 + offsetUs]},
                    {...syncIds, pesPTSus: [0, 40e3, 80e3]}),
            ];
            const timing = [{...noTiming, firstTimeMs: 1e12}, {...noTiming, firstTimeMs: 1e12}];

            test("says that a difference of whole hours can be a time zone", () => {
                const text = renderStreams(pair(7 * 3600e6 - 818000), labels, {timing}).join("\n");
                expect(text).toContain("differ by whole hours, which can be a time zone");
                expect(text).toContain("Compare the sun height with the picture");
                expect(text).not.toContain("do not agree");
            });

            test("says that clocks with any other difference do not agree", () => {
                const text = renderStreams(pair(90e6), labels, {timing}).join("\n");
                expect(text).toContain("The clocks do not agree. Compare the sun height");
                expect(text).not.toContain("whole hours");
            });

            test("says nothing about clocks that agree", () => {
                expect(renderStreams(pair(800e3), labels, {timing}).join("\n")).not.toContain("clocks");
            });

            test("does not point to the sun height when names are hidden", () => {
                const text = renderStreams(pair(90e6), labels, {timing, hideNames: true}).join("\n");
                expect(text).toContain("The clocks do not agree. The report cannot say which is right.");
                expect(text).not.toContain("Compare the sun height");
            });
        });

        describe("the sun height", () => {
            // Snoqualmie Falls, on the clock of each stream of falls.ts. One clock is
            // local time marked as UTC, and the picture is in daylight.
            const place = {[MISB.SensorLatitude]: 47.559, [MISB.SensorLongitude]: -121.891};
            const atFalseClock = {...noTiming, firstTimeMs: Date.UTC(2016, 3, 13, 11, 14, 35, 637)};
            const atTrueClock = {...noTiming, firstTimeMs: Date.UTC(2016, 3, 13, 18, 14, 34, 819)};

            test("is below the horizon on the false clock and above it on the true one", () => {
                const lines = renderStreams([stream(place, asyncIds), stream(place, syncIds)], labels, {timing: [atFalseClock, atTrueClock]});
                const [falseClock, trueClock] = cells(lines, "Sun height at first record");
                expect(Number(falseClock.replace("°", ""))).toBeCloseTo(-19.8, 0);
                expect(Number(trueClock.replace("°", ""))).toBeCloseTo(45.0, 0);
            });

            test("is hidden with the names, as it depends on the place and the time", () => {
                const lines = renderStreams([stream(place, asyncIds)], ["KLV"], {timing: [atFalseClock], hideNames: true});
                expect(cells(lines, "Sun height at first record")).toEqual(["hidden"]);
            });

            test("needs a time and a position", () => {
                expect(cells(renderStreams([stream({}, asyncIds)], ["KLV"], {timing: [atFalseClock]}), "Sun height at first record"))
                    .toEqual(["n/a"]);
                expect(cells(renderStreams([stream(place, asyncIds)], ["KLV"], {timing: [noTiming]}), "Sun height at first record"))
                    .toEqual(["n/a"]);
            });
        });

        test("gives the time between new values for a stream that repeats records", () => {
            const held = {...noTiming, gaps: {count: 0, tested: true, thresholdMs: 100, meanMs: 16.7, newValueMeanMs: 30, maxIntervalMs: 30, repeats: 866}};
            const lines = renderStreams([stream({})], ["MISB file"], {timing: [held]});
            expect(cells(lines, "Mean interval (tag 2)")).toEqual(["30 ms (repeats left out)"]);
        });

        test("names the first stream in the rows that compare with it", () => {
            const lines = renderStreams([stream({}, {klvPid: 4096}), stream({})], ["KLV [0x1000], sync", "MISB file"],
                {timing: [noTiming, noTiming]});
            expect(cells(lines, "Clock offset from KLV [0x1000]")).toEqual(["—", "n/a"]);
            expect(tableRow(lines, "Compared with KLV [0x1000]")).not.toBeNull();
            const both = renderStreams([stream({}, asyncIds), stream({}, asyncIds)],
                ["KLV #0:1 [0x1000], async (1 of 2)", "KLV #0:1 [0x1000], async (2 of 2)"], {timing: [noTiming, noTiming]});
            expect(tableRow(both, "Compared with KLV #0:1 (1 of 2)")).not.toBeNull();
        });

        test("shows which clock the sitch is on", () => {
            const timing = [{...noTiming, onSitchClock: true}, {...noTiming, onSitchClock: false}];
            const lines = renderStreams([stream({}, asyncIds), stream({}, syncIds)], labels, {timing});
            expect(cells(lines, "Sitch time on this clock")).toEqual(["yes", "no"]);
            const unknown = renderStreams([stream({}, asyncIds), stream({}, syncIds)], labels, {timing: [noTiming, noTiming]});
            expect(cells(unknown, "Sitch time on this clock")).toEqual(["n/a", "n/a"]);
        });

        test("says so when a stream has too few records for a gap test, or a survey failed", () => {
            const sparse = {...noTiming, gaps: {count: 0, tested: false, thresholdMs: 126206, meanMs: 42069, maxIntervalMs: 98484, repeats: 0}};
            const lines = renderStreams([stream({})], ["MISB file"], {timing: [sparse]});
            expect(cells(lines, "Gaps (tag 2)")).toEqual(["too few records to test"]);
            expect(cells(lines, "Mean interval (tag 2)")).toEqual(["42069 ms"]);
            const failed = renderStreams([stream({})], ["MISB file"], {timing: [{...noTiming, error: "no time"}]});
            expect(cells(failed, "Gaps (tag 2)")).toEqual(["survey failed: no time"]);
        });

        test("shows the decode counts of each stream", () => {
            const stats = {packets: 10, rejected: 1, badLengths: 2, badChecksums: 3, pesWithoutPacket: 4,
                tagFaults: [{tag: 22, kind: "wrong length", count: 24}, {tag: 74, kind: "decode error", count: 1}]};
            const lines = renderStreams([stream({}, {...syncIds, klvDecodeStats: stats})], ["KLV"], {timing: [noTiming]});
            expect(cells(lines, "Packets not decoded")).toEqual(["3 of 12"]);
            expect(cells(lines, "PES with no KLV packet")).toEqual(["4"]);
            expect(cells(lines, "Bad or missing checksums")).toEqual(["3"]);
            expect(cells(lines, "TS continuity errors")).toEqual(["2"]);
            const start = lines.findIndex(line => line.includes("Tag faults"));
            expect(lines.slice(start, start + 2).map(line => line.split("│")[1].trim()).join(" "))
                .toBe("tag 22 wrong length ×24 / tag 74 decode error ×1");

            const clean = {packets: 10, rejected: 0, badLengths: 0, badChecksums: 0, pesWithoutPacket: null, tagFaults: []};
            const noPES = renderStreams([stream({}, {klvDecodeStats: clean})], ["MISB file"], {timing: [noTiming]});
            expect(cells(noPES, "Tag faults")).toEqual(["none"]);
            expect(cells(noPES, "PES with no KLV packet")).toEqual(["n/a"]);
            const csv = renderStreams([stream({})], ["MISB file"], {timing: [noTiming]});
            expect(cells(csv, "Packets not decoded")).toEqual(["n/a"]);
        });

        test("leaves the timing rows out when there is no timing", () => {
            const lines = renderStreams([stream({}, syncIds)], ["KLV"]);
            expect(tableRow(lines, "Timing")).toBeNull();
            expect(tableRow(lines, "Decoding")).toBeNull();
        });

        test("compares the positions of the streams on their shared clock", () => {
            const fix = (lat, lon, frameLat) => ({[MISB.SensorLatitude]: lat, [MISB.SensorLongitude]: lon,
                [MISB.FrameCenterLatitude]: frameLat, [MISB.FrameCenterLongitude]: lon});
            const first = stream(fix(10, 20, 10), {...asyncIds, pesPTSus: [0, 33000, 66000]});
            const second = stream(fix(10.001, 20, 10.01), {...syncIds, pesPTSus: [1000, 34000, 67000]});
            const lines = renderStreams([first, second], labels, {timing: [noTiming, noTiming]});
            expect(tableRow(lines, "Compared with KLV #0:1")).not.toBeNull();
            expect(cells(lines, "Sensor position (horizontal)")).toEqual(["—", "median 111.3 m"]);
            expect(cells(lines, "Frame center (horizontal)")).toEqual(["—", "median 1113.2 m"]);

            const late = stream(fix(10, 20, 10), {...syncIds, pesPTSus: [9e6, 10e6, 11e6]});
            expect(cells(renderStreams([first, late], labels, {timing: [noTiming, noTiming]}), "Sensor position (horizontal)"))
                .toEqual(["—", "n/a"]);
        });

        test("pairs by tag 2 when a stream has no PES PTS, in the units of each source", () => {
            const fix = lat => ({[MISB.SensorLatitude]: lat, [MISB.SensorLongitude]: 20});
            const klvTime = {[MISB.UnixTimeStamp]: [1700000000000000, 1700000000040000, 1700000000080000]};
            const csvTime = {[MISB.UnixTimeStamp]: [1700000000000, 1700000000040, 1700000000080]};
            const klv = stream({...fix(10), ...klvTime}, asyncIds);
            const csv = stream({...fix(10.001), ...csvTime});
            const lines = renderStreams([klv, csv], ["KLV", "MISB file"], {timing: [noTiming, noTiming]});
            expect(cells(lines, "Sensor position (horizontal)")).toEqual(["—", "median 111.3 m"]);

            // 50 s apart on a CSV clock must not pair as 50 ms.
            const farApart = {[MISB.UnixTimeStamp]: [1700000050000, 1700000050040, 1700000050080]};
            const late = stream({...fix(10.001), ...farApart});
            const unpaired = renderStreams([klv, late], ["KLV", "MISB file"], {timing: [noTiming, noTiming]});
            expect(cells(unpaired, "Sensor position (horizontal)")).toEqual(["—", "n/a"]);
        });

        test("shows a local set only when a stream has it, apart from the Security set", () => {
            const set = [{key: 1, name: "Classification", value: "TEST//"}, {key: 22, name: "Version", value: 10}];
            const lines = renderStreams([
                stream({[MISB.SecurityLocalSet]: [set]}, asyncIds),
                stream({}, syncIds),
            ], ["KLV #0:1", "KLV #0:3"]);
            const start = lines.findIndex(line => line.includes("SecurityLocalSet (tag 48)"));
            expect(lines[start]).toContain("≠");
            expect(lines[start].split("│")[1].trim()).toBe("Classification=TEST//;");
            expect(lines[start + 1].split("│")[1].trim()).toBe("Version=10");
            expect(tableRow(lines, "RVTLocalSet (tag 73)")).toBeNull();
            expect(tableRow(lines, "VMTILocalSet (tag 74)")).toBeNull();

            const vmti = renderStreams([stream({[MISB.VMTILocalSet]: [[{name: "Version", value: 5}]]})], ["MISB file"]);
            expect(cells(vmti, "VMTILocalSet (tag 74)")).toEqual(["Version=5"]);
        });

        test("prints a local set that misb.js cannot decode as raw hex, in one row", () => {
            const tag = MISB.Geo_RegistrationLocalSet;
            const lines = renderStreams([stream({[tag]: "Not Implemented"}, {
                undecodedKLVTags: [{tag, name: "Geo-Registration Local Set", count: 3, values: ["0102"]}],
            })], ["MISB file"]);
            const text = lines.join("\n");
            expect(text).not.toContain("Not Implemented");
            expect(tableRow(lines, "Geo_RegistrationLocalSet (tag 98)")).toBeNull();
            expect(tableRow(lines, "Geo-Registration Local Set (tag 98)")).toEqual({cells: ["0102"], differs: false});
            expect(text.match(/tag 98/g)).toHaveLength(1);
        });

        test("adds a row for each key that is not ST 0601, across the streams", () => {
            const vmti = {key: "060e2b34020b01010e01030306000000", standard: "ST 0903 VMTI", count: 5, bytes: 900};
            const unknown = {key: "060e2b34020301010e01030302000000", standard: null, count: 1, bytes: 120};
            const lines = renderStreams([
                stream({}, {otherKLVPackets: [vmti, unknown]}),
                stream({}, {otherKLVPackets: [{...vmti, count: 4, bytes: 700}]}),
            ], ["MISB file 1", "MISB file 2"]);
            expect(tableRow(lines, "KLV packets that are not ST 0601")).not.toBeNull();
            expect(cells(lines, "ST 0903 VMTI")).toEqual(["5 packet(s), 900 bytes", "4 packet(s), 700 bytes"]);
            expect(cells(lines, `key ${unknown.key}`)).toEqual(["1 packet(s), 120 bytes", "none"]);
            expect(lines).not.toContain("  KLV packets that are not ST 0601: none");
        });

        test("says when the KLV has only ST 0601, and says nothing for data that is not KLV", () => {
            const klv = renderStreams([stream({}, {otherKLVPackets: []})], ["MISB file"]);
            expect(klv).toContain("  KLV packets that are not ST 0601: none");
            const csv = renderStreams([stream({})], ["MISB file"]);
            expect(csv.join("\n")).not.toContain("not ST 0601");
        });

        test("marks ids that were not saved, and says no TS for a stream that has none", () => {
            const reloaded = renderStreams([stream({}, {klvPid: 4098})], ["KLV [0x1002]"], {timing: [noTiming]});
            expect(cells(reloaded, "PES stream_id")).toEqual(["?"]);
            expect(cells(reloaded, "TS continuity errors")).toEqual(["?"]);
            expect(cells(reloaded, "PID")).toEqual(["4098 (0x1002)"]);
            expect(reloaded).toContain("  ? = not saved with this stream. Load the TS file to read it.");

            const file = renderStreams([stream({[MISB.PlatformCallSign]: "ALPHA"})], ["MISB file"]);
            expect(tableRow(file, "In the TS file")).toBeNull();
            expect(cells(file, "PlatformCallSign / TrackID (tag 59)")).toEqual(['"ALPHA"']);

            const mixed = renderStreams([stream({}, syncIds), stream({})], ["KLV", "MISB file"], {timing: [noTiming, noTiming]});
            expect(tableRow(mixed, "PES stream_id")).toEqual({cells: ["0xfc", "no TS"], differs: false});
            expect(cells(mixed, "TS continuity errors")).toEqual(["2", "no TS"]);
            expect(mixed.some(line => line.includes("not saved"))).toBe(false);
        });

        test("shows the raw value of a tag that is not decoded, with its name", () => {
            const undecoded = (tag, hexes) => ({undecodedKLVTags: [{tag, name: null, count: 3, values: hexes}]});
            const lines = renderStreams([
                stream({143: "Not Implemented"}, undecoded(143, ["05"])),
                stream({143: "Not Implemented"}, undecoded(143, ["07"])),
            ], ["MISB file 1", "MISB file 2"]);
            expect(tableRow(lines, "Tags Sitrec does not decode (raw hex)")).not.toBeNull();
            expect(tableRow(lines, "Metadata Substream ID (tag 143)")).toEqual({cells: ["05", "07"], differs: true});

            const text = renderStreams([stream({}, undecoded(106, ["424c5545"]))], ["MISB file"]);
            expect(cells(text, "Stream Designator (tag 106)")).toEqual(['424c5545 "BLUE"']);
            const oneCharacter = renderStreams([stream({}, undecoded(129, ["35"]))], ["MISB file"]);
            expect(cells(oneCharacter, "Target ID (tag 129)")).toEqual(['35 "5"']);
            const unnamed = renderStreams([stream({}, undecoded(200, ["01"]))], ["MISB file"]);
            expect(cells(unnamed, "tag 200")).toEqual(["01"]);
        });

        test("lists the other streams of the TS once, as the streams share them", () => {
            const others = [
                {pid: 0x111, codec: "h264", streamType: "0x1b", name: null, packets: 200, bytes: 36000},
                {pid: 0x1001, codec: "private_data", streamType: "0xf1", name: "ARSX", packets: 1953, bytes: 352000},
            ];
            const first = stream({}, {...asyncIds, tsIds: {...asyncIds.tsIds, otherStreams: others}, sourceFile: "falls.ts"});
            const second = stream({}, {...syncIds, tsIds: {...syncIds.tsIds, otherStreams: others}, sourceFile: "falls.ts"});
            const lines = renderStreams([first, second], labels);
            expect(lines).toContain("OTHER STREAMS IN THE TS");
            expect(lines).toContain("  0x111 h264, stream_type 0x1b: 200 TS packets, 36,000 bytes");
            expect(lines).toContain('  0x1001 private_data "ARSX", stream_type 0xf1: 1,953 TS packets, 352,000 bytes');
            expect(lines.filter(line => line.includes("0x1001"))).toHaveLength(1);

            const hidden = renderStreams([first, second], labels, {hideNames: true}).join("\n");
            expect(hidden).not.toContain("ARSX");
            expect(hidden).toContain('0x1001 private_data "hidden"');
            expect(renderStreams([stream({}, syncIds)], ["KLV"]).join("\n")).not.toContain("OTHER STREAMS");
        });

        test("hides names on request, and keeps numbers, counts and the mark", () => {
            const named = stream({
                [MISB.UASDatalinkLSVersionNumber]: 5,
                [MISB.PlatformTailNumber]: "N97826",
                [MISB.MissionID]: "MISSION",
                [MISB.PlatformCallSign]: ["5", "ALPHA"],
                [MISB.ImageSourceSensor]: "EOW",
                [MISB.SecurityLocalSet]: [[{name: "Classification", value: "TEST//"}]],
            }, {
                ...syncIds,
                undecodedKLVTags: [
                    {tag: 106, name: null, count: 3, values: ["424c55452d35", "424c55452d37"]},
                    {tag: 143, name: null, count: 3, values: ["07"]},
                    {tag: 130, name: null, count: 3, values: ["00112233f4f5"]},
                    {tag: 131, name: null, count: 3, values: ["0005", "00ff00"]},
                ],
            });
            const other = stream({[MISB.ImageSourceSensor]: "IR"}, asyncIds);
            const first = {...noTiming, firstTimeMs: 1460571274819};
            const lines = renderStreams([named, other], labels, {hideNames: true, timing: [first, noTiming]});
            const text = lines.join("\n");
            for (const name of ["N97826", "MISSION", "ALPHA", "BLUE", "424c", "EOW", "TEST//", "KLV_SYNC", "2016-"]) {
                expect(text).not.toContain(name);
            }
            const cell = field => cells(lines, field)[0];
            expect(cell("PlatformTailNumber (tag 4)")).toBe("hidden");
            expect(cell("PlatformCallSign / TrackID (tag 59)")).toBe("hidden / hidden");
            expect(cell("SecurityLocalSet (tag 48)")).toBe("hidden");
            expect(cell("Name in the PMT")).toBe("hidden");
            expect(cell("First valid time (tag 2)")).toBe("hidden");
            expect(cell("Stream Designator (tag 106)")).toBe("hidden / hidden");
            expect(cell("UASDatalinkLSVersionNumber (tag 65)")).toBe("5");
            expect(cell("Metadata Substream ID (tag 143)")).toBe("07");
            expect(cell("tag 130")).toBe("hidden");
            expect(cell("tag 131")).toBe("0005 / hidden");
            expect(text).not.toContain("00112233f4f5");
            expect(cell("PID")).toBe("4098 (0x1002)");
            // Two different values that both print "hidden" still count as different.
            expect(tableRow(lines, "ImageSourceSensor (tag 11)")).toEqual({cells: ["hidden", "hidden"], differs: true});
            expect(renderStreams([named], ["KLV #0:3"]).join("\n")).toContain('"N97826"');
        });

        test("hides text that is all digits, as a tail number can be, and keeps a true number", () => {
            const text = renderStreams([stream({[MISB.MissionID]: "12345", [MISB.PlatformTailNumber]: "54321"})],
                ["MISB file"], {hideNames: true});
            expect(cells(text, "MissionID (tag 3)")).toEqual(["hidden"]);
            expect(cells(text, "PlatformTailNumber (tag 4)")).toEqual(["hidden"]);
            const numbers = renderStreams([stream({[MISB.UASDatalinkLSVersionNumber]: [7, 70000]})], ["MISB file"], {hideNames: true});
            expect(cells(numbers, "UASDatalinkLSVersionNumber (tag 65)")).toEqual(["7 / hidden"]);
            const single = renderStreams([stream({}, {undecodedKLVTags: [{tag: 129, name: null, count: 3, values: ["35"]}]})],
                ["MISB file"], {hideNames: true});
            expect(cells(single, "Target ID (tag 129)")).toEqual(["35"]);
        });

        test("has nothing to show when there are no real streams", () => {
            expect(renderStreams([], [])).toEqual([]);
        });

        test("reads the raw value of each undecoded tag from the packets", () => {
            const packet = (...items) => {
                const value = items.flat();
                return Uint8Array.from([...new Array(16).fill(0), value.length, ...value]);
            };
            const longTag = [0x81, 0x0F]; // BER-OID for tag 143
            const packets = [
                packet([65, 1, 7], [...longTag, 1, 5], [122, 2, 0xAB, 0xCD]),
                packet([65, 1, 7], [...longTag, 1, 7]),
                packet([...longTag, 1, 5]),
            ];
            expect(undecodedTagValues(packets, new Map([[143, null], [122, "Country Codes"]]))).toEqual([
                {tag: 122, name: "Country Codes", count: 1, values: ["abcd"]},
                {tag: 143, name: null, count: 3, values: ["05", "07"]},
            ]);
        });

        test("reads a long BER length around an undecoded tag", () => {
            const body = [10, 0x81, 197, ...new Array(197).fill(0x11), 0x63, 1, 9];
            const packet = Uint8Array.from([...new Array(16).fill(0), 0x81, body.length, ...body]);
            expect(undecodedTagValues([packet], new Map([[0x63, null]]))).toEqual([
                {tag: 0x63, name: null, count: 1, values: ["09"]},
            ]);
        });
    });

    describe("which stream the sitch time is on", () => {
        const start = 1460546075637;

        test("is the one stream near the start", () => {
            expect(streamsOnSitchClock([start, start + 7 * 3600e3], start)).toEqual([true, false]);
        });

        test("is only the nearer one of two streams seconds apart", () => {
            expect(streamsOnSitchClock([start + 800, start], start)).toEqual([false, true]);
        });

        test("is no stream when none is within a minute", () => {
            expect(streamsOnSitchClock([start + 61000, start + 7200000], start)).toEqual([false, false]);
        });

        test("is not known for a stream with no time", () => {
            expect(streamsOnSitchClock([null, start], start)).toEqual([null, true]);
            expect(streamsOnSitchClock([null], start)).toEqual([null]);
        });
    });

    describe("the stream to analyze", () => {
        const node = (hasPTS, misb = Object.assign([], {klvPid: 4096, sourceFile: "a.ts"})) => ({misb, hasRecordPTS: () => hasPTS});

        test("is the platform track's stream, even when another has PES PTS first", () => {
            const [first, second] = [node(true), node(true)];
            expect(chooseAnalyzedStream([first, second], second)).toEqual({node: second, reason: "platform track"});
        });

        test("is otherwise the first with PES PTS, and then the first", () => {
            const [noPTS, withPTS] = [node(false), node(true)];
            expect(chooseAnalyzedStream([noPTS, withPTS], null)).toEqual({node: withPTS, reason: "first stream with PES PTS"});
            expect(chooseAnalyzedStream([noPTS], null)).toEqual({node: noPTS, reason: "first stream"});
        });

        test("a derived track counts as its source stream", () => {
            const source = node(true);
            const derived = node(true, Object.assign([], {klvPid: 4096, sourceFile: "a.ts", derivedTrack: "center"}));
            const otherFile = node(true, Object.assign([], {klvPid: 4096, sourceFile: "b.ts"}));
            expect(streamOfDataNode(derived, [otherFile, source, derived])).toBe(source);
            expect(streamOfDataNode(source, [source])).toBe(source);
        });

        test("a track with no stream in the list, or a derived track with no PID, gives none", () => {
            const source = node(true);
            expect(streamOfDataNode(null, [source])).toBeNull();
            expect(streamOfDataNode(node(true), [source])).toBeNull();
            const csvA = node(false, Object.assign([], {}));
            const csvCenter = node(false, Object.assign([], {derivedTrack: "center"}));
            expect(streamOfDataNode(csvCenter, [csvA, csvCenter])).toBeNull();
        });
    });

    describe("tracks section", () => {
        const group = (label, mode, count, hasRecordPTS = true) => ({label, mode, count, hasRecordPTS});

        test("names the stream and the pairing of each track", () => {
            const lines = renderTracks([group("KLV #0:1 [0x1000], async", "pts", 3)], {realPTS: true, wrapped: false});
            expect(lines[0]).toBe("TRACKS (the stream that each track uses)");
            expect(lines).toContain("  KLV #0:1 [0x1000], async (hasRecordPTS yes): 3 track(s), PES PTS pairing");
            expect(lines).toContain("  Video frame PTS: real (honors dropped frames);  patching: not wrapped");
            const text = lines.join("\n");
            expect(text).toContain("Every track pairs by PES PTS");
            expect(text).not.toContain("synchronous");
        });

        test("warns when a track pairs by UnixTimeStamp", () => {
            const text = renderTracks([group("KLV", "uts", 1, false)], {realPTS: false, wrapped: true}).join("\n");
            expect(text).toContain("KLV (hasRecordPTS no): 1 track(s), UnixTimeStamp pairing (nominal rate)");
            expect(text).toContain("One or more tracks pair by UnixTimeStamp");
            expect(text).toContain("synthetic (uniform);  patching: WRAPPED");
        });
    });
});
