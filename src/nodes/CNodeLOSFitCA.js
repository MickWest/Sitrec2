// Global least-squares constant-acceleration fit to LOS rays.
// Model: P(t) = P0 + V*t + 0.5*A*t^2 (9 unknowns)

import {CNodeTrack} from "./CNodeTrack";
import {fitConstantAcceleration, buildLOSDataset, unpackFitPositions} from "../LOSFitting";
import {abFrameRange} from "../TraverseAnalysisData";

export class CNodeLOSFitCA extends CNodeTrack {
    constructor(v) {
        super(v);
        this.requireInputs(["LOS"]);
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
        if (this.frames < 3) return;

        // Fit the In/Out (A-B) window — the same range the traverse-analysis
        // gallery fits — and hold the endpoint positions outside it.
        const {frame0, frame1} = abFrameRange(this.frames);
        const {dataset, originLat, originLon} = buildLOSDataset(this.in.LOS, frame0, frame1);
        const result = fitConstantAcceleration(dataset, new Set());
        if (!result) return;

        this.array = unpackFitPositions(result.positions, dataset.count, originLat, originLon, frame0, this.frames);
    }

    getValueFrame(f) {
        if (this._dirty) this._doCompute();
        return this.array[Math.floor(f)];
    }
}
