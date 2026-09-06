import {Vector3} from 'three';
import {CNodeAutoTrackLOS} from '../../src/nodes/CNodeAutoTrackLOS';
import {getObjectTracker} from '../../src/CObjectTracking';

jest.mock('../../src/Globals', () => ({}));
jest.mock('../../src/nodes/CNode', () => ({CNode: class {}}));
jest.mock('../../src/CObjectTracking', () => ({getObjectTracker: jest.fn()}));
jest.mock('../../src/utils', () => ({radians: d => d * Math.PI / 180}));
jest.mock('../../src/nodes/CNodeControllerVarious', () => ({extractFOV: v => v}));

test('a source-center point remains on the camera LOS with reduced-resolution playback', () => {
    const toOriginal = jest.fn((x, y) => [x / 3, y / 3]);
    const view = {heightPx: 360, widthPx: 640, fovCoverage: 1,
        panOffsetX: 12, panOffsetY: -5, videoToCanvasCoordsOriginal: toOriginal};
    getObjectTracker.mockReturnValue({getInterpolatedPosition: () => ({x: 960, y: 540})});
    const heading = new Vector3(0, 0, -1);
    const node = Object.assign(Object.create(CNodeAutoTrackLOS.prototype), {
        getVideoView: () => view, ensureVideoGeometryReady: () => true,
        in: {cameraLOSNode: {getValueFrame: () => ({heading: heading.clone(),
            up: new Vector3(0, 1, 0), right: new Vector3(1, 0, 0)})},
        fovNode: {getValueFrame: () => 30}},
    });
    expect(node.getValueFrame(0).heading.distanceTo(heading)).toBeCloseTo(0, 12);
    expect(toOriginal).toHaveBeenCalledWith(960, 540);
    expect([view.panOffsetX, view.panOffsetY]).toEqual([12, -5]);
});
