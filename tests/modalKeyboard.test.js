/** @jest-environment jsdom */
jest.mock('../src/Globals', () => ({Globals: {validationMode: false}}));
jest.mock('../src/par', () => ({par: {paused: false}}));

import {showChoice, showConfirm, showPrompt, showTextEditor} from '../src/showError';
import {promptForText} from '../src/TextPrompt';
import {MODAL_OPEN_EVENT} from '../src/ModalKeyboard';

const buttons = () => [...document.querySelectorAll('[role="dialog"] button')];
const press = (key, options = {}, type = 'keydown') => {
    const event = new KeyboardEvent(type, {key, bubbles: true, cancelable: true, ...options});
    document.activeElement.dispatchEvent(event);
    return event;
};

beforeEach(() => { document.body.innerHTML = ''; });
afterEach(() => {
    while (document.querySelector('[role="dialog"]')) press('Escape');
});

test('the primary option gets focus and Enter chooses the option reached with arrows', async () => {
    const answer = showChoice('Choose', {options: [
        {label: 'First', value: 1},
        {label: 'Default', value: 2, primary: true},
        {label: 'Unavailable', value: 3, disabled: true},
        {label: 'Cancel', value: null, cancel: true},
    ]});
    const [first, primary, , cancel] = buttons();
    expect(document.activeElement).toBe(primary);
    expect(primary.classList.contains('sitrec-modal-current')).toBe(true);
    press('ArrowDown');
    expect(document.activeElement).toBe(cancel);
    expect(cancel.classList.contains('sitrec-modal-current')).toBe(true);
    expect(primary.classList.contains('sitrec-modal-current')).toBe(false);
    press('ArrowRight');
    expect(document.activeElement).toBe(first);
    press('ArrowLeft');
    expect(document.activeElement).toBe(cancel);
    press('ArrowUp');
    expect(document.activeElement).toBe(primary);
    press('ArrowUp');
    press('Enter');
    await expect(answer).resolves.toBe(1);
});

test('Tab and Shift+Tab wrap within the dialog, and closing restores focus', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const answer = showConfirm('Continue?');
    const [yes, no] = buttons();
    press('Tab', {shiftKey: true});
    expect(document.activeElement).toBe(no);
    press('Tab');
    expect(document.activeElement).toBe(yes);
    opener.focus();
    expect(document.activeElement).toBe(yes);
    press('Escape');
    await expect(answer).resolves.toBe(false);
    expect(document.activeElement).toBe(opener);
});

test('dialog keys never reach pre-existing document shortcuts and capture is released on close', async () => {
    const background = jest.fn();
    const resetHeldKeys = jest.fn();
    document.addEventListener('keydown', background, true);
    document.addEventListener('keyup', background, true);
    document.addEventListener(MODAL_OPEN_EVENT, resetHeldKeys);
    try {
        const answer = showConfirm('Continue?');
        expect(resetHeldKeys).toHaveBeenCalledTimes(1);
        for (const key of ['w', 'g', 'Tab', 'ArrowDown']) {
            press(key);
            press(key, {}, 'keyup');
        }
        press('Escape');
        await answer;
        expect(background).not.toHaveBeenCalled();
        press('w');
        expect(background).toHaveBeenCalledTimes(1);
    } finally {
        document.removeEventListener('keydown', background, true);
        document.removeEventListener('keyup', background, true);
        document.removeEventListener(MODAL_OPEN_EVENT, resetHeldKeys);
    }
});

test('text fields keep typing and horizontal caret keys; vertical arrows reach buttons', async () => {
    const answer = showPrompt('Name', {defaultValue: 'Bingley'});
    const input = document.querySelector('input');
    expect(press('x').defaultPrevented).toBe(false);
    expect(press('ArrowLeft').defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(input);
    press('ArrowDown');
    expect(document.activeElement).toBe(buttons()[0]);
    press('ArrowRight');
    expect(document.activeElement).toBe(buttons()[1]);
    press('Enter');
    await expect(answer).resolves.toBe('Bingley');
});

test('Escape cancels a prompt while a button has focus', async () => {
    const answer = showPrompt('Name');
    press('Tab');
    expect(document.activeElement.tagName).toBe('BUTTON');
    press('Escape');
    await expect(answer).resolves.toBeNull();
});

test('multiline editing retains arrow keys and Enter, and Tab reaches its actions', async () => {
    const answer = showTextEditor('Text', {defaultValue: 'first\nsecond'});
    const textarea = document.querySelector('textarea');
    expect(press('Enter').defaultPrevented).toBe(false);
    expect(press('ArrowDown').defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(textarea);
    press('Tab');
    expect(document.activeElement).toBe(buttons()[0]);
    press('Escape');
    await expect(answer).resolves.toBeNull();
});

test('type-to-confirm stays gated while focus navigation skips disabled actions', async () => {
    const answer = showConfirm('Delete?', {typeToConfirm: 'DELETE'});
    const input = document.querySelector('input');
    press('Enter');
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    press('Tab');
    expect(document.activeElement).toBe(buttons()[1]);
    press('Tab');
    expect(document.activeElement).toBe(input);
    input.value = 'DELETE';
    input.dispatchEvent(new Event('input', {bubbles: true}));
    press('Enter');
    await expect(answer).resolves.toBe(true);
});

test('repeat and composition Enter do not accept a choice', async () => {
    const answer = showConfirm('Continue?');
    press('Enter', {repeat: true});
    press('Enter', {isComposing: true});
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    press('Escape');
    await expect(answer).resolves.toBe(false);
});

test('validated text prompts use the same focus navigation and cancel behavior', async () => {
    const answer = promptForText({title: 'Name', defaultValue: 'Bingley'});
    press('Tab');
    expect(document.activeElement.textContent).toBe('Cancel');
    press('Enter');
    await expect(answer).resolves.toBeNull();
});
