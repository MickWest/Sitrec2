// Monte Carlo polynomial fit to LOS rays.
// Random sampling with configurable polynomial order, LOS uncertainty, and trial count.
// Uses CV fit to provide per-frame range estimates for focused sampling.

import {CNodeTrack} from "./CNodeTrack";
import {fitConstantVelocity, fitMonteCarlo, buildLOSDataset, unpackFitPositions, assessLinearFitConditioning} from "../LOSFitting";
import {updateFitDiagnosticsGUI, disposeFitDiagnosticsGUI} from "./LOSFitDiagnostics";
import {abFrameRange} from "../TraverseAnalysisData";

export class CNodeLOSFitMonteCarlo extends CNodeTrack {
    constructor(v) {
        super(v);
        this.requireInputs(["LOS"]);
        this.optionalInputs(["numTrials", "losUncertaintyDeg", "order"]);
        this.array = [];
        this._dirty = true;
    }

    recalculate() {
        if (!this.visible) {
            // Invalidated while hidden: the cached assessment describes a
            // LOS that no longer exists — it must not be resurrectable.
            this._dirty = true;
            this._fitDiagAssessment = null;
            this._fitDiagTitle = null;
            disposeFitDiagnosticsGUI(this);
            return;
        }
        this._doCompute();
    }

    _doCompute() {
        this._dirty = false;
        this.array = [];
        // Clear diagnostics up front: every early return below (too few
        // frames, fit failure) must not leave the previous compute's rows
        // showing as if they described the current state.
        disposeFitDiagnosticsGUI(this);
        this._fitDiagAssessment = null;
        this.frames = this.in.LOS.frames;
        if (this.frames < 2) return;

        // Fit the In/Out (A-B) window — the same range the traverse-analysis
        // gallery fits — and hold the endpoint positions outside it.
        const {frame0, frame1} = abFrameRange(this.frames);
        const {dataset, originLat, originLon} = buildLOSDataset(this.in.LOS, frame0, frame1);

        const options = {};
        const cvResult = fitConstantVelocity(dataset, new Set());
        if (cvResult) {
            const rangeEstimates = new Float32Array(dataset.count);
            for (let i = 0; i < dataset.count; i++) {
                const b = i * 3;
                const dx = cvResult.positions[b] - dataset.sensorPos[b];
                const dy = cvResult.positions[b + 1] - dataset.sensorPos[b + 1];
                const dz = cvResult.positions[b + 2] - dataset.sensorPos[b + 2];
                const range = dx * dataset.losDir[b] + dy * dataset.losDir[b + 1] + dz * dataset.losDir[b + 2];
                rangeEstimates[i] = Math.max(range, 1);
            }
            options.rangeEstimates = rangeEstimates;
        }

        if (this.in.numTrials) options.numTrials = this.in.numTrials.v0;
        if (this.in.losUncertaintyDeg) options.losUncertaintyDeg = this.in.losUncertaintyDeg.v0;
        if (this.in.order) options.order = this.in.order.v0;

        const result = fitMonteCarlo(dataset, new Set(), options);
        if (!result) return;

        this.array = unpackFitPositions(result.positions, dataset.count, originLat, originLon, frame0, this.frames);

        // Surface (never alter): CV-family conditioning + collapse state.
        // These perpendicular-distance fits collapse onto the sensor when its
        // own path is CV/CA-representable (see LOSFitting.js header) — warn
        // the analyst instead of publishing a degenerate track silently.
        this._fitDiagAssessment = assessLinearFitConditioning(dataset, {positions: result.positions});
        this._fitDiagTitle = "Monte Carlo 1 Fit Diagnostics";
        if (this.visible) updateFitDiagnosticsGUI(this, this._fitDiagTitle, this._fitDiagAssessment);
    }

    update(f) {
        super.update(f);
        // Reconcile diagnostics with visibility every frame: switching
        // methods does not recalculate the DESELECTED input (folder must
        // be removed), and selecting a node the gallery already computed
        // while hidden only flips visibility (cached assessment must
        // surface without a recompute).
        if (!this.visible) {
            disposeFitDiagnosticsGUI(this);
        } else if (!this._fitDiagFolder && this._fitDiagAssessment && !this._dirty) {
            updateFitDiagnosticsGUI(this, this._fitDiagTitle, this._fitDiagAssessment);
        }
    }

    dispose() {
        disposeFitDiagnosticsGUI(this);
        super.dispose();
    }

    getValueFrame(f) {
        if (this._dirty) this._doCompute();
        return this.array[Math.floor(f)];
    }
}
