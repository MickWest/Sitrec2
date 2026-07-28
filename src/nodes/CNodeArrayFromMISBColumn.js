import {CNodeEmptyArray} from "./CNodeArray";
import {MISB} from "../MISBUtils";
import {ExpandMISBKeyframes} from "../utils";
import {RollingAverage, RollingAverageDegrees} from "../smoothing";
import {CNode} from "./CNode";
import {assert} from "../assert";
import {showError} from "../showError";

// These nodes replace the manually created CNodeArrays
// in makeArrayNodeFromMISBColumn in CNodeArray.js
// makeArrayNodeFromMISBColumn is deprecated

export class CNodeArrayFromMISBColumn extends CNodeEmptyArray {
    constructor(v) {
        super(v);
        this.input("misb");
        let columnIndex = v.columnIndex;
        if (typeof columnIndex === "string") {
            // strip off the initial "MISB." if it exists
            if (columnIndex.startsWith("MISB.")) {
                columnIndex = columnIndex.slice(5);
            }
            columnIndex = MISB[columnIndex];
        }
        this.columnIndex = columnIndex;
        this.smooth = v.smooth;
        this.degrees = v.degrees;
        this.recalculate();
    }

    recalculate() {

        // this.in.misb is a track that has "misbRow" properties for each entry
        // the number of frames in the track is the length of the array
        // so we inherit that

        // first check if there's a sourceArray, if not, use the array
        // sourceArray is the original array in a smoothed node
        let inputArray = this.in.misb.sourceArray

        if (inputArray === undefined) {
            inputArray = this.in.misb.array;
        }

        this.frames = inputArray.length; // not sure if we want to do it like that

        // this.degrees has to reach the INTERPOLATION, not just the smoothing below.
        // Every angle column is created with degrees=true (see
        // makeLOSNodeFromTrackAngles), but the flag used to stop here, so a heading
        // or azimuth crossing north between two sparse keyframes was interpolated
        // the long way round — 359 degrees of sweep in place of a fraction of one.
        this.array = ExpandMISBKeyframes(inputArray, this.columnIndex, this.degrees);

        if (this.smooth !== 0) {
            if (this.degrees)
                this.array = RollingAverageDegrees(this.array, this.smooth);
            else
                this.array = RollingAverage(this.array, this.smooth);
        }
    }
}

export function makeArrayNodeFromMISBColumn(id, misbTrack, columnIndex, smooth = 0, degrees = false) {

    // asset that the misbTrack is derived from CNode
    assert(misbTrack instanceof CNode, "makeArrayNodeFromMISBColumn: misbTrack is not a CNode");

    try {
        const node = new CNodeArrayFromMISBColumn({
            id: id,
            misb: misbTrack,
            columnIndex: columnIndex,
            smooth: smooth,
            degrees: degrees
        });
        return node;
    } catch (e) {
        showError(e);
        return null;
}

}
