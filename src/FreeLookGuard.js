// Turning Free Look OFF when the user reaches for the controls it is suspending.
//
// Free Look hands the look camera to the mouse, and while it is on CNodeCamera.applyControllers()
// refuses every computed pose source. So the Camera menu's Location and Heading folders go quiet:
// you can drag Pan all you like and the view does not move. That is the mode working as designed,
// and it is also indistinguishable from the control being broken.
//
// So touching one of those controls switches Free Look off first. Nothing is lost by that — the
// mode publishes where you flew to as it goes (syncFreeLookPosition), and switching off syncs the
// manual PTZ angles from the live camera — so the camera stays exactly where it is, and the
// control the user just reached for takes effect from there.
//
// It hooks the FOLDERS rather than the individual controllers, in the CAPTURE phase, on the raw
// DOM events. Three things follow from that, and each is the reason for it:
//
//   - a DOM event is, by definition, a person doing it by hand. lil-gui's onChange fires for a
//     programmatic setValue too, and Free Look itself writes the camera's Location on every mouse
//     move (syncFreeLookPosition -> PositionLLA.onChange), so a value hook would switch the mode
//     off on the first drag of the very gesture it is meant to serve.
//   - a folder covers every control inside it, including the ones a sitch adds later — a dropped
//     angles file's "Custom Az/El", the EXIF relative-altitude button — with no list to maintain.
//   - capture phase, and pointerDOWN rather than a change, so the mode is already off by the time
//     the widget acts on the gesture. A slider drag then moves the camera as you drag it.

import {guiMenus, NodeMan, setRenderOne} from "./Globals";
import {ViewMan} from "./CViewManager";
import {showViewMessage} from "./ViewMessage";
import {t} from "./i18n";

// The permanent Camera sub-folders that hold the parts of the look camera's POSE — which is
// exactly what Free Look suspends, and so exactly what would appear broken while it is on.
//
// Two Camera folders are deliberately NOT here:
//   FOV (Zoom)    — the field of view is not part of the pose and is never suspended.
//                   applyFOVControllers keeps it live under Free Look on purpose (see
//                   CNodeCamera.applyControllers): flying the camera by hand and choosing what
//                   lens it has are separate decisions, and framing what you have just flown to
//                   is a thing you do WHILE flying. Nothing there conflicts, so nothing there
//                   should end the mode.
//   Camera Tweaks — the Free Look switch itself lives there, next to per-camera settings (near
//                   plane, Y-compress) that are not a pose either.
const GUARDED_FOLDERS = ["cameraLocation", "cameraHeading"];

// Keys that move focus or abandon an edit rather than changing a value.
const NON_EDITING_KEYS = new Set(["Tab", "Escape", "Shift", "Control", "Alt", "Meta", "CapsLock"]);

// The manual position node the look camera flies from — the one Free Look itself publishes into
// as you fly (CNodeCamera.syncFreeLookPosition), and the one the position key (C) drops the
// camera onto. Named here rather than in the position node, which is generic: the target's
// position node is the same class with the same key mechanism, and moving the TARGET is not a
// camera move.
const CAMERA_POSITION_NODE = "fixedCameraPosition";

/**
 * Exempt one control from the guard: it lives in a guarded folder but does not move the camera.
 * Marked on the control rather than listed here, so the exemption sits with the thing it excuses
 * and cannot outlive it.
 *
 * @param {object} controller a lil-gui Controller
 * @returns {object} the same controller, for chaining
 */
export function markFreeLookSafe(controller) {
    if (controller?.domElement) controller.domElement.dataset.freeLookSafe = "true";
    return controller;
}

/**
 * Watch the Camera menu's pose folders for a hand-made edit. Idempotent, and
 * safe to call before the folders exist — the flag lives on the folder's own DOM element, so a
 * folder that is rebuilt is re-guarded and one that is not is never double-hooked.
 */
export function installFreeLookGuards() {
    for (const name of GUARDED_FOLDERS) {
        const folder = guiMenus[name];
        const element = folder?.domElement;
        if (!element || element._freeLookGuarded) continue;
        element._freeLookGuarded = true;

        element.addEventListener("pointerdown", onCameraFolderGesture, true);
        element.addEventListener("keydown", onCameraFolderGesture, true);

        // Backstop for the one edit that has no gesture of its own: the wheel over a slider.
        // It cannot be caught on the way in — lil-gui ignores a vertical wheel when the panel
        // has a scrollbar, so a capture-phase wheel listener cannot tell an edit from a scroll —
        // but a wheel that DID move a slider ends in _callOnFinishChange like every other edit.
        // Wrapped rather than registered through the public onFinishChange, which is a single
        // slot the folder's own owner may want.
        wrapFinishChange(folder);
    }
}

function onCameraFolderGesture(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (event.type === "keydown" && NON_EDITING_KEYS.has(event.key)) return;
    // Opening or closing a folder is navigation, not an edit.
    if (target.closest(".title")) return;
    if (target.closest("[data-free-look-safe]")) return;
    disableFreeLook();
}

// Run the guard after anything in `folder` (or a folder inside it) finishes an edit, keeping
// lil-gui's own behaviour and its return value.
function wrapFinishChange(folder) {
    const inherited = folder._callOnFinishChange.bind(folder);
    folder._callOnFinishChange = (controller) => {
        const result = inherited(controller);
        if (!controller?.domElement?.closest("[data-free-look-safe]")) disableFreeLook();
        return result;
    };
}

/**
 * The other hand-made camera move: holding the position key (C) over a 3D view to drop the
 * camera on the point under the cursor. Not a menu edit, so the folder guard above never sees
 * it — and while Free Look is on, the pose is suspended, so without this the key appears to do
 * nothing at all.
 *
 * Call it BEFORE writing the new position: switching Free Look off publishes where the camera
 * was flown to, which would otherwise land on top of the position just chosen.
 *
 * @param {object} positionNode the CNodePositionLLA about to be moved
 * @returns {boolean} true if Free Look was on and is now off
 */
export function disableFreeLookForCameraPosition(positionNode) {
    if (positionNode?.id !== CAMERA_POSITION_NODE) return false;
    return disableFreeLook();
}

/**
 * Switch Free Look off because the user asked for something it was in the way of, and say so
 * over the view it was flying — the control they touched is in a menu, and the thing that just
 * changed is in the viewport.
 *
 * @returns {boolean} true if Free Look was on and is now off
 */
export function disableFreeLook() {
    const camera = NodeMan.get("lookCamera", false);
    if (!camera?.freeLook) return false;

    camera.freeLook = false;
    setRenderOne(true);

    const view = camera.getRenderingView?.() ?? ViewMan.get("lookView", false);
    showViewMessage(view, t("misc.freeLookDisabled"));
    return true;
}
