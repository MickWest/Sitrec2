// given a LOS node and a radius
// we either have an "altitude" node for constant altitude
// or "startDist" to start at a particular distance along the first line
import {Color, Ray, Sphere} from "three";
import {CNodeTrack} from "./CNodeTrack";
import {intersectSphere2, V3} from "../threeUtils";
import {assert} from "../assert";
import {showError} from "../showError";
import {Globals, Sit} from "../Globals";
import {ECEFToLLA_radii} from "../LLA-ECEF-ENU";

// Intersect ray with ellipsoid of semi-axes (a, a, b) centered at origin.
// Returns nearest positive-t intersection point, or null.
function intersectEllipsoidAlt(ray, a, b) {
    const ox = ray.origin.x, oy = ray.origin.y, oz = ray.origin.z;
    const dx = ray.direction.x, dy = ray.direction.y, dz = ray.direction.z;
    const a2 = a * a, b2 = b * b;

    const A = (dx * dx + dy * dy) / a2 + (dz * dz) / b2;
    const B = 2 * ((ox * dx + oy * dy) / a2 + (oz * dz) / b2);
    const C = (ox * ox + oy * oy) / a2 + (oz * oz) / b2 - 1;

    const disc = B * B - 4 * A * C;
    if (disc < 0) return null;

    const sqrtDisc = Math.sqrt(disc);
    const t1 = (-B - sqrtDisc) / (2 * A);
    const t2 = (-B + sqrtDisc) / (2 * A);

    let t;
    if (t1 > 0) t = t1;
    else if (t2 > 0) t = t2;
    else return null;

    return ray.origin.clone().add(ray.direction.clone().multiplyScalar(t));
}

export class CNodeLOSTraverseConstantAltitude extends CNodeTrack {
    constructor(v) {
        super(v);
        this.checkInputs(["LOS"])
        this.optionalInputs(["radius", "verticalSpeed"])
        this.checkExclusiveInputs(["altitude", "startDist"])
        this.array = []
        this.frames = this.in.LOS.frames;
        this._needsRecalculate = true;
    }

    recalculate() {
        this.array = [];
        this.frames = this.in.LOS.frames
        const isEllipsoid = Globals.equatorRadius !== Globals.polarRadius;
        var earthRadius = Globals.equatorRadius;
        if (this.in.radius !== undefined) {
            showError("Radius deprecated, generally we assume fixed wgs84 radius")
            earthRadius = (this.in.radius.v0)
        }
        var startRadius = earthRadius;
        var targetAltitude; // geodetic altitude for ellipsoid mode

        // Sequential traverses anchor on the clip's FIRST ray (TraverseMethods.md):
        // Sit.aFrame/bFrame are playback In/Out loop markers (shipped GoFast sets
        // aFrame:375 purely to skip the pre-lock segment), so they must never
        // alter traverse geometry. Analysis-parity for a fitted A-window result
        // is provided by the "Use exact" Analysis Snapshot, not by this node.
        const anchorFrame = 0;
        let anchorPosition = null;

        if (this.in.altitude !== undefined) {
            targetAltitude = this.in.altitude.v0;
            startRadius = earthRadius + targetAltitude;
        } else if (this.in.startDist !== undefined) {
            const los = this.in.LOS.v(anchorFrame);
            anchorPosition = los.position.clone()
                .add(los.heading.clone().multiplyScalar(this.in.startDist.v(0)));
            if (isEllipsoid) {
                const lla = ECEFToLLA_radii(anchorPosition.x, anchorPosition.y, anchorPosition.z);
                targetAltitude = lla[2];
            } else {
                startRadius = anchorPosition.length();
            }
        }

        // Per-frame altitude offset from verticalSpeed, accumulated from frame 0.
        const altOff = new Float64Array(this.frames);
        if (this.in.verticalSpeed !== undefined) {
            for (let f = 1; f < this.frames; f++) {
                altOff[f] = altOff[f - 1]
                    + this.in.verticalSpeed.v(f) * (Sit.simSpeed ?? 1) / this.fps;
            }
        }

        const altitudeSphere = new Sphere(V3(0, 0, 0), startRadius);
        var position = this.in.LOS.v0.position.clone(); // fallback if nothing intersects

        for (var f = 0; f < this.frames; f++) {

            const los = this.in.LOS.v(f)

            var result = {}
            if (f === anchorFrame && anchorPosition !== null) {
                // exactly the analyzed anchor point (startDist along ray A)
                position = anchorPosition.clone();
            } else {
                let losPosition = los.position.clone();
                let losHeading = los.heading.clone()
                let ray = new Ray(losPosition, losHeading)
                let hit = null;

                if (isEllipsoid) {
                    // Ellipsoid at constant geodetic altitude h has semi-axes (a+h, a+h, b+h)
                    const a = Globals.equatorRadius + targetAltitude + altOff[f];
                    const b = Globals.polarRadius + targetAltitude + altOff[f];
                    hit = intersectEllipsoidAlt(ray, a, b);
                } else {
                    altitudeSphere.radius = startRadius + altOff[f];
                    let target0 = V3() // first intersection
                    let target1 = V3() // second intersection
                    if (intersectSphere2(ray, altitudeSphere, target0, target1)) {
                        hit = target0;
                    }
                }

                if (hit) {
                    position = hit;
                } else {
                    // no intersection, so we use the same distance as the previous point
                    let oldDistance = los.position.distanceTo(position)
                    position = los.position.clone();
                    let heading = los.heading.clone();
                    heading.multiplyScalar(oldDistance)
                    position.add(heading)

                    // override color to red for segments that can't hold altitude.
                    result.color = new Color(1, 0, 0)
                }

            }
            assert(!isNaN(position.x) && !isNaN(position.y) && !isNaN(position.z), "CNodeLOSTraverseConstantAltitude: NaN position at frame " + f);
            result.position = position


            this.array.push(result)
        }

    }

}
