// A folder's own on/off checkbox, drawn at the right end of its title row.
//
// Many folders hold one boolean that switches the whole thing on or off — "Visible", "Show",
// "Enable ..." — as an ordinary row inside the folder. `controller.asFolderToggle()` promotes
// that row to the folder's title bar:
//
//   folder.add(node, "visible").name("Visible").onChange(...).asFolderToggle()
//
// The checkbox is only a VIEW of the existing controller. The controller stays in the folder
// (its row is hidden with a CSS class, not with hide()), so it is still the one piece of state
// and everything that already works on it keeps working: its onChange side effect, `.listen()`
// polling, `.shareAs()` twins in the view header menus (MenuMirror), the setMenuValue API, and
// saving. Clicking the checkbox does what clicking the row did (setValue, then the finish
// callback); any change to the value, from anywhere, reaches the checkbox through the
// controller's updateDisplay(). Promotion turns `.listen()` on, so a write that bypasses every
// controller still reaches the checkbox.
//
// Why hidden with a class and not hide(): MenuMirror patches a source's show()/hide() to hide
// its twins too, so hide() would also remove the row from every view header menu.
//
// Why a sibling of $title and not inside it: lil-gui's title() rewrites $title.textContent,
// and the menu bar reads $title.innerHTML/innerText as a folder's name and layout key. Being a
// sibling also keeps a click on the checkbox away from the title's open/close and drag handlers.
//
// OFF STATE. When the value is false, every row of the folder is faded and made `inert` — no
// clicks, no Tab focus, no keys — except rows marked with `keepLiveWhenFolderOff()`, for
// controls that still do work while the switch is off (Name, Delete, a "sync camera" button).
// The marking is done per ROW, not on the .children box, so that:
//   - an exempt row inside a nested sub-folder is found (the walk goes into sub-folders that
//     hold one) and stays at full opacity;
//   - a nested folder's own title checkbox is blocked with the rest when the parent is off;
//   - in a popup the panel background (on .children) does not fade;
//   - no CSS rule has to out-rank the menu bar's `.root > .children` rules.
// Each control's own enabled/disabled state is untouched and comes back unchanged. Marks are
// reference-counted, because a nested toggle folder and its parent can mark the same row.
// Rows added while the folder is off are marked too (a MutationObserver on the rows).
//
// A root menu's title is a tab sized to its text (the menu bar sets its width), so there the
// checkbox goes just after the end of the TAB, not at the edge of the panel, and follows the
// tab when the title changes width. A torn-out folder is drawn the same way.
//
// Whole-folder copies (GUI.mirrorFolderFrom — object edit popups) promote the twin of a toggle
// in the copy, and MenuMirror's buildTwin carries the exemption to every twin.

import {Controller} from "./js/lil-gui.esm";

const STYLE_ID = "lil-folder-toggle-style";
const OFF_COUNT = "folderOffCount";      // dataset key: how many off folders mark this row

function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
.lil-gui.lil-has-folder-toggle:not(.root) { position: relative; }
.lil-gui.lil-has-folder-toggle:not(.root) > .title { padding-right: calc(var(--checkbox-size) + 2 * var(--padding)); }
.lil-gui > input.lil-folder-toggle {
    position: absolute;
    top: calc((var(--title-height) - var(--checkbox-size)) / 2);
    right: var(--padding);
    margin: 0;
    z-index: 1;
    /* a root menu's element is pointer-events:none, with only its title and rows turned back on */
    pointer-events: auto;
}
.lil-gui .controller.lil-folder-toggle-source { display: none; }
.lil-folder-faded { opacity: 0.4; }
.lil-folder-faded, .lil-folder-faded * { pointer-events: none !important; }
`;
    document.head.appendChild(style);
}

// --- marking the rows of an off folder ------------------------------------------------------

function mark(el, marked) {
    const count = Number(el.dataset[OFF_COUNT] ?? 0) + 1;
    el.dataset[OFF_COUNT] = String(count);
    el.classList.add("lil-folder-faded");
    el.setAttribute("inert", "");
    marked.push(el);
}

function unmark(el) {
    const count = Number(el.dataset[OFF_COUNT] ?? 1) - 1;
    if (count > 0) {
        el.dataset[OFF_COUNT] = String(count);
        return;
    }
    delete el.dataset[OFF_COUNT];
    el.classList.remove("lil-folder-faded");
    el.removeAttribute("inert");
}

// Mark every row element under `children` (a folder's .children element) except exempt ones.
// A sub-folder holding an exempt row is walked into: its title stays usable (it only opens and
// closes), its own title checkbox is blocked, and its rows are marked one by one.
function markRows(elements, marked) {
    for (const el of elements) {
        if (el.classList.contains("lil-keep-live")) continue;
        if (el.classList.contains("lil-gui") && el.querySelector(".lil-keep-live")) {
            const box = el.querySelector(":scope > input.lil-folder-toggle");
            if (box) mark(box, marked);
            const sub = el.querySelector(":scope > .children");
            if (sub) markRows(sub.children, marked);
            continue;
        }
        mark(el, marked);
    }
}

// --- the promotion ----------------------------------------------------------------------------

Controller.prototype.asFolderToggle = function () {
    const folder = this.parent;
    if (!folder || !folder.domElement) return this;
    if (folder._folderToggle === this) return this;
    // One toggle per folder: a second call with another controller replaces the first.
    folder._folderToggle?._removeFolderToggle?.();

    injectStyles();
    this.listen();

    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "lil-folder-toggle";
    box.setAttribute("aria-label", this._name ?? this.property);
    box.addEventListener("change", () => {
        this.setValue(box.checked);
        this._callOnFinishChange?.();
    });

    folder.domElement.insertBefore(box, folder.$children);
    folder.domElement.classList.add("lil-has-folder-toggle");
    this.domElement.classList.add("lil-folder-toggle-source");
    folder._folderToggle = this;
    this._folderToggleBox = box;

    let active = true;
    let marked = [];
    const clearMarks = () => {
        for (const el of marked) unmark(el);
        marked = [];
    };
    const applyMarks = (off) => {
        clearMarks();
        if (!off) return;
        // A torn-out sub-folder has left .children but still belongs to this folder.
        const detached = folder.folders
            .filter(f => f._detachedContainer && !folder.$children.contains(f.domElement))
            .map(f => f.domElement);
        markRows([...folder.$children.children, ...detached], marked);
    };

    let lastOff = null;
    const sync = () => {
        if (!active) return;
        const on = !!this.getValue();
        box.checked = on;
        box.disabled = !!this._disabled;
        box.style.display = this._hidden ? "none" : "";
        box.title = this._tooltip ?? this._name ?? "";
        folder.domElement.classList.toggle("lil-folder-off", !on);
        if (lastOff !== !on) {
            lastOff = !on;
            applyMarks(!on);
        }
    };
    folder._folderToggleResync = () => {
        if (!active) return;
        lastOff = null;
        sync();
    };

    // A root menu's title is a tab sized to its text; a folder is drawn as a root when it IS one
    // (a popup) and while it is torn out, which adds the "root" class without changing its
    // parent. So the placement follows the class and the tab's width. A full-width root title
    // (a plain lil-gui panel) keeps the CSS placement at the right edge.
    const place = () => {
        const title = folder.$title;
        const isTab = folder.domElement.classList.contains("root")
            && title.offsetWidth < folder.domElement.offsetWidth - box.offsetWidth - 8;
        if (isTab) {
            box.style.right = "auto";
            box.style.left = (title.offsetLeft + title.offsetWidth + 4) + "px";
        } else {
            box.style.left = "";
            box.style.right = "";
        }
    };
    const titleObserver = typeof ResizeObserver === "function" ? new ResizeObserver(place) : null;
    titleObserver?.observe(folder.$title);
    const classObserver = new MutationObserver(place);
    classObserver.observe(folder.domElement, {attributes: true, attributeFilter: ["class"]});
    // Rows added, removed or rebuilt while the folder is off must be marked (and unmarked) too.
    const rowObserver = new MutationObserver(() => folder._folderToggleResync?.());
    rowObserver.observe(folder.$children, {childList: true, subtree: true});
    place();

    // Per-instance wrappers. They are never unwrapped: restoring a saved method would throw away
    // anything wrapped on top later (MenuMirror's show() patch when .shareAs() comes after this).
    // After removal they only pass through, because sync() checks `active`.
    const inheritedUpdateDisplay = this.updateDisplay;
    this.updateDisplay = function (...args) {
        const result = inheritedUpdateDisplay.apply(this, args);
        sync();
        return result;
    };
    const inheritedDisable = this.disable;
    this.disable = function (...args) {
        const result = inheritedDisable.apply(this, args);
        sync();
        return result;
    };
    const inheritedShow = this.show;
    this.show = function (...args) {
        const result = inheritedShow.apply(this, args);
        sync();
        return result;
    };
    const inheritedTooltip = this.tooltip;
    if (typeof inheritedTooltip === "function") {
        this.tooltip = function (...args) {
            const result = inheritedTooltip.apply(this, args);
            sync();
            return result;
        };
    }

    this._removeFolderToggle = () => {
        active = false;
        titleObserver?.disconnect();
        classObserver.disconnect();
        rowObserver.disconnect();
        clearMarks();
        box.remove();
        folder.domElement.classList.remove("lil-has-folder-toggle", "lil-folder-off");
        this.domElement.classList.remove("lil-folder-toggle-source");
        if (folder._folderToggle === this) {
            folder._folderToggle = null;
            folder._folderToggleResync = null;
        }
        this._folderToggleBox = null;
        this._removeFolderToggle = null;
    };

    // lil-gui's destroy(all) keeps a .perm() controller unless `all` — a sitch change calls
    // destroy(false) on every menu — so the promotion must survive exactly when the row does.
    const inheritedDestroy = this.destroy;
    this.destroy = function (all = false, ...rest) {
        if (all || !this.permanent) this._removeFolderToggle?.();
        return inheritedDestroy.call(this, all, ...rest);
    };

    sync();
    return this;
};

// Mark a row that still does work while its folder's title checkbox is off (Name, Delete, a
// button that turns the switch on by itself). It stays at full opacity and takes input.
Controller.prototype.keepLiveWhenFolderOff = function () {
    this._keepLiveWhenFolderOff = true;
    this.domElement.classList.add("lil-keep-live");
    // Re-mark every toggled folder up the chain, since this row may sit in a nested sub-folder.
    for (let gui = this.parent; gui; gui = gui.parent) gui._folderToggleResync?.();
    return this;
};
