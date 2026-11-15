// The keys that need Alt (Option on a Mac) while Settings > Require Alt for Shortcuts is on.
import {
    ALT_SHORTCUTS,
    altModifierName,
    altModifierOK,
    altRequiredBy,
    isAltRequired,
    isBareAltShortcut,
    isBareKeyOwned,
    registerBareKeyOwner,
    shortcutLabel,
} from "../src/AltShortcuts";
import {Globals} from "../src/Globals";
import en from "../src/i18n/en";

jest.mock("../src/Globals", () => ({Globals: {}}));

const keydown = (code, mods = {}) => ({code, altKey: false, ctrlKey: false, metaKey: false, ...mods});

describe("AltShortcuts", () => {
    afterEach(() => {
        delete Globals.settings;
        delete Globals.onMac;
    });

    test("the setting is on unless it is explicitly false", () => {
        expect(altRequiredBy(undefined)).toBe(true);
        expect(altRequiredBy({})).toBe(true);
        expect(altRequiredBy({requireAltForShortcuts: true})).toBe(true);
        expect(altRequiredBy({requireAltForShortcuts: false})).toBe(false);

        expect(isAltRequired()).toBe(true);           // before the settings load
        Globals.settings = {requireAltForShortcuts: false};
        expect(isAltRequired()).toBe(false);
    });

    test("covers exactly the keys that were moved to Alt", () => {
        expect(Object.keys(ALT_SHORTCUTS).sort()).toEqual([
            "Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8",
            "KeyC", "KeyE", "KeyF", "KeyI", "KeyO", "KeyU", "KeyX", "Quote", "Semicolon",
        ]);
    });

    test("Alt alone passes; a bare key, AltGr (Ctrl+Alt) and Cmd+Alt do not", () => {
        expect(altModifierOK(keydown("KeyI", {altKey: true}), true)).toBe(true);
        expect(altModifierOK(keydown("KeyI"), true)).toBe(false);
        expect(altModifierOK(keydown("KeyI", {altKey: true, ctrlKey: true}), true)).toBe(false);
        expect(altModifierOK(keydown("KeyI", {altKey: true, metaKey: true}), true)).toBe(false);
        // With the setting off, anything goes, as before.
        expect(altModifierOK(keydown("KeyI"), false)).toBe(true);
        expect(altModifierOK(keydown("KeyI", {altKey: true}), false)).toBe(true);
    });

    test("Shift does not stop an Alt shortcut, so Alt+Shift+F and Alt+Shift+E work", () => {
        expect(altModifierOK(keydown("KeyF", {altKey: true, shiftKey: true}), true)).toBe(true);
        expect(altModifierOK(keydown("KeyE", {altKey: true, shiftKey: true}), true)).toBe(true);
        expect(isBareAltShortcut(keydown("KeyF", {altKey: true, shiftKey: true}), true)).toBe(false);
        expect(isBareAltShortcut(keydown("KeyF", {shiftKey: true}), true)).toBe(true);  // Shift+F alone
    });

    test("only a bare press of a listed key, while Alt is required, gets the hint", () => {
        expect(isBareAltShortcut(keydown("KeyI"), true)).toBe(true);
        expect(isBareAltShortcut(keydown("Digit3"), true)).toBe(true);
        expect(isBareAltShortcut(keydown("KeyI", {altKey: true}), true)).toBe(false);
        expect(isBareAltShortcut(keydown("KeyI", {metaKey: true}), true)).toBe(false);  // Cmd+I
        expect(isBareAltShortcut(keydown("KeyI"), false)).toBe(false);
        expect(isBareAltShortcut(keydown("KeyV"), true)).toBe(false);     // V/B stay bare
        expect(isBareAltShortcut(keydown("Numpad1"), true)).toBe(false);  // camera keys, not presets
        expect(isBareAltShortcut(keydown("Digit9"), true)).toBe(false);
    });

    test("labels name Option on a Mac and Alt elsewhere, and drop it when not required", () => {
        expect(shortcutLabel("I", {required: true, onMac: true})).toBe("Opt+I");
        expect(shortcutLabel("Shift-C", {required: true, onMac: false})).toBe("Alt+Shift-C");
        expect(shortcutLabel("I", {required: false, onMac: true})).toBe("I");
        expect(altModifierName(true)).toBe("Option");
        expect(altModifierName(false)).toBe("Alt");

        // F and E get Shift on Windows and Linux, where some browsers keep Alt+F and Alt+E.
        expect(shortcutLabel("F", {required: true, onMac: false})).toBe("Alt+Shift+F");
        expect(shortcutLabel("E", {required: true, onMac: false})).toBe("Alt+Shift+E");
        expect(shortcutLabel("F", {required: true, onMac: true})).toBe("Opt+F");
        expect(shortcutLabel("I", {required: true, onMac: false})).toBe("Alt+I");
        expect(shortcutLabel("E", {required: false, onMac: false})).toBe("E");
        // The hint writes the long name.
        expect(shortcutLabel("E", {required: true, onMac: true, short: false})).toBe("Option+E");
        expect(shortcutLabel("F", {required: true, onMac: false, short: false})).toBe("Alt+Shift+F");

        // The K overlay reads the live setting each frame.
        Globals.onMac = true;
        expect(shortcutLabel("1-8")).toBe("Opt+1-8");
        Globals.settings = {requireAltForShortcuts: false};
        expect(shortcutLabel("1-8")).toBe("1-8");
    });

    test("a tool can own a bare key while it is active", () => {
        let active = true;
        const unregister = registerBareKeyOwner(code => active && code === "KeyI");
        expect(isBareKeyOwned("KeyI")).toBe(true);
        expect(isBareKeyOwned("KeyO")).toBe(false);
        active = false;
        expect(isBareKeyOwned("KeyI")).toBe(false);
        active = true;
        unregister();
        expect(isBareKeyOwned("KeyI")).toBe(false);
    });

    test("every hint has its English text", () => {
        const strings = en.keyboard.altShortcut;
        expect(strings.hint).toContain("{{shortcut}}");
        for (const {action} of Object.values(ALT_SHORTCUTS)) {
            expect(typeof strings.actions[action]).toBe("string");
        }
        expect(en.custom.settings.requireAltForShortcuts.label).toBe("Require Alt for Shortcuts");
    });
});
