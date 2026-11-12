// Undo/redo action for synthetic object creation.
//
// Extracted into its own dependency-free module so the undo/redo logic can be unit-tested in
// isolation (CustomManagerMenus.js, where createObjectFromInput lives, has an enormous transitive
// import tree). The track manager, the delete function and the recreate callback are INJECTED,
// so the action holds no hidden globals — making it both testable and reusable.
//
// An object created via createObjectFromInput is two things: a 3D object node (objectID) and a
// linked synthetic track (trackID). Undo must remove BOTH (disposing the track does not free the
// object node). Redo re-creates via the supplied callback, which yields FRESH ids — so the action
// tracks the live ids in closure vars and updates them on redo, ensuring a later undo targets the
// recreated pair, not the stale originals.
//
// The object is removed by the injected deleteObject, which is CustomManager.deleteObject: the
// one function that removes a user-made object. It removes the object, every sub-node the
// object made (its controllers, its Location, its GUI values), its open menu and its option in
// the track selectors. This action must not remove those nodes itself. It did so once, from a
// list of ids recorded at creation, and that second way to delete an object missed what
// deleteObject does besides.

/**
 * @param {Object}   p
 * @param {string}   p.name        - object name (for the action description)
 * @param {string}   p.objectID    - id of the created CNode3DObject
 * @param {string}   p.trackID     - id of the created synthetic track
 * @param {Object}   p.trackManager- has exists(id) + disposeRemove(id)
 * @param {function(string)} p.deleteObject - removes the object with that id and everything
 *        it made; does nothing when no object has that id
 * @param {Function} p.recreate    - () => ({objectID, trackID}) re-creating the object+track
 * @returns {{undo: Function, redo: Function, description: string}}
 */
export function makeCreateObjectUndoAction({name, objectID, trackID, trackManager, deleteObject, recreate}) {
    let curObjectID = objectID;
    let curTrackID = trackID;
    return {
        undo: () => {
            // The object first and then its track: the order of Delete Track's "Delete Track
            // and Object". The object leaves while it is still on its track. With the track
            // removed first, the object would go to its manual position, and so into the
            // track selectors, only to be deleted.
            if (curObjectID) deleteObject(curObjectID);
            if (curTrackID && trackManager.exists(curTrackID)) trackManager.disposeRemove(curTrackID);
        },
        redo: () => {
            const r = recreate() || {};
            curObjectID = r.objectID;
            curTrackID = r.trackID;
        },
        description: `Create object "${name}"`,
    };
}
