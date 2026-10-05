// The frame slider's right-click menu: add, rename, go to and delete timeline
// markers, and reset the In/Out (A-B) range. Every edit goes on the undo stack.
// Kept out of CNodeFrameSlider so the slider only decides where the click
// landed; the slider passes in the frame under the cursor and the marker there.

import {EventManager} from "./CEventManager";
import {GlobalDateTimeNode, Globals, setRenderOne, Sit, UndoManager} from "./Globals";
import {t} from "./i18n";
import {par} from "./par";
import {showConfirm} from "./showError";
import {TimelineMarkers} from "./TimelineMarkers";

// The name shown for a marker: its label, or its frame when it has none.
export function markerDisplayName(marker) {
    return marker.label || t("timelineMarkers.unnamed", {frame: marker.frame});
}

// Run a change to the markers and record it for undo if anything changed.
export function editTimelineMarkers(description, change) {
    const before = TimelineMarkers.snapshot();
    const version = TimelineMarkers.version;
    const result = change();
    if (TimelineMarkers.version !== version) {
        const after = TimelineMarkers.snapshot();
        UndoManager?.add({
            undo: () => { TimelineMarkers.restore(before); setRenderOne(true); },
            redo: () => { TimelineMarkers.restore(after); setRenderOne(true); },
            description,
        });
    }
    setRenderOne(true);
    return result;
}

// Jump the playhead to a frame and pause, as a click on the slider does.
export function goToTimelineFrame(frame) {
    if (par.playbackLocked) return;
    par.frame = Math.max(0, Math.min(Sit.frames - 1, Math.round(frame)));
    par.paused = true;
    if (GlobalDateTimeNode) GlobalDateTimeNode.liveMode = false;
    setRenderOne(true);
}

export function inOutIsReset() {
    return Sit.aFrame === 0 && Sit.bFrame === Sit.frames - 1;
}

// In back to the first frame and Out to the last, undoably.
export function resetInOut() {
    if (inOutIsReset()) return;
    const before = {a: Sit.aFrame, b: Sit.bFrame};
    const apply = ({a, b}) => {
        Sit.aFrame = a;
        Sit.bFrame = b;
        EventManager.dispatchEvent("abFrameChanged");
        setRenderOne(true);
    };
    const after = {a: 0, b: Sit.frames - 1};
    apply(after);
    UndoManager?.add({undo: () => apply(before), redo: () => apply(after), description: t("timelineMarkers.resetInOut")});
}

// cursorFrame: the frame under the pointer. marker: the marker under the
// pointer, or null.
export function showTimelineMenu(event, cursorFrame, marker) {
    const currentFrame = Math.round(par.frame);
    // createStandaloneMenu sets its title with innerHTML, and a label can come
    // from a loaded sitch file, so it gets only the numeric title; a marker's
    // name goes in through title(), which sets textContent.
    const menu = Globals.menuBar?.createStandaloneMenu(t("timelineMarkers.menuTitle", {frame: Math.round(cursorFrame)}),
        event.clientX, event.clientY, true, true);
    if (!menu) return null;
    if (marker) menu.title(t("timelineMarkers.markerTitle", {name: markerDisplayName(marker)}));

    const item = (parent, label, action, enabled = true) => {
        const controller = parent.add({run: () => {
            menu.destroy();
            if (enabled) action();
            setRenderOne(true);
        }}, "run").name(label);
        if (!enabled) controller.disable();
        return controller;
    };

    if (marker) {
        // The label applies as it is typed. A context menu closes on an outside
        // click by removing its DOM, and a removed text field gets no blur, so
        // onFinishChange would lose the edit; instead the whole edit becomes
        // one undo step when the menu closes, however it closes.
        const state = {label: marker.label};
        menu.add(state, "label").name(t("timelineMarkers.label")).onChange(value => {
            TimelineMarkers.rename(marker.frame, value);
            menu.title(t("timelineMarkers.markerTitle", {name: markerDisplayName({...marker, label: value})}));
            setRenderOne(true);
        });
        const destroy = menu.destroy.bind(menu);
        let recorded = false;
        menu.destroy = (...args) => {
            const final = TimelineMarkers.get(marker.frame);
            if (!recorded && final && final.label !== marker.label) {
                recorded = true;
                UndoManager?.add({
                    undo: () => { TimelineMarkers.rename(marker.frame, marker.label); setRenderOne(true); },
                    redo: () => { TimelineMarkers.rename(marker.frame, final.label); setRenderOne(true); },
                    description: t("timelineMarkers.undoRename"),
                });
            }
            return destroy(...args);
        };
        item(menu, t("timelineMarkers.goToMarker"), () => goToTimelineFrame(marker.frame), !par.playbackLocked);
        item(menu, t("timelineMarkers.deleteMarker"),
            () => editTimelineMarkers(t("timelineMarkers.undoDelete"), () => TimelineMarkers.remove(marker.frame)));
    }

    item(menu, t("timelineMarkers.addAtCurrent", {frame: currentFrame}),
        () => editTimelineMarkers(t("timelineMarkers.undoAdd"), () => TimelineMarkers.add(currentFrame)),
        !TimelineMarkers.get(currentFrame));
    if (cursorFrame !== currentFrame && !marker) {
        item(menu, t("timelineMarkers.addHere", {frame: cursorFrame}),
            () => editTimelineMarkers(t("timelineMarkers.undoAdd"), () => TimelineMarkers.add(cursorFrame)),
            !TimelineMarkers.get(cursorFrame));
    }

    const markers = TimelineMarkers.list();
    if (markers.length) {
        const folder = menu.addFolder(t("timelineMarkers.goToFolder", {count: markers.length}));
        for (const entry of markers) {
            item(folder, t("timelineMarkers.goToEntry", {name: markerDisplayName(entry), frame: entry.frame}),
                () => goToTimelineFrame(entry.frame), !par.playbackLocked);
        }
        if (markers.length > 8) folder.close();
        item(menu, t("timelineMarkers.deleteAll"), async () => {
            const ok = await showConfirm(t("timelineMarkers.deleteAllConfirm", {count: markers.length}),
                {title: t("timelineMarkers.deleteAllTitle")});
            if (ok) editTimelineMarkers(t("timelineMarkers.undoDeleteAll"), () => TimelineMarkers.clear());
        });
    }

    item(menu, t("timelineMarkers.resetInOut"), resetInOut, !inOutIsReset());

    menu.open();
    // createStandaloneMenu sized the empty menu; the slider is at the bottom
    // of the screen, so re-fit now the rows are in.
    Globals.menuBar.ensureMenuOnScreen?.(menu._standaloneContainer);
    return menu;
}
