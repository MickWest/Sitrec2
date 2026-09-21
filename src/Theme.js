// Theme - the dark / light theme of the user interface.
//
// There is one GLOBAL theme (Settings). It sets the look of the menus, the other lil-gui
// panels, the view header bars and the tooltips (a "data-theme" attribute on <html>, which
// the CSS reads), and a change of the global theme sets EVERY themeable view to the new mode.
// The HTML dialogs and the page chrome that have inline colors do not change.
//
// After that, each themeable view has its own mode: the Dark / Light button in its
// header changes that view only. Shift + click changes all views. See
// CNodeView.enableTheme().
//
// Until the user selects a theme, the theme is "not explicit": the menus are dark and
// each view starts in its NATIVE look (most are dark, the classic curve graphs are white).
// So nothing changes for a user who never opens the setting.

import {NodeMan, setRenderOne} from "./Globals";

let globalDark = true;
let explicit = false;

export function isGlobalThemeDark() {
    return globalDark;
}

// The mode that a new view starts in, and the mode that a saved sitch does not need to store.
// nativeDark = the theme that the view's drawing code was made for.
export function defaultViewDark(nativeDark = true) {
    return explicit ? globalDark : nativeDark;
}

// All themeable views go to one mode. dark = null: each view goes to its native mode.
export function setAllViewsDark(dark) {
    NodeMan.iterate((id, node) => {
        if (node.themeable) node.setDark(dark ?? node.nativeDark, false);   // false: not a choice for one view
    });
    setRenderOne();
}

// theme = "dark" or "light". Anything else = no selection ("Classic", the start condition):
// dark menus, and each view in its native colors.
export function setGlobalTheme(theme) {
    explicit = theme === "dark" || theme === "light";
    globalDark = theme !== "light";
    if (typeof document !== "undefined") {
        document.documentElement.dataset.theme = globalDark ? "dark" : "light";
    }
    setAllViewsDark(explicit ? globalDark : null);
}
