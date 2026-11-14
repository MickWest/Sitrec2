// A folder's TITLE NOTE: a small outlined tag at the right end of its title row, left of the
// title checkbox. It says what the folder's thing is linked to, so that the user can read it
// without opening the folder: "Camera" on the track that the camera is on, "on Track 3" on an
// object that is on that track. TrackObjectLinks.js sets the notes.
//
//   folder.setTitleNote("Camera", "The camera is on this track")
//   folder.setTitleNote("")            // no note
//
// HOW IT IS DRAWN. The note is the title's `data-note` attribute, and CSS draws it with
// `::after`. No element is added. That matters, because the title's TEXT is a key in several
// places: GUI.getFolder and GUI.moveAfter find a folder by it, and the menu bar saves the open
// and closed state of a folder under it. A pseudo-element is not part of textContent, innerText
// or innerHTML, so all of those read the title as before. lil-gui's title() rewrites only the
// text, so the attribute also stays through a rename.
//
// A NAME IS NEVER COVERED. The title becomes a flex row that can wrap, but it is only one line
// high and it cuts off what is outside it. A note that does not fit beside the name goes to a
// second line, which is not drawn. So nothing is measured, and there is no observer. (A title
// with a note loses its "..." when the NAME is longer than the row: the name is then cut at
// the edge.)
//
// FULL CONTRAST, not dim. A dim row already means "switched off" in these menus (FolderToggle.js).
//
// Not on a panel's own title or a torn-out folder's (a root): that title is a tab with the
// name, and the same link is a row inside the panel.
//
// The tip is one more line of the folder's tooltip. GUI.prototype.tooltip (lil-gui-extras.js)
// keeps the folder's own text in `_tooltip` and adds `_titleNoteTip` to it, so a later
// tooltip() call (a rename sets the tooltip again) keeps the line.

import GUI from "./js/lil-gui.esm";

const STYLE_ID = "lil-title-note-style";

function injectStyles() {
    if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    // The column gap keeps the note clear of the name. The arrow before the name is an item of
    // the row too, so its margin takes the same gap back: the name stays where it was.
    style.textContent = `
.lil-gui .lil-gui > .title[data-note] {
    display: flex;
    flex-wrap: wrap;
    align-content: flex-start;
    align-items: center;
    column-gap: 6px;
    row-gap: var(--title-height);
}
.lil-gui .lil-gui > .title[data-note]:before { margin-right: -6px; }
.lil-gui .lil-gui > .title[data-note]::after {
    content: attr(data-note);
    margin-left: auto;
    padding: 0 4px;
    border: 1px solid currentColor;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 400;
    line-height: 13px;
    white-space: nowrap;
}
.lil-gui.root > .title[data-note] { display: block; }
.lil-gui.root > .title[data-note]:before { margin-right: 0; }
.lil-gui.root > .title[data-note]::after { content: none; }
`;
    document.head.appendChild(style);
}

/**
 * Set, change or remove the folder's title note. It writes to the page only when the text
 * changes, so it is safe to call on every refresh.
 * @param {string} [text] - the note; empty for none
 * @param {string} [tip] - a line for the folder's tooltip that says what the note means
 * @returns {GUI} this
 */
GUI.prototype.setTitleNote = function (text, tip) {
    const title = this.$title;
    if (!title) return this;
    const note = text ? String(text) : "";
    if ((title.dataset.note ?? "") !== note) {
        if (note) {
            injectStyles();
            title.dataset.note = note;
        } else {
            delete title.dataset.note;
        }
    }
    const line = tip ? String(tip) : "";
    if ((this._titleNoteTip ?? "") !== line) {
        // A tooltip that was set before this file loaded, or straight on the element.
        if (this._tooltip === undefined) this._tooltip = title.title || undefined;
        this._titleNoteTip = line;
        this.tooltip(this._tooltip);
    }
    return this;
};

/** The folder's title note, or "" when it has none. */
GUI.prototype.getTitleNote = function () {
    return this.$title?.dataset.note ?? "";
};
