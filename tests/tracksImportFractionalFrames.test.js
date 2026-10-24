// par.frame is fractional during real-time playback (updateFrame advances it by
// dt * fps) and stays fractional when paused. Per-frame consumers must use a whole
// frame: the Custom Az/El controller indexed its arrays with it (undefined, so a
// NaN camera), and the MQ9 tracking simulation stored commands at it that never
// matched a stepped frame, so they were silently dropped.

import {PerspectiveCamera, Vector3} from "three";
import {CNodeControllerAzElZoom, CNodeControllerCustomAzEl} from "../src/nodes/CNodeControllerPTZUI";
import {MQ9TrackingSimulation} from "../src/MQ9TrackingSimulation";

jest.mock("../src/nodes/CNodeController", () => ({CNodeController: class {
    constructor() { this.simpleSerials = []; }
}}));
jest.mock("../src/Globals", () => ({
    Globals: {equatorRadius: 6378137, polarRadius: 6356752.314245, validationMode: true},
    Sit: {frames: 900, fps: 30, lat: 0, lon: 0},
    guiMenus: {}, NodeMan: {get: jest.fn()},
}));
jest.mock("../src/par", () => ({par: {paused: true}}));
jest.mock("../src/CViewManager", () => ({}));
jest.mock("../src/LLA-ECEF-ENU", () => ({}));
jest.mock("../src/KeyBoardHandler", () => ({}));
jest.mock("../src/threeExt", () => ({}));
jest.mock("../src/CelestialMath", () => ({}));
jest.mock("../src/atmosphere/refractionSettings", () => ({
    currentTerrestrialLiftContext: () => null,
}));
jest.mock("../src/mouseMoveView", () => ({}));
jest.mock("../src/JetUtils", () => ({}));
jest.mock("../src/i18n", () => ({}));
jest.mock("../src/raycastGround", () => ({raycastGroundElevationFast: jest.fn()}));

describe("Custom Az/El at a fractional frame", () => {
    let controller, applied;

    beforeEach(() => {
        applied = [];
        // Record what the base class would point the camera with.
        jest.spyOn(CNodeControllerAzElZoom.prototype, "apply").mockImplementation(function () {
            applied.push({az: this.az, el: this.el});
        });
        controller = Object.assign(Object.create(CNodeControllerCustomAzEl.prototype), {
            relative: false,
            fallback: {relative: false, az: 0, el: 0, fov: 30},
            azArray: Array.from({length: 100}, (_, f) => f / 10),
            elArray: Array.from({length: 100}, (_, f) => 20 + f / 10),
        });
    });

    afterEach(() => jest.restoreAllMocks());

    test("uses the whole frame being shown", () => {
        controller.apply(37.5, {});
        expect(applied).toEqual([{az: 3.7, el: 23.7}]);
    });

    test("stays inside the arrays past either end", () => {
        controller.apply(99.6, {});
        controller.apply(-0.5, {});
        expect(applied).toEqual([{az: 9.9, el: 29.9}, {az: 0, el: 20}]);
    });
});

describe("MQ9 tracking commands at a fractional frame", () => {
    // The same scene as MQ9TrackingSimulation.test.js, with no scripted commands.
    function simulation(overrides = {}) {
        const radius = 6378137, camera = new PerspectiveCamera(5, 4/3, .1, 1e7);
        camera.position.set(radius+1000, 0, 0); camera.up.set(1,0,0); camera.lookAt(new Vector3(radius+500,0,0));
        camera.updateMatrixWorld(true);
        const target = f => [radius+500, f/30*2, 0];
        return new MQ9TrackingSimulation({camera, fps: 30,
            sensorAt: f => [radius+1000,f/30*20,0], manualAimAt: target,
            observationAt: f => ({id: "balloon", position: target(f), diameterM: 1, confidence: 1}),
            commands: [],
            groundAt: (origin, direction) => {
                const distance = (radius-origin.x)/direction.x;
                return distance>0 ? origin.clone().addScaledVector(direction,distance) : null;
            }, ...overrides});
    }

    test("acquire while paused at 37.4 runs as if issued at frame 37", () => {
        const paused = simulation();
        paused.applyFrame(37.4);
        expect(paused.current.state).toBe("manual");
        paused.command("acquire", 37.4);
        paused.applyFrame(37.4);
        paused.applyFrame(90.7);
        expect(paused.current.state).not.toBe("manual");

        const whole = simulation();
        whole.applyFrame(37);
        whole.command("acquire", 37);
        whole.applyFrame(90);
        expect(JSON.stringify(paused.current)).toBe(JSON.stringify(whole.current));
    });

    test("a fractional start frame still runs whole-frame commands", () => {
        const commands = [{frame: 20, action: "acquire"}];
        const fractional = simulation({startFrame: 10.4, commands});
        fractional.applyFrame(60);
        expect(fractional.current.state).not.toBe("manual");
        const whole = simulation({startFrame: 10, commands});
        whole.applyFrame(60);
        expect(JSON.stringify(fractional.current)).toBe(JSON.stringify(whole.current));
    });

    test("the cached pose for a fractional frame is replayed", () => {
        const s = simulation();
        s.applyFrame(40);
        const pose = s.camera.quaternion.toArray();
        s.camera.quaternion.set(0, 0, 0, 1);
        s.applyCachedFrame(40.5);
        expect(s.camera.quaternion.toArray()).toEqual(pose);
    });
});
