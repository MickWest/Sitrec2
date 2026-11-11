// TrackSelectors.js
//
// The track selectors of a sitch, and the 3D objects on a manual position that are
// options in them.
//
// A track selector is a switch with one option for each track: Camera > Position,
// Target > Target Track, Orbit Target, Zoom To Track, the Position of each 3D object,
// Start From of the Reverse Balloon Launch Finder. Sit.dropTargets.track lists them.
//
// A 3D object that the user made has a Position selector of its own
// (CustomManager.addObjectLocation): Manual, or a track. An object on Manual stays at
// one point, and no track has that point. So, while its Position is Manual, the object
// is an option in every other track selector, under its name.
//
// - The key of the option is the id of the object. The id does not change, so a choice
//   that is saved with the sitch still matches after the object gets a new name.
// - The node of the option is the manual position node of the object (CNodePositionLLA).
//   That node reads no other node, so an option for an object cannot make a loop in the
//   node graph.
// - An object that goes onto a track leaves the selectors: its track is in them already.
//   A selector that had the object selected goes to that track, so it stays with the
//   object.
// - An object that is deleted must leave the selectors BEFORE its nodes go
//   (unlistManualObject, called by CustomManager.deleteObject). A node that is removed
//   takes its graph links with it, but not the rows of the menus.
//
// Leaf module: it imports only Globals. A selector is used through what CNodeSwitch
// gives: inputs, choice, guiLabels, addOption, removeOption, setOptionLabel, selectOption.

import {Globals, NodeMan, Sit} from "./Globals";

// The key of the manual option in an object's own Position selector. It is saved with the
// sitch as the selector's choice, so it does not change with the language.
export const OBJECT_MANUAL_POSITION = "manualPosition";

// The track selectors, as nodes, one at a time. The caller can change the selectors while
// it goes through them: the ids are a copy of the list, and each node is looked up when its
// turn comes, so a selector that was disposed in the meantime is not given.
export function* trackSelectors() {
    for (const target of [...(Sit.dropTargets?.track ?? [])]) {
        // A selector can be listed as "name-N": it then takes only track N of a dropped file.
        const selector = NodeMan.get(target.replace(/-\d+$/, ""), false);
        if (selector) yield selector;
    }
}

// The Position selector of an object, and its manual position node when the object is on it.
function locationOf(objectNode) {
    const own = objectNode.positionSwitchID ? NodeMan.get(objectNode.positionSwitchID, false) : null;
    const manual = own?.choice === OBJECT_MANUAL_POSITION ? own.inputs[OBJECT_MANUAL_POSITION] : null;
    return {own, manual};
}

// The text of an object's option in one selector: the name of the object. Two options of a
// selector must not have the same text, because a menu row is found by its text. So a name
// that another option has gets "(object)" after it.
function optionLabel(selector, key, name) {
    const taken = new Set(Object.keys(selector.inputs).filter(other => other !== key)
        .map(other => selector.guiLabels?.[other] ?? other));
    let label = name;
    for (let count = 1; taken.has(label); count++) {
        label = count === 1 ? `${name} (object)` : `${name} (object ${count})`;
    }
    return label;
}

// Give one selector the option of an object that is on its manual position, or bring the
// text of that option in step with the name of the object.
function listIn(selector, objectNode, manual) {
    const key = objectNode.id;
    const label = optionLabel(selector, key, objectNode.menuName ?? key);
    if (selector.inputs[key] === undefined) selector.addOption(key, manual, label);
    else selector.setOptionLabel(key, label);
}

/**
 * Bring the track selectors in step with one object. Call it when the object gets its
 * Location, when its Position changes, and when its name changes.
 *
 * On Manual, the object is an option in every selector but its own. On a track, it is in
 * none of them, and a selector that had it selected goes to that track.
 *
 * @param {CNode3DObject} objectNode - an object with a Location (positionSwitchID)
 */
export function syncManualObject(objectNode) {
    if (Globals.disposing) return;
    const {own, manual} = locationOf(objectNode);
    const key = objectNode.id;
    for (const selector of trackSelectors()) {
        if (selector === own) continue;     // its own selector has "Manual" for this
        if (manual) {
            listIn(selector, objectNode, manual);
        } else if (selector.inputs[key] !== undefined) {
            if (selector.choice === key && own && selector.inputs[own.choice] !== undefined) {
                selector.selectOption(own.choice);
            }
            selector.removeOption(key);
        }
    }
}

/**
 * Take an object out of the track selectors, before it is deleted. A selector that had it
 * selected goes to its first option, as it does when a track is deleted.
 *
 * @param {CNode3DObject} objectNode
 */
export function unlistManualObject(objectNode) {
    if (Globals.disposing) return;
    const key = objectNode.id;
    for (const selector of trackSelectors()) {
        if (selector.inputs[key] !== undefined) selector.removeOption(key);
    }
}

/**
 * Give a selector that was made after the objects an option for each object that is on its
 * manual position. TrackManager.addTracksToSwitch calls it, after the tracks.
 *
 * @param {CNodeSwitch} selector
 */
export function addManualObjectsToSelector(selector) {
    NodeMan.iterate((id, node) => {
        if (!node.positionSwitchID || node.positionSwitchID === selector.id) return;
        const {manual} = locationOf(node);
        if (manual) listIn(selector, node, manual);
    });
}
