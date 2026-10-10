// Turn a loaded SitrecPhotoBackdrop JSON file into a CNodePhotoBackdrop.
// The file itself stays in the sitch's loadedFiles, so a saved sitch loads it again and this
// runs again; the node's own settings come back through its mods.

import {Globals, NodeMan, setRenderOne} from "../Globals";
import {showError} from "../showError";
import {t} from "../i18n";
import {normalizePhotoBackdrop, photoBackdropNodeId} from "./PhotoBackdropFormat";
import {CNodePhotoBackdrop} from "../nodes/CNodePhotoBackdrop";

/**
 * @returns {CNodePhotoBackdrop|null} the node, or null if the file was rejected.
 */
export function importPhotoBackdrop(filename, json) {
    let backdrop;
    try {
        backdrop = normalizePhotoBackdrop(json);
    } catch (error) {
        showError(t("photoBackdrop.importError", {filename, message: error.message}));
        return null;
    }
    const id = photoBackdropNodeId(filename);
    const existing = NodeMan.get(id, false);
    if (existing) {
        if (Globals.deserializing) return existing;
        // Dropping the same file again replaces the backdrop.
        NodeMan.disposeRemove(existing);
    }
    const node = new CNodePhotoBackdrop({id, backdrop});
    setRenderOne(true);
    return node;
}
