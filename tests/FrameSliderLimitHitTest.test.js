/** @jest-environment jsdom */
// Which control takes a press on the frame slider: the playhead (the thumb of the range input)
// or the In or Out limit. The marks are drawn where the thumb is for the same frame, the
// playhead wins on its thumb, and the nearer limit wins where the two are close together.
import {par, resetPar} from '../src/par';
import {CNodeFrameSlider} from '../src/nodes/CNodeFrameSlider';
import {Sit} from '../src/Globals';

jest.mock('../src/Globals', () => ({
    Globals: {}, GlobalDateTimeNode: {liveMode: false},
    Sit: {frames: 100, fps: 30, aFrame: 0, bFrame: 99},
    NodeMan: {get: jest.fn(), exists: () => false}, setRenderOne: jest.fn(), markSitchDirty: jest.fn(),
    requiresSingleFrameMode: () => false, isFrameAdvanceBlocked: () => false,
}));
jest.mock('../src/nodes/CNode', () => ({CNode: class { constructor(v) {this.id = v.id;} }}));
jest.mock('../src/PageStructure', () => ({getControlsContainer: () => globalThis.document.body}));
jest.mock('../src/SurfaceInteraction', () => ({registerSurfaceInteraction: jest.fn(() => jest.fn())}));
jest.mock('../src/CEventManager', () => ({EventManager: {dispatchEvent: jest.fn()}}));
jest.mock('../src/showError', () => ({}));

let slider;
// The range input is 1006 px wide and starts 2 px inside the canvas, as its default margin
// puts it in the browser. The center of the 16 px thumb is at 10 px for frame 0 and moves
// 990 px over the 99 frames after the first, so 10 px per frame.
const x = frame => 10 + frame * 10;
const THUMB_ROW = 12;     // a y below the handle band, on the thumb
const HANDLE_ROW = 3;     // a y in the handle band at the top of the bar
// The owner of each x in a row: 'A', 'B' or '.' (the playhead and the track).
const row = (fromX, toX, y) => {
    let owners = '';
    for (let px = fromX; px <= toX; px++) owners += slider.getNearLimit(px, y) ?? '.';
    return owners;
};

beforeEach(() => {
    resetPar();
    document.body.innerHTML = '';
    window.matchMedia = () => ({matches: false});
    globalThis.ResizeObserver = class {observe() {} disconnect() {}};
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
    jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({});
    slider = new CNodeFrameSlider({id: 'FrameSlider'});
    Object.defineProperty(slider.sliderInput, 'offsetWidth', {value: 1006});
    Object.defineProperty(slider.sliderInput, 'offsetLeft', {value: 2});
    Object.assign(Sit, {frames: 100, aFrame: 0, bFrame: 99});
});
afterEach(() => { jest.restoreAllMocks(); });

test('a mark is at the center of the thumb for the same frame, from the first frame to the last', () => {
    expect(slider.frameToCanvasX(0)).toBe(2 + 8);
    expect(slider.frameToCanvasX(99)).toBe(2 + 1006 - 8);
    for (let frame = 0; frame < 100; frame++) expect(slider.canvasXToFrame(slider.frameToCanvasX(frame))).toBe(frame);
    // A press outside the travel of the thumb gives the first or the last frame.
    expect(slider.canvasXToFrame(-50)).toBe(0);
    expect(slider.canvasXToFrame(5000)).toBe(99);
});

test('the playhead takes a press on its thumb when the In line is under it', () => {
    par.frame = 0;   // In is on frame 0 also: the default state of a sitch
    // The thumb is 8 px each side of x(0), and the playhead takes 3 px more each side.
    // That is more than the 10 px reach of the In line, so In takes nothing in this row.
    expect(row(x(0) - 14, x(0) + 14, THUMB_ROW)).toBe('.'.repeat(29));
    // The handle band above the thumb is the place to take a limit that the playhead covers.
    expect(row(x(0) - 11, x(0) + 11, HANDLE_ROW)).toBe('.' + 'A'.repeat(21) + '.');
});

test('the playhead takes a press on its thumb when the Out line is under it', () => {
    par.frame = 99;
    expect(row(x(99) - 14, x(99) + 14, THUMB_ROW)).toBe('.'.repeat(29));
    expect(row(x(99) - 11, x(99) + 11, HANDLE_ROW)).toBe('.' + 'B'.repeat(21) + '.');
});

test('a limit line that the playhead does not cover takes a press within 10 px', () => {
    par.frame = 50;
    Object.assign(Sit, {aFrame: 20, bFrame: 80});
    expect(row(x(20) - 11, x(20) + 11, THUMB_ROW)).toBe('.' + 'A'.repeat(21) + '.');
    expect(row(x(80) - 11, x(80) + 11, THUMB_ROW)).toBe('.' + 'B'.repeat(21) + '.');
});

test('a limit line beside the playhead takes a press only on the side away from the thumb', () => {
    par.frame = 50;
    Object.assign(Sit, {aFrame: 51, bFrame: 99});   // In is 10 px to the right of the playhead
    // The playhead has x(50) - 11 to x(50) + 11. In reaches to x(51) + 10 = x(50) + 20.
    expect(row(x(50) - 14, x(50) + 21, THUMB_ROW)).toBe('.'.repeat(26) + 'A'.repeat(9) + '.');
});

test('where In and Out are near each other, the nearer line takes the press', () => {
    par.frame = 0;
    Object.assign(Sit, {aFrame: 40, bFrame: 41});   // the lines are 10 px apart
    // In has from 10 px on its left to the middle of the gap. Out has the remainder.
    expect(row(x(40) - 11, x(41) + 11, THUMB_ROW)).toBe('.' + 'A'.repeat(15) + 'B'.repeat(16) + '.');
});
