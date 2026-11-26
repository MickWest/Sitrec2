/** @jest-environment jsdom */
import {undoManager} from "../src/UndoManager";
import {CNodeNotes} from "../src/nodes/CNodeNotes";
import {CNodeAnnotateOverlay} from "../src/nodes/CNodeAnnotateOverlay";
import {MeasurementManager} from "../src/CMeasurementManager";
import {openMeasurementDialog} from "../src/MeasurementDialog";
import {setNodeMan} from "../src/Globals";

jest.mock("../src/nodes/CNodeView", () => ({CNodeView: class {}}));
jest.mock("../src/nodes/CNodeTrackingOverlay", () => ({CNodeActiveOverlay: class {}}));
jest.mock("../src/CFeatureManager", () => ({}));
jest.mock("../src/nodes/CNode3DObject", () => ({}));
jest.mock("../src/nodes/CNodeSatelliteTrack", () => ({}));
jest.mock("../src/MeasurementDialog", () => ({openMeasurementDialog: jest.fn()}));
jest.mock("../src/nodes/CNodeLabels3D", () => ({CNodeMeasurement: class {
    constructor({id, config}) { this.id = id; this.config = config; }
    setConfig(config) { this.config = config; }
}}));

beforeEach(() => undoManager.clear());

test("dragging an annotation width slider edits the selected stroke once", () => {
    const line = {tool: "line", width: 4};
    const overlay = Object.assign(Object.create(CNodeAnnotateOverlay.prototype), {strokeWidth: 2, selectedStroke: line});
    const range = document.createElement("input");
    range.type = "range";
    overlay._bindStrokeStyleInput(range, "strokeWidth", "width", () => range.valueAsNumber);
    for (const value of [5, 7, 12]) {
        range.value = String(value);
        range.dispatchEvent(new Event("input"));
        expect(line.width).toBe(value);
        expect(undoManager.canUndo()).toBe(false);
    }
    range.dispatchEvent(new Event("change"));
    expect(undoManager.getStatus().undoCount).toBe(1);
    overlay.selectedStroke = null;
    expect(undoManager.undo()).toBe(true);
    expect([line.width, overlay.strokeWidth]).toEqual([4, 2]);
    expect(undoManager.redo()).toBe(true);
    expect([line.width, overlay.strokeWidth]).toEqual([12, 12]);
});

test("typing in notes makes one scene edit at blur and no step if the text returns to its original value", () => {
    const view = Object.assign(Object.create(CNodeNotes.prototype),
        {id: "notesView", div: document.createElement("div"), notesText: "Start"});
    setNodeMan({get: () => view});
    view.createTextArea();
    const type = text => {
        view.textArea.value = text;
        view.textArea.dispatchEvent(new Event("input"));
    };
    const finish = () => view.textArea.dispatchEvent(new Event("blur"));
    type("Start draft");
    type("Start");
    finish();
    expect(undoManager.canUndo()).toBe(false);
    type("First draft");
    type("Final note");
    expect(undoManager.canUndo()).toBe(false);
    finish();
    expect(undoManager.getStatus().undoCount).toBe(1);
    expect(undoManager.undo()).toBe(true);
    expect(view.textArea.value).toBe("Start");
    expect(undoManager.redo()).toBe(true);
    expect(view.notesText).toBe("Final note");
});

test("measurement previews and cancellation stay out of history; delete restores the previous committed edit", async () => {
    const manager = MeasurementManager;
    setNodeMan({exists: () => false});
    const answer = (action, label) => openMeasurementDialog.mockImplementationOnce(async ({config, onChange}) => {
        const count = undoManager.getStatus().undoCount;
        onChange({...config, label: "preview"});
        onChange({...config, label});
        expect(undoManager.getStatus().undoCount).toBe(count);
        return {action, config: {...config, label}};
    });
    answer("cancel", "discard");
    await manager.addMeasurement();
    expect(Object.keys(manager.list)).toEqual([]);
    expect(undoManager.canUndo()).toBe(false);
    answer("apply", "First name");
    await manager.addMeasurement();
    const [id] = Object.keys(manager.list);
    answer("apply", "Second name");
    await manager.editMeasurement(id);
    answer("delete", "uncommitted name");
    await manager.editMeasurement(id);
    expect(manager.list[id]).toBeUndefined();
    expect(undoManager.getStatus().undoCount).toBe(3);
    expect(undoManager.undo()).toBe(true);
    expect(manager.list[id].config.label).toBe("Second name");
    expect(undoManager.undo()).toBe(true);
    expect(manager.list[id].config.label).toBe("First name");
    expect(undoManager.redo()).toBe(true);
    expect(manager.list[id].config.label).toBe("Second name");
});
