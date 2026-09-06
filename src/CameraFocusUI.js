import {Globals, NodeMan, TrackManager, setRenderOne} from "./Globals";

// Use the position controller's frame-based track, not findRootTrack(): the
// latter returns raw MISB samples whose indices need not match video frames.
export function objectFocusTrack(object) {
    const controller = Object.values(object.inputs ?? {}).find(input =>
        input?.isController && input.inputs?.sourceTrack && input.enabled !== false);
    return controller?.inputs.sourceTrack ?? object.inputs?.track ?? object;
}

function selectedTrack(track) {
    const seen = new Set();
    while (track && !seen.has(track)) {
        seen.add(track);
        const selected = track.choice !== undefined ? track.inputs?.[track.choice] : null;
        if (!selected) break;
        track = selected;
    }
    return track;
}

export function sameFocusTrack(a, b) {
    return !!a && !!b && selectedTrack(a) === selectedTrack(b);
}

const cameraTrackControls = {
    focusCameraHere: {
        viewProperty: "focusTrackName", label: "Focus Camera Here",
        tooltip: "Keep the main camera looking at this track and orbiting around it.",
    },
    followCameraHere: {
        viewProperty: "lockTrackName", label: "Follow Camera Here",
        tooltip: "Move the main camera with this track's position and heading (View > Lock Track).",
    },
};

function addCameraTrackControl(node, gui, target, property) {
    const {viewProperty, label, tooltip} = cameraTrackControls[property];
    node._cameraFocusTarget = target;
    node[property] = false;
    node[`${property}Controller`] = gui.add(node, property)
        .name(label).listen().tooltip(tooltip)
        .onChange(enabled => {
            const view = NodeMan.get("mainView", false);
            if (!view) return;
            if (enabled) view[viewProperty] = target()?.id ?? "default";
            else if (sameFocusTrack(NodeMan.get(view[viewProperty], false), target())) {
                view[viewProperty] = "default";
            }
            syncCameraFocusUI();
            setRenderOne(true);
        });
    requestCameraFocusSync();
    return node[`${property}Controller`];
}

export function addCameraFocusControl(node, gui, target) {
    return addCameraTrackControl(node, gui, target, "focusCameraHere");
}

export function addCameraFollowControl(node, gui, target) {
    return addCameraTrackControl(node, gui, target, "followCameraHere");
}

// Imported/generated tracks, every track with an edit/display menu (including
// hidden tracks), and objects' position tracks. Raw-data displays and smoothing
// intermediates are not additional user tracks.
export function cameraFocusOptions(base, nodes) {
    const options = {...base};
    delete options.select;
    if (!Object.values(options).includes("default")) options["Ground (no track)"] = "default";
    const ids = new Set(Object.values(options));
    const add = (track, label) => {
        if (!track?.id || ids.has(track.id) || !NodeMan.exists(track.id)) return;
        label = label || track.shortName || track.id;
        if (Object.hasOwn(options, label)) label = `${label} (${track.id})`;
        Object.defineProperty(options, label, {value: track.id, enumerable: true, configurable: true});
        ids.add(track.id);
    };
    TrackManager?.iterate((id, track) => add(track.trackNode, track.menuText));
    for (const node of nodes) {
        if (!node._cameraFocusTarget) continue;
        const track = node._cameraFocusTarget();
        if (track !== node) add(track);
    }
    return options;
}

let syncing = false;
let queued = false;

export function requestCameraFocusSync() {
    if (queued || Globals.disposing) return;
    queued = true;
    queueMicrotask(() => {
        queued = false;
        syncCameraFocusUI();
    });
    setRenderOne(true);
}

// Scan all sources, not just the open edit menu. Mirrors bind the same node
// properties, so their .listen() controls follow the same selection. A per-frame
// call also catches restored state, changed switches and unmanaged track edits.
export function syncCameraFocusUI() {
    if (syncing || Globals.disposing || !NodeMan) return;
    syncing = true;
    try {
        const nodes = Object.values(NodeMan.list).map(entry => entry.data);
        for (const view of nodes) {
            if (!view._baseFocusTracks) continue;
            const options = cameraFocusOptions(view._baseFocusTracks, nodes);
            for (const property of ["focusTrackName", "lockTrackName"]) {
                const id = view[property];
                // A saved selection can arrive before its imported track. Only
                // clear a track we have actually seen disappear.
                if (view._knownFocusTracks?.has(id) && !NodeMan.exists(id)) view[property] = "default";
                const selected = NodeMan.get(view[property], false);
                if (selected && !Object.values(options).includes(selected.id)) {
                    options[`${selected.shortName || selected.id} (selected)`] = selected.id;
                }
            }
            const signature = JSON.stringify(options);
            if (signature !== view._focusOptionsSignature) {
                view._focusOptionsSignature = signature;
                view.refreshFocusTrackMenus(options);
            }
            view._knownFocusTracks = new Set(Object.values(options).filter(id => NodeMan.exists(id)));
            view.focusTrackController?.updateDisplay();
            view.lockTrackController?.updateDisplay();
        }
        const mainView = NodeMan.get("mainView", false);
        const selections = Object.entries(cameraTrackControls).map(([property, {viewProperty}]) =>
            [property, mainView && NodeMan.get(mainView[viewProperty], false)]);
        for (const node of nodes) {
            if (!node._cameraFocusTarget) continue;
            const target = node._cameraFocusTarget();
            for (const [property, selected] of selections) {
                const enabled = sameFocusTrack(selected, target);
                if (node[property] !== enabled) {
                    node[property] = enabled;
                    node[`${property}Controller`]?.updateDisplay();
                }
            }
        }
    } finally {
        syncing = false;
    }
}
