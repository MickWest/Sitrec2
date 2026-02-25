import {CNode} from "./CNode";
import {GlobalDateTimeNode, NodeMan, Sit} from "../Globals";
import {assert} from "../assert.js";
import {EUSToLLA, LLAToEUS} from "../LLA-ECEF-ENU";
import {roundIfClose} from "../utils";
import {saveAs} from "file-saver";

export class CNodeArray extends CNode {
    constructor(v) {
        v.frames = v.frames ?? v.array.length
        assert(v.array !== undefined, "CNodeArray array undefined")
        super(v);
        // frames?
        this.array = v.array
        this.reprojectFromLLA = v.reprojectFromLLA ?? false;

        if (this.reprojectFromLLA) {
            this.recalculate();
        }

        this.exportable = v.exportable ?? false;
        if (this.exportable) {
            NodeMan.addExportButton(this, "exportArray")
        }
    }

    // generic export function
    // if just a value, then export the value
    exportArray(inspect=false) {

        // if inspect mode, and the array is empty, then return null
        if (inspect && this.array.length === 0) {
            return null;
        }

        let csv;
        if (typeof this.array[0] !== "object") {
            csv = "frame, time, value\n";
            for (let f = 0; f < this.frames; f++) {
                // if it's not an object, then just export the value
                const time = GlobalDateTimeNode.frameToMS(f)
                let value = this.array[f];
                assert (value !== undefined, "CNodeArray exportArray found undefined value at frame " + f);

                csv += f + "," + time + "," + value + "\n";
            }
        } else {
            // if it's an object, assume we want to export LLA, with Alt in meters
            // might need to convert from feet to meters
            // however I need to verify that's actually used
            csv = "Frame,Time,Lat,Lon,Alt(m)\n"
            for (let f = 0; f < this.frames; f++) {
                let pos = this.array[f].lla
                let LLAm = []
                if (pos === undefined) {
                    // don't have an LLA, so convert from EUS
                    // this gives us altitude in meters
                    const posEUS = this.array[f].position
                    const posLLA = EUSToLLA(posEUS);
                    LLAm = [posLLA.x, posLLA.y, posLLA.z]
                } else {
                    // LLA should be in meters
   //                 LLAm = [pos[0], pos[1], f2m(pos[2])]
                    LLAm = [pos[0], pos[1], pos[2]]
  //                  debugger;
                }

                // Round altitude to nearest integer if within epsilon
                LLAm[2] = roundIfClose(LLAm[2], 1e-6);

                const time = GlobalDateTimeNode.frameToMS(f)
                csv += f + "," + time + "," + (LLAm[0]) + "," + (LLAm[1]) + "," + LLAm[2] + "\n"
            }
        }

        if (inspect) {
            return {
                desc: "Per-frame array with frame and time (ms)",
                csv: csv,
            }
        }
        else {
            saveAs(new Blob([csv]), "sitrecArray-" + this.id + ".csv")
        }
    }

    dispose() {
        super.dispose()
        if (this.exportButton !== undefined) {
            this.exportButton.dispose();
        }
    }

    recalculate() {
        if (!this.reprojectFromLLA) return;
        if (!Array.isArray(this.array)) return;

        for (let i = 0; i < this.array.length; i++) {
            const entry = this.array[i];
            if (entry?.lla === undefined) continue;
            const lla = entry.lla;
            entry.position = LLAToEUS(lla[0], lla[1], lla[2]);
        }
    }

    getValueFrame(frame) {
        return this.array[Math.floor(frame)]
    }
}
export class CNodeEmptyArray extends CNodeArray {
    constructor(v) {
        assert (v.array === undefined, "CNodeEmptyArray passed an array, use CArray if that's what you intended")
        v.array = []
        super(v)
    }
}

// example (data driven):
//     focalLength: {kind: "ManualData", data: [0,3000,  745, 1000,]},
export class CNodeManualData extends CNodeEmptyArray {
    constructor(v) {
        super(v);
        this.frames = Sit.frames;
        this.useSitFrames = true;
        this.data = v.data;
        this.array = new Array(this.frames);
        let dataIndex = 0;
        let dataLength = this.data.length;
        for (let f=0; f<this.frames;f++) {
            // if the NEXT frame value is less than or equal to the current frame,
            // then we need to move to the next data value
            while (dataIndex < dataLength-2 && this.data[dataIndex+2] <= f) {
                dataIndex += 2;
            }
            this.array[f] = this.data[dataIndex + 1];
        }

    }



}
