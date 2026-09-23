// Editable display names over immutable ids.
//
// Every nameable thing in a sitch — a track, a 3D object, a building, clouds, a ground overlay —
// keeps an id that never changes, because node ids, switch option keys and saved mods are all
// built from it. The name the user sees is a separate display name, and a rename changes only
// that. This module holds the parts every kind shares:
//
//  - addNameControl() puts the Name control in a thing's menu folder and keeps the folder title
//    in step with it.
//  - notifyDisplayNameChanged() sends the one event that everything which SHOWS a name listens
//    for (measurements, custom graphs, track switches, open edit menus), so a rename path never
//    has to know who displays the name.
//  - uniqueDisplayName() makes "Name-2" style names for duplicates.
//
// Leaf module: it imports only the event manager and i18n, so any node class can use it.

import {EventManager} from "./CEventManager";
import {t} from "./i18n";

export const DISPLAY_NAME_CHANGED = "displayNameChanged";

// The folder title for a display name: "Building: Tower" for kinds that show a prefix, or the
// bare name (3D objects, tracks).
export function displayTitle(name, prefix = null) {
    return prefix ? `${prefix}: ${name}` : String(name);
}

/**
 * Tell everything that shows names that the display name of `id` changed.
 * @param {string} id - the immutable id of the renamed thing (node id or track id)
 */
export function notifyDisplayNameChanged(id) {
    EventManager.dispatchEvent(DISPLAY_NAME_CHANGED, {id});
}

/**
 * Add the Name control to a thing's menu folder.
 *
 * The folder title follows the name as it is typed. The title is set with folder.title(), the
 * lil-gui METHOD: an assignment (folder.title = "...") replaces the method with a string, so the
 * title does not change and a later title() call throws.
 *
 * @param {GUI} folder - the thing's menu folder
 * @param {object} target - holds the name
 * @param {object} [opts]
 * @param {string} [opts.property="name"] - the property on target that holds the name
 * @param {string} [opts.prefix] - folder title prefix, e.g. "Building"
 * @param {function(string)} [opts.onRename] - called after each change, with the new name
 * @param {function(string)} [opts.onFinishChange] - called when an edit is finished
 * @param {string} [opts.id] - the id to notify with; defaults to target.id
 * @param {boolean} [opts.first=false] - put the control at the top of the folder
 * @returns {Controller}
 */
export function addNameControl(folder, target, {property = "name", prefix = null, onRename,
    onFinishChange, id = target.id, first = false} = {}) {
    const controller = folder.add(target, property).name(t("displayName.label"))
        .tooltip(t("displayName.tooltip"))
        .onChange((value) => {
            folder.title(displayTitle(value, prefix));
            onRename?.(value);
            notifyDisplayNameChanged(id);
        });
    if (onFinishChange) controller.onFinishChange(onFinishChange);
    if (first) controller.moveToFirst();
    return controller;
}

/**
 * A name based on `name` that is not in `existingNames`: "Tower" → "Tower-1", "Tower-1" →
 * "Tower-2", and so on, skipping any that are taken.
 * @param {string} name
 * @param {Iterable<string>} existingNames
 * @returns {string}
 */
export function uniqueDisplayName(name, existingNames) {
    const taken = new Set(existingNames);
    const match = String(name).match(/^(.+?)-(\d+)$/);
    const base = match ? match[1] : String(name);
    let counter = match ? parseInt(match[2], 10) : 1;
    let candidate;
    do {
        candidate = `${base}-${counter}`;
        counter++;
    } while (taken.has(candidate));
    return candidate;
}

/**
 * Keep an open menu's title in step with the display name of `id`, until the menu is closed.
 * For the standalone edit menus: their Name control is a mirror of the folder's, so a rename
 * made in the menu must retitle it as well.
 * @param {GUI} menu
 * @param {string} id - the immutable id of the thing the menu edits
 * @param {function(): string} makeTitle - the menu's title for the current name
 */
export function titleFollowsDisplayName(menu, id, makeTitle) {
    // Returning true removes the listener (CEventManager), which is how a closed menu drops out.
    EventManager.addEventListener(DISPLAY_NAME_CHANGED, (event) => {
        if (!menu.domElement?.isConnected) return true;
        if (event?.id === id) menu.title(makeTitle());
        return false;
    });
}
