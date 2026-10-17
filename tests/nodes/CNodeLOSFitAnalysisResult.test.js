import {Vector3} from "three";
import {setNodeMan} from "../../src/Globals";
import {CNodeManager} from "../../src/nodes/CNodeManager";
import {CNodeArray} from "../../src/nodes/CNodeArray";
import {CNodeLOSFitAnalysisResult} from "../../src/nodes/CNodeLOSFitAnalysisResult";

describe("CNodeLOSFitAnalysisResult", () => {
    beforeEach(() => setNodeMan(new CNodeManager()));

    function makeLOS(frames = 5) {
        const array = [];
        for (let f = 0; f < frames; f++) {
            array.push({
                position: new Vector3(6371000, f * 10, 1000),
                heading: new Vector3(0, 1, 0),
            });
        }
        return new CNodeArray({id: "testLOS", array});
    }

    test("serializes and restores the exact selected snapshot", () => {
        makeLOS();
        const original = new CNodeLOSFitAnalysisResult({id: "snapshotA", LOS: "testLOS"});
        const track = Float64Array.from([
            100, 200, 300,
            110, 220, 305,
            125, 245, 315,
        ]);
        expect(original.setAnalysisTrack(track, 0.4, -1.2, 1, "Fixed-Wing Aircraft")).toBe(true);

        const saved = original.modSerialize();
        const restored = new CNodeLOSFitAnalysisResult({id: "snapshotB", LOS: "testLOS"});
        restored.modDeserialize(saved);

        expect(restored.hasAnalysisResult).toBe(true);
        expect(restored.resultName).toBe("Fixed-Wing Aircraft");
        expect(restored._frame0).toBe(1);
        expect(Array.from(restored._analysisTrack)).toEqual(Array.from(track));
        expect(restored.array).toHaveLength(5);
        for (let f = 0; f < 5; f++) {
            expect(restored.array[f].position.distanceTo(original.array[f].position)).toBeLessThan(1e-6);
        }
    });

    test("a VFR Fix conversion keeps the snapshot on the same images through a frame-count change", () => {
        const los = makeLOS(5);
        const snapshot = new CNodeLOSFitAnalysisResult({id: "snapshot", LOS: "testLOS"});
        const track = Float64Array.from([100, 200, 300, 110, 220, 305, 125, 245, 315]);
        snapshot.setAnalysisTrack(track, 0.4, -1.2, 1, "Fixed-Wing Aircraft");
        const before = snapshot.array.map(point => point?.position.clone());
        // Source frames 0..4 become virtual frames 0, 1, 3, 4, 6; virtual 2 and 5 hold.
        const map = [0, 1, 3, 4, 6], inverse = [0, 1, 1, 2, 3, 3, 4];
        snapshot.remapFrames(f => map[f], {oldFrames: 5, newFrames: 7, inverse: f => inverse[f]});
        for (let f = 5; f < 7; f++) los.array.push({position: new Vector3(6371000, f * 10, 1000), heading: new Vector3(0, 1, 0)});
        los.frames = 7;
        snapshot.recalculate();
        expect(snapshot.hasAnalysisResult).toBe(true);
        expect(snapshot._frame0).toBe(1);
        expect(snapshot.array).toHaveLength(7);
        for (const [virtual, source] of [[1, 1], [2, 1], [3, 2], [4, 3]]) {
            expect(snapshot.array[virtual].position.distanceTo(before[source])).toBeLessThan(1e-6);
        }
    });

    test("an unconverted frame-count change still discards the snapshot", () => {
        const los = makeLOS(5);
        const snapshot = new CNodeLOSFitAnalysisResult({id: "snapshot", LOS: "testLOS"});
        snapshot.setAnalysisTrack(Float64Array.from([100, 200, 300]), 0.4, -1.2, 1, "Result");
        los.array.push({position: new Vector3(6371000, 50, 1000), heading: new Vector3(0, 1, 0)});
        los.frames = 6;
        snapshot.recalculate();
        expect(snapshot.hasAnalysisResult).toBe(false);
    });

    test("does not persist the placeholder as if it were an analysis", () => {
        makeLOS();
        const snapshot = new CNodeLOSFitAnalysisResult({id: "snapshot", LOS: "testLOS"});
        expect(snapshot.modSerialize().analysisResult).toBeNull();
    });
});
