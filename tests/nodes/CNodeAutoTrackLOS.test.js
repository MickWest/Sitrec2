import {Quaternion, Vector3} from 'three';

// The same module stubs as CNodeTrackingOverlay.test.js, so that both LOS sources
// can be loaded here and compared, plus the point tracker.
jest.mock('../../src/nodes/CNodeViewUI', () => ({CNodeViewUI: class {}}));
jest.mock('../../src/assert', () => ({assert: jest.fn()}));
jest.mock('../../src/Globals', () => ({Globals: {exportTagNumber: 0}, NodeMan: {}, Sit: {frames: 0}}));
jest.mock('../../src/utils', () => ({radians: d => d * Math.PI / 180}));
jest.mock('../../src/nodes/CNodeControllerVarious', () => ({extractFOV: v => v}));
jest.mock('../../src/ViewUtils', () => ({mouseToCanvas: () => [0, 0]}));
jest.mock('../../src/nodes/CNodeVideoView', () => ({CNodeVideoView: class {}}));
jest.mock('../../src/CEventManager', () => ({
    EventManager: {addEventListener: jest.fn(), removeEventListener: jest.fn()},
}));
jest.mock('../../src/CObjectTracking', () => ({getObjectTracker: jest.fn()}));

const {assert} = require('../../src/assert');
const {getObjectTracker} = require('../../src/CObjectTracking');
const {CNodeAutoTrackLOS} = require('../../src/nodes/CNodeAutoTrackLOS');
const {CNodeTrackingOverlay} = require('../../src/nodes/CNodeTrackingOverlay');

const OW = 1920;
const OH = 1080;
const VFOV = 30;

// An orthonormal camera frame that is NOT axis-aligned, so a mixed-up component
// cannot pass by accident.
const ROTATION = new Quaternion().setFromAxisAngle(new Vector3(1, 2, 3).normalize(), 0.7);
const HEADING = new Vector3(0, 0, -1).applyQuaternion(ROTATION);
const UP = new Vector3(0, 1, 0).applyQuaternion(ROTATION);
const RIGHT = new Vector3(1, 0, 0).applyQuaternion(ROTATION);

function makeLOS() {
    return {position: new Vector3(1, 2, 3), heading: HEADING.clone(), up: UP.clone(), right: RIGHT.clone(),
        angularSize: {minDeg: 1, maxDeg: 2}};
}

// A video view whose LAYOUT state is all present, but must not be used. Any read of
// a conversion method or zoom, or any write to the pan offsets, is recorded.
function makeView(layout) {
    const writes = [];
    const view = {
        originalVideoWidth: OW, originalVideoHeight: OH,
        videoWidth: layout.videoWidth, videoHeight: layout.videoHeight,
        widthPx: layout.widthPx, heightPx: layout.heightPx, fovCoverage: layout.fovCoverage,
        videoToCanvasCoordsOriginal: jest.fn(() => [0, 0]),
        getSourceAndDestCoords: jest.fn(),
        in: {zoom: {v: jest.fn(() => layout.zoom), v0: layout.zoom}},
        writes,
    };
    for (const key of ['panOffsetX', 'panOffsetY']) {
        const value = layout[key];
        Object.defineProperty(view, key, {get: () => value, set: v => writes.push([key, v])});
    }
    return view;
}

const PLAIN = {videoWidth: OW, videoHeight: OH, widthPx: OW, heightPx: OH, fovCoverage: 1,
    zoom: 100, panOffsetX: 0, panOffsetY: 0};
// Reduced-resolution decode, an odd pane, letterboxed, zoomed and panned.
const BUSY = {videoWidth: 1280, videoHeight: 720, widthPx: 1013, heightPx: 377, fovCoverage: 0.7,
    zoom: 250, panOffsetX: 0.2, panOffsetY: -0.1};

function makeNode(view, pos, los = makeLOS()) {
    getObjectTracker.mockReturnValue({getInterpolatedPosition: () => pos});
    // CNode defines "in" as a getter, so it is shadowed with an own property here.
    const node = Object.create(CNodeAutoTrackLOS.prototype, {
        getVideoView: {value: () => view},
        in: {value: {cameraLOSNode: {getValueFrame: () => los}, fovNode: {getValueFrame: () => VFOV}}},
    });
    return {node, los};
}

// The pinhole ray written out by hand, independent of the code under test.
function analyticRay(vx, vy) {
    const fpx = OH / (2 * Math.tan(VFOV * Math.PI / 180 / 2));
    const dx = vx - OW / 2;
    const dy = vy - OH / 2;
    return new Vector3(
        HEADING.x * fpx + RIGHT.x * dx - UP.x * dy,
        HEADING.y * fpx + RIGHT.y * dx - UP.y * dy,
        HEADING.z * fpx + RIGHT.z * dx - UP.z * dy,
    ).normalize();
}

beforeEach(() => {
    assert.mockClear();
});

test('a source-centre pixel stays on the camera LOS, with reduced-resolution playback', () => {
    const view = makeView(BUSY);
    const {node} = makeNode(view, {x: OW / 2, y: OH / 2});
    const result = node.getValueFrame(0);
    expect(result.heading.distanceTo(HEADING)).toBeCloseTo(0, 12);
});

test('a corner pixel gives the analytic pinhole ray', () => {
    for (const [vx, vy] of [[0, 0], [OW, OH], [0, OH], [OW, 0], [123.5, 987.25]]) {
        const {node} = makeNode(makeView(PLAIN), {x: vx, y: vy});
        const result = node.getValueFrame(0);
        expect(result.heading.distanceTo(analyticRay(vx, vy))).toBeLessThan(1e-12);
        expect(result.heading.length()).toBeCloseTo(1, 12);
    }
});

test('the output keeps the LOS contract: heading replaced, size cleared, up/right dropped', () => {
    const {node, los} = makeNode(makeView(PLAIN), {x: 0, y: 0});
    const result = node.getValueFrame(7);
    expect(result).toBe(los);
    expect(result.position.equals(new Vector3(1, 2, 3))).toBe(true);
    expect(result.angularSize).toBeNull();
    expect(result.up).toBeUndefined();
    expect(result.right).toBeUndefined();
    expect(assert).toHaveBeenCalledWith(true, expect.stringContaining('frame 7'));
});

test('the ray does not depend on the video view layout, and never writes the pan', () => {
    const pos = {x: 1700.5, y: 95.25};
    const plainView = makeView(PLAIN);
    const busyView = makeView(BUSY);
    const a = makeNode(plainView, pos).node.getValueFrame(0).heading;
    const b = makeNode(busyView, pos).node.getValueFrame(0).heading;

    // Bit-identical, not merely close: no layout value reaches the arithmetic.
    expect(b.toArray()).toEqual(a.toArray());
    for (const view of [plainView, busyView]) {
        expect(view.writes).toEqual([]);
        expect(view.videoToCanvasCoordsOriginal).not.toHaveBeenCalled();
        expect(view.getSourceAndDestCoords).not.toHaveBeenCalled();
        expect(view.in.zoom.v).not.toHaveBeenCalled();
    }
});

test('Point Track and Manual Tracking give the same ray for the same pixel and LOS', () => {
    const view = makeView(BUSY);
    const overlay = {overlayView: view};
    for (const [vx, vy] of [[0, 0], [OW, OH], [OW / 2, OH / 2], [1700.5, 95.25]]) {
        const manual = CNodeTrackingOverlay.prototype.rayForVideoXY.call(overlay, makeLOS(), VFOV, vx, vy);
        const point = makeNode(view, {x: vx, y: vy}).node.getValueFrame(0).heading;
        expect(point.toArray()).toEqual(manual.toArray());
    }
});

test('on a rotated video, Point Track and Manual Tracking both use the shown frame', () => {
    // Coded 1920x1080 rotated 90 degrees: shown 1080 wide and 1920 high.
    const view = makeView(PLAIN);
    view.videoData = {effectiveRotation: 90};
    const overlay = {overlayView: view};
    const fpx = OW / (2 * Math.tan(VFOV * Math.PI / 180 / 2));
    for (const [xs, ys] of [[540, 960], [1080, 960], [810, 300]]) {
        const vx = xs * OW / OH, vy = ys * OH / OW;
        const expected = new Vector3().addScaledVector(HEADING, fpx)
            .addScaledVector(RIGHT, xs - 540).addScaledVector(UP, -(ys - 960)).normalize();
        const point = makeNode(view, {x: vx, y: vy}).node.getValueFrame(0).heading;
        const manual = CNodeTrackingOverlay.prototype.rayForVideoXY.call(overlay, makeLOS(), VFOV, vx, vy);
        expect(point.distanceTo(expected)).toBeLessThan(1e-12);
        expect(point.toArray()).toEqual(manual.toArray());
    }
});

describe('falls back to the plain camera LOS', () => {
    function expectUnchanged(result, los) {
        expect(result).toBe(los);
        expect(result.heading.equals(HEADING)).toBe(true);
        expect(result.up).toBeDefined();
        expect(result.angularSize).toEqual({minDeg: 1, maxDeg: 2});
    }

    test('with no point tracker', () => {
        const {node, los} = makeNode(makeView(PLAIN), {x: 0, y: 0});
        getObjectTracker.mockReturnValue(null);
        expectUnchanged(node.getValueFrame(0), los);
    });

    test('with no video view', () => {
        const {node, los} = makeNode(null, {x: 0, y: 0});
        expectUnchanged(node.getValueFrame(0), los);
    });

    test('before the video has an original pixel size', () => {
        const view = makeView(PLAIN);
        view.originalVideoWidth = 0;
        view.originalVideoHeight = 0;
        const {node, los} = makeNode(view, {x: 0, y: 0});
        expectUnchanged(node.getValueFrame(0), los);
    });

    test('with no tracked position at this frame', () => {
        const {node, los} = makeNode(makeView(PLAIN), null);
        expectUnchanged(node.getValueFrame(0), los);
    });

    test('when the camera LOS has no up/right', () => {
        const los = makeLOS();
        los.up = undefined;
        const {node} = makeNode(makeView(PLAIN), {x: 0, y: 0}, los);
        const result = node.getValueFrame(0);
        expect(result).toBe(los);
        expect(result.heading.equals(HEADING)).toBe(true);
    });
});

test('only the original video size is needed for readiness', () => {
    const node = Object.create(CNodeAutoTrackLOS.prototype);
    const view = {originalVideoWidth: OW, originalVideoHeight: OH};
    node.getVideoView = () => view;
    expect(node.hasVideoGeometry()).toBe(true);
    view.originalVideoHeight = 0;
    expect(node.hasVideoGeometry()).toBe(false);
    node.getVideoView = () => null;
    expect(node.hasVideoGeometry()).toBe(false);
});
