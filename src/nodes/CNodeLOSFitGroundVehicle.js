// Ground-vehicle traverse: the moving point where each sightline meets a flat
// ground plane at the local terrain height. This is the LIVE counterpart of
// the analysis gallery's "Ground Vehicle" tile (added in the "On the ground"
// ground-contact mode), built on the SAME fitGroundVehicle() + localGroundZ()
// the gallery uses so "Use This" reproduces the tile's track.
//
// Sightlines at/above the horizon never reach the ground; those frames hold
// the last valid position (fitGroundVehicle semantics).

import {CNodeTrack} from "./CNodeTrack";
import {fitGroundVehicle} from "../TraverseAnalysis";
import {abFrameRange, buildAnalysisDataset, expandWindowedTrack, unpackTrackToECEF} from "../TraverseAnalysisData";
import {localGroundZ} from "../AnalyzeTraverse";
import {EventManager} from "../CEventManager";

export class CNodeLOSFitGroundVehicle extends CNodeTrack {
    constructor(v) {
        super(v);
        this.requireInputs(["LOS"]);
        this.array = [];
        this._dirty = true;
        EventManager.addEventListener("elevationChanged", () => {
            this._dirty = true;
            if (this.visible) this.recalculateCascade();
        });
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

        // Same dataset packing, In/Out (A-B) window, ground plane and fit the
        // analysis gallery runs — an applied gallery tile reproduces this
        // exactly; outside the window the track holds the endpoint positions.
        const abRange = abFrameRange(this.frames);
        const {dataset, originLat, originLon} = buildAnalysisDataset(this.in.LOS, null, undefined, abRange);
        const groundZ = localGroundZ(dataset, originLat, originLon);
        const fit = fitGroundVehicle(dataset, groundZ);

        this.solved = {groundZ, fracValid: fit.fracValid};
        this.array = expandWindowedTrack(
            unpackTrackToECEF(fit.track, dataset.n, originLat, originLon),
            this.frames, dataset.frame0);
    }

    getValueFrame(f) {
        if (this._dirty) this._doCompute();
        return this.array[Math.floor(f)];
    }
}
