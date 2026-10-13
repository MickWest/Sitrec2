// VideoNoisePattern - the Video > Forensics > "Noise Pattern Detection" control.
//
// This file is small and is always loaded. The results window, the analysis, the charts
// and the workers are loaded on first use only: src/videoNoisePattern/ comes in with a
// dynamic import when the window is first shown, and it starts the workers.

import {Globals, NodeMan, setRenderOne} from "./Globals";
import {ViewMan} from "./CViewManager";
import {t} from "./i18n";

const VIEW_ID = "videoNoisePattern";
export const NOISE_PATTERN_DEFAULTS = {longestLag: 256, detail: 8, vertical: 0, held: "leave", frames: "all", searchOn: "fastest", offsetSearch: true};
let settings = {...NOISE_PATTERN_DEFAULTS};

// true from the moment the user asks for the window, so the checkbox does not flip back
// while the code loads
let wanted = false;
// set by the lazy module: stops its workers when the sitch changes
let teardown = null;

function currentView() {
    return NodeMan.get(VIEW_ID, false);
}

// Settings from a saved sitch, limited to the values the menu offers.
export function clampNoisePatternOptions(saved) {
    const o = {...NOISE_PATTERN_DEFAULTS, ...(saved ?? {})};
    const lag = Math.round(Number(o.longestLag));
    return {
        longestLag: Number.isFinite(lag) ? Math.max(32, Math.min(2000, lag)) : NOISE_PATTERN_DEFAULTS.longestLag,
        detail: Number(o.detail) === 4 ? 4 : 8,
        vertical: [0, 1, 3].includes(Number(o.vertical)) ? Number(o.vertical) : 0,
        held: o.held === "picture" ? "picture" : "leave",
        frames: o.frames === "ab" ? "ab" : "all",
        searchOn: ["fastest", "gpu", "cpu"].includes(o.searchOn) ? o.searchOn : "fastest",
        offsetSearch: o.offsetSearch !== false,
    };
}

export function setVideoNoisePatternTeardown(fn) {
    teardown = fn;
}

export function isVideoNoisePatternShown() {
    const view = currentView();
    return view ? !!view.visible : wanted;
}

export async function showVideoNoisePattern(show, savedState = null) {
    wanted = show;
    let view = currentView();
    if (!view) {
        if (!show) return;
        const generation = Globals.loadGeneration;
        const {createVideoNoisePatternView} = await import("./videoNoisePattern/CNodeVideoNoisePatternView");
        // Another sitch started to load, or the user cleared the checkbox, during the import.
        if (Globals.loadGeneration !== generation || !wanted) return;
        view = currentView() ?? createVideoNoisePatternView(VIEW_ID, settings);
    }
    if (savedState) view.modDeserialize(savedState);
    view.show(show);
    // Restore runs after fullscreen: a window covered by fullscreen when it was saved
    // stays covered.
    if (show && savedState?.fullscreenSuppressed && ViewMan.fullscreenView) {
        ViewMan.fullscreenSuppressed.add(view);
    }
    wanted = false;
    setRenderOne();
}

// Run (again) with the current settings, opening the window when it is closed.
async function runNoisePattern(action = "run") {
    const view = currentView();
    if (!view || !view.visible) {
        await showVideoNoisePattern(true);
        if (action === "run") return;
    }
    const shown = currentView();
    if (action === "benchmark") shown?.benchmark();
    else shown?.run(true);
}

export function addVideoNoisePatternMenu(folder) {
    const proxy = {
        get show() { return isVideoNoisePatternShown(); },
        set show(value) { showVideoNoisePattern(value); },
        run() { runNoisePattern("run"); },
        stop() { currentView()?.stop(); },
        exportCSV() { currentView()?.exportCSV(); },
        benchmark() { runNoisePattern("benchmark"); },
        async folderScan() {
            const {showNoisePatternFolderScan} = await import("./videoNoisePattern/NoisePatternFolderScanUI");
            return showNoisePatternFolderScan(() => ({...(currentView()?.options ?? settings)}));
        },
    };
    const controls = folder.addFolder(t("videoNoisePattern.menu.label")).close().perm();
    controls.add(proxy, "show")
        .name(t("videoNoisePattern.menu.label"))
        .tooltip(t("videoNoisePattern.menu.tooltip"))
        .listen()
        .perm()
        .asFolderToggle();
    for (const key of Object.keys(NOISE_PATTERN_DEFAULTS)) {
        Object.defineProperty(proxy, key, {
            get() { return (currentView()?.options ?? settings)[key]; },
            set(value) {
                settings[key] = value;
                const view = currentView();
                if (view) {
                    view.options[key] = value;
                    view.settingsChanged();
                }
                setRenderOne();
            },
        });
    }
    const s = (key) => t(`videoNoisePattern.settings.${key}`);
    controls.add(proxy, "longestLag", 32, 2000, 1).name(s("longestLag")).tooltip(s("longestLagTooltip")).listen().perm();
    controls.add(proxy, "detail", {[s("detailFast")]: 8, [s("detailFine")]: 4})
        .name(s("detail")).tooltip(s("detailTooltip")).listen().perm();
    controls.add(proxy, "vertical", {[s("verticalOff")]: 0, [s("verticalOne")]: 1, [s("verticalThree")]: 3})
        .name(s("vertical")).tooltip(s("verticalTooltip")).listen().perm();
    controls.add(proxy, "offsetSearch").name(s("offsetSearch")).tooltip(s("offsetSearchTooltip")).listen().perm();
    controls.add(proxy, "held", {[s("heldLeave")]: "leave", [s("heldPicture")]: "picture"})
        .name(s("held")).tooltip(s("heldTooltip")).listen().perm();
    controls.add(proxy, "frames", {[s("framesAll")]: "all", [s("framesAB")]: "ab"})
        .name(s("frames")).tooltip(s("framesTooltip")).listen().perm();
    controls.add(proxy, "searchOn", {[s("searchFastest")]: "fastest", [s("searchGPU")]: "gpu", [s("searchCPU")]: "cpu"})
        .name(s("searchOn")).tooltip(s("searchOnTooltip")).listen().perm();
    controls.add(proxy, "run").name(s("run")).tooltip(s("runTooltip")).perm();
    controls.add(proxy, "stop").name(s("stop")).perm();
    controls.add(proxy, "exportCSV").name(s("exportCSV")).tooltip(s("exportTooltip")).perm();
    controls.add(proxy, "benchmark").name(s("benchmark")).tooltip(s("benchmarkTooltip")).perm();
    controls.add(proxy, "folderScan").name(t("videoNoisePattern.folderScan.title"))
        .tooltip(t("videoNoisePattern.folderScan.tooltip")).perm().keepLiveWhenFolderOff();
}

// The window is made on demand, so it is not saved as a node mod. A sitch saves this
// record (geometry, theme, settings and the selected pair, never the results) only while
// the window is shown.
export function serializeVideoNoisePattern() {
    const view = currentView();
    if (!view || !view.visible) return undefined;
    const state = view.modSerialize();
    state.fullscreenSuppressed = !!ViewMan.fullscreenView && ViewMan.fullscreenSuppressed.has(view);
    delete state.rootTestRemove;
    return state;
}

export function deserializeVideoNoisePattern(state) {
    if (state?.visible) return showVideoNoisePattern(true, state);
}

// Called when the nodes of a sitch are disposed.
export function resetVideoNoisePattern() {
    wanted = false;
    settings = {...NOISE_PATTERN_DEFAULTS};
    teardown?.();
}
