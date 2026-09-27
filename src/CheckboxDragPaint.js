// Drag to set several checkboxes at once.
//
// Press a checkbox in any lil-gui menu and, still holding the button, drag over other
// checkboxes: each one you pass over is set to the state the first one is changing TO. Release
// ends it. Press and release on one checkbox without dragging is an ordinary click.
//
// Covers every lil-gui boolean row (the whole row is a <label>, so the row counts as well as the
// box) and every folder title checkbox (FolderToggle.js). Each checkbox is set by dispatching
// the same `change` event a click produces, so its controller's setValue, onChange side effect,
// finish callback and mirrors all run exactly as for a click. Disabled boxes and rows in a
// folder that is switched off (inert) are skipped.
//
// The pressed checkbox is not changed on press — a plain click must still work. It is set when
// the drag first reaches another checkbox. After a drag, the click that the browser may still
// deliver on release (when the pointer comes back to the pressed row) is cancelled, or it would
// toggle that checkbox back.

let paint = null;   // {first, state, done: Set<input>, dragged}
let cancelClick = null;

function stopCancellingClicks() {
    if (!cancelClick) return;
    document.removeEventListener("click", cancelClick, {capture: true});
    cancelClick = null;
}

function checkboxAt(target) {
    if (!(target instanceof Element)) return null;
    if (!target.closest(".lil-gui")) return null;
    if (target.matches?.('input[type="checkbox"]')) return target;
    const row = target.closest(".controller.boolean");
    return row ? row.querySelector('input[type="checkbox"]') : null;
}

function usable(input) {
    return input && !input.disabled && !input.closest("[inert]");
}

function setTo(input, state) {
    if (paint.done.has(input)) return;
    paint.done.add(input);
    if (input.checked === state) return;
    input.checked = state;
    input.dispatchEvent(new Event("change", {bubbles: true}));
}

function onPointerDown(event) {
    stopCancellingClicks();     // a new press is never the tail of the last drag
    if (event.button !== 0) return;
    const input = checkboxAt(event.target);
    if (!usable(input)) return;
    paint = {first: input, state: !input.checked, done: new Set(), dragged: false};
}

function onPointerMove(event) {
    if (!paint) return;
    if ((event.buttons & 1) === 0) { paint = null; return; }
    const input = checkboxAt(document.elementFromPoint(event.clientX, event.clientY));
    if (!usable(input) || input === paint.first) return;
    if (!paint.dragged) {
        paint.dragged = true;
        setTo(paint.first, paint.state);
    }
    setTo(input, paint.state);
}

function onPointerUp() {
    if (!paint) return;
    const dragged = paint.dragged;
    paint = null;
    if (!dragged) return;
    // The click (if any) comes after pointerup in the same task; drop it, then stop watching.
    stopCancellingClicks();
    cancelClick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        stopCancellingClicks();
    };
    document.addEventListener("click", cancelClick, {capture: true});
    setTimeout(stopCancellingClicks, 0);
}

export function installCheckboxDragPaint(doc = document) {
    if (doc._checkboxDragPaintInstalled) return;
    doc._checkboxDragPaintInstalled = true;
    doc.addEventListener("pointerdown", onPointerDown, true);
    doc.addEventListener("pointermove", onPointerMove, true);
    doc.addEventListener("pointerup", onPointerUp, true);
    doc.addEventListener("pointercancel", () => { paint = null; }, true);
}

if (typeof document !== "undefined") installCheckboxDragPaint(document);
