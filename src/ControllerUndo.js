import {undoManager} from "./UndoManager";

// Only arm history from an input surface or an explicit API edit. Node updates,
// animation, linked controls and deserialization can all call setValue too.
export function bindControllerUndo(controller, capture, restore) {
    if (!controller._undoBinding) listenForControllerEdit(controller, controller);
    controller._undoBinding = {capture, restore};
}

export function listenForControllerEdit(surface, source) {
    source = source._undoSource ?? source;
    if (surface !== source) surface._undoSource = source;
    const begin = event => {
        if (event.type === "pointerdown" && event.button > 0) return;
        beginControllerEdit(source);
        const pending = source._pendingUndo;
        if (!pending) return;
        const releaseIdle = () => {
            if (source._pendingUndo === pending && !pending.changed) source._pendingUndo = null;
        };
        if (event.type === "pointerdown") {
            const doc = surface.domElement.ownerDocument;
            const end = () => {
                doc.removeEventListener("pointerup", end, true);
                doc.removeEventListener("pointercancel", end, true);
                queueMicrotask(releaseIdle);
            };
            doc?.addEventListener("pointerup", end, true);
            doc?.addEventListener("pointercancel", end, true);
        } else queueMicrotask(releaseIdle);
    };
    for (const event of ["pointerdown", "keydown", "wheel", "input", "change", "dblclick"]) {
        surface.domElement?.addEventListener?.(event, begin, true);
    }
}

export function beginControllerEdit(source) {
    source = source._undoSource ?? source;
    const binding = source._undoBinding;
    if (!binding || source._pendingUndo?.changed || undoManager.isUndoing || undoManager.isRedoing) return;
    source._pendingUndo = {before: binding.capture(), changed: false};
}

export function finishControllerEdit(source) {
    source = source._undoSource ?? source;
    const pending = source._pendingUndo;
    source._pendingUndo = null;
    if (!pending?.changed) return;
    const {capture, restore} = source._undoBinding;
    undoManager.recordState(source._name || source.property, pending.before, capture(), restore);
}
