import {CNodeTrack} from "./CNodeTrack";
import {Sit} from "../Globals";
import {getLocalUpVector, getLocalNorthVector, altitudeHAE, setAltitudeHAE} from "../SphericalMath";
import {V3} from "../threeUtils";

// CNodeCameraMotionTrack
//
// A camera flight path recovered from video-background egomotion (visual odometry).
//
// Input is the per-frame apparent motion of the BACKGROUND in the video, in pixels:
//   motion[f] = { dx, dy, scale }   (dx,dy = background image translation, scale = zoom)
//
// The camera moves OPPOSITE to the background, so per-frame the camera is displaced by
// (signE*dx, signN*dy) * metersPerPixel in the local East/North frame, integrated from an
// anchor (origin.p(0)). Altitude is held at the anchor's height-above-ellipsoid, optionally
// modulated by the accumulated background scale (climbGain>0: background shrinking => climb).
//
// This is intentionally a similarity (pan + roll + zoom) model assuming a near-nadir view
// over a distant ground/cloud plane, where background motion is dominated by platform
// translation. The horizontal scale (metersPerPixel) is inherently ambiguous from background
// motion alone, so it is exposed as a tunable.
export class CNodeCameraMotionTrack extends CNodeTrack {
    constructor(v) {
        if (v.frames === undefined) {
            v.frames = Sit.frames;
            super(v);
            this.useSitFrames = true;
        } else {
            super(v);
        }

        this.input("origin");                       // CNodePositionLLA or any track; p(0) = anchor

        this.motion = v.motion ?? [];               // [{dx,dy,scale}] per frame, background pixels
        this.metersPerPixel = v.metersPerPixel ?? 12;
        this.signE = v.signE ?? -1;                 // camera East per background +dx
        this.signN = v.signN ?? -1;                 // camera North per background +dy
        this.swapEN = v.swapEN ?? false;
        this.climbGain = v.climbGain ?? 0;          // 0 = constant altitude
        this.altOverride = v.altOverride;           // optional fixed HAE in meters

        this.addSimpleSerial("metersPerPixel");
        this.addSimpleSerial("signE");
        this.addSimpleSerial("signN");
        this.addSimpleSerial("swapEN");
        this.addSimpleSerial("climbGain");

        this._needsRecalculate = true;
        this.recalculate();
    }

    setMotion(motion, metersPerPixel) {
        this.motion = motion;
        if (metersPerPixel !== undefined) this.metersPerPixel = metersPerPixel;
        this.recalculate();
    }

    recalculate() {
        this.array = [];
        if (!this.in.origin) return;

        const originPos = this.in.origin.p(0).clone();
        const baseHAE = (this.altOverride !== undefined) ? this.altOverride : altitudeHAE(originPos);

        let pos = originPos.clone();
        let cumLogS = 0;
        let cumTheta = 0;   // accumulated background image rotation (radians)

        for (let f = 0; f < this.frames; f++) {
            const alt = baseHAE * Math.exp(-cumLogS * this.climbGain);
            // imageRot = cumulative background rotation; consumers derive camera roll from it.
            this.array.push({ position: setAltitudeHAE(pos.clone(), alt), imageRot: cumTheta });

            const m = this.motion[f] || { dx: 0, dy: 0, scale: 1, theta: 0 };
            // Guard every term against NaN/non-finite values from a bad fit — a single NaN would
            // poison the cumulative sums and corrupt the whole path from this frame onward.
            const theta = Number.isFinite(m.theta) ? m.theta : 0;
            let dxe = Number.isFinite(m.dx) ? m.dx : 0;
            let dyn = Number.isFinite(m.dy) ? m.dy : 0;
            const scale = (Number.isFinite(m.scale) && m.scale > 1e-6) ? m.scale : 1;
            cumTheta += theta;
            if (this.swapEN) { const t = dxe; dxe = dyn; dyn = t; }

            const up = getLocalUpVector(pos);
            const north = getLocalNorthVector(pos);
            const east = V3().crossVectors(up, north);   // matches CNodeTrackFromVelocity convention

            const dE = this.signE * dxe * this.metersPerPixel;
            const dN = this.signN * dyn * this.metersPerPixel;
            pos.add(east.multiplyScalar(dE)).add(north.multiplyScalar(dN));

            cumLogS += Math.log(scale);
        }
    }
}
