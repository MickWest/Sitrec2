// Field-of-view helpers.
//
// Deliberately a leaf module: it imports only MISBFields (which imports nothing)
// and assert. extractFOV used to live in CNodeControllerVarious, which pulls in
// three/addons via threeExt and so cannot be imported from a Jest-tested module.
// CNodeControllerVarious re-exports it, so existing call sites are unchanged.

import {MISB} from "./MISBFields";
import {assert} from "./assert";

/**
 * Normalise whatever a FOV source node yields into a vertical FOV in degrees.
 *
 * A FOV source is not always a plain number:
 *  - a number is the FOV itself
 *  - a dropped MISB track yields a row, where tag 16 is the sensor vertical FOV
 *  - some tracks carry an explicit vFOV member
 */
export function extractFOV(value) {

    // if it's a number then use that directly as the FOV
    if (typeof value === "number") {
        return value;
    } else if (value.misbRow !== undefined) {
        // Note: some tracks have both misbRow and vFOV
        // in that case, we'll ignore the vFOV and just use the MISB row
        return value.misbRow[MISB.SensorVerticalFieldofView];
    } else if (value.vFOV !== undefined) {
        // it's a track with a vFOV member
        return  value.vFOV;
    } else {
        assert(0, "extractFOV: no vFOV or misbRow member in value, can't find FOV, value = "+value);
    }
}
