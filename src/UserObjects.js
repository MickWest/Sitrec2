// 3D objects that the user made, as opposed to objects that a sitch defines.
//
// Dependency-free, so the rules can be unit-tested without the node graph.

/**
 * True for an object the user made and can delete on its own: an object from Add 3D Object or
 * Add Object, or the object on a hand-drawn track. Their ids are generated as
 * `syntheticObject_<time>` (CustomManagerMenus). Objects that a sitch defines, such as the
 * traverse object or a camera's model, have other nodes that depend on them, so they are not
 * deletable. Nor is a balloon's sphere (`balloonObject_`): it is part of the balloon, which a
 * load always rebuilds with its sphere, so Delete Track on the balloon removes both.
 *
 * @param {string} id - the object's node id
 * @returns {boolean}
 */
export function isUserMadeObjectId(id) {
    return /^syntheticObject_/.test(String(id));
}

/**
 * The sub-nodes a 3D object owns, by id: the ones CNode3DObject and its controllers create as
 * `<objectID>_<name>` (_size, _color_colorInput, _modelLength, _ControllerTrackPosition, ...).
 * Every such name starts with a letter. NodeMan.UniqueName resolves a clash by adding `_1`, so
 * an id that continues with a digit belongs to ANOTHER object made in the same millisecond,
 * and is left alone.
 *
 * @param {string} objectID
 * @param {Iterable<string>} ids - every node id
 * @returns {string[]}
 */
export function ownedSubNodeIds(objectID, ids) {
    const prefix = objectID + "_";
    const owned = [];
    for (const id of ids) {
        if (id.startsWith(prefix) && !/^\d/.test(id.slice(prefix.length))) owned.push(id);
    }
    return owned;
}
