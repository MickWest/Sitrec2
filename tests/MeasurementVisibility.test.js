/** @jest-environment jsdom */
import {Group, Object3D, PerspectiveCamera, Vector3} from "three";

window.matchMedia ??= () => ({matches: false, addEventListener() {}, removeEventListener() {}});
jest.mock("../src/Globals", () => {
    const inert = new Proxy({}, {get: (_, key) => key === "then" ? undefined : inert});
    const globals = {equatorRadius: 6378137, polarRadius: 6378137};
    return new Proxy({}, {get: (_, key) => key === "Globals" ? globals : () => inert});
});
const {CNodeDisplaySkyOverlay, registerLabel3D, unregisterLabel3D, withVisibleMeasurements}
    = require("../src/nodes/CNodeDisplaySkyOverlay");
const {PointEditorWidget} = require("../src/PointEditorWidget");
const {CNodeLabeledArrow} = require("../src/nodes/CNodeLabels3D");
const threeExt = require("../src/threeExt");
const viewUtils = require("../src/ViewUtils");
const R = 6378137;

test("labeled arrow geometry shares the label's visibility group", () => {
    const group = new Group(), start = new Vector3(R + 100, 0, 0);
    const label = Object.assign(Object.create(CNodeLabeledArrow.prototype), {
        id: "testArrow", _object: group, groupNode: {group: new Group()}, label: "Heading",
        position: new Vector3(), textPosition: new Vector3(), layerMask: 1,
        inputs: {start: {p: () => start}, direction: {p: () => new Vector3(0, 1, 0)},
            length: {v: () => -20}, color: {v: () => "white"}},
    });
    const arrow = jest.spyOn(threeExt, "DebugArrowAB").mockImplementation(() => {});
    try {
        label.recalculate(0);
        label.preRender({pixelsToMeters: () => 10});
        expect(arrow).toHaveBeenCalledTimes(2);
        for (const call of arrow.mock.calls) expect(call[5]).toBe(group);
    } finally { arrow.mockRestore(); }
});

test("measurement text and all geometry hide per camera without changing saved visibility", () => {
    const camera = new PerspectiveCamera(60, 1, 0.1, R * 5);
    const measurement = {
        isMeasurement: true, group: new Group(), groupNode: {group: new Group()}, layerMask: 1,
        A: new Vector3(R + 100, 0, 0), B: new Vector3(R, 0, 0),
        textPosition: new Vector3(R + 50, 0, 0), text: "100 m", shouldRender: () => true,
    };
    const ctx = {fillText: jest.fn()};
    const overlay = {camera, overlayView: {camera}, ctx, labelXY: () => [100, 100]};
    registerLabel3D(measurement);
    try {
        for (const side of [1, -1, 1]) {
            camera.position.set(side * (R + 1000), 0, 0);
            camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true);
            ctx.fillText.mockClear();
            CNodeDisplaySkyOverlay.prototype.renderLabels3D.call(overlay, 0, camera);
            expect(ctx.fillText).toHaveBeenCalledTimes(side === 1 ? 1 : 0);
            withVisibleMeasurements(camera, () => expect(measurement.group.visible).toBe(side === 1));
            expect(measurement.group.visible).toBe(true);
        }
        camera.position.x *= -1;
        expect(() => withVisibleMeasurements(camera, () => { throw new Error("render failed"); })).toThrow("render failed");
        expect(measurement.group.visible).toBe(true);
        measurement.group.visible = false;
        withVisibleMeasurements(camera, () => {});
        expect(measurement.group.visible).toBe(false);
    } finally { unregisterLabel3D(measurement); }
});

test("an already attached move handle cannot start a drag through the globe", () => {
    const camera = new PerspectiveCamera();
    camera.position.set(R + 1000, 0, 0);
    const object = new Object3D(); object.position.set(-R - 100, 0, 0);
    const view = {camera};
    const pickView = jest.spyOn(viewUtils, "getInteractiveViewAt").mockReturnValue(view);
    const displayed = jest.spyOn(viewUtils, "isViewDisplayed").mockReturnValue(true);
    const widget = {
        object, isPointerDown: false,
        setupRaycasterForEvent: PointEditorWidget.prototype.setupRaycasterForEvent,
        pickHandle: jest.fn(), updateHandleScales: jest.fn(), dispatchEvent: jest.fn(),
    };
    try {
        PointEditorWidget.prototype.onPointerDown.call(widget, {button: 0, clientX: 100, clientY: 100});
        expect(widget.isPointerDown).toBe(false);
        expect(widget.pickHandle).not.toHaveBeenCalled();
        expect(widget.dispatchEvent).not.toHaveBeenCalled();
    } finally { pickView.mockRestore(); displayed.mockRestore(); }
});
