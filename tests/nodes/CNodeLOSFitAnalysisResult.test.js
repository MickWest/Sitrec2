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

    test("does not persist the placeholder as if it were an analysis", () => {
        makeLOS();
        const snapshot = new CNodeLOSFitAnalysisResult({id: "snapshot", LOS: "testLOS"});
        expect(snapshot.modSerialize().analysisResult).toBeNull();
    });
});
