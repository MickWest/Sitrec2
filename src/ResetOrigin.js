import {NodeMan, Sit} from "./Globals";
import {EUSToLLA} from "./LLA-ECEF-ENU";


export function resetGlobalOrigin() {
    // The origin of the EUS coordinate system is initially set to near Los Angeles
    // if we move far from there, then the precision of the floating point numbers
    // will cause the origin to jitter, and we'll lose precision
    // so we can reset the origin to the current location

    const lookCamera = NodeMan.get("lookCamera").camera;
    const pos = lookCamera.position;

    const LLA = EUSToLLA(pos);
    console.log("Resetting Origin to " + LLA.x + ", " + LLA.y + ", " + LLA.z);
    Sit.lat = LLA.x;
    Sit.lon = LLA.y;

    // Note: Origin adjustment now handled by CFileManager.resetOrigin() which performs
    // a full serialize/deserialize cycle to properly reload all nodes with new coordinates
    // This ensures all LLA to EUS transformations are recalculated correctly

}