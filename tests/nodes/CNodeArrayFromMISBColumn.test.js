import {CNodeArray} from "../../src/nodes/CNodeArray";
import {CNodeGUIValue} from "../../src/nodes/CNodeGUIValue";
import {CNodeArrayFromMISBColumn} from "../../src/nodes/CNodeArrayFromMISBColumn";
import {CNodeManager} from "../../src/nodes/CNodeManager";
import {setNodeMan, setSit} from "../../src/Globals";

test("one saved angle window controls all six columns and zero restores measured angles", () => {
    setNodeMan(new CNodeManager());
    setSit({frames: 301, fps: 30});
    const raw = new CNodeArray({id: "raw", array: Array.from({length: 301}, (_, f) => ({
        misbRow: Array.from({length: 6}, () => f >= 135 && f < 165 ? 1 : 0),
    }))});
    const window = new CNodeGUIValue({id: "anglesWindow", value: 120});
    const columns = Array.from({length: 6}, (_, columnIndex) => new CNodeArrayFromMISBColumn({
        id: `angle${columnIndex}`, misb: raw, columnIndex, smooth: window, degrees: true,
    }));
    columns.forEach(column => expect(column.v(150)).toBeLessThan(0.25));
    window.value = 0;
    window.recalculateCascade();
    columns.forEach(column => expect(column.v(150)).toBeCloseTo(1, 8));
    const saved = JSON.parse(JSON.stringify(window.modSerialize()));
    const restored = new CNodeGUIValue({id: "restoredWindow", value: 120});
    restored.guiEntry = {setValue: jest.fn()};
    restored.modDeserialize(saved);
    expect(restored.v0).toBe(0);
    const reopened = new CNodeArrayFromMISBColumn({id: "reopened", misb: raw, columnIndex: 0, smooth: restored, degrees: true});
    expect(reopened.v(150)).toBeCloseTo(1, 8);
});
