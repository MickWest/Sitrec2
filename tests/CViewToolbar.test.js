/** @jest-environment jsdom */

window.matchMedia = window.matchMedia || (() => ({matches: false, addListener() {}, removeListener() {}}));

import '../src/lil-gui-extras';
import GUI from '../src/js/lil-gui.esm';
import {createMainViewToolbar} from '../src/CViewToolbar';
import {sharedMenuKey} from '../src/ViewUIBarMenus';
import {clearMenuMirrors} from '../src/MenuMirror';

let host, source, view, bar, state, control;
const rect = (left, top, width, height) => ({left, top, width, height, right: left + width, bottom: top + height});
const move = (x, y, buttons = 0) => document.dispatchEvent(new MouseEvent('pointermove', {
    clientX: x, clientY: y, buttons, bubbles: true,
}));

beforeEach(() => {
    jest.useFakeTimers();
    clearMenuMirrors();
    host = document.createElement('div');
    document.body.appendChild(host);
    host.getBoundingClientRect = () => rect(0, 0, 640, 480);
    view = {div: host, _headerRevealClear: jest.fn(() => true)};
    bar = createMainViewToolbar(view);
    bar.bar.getBoundingClientRect = () => rect(8, 34, 48, 94);
    state = {ambient: 0.35};
    source = new GUI({container: host, autoPlace: false});
    control = source.add(state, 'ambient', 0, 2, 0.01).name('Ambient Intensity')
        .shareAs(sharedMenuKey('ambientIntensity'));
});

afterEach(() => {
    bar.dispose();
    source.destroy();
    host.remove();
    clearMenuMirrors();
    jest.useRealTimers();
});

test('fades after use, reveals at the left edge, and keeps the pin preference on the view', () => {
    jest.advanceTimersByTime(2000);
    expect(bar.shown).toBe(false);
    expect(bar.bar.inert).toBe(true);
    move(15, 200);
    expect(bar.shown).toBe(true);
    bar.bar.querySelector('[data-uibar-action="pin"]').click();
    move(400, 200);
    jest.advanceTimersByTime(3000);
    expect(bar.shown).toBe(true);
    expect(view.toolbarPinned).toBe(true);
    bar.setPinned(false);
    jest.advanceTimersByTime(1000);
    expect(bar.shown).toBe(false);
    expect(view.toolbarPinned).toBe(false);
});

test('does not reveal through another window or during a camera drag', () => {
    jest.advanceTimersByTime(2000);
    view._headerRevealClear.mockReturnValue(false);
    move(15, 200);
    expect(bar.shown).toBe(false);
    view._headerRevealClear.mockReturnValue(true);
    move(15, 200, 1);
    expect(bar.shown).toBe(false);
});

test('the sun opens a slider without toggling the light, and both controls stay in sync', () => {
    const change = jest.fn();
    control.onChange(change);
    const sun = bar.bar.querySelector('[data-uibar-action="ambient-light"]');
    sun.click();
    const input = bar.bar.querySelector('input[type="range"]');
    expect(state.ambient).toBe(0.35);
    expect(sun.hasAttribute('aria-pressed')).toBe(false);
    expect(sun.getAttribute('aria-expanded')).toBe('true');
    expect(input.getAttribute('aria-label')).toBe('Ambient Light');
    input.value = '0.75';
    input.dispatchEvent(new Event('input'));
    expect(state.ambient).toBe(0.75);
    expect(change).toHaveBeenCalledTimes(1);
    control.setValue(0.2);
    expect(Number(input.value)).toBe(0.2);
    expect(sun.title).toBe('');
    expect(sun.dataset.tooltip).toContain('Adjust ambient light');
    input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
    expect(sun.getAttribute('aria-expanded')).toBe('false');
});

test.each(['label', 'value'])('double-clicking the slider %s resets the shared value and respects disabled controls', (target) => {
    control.setValue(0.75);
    const change = jest.fn(), finish = jest.fn();
    control.onChange(change).onFinishChange(finish);
    bar.bar.querySelector('[data-uibar-action="ambient-light"]').click();
    const popup = bar.bar.querySelector('.view-uibar-popup');
    const element = target === 'label' ? popup.firstElementChild : popup.lastElementChild.lastElementChild;
    const reset = () => element.dispatchEvent(new MouseEvent('dblclick', {bubbles: true, cancelable: true}));
    reset();
    expect(state.ambient).toBe(0.35);
    expect(Number(popup.querySelector('input').value)).toBe(0.35);
    expect(Number(control.$input.value)).toBe(0.35);
    expect(change).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledTimes(1);
    expect(bar.hasOpenMenu()).toBe(true);

    control.setValue(0.8).disable();
    reset();
    expect(state.ambient).toBe(0.8);
    expect(change).toHaveBeenCalledTimes(2);
    expect(finish).toHaveBeenCalledTimes(1);
});

test('keeps an active slider drag open, even outside the toolbar', () => {
    const sun = bar.bar.querySelector('[data-uibar-action="ambient-light"]');
    sun.dispatchEvent(new Event('pointerenter'));
    const input = bar.bar.querySelector('input[type="range"]');
    input.dispatchEvent(new Event('pointerdown', {bubbles: true}));
    sun.dispatchEvent(new Event('pointerleave'));
    move(400, 200, 1);
    jest.advanceTimersByTime(2000);
    expect(bar.hasOpenMenu()).toBe(true);
    window.dispatchEvent(new Event('pointerup'));
    move(400, 200);
    jest.advanceTimersByTime(2000);
    expect(bar.hasOpenMenu()).toBe(false);
    expect(bar.shown).toBe(false);
});

test('disposal cancels pending reveal and popup work', () => {
    bar.bar.querySelector('[data-uibar-action="ambient-light"]').dispatchEvent(new Event('pointerenter'));
    bar.dispose();
    move(15, 200);
    jest.advanceTimersByTime(5000);
    expect(host.querySelector('.view-toolbar')).toBeNull();
    expect(bar.shown).toBe(false);
});
