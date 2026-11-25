import {NodeMan, setRenderOne} from "../src/Globals";
import {flushCameraInputUpdates, requestCameraInputUpdate} from "../src/CameraInputUpdates";
import {DISPLAY_FRAME_TOLERANCE_MS, frameClockStep} from "../src/renderLoopControl";

jest.mock("../src/Globals", () => ({NodeMan: {get: jest.fn()}, setRenderOne: jest.fn()}));

let cameraNode, inputAngle, renderedAngle;
beforeEach(() => {
    flushCameraInputUpdates(0, true);
    inputAngle = renderedAngle = 0;
    cameraNode = {id: "lookCamera", update: jest.fn(() => { renderedAngle = inputAngle; })};
    NodeMan.get.mockImplementation(id => id === cameraNode.id ? cameraNode : undefined);
    NodeMan.list = {};
    setRenderOne.mockClear();
});
afterEach(() => flushCameraInputUpdates(0, true));

test.each([false, true])("60 Hz drag poses with 30 Hz logic, paused=%s", paused => {
    let logicTime = 0, frame = 0, logicUpdates = 0;
    const drawnAngles = [];
    for (let display = 1; display <= 60; display++) {
        // Coalesced pointer events supply the latest input before each draw.
        inputAngle = display - 0.5;
        requestCameraInputUpdate(cameraNode);
        inputAngle = display;
        requestCameraInputUpdate(cameraNode);
        const step = frameClockStep(display * 1000 / 60, logicTime, 1000 / 30,
            DISPLAY_FRAME_TOLERANCE_MS);
        if (step.due) {
            logicTime = step.time;
            logicUpdates++;
            if (!paused) frame++;
            cameraNode.update(frame);
        }
        flushCameraInputUpdates(frame, step.due);
        drawnAngles.push(renderedAngle);
    }
    expect(logicUpdates).toBe(30);
    expect(frame).toBe(paused ? 0 : 30);
    expect(drawnAngles).toEqual(Array.from({length: 60}, (_, i) => i + 1));
    expect(cameraNode.update).toHaveBeenCalledTimes(60);
    flushCameraInputUpdates(frame);
    expect(cameraNode.update).toHaveBeenCalledTimes(60);
    expect(setRenderOne).toHaveBeenCalledWith(true);
});

test("a scrub's full node update consumes the pending input without applying it twice", () => {
    inputAngle = 12;
    requestCameraInputUpdate(cameraNode);
    cameraNode.update(240);
    flushCameraInputUpdates(240, true);
    flushCameraInputUpdates(240);
    expect(cameraNode.update).toHaveBeenCalledTimes(1);
    expect(renderedAngle).toBe(12);
});

test("a removed camera or replacement with the same id is never updated", () => {
    requestCameraInputUpdate(cameraNode);
    NodeMan.get.mockReturnValue(undefined);
    flushCameraInputUpdates(7);
    requestCameraInputUpdate(cameraNode);
    const replacement = {id: cameraNode.id, update: jest.fn()};
    NodeMan.get.mockReturnValue(replacement);
    flushCameraInputUpdates(7);
    expect(cameraNode.update).not.toHaveBeenCalled();
    expect(replacement.update).not.toHaveBeenCalled();
});

test("cameras with no pending input are left untouched", () => {
    flushCameraInputUpdates(8);
    expect(cameraNode.update).not.toHaveBeenCalled();
    expect(setRenderOne).not.toHaveBeenCalled();
});


test("camera frusta follow the refreshed pose before views draw, without updating unrelated nodes", () => {
    const seen = [];
    const helper = {cameraNode, updateOnCameraInput: true,
        update: jest.fn(frame => seen.push([frame, renderedAngle]))};
    const hidden = {...helper, updateOnCameraInput: false, update: jest.fn()};
    const unrelated = {...helper, cameraNode: {}, update: jest.fn()};
    const ordinary = {cameraNode, update: jest.fn()};
    NodeMan.list = Object.fromEntries(Object.entries({helper, hidden, unrelated, ordinary})
        .map(([id, data]) => [id, {data}]));
    inputAngle = 34;
    requestCameraInputUpdate(cameraNode);
    flushCameraInputUpdates(7);
    expect(seen).toEqual([[7, 34]]);
    expect(hidden.update).not.toHaveBeenCalled();
    expect(unrelated.update).not.toHaveBeenCalled();
    expect(ordinary.update).not.toHaveBeenCalled();
    requestCameraInputUpdate(cameraNode);
    flushCameraInputUpdates(8, true);
    expect(helper.update).toHaveBeenCalledTimes(1);
});
