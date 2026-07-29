import {CNode} from "./CNode";
import {GlobalDateTimeNode, NodeMan, Sit} from "../Globals";
import {assert} from "../assert";
import {ECEFToLLAVD_radii, LLAToECEF} from "../LLA-ECEF-ENU";
import {roundIfClose} from "../utils";
import {saveAs} from "file-saver";
import {meanSeaLevelOffset} from "../EGM96Geoid";

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
        // Direct CNodeArray instances ONLY. Registering an export button probes the
        // export function immediately (makeExportButton calls it with inspect=true),
        // and doing that from a base constructor calls it on a half-built object:
        // a subclass override like CNodeMISBDataTrack.exportTrackKML reads this.misb,
        // which that subclass assigns AFTER super() returns, so it throws and leaves
        // a registered-but-unconstructed node in NodeMan.
        //
        // Nothing is lost. A CNodeEmptyArray subclass has array = [] at this point,
        // so both probes found nothing anyway; subclasses register their own buttons
        // once their data exists (see CNodeMISBDataTrack, CNodeSmoothedPositionTrack,
        // and CNodeTrackClosest's addArrayExportButtons() call after recalculate).
        if (this.exportable && this.constructor === CNodeArray) {
            this.addArrayExportButtons();
        }
    }

    // Subclasses that fill this.array AFTER super() (e.g. CNodeTrackClosest) call
    // this again once the data exists: exportArray's probe returns null on an empty
    // array, so the constructor pass adds no CSV button. (The KML probe is
    // capability-based and does add its button on the first pass; addExportButton
    // dedupes, so the retry is harmless.)
    addArrayExportButtons() {
        NodeMan.addExportButton(this, "exportArray")
        NodeMan.addExportButton(this, "exportTrackKML")
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
                    // don't have an LLA, so convert from ECEF
                    // this gives us altitude in meters
                    const posECEF = this.array[f].position
                    const posLLA = ECEFToLLAVD_radii(posECEF);
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

    // Google Earth gx:Track. Moved down here from CNodeTrack so that any array
    // of per-frame {position} or {lla} can export one — CNodeTrackClosest and
    // the raw LLA track arrays are plain CNodeArrays, not CNodeTracks.
    exportTrackKML(inspect = false) {
        // The inspect probe runs at node CREATION for every export button, so it
        // must stay O(1) — building the whole KML here (as this did when it lived
        // on CNodeTrack) meant 7000+ Date.toISOString() calls before the node was
        // even usable. Probe by capability, not by data: an empty array means a
        // lazily-recalculated track, which still gets its button.
        if (inspect) {
            const first = this.array?.[0];
            if (first !== undefined && typeof first !== "object") {
                // a scalar array (FOV, heading, ...) — nothing to put in a gx:Track
                return null;
            }
            return {desc: "KML Track Export"};
        }

        const trackName = Sit.name + "-" + this.id;
        // <Document>, not <Folder>: CTrackFileKML.legacyTrackName resolves a name for
        // Document>Placemark but NOT for Folder>Placemark, where it deliberately leaves
        // the name unset for back-compat — so a Folder-rooted export re-imports as
        // "Unnamed Track". Document is also the conventional KML root container.
        let kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
<Document>
<name>${trackName}</name>
<Placemark>
<name>${trackName}</name>
<Style>
<LineStyle><color>ff0000ff</color><width>4</width></LineStyle>
<IconStyle><Icon><href>http://maps.google.com/mapfiles/kml/shapes/airports.png</href></Icon></IconStyle>
</Style>
<gx:Track>
<altitudeMode>absolute</altitudeMode>
<extrude>1</extrude>
`;
        const whenLines = [];
        const coordLines = [];

        for (let f = 0; f < this.frames; f++) {
            const timeMS = GlobalDateTimeNode.frameToMS(f);
            const dateStr = new Date(timeMS).toISOString();
            whenLines.push(`<when>${dateStr}</when>`);

            const frameData = this.v(f);
            let lat, lon, alt;
            let altReference = "HAE";
            if (frameData.lla) {
                [lat, lon, alt] = frameData.lla;
                altReference = frameData.altReference ?? "HAE";
            } else if (frameData.position) {
                const llaVec = ECEFToLLAVD_radii(frameData.position);
                lat = llaVec.x;
                lon = llaVec.y;
                alt = llaVec.z;
            } else {
                lat = 0;
                lon = 0;
                alt = 0;
            }

            // KML "absolute" altitude is measured from the EGM96 geoid (MSL) per
            // OGC KML 2.2/2.3 — Google Earth reads it as height above sea level.
            // Convert HAE frames to MSL (H = h - N), mirroring exportMISBCompliantCSV.
            if (altReference === "HAE") {
                alt -= meanSeaLevelOffset(lat, lon);
            }
            coordLines.push(`<gx:coord>${lon} ${lat} ${alt}</gx:coord>`);
        }

        kml += whenLines.join("\n") + "\n";
        kml += coordLines.join("\n") + "\n";
        kml += `</gx:Track>
</Placemark>
</Document>
</kml>`;

        saveAs(new Blob([kml], {type: "application/vnd.google-earth.kml+xml"}), trackName + ".kml");
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
            entry.position = LLAToECEF(lla[0], lla[1], lla[2]);
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
