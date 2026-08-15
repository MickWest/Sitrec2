/**
 * @jest-environment jsdom
 *
 * Regression test: exportMISBCompliantCSV(inspect=true) must emit only the
 * header plus ONE example data row, and must do only one frame's worth of the
 * expensive per-frame work. makeExportButton (CFileManager) calls the exporter
 * in inspect mode at node CREATION time purely to build a tooltip; computing
 * every frame there ran the per-frame ground raycast (frameCenterGroundPoint)
 * during sitch load — ~10 s of frozen UI on a 20,000-frame save. A real export
 * (inspect=false) must still emit every frame, and the inspect example row must
 * be byte-identical to the real export's first row.
 */

jest.mock("../src/showError", () => ({showError: jest.fn()}));
// The production geoid loader fetches its grid over the network, which isn't
// available under Jest, so the synchronous accessor would return 0 and warn.
// Delegate to egm96-universal (bit-identical values) so the exporter's HAE->MSL
// conversion is exercised for real. Same pattern as tests/nodes/CNodeTrack.test.js.
jest.mock("../src/EGM96Geoid", () => {
    const {meanSeaLevel} = require("egm96-universal");
    return {
        meanSeaLevelOffset: (lat, lon) => meanSeaLevel(Math.max(-90, Math.min(90, lat)), lon),
        ensureGeoidLoaded: () => Promise.resolve(),
    };
});
jest.mock("file-saver", () => ({saveAs: jest.fn()}));
jest.mock("../src/Globals", () => {
    const actual = jest.requireActual("../src/Globals");
    return {
        ...actual,
        // The exporter only needs frame->time mapping, fps, and (absent) nodes.
        GlobalDateTimeNode: {frameToMS: (f) => 1700000000000 + f * 33},
        NodeMan: {get: () => null, exists: () => false},
        Sit: {fps: 30, name: "test"},
    };
});

import {Vector3} from "three";
import {CNodeTrack} from "../src/nodes/CNodeTrack";
import {saveAs} from "file-saver";

const FRAMES = 6;

// LOS-shaped track: frames carry a position and a heading VECTOR, which is
// what routes the export through the per-frame frameCenterGroundPoint raycast
// (the expensive path this test exists to bound). The raycast itself is
// replaced with a spy — the contract under test is how often it is called.
function makeLOSTrack() {
    return {
        id: "inspectTest",
        frames: FRAMES,
        v(f) {
            return {
                position: new Vector3(6378137 + f, 0, 0),
                heading: new Vector3(0, 0, -1),
            };
        },
        frameCenterGroundPoint: jest.fn(() => null),
        resolveTruthTargetTrack: () => null,
    };
}

async function blobText(blob) {
    // jsdom's Blob has no .text(); go through FileReader
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsText(blob);
    });
}

describe("exportMISBCompliantCSV inspect mode", () => {
    test("inspect=true does ONE frame of work and emits header + one example row", () => {
        const track = makeLOSTrack();
        const result = CNodeTrack.prototype.exportMISBCompliantCSV.call(track, true);
        expect(result.desc).toBe("MISB Compliant CSV");
        // the expensive per-frame ground raycast ran exactly once, not FRAMES times
        expect(track.frameCenterGroundPoint).toHaveBeenCalledTimes(1);
        const lines = result.csv.trimEnd().split("\n");
        expect(lines.length).toBe(2);
        expect(lines[0].startsWith("UnixTimeStamp,")).toBe(true);
        expect(lines[1].startsWith("1700000000000,")).toBe(true);
    });

    test("inspect=true on an empty track emits just the header", () => {
        const empty = {id: "empty", frames: 0, v: () => null};
        const result = CNodeTrack.prototype.exportMISBCompliantCSV.call(empty, true);
        expect(result.csv.trimEnd().split("\n").length).toBe(1);
    });

    test("real export emits every frame; inspect row is byte-identical to its first row", async () => {
        const inspected = CNodeTrack.prototype.exportMISBCompliantCSV.call(makeLOSTrack(), true);

        const track = makeLOSTrack();
        CNodeTrack.prototype.exportMISBCompliantCSV.call(track, false);
        expect(track.frameCenterGroundPoint).toHaveBeenCalledTimes(FRAMES);
        expect(saveAs).toHaveBeenCalledTimes(1);
        const text = await blobText(saveAs.mock.calls[0][0]);

        const fullLines = text.trimEnd().split("\n");
        expect(fullLines.length).toBe(1 + FRAMES);
        // header + first data row of the real export === the inspect example
        expect(fullLines.slice(0, 2).join("\n") + "\n").toBe(inspected.csv);
    });
});
