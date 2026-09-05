import {Vector3} from "three";
import {setNodeMan, setSit} from "../../src/Globals";
import {CNodeManager} from "../../src/nodes/CNodeManager";
import {CNodeArray} from "../../src/nodes/CNodeArray";
import {CNodeSwitch} from "../../src/nodes/CNodeSwitch";
import {CNodeSmoothedPositionTrack} from "../../src/nodes/CNodeSmoothedPositionTrack";
import {CNodeLOSFitAnalysisResult} from "../../src/nodes/CNodeLOSFitAnalysisResult";
import {connectTraverseOutput} from "../../src/TraverseOutput";

let nodeMan;
beforeEach(() => {
    nodeMan = new CNodeManager();
    setNodeMan(nodeMan);
    setSit({frames: 101, fps: 30, simSpeed: 1});
});
function source(id = "source") {
    return new CNodeArray({id, array: Array.from({length: 101}, (_, f) => ({position: new Vector3(f, 50 * Math.sin(f / 5), 100)}))});
}

test.each(["none", "moving", "savgol", "sliding"])("restores %s over a previously materialized default", method => {
    const raw = source();
    const first = new CNodeSmoothedPositionTrack({id: "first", source: raw, method: "savgol", window: 20});
    first.method = method;
    const saved = JSON.parse(JSON.stringify(first.modSerialize()));
    const restored = new CNodeSmoothedPositionTrack({id: "restored", source: raw, method: "savgol", window: 20});
    restored.p(30);
    restored.modDeserialize(saved);
    expect(restored.method).toBe(method);
    expect(restored.p(30).distanceTo(first.p(30))).toBeLessThan(1e-9);
});

test("old saves without a method retain their configured default", () => {
    const node = new CNodeSmoothedPositionTrack({id: "smooth", source: source(), method: "moving", window: 20});
    node.modDeserialize({visible: true});
    expect(node.method).toBe("moving");
});

test("all traverse output consumers agree, and a saved exact snapshot bypasses filtering", () => {
    const raw = source();
    const los = new CNodeArray({id: "los", array: Array.from({length: 101}, () => ({
        position: new Vector3(6378137, 0, 0), heading: new Vector3(0, 1, 0),
    }))});
    const snapshot = new CNodeLOSFitAnalysisResult({id: "snapshot", LOS: los});
    const track = new Float64Array(61 * 3);
    for (let f = 0; f < 61; f++) {
        track[3 * f] = 1000 + f;
        track[3 * f + 1] = 100 * Math.sin(f / 10);
        track[3 * f + 2] = 100;
    }
    snapshot.setAnalysisTrack(track, 0, 0, 20, "Selected result");
    const restored = new CNodeLOSFitAnalysisResult({id: "restored", LOS: los});
    restored.modDeserialize(JSON.parse(JSON.stringify(snapshot.modSerialize())));
    const selector = new CNodeSwitch({id: "LOSTraverseSelectTrack", inputs: {raw, exact: restored}, default: "raw"});
    const output = new CNodeSmoothedPositionTrack({id: "traverseSmoothedTrack", source: selector, method: "moving", window: 20});
    const display = new CNodeSmoothedPositionTrack({id: "traverseDisplayTrack", source: raw, method: "none"});
    display.addInput("track", selector);
    display.recalculateCascade = jest.fn();
    const graph = new CNodeSmoothedPositionTrack({id: "targetDistanceGraph_GenericJetGraph_Munge", source: raw, method: "none"});
    graph.addInput("targetTrack", selector);
    graph.recalculateCascade = jest.fn();
    connectTraverseOutput(nodeMan);
    expect(display.in.track).toBe(output);
    expect(graph.in.targetTrack).toBe(output);
    output.exportTrackCSV = jest.fn(() => "same output");
    expect(selector.exportTrackCSV(true)).toBe("same output");
    expect(output.p(30).distanceTo(raw.p(30))).toBeGreaterThan(1);
    selector.choice = "exact";
    output.recalculate();
    for (const f of [0, 19, 20, 21, 30, 79, 80, 81, 100]) {
        expect(output.p(f).distanceTo(restored.p(f))).toBeLessThan(1e-9);
    }
    // The user's nonzero window still applies after leaving the exact result.
    selector.choice = "raw";
    output.recalculate();
    expect(output.p(30).distanceTo(raw.p(30))).toBeGreaterThan(1);
});
