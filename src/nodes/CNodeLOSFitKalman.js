// Kalman filter (RTS forward-backward smoother) fit to LOS rays.
// 6-DOF constant-velocity state model with tunable noise parameters.
// GUI sliders are log-scale (10^x) for intuitive control over wide ranges.

import {CNodeTrack} from "./CNodeTrack";
import {fitKalmanFilter, buildLOSDataset, unpackFitPositions} from "../LOSFitting";
import {abFrameRange} from "../TraverseAnalysisData";

export class CNodeLOSFitKalman extends CNodeTrack {
    constructor(v) {
        super(v);
        this.requireInputs(["LOS"]);
        this.optionalInputs(["processNoise", "measurementNoise"]);
        this.array = [];
        this._dirty = true;
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

        // Fit the In/Out (A-B) window — the same range the traverse-analysis
        // gallery fits — and hold the endpoint positions outside it.
        const {frame0, frame1} = abFrameRange(this.frames);
        const {dataset, originLat, originLon} = buildLOSDataset(this.in.LOS, frame0, frame1);

        const options = {};
        if (this.in.processNoise) options.processNoise = Math.pow(10, this.in.processNoise.v0);
        if (this.in.measurementNoise) options.measurementNoise = Math.pow(10, this.in.measurementNoise.v0);

        const result = fitKalmanFilter(dataset, new Set(), options);
        if (!result) return;

        this.array = unpackFitPositions(result.positions, dataset.count, originLat, originLon, frame0, this.frames);
    }

    getValueFrame(f) {
        if (this._dirty) this._doCompute();
        return this.array[Math.floor(f)];
    }
}
