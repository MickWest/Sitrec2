import {CTrackFile} from "./CTrackFile";
import {MISB, MISBFields} from "../MISBFields";
import {atan, degrees, radians, tan} from "../mathUtils";
import {timeStrToEpoch} from "../DateTimeUtils";

export const SRT = {
    FrameCnt: 0,
    DiffTime:1,
    iso:2,
    shutter:3,
    fnum:4,
    ev:5,
    color_md:6,
    focal_len:7,
    latitude:8,
    longitude:9,
    rel_alt:10,
    abs_alt:11,
    ct:12,
    date: 13,
    heading: 14,
    pitch: 15,
    roll: 16,
    gHeading: 17,
    gPitch: 18,
    gRoll: 19,
}

const SRTMapMISB = {
    FrameCnt: null,
    DiffTime: null,
    iso:null,
    shutter:null,
    fnum:null,
    ev:null,
    color_md:null,
    focal_len:null,
    latitude:MISB.SensorLatitude,
    longitude:MISB.SensorLongitude,
    rel_alt:MISB.SensorRelativeAltitude,
    abs_alt:MISB.SensorTrueAltitude,
    ct:null,
    date: null,
    heading: MISB.PlatformHeadingAngle,
    pitch: MISB.PlatformPitchAngle,
    roll: MISB.PlatformRollAngle,
    gHeading: MISB.SensorRelativeAzimuthAngle,
    gPitch: MISB.SensorRelativeElevationAngle,
    gRoll: MISB.SensorRelativeRollAngle,
}

// Every field SRTMapMISB maps is a NUMERIC MISB tag (position, altitude,
// platform attitude, gimbal angles), but the SRT text arrives as strings and
// used to be stored as strings. Arithmetic coerces them, so the track drew
// correctly and the anomaly stayed invisible — but every other parser in the
// codebase writes numbers, and a consumer doing the type check those parsers
// have earned (Number.isFinite, as BotBenchIngest does) saw a whole file of
// unusable rows. Store what the tag says it is.
function srtNumber(value) {
    const n = Number(String(value).trim());
    return Number.isFinite(n) ? n : null;
}

function parseSRT(data) {
    const lines = data.split('\n');
    if (lines[4] === "2" && lines [8] === "3") {
        return parseSRT2(lines)
    }
    return parseSRT1(lines)
}

function parseSRT2(lines) {
    console.warn("parseSRT2 is not yet implemented - falling back to parseSRT1");
    return parseSRT1(lines);
}

function parseSRT1(lines) {
    const numPoints = Math.floor(lines.length / 6);
    let MISBArray = new Array(numPoints);

    for (let i = 0; i < lines.length; i++) {
        // Strip HTML tags using a character-level scan (avoids regex-based HTML sanitization)
        let result = '';
        let inTag = false;
        for (let j = 0; j < lines[i].length; j++) {
            if (lines[i][j] === '<') inTag = true;
            else if (lines[i][j] === '>') inTag = false;
            else if (!inTag) result += lines[i][j];
        }
        lines[i] = result;
    }

    for (let i = 0; i < numPoints; i++) {
        let dataIndex = i * 6;
        let frameInfo = lines[dataIndex + 2].split(', ');
        let detailInfo = lines[dataIndex + 4].match(/\[(.*?)\]/g);

        MISBArray[i] = new Array(MISBFields).fill(null);

        frameInfo.forEach(info => {
            let [key, value] = info.split(': ');
            if (SRT.hasOwnProperty(key)) {
                if(SRTMapMISB[key] !== null) {
                    MISBArray[i][SRTMapMISB[key]] = srtNumber(value.replace('ms', ''));
                }
            }
        });

        detailInfo.forEach(info => {
            let details = info.replace(/[\[\]]/g, '');
            let tokens = details.split(' ');
            for (let j = 0; j < tokens.length; j += 2) {
                let key = tokens[j].replace(':', '');
                let value = tokens[j + 1].trim();

                if (SRT.hasOwnProperty(key)) {
                    if(SRTMapMISB[key] !== null) {
                        MISBArray[i][SRTMapMISB[key]] = srtNumber(value);
                    }

                    if (key === 'focal_len') {
                        let focal_len = parseFloat(value);

                        let referenceFocalLength = 166;
                        let referenceFOV = 5;

                        const sensorSize = 2 * referenceFocalLength * tan(radians(referenceFOV) / 2)
                        const vFOV = degrees(2 * atan(sensorSize / 2 / focal_len))

                        MISBArray[i][MISB.SensorVerticalFieldofView] = vFOV;
                    }
                }
            }
        });

        const date = timeStrToEpoch(lines[dataIndex + 3].trim());
        const dateMS = new Date(date).getTime();
        MISBArray[i][MISB.UnixTimeStamp] = dateMS;
    }

    return MISBArray;
}

export class CTrackFileSRT extends CTrackFile {
    static canHandle(filename, data) {
        if (!data || typeof data !== 'string') {
            return false;
        }
        try {
            const misb = parseSRT(data);
            return misb && misb.length > 0;
        } catch (e) {
            return false;
        }
    }

    doesContainTrack() {
        if (!this.data || typeof this.data !== 'string') {
            return false;
        }
        
        try {
            const misb = parseSRT(this.data);
            return misb && misb.length > 0;
        } catch (e) {
            return false;
        }
    }

    toMISB(trackIndex = 0) {
        if (trackIndex !== 0) {
            console.warn("SRTToMISB: SRT files only contain a single track, index" + trackIndex + " is invalid");
            return false;
        }

        if (!this.data || typeof this.data !== 'string') {
            console.warn("SRTToMISB: No valid SRT data");
            return false;
        }

        try {
            const misb = parseSRT(this.data);
            if (!misb || misb.length === 0) {
                console.warn("SRTToMISB: Failed to parse SRT data");
                return false;
            }
            return misb;
        } catch (e) {
            console.warn("SRTToMISB: Error parsing SRT data: " + e.message);
            return false;
        }
    }

    getShortName(trackIndex = 0, trackFileName = "") {
        if (trackFileName) {
            // Strip the extension for consistency with other track types
            return trackFileName.replace(/\.[^/.]+$/, "");
        }
        return "SRT Track";
    }

    hasMoreTracks(trackIndex = 0) {
        return false;
    }

    getTrackCount() {
        return 1;
    }

    extractObjects() {
    }
}
