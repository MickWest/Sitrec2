/** @jest-environment jsdom */
import {acquirePlaybackControl, par, resetPar} from '../src/par';
import {initKeyboard, KeyMan} from '../src/KeyBoardHandler';
import {CNodeFrameSlider} from '../src/nodes/CNodeFrameSlider';
import {updateFrame} from '../src/updateFrame';
import {Globals, NodeMan, Sit} from '../src/Globals';

jest.mock('../src/Globals', () => ({
    Globals: {}, GlobalDateTimeNode: {liveMode: false},
    Sit: {frames: 100, fps: 30, aFrame: 0, bFrame: 99},
    NodeMan: {get: jest.fn(), exists: () => false}, setRenderOne: jest.fn(),
    requiresSingleFrameMode: () => false, isFrameAdvanceBlocked: () => false,
}));
jest.mock('../src/nodes/CNode', () => ({CNode: class { constructor(v) {this.id = v.id;} }}));
jest.mock('../src/PageStructure', () => ({getControlsContainer: () => globalThis.document.body}));
jest.mock('../src/SurfaceInteraction', () => ({registerSurfaceInteraction: jest.fn(() => jest.fn())}));
jest.mock('../src/HandleStyle', () => ({pointerHitRadius: () => 10}));
jest.mock('../src/CEventManager', () => ({EventManager: {dispatchEvent: jest.fn()}}));
jest.mock('../src/TrackEditMode', () => ({}));
jest.mock('../src/JetStuff', () => ({}));
jest.mock('../src/JetUtils', () => ({}));
jest.mock('../src/GoTo', () => ({}));
jest.mock('../src/showError', () => ({}));
jest.mock('../src/utils', () => ({}));

let slider;
beforeEach(() => {
    resetPar();
    KeyMan.clearAll();
    document.body.innerHTML = '';
    window.matchMedia = () => ({matches: false});
    globalThis.ResizeObserver = class {observe() {} disconnect() {}};
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
    jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({});
    slider = new CNodeFrameSlider({id: 'FrameSlider'});
    slider.sliderInput.max = '99';
    NodeMan.get.mockImplementation(id => id === 'FrameSlider' ? slider : null);
    Globals.orbitPreviewApply = jest.fn();
    initKeyboard();
});
afterEach(() => { jest.restoreAllMocks(); });

function press(key, code, repeat = false) {
    document.dispatchEvent(new KeyboardEvent('keydown', {key, code, repeat, bubbles: true, cancelable: true}));
    if (!repeat) document.dispatchEvent(new KeyboardEvent('keyup', {key, code, bubbles: true}));
}

test('Space stops the analysis once; another Space resumes only normal playback', () => {
    const stop = jest.fn(() => control.release());
    const control = acquirePlaybackControl(stop);
    control.setFrame(12);
    press(' ', 'Space');
    expect(stop).toHaveBeenCalledTimes(1);
    expect(par.frame).toBe(12);
    expect(par.paused).toBe(true);
    press(' ', 'Space', true);
    expect(par.paused).toBe(true);
    press(' ', 'Space');
    expect(par.paused).toBe(false);
    expect(stop).toHaveBeenCalledTimes(1);
    updateFrame(100);
    expect(par.frame).toBe(15);
});

test('transport clicks, scrubbing, stepping and the normal clock cannot take the playhead', () => {
    // Simulate a fast-forward button held before Start Point Track.
    slider.fastForwardButton.held = true;
    slider.advanceHeld = true;
    const control = acquirePlaybackControl(jest.fn());
    control.setFrame(10);
    slider.updatePlaybackControls();
    expect(slider.sliderInput.disabled).toBe(true);
    expect(slider.playPauseButton.getAttribute('aria-disabled')).toBe('true');
    expect(slider.fastForwardButton.held).toBe(false);
    expect(slider.advanceHeld).toBe(false);

    for (const button of [slider.playPauseButton, slider.startButton, slider.endButton,
        slider.frameBackButton, slider.frameAdvanceButton, slider.fastForwardButton, slider.fastRewindButton]) {
        button.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true}));
        button.click();
        button.dispatchEvent(new Event('touchend', {bubbles: true, cancelable: true}));
    }
    slider.sliderInput.value = '80';
    slider.sliderInput.dispatchEvent(new Event('input', {bubbles: true}));
    press('.', 'Period'); press(',', 'Comma'); press('ArrowRight', 'ArrowRight');
    press('i', 'KeyI'); press('o', 'KeyO');
    updateFrame(1000);
    expect(par.frame).toBe(10);
    expect(par.paused).toBe(true);
    expect(Sit.aFrame).toBe(0);
    expect(Sit.bFrame).toBe(99);
    expect(Globals.orbitPreviewApply).not.toHaveBeenCalled();

    control.release();
    slider.updatePlaybackControls();
    expect(slider.sliderInput.disabled).toBe(false);
    expect(slider.playPauseButton.getAttribute('aria-disabled')).toBe('false');
    slider.setFrame(20);
    slider.frameAdvanceButton.click();
    expect(par.frame).toBe(21);
    slider.playPauseButton.click();
    expect(par.paused).toBe(false);
});
