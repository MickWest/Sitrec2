// Exact in-memory snapshot of a trajectory selected from Traverse Analysis.
//
// Several analysis cards intentionally use smoothed/global solvers that have no
// parameter-identical legacy traverse node. Re-running a different live solver
// after the user presses "Use" can therefore display a materially different
// path. This node installs the already-reviewed analysis track itself, preserving
// pointwise preview/apply parity. It is deliberately a snapshot: changing an
// assumption requires re-running the analysis, which also prevents stale cached
// results from being silently relabelled as current.

import {CNodeTrack} from "./CNodeTrack";
import {expandWindowedTrack, unpackTrackToECEF} from "../TraverseAnalysisData";
import {showError} from "../showError";

export class CNodeLOSFitAnalysisResult extends CNodeTrack {
    constructor(v) {
        super(v);
        this.requireInputs(["LOS"]);
        this.frames = this.in.LOS.frames;
        this.array = [];
        this.hasAnalysisResult = false;
        this.resultName = null;
        this._analysisTrack = null;
        this._originLat = null;
        this._originLon = null;
        this._frame0 = 0;
        this._emptyWarningShown = false;
        this._buildPlaceholder();
    }

    _buildPlaceholder() {
        this.frames = this.in.LOS.frames;
        this.array = new Array(this.frames);
        for (let f = 0; f < this.frames; f++) {
            const los = this.in.LOS.v(f);
            this.array[f] = {
                position: los.position.clone().add(los.heading.clone().multiplyScalar(1000)),
            };
        }
    }

    setAnalysisTrack(track, originLat, originLon, frame0 = 0, resultName = "Analysis Result") {
        const count = track ? Math.floor(track.length / 3) : 0;
        if (count < 1 || !Number.isFinite(originLat) || !Number.isFinite(originLon)) return false;
        const windowTrack = unpackTrackToECEF(track, count, originLat, originLon);
        this.frames = this.in.LOS.frames;
        this.array = expandWindowedTrack(windowTrack, this.frames, frame0);
        this.hasAnalysisResult = true;
        this.resultName = resultName;
        this._emptyWarningShown = false;
        // Preserve the compact ENU snapshot so a saved sitch can restore the
        // exact selected result. CNodeSwitch serializes its selected option; if
        // this payload were omitted, reload would silently display the 1-km
        // placeholder under the still-selected "Analysis Result Snapshot".
        this._analysisTrack = Float64Array.from(track);
        this._originLat = originLat;
        this._originLon = originLon;
        this._frame0 = frame0;
        return true;
    }

    modSerialize() {
        return {
            ...super.modSerialize(),
            analysisResult: this.hasAnalysisResult ? {
                track: Array.from(this._analysisTrack),
                originLat: this._originLat,
                originLon: this._originLon,
                frame0: this._frame0,
                resultName: this.resultName,
            } : null,
        };
    }

    modDeserialize(v) {
        super.modDeserialize(v);
        const saved = v && v.analysisResult;
        if (saved && Array.isArray(saved.track) && saved.track.length >= 3
            && saved.track.length % 3 === 0
            && Number.isFinite(saved.originLat) && Number.isFinite(saved.originLon)) {
            this.setAnalysisTrack(Float64Array.from(saved.track), saved.originLat, saved.originLon,
                saved.frame0 ?? 0, saved.resultName ?? "Analysis Result");
        }
    }

    // A result snapshot should not refit itself during an unrelated graph
    // cascade. If the sitch changes frame count, discard it rather than serving
    // a track from a different situation.
    recalculate() {
        if (this.array.length !== this.in.LOS.frames) {
            this.hasAnalysisResult = false;
            this.resultName = null;
            this._analysisTrack = null;
            this._originLat = null;
            this._originLon = null;
            this._frame0 = 0;
            this._buildPlaceholder();
        }
    }

    getValueFrame(f) {
        if (!this.hasAnalysisResult && !this._emptyWarningShown) {
            this._emptyWarningShown = true;
            showError("Analysis Snapshot is empty. Run Traverse > Analyze Traverse Methods, then choose “Use exact” on a result.");
        }
        return this.array[Math.floor(f)];
    }
}
