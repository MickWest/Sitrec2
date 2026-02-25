import {LLAToEUS} from "../LLA-ECEF-ENU";
import {FileManager, NodeMan, Sit} from "../Globals";
import {MISB, MISBFields} from "../MISBUtils";
import {CNodeEmptyArray} from "./CNodeArray";
import {saveAs} from "file-saver";

import {CNodeLOSTrackMISB} from "./CNodeLOSTrackMISB";
import {makeArrayNodeFromMISBColumn} from "./CNodeArrayFromMISBColumn";
import {assert} from "../assert";
import {EventManager} from "../CEventManager";
import {elevationAtLL} from "../threeExt";
import {parsePartialDateTime} from "../ParseUtils";
import {meanSeaLevelOffset} from "../EGM96Geoid";

//export const MISBFields = Object.keys(MISB).length;

// export const MISB_Aliases = {
//     // PrecisionTimeStamp uses microseconds not milliseconds
//     // so any conversion will have to detect this and multiply by 1000
//     PrecisionTimeStamp: MISB.UnixTimeStamp,
// }


export class CNodeMISBDataTrack extends CNodeEmptyArray {
    constructor(v) {
        super(v);
//        this.misb = FileManager.get(v.misbFile)

        // if v.misb is an array then it's the data, otherwise it's a file name
        // of an already converted MISB file
        if (Array.isArray(v.misb)) {
            this.misb = v.misb;
        } else {
            this.misb = FileManager.get(v.misb)
        }

        // For tracks with relative timestamps (e.g., seconds from 0), store metadata
        // to enable user override of start time via GUI
        if (v.trackFile && v.trackFile.isRelativeTime) {
            this.isRelativeTime = true;
            this.parsingBaseTime = v.trackFile.parsingBaseTime;
        }
        this.trackStartTime = "";       // user-entered ISO datetime string

        // G-force filter for removing spurious data points
        this.filterEnabled = false;
        this.filterMaxG = 3.0;  // 3g is a lot higher than you'd get in reality, but with sparse curved tracks the effective g can be quite high. Most spurious data will result in much higher values (like >100g)
        this.tryAltitudeFirst = true; // try replacing just altitude before removing the point
        this.filteredSlots = new Set();
        this.altitudeFixedSlots = new Map(); // slot -> corrected altitude

        this.selectSourceColumns(v.columns || ["SensorLatitude", "SensorLongitude", "SensorTrueAltitude", "AltitudeAGL"]);

        this.recalculate()

        this.exportable = v.exportable ?? false;
        if (this.exportable) {
            NodeMan.addExportButton(this, "exportMISBCSV")
            NodeMan.addExportButton(this, "exportTrackKML")
        }


        EventManager.addEventListener("elevationChanged", () => {
            if (this.useAGL) {

                // WHY DOES THIS NOT ADJSUT THE ALTITUDE BASED ON THE NEW ELEVATION?

                this.makeArrayForTrackDisplay();

                // CHECK IF THIS IS RECREATING THE DISPLAY TRACKS
                this.recalculateCascade()
            }
        });
    }

    // Add GUI text field for overriding the start time of relative-time tracks.
    // Uses onFinishChange to avoid parsing partial input while user is typing.
    // Supports partial datetime input (e.g., "10:30", "January 15") via chrono-node.
    setupTrackStartTimeGUI(guiFolder) {
        if (!this.isRelativeTime) return;

        this.trackStartTimeController = guiFolder.add(this, "trackStartTime").name("Start Time").listen()
            .onFinishChange(() => this.handleTrackStartTimeChange())
            .tooltip("Override start time (e.g., '10:30', 'Jan 15', '2024-01-15T10:30:00Z'). Leave blank for global start time.");

        this.addSimpleSerial("trackStartTime");
    }

    // Add GUI controls for the g-force filter
    setupFilterGUI(guiFolder) {
        const folder = guiFolder.addFolder("Filter Bad Data").close();
        folder.add(this, "filterEnabled").name("Enable Filter").listen().onChange(() => {
            this.runGForceFilter();
            this.recalculateCascade();
        });
        folder.add(this, "tryAltitudeFirst").name("Try Altitude First").listen().onChange(() => {
            this.runGForceFilter();
            this.recalculateCascade();
        });
        folder.add(this, "filterMaxG", 0.1, 10, 0.1).name("Max G").listen().onChange(() => {
            this.runGForceFilter();
            this.recalculateCascade();
        });

        this.addSimpleSerial("filterEnabled");
        this.addSimpleSerial("tryAltitudeFirst");
        this.addSimpleSerial("filterMaxG");
    }

    // Compute acceleration at slot b given neighbors a and c.
    // Returns acceleration in m/s², or -1 if it can't be computed.
    _computeAccelAtSlot(a, b, c) {
        const posA = this.getPosition(a);
        const posB = this.getPosition(b);
        const posC = this.getPosition(c);

        const timeA = this.getTime(a);
        const timeBMs = this.getTime(b);
        const timeC = this.getTime(c);

        const dtAB = (timeBMs - timeA) / 1000;
        const dtBC = (timeC - timeBMs) / 1000;
        if (dtAB <= 0 || dtBC <= 0) return -1;

        const velAB = posB.clone().sub(posA).divideScalar(dtAB);
        const velBC = posC.clone().sub(posB).divideScalar(dtBC);

        const dtAC = (timeC - timeA) / 2000;
        return velBC.clone().sub(velAB).length() / dtAC;
    }

    // Multi-pass g-force filter: marks slots where acceleration exceeds filterMaxG * 9.81 m/s²
    // Uses wide-baseline velocity estimates (minDt = 0.5s) to avoid false positives from
    // timestamp quantization noise in high-frame-rate data.
    // When tryAltitudeFirst is enabled, bad points first get their altitude replaced with
    // an interpolated value from neighbors. Only if that doesn't fix it is the point removed.
    runGForceFilter() {
        this.filteredSlots.clear();
        this.altitudeFixedSlots.clear();
        if (!this.filterEnabled) return;

        const maxAccel = this.filterMaxG * 9.81;
        const minDt = 0.5; // minimum time span for velocity estimates (seconds)
        let changed = true;

        while (changed) {
            changed = false;

            const validSlots = [];
            for (let i = 0; i < this.misb.length; i++) {
                if (!this.filteredSlots.has(i) && this._isValidBasic(i)) {
                    validSlots.push(i);
                }
            }

            for (let idx = 1; idx < validSlots.length - 1; idx++) {
                const b = validSlots[idx];

                // Find wide-baseline neighbors before and after B
                let aBefore = idx - 1;
                const timeBMs = this.getTime(b);
                while (aBefore >= 0 && (timeBMs - this.getTime(validSlots[aBefore])) / 1000 < minDt) aBefore--;
                if (aBefore < 0) aBefore = 0;

                let cAfter = idx + 1;
                while (cAfter < validSlots.length && (this.getTime(validSlots[cAfter]) - timeBMs) / 1000 < minDt) cAfter++;
                if (cAfter >= validSlots.length) cAfter = validSlots.length - 1;

                const a = validSlots[aBefore];
                const c = validSlots[cAfter];
                if (a === b || c === b) continue;

                const accel = this._computeAccelAtSlot(a, b, c);
                if (accel < 0) continue;

                if (accel > maxAccel) {
                    // Try altitude fix first if enabled
                    if (this.tryAltitudeFirst && !this.altitudeFixedSlots.has(b)) {
                        const timeA = this.getTime(a);
                        const timeC = this.getTime(c);
                        const t = (timeBMs - timeA) / (timeC - timeA);
                        const altA = this.getAltMSL(a);
                        const altC = this.getAltMSL(c);
                        const interpolatedAlt = altA + (altC - altA) * t;

                        // Temporarily apply the fix and recheck
                        this.altitudeFixedSlots.set(b, interpolatedAlt);
                        const newAccel = this._computeAccelAtSlot(a, b, c);

                        if (newAccel >= 0 && newAccel <= maxAccel) {
                            // Altitude fix worked — keep the point with corrected altitude
                            changed = true;
                            continue;
                        }
                        // Altitude fix didn't help — remove the fix and filter the point
                        this.altitudeFixedSlots.delete(b);
                    }

                    this.filteredSlots.add(b);
                    changed = true;
                }
            }
        }

        if (this.altitudeFixedSlots.size > 0) {
            console.log(`Altitude-fixed ${this.altitudeFixedSlots.size} points in track ${this.id}`);
        }
        if (this.filteredSlots.size > 0) {
            console.log(`Filtered ${this.filteredSlots.size} points from track ${this.id} (max ${this.filterMaxG}g)`);
        }
    }

    // Scan the track and return the peak g-force value (without modifying filteredSlots)
    // Uses the same wide-baseline approach as runGForceFilter.
    getMaxGForce() {
        const validSlots = [];
        for (let i = 0; i < this.misb.length; i++) {
            if (this._isValidBasic(i)) {
                validSlots.push(i);
            }
        }

        const minDt = 0.5;
        let maxG = 0;
        for (let idx = 1; idx < validSlots.length - 1; idx++) {
            const b = validSlots[idx];
            const timeBMs = this.getTime(b);

            let aBefore = idx - 1;
            while (aBefore >= 0 && (timeBMs - this.getTime(validSlots[aBefore])) / 1000 < minDt) aBefore--;
            if (aBefore < 0) aBefore = 0;

            let cAfter = idx + 1;
            while (cAfter < validSlots.length && (this.getTime(validSlots[cAfter]) - timeBMs) / 1000 < minDt) cAfter++;
            if (cAfter >= validSlots.length) cAfter = validSlots.length - 1;

            const a = validSlots[aBefore];
            const c = validSlots[cAfter];
            if (a === b || c === b) continue;

            const posA = this.getPosition(a);
            const posB = this.getPosition(b);
            const posC = this.getPosition(c);

            const timeA = this.getTime(a);
            const timeC = this.getTime(c);

            const dtAB = (timeBMs - timeA) / 1000;
            const dtBC = (timeC - timeBMs) / 1000;
            if (dtAB <= 0 || dtBC <= 0) continue;

            const velAB = posB.clone().sub(posA).divideScalar(dtAB);
            const velBC = posC.clone().sub(posB).divideScalar(dtBC);
            const dtAC = (timeC - timeA) / 2000;
            const accel = velBC.clone().sub(velAB).length() / dtAC;
            const g = accel / 9.81;
            if (g > maxG) maxG = g;
        }
        return maxG;
    }

    // Basic validity check without the g-force filter (used by runGForceFilter to avoid circular dependency)
    _isValidBasic(slotNumber) {
        let lat = this.getLat(slotNumber)
        let lon = this.getLon(slotNumber)
        let alt = this.getAltMSL(slotNumber)
        let time = this.getTime(slotNumber)

        if (isNaN(time) || time < 0 || time > 4102444800000) return false
        if (isNaN(lat) || isNaN(lon) || isNaN(alt)) return false
        if (lat < -90 || lat > 90) return false
        if (lon < -360 || lon > 360) return false
        if (alt < -1000) return false
        if (alt > 36000000) return false

        if (lat === 0) {
            if (this.lastValidSlot === undefined || Math.abs(this.getLat(this.lastValidSlot)) > 1.0) {
                return false;
            }
        }
        if (lon === 0) {
            if (this.lastValidSlot === undefined || Math.abs(this.getLon(this.lastValidSlot)) > 1.0) {
                return false;
            }
        }

        return true;
    }

    // Parse trackStartTime using chrono-node with parsingBaseTime as reference.
    // Updates trackStartTime to the normalized ISO string if parsing succeeds.
    async handleTrackStartTimeChange() {
        if (!this.trackStartTime || this.trackStartTime.trim() === "") {
            this.recalculateCascade();
            return;
        }
        
        const referenceDate = new Date(this.parsingBaseTime);
        const parsed = await parsePartialDateTime(this.trackStartTime, referenceDate);
        
        if (parsed) {
            const isoString = parsed.toISOString();
            // Skip if already normalized to avoid setValue() triggering onFinishChange loop
            if (this.trackStartTime !== isoString) {
                // Use setValue() to update both value and display
                this.trackStartTimeController?.setValue(isoString);
            }
            this.recalculateCascade();
        }
    }

    // Compute time offset in seconds from trackStartTime.
    // Used by CNodeTrackFromMISB.getValue() to combine with timeOffset.
    // Returns 0 if trackStartTime is empty or invalid.
    getTrackStartTimeOffsetSeconds() {
        if (!this.trackStartTime || this.trackStartTime.trim() === "") {
            return 0;
        }
        const parsed = Date.parse(this.trackStartTime);
        if (isNaN(parsed)) {
            return 0;
        }
        // parsingBaseTime is when track timestamps were computed
        // trackStartTime is when user says track actually started
        // Return offset in seconds (negative if track starts later than parsing base)
        return (this.parsingBaseTime - parsed) / 1000;
    }

    exportMISBCSV(inspect = false) {
        let csv = ""
        // MISB is an object of name -> index pairs, so we can get the column name from the index
        // but have to search for it.
        for (let i=0;i<MISBFields;i++) {
            let name = "unknown";
            for (let key in MISB) {
                if (MISB[key] === i) {
                    name = key;
                    break;
                }
            }
            csv = csv + name + (i<MISBFields-1?",":"\n");
        }

        for (let f=0;f<this.misb.length;f++) {
            for (let i=0;i<MISBFields;i++) {
                let value = this.misb[f][i];
                // if not null and an object, then replace with "COMPLEX"
                // (null is considered an object - a quirk of JS)
                if (value !== null && typeof value === "object") {
                        value = "COMPLEX"
                }

                csv = csv + value + (i<MISBFields-1?",":"\n");
            }
        }
        if (inspect) {
            return {
                desc: "MISB CSV Export",
                csv: csv,
            }
        }
        else {
            saveAs(new Blob([csv]), "MISB-DATA" + this.id + ".csv")
        }
    }

    exportTrackKML(inspect = false) {
        const trackName = Sit.name + "-" + this.id;
        let kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
<Folder>
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

        for (let f = 0; f < this.misb.length; f++) {
            if (!this.isValid(f)) continue;
            const timeMS = this.getTime(f);
            const dateStr = new Date(timeMS).toISOString();
            whenLines.push(`<when>${dateStr}</when>`);

            const lat = this.getLat(f);
            const lon = this.getLon(f);
            const alt = this.getAltMSL(f);
            coordLines.push(`<gx:coord>${lon} ${lat} ${alt}</gx:coord>`);
        }

        kml += whenLines.join("\n") + "\n";
        kml += coordLines.join("\n") + "\n";
        kml += `</gx:Track>
</Placemark>
</Folder>
</kml>`;

        if (inspect) {
            return {
                desc: "KML Track Export",
                kml: kml,
            };
        } else {
            saveAs(new Blob([kml], {type: "application/vnd.google-earth.kml+xml"}), trackName + ".kml");
        }
    }

    // given an array of the MISB column names for lat,lon,alt
    // then store the column indices for the lat, lon, and alt
    // this is soe we can switch between the sensor LLA, the frame center LLA, and the corners
    selectSourceColumns(columns) {
        this.latCol = MISB[columns[0]]
        this.lonCol = MISB[columns[1]]
        this.altCol = MISB[columns[2]]
        this.useAGL = false;
        // check to see if we have data in altCol
        if (this.misb[0][this.altCol] === null) {
            this.useAGL = true;
            this.altCol = MISB[columns[3]]; // this is the altitude column
            assert(this.misb[0][this.altCol] !== undefined, "CNodeMISBDataTrack: AGL altitude column not found in MISB data");
        }
    }



    // to display the full length track of original source data, (like, for a KML)
    // we need to make an array of EUS positions for each point in the track
    // NOTE: this is a DATA track, not a camera/position
    // and this array is just to display the shape of the track,
    makeArrayForTrackDisplay() {
        this.array = [];
        var points = this.misb.length
        for (var f = 0; f < points; f++) {
            // we only handle rows that have valid data
            if (this.isValid(f)) {
                var pos = LLAToEUS(this.getLat(f), this.getLon(f), this.getAltHAE(f));
                this.array.push({position: pos})
            } else if (this.filteredSlots.has(f)) {
                // Filtered out by g-force filter — skip silently
                this.array.push({})
            } else {
                // otherwise, just give it an empty structure
                console.warn("CNodeMISBDataTrack: invalid data at frame " + f + " in track " + this.id + " lat=" + this.getLat(f) + " lon=" + this.getLon(f) + " alt=" + this.getAltMSL(f));
                console.warn("Returning empty object {}")
                assert(0, "CNodeMISBDataTrack: invalid data at frame " + f + " in track " + this.id);
                this.array.push({})
            }

        }
        this.frames = points;

    }

    getTrackStartTime() {
        return this.getTime(0)
    }

    getLat(i) {
        return Number(this.misb[i][this.latCol]);
    }

    getLon(i) {
        return Number(this.misb[i][this.lonCol]);
    }

    getRawAlt(i) {
        let alt = Number(this.misb[i][this.altCol])
        if (!this.useAGL) {
            // if we are not using AGL, then the altitude is the true altitude
            return alt;
        }
        // if we are using AGL, then the altitude is the AGL altitude
        // so we need to adjust it to be the true altitude
        const lat = this.getLat(i);
        const lon = this.getLon(i);
       // const position = LLAToEUS(lat, lon, alt);
        // get the base altitude at this position
        const elevation = elevationAtLL(lat, lon);
        alt += elevation;
        return alt;


    }

    adjustAlt(a, lat, lon) {
        if (this.altitudeLock !== undefined && this.altitudeLock !== -1) {
            if (this.altitudeLockAGL && lat !== undefined && lon !== undefined) {
                return elevationAtLL(lat, lon) + this.altitudeLock;
            }
            return this.altitudeLock;
        } else if (this.altitudeOffset !== undefined) {
            return a + this.altitudeOffset
        }
        return a;
    }


    // Returns MSL altitude (orthometric). Use for exports (KML, CSV, GeoJSON).
    getAltMSL(i) {
        // If this slot had its altitude corrected by the filter, use that
        if (this.altitudeFixedSlots && this.altitudeFixedSlots.has(i)) {
            return this.altitudeFixedSlots.get(i);
        }
        let a = this.getRawAlt(i);
        return this.adjustAlt(a, this.getLat(i), this.getLon(i));
    }

    // Returns HAE altitude (h = H + N). Use for EUS/ECEF conversions.
    getAltHAE(i) {
        const lat = this.getLat(i);
        const lon = this.getLon(i);
        return this.getAltMSL(i) + meanSeaLevelOffset(lat, lon);
    }

    // get time at frame i in milliseconds since epoch
    // MISB data (or converted CSV data) can be in seconds, milliseconds, or microseconds
    // so we have to detect which and convert to milliseconds
    getTime(i) {
        let time = Number(this.misb[i][MISB.UnixTimeStamp])
        // check to see if it's in milliseconds or microseconds
        if (time > 31568461000000) {   // 31568461000000 is 1971 using microseconds, but 2970 using milliseconds
            time = time / 1000
        } else if (time < 31568461000) { // <1971 in milliseconds, less than 2970 in seconds, so seconds
            time = time * 1000
        }
        return time
    }

    // given a time, find the first frame that is at or after that time
    getIndexAtTime(time) {
        let points = this.misb.length
        for (let f = 0; f < points; f++) {
            if (this.getTime(f) >= time) {
                return f;
            }
        }
        return 0
    }

    // get EUS position at frame i
    getPosition(i) {
        return LLAToEUS(this.getLat(i), this.getLon(i), this.getAltHAE(i));
    }

    // given a time in ms (UNIX time), return the position at that time
    getPositionAtTime(time) {
        return this.getPosition(this.getIndexAtTime(time));
    }


    // a slot is valid if it has a valid timestamp
    // and the lat/lon/alt are not NaN
    isValid(slotNumber) {
        if (this.filteredSlots && this.filteredSlots.has(slotNumber)) return false;
        let lat = this.getLat(slotNumber)
        let lon = this.getLon(slotNumber)
        let alt = this.getAltMSL(slotNumber)
        let time = this.getTime(slotNumber)

        // time is in unix time, check its a number and from 1970 to 2100
        if (isNaN(time) || time < 0 || time > 4102444800000) return false
        // lat, lon, alt are floats, check they are not NaN
        if (isNaN(lat) || isNaN(lon) || isNaN(alt)) return false
        // check lat is -90 to 90
        if (lat < -90 || lat > 90) return false
        // and lon is -180 to 180, but allow to 360 as some data might be 0..360, or even (unlikely) -360..0
        // basically jsut checking they are reasonable numbers
        if (lon < -360 || lon > 360) return false
        // and alt is a positive number, allowing a little leeway for the ground
        if (alt < -1000) return false
        // nothing beyond geostationary orbit
        // not expecting anything out of the atmosphere, but just in case.
        // again just checking for reasonable numbers
        if (alt > 36000000) return false

        // check for zeros, as they are likely to be invalid
        if (lat ===0 ) {
            // check if the last valid slot's lat was near zero, if so we allow this
            if (this.lastValidSlot === undefined || Math.abs(this.getLat(this.lastValidSlot)) > 1.0) {
                return false;
            }
        }

        if (lon ===0 ) {
            // check if the last valid slot's lon was near zero, if so we allow this
            if (this.lastValidSlot === undefined || Math.abs(this.getLon(this.lastValidSlot)) > 1.0) {
                return false;
            }
        }

        if (alt ===0 ) {
            // always allow alt === 0, as it's common for grounded planes (ADS-B)
            // maybe we might want to check if it is on the ground and use terrain elevation?
            // // check if the last valid slot's alt was near zero, if so we allow this
            // if (this.lastValidSlot === undefined || Math.abs(this.getAltMSL(this.lastValidSlot)) > 1000) {
            //     return false;
            // }
            if (!this.warnedAboutZeroAltitude)
                console.warn("Altitude is zero at slot " + slotNumber + " (and maybe others) in track " + this.id+" (allowed, likely grounded plane)");
            this.warnedAboutZeroAltitude = true;
        }



        this.lastValidSlot = slotNumber;


        return true;

    }


    recalculate() {
        this.runGForceFilter();
        this.makeArrayForTrackDisplay()
    }
}


// given a track with MISB style platform and sensor Az/El/Roll
// extract them into arrays and then use those arrays
// to create CNodeLOSTrackMISB
export function makeLOSNodeFromTrackAngles(trackID, data) {
    const cameraTrackAngles = NodeMan.get(trackID);
    const smooth = data.smooth ?? 0;

    makeArrayNodeFromMISBColumn(trackID+"platformHeading", cameraTrackAngles, data.platformHeading ?? MISB.PlatformHeadingAngle, smooth, true)
    makeArrayNodeFromMISBColumn(trackID+"platformPitch", cameraTrackAngles, data.platformPitch ?? MISB.PlatformPitchAngle, smooth, true)
    makeArrayNodeFromMISBColumn(trackID+"platformRoll", cameraTrackAngles, data.platformRoll ?? MISB.PlatformRollAngle, smooth, true)
    makeArrayNodeFromMISBColumn(trackID+"sensorAz", cameraTrackAngles, data.sensorAz ?? MISB.SensorRelativeAzimuthAngle, smooth, true)
    makeArrayNodeFromMISBColumn(trackID+"sensorEl", cameraTrackAngles, data.sensorEl ?? MISB.SensorRelativeElevationAngle, smooth, true)
    makeArrayNodeFromMISBColumn(trackID+"sensorRoll", cameraTrackAngles, data.sensorRoll ?? MISB.SensorRelativeRollAngle, smooth, true)

    const node = new CNodeLOSTrackMISB({
        id: data.id ?? trackID+"_LOS", cameraTrack: trackID,
        platformHeading: trackID+"platformHeading", platformPitch: trackID+"platformPitch", platformRoll: trackID+"platformRoll",
        sensorAz: trackID+"sensorAz", sensorEl: trackID+"sensorEl", sensorRoll: trackID+"sensorRoll"
    })

    return node;
}

export function removeLOSNodeColumnNodes(trackID) {
    console.log("removeLOSNodeColumnNodes: trackID="+trackID);
    NodeMan.disposeRemove(trackID+"platformHeading")
    NodeMan.disposeRemove(trackID+"platformPitch")
    NodeMan.disposeRemove(trackID+"platformRoll")
    NodeMan.disposeRemove(trackID+"sensorAz")
    NodeMan.disposeRemove(trackID+"sensorEl")
    NodeMan.disposeRemove(trackID+"sensorRoll")
}

