import {captureTraverseSource} from "../src/TraverseSource";
import {balloonDisplayName} from "../src/TraverseHypotheses";
import {reportOverviewCandidates, reportSourceHTML} from "../src/TraverseReport";

test("source identity follows the observations and freezes file details independently of the scene", () => {
    const header = ["TrackID", "Time", "SensorPositionX", "TruePositionX"];
    const metadata = {sensor: {sourceFile: {name: "flight.csv", relativePath: "runs/day/flight.csv", size: 42}}};
    const src = captureTraverseSource({sit: {name: "custom"}, files: {
        truth: {filename: "reference.csv"}, sensor: {data: {data: [header, ["a", "0", "1", "2"]]}}}, metadata,
        tracks: [{trackFileName: "truth", shortName: "Reference"},
            {trackFileName: "sensor", shortName: "Sensor", anglesNode: {id: "Angles"}}], cameraHeading: "Angles"});
    header[0] = "changed";
    metadata.sensor.sourceFile.relativePath = "changed";
    expect(src.title).toBe("flight.csv");
    expect(src.files[0]).toMatchObject({primary: true, relativePath: "runs/day/flight.csv", bytes: 42, rows: 1,
        columns: ["TrackID", "Time", "SensorPositionX", "TruePositionX"]});
    expect(reportSourceHTML(src)).toContain("No video is loaded");
});

test("source context distinguishes a loaded video from a recorded video parent and escapes names", () => {
    const src = captureTraverseSource({sit: {name: "custom", loadedFiles: {a: "tracks/a.csv"}},
        files: {a: {filename: "<a>.csv", tsParentFilename: "original.ts"}, b: {filename: "b.csv"}},
        tracks: [{trackFileName: "a"}, {trackFileName: "b"}], videos: [{fileName: "original.mp4"}]});
    const html = reportSourceHTML(src);
    expect(html).toContain("&lt;a&gt;.csv");
    expect(html).toContain("Extracted from original.ts");
    expect(html).toContain("a derivation from that video is not recorded");
    expect(src.files[0].relativePath).toBe("tracks/a.csv");
    expect(src.files[1].relativePath).toBeNull();
});

test("only an appreciable rise followed by fall inside the clip gets a possible-lantern label", () => {
    const p = {vRise: 2, vSink: 1, tBurn: 20, tauCool: 10};
    expect(balloonDisplayName(p, 120, "lifecycle")).toBe("Possible sky lantern (rise then fall)");
    expect(balloonDisplayName(p, 25, "lifecycle")).toBe("Balloon");
    expect(balloonDisplayName({...p, tBurn: 180}, 120, "lifecycle")).toBe("Balloon");
    expect(balloonDisplayName({...p, tBurn: -50}, 120, "lifecycle")).toBe("Balloon");
    expect(balloonDisplayName({...p, vRise: 0.001}, 120, "lifecycle")).toBe("Balloon");
    expect(balloonDisplayName(p, 120, "steady")).toBe("Balloon");
    expect(balloonDisplayName({}, 120)).toBe("Balloon");
});

test("overview keeps close leaders and excludes distant-direction placeholders", () => {
    const candidates = [
        {h: {atInfinity: true, track: [1]}, r: {coLeader: true}},
        {h: {name: "first", track: [2]}, r: {coLeader: true}},
        {h: {name: "second", track: [3]}, r: {coLeader: true}},
        {h: {name: "weak", track: [4]}, r: {coLeader: false}},
    ];
    expect(reportOverviewCandidates(candidates).map(x => x.h.name)).toEqual(["first", "second"]);
    expect(reportOverviewCandidates(candidates.slice(3)).map(x => x.h.name)).toEqual(["weak"]);
});
