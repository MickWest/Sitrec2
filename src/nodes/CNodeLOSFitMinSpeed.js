// Global "minimum speed" fit to the LOS rays — the SLOWEST object consistent
// with the sightlines. Builds the analysis dataset from the LOS, runs
// traverseMinSpeed (minimum air-speed along the rays + a smoothing spline that
// sheds sensor jitter), and returns the full-clip track.
//
// This is the drifting-lantern / near-static-object reading: for a sensor
// orbiting a slow, close object the apparent motion is mostly the sensor's own
// parallax, so the slowest consistent object is a near-static drifter (the
// Aguadilla / GoFast lantern answer). The traverse-analysis gallery's
// "Minimum Speed" contender (key "saddle") selects THIS node, so the applied
// path is the same one it previewed. See src/TraverseAnalysis.js (traverseMinSpeed).

import { METERS_PER_NM, traverseMinSpeed } from "../TraverseAnalysis";
import {
	abFrameRange,
	buildAnalysisDataset,
	expandWindowedTrack,
	unpackTrackToECEF,
} from "../TraverseAnalysisData";
import { CNodeTrack } from "./CNodeTrack";

export class CNodeLOSFitMinSpeed extends CNodeTrack {
	constructor(v) {
		super(v);
		this.requireInputs(["LOS"]);
		// startDist is only a wind-anchor hint; the fit finds its own range.
		this.optionalInputs(["startDist", "wind"]);
		this.array = [];
		this._dirty = true;
	}

	recalculate() {
		if (!this.visible) {
			this._dirty = true;
			return;
		}
		this._doCompute();
	}

	_doCompute() {
		this._dirty = false;
		this.array = [];
		this.frames = this.in.LOS.frames;
		if (this.frames < 2) return;

		// wind local frame is anchored roughly mid-envelope; not range-critical
		const anchorDist = this.in.startDist
			? this.in.startDist.v0
			: 20 * METERS_PER_NM;
		// Fit the In/Out (A-B) window — the same range the traverse-analysis
		// gallery fits — and hold the endpoint positions outside it.
		const abRange = abFrameRange(this.frames);
		const { dataset, originLat, originLon } = buildAnalysisDataset(
			this.in.LOS,
			this.in.wind ?? null,
			anchorDist,
			abRange,
		);

		const { track } = traverseMinSpeed(dataset);
		this.array = expandWindowedTrack(
			unpackTrackToECEF(track, dataset.n, originLat, originLon),
			this.frames, dataset.frame0);
	}

	getValueFrame(f) {
		if (this._dirty) this._doCompute();
		return this.array[Math.floor(f)];
	}
}
