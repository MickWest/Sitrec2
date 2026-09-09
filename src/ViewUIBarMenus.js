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

// Mirror key for a control that belongs to NO single view but is surfaced on more than one.
// "Extend All Tracks to Ground" is one flag over every track: both 3D views want the button, and
// there is only one thing for it to be. Same registry and same mirroring as a per-view slot —
// only the key differs, so two bars subscribe to ONE control instead of pretending there are two
// and leaving the user to wonder why ticking either ticks the other.
export function sharedMenuKey(slot) {
    return `shared:${slot}`;
}

// The key a registry item names, per view. `shared: true` says the item is one of the above.
function keyForItem(viewId, item) {
    return item.shared ? sharedMenuKey(item.slot) : viewMenuKey(viewId, item.slot);
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
 * "features" is Pins in both Main and Look, backed by two different controllers.
 */
export const VIEW_UIBAR_MENUS = {
    mainView: [
        {slot: "measurements", name: "Measurements"},
        {slot: "labels", name: "Labels"},
        {slot: "features", name: "Pins"},
        {slot: "los", name: "Lines of Sight"},
        {slot: "currentLos", name: "Current LOS"},
        {slot: "frustum", name: "Camera Frustum"},
        {slot: "showTracks", name: "Show Tracks", shared: true},
        {slot: "extendToGround", name: "Extend Tracks to Ground", shared: true},
        {slot: "compass", name: "Compass"},
        {slot: "timeDisplay", name: "Time Display"},
        {slot: "mainViewScale", name: "Object Scale"},
        {slot: "fov", name: "Field of View"},
        {slot: "yCompress", name: "Y-Compress"},
        {slot: "showSatellites", name: "Satellites", shared: true, folder: "nightSky"},
        {slot: "starNames", name: "Star Names", folder: "nightSky"},
        {slot: "onlyPlanets", name: "Only Label Planets", folder: "nightSky"},
        {slot: "equatorialGrid", name: "Equatorial Grid", folder: "nightSky"},
    ],

    lookView: [
        {slot: "freeLook", name: "Free Look"},
        {slot: "measurements", name: "Measurements"},
        {slot: "labels", name: "Labels"},
        {slot: "features", name: "Pins"},
        {slot: "allTracks", name: "All Tracks"},
        {slot: "showTracks", name: "Show Tracks", shared: true},
        {slot: "extendToGround", name: "Extend Tracks to Ground", shared: true},
        {slot: "compass", name: "Compass"},
        {slot: "timeDisplay", name: "Time Display"},
        {slot: "simInfo", name: "Readout"},
        {slot: "northUp", name: "North Up"},
        {slot: "yCompress", name: "Y-Compress"},
        {slot: "showSatellites", name: "Satellites", shared: true, folder: "nightSky"},
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
        {slot: "videoInfo", name: "Readout"},
        {slot: "grid", name: "Grid"},
        {slot: "annotations", name: "Annotations"},
        {slot: "exifPanel", name: "EXIF / Metadata"},
        {slot: "removeVideo", name: "Remove Video"},
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
        (folder ?? menu).addMirror(keyForItem(view.id, item), {
            name: itemLabel(item),
            onMirror: (twin) => {
                folder?.show();          // reveal the group now it has something in it
                placeInOrder(twin.domElement, index);
            },
        });
    });
    return items.length;
}

// --- header ICONS ---------------------------------------------------------------------------
//
// The handful of toggles worth reaching without opening anything, promoted out of the menu onto
// the bar itself. An icon is NOT a second control: it mirrors the SAME slot as the menu row it
// sits beside, so the flag, the global-menu row, the header row and the icon are four faces of
// one boolean (CUIBar.addToggleIcon has the mechanism).
//
// So every icon slot is also a row in VIEW_UIBAR_MENUS above, deliberately: the row is the
// discoverable form — it carries the full label and the tooltip, and it is where a user who
// does not recognise a glyph finds out what it was. The icon is the shortcut, and it borrows
// that label and tooltip rather than restating them.
//
// Drawn inline at 16x16 rather than pulled from an icon font, so each one can say what it is in
// the colour the thing is actually drawn in: red lines of sight, a cyan view frustum. An icon
// whose control is off is drained of colour, which is what makes a glance at the bar a reading
// of what the view is currently showing.

const ICON_LOS = `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
    <g stroke="#ff5a5a" stroke-width="1.6" stroke-linecap="round">
        <path d="M1.7 14.1 L14.3 9.2"/><path d="M1.7 10.3 L14.3 5.4"/><path d="M1.7 6.5 L14.3 1.6"/>
    </g></svg>`;

const ICON_FRUSTUM = `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
    <path d="M1.9 8 L14.1 1.7 L14.1 14.3 Z" fill="none" stroke="#3fd8e8" stroke-width="1.5"
          stroke-linejoin="round"/></svg>`;

// A struck-through eye: the one glyph everybody already reads as "hide this". Lit means the
// view IS decluttered, which is what the eye being crossed out says.
const ICON_DECLUTTER = `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
    <path d="M1.5 8 C3.5 4.7 5.7 3.3 8 3.3 C10.3 3.3 12.5 4.7 14.5 8
             C12.5 11.3 10.3 12.7 8 12.7 C5.7 12.7 3.5 11.3 1.5 8 Z"
          fill="none" stroke="currentColor" stroke-width="1.2"/>
    <circle cx="8" cy="8" r="2" fill="currentColor"/>
    <path d="M3 13 L13 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;

// A map pin. The one icon whose subject is already a picture — a pin is what the thing IS on
// the ground, so drawing anything else would be a worse name for it than the word.
const ICON_PINS = `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
    <path d="M8 14.2 C8 14.2 12.6 9 12.6 5.9 A4.6 4.6 0 0 0 3.4 5.9 C3.4 9 8 14.2 8 14.2 Z"
          fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
    <circle cx="8" cy="5.9" r="1.5" fill="currentColor"/></svg>`;

const ICON_LABELS = `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
    <text x="8" y="13" text-anchor="middle" font-family="sans-serif" font-size="14"
          font-weight="700" fill="currentColor">L</text></svg>`;

// A four-point sparkle rather than a dot: at 15px a circle reads as a bullet, and the whole
// point of the icon is that the thing being named is a star.
const ICON_STAR_NAMES = `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
    <path d="M3.4 3.6 Q4 6.6 6.4 7.2 Q4 7.8 3.4 10.8 Q2.8 7.8 0.4 7.2 Q2.8 6.6 3.4 3.6 Z"
          fill="currentColor"/>
    <text x="10.6" y="13.2" text-anchor="middle" font-family="sans-serif" font-size="12"
          font-weight="700" fill="currentColor">S</text></svg>`;

// A dimension line, the way a drawing marks a distance: extension lines at each end, arrows
// running out to them, and a gap in the middle where the figure goes — which is also the shape
// CNodeMeasureAB actually draws, two outward arrows with the distance between them. Green to
// match: that node's default colour is 0x00FF00. Wider than the others because the number is
// the point of it; squeezed, it would just be a line with a smudge on it.
const ICON_MEASUREMENTS = `<svg viewBox="0 0 26 16" width="24" height="15" aria-hidden="true">
    <g stroke="#00ff00" stroke-width="1.2" stroke-linecap="round">
        <path d="M2 2.6 V13.4"/><path d="M24 2.6 V13.4"/>
        <path d="M2 8 H8"/><path d="M18.5 8 H24"/>
    </g>
    <path d="M2 8 L5.6 6.2 L5.6 9.8 Z" fill="#00ff00"/>
    <path d="M24 8 L20.4 6.2 L20.4 9.8 Z" fill="#00ff00"/>
    <text x="13.2" y="11.2" text-anchor="middle" font-family="sans-serif" font-size="9"
          font-weight="700" fill="currentColor">12</text></svg>`;

// A track: the same line the extend-to-ground icon hangs its curtain from, with its sample
// points on it, so the pair reads as two things you can do to the same object.
const ICON_SHOW_TRACKS = `<svg viewBox="0 0 20 16" width="19" height="15" aria-hidden="true">
    <path d="M2 11.5 L6.5 6.5 L11 9.5 L18 3.5" fill="none" stroke="currentColor"
          stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
    <g fill="currentColor">
        <circle cx="2" cy="11.5" r="1.5"/><circle cx="6.5" cy="6.5" r="1.5"/>
        <circle cx="11" cy="9.5" r="1.5"/><circle cx="18" cy="3.5" r="1.5"/>
    </g></svg>`;

// A track with a curtain hanging from it down to the ground — which is what "Extend to Ground"
// draws. The drop lines are dimmed so the track still reads as the track.
const ICON_EXTEND_GROUND = `<svg viewBox="0 0 20 16" width="19" height="15" aria-hidden="true">
    <g stroke="currentColor" stroke-width="1" opacity="0.55">
        <path d="M4 4.1 V13"/><path d="M8 5.9 V13"/><path d="M12 6.6 V13"/><path d="M16 4.3 V13"/>
    </g>
    <path d="M2 3.2 L6 5 L10 6.3 L14 5.2 L18 3.6" fill="none" stroke="currentColor"
          stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
    <path d="M1.5 13.4 H18.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
    </svg>`;

// The frustum again, greyed back, with the one line the toggle actually adds: the current
// frame's line of sight, straight down the middle. Reading it beside the frustum icon is the
// point — same shape, so it is plainly a thing INSIDE the camera's view.
const ICON_CURRENT_LOS = `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
    <path d="M1.9 8 L14.1 1.7 L14.1 14.3 Z" fill="none" stroke="currentColor" stroke-width="1.2"
          opacity="0.45" stroke-linejoin="round"/>
    <path d="M2.4 8 H14.1" stroke="#ffffff" stroke-width="1.6" stroke-linecap="round"/></svg>`;

// Three orthogonal axes, drawn as the isometric trihedron every 3D tool uses for its navigation
// gizmo — the one glyph that already means "you are moving in space" rather than "something is
// being displayed". currentColor, not the red/green/blue of an axis helper, because Free Look
// draws nothing in the scene: it is a MODE, so what it has to say is on/off, which the bar says
// by lighting the button.
const ICON_FREE_LOOK = `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
    <g stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
        <path d="M8 10 V5.1"/><path d="M8 10 L12.67 12.7"/><path d="M8 10 L3.33 12.7"/>
    </g>
    <g fill="currentColor">
        <path d="M8 2.2 L9.3 4.8 L6.7 4.8 Z"/>
        <path d="M14.75 13.9 L11.85 13.73 L13.15 11.47 Z"/>
        <path d="M1.25 13.9 L2.85 11.47 L4.15 13.73 Z"/>
    </g></svg>`;

// A satellite: body between two solar panels. Distinct from the star sparkle next to it, which
// is what it has to be told apart from.
const ICON_SATELLITE = `<svg viewBox="0 0 20 16" width="19" height="15" aria-hidden="true">
    <g fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round">
        <rect x="1.4" y="4.8" width="4.8" height="6.4" rx="0.6"/>
        <rect x="13.8" y="4.8" width="4.8" height="6.4" rx="0.6"/>
        <path d="M6.2 8 H8.4"/><path d="M11.6 8 H13.8"/>
    </g>
    <rect x="8.4" y="5.8" width="3.2" height="4.4" rx="0.7" fill="currentColor"/></svg>`;

// A compass rose: the ring, and a needle whose north half is solid — the half that carries the
// information.
const ICON_COMPASS = `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
    <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.2"/>
    <path d="M8 2.6 L10.3 8 L5.7 8 Z" fill="currentColor"/>
    <path d="M8 13.4 L10.3 8 L5.7 8 Z" fill="currentColor" opacity="0.4"/></svg>`;

// A clock face reading ten past ten, the way every clock in every shop window does — the hands
// are widest apart there, which is what makes it read as a clock at 15 pixels.
const ICON_CLOCK = `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
    <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.2"/>
    <path d="M8 4.3 V8.2 L10.7 9.8" fill="none" stroke="currentColor" stroke-width="1.4"
          stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// A panel of readings. ONE icon for both readouts: a view has exactly one — the look view's sim
// readout, the video view's video readout — so there is nothing to tell apart, and the same
// button in the same place means the same thing wherever you find it.
const ICON_READOUT = `<svg viewBox="0 0 20 16" width="19" height="15" aria-hidden="true">
    <rect x="1.6" y="2.7" width="16.8" height="10.6" rx="1.4" fill="none" stroke="currentColor"
          stroke-width="1.2"/>
    <g stroke="currentColor" stroke-width="1.3" stroke-linecap="round">
        <path d="M4.4 6.2 H13"/><path d="M4.4 8.6 H15.6"/><path d="M4.4 11 H10.4"/>
    </g></svg>`;

// Not every icon is a picture. A control whose point is a NUMBER is clearer written out than
// drawn, so this one is text and is simply wider than it is tall — the bar's icons are laid out
// by their own width, not forced into a square.
const ICON_ZOOM_100 = `<span style="font:600 11px/1 sans-serif; letter-spacing:0.2px; padding:0 3px"
    >100%</span>`;

// What "Declutter" turns off: everything drawn OVER the recreation rather than being part of it.
// Listed as slots and resolved against each view's own menu registry, so a view only ever
// declutters what it actually has — the look view has no camera frustum to hide, and only the
// view that hosts a readout can turn one off.
const DECLUTTER_SLOTS = [
    "labels", "features", "measurements", "showTracks", "starNames",
    "compass", "timeDisplay", "simInfo", "videoInfo", "los", "frustum",
];

// The run Main and Look both open with, written once so it cannot drift: they sit side by side
// and are read as a pair, so a button in both has to be in the same place in both.
const COMMON_3D_ICONS = [
    {targets: DECLUTTER_SLOTS, icon: ICON_DECLUTTER, action: "declutter",
        tip: "Declutter — hide every overlay in this view; press again to bring back exactly the ones that were showing"},
    {slot: "labels", icon: ICON_LABELS},
    {slot: "features", icon: ICON_PINS},
    {slot: "measurements", icon: ICON_MEASUREMENTS},
    {slot: "showTracks", icon: ICON_SHOW_TRACKS, shared: true},
    {slot: "extendToGround", icon: ICON_EXTEND_GROUND, shared: true,
        double: "clearExtendToGround"},
    {slot: "showSatellites", icon: ICON_SATELLITE, shared: true},
    {slot: "starNames", icon: ICON_STAR_NAMES},
    // View chrome rather than scene content, so last — and each only exists in the view that
    // happens to host it, so on most sitches only the look view shows these two.
    {slot: "compass", icon: ICON_COMPASS},
    {slot: "timeDisplay", icon: ICON_CLOCK},
];

/**
 * Which slots get an icon on which view's bar, in bar order (left to right, after the title).
 *
 * Item fields:
 *   slot   — the mirrored slot, which must ALSO be a row in VIEW_UIBAR_MENUS for the same view
 *   targets— instead of `slot`: several slots this ONE button clears and restores together
 *            (Declutter). Only those the view has a row for are used. Needs `action` and `tip`.
 *   icon   — the markup to draw
 *   value  — present for a SNAP button: pressing moves the control to this value and remembers
 *            where it was; pressing again puts it back. The icon lights while the control holds
 *            the value. Absent for a boolean toggle.
 *   tip    — required with `value`, since the control's own label describes the control, not what
 *            the button does to it. i18n key `viewIcons.<slot>` overrides it.
 *   shared — the slot is a sharedMenuKey, one control behind every view's copy of the button.
 *   double — slot of a shared ACTION control to run on a DOUBLE click. The single click still
 *            does the ordinary thing; the double is the blunter version of it.
 *   peek   — keep a copy of this icon on screen while the header is HIDDEN and its control is
 *            ON. For a MODE that changes what the view does rather than what it draws: with the
 *            bar away there would otherwise be nothing at all to say you are in it.
 *
 * A control that means something in two views gets an icon in both. For a per-view slot those
 * are two different controllers behind one name, each bar driving its own; for a `shared` slot
 * they are two buttons onto one control. Lines of sight and the camera frustum are drawn in the
 * main view only, so they appear there only.
 */
export const VIEW_UIBAR_ICONS = {
    // Anything only one view has comes AFTER the common run — see COMMON_3D_ICONS.
    mainView: [
        ...COMMON_3D_ICONS,
        {slot: "los", icon: ICON_LOS},
        {slot: "currentLos", icon: ICON_CURRENT_LOS},
        {slot: "frustum", icon: ICON_FRUSTUM},
    ],

    lookView: [
        // AHEAD of the common run — the one thing that outranks it. Free Look is not an overlay
        // you switch on to see more, it is who is flying the camera: while it is on, the Location
        // and Heading sources are suspended and this view answers to the mouse. It is also the
        // only icon that stays on screen with the header hidden (`peek`), because a mode you are
        // inside has to be visible from inside it.
        {slot: "freeLook", icon: ICON_FREE_LOOK, peek: true},
        ...COMMON_3D_ICONS,
        {slot: "simInfo", icon: ICON_READOUT},      // this view's on-screen readout
    ],

    video: [
        {slot: "videoInfo", icon: ICON_READOUT},    // …and this view's
        {slot: "zoom", icon: ICON_ZOOM_100, value: 100,
            tip: "Video zoom 100% — press again to go back to the previous zoom"},
    ],
};

/**
 * Consumer side, the twin of populateViewUIBarMenu: put `view`'s icons on its bar. Called from
 * the same place, once per view; views with no icon entry are left alone.
 *
 * Each icon starts hidden and appears if and when its control is published, so a sitch with no
 * lines of sight and no night sky shows two icons rather than four empty ones.
 *
 * @param {object} view a CNodeView with a CUIBar already created
 * @returns {number} how many icons were requested
 */
export function populateViewUIBarIcons(view) {
    const items = VIEW_UIBAR_ICONS[view?.id];
    const bar = view?.uiBar;
    if (!items || typeof bar?.addControlIcon !== "function") return 0;

    // Left section, so they sit next to the view's own menu — these belong to the view, unlike
    // the window chrome (fullscreen, pop out, pin, close) gathered on the right. A hairline
    // keeps the first icon from reading as part of the title, which is a menu, not a toggle.
    bar.addSeparator?.(true);
    for (const item of items) {
        if (item.targets) {
            bar.addGroupIcon(groupKeys(view.id, item.targets), {
                html: item.icon,
                action: `icon-${item.action}`,
                tooltip: iconTip({...item, slot: item.action}),
                left: true,
            });
            continue;
        }
        bar.addControlIcon(keyForItem(view.id, item), {
            html: item.icon,
            action: `icon-${item.slot}`,
            value: item.value,
            peek: item.peek,
            doubleKey: item.double === undefined ? undefined : sharedMenuKey(item.double),
            label: rowLabel(view.id, item.slot),
            tooltip: item.tip === undefined ? undefined : iconTip(item),
            left: true,
        });
    }
    return items.length;
}

// The mirror keys for a group button's targets, in this view: the slots the view actually has a
// menu row for, keyed the way that row is keyed. A view that has no compass simply has one fewer
// thing to declutter, with no special case anywhere.
function groupKeys(viewId, targets) {
    const rows = VIEW_UIBAR_MENUS[viewId] ?? [];
    return targets
        .map(slot => rows.find(row => row.slot === slot))
        .filter(Boolean)
        .map(row => keyForItem(viewId, row));
}

// The SHORT name the menu row beside it uses. An icon names itself after its row rather than
// after the control it mirrors, because some of those controls are named for their internals —
// the compass overlay's own switch is called "compassMain", which is no use as a tooltip.
function rowLabel(viewId, slot) {
    const row = (VIEW_UIBAR_MENUS[viewId] ?? []).find(item => item.slot === slot);
    return row ? itemLabel(row) : undefined;
}

function iconTip(item) {
    return t(`viewIcons.${item.slot}`, {defaultValue: item.tip});
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
