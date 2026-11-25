import {NodeMan, setRenderOne} from "./Globals";

// Controller-backed gestures change input values, not the camera itself. Keep
// those changes responsive between simulation ticks without recalculating the
// whole sitch. Several pointer events before one draw collapse to one update.
const pendingCameras = new Set();

export function requestCameraInputUpdate(cameraNode) {
    if (typeof cameraNode?.update !== "function") return;
    pendingCameras.add(cameraNode);
    setRenderOne(true);
}

export function flushCameraInputUpdates(frame, nodesUpdated = false) {
    if (!pendingCameras.size) return;
    const cameras = [...pendingCameras];
    pendingCameras.clear();
    if (nodesUpdated) return;

    const updated = new Set();
    for (const cameraNode of cameras) {
        // A sitch can be replaced between the gesture and the next draw.
        if (NodeMan.get(cameraNode.id, false) !== cameraNode) continue;
        // Preserve the complete ordered controller stack and camera overrides.
        // The frame is unchanged; this does not advance simulation or cascade.
        cameraNode.update(frame);
        updated.add(cameraNode);
    }
    if (!updated.size) return;

    // Frusta display the camera in other views, but are not graph outputs of
    // it. Refresh only opted-in displays; no whole-sitch cascade is needed.
    for (const {data: node} of Object.values(NodeMan.list ?? {})) {
        if (node.updateOnCameraInput && updated.has(node.cameraNode)) {
            node.update(frame);
        }
    }
}
