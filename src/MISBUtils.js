// Re-export MISB and MISBFields from the dependency-free MISBFields.js
// The constants are now in MISBFields.js for cleaner imports in tests
export {MISB, MISBFields} from "./MISBFields";
import {MISB, MISBFields} from "./MISBFields";
import * as st0601 from './js/misb.js-main/src/st0601.mjs'
import * as st0903 from './js/misb.js-main/src/st0903.mjs'
import * as st0104 from './js/misb.js-main/src/st0104.mjs'
import * as st0806 from './js/misb.js-main/src/st0806.mjs'
import * as klv from './js/misb.js-main/src/klv.mjs'
import {showError} from "./showError";

// this MISB object is for the internal representation of the MISB data
// i.e. it's the index of the data within
// these are standard MISB 0601 tags (keys) and values as listed in
// https://upload.wikimedia.org/wikipedia/commons/1/19/MISB_Standard_0601.pdf
// with the following exceptions:
// any dash in the name is replaced with an underscore
// any spaces or parentheses ' ', '(' and ')' in the name are removed
// These are mostly just numbers, but some are strings, and some are arrays of numbers
//
// For local extensions, other values can be added (perhaps computed values)
// e.g. SensorRelativeAltitude = is the altitude above start point of the track
// and is a value supplied by DJI Metadata.

// MISB constant is now imported from MISBFields.js
const MISB_LEGACY = {
    Checksum: 1,
    UnixTimeStamp: 2,
    MissionID: 3,
    PlatformTailNumber: 4,
    PlatformHeadingAngle: 5,
    PlatformPitchAngle: 6,
    PlatformRollAngle: 7,
    PlatformTrueAirspeed: 8,
    PlatformIndicatedAirspeed: 9,
    PlatformDesignation: 10,
    ImageSourceSensor: 11,
    ImageCoordinateSystem: 12,
    SensorLatitude: 13,
    SensorLongitude: 14,
    SensorTrueAltitude: 15,
    SensorHorizontalFieldofView: 16,
    SensorVerticalFieldofView: 17,
    SensorRelativeAzimuthAngle: 18,
    SensorRelativeElevationAngle: 19,
    SensorRelativeRollAngle: 20,
    SlantRange: 21,
    TargetWidth: 22,
    FrameCenterLatitude: 23,
    FrameCenterLongitude: 24,
    FrameCenterElevation: 25,
    OffsetCornerLatitudePoint1: 26,
    OffsetCornerLongitudePoint1: 27,
    OffsetCornerLatitudePoint2: 28,
    OffsetCornerLongitudePoint2: 29,
    OffsetCornerLatitudePoint3: 30,
    OffsetCornerLongitudePoint3: 31,
    OffsetCornerLatitudePoint4: 32,
    OffsetCornerLongitudePoint4: 33,
    IcingDetected: 34,
    WindDirection: 35,
    WindSpeed: 36,
    StaticPressure: 37,
    DensityAltitude: 38,
    OutsideAirTemperature: 39,
    TargetLocationLatitude: 40,
    TargetLocationLongitude: 41,
    TargetLocationElevation: 42,
    TargetTrackGateWidth: 43,
    TargetTrackGateHeight: 44,
    TargetErrorEstimate_CE90: 45,
    TargetErrorEstimate_LE90: 46,
    GenericFlagData: 47,
    SecurityLocalSet: 48,
    PlatformAngleofAttack: 50,
    PlatformVerticalSpeed: 51,
    PlatformSideslipAngle: 52,
    RelativeHumidity: 55,
    PlatformGroundSpeed: 56,
    GroundRange: 57,
    PlatformFuelRemaining: 58,
    PlatformCallSign: 59,   // Mick: We reuse this for TrackID
    TrackID: 59,            // Mick: same as PlatformCallSign
    LaserPRFCode: 62,
    SensorFieldofViewName: 63,
    PlatformMagneticHeading: 64,
    UASDatalinkLSVersionNumber: 65,
    AlternatePlatformLatitude: 67,
    AlternatePlatformLongitude: 68,
    AlternatePlatformName: 70,
    AlternatePlatformHeading: 71,
    EventStartTime: 72,
    RVTLocalSet: 73,
    VMTILocalSet: 74,
    SensorEllipsoidHeight: 75,
    AlternatePlatformEllipsoidHeight: 76,
    OperationalMode: 77,
    FrameCenterHeightAboveEllipsoid: 78,
    SensorNorthVelocity: 79,
    SensorEastVelocity: 80,
    ImageHorizonPixelPack: 81,
    CornerLatitudePoint1: 82,
    CornerLongitudePoint1: 83,
    CornerLongitudePoint2: 85,
    CornerLatitudePoint2: 84,
    CornerLatitudePoint3: 86,
    CornerLongitudePoint3: 87,
    CornerLatitudePoint4: 88,
    CornerLongitudePoint4: 89,
    PlatformPitchAngleFull: 90,
    PlatformRollAngleFull: 91,
    PlatformAngleofAttackFull: 92,
    PlatformSideslipAngleFull: 93,
    MIISCoreIdentifier: 94,
    SARMotionImageryMetadata: 95,   // Mick: added this
    TargetWidthExtended: 96,        // Mick: this is the last one listed in the MISB 0601.8 spec

    Geo_RegistrationLocalSet: 98,
    SensorEllipsoidHeightExtended: 104,
    AltitudeAGL: 113,
    ControlCommandVerificationList: 116,
    SensorAzimuthRate: 117,
    SensorElevationRate: 118,
    SensorRollRate: 119,
    On_boardMIStoragePercentFull: 120,

    SensorRelativeAltitude: 121,
}

// array of the full names and expected data types

const misbTagInfo = [
    {}, // Tag 0
    { name: "Checksum", units: "None", isNumber: true },  // Tag 1
    { name: "UNIX Time Stamp", units: "Microseconds", isNumber: true },  // Tag 2
    { name: "Mission ID", units: "String", isNumber: false },  // Tag 3
    { name: "Platform Tail Number", units: "String", isNumber: false },  // Tag 4
    { name: "Platform Heading Angle", units: "Degrees", isNumber: true },  // Tag 5
    { name: "Platform Pitch Angle", units: "Degrees", isNumber: true },  // Tag 6
    { name: "Platform Roll Angle", units: "Degrees", isNumber: true },  // Tag 7
    { name: "Platform True Airspeed", units: "Meters/Second", isNumber: true },  // Tag 8
    { name: "Platform Indicated Airspeed", units: "Meters/Second", isNumber: true },  // Tag 9
    { name: "Platform Designation", units: "String", isNumber: false },  // Tag 10
    { name: "Image Source Sensor", units: "String", isNumber: false },  // Tag 11
    { name: "Image Coordinate System", units: "String", isNumber: false },  // Tag 12
    { name: "Sensor Latitude", units: "Degrees", isNumber: true },  // Tag 13
    { name: "Sensor Longitude", units: "Degrees", isNumber: true },  // Tag 14
    { name: "Sensor True Altitude", units: "Meters", isNumber: true },  // Tag 15
    { name: "Sensor Horizontal Field of View", units: "Degrees", isNumber: true },  // Tag 16
    { name: "Sensor Vertical Field of View", units: "Degrees", isNumber: true },  // Tag 17
    { name: "Sensor Relative Azimuth Angle", units: "Degrees", isNumber: true },  // Tag 18
    { name: "Sensor Relative Elevation Angle", units: "Degrees", isNumber: true },  // Tag 19
    { name: "Sensor Relative Roll Angle", units: "Degrees", isNumber: true },  // Tag 20
    { name: "Slant Range", units: "Meters", isNumber: true },  // Tag 21
    { name: "Target Width", units: "Meters", isNumber: true },  // Tag 22
    { name: "Frame Center Latitude", units: "Degrees", isNumber: true },  // Tag 23
    { name: "Frame Center Longitude", units: "Degrees", isNumber: true },  // Tag 24
    { name: "Frame Center Elevation", units: "Meters", isNumber: true },  // Tag 25
    { name: "Offset Corner Latitude Point 1", units: "Degrees", isNumber: true },  // Tag 26
    { name: "Offset Corner Longitude Point 1", units: "Degrees", isNumber: true },  // Tag 27
    { name: "Offset Corner Latitude Point 2", units: "Degrees", isNumber: true },  // Tag 28
    { name: "Offset Corner Longitude Point 2", units: "Degrees", isNumber: true },  // Tag 29
    { name: "Offset Corner Latitude Point 3", units: "Degrees", isNumber: true },  // Tag 30
    { name: "Offset Corner Longitude Point 3", units: "Degrees", isNumber: true },  // Tag 31
    { name: "Offset Corner Latitude Point 4", units: "Degrees", isNumber: true },  // Tag 32
    { name: "Offset Corner Longitude Point 4", units: "Degrees", isNumber: true },  // Tag 33
    { name: "Icing Detected", units: "None", isNumber: false },  // Tag 34
    { name: "Wind Direction", units: "Degrees", isNumber: true },  // Tag 35
    { name: "Wind Speed", units: "Meters/Second", isNumber: true },  // Tag 36
    { name: "Static Pressure", units: "Millibars", isNumber: true },  // Tag 37
    { name: "Density Altitude", units: "Meters", isNumber: true },  // Tag 38
    { name: "Outside Air Temperature", units: "Celsius", isNumber: true },  // Tag 39
    { name: "Target Location Latitude", units: "Degrees", isNumber: true },  // Tag 40
    { name: "Target Location Longitude", units: "Degrees", isNumber: true },  // Tag 41
    { name: "Target Location Elevation", units: "Meters", isNumber: true },  // Tag 42
    { name: "Target Track Gate Width", units: "Pixels", isNumber: true },  // Tag 43
    { name: "Target Track Gate Height", units: "Pixels", isNumber: true },  // Tag 44
    { name: "Target Error Estimate - CE90", units: "Meters", isNumber: true },  // Tag 45
    { name: "Target Error Estimate - LE90", units: "Meters", isNumber: true },  // Tag 46
    { name: "Generic Flag Data 01", units: "None", isNumber: true },  // Tag 47
    { name: "Security Local Set", units: "None", isNumber: false },  // Tag 48
    { name: "Differential Pressure", units: "Millibars", isNumber: true },  // Tag 49
    { name: "Platform Angle of Attack", units: "Degrees", isNumber: true },  // Tag 50
    { name: "Platform Vertical Speed", units: "Meters/Second", isNumber: true },  // Tag 51
    { name: "Platform Side Slip Angle", units: "Degrees", isNumber: true },  // Tag 52
    { name: "Airfield Barometric Pressure", units: "Millibars", isNumber: true },  // Tag 53
    { name: "Airfield Elevation", units: "Meters", isNumber: true },  // Tag 54
    { name: "Relative Humidity", units: "Percent", isNumber: true },  // Tag 55
    { name: "Platform Ground Speed", units: "Meters/Second", isNumber: true },  // Tag 56
    { name: "Ground Range", units: "Meters", isNumber: true },  // Tag 57
    { name: "Platform Fuel Remaining", units: "Kilograms", isNumber: true },  // Tag 58
    { name: "Platform Call Sign", units: "None", isNumber: false },  // Tag 59
    { name: "Weapon Load", units: "None", isNumber: false },  // Tag 60
    { name: "Weapon Fired", units: "None", isNumber: false },  // Tag 61
    { name: "Laser PRF Code", units: "None", isNumber: false },  // Tag 62
    { name: "Sensor Field of View Name", units: "None", isNumber: false },  // Tag 63
    { name: "Platform Magnetic Heading", units: "Degrees", isNumber: true },  // Tag 64
    { name: "UAS LDS Status", units: "None", isNumber: false },  // Tag 65
    { name: "Sensor Ellipsoid Height", units: "Meters", isNumber: true },  // Tag 66
    { name: "Alternate Platform Latitude", units: "Degrees", isNumber: true },  // Tag 67
    { name: "Alternate Platform Longitude", units: "Degrees", isNumber: true },  // Tag 68
    { name: "Alternate Platform Altitude", units: "Meters", isNumber: true },  // Tag 69
    { name: "Alternate Platform Name", units: "String", isNumber: false },  // Tag 70
    { name: "Alternate Platform Heading", units: "Degrees", isNumber: true },  // Tag 71
    { name: "Event Start Time - UTC", units: "Microseconds", isNumber: true },  // Tag 72
    { name: "RVT Local Set", units: "None", isNumber: false },  // Tag 73
    { name: "VMTI Data Set", units: "None", isNumber: false },  // Tag 74
    { name: "Sensor Ellipsoid Height", units: "Meters", isNumber: true },  // Tag 75
    { name: "Alternate Platform Ellipsoid Height", units: "Meters", isNumber: true },  // Tag 76
    { name: "Operational Mode", units: "None", isNumber: false },  // Tag 77
    { name: "Frame Center Height Above Ellipsoid", units: "Meters", isNumber: true },  // Tag 78
    { name: "Sensor North Velocity", units: "Meters/Second", isNumber: true },  // Tag 79
    { name: "Sensor East Velocity", units: "Meters/Second", isNumber: true },  // Tag 80
    { name: "Image Horizon Pixel Pack", units: "Pack", isNumber: false },  // Tag 81
    { name: "Corner Latitude Point 1 (Full)", units: "Degrees", isNumber: true },  // Tag 82
    { name: "Corner Longitude Point 1 (Full)", units: "Degrees", isNumber: true },  // Tag 83
    { name: "Corner Latitude Point 2 (Full)", units: "Degrees", isNumber: true },  // Tag 84
    { name: "Corner Longitude Point 2 (Full)", units: "Degrees", isNumber: true },  // Tag 85
    { name: "Corner Latitude Point 3 (Full)", units: "Degrees", isNumber: true },  // Tag 86
    { name: "Corner Longitude Point 3 (Full)", units: "Degrees", isNumber: true },  // Tag 87
    { name: "Corner Latitude Point 4 (Full)", units: "Degrees", isNumber: true },  // Tag 88
    { name: "Corner Longitude Point 4 (Full)", units: "Degrees", isNumber: true },  // Tag 89
    { name: "Platform Pitch Angle (Full)", units: "Degrees", isNumber: true },  // Tag 90
    { name: "Platform Roll Angle (Full)", units: "Degrees", isNumber: true },  // Tag 91
    { name: "Platform Angle of Attack (Full)", units: "Degrees", isNumber: true },  // Tag 92
    { name: "Platform Slipslide Angle Attack (Full)", units: "Degrees", isNumber: true },  // Tag 93

    { name: "MIIS Core Identifieer", units: "String", isNumber: false },  // Tag 94
    { name: "SARMotionImageryMetadata", units: "String", isNumber: false },  // Tag 95
    { name: "TargetWidthExtended", units: "String", isNumber: false },  // Tag 96
    {}, // 97
    { name: "Geo_RegistrationLocalSet", units: "String", isNumber: false },  // Tag 98
    {}, // 99
    {}, // 100
    {}, // 101
    {}, // 102
    {}, // 103

    { name: "SensorEllipsoidHeightExtended", units: "Pixels", isNumber: true },  // Tag 104
    {}, // 105
    {}, // 106
    {}, // 107
    {}, // 108
    {}, // 109
    {}, // 110
    {}, // 111
    {}, // 112
    { name: "Altitude AGL", units: "Meters", isNumber: true },  // Tag 113
    {}, // 114
    {}, // 115
    { name: "ControlCommandVerificationList", units: "String", isNumber: false },  // Tag 116
    { name: "SensorAzimuthRate", units: "Degrees", isNumber: true },  // Tag 117
    { name: "SensorElevationRate", units: "Degrees", isNumber: true },  // Tag 118
    { name: "SensorRollRate", units: "Degrees", isNumber: true },  // Tag 119
    { name: "On_boardMIStoragePercentFull", units: "Number", isNumber: true },  // Tag 120
    { name: "SensorRelativeAltitude", units: "Meters", isNumber: true },  // Tag 121
];


// test that is correct by iterating over the MISB keys, then logging the key and the info name

// for (const key in MISB) {
//     console.log(key, misbTagInfo[MISB[key]].name);
// }
// debugger;



// Some additional fields are listed here:
// https://impleotv.com/content/misbcore/help//user-guide/st601-supported.html

// MISBFields is now imported and re-exported from MISBFields.js

// all the MISB identifiers above are the MISB 0601.8 tag's LS Names with spaces removed
// so to parse a generic CSV file, we first assume the header row is the LS Names
// we remove the spaces, and then compare to the MISB identifiers above
// so it will work with or without spaces in the header row
// we also do the comparison case-insensitive as the LS Names are generally capitalized
// but some words, like "of" are not, and there might be use confusion
// all LS Names are unique regardless of case

// Walk a MISB array and compute the UnixTimeStamp + pesPTSus spans
// over the same index range (first/last records where both are
// populated, when pesPTSus exists at all). Returns spans in seconds.
// Used by the timing-analysis report and the fps-mismatch dialog —
// the apples-to-apples spans are essential for measuring the encoder
// PCR-vs-real-clock rate ratio without mixing different time ranges.
//
// Returns: { utsSpanS, pesSpanS } | null
//   utsSpanS: real-time wall-clock span (always present if valid)
//   pesSpanS: encoder PCR-clock span over the SAME records (null if
//             the misb has no pesPTSus array — async-mode KLV)
//   null:    fewer than 2 records have a populated UTS
export function computeMisbSpans(misb) {
    if (!misb || misb.length < 2) return null;
    const pesArr = misb.pesPTSus;
    const havePes = Array.isArray(pesArr);
    let firstUts = null, lastUts = null;
    let firstPes = null, lastPes = null;
    for (let i = 0; i < misb.length; i++) {
        const row = misb[i];
        if (!row) continue;
        const uts = row[2]; // MISB.UnixTimeStamp = 2 (µs since Unix epoch)
        const pes = havePes ? pesArr[i] : null;
        if (uts == null) continue;
        // For PES-vs-real ratio we need both populated; require both
        // here so first/last align on identical records.
        if (havePes && pes == null) continue;
        if (firstUts === null) { firstUts = uts; firstPes = pes; }
        lastUts = uts;
        lastPes = pes;
    }
    if (firstUts === null || lastUts === null || lastUts <= firstUts) return null;
    return {
        utsSpanS: (lastUts - firstUts) / 1e6,
        pesSpanS: (havePes && firstPes != null && lastPes != null && lastPes > firstPes)
            ? (lastPes - firstPes) / 1e6 : null,
    };
}

// Encoder PTS-cadence-mismatch analysis. Compares the labeled video
// frame rate (frames per encoder PCR-second) with the real-world rate
// (frames per real-second) using the encoder's PCR-vs-real-clock ratio
// measured from the KLV stream. Catches the "ffmpeg -r N without an
// fps filter" footgun (and similar tactical-encoder misconfigurations)
// where PES PTS values are written at one cadence while frames are
// captured at another — the platform track ends partway through the
// video timeline because Sit.fps is left at the labeled rate.
//
// The math: real_fps = pcr_fps × (klvPesSpan / klvUtsSpan). The naive
// formula `videoFrameCount / klvUtsSpan` mixes time ranges (KLV often
// pre-rolls a few seconds before first decoded video frame) and gives
// wrong fps for normally-synchronised files.
//
// Caller provides the four measurements; we return all derived
// quantities so callers can format / threshold as needed.
//
// Args:
//   videoFrameCount  — total decoded video frames
//   videoPesSpanS    — span of video PES PTS values, in seconds
//   klvUtsSpanS      — span of KLV UnixTimeStamp values, in seconds
//   klvPesSpanS      — span of KLV pesPTSus over the same record range
//                      (null if KLV is async-mode without PES PTS)
//   currentSitFps    — optional, for reporting "current vs real" delta
//
// Returns: { valid, pcrFps, realFps, ratePesOverReal, fpsGap, sitFpsDelta }
//   valid:           false if inputs are missing/invalid
//   pcrFps:          frames per PCR-second (= the labeled fps)
//   realFps:         frames per real-second (= pcrFps × rate)
//   ratePesOverReal: klvPesSpan / klvUtsSpan (1.0 if no PES; ~1.0 normally)
//   fpsGap:          |realFps − pcrFps| / realFps
//   sitFpsDelta:     |realFps − currentSitFps| / realFps (NaN if no current)
export function computeFpsAnalysis({ videoFrameCount, videoPesSpanS, klvUtsSpanS, klvPesSpanS, currentSitFps } = {}) {
    if (!(videoFrameCount > 1) || !(videoPesSpanS > 0) || !(klvUtsSpanS > 0)) {
        return { valid: false };
    }
    const pcrFps = videoFrameCount / videoPesSpanS;
    // Without KLV PES PTS we can't measure the rate ratio independently,
    // so we have to assume PCR == real and accept that we can't *detect*
    // a PTS-cadence misconfiguration in async-mode KLV files.
    const ratePesOverReal = (klvPesSpanS > 0) ? (klvPesSpanS / klvUtsSpanS) : 1.0;
    const realFps = pcrFps * ratePesOverReal;
    const fpsGap = Math.abs(realFps - pcrFps) / Math.max(realFps, 1e-6);
    const sitFpsDelta = (currentSitFps > 0)
        ? Math.abs(realFps - currentSitFps) / Math.max(realFps, 1e-6)
        : NaN;
    return { valid: true, pcrFps, realFps, ratePesOverReal, fpsGap, sitFpsDelta };
}

export function parseMISB1CSV(csv) {
    const rows = csv.length;
    console.log("MISB CSV rows = "+rows);
    let MISBArray = new Array(rows - 1);

    // prefill the entire array with null
    for (let i = 1; i < rows; i++) {
        MISBArray[i - 1] = new Array(MISBFields).fill(null);
    }

    // for each column header, find the corresponding MISB field
    // then parse the values for the entire column and put them in the MISBArray
    // if the column header doesn't match a MISB field, ignore it
    for (let col = 0; col < csv[0].length; col++) {
        // remove spaces and make it lowercase
        const header = csv[0][col].replace(/\s/g, "").toLowerCase();

        // find the MISB field that matches the header
        // this will basically be the same thing, just ignoring case and spaces
        const field = Object.keys(MISB).find(key => key.toLowerCase() === header);


        if (field !== undefined) {
//            console.log("MISB Data "+csv[0][col] + " - row 1 = " + csv[1][col] + " - field = " + field + " - col = " + col);
//            console.log("MISB LAST ROW = " + csv[rows-1][col]);
            // got the MISB column, so just copy the values
            const isNumber = misbTagInfo[MISB[field]].isNumber;
            for (let row = 1; row < rows; row++) {
                // field is the name of the MISB field, and col is the column in the csv
                // we use MISB[field] to get the index in the MISBArray
                let value = csv[row][col];
                // handle missing values
                if (value === "null" || value === null || value === "" || value === "NaN") {
                    // convert or leave it as the null object, so all missing fields are consistent
                    value = null;
                } else {
                    // all csv values com in as string
                    // so we need to convert them to numbers, if a number is expected.
                    if (isNumber) {
                        value = Number(value);
                        if (isNaN(value)) {
                            value = null;
                        }
                    }
                }

                MISBArray[row - 1][MISB[field]] = value;
            }
        } else {

            if (header === "precisiontimestamp") {
                // Special handling for PrecisionTimeStamp, which is an alternate timestamp format
                // for example 25-Dec-2023 14:00:00.000

                for (let row = 1; row < rows; row++) {
                    let value = csv[row][col];
                    // We will convert to a Unix timestamp using the Date constructor
                    // need to add a Z to the end of the string to indicate UTC timezone
                    // unless there already is one
                    if (!value.endsWith("Z")) {
                        value += "Z";
                    }
                    const date = new Date(value);
                    // store as ms
                    MISBArray[row - 1][MISB.UnixTimeStamp] = date.getTime();
                    if (row < 10 ) {
                        console.log(`Converted PrecisionTimeStamp to UnixTimestamp: ${date.toISOString()}`);
                    }
                }

            } else {

                console.warn("UNHANDLED MISB DATA: " + csv[0][col]);
            }
        }
    }

    return MISBArray;
}


// import * as st0601 from './js/misb.js-main/src/st0601.mjs'
// const klvTest =[
//     '060E2B34 020B0101 0E0103010100000081D2020800046050584E0180030A4D697373696F6E20',
//     '3132050271C20602FD3D070208B80A085072656461746F720B07454F204E6F73650C0E47656F',
//     '64657469632057475338340D045595B66D0E045B5360C40F02C2211002CD9C1102D917120472',
//     '4A0A20130487F84B86140400000000150403830926160212811704F101A229180414BC082B19',
//     '0234F3301C01010102010703052F2F5553410C01070D060055005300411602000A4101065E22',
//     '0170F592F02373364AF8AA9162C00F2EB2DA16B74341000841A0BE365B5AB96A36450102AA43'
// ]
// const json = st0601.parse(klvTest.join(''), { debug: true })
// console.log(json)

//const { st0601, st0903, st0104, st0806, klv } = require('./js/misb.js-main/index.js')

const standards = [st0601, st0903, st0806, st0104]
const packets = {}
for(const standard of standards) {
    packets[standard.name] = []
}

// the code expects st0601 data packets to start with a key, which is
// 060e2b34020b01010e01030101000000
// this is then followed directly by the packet, like
// 060E2B34020B01010E01030101000000 8190020800046CAE71B92030410101
// instead, in the data extracted with ffmpeg, I get:
// ..........0B01010E01030101000000 8190020800
// i.e. the first five bytes of the key are missing
// so we have an 11 byte key????


export function parseKLVFile(data, pesEntries = null, videoFirstPESus = null) {
    console.log(`parseKLVFile: Received data type: ${data.constructor.name}, byteLength: ${data.byteLength}`);

    // Convert to Uint8Array for processing
    let uint8Data;
    if (data instanceof ArrayBuffer) {
        uint8Data = new Uint8Array(data);
        console.log(`parseKLVFile: Data is ArrayBuffer with ${data.byteLength} bytes`);
    } else if (data instanceof Uint8Array) {
        uint8Data = data;
        console.log(`parseKLVFile: Data is Uint8Array with ${data.length} bytes, buffer has ${data.buffer.byteLength} bytes`);
    } else {
        showError('parseKLVFile: Unsupported data type');
        return;
    }

    // Validate and extract complete KLV packets
    // KLV structure: Key (variable, often 16 bytes for universal keys) + Length (BER encoded) + Value
    const validPackets = [];
    // Per-record byte offset (start of the key) in the input substream.
    // Used to pair each KLV record to its source PES packet's PTS, when
    // pesEntries are provided by the TS demuxer.
    const validPacketOffsets = [];
    let offset = 0;
    let packetCount = 0;
    let skippedIncomplete = 0;
    
    while (offset < uint8Data.length) {
        // Look for potential KLV packet start
        // Check for local set key (3 bytes: 00 00 df) or universal key (16 bytes starting with 06 0e 2b 34)
        let keyLength = 0;
        let packetStart = offset;
        
        if (offset + 3 <= uint8Data.length && 
            uint8Data[offset] === 0x00 && 
            uint8Data[offset + 1] === 0x00 && 
            uint8Data[offset + 2] === 0xdf) {
            // Local set key (3 bytes)
            keyLength = 3;
        } else if (offset + 16 <= uint8Data.length && 
                   uint8Data[offset] === 0x06 && 
                   uint8Data[offset + 1] === 0x0e && 
                   uint8Data[offset + 2] === 0x2b && 
                   uint8Data[offset + 3] === 0x34) {
            // Universal key (16 bytes)
            keyLength = 16;
        } else {
            // Not a recognized KLV key, skip this byte
            offset++;
            continue;
        }
        
        // Parse BER length
        offset += keyLength;
        if (offset >= uint8Data.length) break;
        
        let length = 0;
        const firstLengthByte = uint8Data[offset];
        
        if ((firstLengthByte & 0x80) === 0) {
            // Short form: length is in the first byte (0-127)
            length = firstLengthByte;
            offset += 1;
        } else {
            // Long form: first byte indicates how many bytes encode the length
            const numLengthBytes = firstLengthByte & 0x7f;
            offset += 1;
            
            if (offset + numLengthBytes > uint8Data.length) {
                console.log(`parseKLVFile: Incomplete BER length at offset ${packetStart}, skipping`);
                skippedIncomplete++;
                break;
            }
            
            for (let i = 0; i < numLengthBytes; i++) {
                length = (length << 8) | uint8Data[offset + i];
            }
            offset += numLengthBytes;
        }
        
        // Check if we have the complete value
        const packetEnd = offset + length;
        if (packetEnd > uint8Data.length) {
            console.log(`parseKLVFile: Incomplete packet at offset ${packetStart}: expected ${length} bytes but only ${uint8Data.length - offset} available, skipping`);
            skippedIncomplete++;
            break;
        }
        
        // Extract complete packet (key + length + value)
        const completePacket = uint8Data.slice(packetStart, packetEnd);
        validPackets.push(completePacket);
        validPacketOffsets.push(packetStart);
        packetCount++;

        offset = packetEnd;
    }
    
    console.log(`parseKLVFile: Found ${packetCount} complete KLV packets, skipped ${skippedIncomplete} incomplete packets`);
    
    if (validPackets.length === 0) {
        showError('parseKLVFile: No valid KLV packets found');
        return;
    }
    
    // Concatenate all valid packets
    const totalLength = validPackets.reduce((sum, packet) => sum + packet.length, 0);
    const cleanedData = new Uint8Array(totalLength);
    let writeOffset = 0;
    for (const packet of validPackets) {
        cleanedData.set(packet, writeOffset);
        writeOffset += packet.length;
    }
    
    console.log(`parseKLVFile: Cleaned data size: ${cleanedData.length} bytes (was ${uint8Data.length} bytes)`);
    
    let result;
    try {
        result = klv.decode(cleanedData.buffer, st0601, null, {debug: false});
    } catch (error) {
        showError(error);
        return;
    }
    // for (const standard of standards) {
    //     for (const packet of result[standard.name]) {
    //         packets[standard.name].push(packet)
    //     }
    // }
    //
    // for (const standard of standards) {
    //     const name = standard.name
    //     console.log(`${name}: ${packets[name]?.length ?? 0}`)
    // }

    const data0601 = result[st0601.name];
    const n = data0601.length;
    const MISBArray = new Array(n);
    for (let i=0; i<n; i++) {
        MISBArray[i] = new Array(MISBFields).fill(null);
        for (const index of Object.keys(data0601[i])) {
            const line = data0601[i][index];
            MISBArray[i][line.key] = line.value;
        }
        const unixTime = MISBArray[i][MISB["UnixTimeStamp"]];
        // display as actual time:
        if (unixTime > 0) {
            const date = new Date(unixTime / 1000); // Convert microseconds to seconds
            const formattedDate = date.toLocaleString();
        }

    }

    // Pair each parsed record with its source PES packet's PTS, if the TS
    // demuxer supplied PES entries. We walk both sequences in order
    // (validPacketOffsets is monotonic by construction; pesEntries is
    // monotonic by accumulator) so the pairing is O(n+m).
    if (pesEntries && pesEntries.length > 0) {
        let pesPTSus = null;
        // If we know the video's first PES PTS on the same PCR clock,
        // shift KLV PTS values onto the same origin as the (downstream-
        // normalized-to-0) video framePTSus. Any genuine cross-stream
        // offset in the source TS becomes a constant offset in the KLV
        // array, which is the correct preservation of the encoder's
        // intent. If no video reference is available (KLV-only or non-TS
        // path), normalize KLV to its own first record — at-start
        // alignment without cross-stream calibration.
        const originUs = (videoFirstPESus !== null) ? videoFirstPESus : pesEntries[0].ptsUs;
        if (pesEntries.length === n) {
            // Common synchronous-mode case: one KLV PES per decoded record.
            // 1:1 pairing by index — robust to whatever internal packet
            // structure the byte scanner counted (wrapper + LS pairs, etc.).
            pesPTSus = pesEntries.map(e => e.ptsUs - originUs);
        } else if (validPacketOffsets.length === n) {
            // The byte scanner found exactly as many "valid packets" as the
            // decoder returned records — pair by byte offset within the
            // substream, walking both arrays in order.
            pesPTSus = new Array(n);
            let pesIdx = 0;
            for (let i = 0; i < n; i++) {
                const recordStart = validPacketOffsets[i];
                while (pesIdx < pesEntries.length - 1 &&
                       pesEntries[pesIdx + 1].offset <= recordStart) {
                    pesIdx++;
                }
                pesPTSus[i] = (pesEntries[pesIdx].offset <= recordStart)
                    ? pesEntries[pesIdx].ptsUs - originUs
                    : null;
            }
        } else {
            // Mismatch we can't reconcile cleanly — e.g., KLV decoder
            // returned fewer records than the byte scanner found packets,
            // and the count doesn't match the PES count either. Pair by
            // best-effort byte offset using the ratio of decoded-records
            // to scanner-packets, falling back to PES boundaries.
            console.warn(`parseKLVFile: pesEntries (${pesEntries.length}) doesn't match decoded records (${n}) ` +
                `and validPacketOffsets (${validPacketOffsets.length}) doesn't either. ` +
                `Attempting interpolated pairing.`);
            pesPTSus = new Array(n);
            // Map decoded record i to its proportional position in the
            // scanned-packets array, then look up by byte offset.
            const ratio = validPacketOffsets.length / n;
            let pesIdx = 0;
            for (let i = 0; i < n; i++) {
                const packetIdx = Math.floor(i * ratio);
                const recordStart = validPacketOffsets[Math.min(packetIdx, validPacketOffsets.length - 1)];
                while (pesIdx < pesEntries.length - 1 &&
                       pesEntries[pesIdx + 1].offset <= recordStart) {
                    pesIdx++;
                }
                pesPTSus[i] = (pesEntries[pesIdx].offset <= recordStart)
                    ? pesEntries[pesIdx].ptsUs - originUs
                    : null;
            }
        }
        if (pesPTSus) {
            MISBArray.pesPTSus = pesPTSus;
            const nonNull = pesPTSus.filter(v => v !== null).length;
            const firstPTS = pesPTSus.find(v => v !== null);
            const lastPTS = [...pesPTSus].reverse().find(v => v !== null);
            if (firstPTS !== undefined && lastPTS !== undefined) {
                console.log(`parseKLVFile: paired ${nonNull}/${n} records with PES PTS ` +
                    `(range ${(firstPTS/1e6).toFixed(3)}s – ${(lastPTS/1e6).toFixed(3)}s)`);
            }
        }
    }

    return MISBArray;

}




