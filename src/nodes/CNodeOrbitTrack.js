import {CNodeTrack} from "./CNodeTrack";
import {Sit} from "../Globals";
import {getLocalEastVector, getLocalNorthVector} from "../SphericalMath";
import {ECEFToLLAVD_radii, LLAToECEF} from "../LLA-ECEF-ENU";

export class CNodeOrbitTrack extends CNodeTrack {
    constructor(v) {
        v.frames = v.frames ?? Sit.frames;
        super(v);
        this.useSitFrames = true;

        this.requireInputs(["target", "radius", "period"]);
        this.optionalInputs(["altitude", "startAngle"]);
        this.isNumber = false;

        this._needsRecalculate = true;
    }

    recalculate() {
        this.array = [];

        const radiusMeters = this.in.radius.getValueFrame(0);
        const periodSeconds = this.in.period.getValueFrame(0);

        // Orbit altitude (HAE, meters) is a plain scalar from the Orbit Altitude
        // slider — a single value held for the whole orbit, independent of the
        // (possibly disabled) manual camera altitude.
        const altitudeMeters = this.in.altitude ? this.in.altitude.getValueFrame(0) : undefined;

        // Starting azimuth (compass degrees, clockwise from north) → phase offset
        // on the orbit angle. The angle below is already measured clockwise from
        // north (cos→north, sin→east), so 0° starts due north, 90° east, etc.
        const startAngleRad = this.in.startAngle
            ? this.in.startAngle.getValueFrame(0) * Math.PI / 180
            : 0;

        for (let f = 0; f < this.frames; f++) {
            const targetPos = this.in.target.p(f);

            const angle = startAngleRad + 2 * Math.PI * f / (periodSeconds * Sit.fps);

            const north = getLocalNorthVector(targetPos);
            const east = getLocalEastVector(targetPos);

            const orbitPos = targetPos.clone()
                .add(north.multiplyScalar(Math.cos(angle) * radiusMeters))
                .add(east.multiplyScalar(Math.sin(angle) * radiusMeters));

            // If an altitude is provided, override the orbit altitude with it,
            // keeping the orbit's lat/lon.
            if (altitudeMeters !== undefined) {
                const orbitLLA = ECEFToLLAVD_radii(orbitPos);
                orbitPos.copy(LLAToECEF(orbitLLA.x, orbitLLA.y, altitudeMeters));
            }

            this.array.push({position: orbitPos});
        }
    }
}
