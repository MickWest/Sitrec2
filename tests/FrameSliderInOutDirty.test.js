/** @jest-environment jsdom */
// The In and Out frames are saved with the sitch, so changing them on the frame slider (dragging
// a limit, or double-clicking outside the range to reset one) marks the sitch as changed, as
// does undoing or redoing a drag.
import {resetPar} from '../src/par';
import {CNodeFrameSlider} from '../src/nodes/CNodeFrameSlider';
import {markSitchDirty, Sit} from '../src/Globals';
import {registerSurfaceInteraction} from '../src/SurfaceInteraction';

jest.mock('../src/Globals', () => ({
    Globals: {}, GlobalDateTimeNode: {liveMode: false},
    Sit: {frames: 100, fps: 30, aFrame: 0, bFrame: 99},
    NodeMan: {get: jest.fn(), exists: () => false}, setRenderOne: jest.fn(), markSitchDirty: jest.fn(),
    requiresSingleFrameMode: () => false, isFrameAdvanceBlocked: () => false,
}));
jest.mock('../src/nodes/CNode', () => ({CNode: class { constructor(v) {this.id = v.id;} }}));
jest.mock('../src/PageStructure', () => ({getControlsContainer: () => globalThis.document.body}));
jest.mock('../src/SurfaceInteraction', () => ({registerSurfaceInteraction: jest.fn(() => jest.fn())}));
jest.mock('../src/HandleStyle', () => ({pointerHitRadius: () => 10}));
jest.mock('../src/CEventManager', () => ({EventManager: {dispatchEvent: jest.fn()}}));
jest.mock('../src/showError', () => ({}));

let slider, limits;
// Canvas x of a frame: 5 px padding each side of a 1010 px canvas, so 10 px per frame.
const x = frame => 5 + frame * 10;
const at = frame => ({clientX: x(frame), clientY: 20});

beforeEach(() => {
    resetPar();
    document.body.innerHTML = '';
    window.matchMedia = () => ({matches: false});
    globalThis.ResizeObserver = class {observe() {} disconnect() {}};
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
    jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({});
    registerSurfaceInteraction.mockClear();
    slider = new CNodeFrameSlider({id: 'FrameSlider'});
    Object.defineProperty(slider.canvas, 'offsetWidth', {value: 1010});
    limits = registerSurfaceInteraction.mock.calls.map(call => call[1]).find(options => options.profile === 'limits');
    Object.assign(Sit, {aFrame: 40, bFrame: 60});
    markSitchDirty.mockClear();
});
afterEach(() => { jest.restoreAllMocks(); });

test('dragging a limit to another frame marks the sitch changed', () => {
    limits.begin(at(40), {limit: 'A'});
    limits.move(at(40));
    limits.end(at(40));
    expect(markSitchDirty).not.toHaveBeenCalled();   // released where it started

    limits.begin(at(40), {limit: 'A'});
    limits.move(at(20));
    limits.end(at(20));
    expect(Sit.aFrame).toBe(20);
    expect(markSitchDirty).toHaveBeenCalled();

    markSitchDirty.mockClear();
    limits.begin(at(60), {limit: 'B'});
    limits.move(at(80));
    limits.end(at(80));
    expect(Sit.bFrame).toBe(80);
    expect(markSitchDirty).toHaveBeenCalled();
});

test('undoing or redoing a drag marks the sitch changed', () => {
    limits.restore({a: 40, b: 60});
    expect(markSitchDirty).toHaveBeenCalledTimes(1);
});

test('double-clicking outside the range resets that limit and marks the sitch changed', () => {
    const doubleClick = frame => slider.sliderDiv.dispatchEvent(new MouseEvent('dblclick', {...at(frame), bubbles: true}));
    doubleClick(50);   // inside the range: nothing to reset
    expect(markSitchDirty).not.toHaveBeenCalled();
    doubleClick(10);
    expect(Sit.aFrame).toBe(0);
    expect(markSitchDirty).toHaveBeenCalledTimes(1);
    doubleClick(90);
    expect(Sit.bFrame).toBe(99);
    expect(markSitchDirty).toHaveBeenCalledTimes(2);
});
