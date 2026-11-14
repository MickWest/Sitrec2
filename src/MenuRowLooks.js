// Two looks for a menu row that the plain lil-gui rows do not have. Each one is still an
// ordinary controller, so the Sitrec API finds it, and a panel copy of the folder has it too:
// MenuMirror's buildTwin gives the copy the same look.
//
// LINK ROW: controller.asLinkRow("On Track")
//
//   A button row drawn as a label on the left and the button on the right, like a value row:
//
//       On Track   [ Balloon          > ]
//
//   The label says what the link is, and the button's own text (its name) is the NAME of the
//   thing at the other end. A click opens that thing's menu. For the links between a track and
//   the objects on it (TrackObjectLinks.js). A full-width button with the text "Track: Balloon"
//   read as a heading, and "Track: Track 3" said the word two times.
//
//   The button's text changes when the other thing gets a new name. `_signatureName` is the
//   row's name for the copy of a folder in a panel (CustomManagerMirror.createGUISignature):
//   it does not change, so a rename does not make the panel build itself again while the user
//   types in its Name field.
//
// DISPLAY ROW: controller.asDisplayRow()
//
//   A text row that only shows something: "Used For   Camera position, FOV". The text can be
//   selected and copied, but not edited. It is not disabled: a disabled row is dim, and dim
//   means "switched off" in these menus.
//
//   `_displayOnly` tells the Sitrec API to leave the row out when it looks for a control by
//   name (CSitrecAPI._matchController). A script's `set "Traverse Method" ...` finds the real
//   control "LOS Traverse Method" by a partial match; a display row with exactly that name
//   must not take it.

import {Controller} from "./js/lil-gui.esm";

const STYLE_ID = "lil-row-looks-style";

function injectStyles() {
    if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    // The label of a link row is drawn by ::before, with the measures and the fill of a
    // row's .name: the panel fill in a menu, and none in a panel of the modern look
    // (ModernControlStyle.js does the same for .name).
    style.textContent = `
.lil-gui .controller.function.lil-link-row::before {
    content: attr(data-link-label);
    flex: 0 0 auto;
    box-sizing: border-box;
    min-width: var(--name-width);
    padding-left: 5px;
    padding-right: var(--spacing);
    line-height: var(--widget-height);
    white-space: nowrap;
    overflow: hidden;
    background: var(--sitrec-bg-panel);
}
.sitrec-modern .controller.function.lil-link-row::before { background: transparent; }
.lil-gui .controller.function.lil-link-row > .widget { flex: 1 1 0; width: auto; min-width: 0; }
.lil-gui .controller.function.lil-link-row button { display: flex; align-items: center; min-width: 0; }
.lil-gui .controller.function.lil-link-row button > .name { flex: 1 1 auto; min-width: 0; }
.lil-gui .controller.function.lil-link-row button::after {
    content: "\\203A";
    flex: 0 0 auto;
    padding: 0 6px 1px 4px;
    opacity: 0.7;
}
.lil-gui .controller.string.lil-display-row input {
    background: transparent;
    color: inherit;
    cursor: default;
    text-overflow: ellipsis;
}
`;
    document.head.appendChild(style);
}

/**
 * Draw this button row as a label and a button. The button's text is the controller's name.
 * @param {string} label - the text on the left, e.g. "On Track"
 * @param {string} [signatureName] - a name for the row that does not change with the button's
 *        text; defaults to the label
 * @returns {Controller} this
 */
Controller.prototype.asLinkRow = function (label, signatureName) {
    injectStyles();
    this._linkRowLabel = String(label ?? "");
    this._signatureName = signatureName ?? this._signatureName ?? `link:${this._linkRowLabel}`;
    this.domElement.classList.add("lil-link-row");
    this.domElement.dataset.linkLabel = this._linkRowLabel;
    return this;
};

/**
 * Make this text row a display: it shows a text that the user cannot edit, and the Sitrec
 * API does not take it for a control.
 * @returns {Controller} this
 */
Controller.prototype.asDisplayRow = function () {
    injectStyles();
    this._displayOnly = true;
    this.domElement.classList.add("lil-display-row");
    if (this.$input) {
        this.$input.readOnly = true;
        this.$input.tabIndex = -1;
    }
    return this;
};
