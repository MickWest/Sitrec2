import {CNodeController} from "./CNodeController";
import {getLocalEastVector, getLocalNorthVector, getLocalUpVector} from "../SphericalMath";

// Turns a kite to face the wind on each frame. A kite model has its nose on +Z,
// and the kite track (CNodeKiteTrack) gives the wind at the kite. Add it after
// the TrackPosition controller, which sets the position this one turns about.
export class CNodeControllerKiteHeading extends CNodeController {
    constructor(v) {
        super(v);
        this.input("track");
    }

    apply(f, objectNode) {
        const object = objectNode._object;
        const state = this.in.track.kiteStateAt(f);
        if (!state) return;
        const position = object.position;
        const intoWind = state.windToward + Math.PI;
        const target = position.clone()
            .addScaledVector(getLocalNorthVector(position), Math.cos(intoWind))
            .addScaledVector(getLocalEastVector(position), Math.sin(intoWind));
        object.up.copy(getLocalUpVector(position));
        object.lookAt(target);
    }
}
