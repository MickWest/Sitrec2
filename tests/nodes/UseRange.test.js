jest.mock("json-stringify-pretty-compact", () => ({__esModule: true, default: JSON.stringify}));

import {Vector3} from "three";
import {MISB, MISBFields} from "../../src/MISBFields";
import {misbRangeSources, rangeSamplesForFrames, sampleMISBRange} from "../../src/MISBRange";
import {CNodeArray} from "../../src/nodes/CNodeArray";
import {CNodeLOSTraverseUseRange} from "../../src/nodes/CNodeLOSTraverseUseRange";
import {CNodeManager} from "../../src/nodes/CNodeManager";
import {EventManager} from "../../src/CEventManager";
import {setFileManager, setNodeMan, setSit, setTrackManager} from "../../src/Globals";

function row(slant, ground = null) {
    const result = new Array(MISBFields).fill(null);
    result[MISB.SlantRange] = slant;
    result[MISB.GroundRange] = ground;
    return result;
}

describe("MISB range sampling", () => {
    test("discovers both populated standard range columns, including sparse columns and zero", () => {
        const tracks = [{menuText: "Camera", trackDataNode: {id: "data", misb: [row(null), row(0, 200)]}, trackNode: {}}];
        expect(misbRangeSources(tracks).map(s => [s.label, s.column])).toEqual([
            ["Camera / Slant Range (m)", MISB.SlantRange],
            ["Camera / Ground Range (m)", MISB.GroundRange],
        ]);
        expect(misbRangeSources([{trackNode: {}, trackDataNode: {id: "empty", misb: [row(null), row(-1, Infinity), row("200")]}}])).toEqual([]);
    });

    test("uses timed MISB brackets, linear metres and endpoint holds", () => {
        const entry = {misbRow: row(7485), misbNextRow: row(9135), misbFraction: 0.25};
        expect(sampleMISBRange(entry, MISB.SlantRange)).toEqual({range: 7897.5, held: false});
        expect(sampleMISBRange({...entry, misbFraction: 0}, MISB.SlantRange).range).toBe(7485);
        expect(sampleMISBRange({...entry, misbFraction: 1}, MISB.SlantRange).range).toBe(9135);
        expect(sampleMISBRange({...entry, misbFraction: -10}, MISB.SlantRange)).toEqual({range: 7485, held: true});
        expect(sampleMISBRange({...entry, misbFraction: 10}, MISB.SlantRange)).toEqual({range: 9135, held: true});
    });

    test("does not turn blanks into zero or smooth recorded jumps", () => {
        const entries = [null, 7485, null, 9135, -1, Infinity, 0].map(value => ({misbRow: row(value)}));
        const samples = rangeSamplesForFrames(entries, MISB.SlantRange, entries.length, 7485);
        expect(samples.map(s => s.range)).toEqual([7485, 7485, 7485, 9135, 9135, 9135, 0]);
        expect(samples.map(s => s.held)).toEqual([true, false, true, false, true, true, false]);
    });

    test("holds the known source value if this scene window contains only missing records", () => {
        expect(rangeSamplesForFrames([{misbRow: row(null)}], MISB.SlantRange, 1, 100))
            .toEqual([{range: 100, held: true}]);
    });
});

describe("Use Range traverse", () => {
    let tracks;
    let los;
    beforeEach(() => {
        EventManager.removeAll();
        setNodeMan(new CNodeManager());
        setFileManager({removeExportButton: jest.fn()});
        setSit({frames: 3, fps: 24});
        tracks = [];
        setTrackManager({iterate: callback => tracks.forEach(t => callback(t.trackDataNode.id, t))});
        los = new CNodeArray({id: "LOS", array: [
            {position: new Vector3(10, 20, 30), heading: new Vector3(2, 0, 0)},
            {position: new Vector3(20, 30, 40), heading: new Vector3(0, 1, 0)},
            {position: new Vector3(30, 40, 50), heading: new Vector3(0, 0, 1)},
        ]});
    });
    afterEach(() => EventManager.removeAll());

    function addTrack(name, rows) {
        const track = {
            menuText: name,
            trackDataNode: {id: `TrackData_${name}`, misb: rows},
            trackNode: new CNodeArray({id: `Track_${name}`, array: rows.map(r => ({misbRow: r}))}),
        };
        tracks.push(track);
        EventManager.dispatchEvent("tracksChanged");
        return track;
    }

    test("applies metres along the current LOS without changing the camera or source vectors", () => {
        addTrack("Nellis", [row(7485), row(9000), row(9135)]);
        const traverse = new CNodeLOSTraverseUseRange({id: "range", LOS: los}, null);
        expect(traverse.p(0).toArray()).toEqual([7495, 20, 30]);
        expect(traverse.p(1).toArray()).toEqual([20, 9030, 40]);
        expect(traverse.p(2).toArray()).toEqual([30, 40, 9185]);
        expect(traverse.v(2).range).toBe(9135);
        expect(los.v(0).position.toArray()).toEqual([10, 20, 30]);
        expect(los.v(0).heading.toArray()).toEqual([2, 0, 0]);
    });

    test("switches between source tracks and columns, and recalculates when source data changes", () => {
        addTrack("First", [row(100, 10), row(200, 20), row(300, 30)]);
        const second = addTrack("Second", [row(500), row(600), row(700)]);
        const traverse = new CNodeLOSTraverseUseRange({id: "range", LOS: los}, null);
        traverse.selectRangeSource(JSON.stringify(["TrackData_First", MISB.GroundRange]));
        expect(traverse.p(0).distanceTo(los.v(0).position)).toBe(10);
        traverse.selectRangeSource(JSON.stringify(["TrackData_Second", MISB.SlantRange]));
        expect(traverse.p(0).distanceTo(los.v(0).position)).toBe(500);
        // Exercise the cascade without constructing a renderer in this unit test.
        traverse.checkDisplayOutputs = false;
        second.trackNode.array[0] = {misbRow: row(900)};
        second.trackNode.recalculateCascade();
        expect(traverse.p(0).distanceTo(los.v(0).position)).toBe(900);
    });

    test("uses the source's timed rows even when its scene frame count differs from raw record count", () => {
        const track = addTrack("Sparse", [row(100), row(500)]);
        track.trackNode.array = [0, 0.5, 1].map(t => ({misbRow: row(100), misbNextRow: row(500), misbFraction: t}));
        const traverse = new CNodeLOSTraverseUseRange({id: "range", LOS: los}, null);
        expect([0, 1, 2].map(f => traverse.v(f).range)).toEqual([100, 300, 500]);
    });

    test("restores a saved source after asynchronous imports in a different order", () => {
        const traverse = new CNodeLOSTraverseUseRange({id: "range", LOS: los}, null);
        const desired = JSON.stringify(["TrackData_Second", MISB.GroundRange]);
        traverse.modDeserialize({rangeSource: desired});
        addTrack("First", [row(100), row(100), row(100)]);
        expect(traverse.modSerialize().rangeSource).toBe(desired);
        addTrack("Second", [row(500, 50), row(600, 60), row(700, 70)]);
        expect(traverse.rangeSource).toBe(desired);
        expect(traverse.v(2).range).toBe(70);
        expect(traverse.modSerialize().rangeSource).toBe(desired);
    });

    test("updates method availability on imports/removals and removes its event listener on disposal", () => {
        const traverse = new CNodeLOSTraverseUseRange({id: "range", LOS: los}, null);
        const menu = {
            inputs: {},
            addOption(key, node) { this.inputs[key] = node; },
            removeOption(key) { delete this.inputs[key]; },
        };
        traverse.bindTraverseSwitch(menu);
        expect(menu.inputs["Use Range"]).toBeUndefined();
        addTrack("Nellis", [row(7485), row(9000), row(9135)]);
        expect(menu.inputs["Use Range"]).toBe(traverse);
        expect(traverse.v(0).range).toBe(7485);
        tracks.length = 0;
        EventManager.dispatchEvent("tracksChanged");
        expect(menu.inputs["Use Range"]).toBeUndefined();
        expect(traverse.in.rangeTrack).toBeUndefined();
        expect(traverse.sources).toEqual([]);
        const listener = traverse._onTracksChanged;
        traverse.dispose();
        expect(EventManager.events.tracksChanged).not.toContain(listener);
    });
});
