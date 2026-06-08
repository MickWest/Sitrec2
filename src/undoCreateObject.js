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
 * @param {Object}   p.trackManager- has exists(id) + disposeRemove(id)
 * @param {Object}   p.nodeMan     - has exists(id) + unlinkDisposeRemove(id)
 * @param {Function} p.recreate    - () => ({objectID, trackID}) re-creating the object+track
 * @returns {{undo: Function, redo: Function, description: string}}
 */
export function makeCreateObjectUndoAction({name, objectID, trackID, trackManager, nodeMan, recreate}) {
    let curObjectID = objectID;
    let curTrackID = trackID;
    return {
        undo: () => {
            // Remove the track first (tears down its display/data nodes), then the object node.
            if (curTrackID && trackManager.exists(curTrackID)) trackManager.disposeRemove(curTrackID);
            if (curObjectID && nodeMan.exists(curObjectID)) nodeMan.unlinkDisposeRemove(curObjectID);
        },
        redo: () => {
            const r = recreate() || {};
            curObjectID = r.objectID;
            curTrackID = r.trackID;
        },
        description: `Create object "${name}"`,
    };
}
