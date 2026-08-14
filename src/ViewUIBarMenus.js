// Per-view header menus — the view-specific slice of the global menus.
//
// Each big view's CUIBar title menu ("Main", "Look", "Video") is the home for the controls
// that only affect THAT view. Those controls already exist, scattered through the Show, View,
// Video and Camera menus, so the header does not re-implement them — it MIRRORS them
// (src/MenuMirror.js). One control, one piece of state, one side effect: the header row and
// the global-menu row are two views of the same lil-gui controller, and neither knows which
// one the user clicked.
//
// Adding an item is two edits:
//
//   1. where the control is CREATED, publish it under the view it belongs to — chained onto
//      the end of the existing call, so nothing has to be restructured:
//        guiShowHide.add(Globals, "showLabelsLook").name(…).listen()
//            .shareAs(viewMenuKey("lookView", "labels"))
//
//   2. here, list that slot in the view's entry:
//        {slot: "labels", name: "Labels"}
//
// Nothing else is needed: registration and request are order-independent, so a control created
// long after the view (the night-sky overlays, the video Rotation dropdown) still lands in the
// header when it appears. A slot with no source simply does not show up — which is what should
// happen for a sitch that has no video overlay or no night sky.
//
// Labels are deliberately SHORTER than the global-menu originals: the view is already named by
// the menu you opened, so "Measurements in Look" is just "Measurements" under Look. Tooltips
// are inherited from the source, so the long-form explanation is still one hover away.
//
// tests/ViewUIBarMenus.test.js guards the registry against the ways the two halves drift apart.

import "./MenuMirror";       // installs Controller.shareAs / GUI.addMirror
import {t} from "./i18n";

// Mirror key for one slot of one view. Namespaced so view-menu keys can never collide with the
// hand-written keys used elsewhere (e.g. "chatModel").
export function viewMenuKey(viewId, slot) {
    return `view:${viewId}:${slot}`;
}

// What a view is CALLED, in one place: the header title, and the "… in Main" / "… in Look"
// suffix on every per-view control in the global menus.
export const FRIENDLY_VIEW_NAMES = {
    mainView: "Main", lookView: "Look", video: "Video", video2: "Video 2",
    chatView: "Assistant",
};

// The naming convention for a per-view control in a GLOBAL menu: "<Thing> in <View>", e.g.
// "Labels in Look", "Star Names in Main". Used where the label has to be composed at runtime
// because there is one control per view (the night-sky overlays); the fixed labels in
// src/i18n/en.js are written to the same shape by hand, and the header menus drop the suffix
// entirely because the menu you opened already names the view.
export function viewControlLabel(viewId, thing) {
    return `${thing} in ${FRIENDLY_VIEW_NAMES[viewId] ?? viewId}`;
}

// Sub-folder titles, by the id that registry items refer to. Kept apart from the items so the
// title lives in one place and the i18n key (`viewMenus.folders.<id>`) is a plain identifier.
export const VIEW_UIBAR_FOLDERS = {
    nightSky: "Night Sky",
    videoOverlay: "Video Overlay",
    adjustments: "Adjustments",
    masking: "Masking",
};

/**
 * The registry: for each view, the ordered contents of its header menu.
 *
 * Item fields:
 *   slot    — matches the slot in the control's .shareAs(viewMenuKey(...)) (required)
 *   name    — short label for the header row; i18n key `viewMenus.<slot>` overrides it
 *   folder  — optional VIEW_UIBAR_FOLDERS id to group the row under
 *
 * A slot name means the same thing in every view (that is why the label can be shared), so
 * "features" is Features in both Main and Look, backed by two different controllers.
 */
export const VIEW_UIBAR_MENUS = {
    mainView: [
        {slot: "measurements", name: "Measurements"},
        {slot: "labels", name: "Labels"},
        {slot: "features", name: "Features"},
        {slot: "fov", name: "Field of View"},
        {slot: "yCompress", name: "Y-Compress"},
        {slot: "starNames", name: "Star Names", folder: "nightSky"},
        {slot: "onlyPlanets", name: "Only Label Planets", folder: "nightSky"},
        {slot: "equatorialGrid", name: "Equatorial Grid", folder: "nightSky"},
    ],

    lookView: [
        {slot: "measurements", name: "Measurements"},
        {slot: "labels", name: "Labels"},
        {slot: "features", name: "Features"},
        {slot: "allTracks", name: "All Tracks"},
        {slot: "compass", name: "Compass"},
        {slot: "timeDisplay", name: "Time Display"},
        {slot: "northUp", name: "North Up"},
        {slot: "yCompress", name: "Y-Compress"},
        {slot: "starNames", name: "Star Names", folder: "nightSky"},
        {slot: "onlyPlanets", name: "Only Label Planets", folder: "nightSky"},
        {slot: "equatorialGrid", name: "Equatorial Grid", folder: "nightSky"},
        {slot: "celestialVectors", name: "Celestial Vectors", folder: "nightSky"},
        {slot: "overlayTransparency", name: "Transparency %", folder: "videoOverlay"},
        {slot: "overlayKeyColor", name: "Key Color", folder: "videoOverlay"},
        {slot: "overlayKeyTolerance", name: "Key Tolerance %", folder: "videoOverlay"},
        {slot: "groundVideo", name: "Ground Video", folder: "videoOverlay"},
    ],

    video: [
        {slot: "zoom", name: "Zoom %"},
        {slot: "rotation", name: "Rotation"},
        {slot: "videoInfo", name: "Video Info"},
        {slot: "grid", name: "Grid"},
        {slot: "annotations", name: "Annotations"},
        {slot: "exifPanel", name: "EXIF / Metadata"},
        {slot: "effects", name: "Enable Effects", folder: "adjustments"},
        {slot: "brightness", name: "Brightness", folder: "adjustments"},
        {slot: "contrast", name: "Contrast", folder: "adjustments"},
        {slot: "mask", name: "Enable Mask", folder: "masking"},
        {slot: "maskEdit", name: "Edit Mask", folder: "masking"},
    ],
};

/**
 * Consumer side: fill in `view`'s header menu from the registry. Called once, from
 * CNodeView.createViewHeader, for every view — views with no registry entry are left alone.
 *
 * @param {object} view a CNodeView with a CUIBar already created
 * @returns {number} how many rows were requested (not how many exist yet — sources that are
 *          not registered yet fill in later, and sources that never appear never do)
 */
export function populateViewUIBarMenu(view) {
    const items = VIEW_UIBAR_MENUS[view?.id];
    const menu = view?.uiBar?.titleMenu;
    if (!items || !menu) return 0;

    const folders = new Map();
    items.forEach((item, index) => {
        const folder = item.folder ? folderFor(menu, folders, item.folder, index) : null;
        (folder ?? menu).addMirror(viewMenuKey(view.id, item.slot), {
            name: itemLabel(item),
            onMirror: (twin) => {
                folder?.show();          // reveal the group now it has something in it
                placeInOrder(twin.domElement, index);
            },
        });
    });
    return items.length;
}

function itemLabel(item) {
    return t(`viewMenus.${item.slot}`, {defaultValue: item.name});
}

// Sub-folders are created UP FRONT so they keep their registry position whenever their contents
// arrive, but HIDDEN, because a slot whose source never registers must not leave an empty group
// behind — "Video Overlay" with nothing in it is worse than no heading at all.
function folderFor(menu, folders, id, index) {
    let folder = folders.get(id);
    if (!folder) {
        folder = menu.addFolder(t(`viewMenus.folders.${id}`, {defaultValue: VIEW_UIBAR_FOLDERS[id] ?? id}));
        folder.hide();
        placeInOrder(folder.domElement, index);
        folders.set(id, folder);
    }
    return folder;
}

// Put a row (or group) where the registry says it goes. Rows are NOT created in registry order:
// a control that does not exist yet is mirrored in whenever it appears, which would otherwise
// leave the menu ordered by whatever the sitch happened to build first — different from one
// sitch to the next, and different from the list a reader of this file would expect. lil-gui
// lays out purely by DOM order, so a single insertBefore is the whole fix.
function placeInOrder(element, index) {
    element._viewMenuOrder = index;
    const parent = element.parentElement;
    if (!parent) return;
    // Anything without an order came from somewhere else and belongs after our rows.
    const after = [...parent.children]
        .find(sibling => sibling !== element && (sibling._viewMenuOrder ?? Infinity) > index);
    parent.insertBefore(element, after ?? null);
}
