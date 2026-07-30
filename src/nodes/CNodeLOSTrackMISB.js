// For this we will need the Platform position and orientation, and the sensor orientation
// we return a track that has position (of the platform) and the absolute heading of the sensor
// Similar to CNodeLOSTrackAzEl (which only used Az and El
//
// the camera track (position) will be passed in, but comes from
//     SensorLatitude: 13,
//     SensorLongitude: 14,
//     SensorTrueAltitude: 15,
//
// the platform orientation is from:
//     PlatformHeadingAngle: 5,
//     PlatformPitchAngle: 6,
//     PlatformRollAngle: 7,
//
// the sensor (gimballed camera) orientation relative to the platfrom is:
//     SensorRelativeAzimuthAngle: 18,
//     SensorRelativeElevationAngle: 19,
//     SensorRelativeRollAngle: 20,
//
// A CNodeLOSTrackMISB will return per-frame data like:
// {position: Vector3, heading: Vector3, matrix: Matrix4}
// where the matrix is the orientation of the sensor
// and position heading are the usual LOS values
import {Vector3} from "three";
import {misbSensorMatrix} from "../MISBSightline";
import {CNodeLOS} from "./CNodeLOS";

export class CNodeLOSTrackMISB extends CNodeLOS {

    constructor(v) {
        super(v);
        this.input("cameraTrack")
        this.input("platformHeading")
        this.input("platformPitch")
        this.input("platformRoll")
        this.input("sensorAz")
        this.input("sensorEl")
        this.input("sensorRoll")
        this.recalculate();
    }

    recalculate() {
        this.array = []
        this.frames = this.in.cameraTrack.frames
        for (var f = 0; f < this.frames; f++) {
            var A = this.in.cameraTrack.p(f)

            // The rotation order lives in MISBSightline.js so that a caller with
            // MISB rows and no node graph (the BotBench bulk runner) builds the
            // identical sightline instead of a second, drifting copy of it.
            const sensorMatrix = misbSensorMatrix(A, {
                platformHeading: this.in.platformHeading.v(f),
                platformPitch: this.in.platformPitch.v(f),
                platformRoll: this.in.platformRoll.v(f),
                sensorAz: this.in.sensorAz.v(f),
                sensorEl: this.in.sensorEl.v(f),
                sensorRoll: this.in.sensorRoll.v(f),
            });

            // the heading of the sensor is the forward vector of the sensor matrix
            var heading = new Vector3().setFromMatrixColumn(sensorMatrix, 2);
            heading.normalize(); // should be normalized, but just tighten it up.

            // we might need to calculate the roll angle here
            //
            this.array.push({position: A, heading: heading, matrix: sensorMatrix.clone()})


        }
    }

    update(f) {
        if (f >= 0 && f < this.frames) {
            const v = this.array[f]

            // DebugAxes("MISB Axes", v.position, 1000)
            // DebugMatrixAxes("MISB Axes", v.position, v.matrix, 1000)
        }
    }


}