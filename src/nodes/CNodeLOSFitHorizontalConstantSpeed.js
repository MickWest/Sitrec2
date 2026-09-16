// A speculative level-flight fit for a target whose horizontal speed stays
// nearly constant while its heading changes. The fit searches altitude, not
// range: each candidate level surface is intersected with every sightline and
// the broad variation in its smoothed horizontal speed is scored.

import {CNodeTrack} from "./CNodeTrack";
import {fitHorizontalConstantSpeed} from "../TraverseAnalysis";
import {abFrameRange, buildAnalysisDataset, expandWindowedTrack, unpackTrackToECEF} from "../TraverseAnalysisData";
import {localGroundZ} from "../AnalyzeTraverse";
import {EventManager} from "../CEventManager";

export class CNodeLOSFitHorizontalConstantSpeed extends CNodeTrack {
    constructor(v) {
        super(v);
        this.requireInputs(["LOS"]);
        this.array = [];
        this._dirty = true;
        this.solved = null;
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
        if (this.frames < 20) return;

        const abRange = abFrameRange(this.frames);
        const {dataset, originLat, originLon} = buildAnalysisDataset(this.in.LOS, null, undefined, abRange);
        const groundAltitude = localGroundZ(dataset, originLat, originLon);
        dataset.groundLevelM = groundAltitude;
        const fit = fitHorizontalConstantSpeed(dataset, {groundAltitude});
        this.solved = fit;
        if (fit.failed || !fit.track) {
            console.warn(`Horizontal Speed Valley fit failed: ${fit.failureReason ?? "unknown reason"}`);
            return;
        }

        // The broad average is part of this solver's model and is also the
        // track used in the analysis gallery. It suppresses pointing jitter
        // before the constant-speed assumption is judged.
        this.array = expandWindowedTrack(
            unpackTrackToECEF(fit.track, dataset.n, originLat, originLon),
            this.frames, dataset.frame0);
    }

    getValueFrame(f) {
        if (this._dirty) this._doCompute();
        return this.array[Math.floor(f)];
    }
}
