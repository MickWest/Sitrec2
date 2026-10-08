// CNodeDisplayBalloonSphere.js
// A sphere that follows a track and scales based on atmospheric pressure,
// simulating weather balloon expansion during ascent.
//
// Balloon expansion follows the ideal gas law (constant temperature approx):
//   Volume ∝ 1/P  →  radius ∝ (P₀/P)^(1/3)
//
// Typical weather balloon:
//   - Launch: ~1.5m diameter at ~1013 hPa (surface)
//   - Burst:  ~6-8m diameter at ~5-10 hPa (~30km)

import {CNode3DObject} from "./CNode3DObject";
import {MISB} from "../MISBFields";
import {balloonDiameter, sondeRowFrame} from "../SondeTrajectory";
import {Globals} from "../Globals";
import * as LAYER from "../LayerMasks";

export class CNodeDisplayBalloonSphere extends CNode3DObject {
    constructor(v) {
        // Set sphere defaults before calling super
        v.object = "sphere";
        v.color ??= "white";
        v.opacity ??= 1.0;
        v.transparent ??= false;
        v.radius ??= 1; // will be overridden by dynamic scaling
        v.layers ??= LAYER.MASK_HELPERS;

        super(v);

        // Balloon base diameter at surface pressure (meters)
        this.baseDiameter = v.baseDiameter ?? 1.5;

        // Surface pressure reference (hPa)
        this.surfacePressure = v.surfacePressure ?? 1013.25;
    }

    // Override recalculate to prevent base class from applying static size
    recalculate() {
    }

    update(f) {
        // Let parent and controllers (TrackPosition) handle positioning
        super.update(f);

        // Compute balloon diameter from pressure at current frame.
        // Use the misbRow stored by CNodeTrackFromMISB for this frame,
        // which is the actual data row used for the interpolated position.
        let diameter = this.baseDiameter;
        let pressure = null;

        // The pressure row at the whole frame in progress: playback frames can be fractional or past the track's end.
        const row = this.in.track ? sondeRowFrame(f, this.in.track.frames) : -1;
        if (row >= 0) {
            const trackValue = this.in.track.getValueFrame(row);
            if (trackValue && trackValue.misbRow) {
                const p = trackValue.misbRow[MISB.StaticPressure];
                if (p != null && p > 0) pressure = p;
            }
        }

        if (pressure != null && pressure > 0) {
            diameter = balloonDiameter(this.baseDiameter, pressure, this.surfacePressure);
        }

        // Apply scale: diameter in meters, multiplied by the global object scale
        const scale = diameter * Globals.objectScale;
        this.group.scale.setScalar(scale);
    }
}
