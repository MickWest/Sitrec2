// MISB field definitions - constants only, no dependencies
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

export const MISB = {
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
    PlatformCallSign: 59,
    TrackID: 59,
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
    SARMotionImageryMetadata: 95,
    TargetWidthExtended: 96,
    Geo_RegistrationLocalSet: 98,
    SensorEllipsoidHeightExtended: 104,
    AltitudeAGL: 113,
    ControlCommandVerificationList: 116,
    SensorAzimuthRate: 117,
    SensorElevationRate: 118,
    SensorRollRate: 119,
    On_boardMIStoragePercentFull: 120,
    SensorRelativeAltitude: 121,

    // Local extensions (not MISB 0601 tags): client-specific ground-truth
    // position/motion columns (truth_lat, truth_long, truth_alt, truth_heading,
    // truth_speed) found in some MISB-style CSV exports. Used by CTrackFileMISB
    // to build a derived "Truth" track, like the FrameCenter track.
    TruthLatitude: 122,
    TruthLongitude: 123,
    TruthAltitude: 124,     // meters
    TruthHeading: 125,      // parsed but currently unused
    TruthSpeed: 126,        // parsed but currently unused
}

export const MISBFields = 127;
