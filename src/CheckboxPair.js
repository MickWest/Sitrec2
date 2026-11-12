// Two independent Main/Look booleans on one row, with an optional third for the
// video view. Keep ordinary controllers so saving, menu APIs, mirrors, disabled
// states and checkbox drag painting work.
import GUI, {Controller} from "./js/lil-gui.esm";

const STYLE_ID = "lil-checkbox-pair-style";

function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
.lil-gui .lil-checkbox-pair {
    gap: var(--spacing);
}
.lil-gui .lil-checkbox-pair > .lil-checkbox-pair-name { flex: 1; min-width: 0; }
.lil-gui .lil-checkbox-pair > .controller.boolean {
    flex: 0 0 auto;
    width: auto;
    margin: 0;
    padding: 0;
}
.lil-gui .lil-checkbox-pair > .controller.boolean > .name { display: none; }
.lil-gui .lil-checkbox-pair > .controller.boolean > .widget {
    position: relative;
    flex: 0 0 auto;
    width: var(--checkbox-size);
}
.lil-gui .lil-checkbox-pair-letter {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
    font-size: calc(var(--checkbox-size) * 0.7);
    line-height: 1;
    opacity: 0.45;
}
.lil-gui .lil-checkbox-pair input:checked + .lil-checkbox-pair-letter { opacity: 0; }
`;
    document.head.appendChild(style);
}

// Pair existing controllers, including controls on different view/node objects.
// The outer .controller inherits the same spacing and height as every menu row;
// only its inner controllers suppress their own margins and padding.
// An optional Video controller goes first, so the boxes read V M L.
export function pairCheckboxControllers(main, look, name, video = null) {
    const existing = main._checkboxPair;
    if (existing && existing === look._checkboxPair && existing.video === video) return existing;
    const members = video ? [video, main, look] : [main, look];
    for (const controller of members) controller._checkboxPair?.remove();
    injectStyles();
    const gui = main.parent;
    const row = document.createElement("div");
    row.className = "controller lil-checkbox-pair";
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", name);
    const caption = document.createElement("span");
    caption.className = "name lil-checkbox-pair-name";
    caption.textContent = name;
    row.appendChild(caption);
    const first = [...gui.$children.children].find(el => members.some(c => c.domElement === el));
    gui.$children.insertBefore(row, first);

    let active = true;
    const cleanups = [];
    const pair = {main, look, video, domElement: row, remove() {
        if (!active) return;
        if (main._folderToggleOptions?.paired) main._removeFolderToggle?.();
        active = false;
        for (const controller of members) {
            if (controller.domElement.parentNode === row) gui.$children.insertBefore(controller.domElement, row);
            delete controller._checkboxPair;
        }
        for (const cleanup of cleanups) cleanup();
        row.remove();
    }};
    const sync = () => {
        if (!active) return;
        const live = members.filter(c => gui.controllers.includes(c));
        if (live.length < 2) { pair.remove(); return; }
        row.style.display = live.some(c => !c._hidden) ? "" : "none";
    };
    for (const controller of members) {
        const letter = controller === video ? "V" : controller === main ? "M" : "L";
        controller._checkboxPair = pair;
        controller.listen();
        row.appendChild(controller.domElement);
        controller.domElement.title ||= controller._name;
        const marker = document.createElement("span");
        marker.className = "lil-checkbox-pair-letter";
        marker.textContent = letter;
        marker.setAttribute("aria-hidden", "true");
        controller.$widget.appendChild(marker);

        // The generic menu shortcut handler consumes Space. Allow native-style
        // keyboard toggling here without also firing a scene playback shortcut.
        const keydown = event => {
            if (event.code === "Space" || event.key === " ") {
                event.preventDefault();
                event.stopPropagation();
                if (!event.repeat) controller.$input.click();
            }
        };
        const keyup = event => {
            if (event.code === "Space" || event.key === " ") event.stopPropagation();
        };
        controller.$input.addEventListener("keydown", keydown);
        controller.$input.addEventListener("keyup", keyup);
        cleanups.push(() => {
            marker.remove();
            controller.$input.removeEventListener("keydown", keydown);
            controller.$input.removeEventListener("keyup", keyup);
        });
        for (const method of ["show", "destroy"]) {
            const inherited = controller[method];
            controller[method] = function (...args) {
                const result = inherited.apply(this, args);
                sync();
                return result;
            };
        }
    }
    sync();
    return pair;
}

// Register one side as its owning view is constructed. Pair only Main and Look
// controls with the same key in the same folder. Other views retain normal rows.
// Destroying either side restores the survivor's normal row; a replacement can
// pair with it again without leaving stale controllers or duplicate callbacks.
//
// A control of the video view joins the Main/Look row as a third box only when it
// asks to with joinVideo. Other video controls with the same key keep normal rows.
Controller.prototype.asViewCheckbox = function (viewId, name, key = name, joinVideo = false) {
    const member = viewId === "mainView" || viewId === "lookView" || (viewId === "video" && joinVideo);
    if (!member) return this;
    if (this.$input?.type !== "checkbox") return this;
    this._viewCheckbox = {viewId, name, key, joinVideo};
    const find = id => id === viewId ? this : this.parent.controllers.find(c =>
        c._viewCheckbox?.key === key && c._viewCheckbox.viewId === id) ?? null;
    const main = find("mainView"), look = find("lookView");
    if (main && look) pairCheckboxControllers(main, look, name, find("video"));
    return this;
};

// Convenience for properties on one object. Both APIs use the same row.
// videoProperty adds the third box, for the video view.
GUI.prototype.addCheckboxPair = function (object, mainProperty, lookProperty, name, videoProperty) {
    if (videoProperty !== undefined) {
        this.add(object, videoProperty).name(`${name} in Video`).listen()
            .asViewCheckbox("video", name, name, true);
    }
    const main = this.add(object, mainProperty).name(`${name} in Main`).listen()
        .asViewCheckbox("mainView", name);
    const look = this.add(object, lookProperty).name(`${name} in Look`).listen()
        .asViewCheckbox("lookView", name);
    return main._checkboxPair;
};
