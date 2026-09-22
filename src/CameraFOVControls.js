import {Globals, guiMenus} from "./Globals";

// Keep mode visibility separate from lil-gui's own show/disable state. Source
// selection, video aspect locks and EXIF metadata can update that state while
// another projection is active, and must still be respected when it is restored.
export function updateCameraFOVControls() {
    const parent = guiMenus.cameraFOV;
    if (!parent) return;
    const doc = parent.domElement.ownerDocument;
    if (!doc.getElementById("camera-projection-controls-style")) {
        const style = doc.createElement("style");
        style.id = "camera-projection-controls-style";
        style.textContent = ".camera-projection-inactive { display: none !important; }";
        doc.head.appendChild(style);
    }

    const fish = !!Globals.fisheye?.enabled;
    const pano = !!Globals.panoramic?.enabled;
    const setActive = (controller, active) => {
        controller.domElement.classList.toggle("camera-projection-inactive", !active);
        // Inert blocks pointer and keyboard interaction without overwriting the
        // controller's own disabled state (e.g. the read-only aspect readout).
        controller.domElement.inert = !active;
    };
    for (const controller of parent.controllers) setActive(controller, !fish && !pano);
    for (const folder of parent.folders) {
        const active = folder._title === "Fisheye" ? fish
            : folder._title === "Panoramic Camera" ? pano : !fish && !pano;
        for (const controller of folder.controllers) {
            const modeSwitch = controller.property === "enabled"
                && (controller.object === Globals.fisheye || controller.object === Globals.panoramic);
            setActive(controller, modeSwitch || active);
        }
    }
}
