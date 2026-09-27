import {guiShowHide} from "./Globals";
import {t} from "./i18n";

// The Show ▸ "Lines of Sight (LOS)" sub-folder (CNodeDisplayLOS) and the Show ▸ "Frustum"
// sub-folder (CNodeDisplayCameraFrustum). Each is created by the first node that asks for it,
// so it sits where those controls used to be.
// They are NOT permanent folders: menuBar.destroy(false) removes them with the rest of the
// sitch's controls on a sitch change, so a cached folder is only reused while it is still attached.
const folders = {};

function getShowSubFolder(key) {
    const cached = folders[key];
    if (cached && guiShowHide.folders.includes(cached)) return cached;
    folders[key] = guiShowHide.addFolder(t(`menus.showHide.${key}.title`))
        .close()
        .tooltip(t(`menus.showHide.${key}.tooltip`));
    return folders[key];
}

export function getLOSFolder() {
    return getShowSubFolder("linesOfSight");
}

export function getFrustumFolder() {
    return getShowSubFolder("frustum");
}
