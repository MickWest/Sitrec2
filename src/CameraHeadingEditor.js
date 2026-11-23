import {guiMenus, NodeMan} from "./Globals";
import {CNodeControllerHeadingEditor} from "./nodes/CNodeControllerHeadingEditor";
import {setupCameraEditorMenu} from "./CameraEditorMenu";

export function setupHeadingEditor() {
    const source = NodeMan.get("CameraLOSController", false);
    const camera = NodeMan.get("lookCamera", false);
    if (!source || !camera || NodeMan.exists("headingEditor")) return;
    const editor = new CNodeControllerHeadingEditor({id: "headingEditor"});
    camera.addControllerNode(editor);
    setupCameraEditorMenu(guiMenus.cameraHeading, editor, "Heading");
}
