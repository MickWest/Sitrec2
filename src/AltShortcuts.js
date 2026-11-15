// Keyboard shortcuts that need Alt (Option on a Mac) while the "Require Alt for Shortcuts"
// setting is on. The setting is on by default.
//
// Each of these keys changes the sitch or the screen, and a bare letter is easy to press by
// accident: while typing into a field that does not have focus, for example. With the setting
// off, the keys work without Alt, as they always did.
//
// Read the physical key (KeyboardEvent.code), never the character (KeyboardEvent.key). On a Mac,
// Option changes the character: Option+O gives "ø", Option+C gives "ç", and Option+E, I and U
// give a dead key whose event.key is "Dead". The code stays "KeyO", "KeyC" and so on.

import {Globals} from "./Globals";

// key: what the user sees in a hint or in the K overlay.
// action: the i18n key, under keyboard.altShortcut.actions, that says what the key does.
// shiftOffMac: on Windows and Linux, the labels write the key with Shift (Alt+Shift+F). Some
//   browsers there keep Alt+F and Alt+E for their own menu, and then the page does not get the
//   key. Only the labels change: the keydown handler does not check Shift, so Alt+F and
//   Alt+Shift+F both work wherever the browser sends them to the page.
export const ALT_SHORTCUTS = {
    KeyI: {key: "I", action: "setIn"},
    KeyO: {key: "O", action: "setOut"},
    KeyF: {key: "F", action: "fullscreen", shiftOffMac: true},
    KeyU: {key: "U", action: "toggleUI"},
    KeyE: {key: "E", action: "extendToGround", shiftOffMac: true},
    KeyC: {key: "C", action: "moveCamera"},
    KeyX: {key: "X", action: "moveTarget"},
    Semicolon: {key: ";", action: "startTimeBack"},
    Quote: {key: "'", action: "startTimeForward"},
    Digit1: {key: "1", action: "viewPreset"},
    Digit2: {key: "2", action: "viewPreset"},
    Digit3: {key: "3", action: "viewPreset"},
    Digit4: {key: "4", action: "viewPreset"},
    Digit5: {key: "5", action: "viewPreset"},
    Digit6: {key: "6", action: "viewPreset"},
    Digit7: {key: "7", action: "viewPreset"},
    Digit8: {key: "8", action: "viewPreset"},
};

export function isAltShortcut(code) {
    return Object.hasOwn(ALT_SHORTCUTS, code);
}

// The setting is on unless it is explicitly false. Before the settings load, it is on.
export function altRequiredBy(settings) {
    return settings?.requireAltForShortcuts !== false;
}

export function isAltRequired() {
    return altRequiredBy(Globals.settings);
}

// True when the modifiers of a keydown let an Alt shortcut run.
//
// AltGr (the right Alt key on many European layouts) reports as Ctrl+Alt. People use it to type
// characters such as @ € { } ą ó, so it must never count as Alt here.
export function altModifierOK(event, required = isAltRequired()) {
    if (!required) return true;
    return !!event.altKey && !event.ctrlKey && !event.metaKey;
}

// True when a keydown is one of these keys pressed without Alt while Alt is required.
// That is the press that gets the "this key is now Alt+…" hint.
export function isBareAltShortcut(event, required = isAltRequired()) {
    return required && isAltShortcut(event.code)
        && !event.altKey && !event.ctrlKey && !event.metaKey;
}

// The modifier name, short ("Opt") for the K overlay and long ("Option") for the hint.
export function altModifierName(onMac = Globals.onMac, {short = false} = {}) {
    if (!onMac) return "Alt";
    return short ? "Opt" : "Option";
}

// The labels that get Shift on Windows and Linux (shiftOffMac above).
const SHIFT_OFF_MAC_KEYS = new Set(Object.values(ALT_SHORTCUTS)
    .filter(shortcut => shortcut.shiftOffMac)
    .map(shortcut => shortcut.key));

// How a label writes one of these keys while Alt is required: "Opt+I" or "Alt+I", and
// "Alt+Shift+F" / "Alt+Shift+E" on Windows and Linux. With the setting off, the key alone.
// `key` is the label as the overlay writes it, for example "Shift-C" or "1-8".
// `short: false` writes "Option" in place of "Opt", for the hint message.
export function shortcutLabel(key, {required = isAltRequired(), onMac = Globals.onMac, short = true} = {}) {
    if (!required) return key;
    const shift = !onMac && SHIFT_OFF_MAC_KEYS.has(key) ? "Shift+" : "";
    return `${altModifierName(onMac, {short})}+${shift}${key}`;
}

// Tools that own a bare key while they are active: the Annotation tools in Edit Mode use I, E
// and X to pick a tool, and Point Track uses ; and ' to step. A press that a tool uses is not
// an accident, so it gets no hint. Each owner is a function (code) => boolean.
const bareKeyOwners = new Set();

export function registerBareKeyOwner(owner) {
    bareKeyOwners.add(owner);
    return () => bareKeyOwners.delete(owner);
}

export function isBareKeyOwned(code) {
    for (const owner of bareKeyOwners) {
        if (owner(code)) return true;
    }
    return false;
}
