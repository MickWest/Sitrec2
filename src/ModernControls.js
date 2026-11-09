import GUI from "./js/lil-gui.esm";
import "./MenuMirror";
import {registerGUIRoot, unregisterGUIRoot} from "./GUIRootRegistry";
import {modernControlStyle} from "./ModernControlStyle";

// Presentation only: keep the real controllers, including their keyboard editing,
// units, numeric drag/wrap/elastic behavior, callbacks and accessibility labels.
export function applyModernControls(gui, {embedded = false} = {}) {
    const doc = gui.domElement.ownerDocument;
    if (!doc.getElementById("sitrec-modern-controls-style")) {
        const style = doc.createElement("style");
        style.id = "sitrec-modern-controls-style";
        style.textContent = modernControlStyle;
        doc.head.append(style);
    }
    gui.domElement.classList.add("sitrec-modern");
    gui.domElement.dataset.interactionNative = "true";
    if (embedded) gui.domElement.classList.add("modern-embedded");
    return gui;
}

// A group can be embedded in any HTML layout; its controls come from mirrorTo().
// There is no second schema of labels, ranges, units or enabled-state rules.
export function createControlGroup(container, {beforeEdit, onChange} = {}) {
    const gui = applyModernControls(new GUI({container, autoPlace: false}), {embedded: true});
    if (beforeEdit) {
        gui.domElement.addEventListener("pointerdown", beforeEdit, true);
        gui.domElement.addEventListener("keydown", event => {
            if (!["Tab", "Escape", "Shift", "Control", "Alt", "Meta"].includes(event.key)) beforeEdit();
        }, true);
    }
    if (onChange) gui.onChange(onChange);
    registerGUIRoot(gui);
    const destroy = gui.destroy;
    gui.destroy = function (...args) {
        unregisterGUIRoot(this);
        return destroy.apply(this, args);
    };
    return gui;
}

export function setControlGroupActive(gui, active) {
    if (active) { registerGUIRoot(gui); gui.updateListeners(); }
    else unregisterGUIRoot(gui);
}
