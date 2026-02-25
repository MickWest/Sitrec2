import {asin, degrees, metersPerSecondFromKnots, radians} from "../utils";
import {calcHorizonPoint, getLocalNorthVector, getLocalUpVector} from "../SphericalMath";
import {CNodeEmptyArray} from "./CNodeArray";
import {assert} from "../assert.js";
import {V3} from "../threeUtils";

/*
    Computes a per-frame turn rate that, when applied to the jet track,
    produces the desired angular speed of the cloud horizon (the red line).

    The internal jet simulation matches CNodeJetTrack exactly (same origin,
    heading, wind). Angular speed is measured using the same asin(perpStep/offset)
    formula as CNodeTraverseAngularSpeed, ensuring the round trip closes exactly.

    Uses multiple passes to converge: each pass simulates the jet trajectory with
    the current turn rates and measures what TAS would read back, then adjusts.

    Inputs:
        cloudAlt   = altitude of the cloud layer above the ground
        cloudSpeed = desired angular speed of the clouds (the red line)
        az         = azimuth track of the ATFLIR pod
        speed      = true airspeed of the jet
        wind       = wind node (same as CNodeJetTrack's wind, e.g. localWind)
        cloudWind  = cloud wind node (same as TAS's wind input)
        heading    = initial heading node (same as CNodeJetTrack's heading)
        origin     = jet origin node (same as CNodeJetTrack's origin)
 */
export class CNodeTurnRateFromClouds extends CNodeEmptyArray {
    constructor(v) {
        super(v);
        this.startTurnRate = v.startTurnRate ?? 0
        this.checkInputs(["cloudAlt", "cloudSpeed", "az", "speed", "wind", "cloudWind", "heading", "origin"])
        this.frames = this.in.az.frames
        this.fps = this.in.az.fps
        assert(this.frames > 0, "Need frames in az input to CNodeTurnRateFromClouds")
        this.recalculate()
    }

    // Run one pass of the simulation: given a turn rate array, simulate the jet
    // trajectory and measure what TAS would read back. Returns a new turn rate array.
    simulatePass(turnRates) {
        const newTurnRates = []

        const jetPos = this.in.origin.p(0)
        const jetFwd = getLocalNorthVector(jetPos)
        const jetUp = getLocalUpVector(jetPos)

        const headingNode = this.in.heading.getRoot()
        let jetHeading
        if (headingNode.getHeading !== undefined) {
            jetHeading = headingNode.getHeading(0)
        } else {
            jetHeading = headingNode.getValueFrame(0)
        }
        jetFwd.applyAxisAngle(jetUp, radians(-jetHeading))

        for (var f = 0; f < this.frames - 1; f++) {
            const lastPosition = jetPos.clone()
            const lastFwd = jetFwd.clone()
            const turnRate = turnRates[f]

            // Move jet forward (same as CNodeJetTrack)
            const jetSpeed = metersPerSecondFromKnots(this.in.speed.getValueFrame(f))
            jetPos.add(jetFwd.clone().multiplyScalar(jetSpeed / this.fps))

            // Add wind (same as CNodeJetTrack)
            this.in.wind.setPosition(jetPos)
            jetPos.add(this.in.wind.v(f))

            // Rotate heading around local up
            var upAxis = getLocalUpVector(jetPos)
            jetFwd.applyAxisAngle(upAxis, -radians(turnRate / this.fps))
            var rightAxis = V3()
            rightAxis.crossVectors(upAxis, jetFwd)
            jetFwd.crossVectors(rightAxis, upAxis)

            const cloudAlt = this.in.cloudAlt.v(f)

            // Compute LOS at frame f and f+1
            const upLast = getLocalUpVector(lastPosition)
            let LOS_f = lastFwd.clone()
            LOS_f.applyAxisAngle(upLast, radians(-this.in.az.v(f)))

            let LOS_f1 = jetFwd.clone()
            LOS_f1.applyAxisAngle(upAxis, radians(-this.in.az.v(f + 1)))

            // Compute horizon points
            let horizon_f = calcHorizonPoint(lastPosition, LOS_f, cloudAlt)
            let horizon_f1 = calcHorizonPoint(jetPos, LOS_f1, cloudAlt)

            // Measure angular speed (same as TAS)
            let offset = horizon_f1.clone().sub(jetPos)
            offset.sub(upAxis.clone().multiplyScalar(offset.dot(upAxis)))

            // TAS computes: step = horizon(f) - (horizon(f-1) + cloudWind)
            // So we add cloudWind to horizon_f before subtracting, matching TAS exactly
            const cloudWindVec = this.in.cloudWind.v(f + 1)
            let step = horizon_f1.clone().sub(horizon_f.clone().add(cloudWindVec))
            step.sub(upAxis.clone().multiplyScalar(step.dot(upAxis)))

            const viewNormal = offset.clone().normalize()
            const perpStep = step.clone().sub(viewNormal.clone().multiplyScalar(viewNormal.dot(step)))

            let measuredSpeed = -degrees(asin(perpStep.length() / offset.length())) * this.fps

            const crossSign = offset.clone().cross(perpStep).dot(upAxis)
            if (crossSign <= 0) {
                measuredSpeed = -measuredSpeed
            }

            // Error: how far off is the measured speed from the desired cloudSpeed?
            const error = measuredSpeed - this.in.cloudSpeed.v(f)
            // Adjust turn rate to reduce the error
            newTurnRates.push(turnRate - error)
        }
        // Duplicate final
        newTurnRates.push(newTurnRates[newTurnRates.length - 1])

        return newTurnRates
    }

    recalculate() {
        // Initialize with a constant turn rate (the desired cloud speed is a good starting guess)
        let turnRates = new Array(this.frames).fill(this.startTurnRate)

        // Multiple passes to converge
        for (let pass = 0; pass < 10; pass++) {
            turnRates = this.simulatePass(turnRates)
        }

        this.array = turnRates
    }

}
