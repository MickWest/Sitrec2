import {CTrackFile} from "./TrackFiles/CTrackFile";
import {CTrackFileKML} from "./TrackFiles/CTrackFileKML";
import {CTrackFileSTANAG} from "./TrackFiles/CTrackFileSTANAG";
import {CTrackFileSRT, SRT} from "./TrackFiles/CTrackFileSRT";
import {CTrackFileJSON} from "./TrackFiles/CTrackFileJSON";
import {CTrackFileMISB} from "./TrackFiles/CTrackFileMISB";
import {CTrackFileSonde} from "./TrackFiles/CTrackFileSonde";
import {CTrackFileADSBTrace} from "./TrackFiles/CTrackFileADSBTrace";
import {parseXml} from "./parseXml";

export {CTrackFile, CTrackFileKML, CTrackFileSTANAG, CTrackFileSRT, CTrackFileJSON, CTrackFileMISB, CTrackFileSonde, CTrackFileADSBTrace, SRT, parseXml};

export function parseSRT(data) {
    const srtFile = new CTrackFileSRT(data);
    return srtFile.toMISB();
}

export function doesKMLContainTrack(kml) {
    let trackFile;
    if (kml instanceof CTrackFileKML) {
        trackFile = kml;
    } else {
        trackFile = new CTrackFileKML(kml);
    }
    return trackFile.doesContainTrack();
}

/*
time(millisecond)
datetime(utc)
latitude
longitude
height_above_takeoff(feet)
height_above_ground_at_drone_location(feet)
ground_elevation_at_drone_location(feet)
altitude_above_seaLevel(feet)
height_sonar(feet)
speed(mph)
distance(feet)
mileage(feet)
satellites
gpslevel
voltage(v)
max_altitude(feet)
max_ascent(feet)
max_speed(mph)
max_distance(feet)
xSpeed(mph)
ySpeed(mph)
zSpeed(mph)
compass_heading(degrees)
pitch(degrees)
roll(degrees)
isPhoto
isVideo
rc_elevator
rc_aileron
rc_throttle
rc_rudder
rc_elevator(percent)
rc_aileron(percent)
rc_throttle(percent)
rc_rudder(percent)
gimbal_heading(degrees)
gimbal_pitch(degrees)
gimbal_roll(degrees)
battery_percent
voltageCell1
voltageCell2
voltageCell3
voltageCell4
voltageCell5
voltageCell6
current(A)
battery_temperature(f)
altitude(feet)
ascent(feet)
flycStateRaw
flycState
message
*/


export function KMLToMISB(kml, trackIndex = 0) {
    let trackFile;
    if (kml instanceof CTrackFileKML) {
        trackFile = kml;
    } else {
        trackFile = new CTrackFileKML(kml);
    }
    return trackFile.toMISB(trackIndex);
}

///////////////////////////////////////////////////
// XML like STANAG

export function doesSTANAGContainTrack(xml) {
    let trackFile;
    if (xml instanceof CTrackFileSTANAG) {
        trackFile = xml;
    } else {
        trackFile = new CTrackFileSTANAG(xml);
    }
    return trackFile.doesContainTrack();
}

export function STANAGToMISB(xml, trackIndex = 0) {
    let trackFile;
    if (xml instanceof CTrackFileSTANAG) {
        trackFile = xml;
    } else {
        trackFile = new CTrackFileSTANAG(xml);
    }
    return trackFile.toMISB(trackIndex);
}

export const doesXMLContainTrack = doesSTANAGContainTrack;
export const XMLToMISB = STANAGToMISB;
