import {Vector3} from "three";
import {withUnfilteredAnalysisAngles} from "../src/AnalysisAngleSmoothing";
import {captureInputFiltering} from "../src/AnalysisFiltering";
import {buildAnalysisDataset} from "../src/TraverseAnalysisData";
import {setNodeMan, setSit} from "../src/Globals";
import {CNodeManager} from "../src/nodes/CNodeManager";
import {CNodeArray} from "../src/nodes/CNodeArray";
import {CNodeGUIValue} from "../src/nodes/CNodeGUIValue";
import {CNodeArrayFromMISBColumn} from "../src/nodes/CNodeArrayFromMISBColumn";
import {CNodeLOSTrackMISB} from "../src/nodes/CNodeLOSTrackMISB";

let nodeMan;
beforeEach(() => {
    nodeMan = new CNodeManager();
    setNodeMan(nodeMan);
    setSit({frames: 301, fps: 30, simSpeed: 1, lat: 0, lon: 0});
});

function fixture(windowValue = 120) {
    const source = new CNodeArray({id: "source", array: Array.from({length: 301}, (_, f) => ({
        position: new Vector3(6378137, f, 0),
        misbRow: [0, 0, 0, f >= 135 && f < 165 ? 1 : 0, -30, 0],
    }))});
    const window = new CNodeGUIValue({id: "angles", value: windowValue});
    const fields = ["platformHeading", "platformPitch", "platformRoll", "sensorAz", "sensorEl", "sensorRoll"];
    const columns = Object.fromEntries(fields.map((field, columnIndex) => [field,
        new CNodeArrayFromMISBColumn({id: field, misb: source, columnIndex, smooth: window, degrees: true})]));
    const los = new CNodeLOSTrackMISB({id: "los", cameraTrack: source, ...columns});
    return {window, columns, los};
}

test("analysis uses recorded angles and reports zero, then restores playback and saved settings", async () => {
    const {window, columns, los} = fixture();
    const before = los.v(150).heading.clone();
    const viewingDataset = buildAnalysisDataset(los).dataset;
    const recalc = jest.spyOn(window, "recalculateCascade");
    expect(columns.sensorAz.v(150)).toBeLessThan(0.25);
    const dataset = await withUnfilteredAnalysisAngles(los, async () => {
        await Promise.resolve();
        expect(window.v0).toBe(0);
        expect(columns.sensorAz.v(150)).toBeCloseTo(1, 10);
        expect(los.v(150).heading.distanceTo(before)).toBeGreaterThan(0.001);
        const filters = captureInputFiltering([{node: los, role: "Sightlines"}], {fps: 30, frame0: 0, frame1: 300});
        expect(filters).toHaveLength(1);
        expect(filters[0].status).toBe("off");
        return buildAnalysisDataset(los).dataset;
    });
    expect(Array.from(dataset.D)).not.toEqual(Array.from(viewingDataset.D));
    expect(window.v0).toBe(120);
    expect(window.modSerialize().value).toBe(120);
    expect(los.v(150).heading.distanceTo(before)).toBeLessThan(1e-12);
    expect(recalc).toHaveBeenCalledTimes(2); // one shared control for six columns
});

test.each(["cancelled", "solver failed"])("restores the viewing filter after %s", async message => {
    const {window, los} = fixture(30);
    await expect(withUnfilteredAnalysisAngles(los, async () => { throw new Error(message); })).rejects.toThrow(message);
    expect(window.v0).toBe(30);
});

test("only the selected source and enabled camera controllers are changed", async () => {
    const {window, los} = fixture();
    const other = new CNodeGUIValue({id: "otherAngles", value: 60});
    const otherColumn = {smoothingKind: "column", degrees: true, in: {smooth: other}};
    const selected = {getObject: () => ({in: {active: los,
        disabled: {isController: true, enabled: false, in: {source: otherColumn}}}}),
        in: {unselected: otherColumn}};
    await withUnfilteredAnalysisAngles(selected, () => {
        expect(window.v0).toBe(0);
        expect(other.v0).toBe(60);
    });
    expect(window.v0).toBe(120);
});

test("zero is preserved, and edits or a new scene are not overwritten on completion", async () => {
    const {window, los} = fixture(0);
    const recalc = jest.spyOn(window, "recalculateCascade");
    await withUnfilteredAnalysisAngles(los, () => {});
    expect(recalc).not.toHaveBeenCalled();
    window.value = 120;
    await withUnfilteredAnalysisAngles(los, () => { window.value = 60; });
    expect(window.value).toBe(60);
    await withUnfilteredAnalysisAngles(los, () => { setNodeMan(new CNodeManager()); });
    expect(window.value).toBe(0); // the disposed scene is left alone
});
