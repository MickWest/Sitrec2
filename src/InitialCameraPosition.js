// Whether text navigation may place a look camera that has not been positioned
// independently. Runtime-only: a saved scene's observer is always protected.
const initialPositions = new WeakMap();
export const TEXT_LOCATION_HEIGHT_METERS = 10 * 0.3048;

const snapshot = position => ({lla: position._LLA?.slice(), agl: position.agl});
function unchanged(position, state) {
    return state.lla?.length === 3 && position._LLA?.length === 3
        && state.agl === position.agl
        && state.lla.every((value, index) => Math.abs(value - position._LLA[index]) < (index === 2 ? 1e-4 : 1e-9));
}

export function beginInitialCameraPosition(position, allowed) {
    if (position) initialPositions.set(position, {...snapshot(position), allowed: !!allowed, applying: false});
}

export function noteCameraPositionChange(position, sourceChanged = false) {
    const state = initialPositions.get(position);
    if (state && !state.applying && (sourceChanged || !unchanged(position, state))) state.allowed = false;
}

export function canPlaceInitialCamera(position, source, freeLook = false) {
    const state = initialPositions.get(position);
    if (!state?.allowed) return false;
    if (source !== 'fixedCamera' || freeLook || !unchanged(position, state)) state.allowed = false;
    return state.allowed;
}

// Geolocation and these initial text placements are allowed starting positions.
// They do not erase a previous manual edit, nor make saved work eligible again.
export function withInitialCameraPlacement(position, apply) {
    const state = initialPositions.get(position);
    noteCameraPositionChange(position);
    if (state) state.applying = true;
    try { return apply(); }
    finally {
        if (state) Object.assign(state, snapshot(position), {applying: false});
    }
}
