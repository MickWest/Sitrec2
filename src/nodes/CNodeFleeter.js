import {metersFromNM, radians} from "../utils";
import {Sit, Units} from "../Globals";
import {CNodeEmptyArray} from "./CNodeArray";

import {V3} from "../threeUtils";
import {getLocalEastVector, getLocalNorthVector, getLocalUpVector} from "../SphericalMath";


export class CNodeFleeter extends CNodeEmptyArray {
    constructor(v) {
        super(v);
        this.input("gimbal") // the gimbal input node is the calculated traversal track
        this.input("turnFrame")
        this.input("turnRate")
        this.input("acc")
        this.input("spacing")
        this.input("fleetX")
        this.input("fleetY")

        this.offX = v.offX
        this.offY = v.offY
        this.offZ = v.offZ

        this.recalculate()

    }

    recalculate() {
        this.array = []
        this.frames = this.in.gimbal.frames
        // position is relative to gimbal at frame 0
        var pos = this.in.gimbal.v0.position.clone()

        // Get local tangent frame at the starting position
        const localUp = getLocalUpVector(pos)
        const localEast = getLocalEastVector(pos)
        const localNorth = getLocalNorthVector(pos)

        // offsetting by offX,offY,offZ
        // offX = east (old EUS X), offY = up (old EUS Y), offZ = south (old EUS Z)
        // needs to be relative to the heading of the Gimbal object

        const gv = this.in.gimbal.p(1).sub(this.in.gimbal.p(0))
        gv.normalize()
        // Project velocity onto the local tangent plane to get heading
        const velEast = gv.dot(localEast)
        const velNorth = gv.dot(localNorth)
        const heading = Math.atan2(velEast, velNorth)

        // Build offset in local tangent frame: offX=east, offY=up, offZ=south
        const off = V3(this.offX, this.offY, this.offZ)
        // Rotate the offset around up axis by -heading (same logic as before, but in local frame)
        // First express offset in world coords via local basis, then rotate
        const offWorld = localEast.clone().multiplyScalar(off.x)
            .add(localUp.clone().multiplyScalar(off.y))
            .add(localNorth.clone().multiplyScalar(-off.z)) // south = -north
        offWorld.applyAxisAngle(localUp, -heading)

        const fleeterScale = this.in.spacing.v0
        // Apply scaled offset + fleet position offset (fleetX=east, fleetY=south in old EUS)
        const fleetOffWorld = localEast.clone().multiplyScalar(metersFromNM(this.in.fleetX.v0))
            .add(localNorth.clone().multiplyScalar(-metersFromNM(this.in.fleetY.v0))) // fleetY was south
        pos.add(offWorld.multiplyScalar(metersFromNM(fleeterScale)))
        pos.add(fleetOffWorld)

        // Use local up as the turn axis (instead of hardcoded Y-up)
        var upAxis = localUp.clone()

        // velocity comes from the first two frames of the gimbal object track
        // and give us a per-frame
        var vel = this.in.gimbal.p(1)
                  .sub(this.in.gimbal.p(0))
        var turnStarted = false
        var turnEnded = false;
        var turnTotal = 0
        for (var f = 0; f < this.frames; f++) {
            this.array.push({position: pos.clone()})
            pos.add(vel)

            if (!turnStarted && f>this.in.turnFrame.v0) {
                turnStarted = true;
                var speed = Units.m2Speed * vel.length() * Sit.fps;
                vel.multiplyScalar(this.in.acc.v0)
                speed = Units.m2Speed * vel.length() * Sit.fps;
            }
            if (turnStarted && !turnEnded) {
                const turn = radians(this.in.turnRate.v0/Sit.fps)
                vel.applyAxisAngle(upAxis,turn)

                turnTotal += this.in.turnRate.v0/Sit.fps
                if (turnTotal>=180) {
                    turnEnded = true;
                }
            }
        }
    }
}

