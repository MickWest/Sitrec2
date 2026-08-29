// Undo/redo action for synthetic object creation.
//
// Extracted into its own dependency-free module so the undo/redo logic can be unit-tested in
// isolation (CustomManagerMenus.js, where createObjectFromInput lives, has an enormous transitive
// import tree). The managers and the recreate callback are INJECTED, so the action holds no
// hidden globals — making it both testable and reusable.
//
// An object created via createObjectFromInput is two things: a 3D object node (objectID) and a
// linked synthetic track (trackID). Undo must remove BOTH (disposing the track does not free the
// object node). Redo re-creates via the supplied callback, which yields FRESH ids — so the action
// tracks the live ids in closure vars and updates them on redo, ensuring a later undo targets the
// recreated pair, not the stale originals.

/**
 * @param {Object}   p
 * @param {string}   p.name        - object name (for the action description)
 * @param {string}   p.objectID    - id of the created CNode3DObject
 * @param {string}   p.trackID     - id of the created synthetic track
 * @param {string[]} [p.ownedNodeIds] - ids of the sub-nodes CNode3DObject auto-created
 *        under the object (see the sweep in undo() for why these are needed)
 * @param {Object}   p.trackManager- has exists(id) + disposeRemove(id)
 * @param {Object}   p.nodeMan     - has exists(id) + unlinkDisposeRemove(id)
 * @param {Function} p.recreate    - () => ({objectID, trackID, ownedNodeIds}) re-creating
 *        the object+track
 * @returns {{undo: Function, redo: Function, description: string}}
 */
export function makeCreateObjectUndoAction({name, objectID, trackID, ownedNodeIds = [], trackManager, nodeMan, recreate}) {
    let curObjectID = objectID;
    let curTrackID = trackID;
    let curOwnedNodeIds = ownedNodeIds;
    return {
        undo: () => {
            // Remove the track first (tears down its display/data nodes), then the object node.
            if (curTrackID && trackManager.exists(curTrackID)) trackManager.disposeRemove(curTrackID);

            // ...then every sub-node CNode3DObject auto-created under the object id
            // (_size, _color_colorInput, _modelLength, _ControllerTrackPosition,
            // _ControllerObjectTilt, _ControllerObjectTiltSmoothed and its _window).
            // unlinkDisposeRemove(objectID) alone leaves them registered: it severs the
            // object's edges but disposes only the object itself, and the orphans it
            // creates appear AFTER the track removal above has already run its
            // pruneUnusedFlagged() pass, so even the prunable ones survive. Recursing
            // through inputs would not be enough either - _color_colorInput and
            // _modelLength are not inputs of the object, so nothing reaches them.
            // The ids are therefore recorded at creation time and swept explicitly,
            // the same ownership-snapshot approach the scripted-video walker uses.
            // Order matters: the object goes last, so its inputs are still linked while
            // they are removed and no node is disposed with a dangling reference to it.
            for (const id of curOwnedNodeIds) {
                if (nodeMan.exists(id)) nodeMan.unlinkDisposeRemove(id);
            }
            if (curObjectID && nodeMan.exists(curObjectID)) nodeMan.unlinkDisposeRemove(curObjectID);
        },
        redo: () => {
            const r = recreate() || {};
            curObjectID = r.objectID;
            curTrackID = r.trackID;
            // Redo builds a fresh object under a fresh id, so the previous sweep list is
            // stale - adopt the new one or the next undo leaks the recreated sub-nodes.
            curOwnedNodeIds = r.ownedNodeIds ?? [];
        },
        description: `Create object "${name}"`,
    };
}
