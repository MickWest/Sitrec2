// Leaving track edit mode from anywhere other than the "Edit Track" checkbox: the edit menus,
// the point menu, and the Escape key. All of them come here so the three pieces of state
// (trackOb.editMode, the spline editor, Globals.editingTrack) always change together.

import {CustomManager, Globals, setRenderOne, TrackManager} from "./Globals";
import {t} from "./i18n";

// True when a panel mirroring `folder` is open. A track's panel and an object's panel can be
// open together, so every open persistent menu is checked.
export function isPanelShowing(folder) {
    if (!folder) return false;
    for (const menu of Globals.menuBar?.persistentMenus ?? []) {
        if (menu._mirrorSource === folder) return true;
    }
    return false;
}

// Show Track Menu, and Show Object Menu when an object rides the track, for both edit menus.
// Edit mode is modal, so right-clicking the track or its object does not open their menus
// while it is on; these open them without leaving it. A menu that is already open gets no
// item. Each is {label, action}.
export function trackAndObjectMenuActions(trackOb, clientX, clientY) {
    const actions = [];
    if (!isPanelShowing(trackOb.guiFolder)) {
        actions.push({
            label: t("custom.contextMenu.showTrackMenu"),
            action: () => CustomManager.showTrackMenu(
                {trackID: trackOb.trackID, guiFolder: trackOb.guiFolder, trackOb}, clientX, clientY),
        });
    }
    const object = TrackManager.objectForTrack(trackOb);
    if (object && !isPanelShowing(CustomManager.nodeEditFolder(object))) {
        actions.push({
            label: t("custom.contextMenu.showObjectMenu"),
            action: () => CustomManager.showNodeEditMenu(object, clientX, clientY),
        });
    }
    return actions;
}

export function exitTrackEditMode(trackOb = Globals.editingTrack) {
    if (!trackOb) return false;
    if (trackOb.setEditMode) {
        trackOb.setEditMode(false);
    } else {
        trackOb.editMode = false;
        trackOb.splineEditor?.setEnable(false);
        if (Globals.editingTrack === trackOb) Globals.editingTrack = null;
    }
    setRenderOne(true);
    return true;
}

// True when a right-click menu is on screen. Escape closes that menu first, so it leaves edit
// mode only when there is none. Persistent panels (the track's own folder, which is where edit
// mode is usually switched on) do not count: they do not hold Escape back.
export function hasOpenContextMenu() {
    return !!Globals.menuBar?.activeContextMenu;
}

// A small label at the top of each 3D view while a track is in edit mode, so the mode (and how
// to leave it) is visible. Called from the render loop, so it touches the DOM only on a change.
export function updateTrackEditBadge(view) {
    const div = view?.div;
    if (!div) return;
    const trackOb = Globals.editingTrack;
    const text = trackOb?.splineEditor?.enable
        ? t("custom.contextMenu.editingBadge", {name: trackOb.displayName || trackOb.menuText || trackOb.trackID})
        : null;
    if (view._trackEditBadgeText === text) return;
    view._trackEditBadgeText = text;

    let badge = div.querySelector(".track-edit-badge");
    if (!text) {
        badge?.remove();
        return;
    }
    if (!badge) {
        badge = document.createElement("div");
        badge.className = "track-edit-badge";
        badge.style.cssText = "position:absolute;top:8px;left:50%;transform:translateX(-50%);"
            + "background:rgba(0,0,0,0.75);color:#fff;padding:4px 12px;border-radius:4px;"
            + "font:12px sans-serif;pointer-events:none;z-index:600;white-space:nowrap";
        div.appendChild(badge);
    }
    badge.textContent = text;
}
