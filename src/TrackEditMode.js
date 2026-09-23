// Leaving track edit mode from anywhere other than the "Edit Track" checkbox: the edit menus,
// the point menu, and the Escape key. All of them come here so the three pieces of state
// (trackOb.editMode, the spline editor, Globals.editingTrack) always change together.

import {Globals, setRenderOne} from "./Globals";
import {t} from "./i18n";

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
