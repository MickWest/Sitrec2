import {CNodeTrack} from "./CNodeTrack";
import {NodeMan, Sit} from "../Globals";
import {getLocalNorthVector, getLocalUpVector, setAltitudeMSL} from "../SphericalMath";
import {radians} from "../utils";
import {V3} from "../threeUtils";
import {EventManager} from "../CEventManager";

export class CNodeTrackFromVelocity extends CNodeTrack {
    constructor(v) {
        if (v.frames === undefined) {
            v.frames = Sit.frames;
            super(v);
            this.useSitFrames = true;
        } else {
            super(v);
        }

        this.input("origin");
        this.input("velocity");
        this.optionalInputs(["terrain"]);

        this.agl = v.agl ?? 1;

        EventManager.addEventListener("elevationChanged", () => this.onElevationChanged());
        this.recalculate();
    }

    onElevationChanged() {
        const terrainNode = this.in.terrain ?? NodeMan.get("TerrainModel", false);
        if (terrainNode && this.refreshElevationCache(terrainNode, this.agl)) {
            this.recalculateCascade();
        }
    }

    recalculate() {
        this.array = [];
        this.elevationCache = null; // flush cache for fresh terrain queries

        const pos = this.in.origin.p(0).clone();

        for (let f = 0; f < this.frames; f++) {
            const groundPos = this.getGroundPoint(pos, f);

            this.array.push({
                position: groundPos.clone(),
            });

            const vel = this.in.velocity.v(f);
            if (vel && (vel.speed !== undefined || vel.dx !== undefined)) {
                const up = getLocalUpVector(pos);
                const north = getLocalNorthVector(pos);

                let moveVector;
                if (vel.speed !== undefined && vel.heading !== undefined) {
                    const fwd = north.clone();
                    fwd.applyAxisAngle(up, radians(-vel.heading));
                    moveVector = fwd.multiplyScalar(vel.speed / Sit.fps);
                } else if (vel.dx !== undefined && vel.dy !== undefined) {
                    const east = V3().crossVectors(up, north);
                    moveVector = north.clone().multiplyScalar(vel.dy / Sit.fps);
                    moveVector.add(east.clone().multiplyScalar(vel.dx / Sit.fps));
                }

                if (moveVector) {
                    pos.add(moveVector);

                    const rightAxis = V3().crossVectors(up, moveVector);
                    if (rightAxis.lengthSq() > 0.0001) {
                        const newUp = getLocalUpVector(pos);
                        const newNorth = getLocalNorthVector(pos);
                        const newRight = V3().crossVectors(newUp, newNorth);
                    }
                }
            }
        }
    }

    getGroundPoint(pos, frame) {
        const terrainNode = this.in.terrain ?? NodeMan.get("TerrainModel", false);
        if (terrainNode) {
            return this.getPointBelowCached(terrainNode, pos, this.agl, frame);
        }
        return setAltitudeMSL(pos, this.agl);
    }
}
