/** @jest-environment jsdom */

window.matchMedia = window.matchMedia || (() => ({matches: false, addListener() {}, removeListener() {}}));

import '../src/lil-gui-extras';
import GUI from '../src/js/lil-gui.esm';
import {createLookViewToolbar, createMainViewToolbar} from '../src/CViewToolbar';
import {sharedMenuKey} from '../src/ViewUIBarMenus';
import {clearMenuMirrors} from '../src/MenuMirror';
import {getObjectMoveMode, OBJECT_MOVE_MODES, setObjectMoveMode} from '../src/ObjectMoveModes';
import {Globals} from '../src/Globals';

let host, source, view, bar, state, control;
const rect = (left, top, width, height) => ({left, top, width, height, right: left + width, bottom: top + height});
const move = (x, y, buttons = 0) => document.dispatchEvent(new MouseEvent('pointermove', {
    clientX: x, clientY: y, buttons, bubbles: true,
}));

beforeEach(() => {
    jest.useFakeTimers();
    clearMenuMirrors();
    setObjectMoveMode('surface');
    Globals.onMac = false;
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

test('holding Alt shows just the mode icon at its real button position in both views', () => {
    const lookBar = createLookViewToolbar({...view});
    bar.moveModeButton.getBoundingClientRect = () => rect(13, 121, 36, 36);
    lookBar.moveModeButton.getBoundingClientRect = () => rect(13, 81, 36, 36);
    try {
        jest.advanceTimersByTime(2000);
        document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Alt', code: 'AltLeft', altKey: true, bubbles: true}));
        for (const toolbar of [bar, lookBar]) {
            expect(toolbar.shown).toBe(false);
            expect(toolbar.moveModePeek.style.display).toBe('flex');
            expect(toolbar.moveModePeek.style.left).toBe('13px');
            expect(toolbar.moveModePeek.style.top).toBe(`${toolbar.moveModeButton.getBoundingClientRect().top}px`);
            expect(toolbar.moveModePeek.hasAttribute('aria-pressed')).toBe(false);
        }
        setObjectMoveMode('push');
        expect(bar.moveModePeek.dataset.moveMode).toBe('push');
        expect(lookBar.moveModePeek.innerHTML).toBe(lookBar.moveModeButton.innerHTML);
        bar.moveModePeek.click();
        expect(bar.hasOpenMenu()).toBe(true);
        expect(bar.moveModePeek.style.display).toBe('none');
        document.dispatchEvent(new KeyboardEvent('keyup', {key: 'Alt', code: 'AltLeft', altKey: false, bubbles: true}));
        expect(lookBar.moveModePeek.style.display).toBe('none');
    } finally { lookBar.dispose(); }
});

test('the Alt icon stays visible while dragging, clears on blur, and releases its listeners', () => {
    jest.advanceTimersByTime(2000);
    document.dispatchEvent(new MouseEvent('pointermove', {clientX: 400, clientY: 200, altKey: true, buttons: 1, bubbles: true}));
    expect(bar.shown).toBe(false);
    expect(bar.moveModePeek.style.display).toBe('flex');
    window.dispatchEvent(new Event('blur'));
    expect(bar.moveModePeek.style.display).toBe('none');
    const update = jest.spyOn(bar, 'setAltHeld');
    bar.dispose();
    document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Alt', altKey: true, bubbles: true}));
    expect(update).not.toHaveBeenCalled();
    expect(host.querySelector('[data-uibar-action="move-mode-peek"]')).toBeNull();
});

test.each([[true, 'Opt'], [false, 'Alt']])('mode tooltips use the platform modifier (Mac: %s)', (onMac, modifier) => {
    Globals.onMac = onMac;
    setObjectMoveMode('push');
    for (const button of [bar.moveModeButton, bar.moveModePeek]) {
        expect(button.dataset.tooltip).toContain(`${modifier}+M cycles modes`);
        expect(button.dataset.tooltip).toContain(`\nTIP: Hold down ${modifier} to see and move objects`);
    }
});

test('both movement pickers select all four shared modes and reflect restored state', () => {
    const lookBar = createLookViewToolbar({...view});
    try {
        for (const mode of OBJECT_MOVE_MODES) {
            lookBar.moveModeButton.click();
            expect(lookBar.hasOpenMenu()).toBe(true);
            lookBar.bar.querySelector(`[role="menuitemradio"][data-move-mode="${mode}"]`).click();
            expect(getObjectMoveMode()).toBe(mode);
            expect(lookBar.hasOpenMenu()).toBe(false);
            for (const toolbar of [bar, lookBar]) {
                expect(toolbar.moveModeButton.dataset.moveMode).toBe(mode);
                expect(toolbar.bar.querySelector('[aria-checked="true"]').dataset.moveMode).toBe(mode);
            }
        }
        setObjectMoveMode('push');
        expect(bar.moveModeButton.getAttribute('aria-label')).toBe('Move mode: In / out');
        expect(lookBar.moveModeButton.dataset.moveMode).toBe('push');
    } finally { lookBar.dispose(); }
});

test('movement menu supports keyboard navigation, dismissal, and holds the toolbar open', () => {
    const button = bar.moveModeButton;
    button.click();
    const menu = bar.bar.querySelector('[role="menu"]');
    expect(document.activeElement.dataset.moveMode).toBe('surface');
    menu.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowDown', bubbles: true}));
    expect(document.activeElement.dataset.moveMode).toBe('lookCameraPlane');
    menu.dispatchEvent(new KeyboardEvent('keydown', {key: 'End', bubbles: true}));
    expect(document.activeElement.dataset.moveMode).toBe('screenPlane');
    move(400, 200);
    jest.advanceTimersByTime(2000);
    expect(bar.hasOpenMenu()).toBe(true);
    expect(bar.shown).toBe(true);
    menu.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(button);
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
    const popup = bar.bar.querySelector('input[type="range"]').closest('.view-uibar-popup');
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
