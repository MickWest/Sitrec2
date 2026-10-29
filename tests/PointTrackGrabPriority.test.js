/** @jest-environment jsdom */
// A Point Track point near the top of the video lies under the view's own chrome: the header
// strip and the top resize handle. A press on the point must grab the point rather than move or
// resize the view, and a press on that chrome away from the point must still reach the chrome.
import {ObjectTracker} from '../src/CObjectTracking';
import {getInteractionRouter} from '../src/InteractionRouter';
import {makeDraggable, makeResizable} from '../src/DragResizeUtils';

jest.mock('../src/Globals', () => ({
    Globals: {}, Sit: {frames: 20, aFrame: 0, bFrame: 19},
    NodeMan: {get: jest.fn(() => null)}, setRenderOne: jest.fn(),
    unregisterFrameBlocker: jest.fn(), UndoManager: {add: jest.fn()},
}));
jest.mock('../src/openCVLoader', () => ({getCV: () => ({}), loadOpenCV: jest.fn()}));
jest.mock('../src/jsfeatLoader', () => ({getJsfeat: jest.fn(() => null), loadJsfeat: jest.fn()}));
jest.mock('../src/CVideoData', () => ({interpolatePosition: (map, f) => map.get(f)}));
jest.mock('../src/CEventManager', () => ({EventManager: {addEventListener: jest.fn()}}));
jest.mock('../src/KeyBoardHandler', () => ({
    KeyMan: {isKeyHeld: jest.fn(), clearAll: jest.fn()}, isKeyHeld: () => false,
}));
jest.mock('../src/CViewManager', () => ({ViewMan: {iterate() {}}}));
jest.mock('../src/VideoExporter', () => ({}));
jest.mock('../src/utils', () => ({}));
jest.mock('../src/showError', () => ({showError: jest.fn()}));
jest.mock('../src/AttributionOverlay', () => ({}));
jest.mock('../src/configUtils', () => ({isLocal: true}));
jest.mock('../src/i18n', () => ({t: v => v}));
jest.mock('../src/PointTrackFrequencyGraph', () => ({
    addPointTrackFrequencyMenu: jest.fn(),
    getPointTrackFrequencyAperture: jest.fn(() => null),
}));

const rect = {left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300};
let div, bar, tracker, blocker, dragStart, resizeStart;

function pointer(target, type, x, y) {
    const e = new MouseEvent(type, {bubbles: true, cancelable: true, clientX: x, clientY: y,
        button: 0, buttons: type === 'pointerup' ? 0 : 1});
    Object.defineProperty(e, 'pointerId', {value: 1});
    Object.defineProperty(e, 'pointerType', {value: 'mouse'});
    target.dispatchEvent(e);
}

beforeEach(() => {
    div = document.createElement('div');
    div.style.cssText = 'left:0px;top:0px;width:400px;height:300px';
    div.getBoundingClientRect = () => rect;
    const canvas = document.createElement('canvas');
    canvas.getBoundingClientRect = () => rect;
    bar = document.createElement('div');
    bar.className = 'view-uibar';
    bar.getBoundingClientRect = () => ({...rect, bottom: 26, height: 26});
    div.append(canvas, bar);
    document.body.appendChild(div);

    // Video pixels are canvas pixels here, so the numbers below read directly.
    const view = {div, canvas, zIndex: 1, dWidth: 400, originalVideoWidth: 400,
        videoData: {videoWidth: 400, videoHeight: 300},
        getSourceAndDestCoords() {}, canvasToVideoCoordsOriginal: (x, y) => [x, y],
        mouse: {x: 0, y: 0, newPosition(e) { this.x = e.clientX; this.y = e.clientY; },
            handleMouseMove: jest.fn()},
        addHeaderRevealBlocker: fn => { blocker = fn; return () => {}; }};
    dragStart = jest.fn();
    resizeStart = jest.fn();
    makeDraggable(div, {handle: bar, viewInstance: view, onDragStart: dragStart});
    makeResizable(div, {handles: 'n', viewInstance: view, onResizeStart: resizeStart});
    div._resizeHandles.n.getBoundingClientRect = () => ({...rect, top: -5, bottom: 5, height: 10});

    tracker = new ObjectTracker(view);
    Object.assign(tracker, {enabled: true, trackX: 200, trackY: 12, trackRadius: 30});
    tracker.updateSliderStatus = jest.fn();
    tracker.hookMouseHandler();
});
afterEach(() => { getInteractionRouter(document).dispose(); div.remove(); });

test('a press on the point under the top resize handle grabs the point', () => {
    pointer(div._resizeHandles.n, 'pointerdown', 200, 2);
    pointer(document, 'pointermove', 210, 22);
    pointer(document, 'pointerup', 210, 22);
    expect(resizeStart).not.toHaveBeenCalled();
    expect([tracker.trackX, tracker.trackY]).toEqual([210, 32]);
    expect(div.style.height).toBe('300px');
});

test('a press on the point under the header grabs it; elsewhere the header still drags', () => {
    pointer(bar, 'pointerdown', 200, 15);
    pointer(document, 'pointermove', 230, 15);
    pointer(document, 'pointerup', 230, 15);
    expect(dragStart).not.toHaveBeenCalled();
    expect(tracker.trackX).toBe(230);

    pointer(bar, 'pointerdown', 350, 15);
    pointer(document, 'pointerup', 350, 15);
    expect(dragStart).toHaveBeenCalledTimes(1);
});

test('the header stays down over the point, and a disabled tracker claims nothing', () => {
    expect(blocker(200, 15)).toBe(true);
    expect(blocker(350, 15)).toBe(false);

    tracker.enabled = false;
    expect(blocker(200, 15)).toBe(false);
    pointer(bar, 'pointerdown', 200, 15);
    pointer(document, 'pointerup', 200, 15);
    expect(dragStart).toHaveBeenCalledTimes(1);
});
