/** @jest-environment jsdom */
import i18next from "i18next";
import {initI18n, setLanguage} from "../src/i18n";
import {localizeElements, titleText} from "../src/NativeText";
import {TimeEditor} from "../src/TimeEditor";

afterEach(() => setLanguage("en"));

test("a template gets its text, tooltip, placeholder and label from keys", () => {
    const root = document.createElement("div");
    root.dataset.i18nLabel = "timeEditor.label";
    root.innerHTML = '<button data-i18n="timeEditor.nowOnce.label" data-i18n-title="timeEditor.nowOnce.tooltip"></button>'
        + '<input data-i18n-placeholder="timeEditor.paste.placeholder" data-i18n-label="timeEditor.paste.label">';
    expect(localizeElements(root)).toBe(root);
    expect(root.getAttribute("aria-label")).toBe("Date and time editor");
    expect(root.querySelector("button").textContent).toBe("Now once");
    expect(root.querySelector("button").title).toBe("Set the current frame to the real clock once, and stay paused");
    expect(root.querySelector("input").placeholder).toBe("Paste a date & time");
    expect(root.querySelector("input").getAttribute("aria-label")).toBe("Paste date and time");
});

test("a translation is shown as text and cannot add markup", () => {
    initI18n();
    i18next.addResourceBundle("de", "translation", {timeEditor: {nowOnce: {label: "<b>Jetzt</b> & einmal"}}}, true, true);
    setLanguage("de");
    const root = document.createElement("div");
    root.innerHTML = '<button data-i18n="timeEditor.nowOnce.label"></button>';
    localizeElements(root);
    expect(root.querySelector("button").textContent).toBe("<b>Jetzt</b> & einmal");
    expect(root.querySelector("b")).toBeNull();
});

test("the time editor shows a second language, and English where a string is not translated", () => {
    initI18n();
    i18next.addResourceBundle("de", "translation", {timeEditor: {
        target: {now: "Abspielkopf", start: "Start"}, status: {paused: "PAUSIERT"}, frame: "Bild {{frame}}", parts: {year: "Jahr"},
    }}, true, true);
    setLanguage("de");
    const host = document.createElement("div");
    document.body.append(host);
    const state = {now: new Date("2024-12-31T23:59:10Z"), start: new Date("2024-12-31T23:59:00Z"), frame: 300,
        offset: 0, useZone: false, zone: "UTC", paused: true, live: false, speed: 1, playbackSpeed: 1, canUndo: false};
    const editor = new TimeEditor(host, {zones: [], read: () => state, pause() {}});
    try {
        expect(editor.root.querySelector('[data-target="now"]').textContent).toBe("Abspielkopf");
        expect(editor.el("status").textContent).toBe("PAUSIERT");
        expect(editor.el("frame").textContent).toBe("Bild 300");
        expect(editor.root.querySelector('[data-part="year"]').getAttribute("aria-label")).toBe("Jahr");
        // Not in the German strings: the English text is shown.
        expect(editor.root.querySelector('[data-action="live"]').textContent).toBe("● Live");
    } finally {
        editor.dispose(); host.remove();
    }
});

test("a title is a key or fixed text", () => {
    expect(titleText({titleKey: "panels.satellite.title"})).toBe("Satellite Controls");
    expect(titleText({title: "Fixed"})).toBe("Fixed");
    expect(titleText({})).toBeUndefined();
});
