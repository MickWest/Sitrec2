// Who gets a key press when the focus is inside a native panel.
//
// The menus give a key back to the scene when the focused control is not a text
// field: the control loses focus and the key goes on to the document handler (see
// Controller in js/lil-gui.esm.js). So Space still plays, and comma and period still
// step a frame, after a click on a checkbox or a button.
//
// Native panels obey the same rule after a click. A panel keeps a key in two cases
// only: text entry, and a control that the keyboard itself moved the focus to (Tab),
// so that a panel can still be operated without a pointer.

const NON_TEXT_INPUTS = new Set(["checkbox", "radio", "button", "submit", "reset", "range", "color", "file", "image"]);
const watched = new WeakSet();      // documents that report pointer and Tab use
const released = new WeakSet();     // key events already given back to the scene
let keyboardFocus = false;          // true after Tab, false after a pointer press

export function isTextEntry(element) {
    const tag = element?.tagName?.toLowerCase();
    if (tag === "textarea" || element?.isContentEditable) return true;
    return tag === "input" && !NON_TEXT_INPUTS.has((element.type || "text").toLowerCase());
}

// The focus source is the last of the two: a pointer press, or Tab.
export function watchFocusSource(doc = document) {
    if (watched.has(doc)) return;
    watched.add(doc);
    doc.addEventListener("pointerdown", () => { keyboardFocus = false; }, true);
    doc.addEventListener("keydown", event => { if (event.key === "Tab") keyboardFocus = true; }, true);
}

// True when the panel keeps this key: the scene must not see it.
export function panelKeepsKey(event) {
    return !released.has(event) && (keyboardFocus || isTextEntry(event.target));
}

// Give the key to the scene, as the menus do: drop the focus and cancel the control's
// own action, but let the event continue to the document. Returns true when the key
// goes to the scene. It is safe to call again for the same event.
export function releaseKeyToScene(event) {
    if (released.has(event)) return true;
    if (panelKeepsKey(event)) return false;
    released.add(event);
    event.target.blur?.();
    event.preventDefault();
    return true;
}

// The usual pair of listeners for the root element of a native surface.
export function routeNativeKeys(element) {
    watchFocusSource(element.ownerDocument);
    element.addEventListener("keydown", event => { if (!releaseKeyToScene(event)) event.stopPropagation(); });
    element.addEventListener("keyup", event => { if (panelKeepsKey(event)) event.stopPropagation(); });
}
