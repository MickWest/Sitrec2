jest.mock("json-stringify-pretty-compact", () => ({__esModule: true, default: JSON.stringify}));
jest.mock("../../src/EGM96Geoid", () => ({
    meanSeaLevelOffset: () => 0,
    ensureGeoidLoaded: () => Promise.resolve(),
}));

import {Vector3} from "three";
import {CNode} from "../../src/nodes/CNode";
import {CNodeManager} from "../../src/nodes/CNodeManager";
import {CNodeMISBDataTrack, makeLOSNodeFromTrackAngles} from "../../src/nodes/CNodeMISBData";
import {CNodeTrackFromMISB} from "../../src/nodes/CNodeTrackFromMISB";
import {CTrackFileMISB} from "../../src/TrackFiles/CTrackFileMISB";
import {MISB, MISBFields} from "../../src/MISBFields";
import {Globals, NodeMan, setGlobalDateTimeNode, setNodeMan, setSit} from "../../src/Globals";
import {ExpandMISBKeyframes} from "../../src/utils";

const startTime = 1700000000000;
class Clock extends CNode {
    getStartTimeValue() { return startTime; }
}

function rows() {
    return Array.from({length: 3}, (_, i) => {
        const row = new Array(MISBFields).fill(null);
        Object.assign(row, {
            [MISB.UnixTimeStamp]: startTime + i * 1000,
            [MISB.SensorLatitude]: 37, [MISB.SensorLongitude]: -120,
            [MISB.SensorTrueAltitude]: 1000, [MISB.SensorVerticalFieldofView]: 8,
            [MISB.PlatformHeadingAngle]: 0,
            [MISB.PlatformPitchAngleFull]: 45, [MISB.PlatformRollAngleFull]: 0,
            [MISB.SensorRelativeAzimuthAngle]: 0, [MISB.SensorRelativeElevationAngle]: 0,
            [MISB.SensorRelativeRollAngle]: 0,
        });
        return row;
    });
}

function importTrack(misb, options = {}) {
    const file = new CTrackFileMISB(misb);
    new CNodeMISBDataTrack({id: "source", misb: file.toMISB()});
    new CNodeTrackFromMISB({id: "cameraTrack", misb: "source"});
    const los = makeLOSNodeFromTrackAngles("cameraTrack", options);
    return {file, los};
}

beforeEach(() => {
    setNodeMan(new CNodeManager());
    setSit({frames: 5, fps: 2, simSpeed: 1, lat: 37, lon: -120, isCustom: true, name: "custom"});
    Globals.equatorRadius = Globals.polarRadius = 6378137;
    setGlobalDateTimeNode(new Clock({id: "dateTimeStart"}));
});

test("a full-only attitude file builds the recorded sightline through the import graph", () => {
    const {file, los} = importTrack(rows());
    expect(file._hasAngles()).toBe(true);
    // Independent physical result: north-facing platform, nose 45 degrees up.
    const lat = 37 * Math.PI / 180, lon = -120 * Math.PI / 180;
    const north = new Vector3(-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat));
    const up = new Vector3(Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat));
    const expected = north.add(up).normalize();
    expect(los.v(0).heading.distanceTo(expected)).toBeLessThan(1e-12);
    expect(NodeMan.get("cameraTrackplatformPitch").v(0)).toBe(45);
});

test("full attitude takes priority per row with legacy fallback for an unknown full value", () => {
    const misb = rows();
    [45, null, 15].forEach((pitch, i) => {
        misb[i][MISB.PlatformPitchAngleFull] = pitch;
        misb[i][MISB.PlatformPitchAngle] = i === 1 ? 30 : 5;
        misb[i][MISB.PlatformRollAngleFull] = i === 1 ? null : -40 + i * 25;
        misb[i][MISB.PlatformRollAngle] = i === 1 ? 20 : 2;
    });
    const original = misb.map(row => row.slice());
    importTrack(misb);
    expect(NodeMan.get("cameraTrackplatformPitch").array).toEqual([45, 37.5, 30, 22.5, 15]);
    expect(NodeMan.get("cameraTrackplatformRoll").array).toEqual([-40, -10, 20, 15, 10]);
    expect(misb).toEqual(original);
});

test("explicit legacy attitude column overrides retain their selected values", () => {
    const misb = rows();
    misb.forEach(row => {
        row[MISB.PlatformPitchAngle] = 5;
        row[MISB.PlatformRollAngle] = 2;
    });
    importTrack(misb, {platformPitch: MISB.PlatformPitchAngle, platformRoll: MISB.PlatformRollAngle});
    expect(NodeMan.get("cameraTrackplatformPitch").array).toEqual([5, 5, 5, 5, 5]);
    expect(NodeMan.get("cameraTrackplatformRoll").array).toEqual([2, 2, 2, 2, 2]);
});

test("priority columns also work on the legacy keyframe expansion path", () => {
    const misb = rows();
    [40, null, 10].forEach((pitch, i) => {
        misb[i][MISB.PlatformPitchAngleFull] = pitch;
        misb[i][MISB.PlatformPitchAngle] = i === 1 ? 20 : 1;
    });
    const entries = [misb[0], misb[0], misb[1], misb[1], misb[2]].map(misbRow => ({misbRow}));
    expect(ExpandMISBKeyframes(entries, [MISB.PlatformPitchAngleFull, MISB.PlatformPitchAngle], true))
        .toEqual([40, 30, 20, 15, 10]);
});
