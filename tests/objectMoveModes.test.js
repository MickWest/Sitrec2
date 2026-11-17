/** @jest-environment jsdom */
import {initKeyboard, KeyMan} from '../src/KeyBoardHandler';
import {getObjectMoveMode, setObjectMoveMode, subscribeObjectMoveMode} from '../src/ObjectMoveModes';
import {markSitchDirty, Sit} from '../src/Globals';
import {registerBareKeyOwner} from '../src/AltShortcuts';

jest.mock('../src/Globals', () => ({
    Globals: {}, Sit: {isCustom: true}, NodeMan: {get: () => null, exists: () => false},
    setRenderOne: jest.fn(), markSitchDirty: jest.fn(),
}));
jest.mock('../src/nodes/CNodeFrameSlider', () => ({updateFrameSlider: jest.fn()}));
jest.mock('../src/CEventManager', () => ({EventManager: {dispatchEvent: jest.fn()}}));
jest.mock('../src/TrackEditMode', () => ({}));
jest.mock('../src/utils', () => ({}));

beforeEach(() => {
    document.body.innerHTML = '';
    Sit.isCustom = true;
    setObjectMoveMode('surface');
    markSitchDirty.mockClear();
    KeyMan.clearAll();
    initKeyboard();
});

function press(options = {}, target = document) {
    const event = new KeyboardEvent('keydown', {key: 'm', code: 'KeyM', altKey: true, bubbles: true, cancelable: true, ...options});
    target.dispatchEvent(event);
    target.dispatchEvent(new KeyboardEvent('keyup', {key: 'm', code: 'KeyM', bubbles: true}));
    return event;
}

test.each([true, false])('Alt+M cycles all modes once per press (custom sitch: %s)', isCustom => {
    Sit.isCustom = isCustom;
    for (const mode of ['lookCameraPlane', 'push', 'screenPlane', 'surface']) {
        expect(press().defaultPrevented).toBe(true);
        expect(getObjectMoveMode()).toBe(mode);
    }
    expect(markSitchDirty).toHaveBeenCalledTimes(4);
});

test('Alt+M leaves bare M, other modifiers, repeats, and bare tool keys alone', () => {
    expect(press({altKey: false}).defaultPrevented).toBe(false);
    for (const mod of ['shiftKey', 'ctrlKey', 'metaKey', 'repeat']) press({[mod]: true});
    const unregister = registerBareKeyOwner(code => code === 'KeyM');
    press({altKey: false});
    unregister();
    expect(getObjectMoveMode()).toBe('surface');
    expect(markSitchDirty).not.toHaveBeenCalled();
});

test('Option+M uses the physical key even when Mac reports the µ character', () => {
    expect(press({key: 'µ'}).defaultPrevented).toBe(true);
    expect(getObjectMoveMode()).toBe('lookCameraPlane');
});

test.each(['input', 'textarea', 'select', 'div'])('Alt+M does not interrupt typing in %s', tag => {
    const input = document.createElement(tag);
    if (tag === 'div') input.contentEditable = 'true';
    // jsdom's contentEditable property does not reflect its attribute.
    if (tag === 'div') input.setAttribute('contenteditable', 'true');
    document.body.append(input);
    input.focus();
    expect(press({}, input).defaultPrevented).toBe(false);
    expect(getObjectMoveMode()).toBe('surface');
});

test('restoring a mode updates subscribers without dirtying, and disposal removes them', () => {
    const changed = jest.fn();
    const unsubscribe = subscribeObjectMoveMode(changed);
    setObjectMoveMode('screenPlane');
    setObjectMoveMode('invalid');
    expect(getObjectMoveMode()).toBe('screenPlane');
    expect(changed.mock.calls).toEqual([['surface'], ['screenPlane']]);
    expect(markSitchDirty).not.toHaveBeenCalled();
    unsubscribe();
    setObjectMoveMode('push');
    expect(changed).toHaveBeenCalledTimes(2);
});
