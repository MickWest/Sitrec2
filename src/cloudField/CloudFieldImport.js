// Turn a loaded SitrecCloudField JSON file into a CNodeCloudField.
// The file itself stays in the sitch's loadedFiles, so a saved sitch loads it
// again and this runs again; the node's own settings come back through its mods.

import {Globals, NodeMan, setRenderOne} from "../Globals";
import {showError} from "../showError";
import {cloudFieldNodeId, normalizeCloudField} from "./CloudFieldFormat";
import {CNodeCloudField} from "../nodes/CNodeCloudField";

/**
 * @returns {CNodeCloudField|null} the node, or null if the file was rejected.
 */
export function importCloudField(filename, json) {
    let field;
    try {
        field = normalizeCloudField(json);
    } catch (error) {
        showError(`Can't import cloud field "${filename}": ${error.message}`);
        return null;
    }
    const id = cloudFieldNodeId(filename);
    const existing = NodeMan.get(id, false);
    if (existing) {
        if (Globals.deserializing) return existing;
        // Dropping the same file again replaces the field.
        NodeMan.disposeRemove(existing);
    }
    const node = new CNodeCloudField({id, field});
    setRenderOne(true);
    return node;
}
