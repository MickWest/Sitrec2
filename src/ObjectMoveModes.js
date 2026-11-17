import {markSitchDirty, setRenderOne} from './Globals';

export const OBJECT_MOVE_MODES = ['surface', 'lookCameraPlane', 'push', 'screenPlane'];
let mode = 'surface';
const listeners = new Set();

export function getObjectMoveMode() { return mode; }

export function setObjectMoveMode(value, {userAction = false} = {}) {
    if (!OBJECT_MOVE_MODES.includes(value) || value === mode) return;
    mode = value;
    if (userAction) markSitchDirty();
    for (const listener of listeners) listener(mode);
    setRenderOne(true);
}

export function cycleObjectMoveMode() {
    setObjectMoveMode(OBJECT_MOVE_MODES[(OBJECT_MOVE_MODES.indexOf(mode) + 1) % OBJECT_MOVE_MODES.length],
        {userAction: true});
}

export function subscribeObjectMoveMode(listener) {
    listeners.add(listener);
    listener(mode);
    return () => listeners.delete(listener);
}
