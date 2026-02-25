// takes a track and traverse node and returns the per-second
// angular difference between the lines beteeen the nodes
// for this frame and the previous frame.
import {CNode} from "./CNode";
import {asin, degrees} from "../utils";
import {getLocalUpVector} from "../SphericalMath";

export class CNodeTraverseAngularSpeed extends CNode {
    constructor(v) {
        super(v);

        // track is like a jet track, with a "position" memeber
        // "traverse" is an array of objects that have a "position member"
        this.checkInputs(["track", "traverse"])
        this.frames = this.in.track.frames;
    }

    getValueFrame(f) {
        if (f === 0) return this.getValueFrame(1)

        let trackPos = this.in.track.p(f)
        let traversePos = this.in.traverse.p(f)

        const up = getLocalUpVector(trackPos);

        let offset = traversePos.clone().sub(trackPos)
        offset.sub(up.clone().multiplyScalar(offset.dot(up)))

        let trackPos0 = this.in.track.p(f - 1)
        let traversePos0 = this.in.traverse.p(f - 1)

        // this position has ALSO moved by the per-frame cloud wind velocity
        const wind = this.in.wind.v(f)
        traversePos0.add(wind)

        var step = traversePos.clone().sub(traversePos0)
        step.sub(up.clone().multiplyScalar(step.dot(up)))

        // Step is how far we've moved along curve that touches the horison.
        // nee to get this PERPENDICULAR to the view vector (which we assume is offset)
        const viewNormal = offset.clone().normalize()
        const viewComponentOfStep = step.clone().sub(viewNormal.clone().multiplyScalar(viewNormal.dot(step)))

        let angleDifferenceDegrees = -degrees(asin(viewComponentOfStep.length()/offset.length())) * this.fps;

        // Determine sign using cross product projected onto local up.
        const toTraverse = offset.clone();
        const crossSign = toTraverse.cross(viewComponentOfStep).dot(up);
        if (crossSign <= 0) {
            angleDifferenceDegrees = -angleDifferenceDegrees;
        }

        return (angleDifferenceDegrees)
    }

}
