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
import {CNodeMISBDataTrack} from "../../src/nodes/CNodeMISBData";
import {MISB, MISBFields} from "../../src/MISBFields";
import {setGlobalDateTimeNode, setNodeMan, setSit} from "../../src/Globals";
import {LLAToECEF, ECEFToLLAVD_radii} from "../../src/LLA-ECEF-ENU";

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
    getPosition(i) { return LLAToECEF(this.getLat(i), this.getLon(i), this.getRawAlt(i)); }
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

    test("recorded fireballs interpolate in ECEF across the dateline and hold endpoints", () => {
        const data = new TestMISBDataNode([
            makeMISBRow(1_001_000, 0, 179.99, 100000),
            makeMISBRow(1_003_000, 0, -179.99, 80000),
        ]);
        data.fireballObservedInterval = true;
        const track = new CNodeTrackFromMISB({id: "fireball", misb: "trackData"});
        const a=data.getPosition(0), b=data.getPosition(1);
        expect(track.array[0].position.distanceTo(a)).toBeLessThan(0.001);
        expect(track.array[2].position.distanceTo(a.clone().lerp(b,0.5))).toBeLessThan(0.001);
        expect(Math.abs(ECEFToLLAVD_radii(track.array[2].position).y)).toBeCloseTo(180,3);
        expect(track.array[3].position.distanceTo(b)).toBeLessThan(0.001);
    });

    test("validated fireball endpoints at zero coordinates remain valid and use HAE", () => {
        const data = new CNodeMISBDataTrack({id: 'zeroFireball', misb: [
            makeMISBRow(1_001_000, 0, 0, 100000),
            makeMISBRow(1_003_000, 0.1, 0.1, 80000),
        ], fireballObservedInterval: true, altitudeIsHAE: true});
        expect(data.isValid(0)).toBe(true);
        expect(data._isValidBasic(0)).toBe(true);
        expect(data.getAltHAE(0)).toBe(100000);
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

describe("CNodeTrackFromMISB frame clock", () => {
    // Regression for the accumulated, truncated frame clock. Rows every 100 ms
    // resampled at 30 fps put every row exactly on a frame (row i = frame 3i),
    // but `frameTime += 1/30` summed 300 times is 9.999999999999975 s and
    // Math.floor(frameTime*1000) made that 9999 ms, so the row stamped 10.000 s
    // was not selected until frame 301. The angle columns are keyframed at the
    // frame where the row changes, so every sightline direction ran a frame
    // behind its position. The time is now computed directly from the frame
    // index and not truncated.
    beforeEach(() => {
        const nodeMan = new CNodeManager();
        setNodeMan(nodeMan);
        setSit({
            frames: 331,
            fps: 30,
            simSpeed: 1,
            lat: 0,
            lon: 0,
            isCustom: true,
            name: "custom",
        });
        setGlobalDateTimeNode(new TestDateTimeNode(1_000_000));
    });

    test("a row stamped exactly on a frame is that frame's row, with fraction 0", () => {
        const start = 1_000_000;
        const misb = [];
        for (let i = 0; i <= 111; i++) misb.push(makeMISBRow(start + i * 100, 0, i * 0.001));
        new TestMISBDataNode(misb);

        const track = new CNodeTrackFromMISB({
            id: "track",
            misb: "trackData",
            columns: ["SensorLatitude", "SensorLongitude", "SensorTrueAltitude", "AltitudeAGL"],
        });

        // Frames 3, 300 and 330 are rows 1, 100 and 110 exactly.
        for (const [frame, row] of [[3, 1], [300, 100], [330, 110]]) {
            expect(track.array[frame].misbRow).toBe(misb[row]);
            expect(track.array[frame].misbNextRow).toBe(misb[row + 1]);
            expect(track.array[frame].misbFraction).toBeCloseTo(0, 9);
            expect(track.array[frame].lla[1]).toBeCloseTo(row * 0.001, 9);
        }
        // A frame between rows carries the bracketing pair and its true fraction.
        expect(track.array[301].misbRow).toBe(misb[100]);
        expect(track.array[301].misbNextRow).toBe(misb[101]);
        expect(track.array[301].misbFraction).toBeCloseTo(1 / 3, 9);
    });
});
