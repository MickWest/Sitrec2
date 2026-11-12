// Two independent Main/Look booleans on one row. Keep ordinary controllers so
// saving, menu APIs, mirrors, disabled states and checkbox drag painting work.
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
// only its two inner controllers suppress their own margins and padding.
export function pairCheckboxControllers(main, look, name) {
    if (main._checkboxPair && main._checkboxPair === look._checkboxPair) return main._checkboxPair;
    main._checkboxPair?.remove();
    look._checkboxPair?.remove();
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
    const first = [...gui.$children.children].find(el => el === main.domElement || el === look.domElement);
    gui.$children.insertBefore(row, first);

    let active = true;
    const cleanups = [];
    const pair = {main, look, domElement: row, remove() {
        if (!active) return;
        if (main._folderToggleOptions?.paired) main._removeFolderToggle?.();
        active = false;
        for (const controller of [main, look]) {
            if (controller.domElement.parentNode === row) gui.$children.insertBefore(controller.domElement, row);
            delete controller._checkboxPair;
        }
        for (const cleanup of cleanups) cleanup();
        row.remove();
    }};
    const sync = () => {
        if (!active) return;
        const live = [main, look].filter(c => gui.controllers.includes(c));
        if (live.length < 2) { pair.remove(); return; }
        row.style.display = live.some(c => !c._hidden) ? "" : "none";
    };
    for (const [controller, letter] of [[main, "M"], [look, "L"]]) {
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
Controller.prototype.asViewCheckbox = function (viewId, name, key = name) {
    if (viewId !== "mainView" && viewId !== "lookView") return this;
    if (this.$input?.type !== "checkbox") return this;
    this._viewCheckbox = {viewId, name, key};
    const other = this.parent.controllers.find(c => c !== this
        && c._viewCheckbox?.key === key && c._viewCheckbox.viewId !== viewId);
    if (other) {
        const main = viewId === "mainView" ? this : other;
        const look = viewId === "lookView" ? this : other;
        pairCheckboxControllers(main, look, name);
    }
    return this;
};

// Convenience for two properties on one object. Both APIs use the same row.
GUI.prototype.addCheckboxPair = function (object, mainProperty, lookProperty, name) {
    const main = this.add(object, mainProperty).name(`${name} in Main`).listen()
        .asViewCheckbox("mainView", name);
    const look = this.add(object, lookProperty).name(`${name} in Look`).listen()
        .asViewCheckbox("lookView", name);
    return main._checkboxPair;
};
