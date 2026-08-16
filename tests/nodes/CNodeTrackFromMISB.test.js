jest.mock("json-stringify-pretty-compact", () => ({
    __esModule: true,
    default: JSON.stringify,
}));
// The production geoid loader fetches its grid over the network, which isn't
// available under Jest, so the synchronous accessor would return 0 and warn.
// Delegate to egm96-universal (bit-identical values) so the MSL->HAE conversion
// in recalculate() is exercised for real. Same pattern as tests/nodes/CNodeTrack.test.js.
jest.mock("../../src/EGM96Geoid", () => {
    const {meanSeaLevel} = require("egm96-universal");
    return {
        meanSeaLevelOffset: (lat, lon) => meanSeaLevel(Math.max(-90, Math.min(90, lat)), lon),
        ensureGeoidLoaded: () => Promise.resolve(),
    };
});

import {CNode} from "../../src/nodes/CNode";
import {CNodeManager} from "../../src/nodes/CNodeManager";
import {CNodeTrackFromMISB} from "../../src/nodes/CNodeTrackFromMISB";
import {MISB, MISBFields} from "../../src/MISBFields";
import {setGlobalDateTimeNode, setNodeMan, setSit} from "../../src/Globals";

class TestDateTimeNode extends CNode {
    constructor(startTimeMs) {
        super({id: "dateTimeStart"});
        this.startTimeMs = startTimeMs;
    }

    getStartTimeValue() {
        return this.startTimeMs;
    }

    getValueFrame() {
        return this.startTimeMs;
    }
}

class TestMISBDataNode extends CNode {
    constructor(misb, options = {}) {
        super({id: "trackData"});
        this.misb = misb;
        this.useAGL = false;
        this._hasRecordPTS = options.hasRecordPTS ?? false;
    }

    selectSourceColumns() {}
    getLat(i) { return this.misb[i][MISB.SensorLatitude]; }
    getLon(i) { return this.misb[i][MISB.SensorLongitude]; }
    getRawAlt(i) { return this.misb[i][MISB.SensorTrueAltitude]; }
    getTime(i) { return this.misb[i][MISB.UnixTimeStamp]; }
    isValid(i) { return this.misb[i] !== undefined; }
    isTerrainDependent() { return false; }
    isAGLLockActive() { return false; }
    hasRecordPTS() { return this._hasRecordPTS; }
    adjustAlt(alt) { return alt; }
    needsGeoidToHAE() { return true; } // MSL source: pipeline adds geoid N (0 in tests, grid not loaded)
}

function makeMISBRow(timeMs, lat, lon, alt = 1000) {
    const row = new Array(MISBFields).fill(null);
    row[MISB.UnixTimeStamp] = timeMs;
    row[MISB.SensorLatitude] = lat;
    row[MISB.SensorLongitude] = lon;
    row[MISB.SensorTrueAltitude] = alt;
    return row;
}

describe("CNodeTrackFromMISB timing source selection", () => {
    beforeEach(() => {
        const nodeMan = new CNodeManager();
        setNodeMan(nodeMan);
        setSit({
            frames: 4,
            fps: 1,
            simSpeed: 1,
            lat: 0,
            lon: 0,
            isCustom: true,
            name: "custom",
        });
        const dateTimeNode = new TestDateTimeNode(1_000_000);
        setGlobalDateTimeNode(dateTimeNode);

        nodeMan.add("video", {
            videoData: {
                framePTSus: [0, 1_000_000, 3_000_000, 6_000_000],
                hasRealFramePTS: () => true,
                getFrameTimeMs: frame => [0, 1000, 3000, 6000][frame] ?? null,
            },
        });
    });

    test("ignores video PTS for MISB-shaped tracks without per-record PES PTS", () => {
        const start = 1_000_000;
        new TestMISBDataNode([
            makeMISBRow(start, 0, 0),
            makeMISBRow(start + 1000, 0, 1),
            makeMISBRow(start + 2000, 0, 2),
            makeMISBRow(start + 3000, 0, 3),
        ]);

        const track = new CNodeTrackFromMISB({
            id: "track",
            misb: "trackData",
            columns: ["SensorLatitude", "SensorLongitude", "SensorTrueAltitude", "AltitudeAGL"],
        });

        expect(track.array[1].lla[1]).toBeCloseTo(1, 6);
        expect(track.array[2].lla[1]).toBeCloseTo(2, 6);
    });

    test("preserves PES PTS pairing when MISB records have per-record PTS", () => {
        const start = 1_000_000;
        const misb = [
            makeMISBRow(start, 0, 0),
            makeMISBRow(start + 10_000, 0, 10),
            makeMISBRow(start + 20_000, 0, 20),
            makeMISBRow(start + 30_000, 0, 30),
        ];
        misb.pesPTSus = [0, 1_000_000, 3_000_000, 6_000_000];
        new TestMISBDataNode(misb, {hasRecordPTS: true});

        const track = new CNodeTrackFromMISB({
            id: "track",
            misb: "trackData",
            columns: ["SensorLatitude", "SensorLongitude", "SensorTrueAltitude", "AltitudeAGL"],
        });

        expect(track.array[1].lla[1]).toBeCloseTo(10, 6);
        expect(track.array[2].lla[1]).toBeCloseTo(20, 6);
    });
});
