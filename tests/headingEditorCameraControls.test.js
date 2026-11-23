import {PerspectiveCamera, Vector2} from "three";
import {CameraMapControls} from "../src/js/CameraControls";
import {CNodeControllerPTZUI} from "../src/nodes/CNodeControllerPTZUI";
import {NodeMan} from "../src/Globals";
import {fitViewSyncPan} from "../src/FitViewSync";

jest.mock("../src/Globals", () => ({Globals: {}, Sit: {}, NodeMan: {get: jest.fn(), exists: jest.fn()}, setRenderOne: jest.fn()}));
jest.mock("../src/nodes/CNodeControllerPTZUI", () => ({CNodeControllerPTZUI: class {}}));
jest.mock("../src/threeExt", () => ({}));
jest.mock("../src/LLA-ECEF-ENU", () => ({}));
jest.mock("../src/EGM96Geoid", () => ({}));
jest.mock("../src/SphericalMath", () => ({}));
jest.mock("../src/mouseMoveView", () => ({}));
jest.mock("../src/KeyBoardHandler", () => ({isKeyHeld: () => false}));
jest.mock("../src/configUtils", () => ({isLocal: false}));
jest.mock("../src/ViewUtils", () => ({mouseToView: (v, x, y) => [x, y]}));
jest.mock("../src/raycastGround", () => ({}));
jest.mock("../src/nodes/CNodeLabels3D", () => ({}));
jest.mock("../src/nodes/CNodePositionLLA", () => ({}));
jest.mock("../src/LocalFrame", () => ({}));
jest.mock("../src/DragResizeUtils", () => ({isViewDragging: false}));
jest.mock("../src/FisheyeProjection", () => ({fisheyeEquivalentFOVDeg: () => undefined}));
jest.mock("../src/PanoramicCamera", () => ({isPanoramicCamera: () => false}));
jest.mock("../src/FitViewSync", () => ({fitViewSyncActive: () => true, fitViewSyncPan: jest.fn()}));

let controls, headingEditor, cameraNode, ptz;
beforeEach(() => {
    ptz = Object.assign(new CNodeControllerPTZUI(), {az: 4, el: 5, fov: 30});
    headingEditor = {isActive: () => true, dragView: jest.fn()};
    cameraNode = {id: "lookCamera", freeLook: false, inputs: {ptz}};
    NodeMan.get.mockImplementation(id => typeof id === "object" ? id
        : ({lookCamera: cameraNode, headingEditor})[id]);
    controls = Object.assign(Object.create(CameraMapControls.prototype), {
        enabled: true, state: 2, button: 0, rotateSpeed: .5,
        camera: new PerspectiveCamera(30),
        view: {id: "lookView", cameraNode, heightPx: 600},
        mouseStart: new Vector2(100, 100), mouseEnd: new Vector2(), mouseDelta: new Vector2(),
        updateMeasureArrow() {}, deferCascade: jest.fn(), fixUp: jest.fn(),
    });
    fitViewSyncPan.mockClear();
});

test("left drag edits heading offsets even while camera-fit video sync is on", () => {
    controls.handleMouseMove({clientX: 120, clientY: 110, buttons: 1});
    expect(headingEditor.dragView).toHaveBeenCalledTimes(1);
    const [pan, tilt] = headingEditor.dragView.mock.calls[0];
    expect(pan).toBeCloseTo(-1); expect(tilt).toBeCloseTo(.5);
    expect(fitViewSyncPan).not.toHaveBeenCalled();
    expect(ptz.az).toBe(4); expect(ptz.el).toBe(5);
    expect(controls.deferCascade).toHaveBeenCalledWith(headingEditor);
});

test("without Heading Editor the same drag still pans the fit-synced video", () => {
    headingEditor.isActive = () => false;
    controls.handleMouseMove({clientX: 120, clientY: 110, buttons: 1});
    expect(fitViewSyncPan).toHaveBeenCalledWith(controls.view, 20, 10);
    expect(headingEditor.dragView).not.toHaveBeenCalled();
});
