// Stationary-point traverse: the single fixed world position that best fits
// every LOS ray (closed-form least squares — the point minimizing the summed
// perpendicular miss to all sightlines). The object simply does not move.
//
// This is the LIVE counterpart of the analysis gallery's "Stationary Point in
// Space" and "Ground Object" tiles, built on the SAME fitFixedPoint() the
// gallery uses so "Use This" reproduces the tile's track exactly. No on-ray
// traverse can represent a stationary object — walking the rays at speed 0
// still has to move by the rays' closest-approach distance every frame, which
// drifts and trips the "faster than target speed" flag (the old broken apply).
//
// With v.groundPin the point is pinned to the analyser's sea-level plane
// (ENU z = 0), matching the gallery's "Ground Object" fit.

import {CNodeTrack} from "./CNodeTrack";
import {fitFixedPoint, fitGroundPoint} from "../TraverseAnalysis";
import {abFrameRange, buildAnalysisDataset, expandWindowedTrack, unpackTrackToECEF} from "../TraverseAnalysisData";
import {localGroundZ} from "../AnalyzeTraverse";
import {EventManager} from "../CEventManager";

export class CNodeLOSFitStationaryPoint extends CNodeTrack {
    constructor(v) {
        super(v);
        this.requireInputs(["LOS"]);
        this.groundPin = v.groundPin ?? false;
        this.array = [];
        this._dirty = true;
        if (this.groundPin) {
            EventManager.addEventListener("elevationChanged", () => {
                this._dirty = true;
                if (this.visible) this.recalculateCascade();
            });
        }
    }

    recalculate() {
        if (!this.visible) { this._dirty = true; return; }
        this._doCompute();
    }

    _doCompute() {
        this._dirty = false;
        this.array = [];
        this.frames = this.in.LOS.frames;
        if (this.frames < 2) return;

        // Same dataset packing, In/Out (A-B) window, and fit the analysis
        // gallery runs — an applied gallery tile reproduces this exactly. The
        // point is stationary, so "holding" outside the window is the same
        // constant position. The ground pin uses the LOCAL SURFACE height
        // (localGroundZ — terrain/sea level), matching the gallery's Ground
        // Object fit, not raw ENU z=0.
        const abRange = abFrameRange(this.frames);
        const {dataset, originLat, originLon} = buildAnalysisDataset(this.in.LOS, null, undefined, abRange);
        const fit = this.groundPin
            ? fitGroundPoint(dataset, localGroundZ(dataset, originLat, originLon))
            : fitFixedPoint(dataset, {});

        this.solved = {distance: fit.distance, errDeg: fit.errDeg};
        this.array = expandWindowedTrack(
            unpackTrackToECEF(fit.track, dataset.n, originLat, originLon),
            this.frames, dataset.frame0);
    }

    getValueFrame(f) {
        if (this._dirty) this._doCompute();
        return this.array[Math.floor(f)];
    }
}
