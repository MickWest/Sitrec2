// VideoQPGraph - the Video > Forensics > "QP Graph" control.
//
// This file is small and is always loaded. The graph view, the analysis and the
// H.264 bitstream parser are loaded on first use only:
//   - src/videoQP/ comes in with a dynamic import when the graph is first shown
//   - the parser is only imported by the worker (src/workers/H264QPWorker.js)

import {Globals, NodeMan, setRenderOne} from "./Globals";
import {ViewMan} from "./CViewManager";
import {t} from "./i18n";

const VIEW_ID = "videoQPGraph";

// true from the moment the user asks for the graph, so the checkbox does not
// flip back while the code loads
let wanted = false;

function currentView() {
    return NodeMan.get(VIEW_ID, false);
}

export function isVideoQPGraphShown() {
    const view = currentView();
    return view ? !!view.visible : wanted;
}

export async function showVideoQPGraph(show, savedState = null) {
    wanted = show;
    let view = currentView();
    if (!view) {
        if (!show) return;
        const generation = Globals.loadGeneration;
        const {createVideoQPGraphView} = await import("./videoQP/CNodeVideoQPGraphView");
        // Another sitch started to load, or the user cleared the checkbox, during the import.
        if (Globals.loadGeneration !== generation || !wanted) return;
        view = currentView() ?? createVideoQPGraphView(VIEW_ID);
    }
    if (savedState) view.modDeserialize(savedState);
    view.show(show);
    // Restore runs after fullscreen. Older saves carry only visible:true, so
    // show their graph; new saves also distinguish a graph covered by fullscreen
    // from one deliberately opened on top of it.
    if (show && savedState?.fullscreenSuppressed && ViewMan.fullscreenView) {
        ViewMan.fullscreenSuppressed.add(view);
    }
    wanted = false;
    setRenderOne();
}

export function addVideoQPGraphMenu(folder) {
    const proxy = {
        get show() { return isVideoQPGraphShown(); },
        set show(value) { showVideoQPGraph(value); },
    };
    folder.add(proxy, "show")
        .name(t("videoQP.menu.label"))
        .tooltip(t("videoQP.menu.tooltip"))
        .listen()
        .perm();
}

// The view is made on demand, so it is not saved as a node mod. A sitch saves this
// record only while the graph is shown.
export function serializeVideoQPGraph() {
    const view = currentView();
    if (!view || !view.visible) return undefined;
    const state = view.modSerialize();   // geometry, and the theme when it is not the global one
    state.fullscreenSuppressed = !!ViewMan.fullscreenView && ViewMan.fullscreenSuppressed.has(view);
    delete state.rootTestRemove;
    return state;
}

export function deserializeVideoQPGraph(state) {
    if (state?.visible) return showVideoQPGraph(true, state);
}

// Called when the nodes of a sitch are disposed.
export function resetVideoQPGraph() {
    wanted = false;
}
