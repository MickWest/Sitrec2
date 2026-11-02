jest.mock("json-stringify-pretty-compact", () => ({__esModule: true, default: JSON.stringify}));
jest.mock("../src/EGM96Geoid", () => ({
    meanSeaLevelOffset: () => 0,
    ensureGeoidLoaded: () => Promise.resolve(),
}));

import {CNodeMISBDataTrack} from "../src/nodes/CNodeMISBData";
import {CNodeManager} from "../src/nodes/CNodeManager";
import {MISB, MISBFields} from "../src/MISBFields";
import {NodeMan, setFileManager, setNodeMan, setSit} from "../src/Globals";

// The deep analysis of generateTimingAnalysis, on the real method. It has to say
// only what it measured, so these tests are on its words.
const PERIOD_MS = 40;
const FRAME_US = 33366;

function dataNode(records, {pesOffsetUs = null, gapAt = null} = {}) {
    const misb = [];
    let timeUs = 1500000000000000;
    for (let i = 0; i < records; i++) {
        if (i === gapAt) timeUs += 5000000;
        const row = new Array(MISBFields).fill(null);
        row[MISB.UnixTimeStamp] = timeUs;
        row[MISB.SensorLatitude] = 34 + i * 1e-5;
        row[MISB.SensorLongitude] = -118;
        row[MISB.SensorTrueAltitude] = 3000;
        misb.push(row);
        timeUs += PERIOD_MS * 1000;
    }
    if (pesOffsetUs !== null) misb.pesPTSus = misb.map((row, i) => pesOffsetUs + i * PERIOD_MS * 1000);
    const node = Object.create(CNodeMISBDataTrack.prototype);
    node.misb = misb;
    node.isValid = () => true;
    return node;
}

function reportOf(node) {
    return node.generateTimingAnalysis();
}

function withVideo(frames, originUs = 49773814633) {
    const framePTSus = Array.from({length: frames}, (_, i) => originUs + i * FRAME_US);
    const video = {videoData: {framePTSus}};
    jest.spyOn(NodeMan, "get").mockImplementation(id => (id === "video" ? video : null));
}

beforeAll(() => {
    setNodeMan(new CNodeManager());
    setFileManager({list: {}, exists: () => false, iterate: () => {}});
    setSit({fps: 30});
});
afterEach(() => jest.restoreAllMocks());

describe("the report headline", () => {
    test("with PES PTS, it gives the measured comparison and not a claim of alignment", () => {
        withVideo(1200);
        const report = dataNode(1000, {pesOffsetUs: 14344}).generateTimingAnalysis();
        expect(report).toContain("✓ No gaps or span mismatch found.");
        expect(report).toContain("first record 14.344 ms from the first frame");
        expect(report).not.toContain("well-aligned");
    });

    test("without PES PTS, it says that the times were not compared", () => {
        withVideo(1200);
        const report = dataNode(1000).generateTimingAnalysis();
        expect(report).toContain("✓ No gaps or span mismatch found.");
        expect(report).toContain("KLV and video times were not compared");
    });

    test("a gap takes the place of the tick", () => {
        withVideo(1200);
        const report = dataNode(1000, {gapAt: 500}).generateTimingAnalysis();
        expect(report).not.toContain("No gaps or span mismatch found");
        expect(report).toContain("discrete gap");
    });
});

describe("records that repeat", () => {
    // The metadata updates every 30 ms, and each record is repeated until it changes.
    function heldStream(records) {
        const node = dataNode(records);
        node.misb.forEach((row, i) => {
            row[MISB.UnixTimeStamp] = 1500000000000000 + Math.floor(i / 2) * 2 * 30000;
        });
        return node;
    }

    test("are not reported as clock scatter in any section", () => {
        withVideo(900);
        const report = reportOf(heldStream(1000));
        expect(report).toContain("500 of 1000 records repeat the previous time");
        expect(report).toContain("the figures below leave the repeats out");
        for (const text of ["scatter widely", "scattered", "retransmitted", "gap clusters"]) expect(report).not.toContain(text);
    });

    test("every section gives the time between new values, and says that the repeats are left out", () => {
        withVideo(900);
        const report = reportOf(heldStream(1000));
        expect(report).toContain("Repeated times:                  500 (left out of the figures below)");
        expect(report).toContain("Mean interval:                   60.");
        expect(report).toContain("(<5%, tight)");
        expect(report).toContain("Verdict:                         Uniform");
        expect(report).toContain("500 repeated times, the held values in SUMMARY. No reversed times.");
    });

    test("a reversed time is listed, also in a stream that holds its values", () => {
        withVideo(900);
        const node = heldStream(1000);
        node.misb[700][MISB.UnixTimeStamp] -= 80000;
        const report = reportOf(node);
        expect(report).toContain("A reversed time is out of order");
        expect(report).not.toContain("gaps above");
    });
});

describe("the report headline with no video", () => {
    test("says nothing about the frame rate", () => {
        jest.spyOn(NodeMan, "get").mockImplementation(() => null);
        const report = reportOf(dataNode(100));
        expect(report).toContain("Video data not yet available");
        expect(report).not.toContain("variable frame rate");
        expect(report).not.toContain("Variable-rate video");
    });
});

describe("the video frame rate", () => {
    // Frame times at a steady rate, with some frames dropped.
    function withFrames(frames, droppedAfter) {
        let timeUs = 49773814633;
        const framePTSus = Array.from({length: frames}, (_, i) => {
            const ptsUs = timeUs;
            timeUs += droppedAfter.includes(i) ? 2 * FRAME_US : FRAME_US;
            return ptsUs;
        });
        jest.spyOn(NodeMan, "get").mockImplementation(id => (id === "video" ? {videoData: {framePTSus}} : null));
    }

    test("one dropped frame is not a variable frame rate", () => {
        withFrames(1200, [62]);
        const report = reportOf(dataNode(1000));
        expect(report).not.toContain("ariable");
        expect(report).toContain("Video has a constant frame rate, except for 1 interval.");
        expect(report).toContain("Constant frame rate, except for 1 of 1199 intervals");
    });

    test("frames that vary all through the video are a variable frame rate", () => {
        const droppedAfter = Array.from({length: 120}, (_, i) => i * 10);
        withFrames(1200, droppedAfter);
        const report = reportOf(dataNode(1000));
        expect(report).toContain("Video has variable frame rate: 120 of 1199 intervals are off the median.");
        expect(report).toContain("Variable frame rate — 120 of 1199 intervals off the median of 33.366 ms");
        expect(report).toContain("Variable-rate video");
    });

    test("a clean video is constant, with no note", () => {
        withVideo(1200);
        const report = reportOf(dataNode(1000));
        expect(report).toContain("Verdict:                         Constant frame rate (CFR)");
        expect(report).not.toContain("except for");
    });
});

describe("PES PTS that is not clean", () => {
    function scattered() {
        const node = dataNode(1000, {pesOffsetUs: 0});
        node.misb.forEach((row, i) => { row[MISB.UnixTimeStamp] += (i % 2) * 20000; });
        node.misb.pesPTSus = node.misb.pesPTSus.map((us, i) => us + (i % 3) * 30000);
        return node;
    }

    test("is not called clean or uniform", () => {
        withVideo(1200);
        const report = reportOf(scattered());
        expect(report).toContain("scatter widely");
        expect(report).not.toContain("PES PTS is clean");
        expect(report).not.toContain("PES PTS is uniform");
    });

    test("clean PES PTS under scattered tag 2 is called uniform in the notes", () => {
        withVideo(1200);
        const node = dataNode(1000, {pesOffsetUs: 0});
        node.misb.forEach((row, i) => { row[MISB.UnixTimeStamp] += (i % 2) * 20000; });
        const report = reportOf(node);
        expect(report).toContain("PES PTS is clean");
        expect(report).toContain("scatter is high but PES PTS is uniform");
        expect(report).toContain("the difference\n  is in the tag 2 values");
    });
});

describe("PES PTS with no value in it", () => {
    test("is a stream with no PES PTS, and does not stop the report", () => {
        withVideo(1200);
        const node = dataNode(1000);
        node.misb.pesPTSus = node.misb.map(() => null);
        const report = reportOf(node);
        expect(report).toContain("KLV and video times were not compared");
        expect(report).toContain("Non-null entries:                0 / 1000");
        expect(report).not.toContain("KLV PES PTS TIMING");
        expect(report).not.toContain("Infinity");
    });
});

describe("the report body", () => {
    test("estimates no clock skew and no drift from a pairing by position", () => {
        withVideo(1200);
        const report = dataNode(1000, {pesOffsetUs: 0, gapAt: 500}).generateTimingAnalysis();
        for (const text of ["DRIFT", "Linear clock skew", "RECOMMENDATIONS", "synchronous-mode", "PES span / tag 2 span"]) {
            expect(report).not.toContain(text);
        }
        expect(report).toContain("NOTES");
    });

    test("gives no fps from the KLV, even when the two clocks run at different rates", () => {
        withVideo(1000);
        const node = dataNode(1000, {pesOffsetUs: 0});
        // No gaps, no scatter, and the PES span is 10% shorter than the tag 2 span.
        node.misb.pesPTSus = node.misb.pesPTSus.map(us => us * 0.9);
        const report = reportOf(node);
        for (const text of ["Real-time fps", "real fps", "wrong cadence", "Recommended Sit.fps", "Set Sit.fps", "Consider applying"]) {
            expect(report).not.toContain(text);
        }
    });

    test("does not say why the spans differ", () => {
        withVideo(600);
        const report = reportOf(dataNode(1000));
        expect(report).toContain("KLV span and video span differ");
        expect(report).toContain("Span mismatch with uniform KLV. This report cannot say why.");
        expect(report).not.toContain("clock-rate error");
    });

    test("the gap section does not guess why a field changed at a gap", () => {
        withVideo(1200);
        const node = dataNode(1000, {gapAt: 500});
        node.misb.forEach((row, i) => { row[MISB.SlantRange] = i < 500 ? 1000 : 5000; });
        const report = reportOf(node);
        expect(report).toContain("SlantRange changes at 1 of 1 gaps.");
        for (const text of ["user's report", "likely", "emitter"]) expect(report).not.toContain(text);
    });

    // A field with its value before and after the gap. Each one is a name, a place or a
    // time, and each reached the report by a different path in the code.
    test.each([
        ["MissionID", "MISSION-ALPHA", "MISSION-BRAVO"],
        ["MissionID", "12345", "54321"],
        ["PlatformTailNumber", "N12345", "N54321"],
        ["PlatformDesignation", "MQ-9 Alpha", "MQ-9 Bravo"],
        ["ImageSourceSensor", "SENSOR-ALPHA", "SENSOR-BRAVO"],
        ["ImageCoordinateSystem", "Geodetic WGS84", "Geodetic Other"],
        ["PlatformCallSign", "HAWK01", "HAWK02"],
        ["SensorLatitude", 34.5678, 35.6789],
        ["SensorTrueAltitude", 4321.5, 8765.5],
        ["FrameCenterElevation", 4321.5, 8765.5],
        ["TargetLocationElevation", 4321.5, 8765.5],
        ["DensityAltitude", 4321.5, 8765.5],
        ["EventStartTime", 1500000000000000, 900000000000000],
        ["LaserPRFCode", 1111, 2222],
    ])("prints only that %s changed at a gap, for %s", (field, before, after) => {
        withVideo(1200);
        const node = dataNode(1000, {gapAt: 500});
        node.misb.forEach((row, i) => { row[MISB[field]] = i < 500 ? before : after; });
        const report = reportOf(node);
        const printed = [before, after].flatMap(value => [String(value), Number(value).toFixed(1), Number(value).toFixed(3),
            Number(value).toExponential(3)]).filter(text => text !== "NaN");
        for (const text of printed) expect(report).not.toContain(text);
        // Tag 59 has two names, and the report uses the second.
        expect(report).toContain(`${field === "PlatformCallSign" ? "TrackID" : field}: changed`);
    });

    test("says that a field appeared or went at a gap, and prints no value", () => {
        withVideo(1200);
        const node = dataNode(1000, {gapAt: 500});
        node.misb.forEach((row, i) => {
            row[MISB.MissionID] = i < 500 ? null : "MISSION-BRAVO";
            row[MISB.PlatformTailNumber] = i < 500 ? "N12345" : null;
        });
        const report = reportOf(node);
        expect(report).toContain("MissionID: appeared");
        expect(report).toContain("PlatformTailNumber: gone");
    });

    test("still prints the values that name nothing at a gap", () => {
        withVideo(1200);
        const node = dataNode(1000, {gapAt: 500});
        node.misb.forEach((row, i) => {
            row[MISB.SensorFieldofViewName] = i < 500 ? 1 : 3;
            row[MISB.SensorRelativeAzimuthAngle] = i < 500 ? 10 : 50;
        });
        const report = reportOf(node);
        expect(report).toContain("Narrow → Wide");
        expect(report).toContain("10.000 → 50.000");
    });

    test("names no absolute time, as this part of the report is meant to be anonymous", () => {
        withVideo(1200);
        const report = dataNode(1000, {pesOffsetUs: 0}).generateTimingAnalysis();
        expect(report).not.toContain("2017-");
        expect(report).not.toContain("49773814633");
    });
});
