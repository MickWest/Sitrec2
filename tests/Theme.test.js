/**
 * @jest-environment jsdom
 */
// Theme.js: the global dark / light theme, and the rule for the mode of each view.

const views = {};
jest.mock("../src/Globals", () => ({
    NodeMan: {iterate: (fn) => Object.entries(views).forEach(([id, node]) => fn(id, node))},
    setRenderOne: jest.fn(),
}));

import {defaultViewDark, isGlobalThemeDark, setAllViewsDark, setGlobalTheme} from "../src/Theme";

function makeView(nativeDark, themeable = true) {
    const view = {
        themeable, nativeDark, dark: nativeDark, themeExplicit: true,
        setDark(dark, explicit = true) { this.dark = dark; this.themeExplicit = explicit; },
    };
    return view;
}

beforeEach(() => {
    for (const id of Object.keys(views)) delete views[id];
    views.graph = makeView(true);           // a view with dark native colors
    views.classicGraph = makeView(false);   // a classic curve graph: white
    views.mainView = makeView(true, false); // a 3D view: not themeable
    setGlobalTheme("");
});

test("with no selection, the menus are dark and each view keeps its native mode", () => {
    expect(isGlobalThemeDark()).toBe(true);
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(defaultViewDark(true)).toBe(true);
    expect(defaultViewDark(false)).toBe(false);
    expect(views.graph.dark).toBe(true);
    expect(views.classicGraph.dark).toBe(false);
});

test("a selected theme sets the menus and every themeable view", () => {
    setGlobalTheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(views.graph.dark).toBe(false);
    expect(views.classicGraph.dark).toBe(false);
    expect(defaultViewDark(true)).toBe(false);

    setGlobalTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(views.graph.dark).toBe(true);
    expect(views.classicGraph.dark).toBe(true);
    expect(defaultViewDark(false)).toBe(true);
});

test("a view that is not themeable does not change", () => {
    views.mainView.dark = "untouched";
    setGlobalTheme("light");
    setAllViewsDark(true);
    expect(views.mainView.dark).toBe("untouched");
});

test("the selection of no theme returns each view to its native mode", () => {
    setGlobalTheme("light");
    setGlobalTheme("");
    expect(views.graph.dark).toBe(true);
    expect(views.classicGraph.dark).toBe(false);
    expect(document.documentElement.dataset.theme).toBe("dark");
});

test("a change of all views together is not a choice for one view", () => {
    views.graph.setDark(false);             // the user set this view with its own button
    expect(views.graph.themeExplicit).toBe(true);
    setAllViewsDark(true);                  // Shift + click, or the global theme
    expect(views.graph.themeExplicit).toBe(false);
    expect(views.classicGraph.themeExplicit).toBe(false);
});

test("a value that is not known is the same as no selection", () => {
    setGlobalTheme("blue");
    expect(isGlobalThemeDark()).toBe(true);
    expect(defaultViewDark(false)).toBe(false);
});
